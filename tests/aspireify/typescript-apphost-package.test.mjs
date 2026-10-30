import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const referenceUrl = new URL("../../skills/aspireify/references/javascript-apps.md", import.meta.url);

async function readPackageJsonSection() {
    const source = await readFile(referenceUrl, "utf8");
    const start = source.indexOf("### package.json");
    const end = source.indexOf("### `tsconfig.apphost.json`");
    assert.ok(start >= 0 && end > start, "javascript-apps.md must keep the package.json and tsconfig.apphost.json sections");
    return source.slice(start, end);
}

function jsonBlocks(section) {
    return [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]));
}

test("TypeScript AppHost package scripts compile with tsconfig.apphost.json", async () => {
    const blocks = jsonBlocks(await readPackageJsonSection());
    assert.ok(blocks.length > 0, "the package.json section must show the scaffolded scripts");

    for (const block of blocks) {
        const scripts = block.scripts ?? {};
        assert.equal(scripts["aspire:start"], "aspire run");
        assert.equal(scripts["aspire:build"], "tsc -p tsconfig.apphost.json");
        assert.equal(scripts["aspire:dev"], "tsc --watch -p tsconfig.apphost.json");

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

test("existing package.json guidance preserves scripts and module type", async () => {
    const section = await readPackageJsonSection();
    const [existingPackage] = jsonBlocks(section);

    assert.equal(existingPackage.type, undefined, "an existing package.json must not be switched to ESM");
    for (const name of ["dev", "build", "watch"]) {
        assert.equal(existingPackage.scripts?.[name], undefined, `an existing package.json must keep its own "${name}" script`);
    }
    assert.match(section, /aspire:` prefix|aspire:` namespace/);
});
