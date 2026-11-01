import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const skillsRoot = new URL("../skills/", import.meta.url);

function markdownFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
        if (entry.isDirectory()) return markdownFiles(url);
        return entry.name.endsWith(".md") ? [url] : [];
    });
}

const typeScriptBlocks = markdownFiles(skillsRoot).flatMap((url) => {
    const text = readFileSync(url, "utf8").replace(/\r\n/g, "\n");
    const file = url.pathname.slice(url.pathname.indexOf("/skills/") + 1);
    return [...text.matchAll(/```(?:ts|typescript|mts)\n([\s\S]*?)```/g)].map((match) => ({
        file,
        code: match[1],
    }));
});

test("TypeScript AppHost examples pass ContainerLifetime enum members, not string literals", () => {
    // Generated SDK (13.6): withLifetime(lifetime: ContainerLifetime) with members Session and Persistent.
    for (const { file, code } of typeScriptBlocks) {
        assert.doesNotMatch(code, /\.withLifetime\(\s*["'`]/, `${file} passes a string to withLifetime`);
    }
});

test("TypeScript AppHost examples pass withDataVolume options, not a positional name", () => {
    // Generated SDK (13.6): withDataVolume(options?: { name?: string; isReadOnly?: boolean }).
    for (const { file, code } of typeScriptBlocks) {
        assert.doesNotMatch(code, /\.withDataVolume\(\s*["'`]/, `${file} passes a positional name to withDataVolume`);
    }
});

test("Aspireify persistence examples show the generated TypeScript shapes", () => {
    const wiring = typeScriptBlocks
        .filter(({ file }) => file === "skills/aspireify/references/apphost-wiring.md")
        .map(({ code }) => code)
        .join("\n");
    assert.match(wiring, /import \{ ContainerLifetime \} from "\.\/\.aspire\/modules\/aspire\.mjs";/);
    assert.match(wiring, /\.withLifetime\(ContainerLifetime\.Persistent\)/);
    assert.match(wiring, /\.withDataVolume\(\{ name: "pg-data" \}\)/);
});
