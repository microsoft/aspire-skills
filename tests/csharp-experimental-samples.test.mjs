import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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

function csharpBlocks() {
    return markdownFiles(skillsRoot).flatMap((file) => {
        const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
        return [...text.matchAll(/```(?:csharp|cs)\n([\s\S]*?)```/g)].map((m) => ({
            where: `${relative(skillsRoot, file)}:${text.slice(0, m.index).split("\n").length}`,
            code: m[1],
        }));
    });
}

function suppressedBefore(code, call, diagnostic) {
    const at = code.indexOf(call);
    const disables = [...code.slice(0, at).matchAll(/#pragma warning disable ([^\n/]+)/g)];
    return disables.some((m) => m[1].split(",").map((id) => id.trim()).includes(diagnostic));
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
            if (code.includes(call) && !suppressedBefore(code, call, diagnostic)) {
                offenders.push(`${where}: ${call} without #pragma warning disable ${diagnostic}`);
            }
        }
    }
    assert.deepEqual(offenders, []);
});

test("runnable file-based C# AppHost samples pin the Aspire.AppHost.Sdk version", () => {
    const offenders = csharpBlocks()
        .filter(({ code }) => /\.Build\(\)\.Run\(\)/.test(code))
        .flatMap(({ where, code }) =>
            code.split("\n").filter((line) => /^#:sdk Aspire\.AppHost\.Sdk\s*$/.test(line)).map(() => where));
    assert.deepEqual(offenders, []);
});

test("file-based C# sample references the package that provides WithBrowserLogs", () => {
    const authoring = readFileSync(join(skillsRoot, "aspireify/references/csharp-authoring.md"), "utf8");
    const fileBased = /## File-based AppHost \(apphost\.cs\)[\s\S]*?```csharp\n([\s\S]*?)```/.exec(authoring)?.[1];
    assert.ok(fileBased, "csharp-authoring.md must keep its file-based AppHost sample");
    assert.match(fileBased, /\.WithBrowserLogs\(/);
    assert.match(fileBased, /^#:package Aspire\.Hosting\.Browsers@/m);
});
