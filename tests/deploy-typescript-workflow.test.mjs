import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const referencesUrl = new URL("../skills/aspire-deployment/references/", import.meta.url);

// TypeScript AppHosts import ./.aspire/modules/aspire.mjs, which `aspire init` gitignores.
// A clean CI checkout must run `aspire restore` before any step that type-checks the AppHost.
function assertRestoresBeforeBuild(commands, label) {
    const install = commands.findIndex((command) => /aspire\.dev\/install\.sh/.test(command));
    const restore = commands.findIndex((command) => /^aspire restore\b/.test(command));
    const build = commands.findIndex((command) => /\bnpm run build\b/.test(command));

    assert.ok(build >= 0, `${label} must build the TypeScript workspace`);
    assert.ok(restore >= 0, `${label} must run aspire restore to generate .aspire/modules`);
    assert.ok(restore < build, `${label} must run aspire restore before npm run build`);
    if (install >= 0) {
        assert.ok(install < restore, `${label} must install the Aspire CLI before aspire restore`);
    }
}

function runCommands(steps) {
    return steps
        .flatMap((step) => (typeof step.run === "string" ? step.run.split("\n") : []))
        .map((line) => line.trim())
        .filter(Boolean);
}

test("TypeScript deploy workflow restores the AppHost SDK before building", async () => {
    const workflow = parse(await readFile(new URL("github-actions-azure-typescript.yml", referencesUrl), "utf8"));
    assertRestoresBeforeBuild(runCommands(workflow.jobs.deploy.steps), "github-actions-azure-typescript.yml");
});

test("CI/CD TypeScript setup snippet restores the AppHost SDK before building", async () => {
    const source = (await readFile(new URL("cicd.md", referencesUrl), "utf8")).replace(/\r\n/g, "\n");
    const match = source.match(/TypeScript AppHost setup[^\n]*:\n\n```yaml\n([\s\S]*?)```/);
    assert.ok(match, "cicd.md must keep the TypeScript AppHost setup snippet");
    assertRestoresBeforeBuild(runCommands(parse(match[1])), "cicd.md TypeScript AppHost setup");
});
