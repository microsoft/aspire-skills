import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillsRoot = fileURLToPath(new URL("../skills/", import.meta.url));

function markdownFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return markdownFiles(path);
        return entry.isFile() && path.endsWith(".md") ? [path] : [];
    });
}

function csharpBlocks() {
    return markdownFiles(skillsRoot).flatMap((file) => {
        const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
        return [...text.matchAll(/```(?:csharp|cs)\n([\s\S]*?)```/g)].map((m) => ({
            where: `${relative(skillsRoot, file)}:${text.slice(0, m.index).split("\n").length}`,
            code: m[1],
        }));
    });
}

function suppressedAt(code, at, diagnostic) {
    let suppressed = false;
    for (const m of code.slice(0, at).matchAll(/#pragma warning (disable|restore)\b([^\n/]*)/g)) {
        const ids = m[2].split(",").map((id) => id.trim()).filter(Boolean);
        if (ids.length === 0 || ids.includes(diagnostic)) suppressed = m[1] === "disable";
    }
    return suppressed;
}

function unsuppressedCalls(code, call, diagnostic) {
    const offsets = [];
    for (let at = code.indexOf(call); at !== -1; at = code.indexOf(call, at + call.length)) {
        if (!suppressedAt(code, at, diagnostic)) offsets.push(at);
    }
    return offsets;
}

// Aspire 13.6.4: these APIs are [Experimental] and fail the C# build unless suppressed.
const experimental = [
    { call: "AddNextJsApp(", diagnostic: "ASPIREJAVASCRIPT001" },
    { call: ".WithBrowserLogs(", diagnostic: "ASPIREBROWSERLOGS001" },
];

test("C# samples suppress the experimental diagnostics of the APIs they call", () => {
    const offenders = [];
    for (const { where, code } of csharpBlocks()) {
        for (const { call, diagnostic } of experimental) {
            if (unsuppressedCalls(code, call, diagnostic).length > 0) {
                offenders.push(`${where}: ${call} without #pragma warning disable ${diagnostic}`);
            }
        }
    }
    assert.deepEqual(offenders, []);
});

test("experimental suppression check tracks disable/restore state at every call", () => {
    const call = ".WithBrowserLogs(";
    const id = "ASPIREBROWSERLOGS001";
    assert.deepEqual(unsuppressedCalls(`#pragma warning disable ${id}\na${call});`, call, id), []);
    assert.equal(
        unsuppressedCalls(`#pragma warning disable ${id}\n#pragma warning restore ${id}\na${call});`, call, id).length, 1);
    assert.equal(
        unsuppressedCalls(`#pragma warning disable ${id}\na${call});\n#pragma warning restore ${id}\nb${call});`, call, id).length, 1);
    assert.equal(
        unsuppressedCalls(`#pragma warning disable ${id}\n#pragma warning restore\na${call});`, call, id).length, 1);
    assert.deepEqual(
        unsuppressedCalls(`#pragma warning disable OTHER001, ${id}\na${call});\nb${call});`, call, id), []);
});

test("runnable file-based C# AppHost samples pin the Aspire.AppHost.Sdk version", () => {
    const offenders = csharpBlocks()
        .filter(({ code }) => /\.Build\(\)\.Run\(\)/.test(code))
        .flatMap(({ where, code }) =>
            code.split("\n").filter((line) => /^#:sdk Aspire\.AppHost\.Sdk\s*$/.test(line)).map(() => where));
    assert.deepEqual(offenders, []);
});

test("file-based C# sample references the package that provides WithBrowserLogs", () => {
    const authoring = readFileSync(join(skillsRoot, "aspireify/references/csharp-authoring.md"), "utf8")
        .replace(/\r\n/g, "\n");
    const fileBased = /## File-based AppHost \(apphost\.cs\)[\s\S]*?```csharp\n([\s\S]*?)```/.exec(authoring)?.[1];
    assert.ok(fileBased, "csharp-authoring.md must keep its file-based AppHost sample");
    assert.match(fileBased, /\.WithBrowserLogs\(/);
    assert.match(fileBased, /^#:package Aspire\.Hosting\.Browsers@/m);
});
