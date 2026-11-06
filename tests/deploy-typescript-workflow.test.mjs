import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const referencesUrl = new URL("../skills/aspire-deployment/references/", import.meta.url);

// TypeScript AppHosts import ./.aspire/modules/aspire.mjs, which `aspire init` gitignores.
// A clean CI checkout must run `aspire restore` before any step that type-checks the AppHost.
// The full workflow runs on a clean runner, so it must install the CLI itself. The cicd.md
// snippet is a fragment placed after the shared install step, so installation is optional there.
// GitHub Actions applies $GITHUB_PATH additions only to later steps, so the PATH update must be
// in an earlier step than `aspire restore` unless that step also exports PATH before restoring.
function assertRestoresBeforeBuild(commands, label, { requireInstall = false } = {}) {
    const find = (pattern) => commands.findIndex(({ command }) => pattern.test(command));
    const install = find(/aspire\.dev\/install\.sh/);
    const addToPath = find(/\.aspire\/bin\b.*>>\s*"?\$GITHUB_PATH"?/);
    const restore = find(/^aspire restore\b/);
    const build = find(/\bnpm run build\b/);

    assert.ok(build >= 0, `${label} must build the TypeScript workspace`);
    assert.ok(restore >= 0, `${label} must run aspire restore to generate .aspire/modules`);
    assert.ok(restore < build, `${label} must run aspire restore before npm run build`);
    if (requireInstall) {
        assert.ok(install >= 0, `${label} must install the Aspire CLI before aspire restore`);
        assert.ok(addToPath > install && addToPath < restore,
            `${label} must add $HOME/.aspire/bin to $GITHUB_PATH after installing and before aspire restore`);
        const restoreStep = commands[restore].step;
        const exportedInRestoreStep = commands.some(({ command, step }, index) =>
            step === restoreStep && index < restore && /^export PATH=.*\.aspire\/bin\b/.test(command));
        assert.ok(commands[addToPath].step < restoreStep || exportedInRestoreStep,
            `${label} must update $GITHUB_PATH in an earlier step than aspire restore, because GitHub Actions applies it only to later steps`);
    }
    if (install >= 0) {
        assert.ok(install < restore, `${label} must install the Aspire CLI before aspire restore`);
    }
}

function runCommands(steps) {
    return steps.flatMap((step, stepIndex) => (typeof step.run === "string" ? step.run.split("\n") : [])
        .map((line) => line.trim())
        .filter(Boolean)
        .map((command) => ({ command, step: stepIndex })));
}

test("TypeScript deploy workflow restores the AppHost SDK before building", async () => {
    const workflow = parse(await readFile(new URL("github-actions-azure-typescript.yml", referencesUrl), "utf8"));
    assertRestoresBeforeBuild(runCommands(workflow.jobs.deploy.steps), "github-actions-azure-typescript.yml", {
        requireInstall: true,
    });
});

async function cicdNodeSetupSteps() {
    const source = (await readFile(new URL("cicd.md", referencesUrl), "utf8")).replace(/\r\n/g, "\n");
    const match = source.match(/Node setup for a TypeScript AppHost or JavaScript resources[^\n]*:\n\n```yaml\n([\s\S]*?)```/);
    assert.ok(match, "cicd.md must keep the Node setup snippet for TypeScript AppHosts and JavaScript resources");
    return parse(match[1]);
}

test("CI/CD TypeScript setup snippet restores the AppHost SDK before building", async () => {
    assertRestoresBeforeBuild(runCommands(await cicdNodeSetupSteps()), "cicd.md Node setup");
});

// The Node setup block is shared with C# and Go AppHosts that only have JavaScript resources.
// Those repos have no apphost.mts, so the TypeScript AppHost restore must be skipped there.
test("CI/CD Node setup snippet restores only when a TypeScript AppHost exists", async () => {
    const steps = await cicdNodeSetupSteps();
    const restoreSteps = steps.filter((step) => /^\s*aspire restore\b/m.test(step.run ?? ""));
    assert.equal(restoreSteps.length, 1, "cicd.md Node setup must keep aspire restore in its own step");
    const [restore] = restoreSteps;
    assert.equal(restore.run.trim().split("\n").length, 1, "the restore step must not also install or build");
    const apphost = restore.run.match(/--apphost\s+(?:\.\/)?(\S+\.mts)\b/)?.[1];
    assert.ok(apphost, "the restore step must name the TypeScript AppHost with --apphost");
    assert.match(String(restore.if ?? ""), new RegExp(`hashFiles\\('(?:\\./)?${apphost.replace(/[.]/g, "\\.")}'\\)\\s*!=\\s*''`),
        "the restore step must be skipped when the TypeScript AppHost file does not exist");
    for (const step of steps.filter((candidate) => candidate !== restore)) {
        assert.doesNotMatch(step.run ?? "", /\baspire restore\b/, `${step.name} must not restore the TypeScript AppHost unconditionally`);
    }
});
