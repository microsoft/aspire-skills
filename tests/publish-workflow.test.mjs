import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(repoRoot, ".github", "workflows", "publish.yml"), "utf8")
  .replace(/\r\n/g, "\n");
const skillsAsset = "dist/aspire-skills-v9.9.9.tgz";
const extensionsAsset = "dist/aspire-extensions-v9.9.9.tgz";

test("manual inputs are only bundle checkboxes, defaulting to skills", () => {
  const inputs = workflow.match(/  workflow_dispatch:\n    inputs:\n([\s\S]*?)\npermissions:/)?.[1];
  assert.ok(inputs);
  assert.deepEqual(
    [...inputs.matchAll(/^      ([a-z_]+):$/gm)].map(match => match[1]),
    ["include_skills", "include_extensions"]
  );
  for (const [bundle, defaultValue] of [["skills", true], ["extensions", false]]) {
    assert.match(inputs, new RegExp(
      `      include_${bundle}:\\n        description: Include aspire-${bundle}\\n        type: boolean\\n        default: ${defaultValue}\\n`
    ));
  }
});

test("tag pushes upload skills while manual runs honor both checkbox values", () => {
  const step = stepSource("Publish GitHub release");
  assert.match(step, /INCLUDE_SKILLS: \$\{\{ github\.event_name == 'push' \|\| inputs\.include_skills \}\}/);
  assert.match(step, /INCLUDE_EXTENSIONS: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.include_extensions \}\}/);
});

test("an empty manual selection fails before checkout", () => {
  assert.match(
    stepSource("Validate bundle selection"),
    /if: \$\{\{ github\.event_name == 'workflow_dispatch' && !inputs\.include_skills && !inputs\.include_extensions \}\}/
  );
  assert.ok(workflow.indexOf("- name: Validate bundle selection") < workflow.indexOf("- name: Checkout"));
  const result = runStep("Validate bundle selection");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::Select at least one bundle/);
});

test("release dependencies are installed before tests and bundle creation", () => {
  assert.match(stepSource("Install test dependencies"), /run: npm ci --ignore-scripts/);
  const steps = ["Setup Node", "Install test dependencies", "Test bundles", "Build bundles"]
    .map(name => workflow.indexOf(`- name: ${name}`));
  assert.ok(steps.every(index => index !== -1));
  assert.deepEqual(steps, steps.toSorted((left, right) => left - right));
});

for (const selection of [
  { name: "skills only", skills: "true", extensions: "false", assets: [skillsAsset] },
  { name: "extensions only", skills: "false", extensions: "true", assets: [extensionsAsset] },
  { name: "both bundles", skills: "true", extensions: "true", assets: [skillsAsset, extensionsAsset] }
]) {
  test(`${selection.name} uploads only the selected assets to new and existing releases`, () => {
    for (const releaseExists of [true, false]) {
      const result = runStep("Publish GitHub release", {
        TAG_NAME: "v9.9.9",
        VERSION: "9.9.9",
        SKILLS_ASSET: skillsAsset,
        EXTENSIONS_ASSET: extensionsAsset,
        INCLUDE_SKILLS: selection.skills,
        INCLUDE_EXTENSIONS: selection.extensions,
        RELEASE_EXISTS_STATUS: releaseExists ? "0" : "1"
      }, `
gh() {
  if [[ "$1 $2" == "release view" ]]; then
    return "$RELEASE_EXISTS_STATUS"
  fi
  printf '<%s>' "$@"
  printf '\\n'
}
`);
      assert.equal(result.status, 0, result.stderr);
      const expected = releaseExists
        ? ["release", "upload", "v9.9.9", ...selection.assets, "--clobber"]
        : ["release", "create", "v9.9.9", ...selection.assets, "--verify-tag", "--title", "v9.9.9", "--notes", "Aspire bundles 9.9.9"];
      assert.equal(result.stdout, `${expected.map(arg => `<${arg}>`).join("")}\n`);
    }
  });
}

function stepSource(name) {
  const step = workflow.split(/^      - name: /m).find(source => source.startsWith(`${name}\n`));
  assert.ok(step, `Missing publish step: ${name}`);
  return step;
}

function runStep(name, env = {}, setup = "") {
  const script = stepSource(name).match(/        run: \|\n([\s\S]*)$/)?.[1];
  assert.ok(script, `Missing Bash script for publish step: ${name}`);
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", `${setup}\n${script.replace(/^ {10}/gm, "")}`], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, ...env }
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}
