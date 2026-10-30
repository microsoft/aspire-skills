import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceTextModule, SyntheticModule, createContext } from "node:vm";
import { test } from "node:test";

const providerUrl = new URL("../../extensions/aspire-doctor/extension.mjs", import.meta.url);
const source = await readFile(providerUrl, "utf8");

async function harness(t, { workspacePath, workingDirectory }) {
    const canvasOpens = [];
    const spawns = [];
    let declaration;
    const sdk = {
        createCanvas: (options) => options,
        CanvasError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
        joinSession: async (options) => {
            declaration = options.canvases[0];
            return {
                workspacePath,
                log() {},
                rpc: { canvas: { open: async (payload) => { canvasOpens.push(JSON.parse(JSON.stringify(payload))); } } },
            };
        },
    };
    const childProcess = {
        spawn(command, args) {
            spawns.push({ command, args });
            const child = new EventEmitter();
            child.unref = () => {};
            queueMicrotask(() => child.emit("spawn"));
            return child;
        },
    };
    const context = createContext({ URL, Buffer, process, console, setTimeout, clearTimeout, setInterval, clearInterval });
    const module = new SourceTextModule(source, {
        context,
        identifier: providerUrl.href,
        initializeImportMeta(meta) { meta.url = providerUrl.href; },
    });
    await module.link(async (specifier) => {
        const exports = specifier === "@github/copilot-sdk/extension" ? sdk
            : specifier === "node:child_process" ? childProcess
                : await import(specifier.startsWith(".") ? new URL(specifier, providerUrl).href : specifier);
        return new SyntheticModule(Object.keys(exports), function () {
            for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        }, { context });
    });
    await module.evaluate();
    const opened = await declaration.open({ instanceId: "doctor-test", input: {}, session: { workingDirectory } });
    t.after(() => declaration.onClose({ instanceId: "doctor-test" }));
    return {
        canvasOpens,
        spawns,
        async openPath(path) {
            const url = new URL("/api/open-path", opened.url);
            url.search = new URL(opened.url).search;
            const response = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ path }),
            });
            assert.equal(response.status, 200);
            return response.json();
        },
    };
}

test("open-path resolves and contains editor paths against the repository, not session storage", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aspire-doctor-roots-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repo = join(root, "repo");
    const sessionState = join(root, "session-state");
    await mkdir(join(repo, "..config"), { recursive: true });
    await mkdir(join(sessionState, "files"), { recursive: true });
    await writeFile(join(repo, "..config", "settings.json"), "{}");
    await writeFile(join(repo, "AppHost.cs"), "");
    await writeFile(join(sessionState, "files", "state.json"), "{}");
    const outside = join(root, "outside.json");
    await writeFile(outside, "{}");

    const h = await harness(t, { workspacePath: sessionState, workingDirectory: repo });

    assert.deepEqual(await h.openPath(join(repo, "..config", "settings.json")),
        { ok: true, mode: "editor", path: "..config/settings.json" });
    assert.deepEqual(await h.openPath("AppHost.cs"), { ok: true, mode: "editor", path: "AppHost.cs" });
    assert.deepEqual(h.canvasOpens.map(({ canvasId, input }) => [canvasId, input.scope, input.path]), [
        ["editor", "repo", "..config/settings.json"],
        ["editor", "repo", "AppHost.cs"],
    ]);

    assert.equal((await h.openPath(outside)).mode, "file-manager");
    assert.equal((await h.openPath(join(sessionState, "files", "state.json"))).mode, "file-manager");
    assert.equal(h.canvasOpens.length, 2, "paths outside the repository never reach the editor canvas");
    assert.equal(h.spawns.length, 2);
});
