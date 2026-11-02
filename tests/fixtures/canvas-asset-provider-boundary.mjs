import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

const assets = await Promise.all([
    ["theme.css", "text/css"],
    ["icons.svg", "image/svg+xml"],
].map(async ([name, type]) => ({
    name, type,
    body: await fs.readFile(new URL(`../../assets/canvas/${name}`, import.meta.url), "utf8"),
})));

async function openProvider(t, extension, layout) {
    const root = await fs.mkdtemp(join(tmpdir(), "canvas-assets-"));
    const ui = join(root, "extensions", extension, "ui");
    const shared = join(root, "assets", "canvas");
    const servers = [];
    const instance = {
        instanceId: "assets",
        input: { viewMode: "global" },
        session: { workingDirectory: root },
    };
    let canvas;
    t.after(async () => {
        for (const server of servers) server.closeAllConnections();
        await canvas?.onClose(instance);
        for (const server of servers) {
            if (server.listening) await new Promise((done) => server.close(done));
        }
        await fs.rm(root, { recursive: true, force: true });
    });

    await fs.mkdir(ui, { recursive: true });
    await fs.writeFile(join(ui, "styles.css"), ".local-style { display: block; }");
    for (const asset of assets) {
        if (layout !== "standalone" && layout !== "missing") {
            await fs.mkdir(shared, { recursive: true });
            await fs.writeFile(join(shared, asset.name), asset.body);
        }
        if (layout === "placeholder") {
            await fs.writeFile(join(ui, `canvas-${asset.name}`), `../../../assets/canvas/${asset.name}`);
        } else if (layout === "standalone" || layout === "denied") {
            await fs.writeFile(join(ui, `canvas-${asset.name}`), `${asset.body}\n`);
        }
    }

    const providerUrl = new URL(`../../extensions/${extension}/extension.mjs`, import.meta.url);
    const installedUrl = pathToFileURL(join(root, "extensions", extension, "extension.mjs"));
    const context = createContext({
        URL, Buffer, process, console, setTimeout, clearTimeout, setInterval, clearInterval,
    });
    const provider = new SourceTextModule(await fs.readFile(providerUrl, "utf8"), {
        context,
        identifier: providerUrl.href,
        initializeImportMeta(meta) { meta.url = installedUrl.href; },
    });
    await provider.link(async (specifier) => {
        let exports;
        if (specifier === "@github/copilot-sdk/extension") {
            exports = {
                createCanvas: (options) => options,
                CanvasError: class extends Error {},
                joinSession: async (options) => {
                    [canvas] = options.canvases;
                    return { workspacePath: root, log() {} };
                },
            };
        } else if (specifier === "node:http") {
            exports = {
                ...http,
                createServer(...args) {
                    const server = http.createServer(...args);
                    servers.push(server);
                    return server;
                },
            };
        } else if (specifier === "node:fs/promises") {
            exports = {
                ...fs,
                readFile(path, ...args) {
                    if (layout === "denied" && assets.some(({ name }) => String(path) === pathToFileURL(join(shared, name)).href)) {
                        return Promise.reject(Object.assign(new Error("Access denied"), { code: "EACCES" }));
                    }
                    return fs.readFile(path, ...args);
                },
            };
        } else {
            exports = await import(specifier.startsWith(".") ? new URL(specifier, providerUrl).href : specifier);
            if (specifier === "./lib/app-model.mjs") {
                exports = {
                    ...exports,
                    createAspireCliRunner: () => ({
                        run: async () => ({ ok: true, code: 0, stdout: "[]", stderr: "" }),
                    }),
                };
            }
        }
        return new SyntheticModule(Object.keys(exports), function () {
            for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        }, { context });
    });
    await provider.evaluate();
    return canvas.open(instance);
}

for (const extension of ["aspire-apphosts", "aspire-doctor", "aspireify"]) {
    for (const [layout, description] of [
        ["placeholder", "canonical assets override Git UI placeholders"],
        ["no-ui-assets", "canonical assets work without UI links"],
        ["standalone", "missing canonical assets fall back to standalone UI files"],
        ["denied", "canonical read errors do not fall back to UI files"],
        ["missing", "missing canonical and UI assets return 404"],
    ]) {
        test(`${extension}: ${description}`, async (t) => {
            const opened = await openProvider(t, extension, layout);
            for (const asset of assets) {
                const response = await fetch(new URL(`/canvas-${asset.name}`, opened.url));
                if (layout === "denied" || layout === "missing") {
                    assert.equal(response.status, 404);
                    continue;
                }
                assert.equal(response.status, 200);
                assert.ok(response.headers.get("content-type").startsWith(asset.type));
                assert.equal(response.headers.get("cache-control"), "no-store");
                assert.equal(await response.text(), layout === "standalone" ? `${asset.body}\n` : asset.body);
                if (extension === "aspire-apphosts") {
                    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
                    assert.ok(response.headers.get("content-security-policy"));
                }
            }
            const local = await fetch(new URL("/styles.css", opened.url));
            assert.equal(local.status, 200);
            assert.equal(await local.text(), ".local-style { display: block; }");
            for (const path of ["/assets/canvas/theme.css", "/%2e%2e%2fassets%2fcanvas%2ftheme.css"]) {
                const response = await fetch(new URL(path, opened.url));
                assert.equal(response.status, 404, "only allowlisted static assets are public");
            }
        });
    }
}
