import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillsRoot = fileURLToPath(new URL("../skills/", import.meta.url));

function markdownFiles(dir) {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return markdownFiles(path);
        return path.endsWith(".md") ? [path] : [];
    });
}

function tsBlocks(text) {
    return [...text.replace(/\r\n/g, "\n").matchAll(/```(?:ts|typescript)\n([\s\S]*?)```/g)].map((m) => m[1]);
}

// Generated SDK (13.6): primaryEndpoint is a method returning EndpointReferencePromise.
test("TypeScript samples call primaryEndpoint() instead of reading it as a property", () => {
    const offenders = [];
    for (const file of markdownFiles(skillsRoot)) {
        for (const block of tsBlocks(readFileSync(file, "utf8"))) {
            for (const line of block.split("\n")) {
                if (/\.primaryEndpoint\b(?!\s*\()/.test(line)) offenders.push(`${file}: ${line.trim()}`);
            }
        }
    }
    assert.deepEqual(offenders, []);
});

test("TypeScript withEnvironment example passes an endpoint from primaryEndpoint()", () => {
    const authoring = readFileSync(join(skillsRoot, "aspireify/references/typescript-authoring.md"), "utf8");
    const section = /## Unified `withEnvironment` API\n([\s\S]*?)\n## /.exec(authoring.replace(/\r\n/g, "\n"))?.[1];
    assert.ok(section, "typescript-authoring.md must keep its Unified withEnvironment API section");
    assert.match(section, /\.withEnvironment\('SERVICE_URL', cache\.primaryEndpoint\(\)\)/);
});
