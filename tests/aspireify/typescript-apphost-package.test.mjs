import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const referenceUrl = new URL("../../skills/aspireify/references/javascript-apps.md", import.meta.url);

// Script layouts emitted by TypeScriptLanguageSupport.CreatePackageJson for a fresh AppHost package.
// microsoft/aspire v13.5.4 (9c1b401dd67746739044f68959cbf4d3d7af93a6) and
// v13.6.0 (56f3e9c0d216c0c7069dabb49dd0464e4827744f) / v13.6.4 (c89352703f78ae46de90fbf751ed8b52b77b89bf).
const aspireScripts = {
    "aspire:lint": "eslint apphost.mts",
    "aspire:start": "aspire run",
    "aspire:build": "tsc -p tsconfig.apphost.json",
    "aspire:dev": "tsc --watch -p tsconfig.apphost.json",
};
const fresh136Scripts = {
    ...aspireScripts,
    lint: "eslint apphost.mts",
    dev: "eslint apphost.mts && aspire run",
    build: "eslint apphost.mts && tsc -p tsconfig.apphost.json",
    watch: "tsc --watch -p tsconfig.apphost.json",
};
const fresh135Scripts = {
    ...aspireScripts,
    lint: "npm run aspire:lint",
    predev: "npm run aspire:lint",
    dev: "npm run aspire:start",
    prebuild: "npm run aspire:lint",
    build: "npm run aspire:build",
    watch: "npm run aspire:dev",
};

async function readSource() {
    return (await readFile(referenceUrl, "utf8")).replace(/\r\n/g, "\n");
}

async function readPackageJsonSection() {
    const source = await readSource();
    const start = source.indexOf("### package.json");
    const end = source.indexOf("### `tsconfig.apphost.json`");
    assert.ok(start >= 0 && end > start, "javascript-apps.md must keep the package.json and tsconfig.apphost.json sections");
    return source.slice(start, end);
}

async function readTsconfigSection() {
    const source = await readSource();
    const start = source.indexOf("### `tsconfig.apphost.json`");
    assert.ok(start >= 0);
    const next = source.indexOf("\n## ", start);
    return source.slice(start, next < 0 ? undefined : next);
}

function subsection(section, heading) {
    const marker = `#### ${heading}`;
    const start = section.indexOf(marker);
    assert.ok(start >= 0, `the package.json section must have a "${marker}" subsection`);
    const next = section.indexOf("\n#### ", start + marker.length);
    return section.slice(start, next < 0 ? undefined : next);
}

function jsonBlocks(section) {
    return [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]));
}

