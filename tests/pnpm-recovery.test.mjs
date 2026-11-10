import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const fixture = "evals/ts-apphost-pnpm-policy";
const rootPolicy = parse(read(`${fixture}/pnpm-workspace.yaml`));
const apphostPolicy = parse(read(`${fixture}/aspire-apphost/pnpm-workspace.yaml`));
const authoring = read("skills/aspireify/references/typescript-authoring.md");
const recovery = authoring.split("### pnpm build-policy recovery\n")[1]?.split("\n## ")[0];
const stimuli = ["aspire-init", "aspireify"].map(skill => {
  const spec = parse(read(`skills/${skill}/evals/eval.yaml`));
  const stimulus = spec.stimuli.find(item => item.tags?.area?.includes("pnpm-recovery"));
  return { skill, stimulus };
});

test("the documented approval isolates esbuild without relaxing application policy", () => {
  assert.ok(recovery, "Missing shared pnpm recovery procedure");
  assert.deepEqual(rootPolicy, { packages: ["apps/*"], allowBuilds: { esbuild: false } });
  assert.deepEqual(apphostPolicy, { packages: ["."], allowBuilds: { esbuild: true } });
  const recipe = recovery.match(/```yaml\n([\s\S]*?)\n\s*```/);
  assert.ok(recipe, "Missing nested workspace policy example");
  assert.deepEqual(parse(recipe[1]), apphostPolicy);
  assert.match(recovery, /pnpm --config\.workspaceDir="\$PWD" install --frozen-lockfile/);
  assert.match(recovery, /pnpm exec tsc --noEmit -p tsconfig\.apphost\.json/);
  assert.match(recovery, /pnpm exec tsx --eval/);
});

test("partial-init fixtures do not assume root config or pre-approved builds exist", () => {
  assert.equal(existsSync(new URL(`../${fixture}/aspire.config.json`, import.meta.url)), false);
  const rootPackage = JSON.parse(read(`${fixture}/package.json`));
  const apphostPackage = JSON.parse(read(`${fixture}/aspire-apphost/package.json`));
  assert.equal(rootPackage.packageManager, "pnpm@11.25.0");
  assert.ok(apphostPackage.devDependencies.tsx);
  assert.match(read(`${fixture}/init-output.txt`), /ERR_PNPM_IGNORED_BUILDS[\s\S]*Exit code: 4/);
  const initial = stimuli.find(item => item.skill === "aspire-init").stimulus;
  assert.ok(initial, "Missing partial-init regression");
  assert.ok(!initial.environment.files.some(file => file.dest.endsWith("aspire.config.json")));
  assert.ok(!initial.environment.files.some(file =>
    file.dest.endsWith("aspire-apphost/pnpm-workspace.yaml")));
});

test("the restore regression retains the dependency error despite CLI success", () => {
  assert.match(read(`${fixture}/restore-output.txt`),
    /ERR_PNPM_IGNORED_BUILDS[\s\S]*restored successfully[\s\S]*Exit code: 0/);
  const existing = stimuli.find(item => item.skill === "aspireify").stimulus;
  assert.ok(existing, "Missing existing-approval regression");
  assert.ok(existing.environment.files.some(file =>
    file.dest.endsWith("aspire-apphost/pnpm-workspace.yaml")));
  assert.match(recovery, /success despite this dependency error/);
  assert.match(recovery, /microsoft\/aspire\/issues\/18012/);
  assert.match(recovery, /microsoft\/aspire\/pull\/19919/);
});

for (const { skill, stimulus } of stimuli) {
  test(`${skill}: pnpm regression has real activation, judging and read-only coverage`, () => {
    assert.ok(stimulus, `Missing ${skill} pnpm-recovery stimulus`);
    assert.equal(stimulus.tags.priority, "p1");
    assert.ok(stimulus.graders.some(grader =>
      grader.type === "skill-invocation" && grader.config.required.includes(skill)));
    assert.ok(stimulus.graders.some(grader => grader.type === "diff-empty"));
    assert.ok(stimulus.graders.some(grader => grader.type === "prompt"));
    assert.ok(stimulus.rubric.length >= 4);
    for (const file of stimulus.environment.files) {
      const source = new URL(file.src,
        new URL(`../skills/${skill}/evals/eval.yaml`, import.meta.url));
      assert.ok(existsSync(source), `Missing fixture: ${source.pathname}`);
    }
  });
}