function sentences(text) {
    return text
        .replace(/```[\s\S]*?```/g, "\n\n")
        .split(/\n\s*\n|\n(?=#|- )/)
        .flatMap((paragraph) => paragraph.replace(/\s+/g, " ").split(/(?<=[.;:])\s+(?=[A-Z`*-])/));
}

test("AppHost package scripts compile with tsconfig.apphost.json", async () => {
    const section = await readPackageJsonSection();
    const blocks = [
        ...jsonBlocks(subsection(section, "Merging into an existing AppHost package")),
        ...jsonBlocks(subsection(section, "Fresh AppHost package")),
    ];
    assert.ok(blocks.length >= 3, "the AppHost package examples must show the scaffolded scripts");

    for (const block of blocks) {
        const scripts = block.scripts ?? {};
        for (const [name, command] of Object.entries(aspireScripts)) {
            assert.equal(scripts[name], command, `AppHost package script "${name}"`);
        }
        for (const [name, command] of Object.entries(scripts)) {
            if (/\btsc\b/.test(command)) {
                assert.match(
                    command,
                    /-p tsconfig\.apphost\.json/,
                    `script "${name}" must compile the AppHost with tsconfig.apphost.json, not the app's root tsconfig.json`,
                );
            }
        }
    }
});

test("an existing root package.json gets only delegates into aspire-apphost", async () => {
    const section = await readPackageJsonSection();
    assert.match(
        subsection(section, "Where the AppHost package goes"),
        /Existing root `package.json`[\s\S]*?`aspire-apphost\/`[\s\S]*?`aspire-apphost\/package.json`/,
        "with an existing root package.json the AppHost must be placed in aspire-apphost/ with its own package",
    );

    const rootSection = subsection(section, "Root delegate scripts");
    const [root] = jsonBlocks(rootSection);
    assert.ok(root, "the root delegate guidance must show the resulting root package.json");

    // Existing CommonJS root with custom scripts, engines, and a conflicting aspire:dev.
    assert.equal(root.type, "commonjs", "the root module type must not change");
    assert.deepEqual(root.engines, { node: ">=18" }, "root engines must not change");
    assert.deepEqual(root.dependencies, { "express": "^4.19.2" }, "root dependencies must not change");
    assert.equal(root.devDependencies, undefined, "AppHost devDependencies must not be added to the root");
    assert.deepEqual(root.scripts, {
        build: "node build.js",
        dev: "node server.js",
        "aspire:dev": "node custom-dev.js",
        "aspire:start": "npm --prefix aspire-apphost run aspire:start",
        "aspire:build": "npm --prefix aspire-apphost run aspire:build",
    });

    assert.match(rootSection, /pnpm --dir aspire-apphost run/);
    assert.match(rootSection, /yarn --cwd aspire-apphost run/);
    assert.match(rootSection, /bun --cwd aspire-apphost run/);
    assert.match(rootSection, /deno task --cwd aspire-apphost/);
});

test("merge rules apply to the AppHost package and preserve scripts and module type", async () => {
    const section = await readPackageJsonSection();
    const mergeSection = subsection(section, "Merging into an existing AppHost package");
    const [existingPackage] = jsonBlocks(mergeSection);

    assert.match(mergeSection, /apply to the AppHost package only, never to the root/);
    assert.equal(existingPackage.type, undefined, "an existing package.json must not be switched to ESM");
    for (const name of ["dev", "build", "watch"]) {
        assert.equal(existingPackage.scripts?.[name], undefined, `an existing package.json must keep its own "${name}" script`);
    }
    assert.match(mergeSection, /aspire:` prefix|aspire:` namespace/);
    assert.doesNotMatch(mergeSection, /without overwriting anything/, "the CLI overwrites engines.node, so the merge is not a blanket no-overwrite");
    assert.match(mergeSection, /sets `engines\.node`[\s\S]{0,200}?replacing any\s+existing value/, "the guidance must say the CLI replaces an existing engines.node");
});

test("aspire restore is not described as creating or merging package.json or tsconfig", async () => {
    const text = (await readPackageJsonSection()) + (await readTsconfigSection());
    const fileClaim = /package\.json|tsconfig\.apphost\.json|scripts/;
    const writeVerb = /\b(creat|merg|scaffold|repair|recreat|writ|generat)\w*/i;
    const negation = /\b(does not|doesn't|do not|never|not)\b/;

    for (const sentence of sentences(text)) {
        if (!sentence.includes("`aspire restore`") || !fileClaim.test(sentence)) {
            continue;
        }
        if (writeVerb.test(sentence) || /\brun `aspire restore`/.test(sentence)) {
            assert.match(sentence, negation, `restore must not be credited with writing project files: "${sentence}"`);
        }
    }

    const restoreSection = subsection(await readPackageJsonSection(), "What `aspire restore` does");
    assert.match(restoreSection, /`\.aspire\/modules\/`/);
    assert.match(restoreSection, /does not create,\s+merge,\s+or repair `package.json`/);
});

test("fresh AppHost package documents both the 13.6+ and 13.5 script layouts", async () => {
    const fresh = subsection(await readPackageJsonSection(), "Fresh AppHost package");
    const parts = fresh.split(/(?=Aspire CLI 13\.)/);
    const layout = (label) => {
        const part = parts.find((p) => p.startsWith(label));
        assert.ok(part, `the fresh-package guidance must have a block labeled "${label}"`);
        const [block] = jsonBlocks(part);
        assert.ok(block, `"${label}" must show its package.json`);
        return block;
    };

    const v136 = layout("Aspire CLI 13.6 and later");
    const v135 = layout("Aspire CLI 13.5");
    assert.deepEqual(v136.scripts, fresh136Scripts);
    assert.deepEqual(v135.scripts, fresh135Scripts);
    for (const block of [v136, v135]) {
        assert.equal(block.type, "module");
        assert.deepEqual(block.engines, { node: "^20.19.0 || ^22.13.0 || >=24" });
    }
    assert.match(fresh, /Both layouts are valid CLI output/);
});
