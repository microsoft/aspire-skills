import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { assertExecution, hashFile, snapshot } from "../evals/project-v2-migration/bootstrap-harness.mjs";
import { runMock } from "../evals/project-v2-migration/mock-aspire.mjs";

const baseline = fileURLToPath(new URL("../evals/project-v2-migration/bootstrap-fixture", import.meta.url));
test("hidden baseline matches canonical fixture and mock bytes", () => {
  const manifest = JSON.parse(readFileSync(new URL("../evals/project-v2-migration/bootstrap-baseline.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.files, snapshot(baseline));
  assert.equal(manifest.mockSha, hashFile(fileURLToPath(new URL("../evals/project-v2-migration/mock-aspire.mjs", import.meta.url))));
});
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "bootstrap-execution-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(baseline, root, { recursive: true });
  return root;
}
function prepareProbe(root, { ownConfig = true, copyClosure = true } = {}) {
  const probe = join(root, "original/probe");
  mkdirSync(probe);
  cpSync(join(root, "original/host"), join(probe, "host"), { recursive: true });
  if (copyClosure) cpSync(join(root, "integrations"), join(probe, "integrations"), { recursive: true });
  if (ownConfig) {
    const config = JSON.parse(readFileSync(join(root, "original/aspire.config.json"), "utf8"));
    config.packages["Example.Hosting"] = copyClosure ? "integrations/Example/Example.csproj" : "../../integrations/Example/Example.csproj";
    writeFileSync(join(probe, "aspire.config.json"), JSON.stringify(config));
  }
  return probe;
}
const restore = ["restore", "--apphost", "./apphost.mts", "--non-interactive"];
const add = ["add", "Aspire.Hosting.Dotnet", "--version", "13.6.0-dev", "--apphost", "./apphost.mts", "--non-interactive"];

test("unapproved restore effects are rejected even if execution failed", t => {
  const root = fixture(t);
  assertExecution(root, baseline, "denied");
  runMock(root, join(root, "legacy"), restore);
  assert.throws(() => assertExecution(root, baseline, "denied"), /Unapproved original fixture writes/);
});
test("approved exact restore failure leaves config and rejects retries or wrong targets", t => {
  const root = fixture(t);
  const result = runMock(root, join(root, "legacy"), restore);
  assert.equal(result.exitCode, 6);
  assert.match(result.output, /SourceRoot\.RevisionId/);
  assertExecution(root, baseline, "failure");
  runMock(root, join(root, "legacy"), restore);
  assert.throws(() => assertExecution(root, baseline, "failure"), /exactly once/);
  const wrong = fixture(t);
  runMock(wrong, join(wrong, "legacy"), ["restore", "--apphost", "../original/host/apphost.mts", "--non-interactive"]);
  assert.throws(() => assertExecution(wrong, baseline, "failure"));
});
test("approved copy owns config, install effects and transitive integration builds", t => {
  const root = fixture(t);
  const probe = prepareProbe(root);
  runMock(root, join(probe, "host"), add);
  runMock(root, join(probe, "host"), restore);
  assertExecution(root, baseline, "probe");
});
test("probe supports retaining the mock and audit inside the approved copy", t => {
  const root = fixture(t);
  const probe = prepareProbe(root);
  runMock(probe, join(probe, "host"), add);
  runMock(probe, join(probe, "host"), restore);
  assertExecution(root, baseline, "probe");
});
test("probe graders catch original ancestor config and external integration builds", t => {
  for (const options of [{ ownConfig: false }, { copyClosure: false }]) {
    const root = fixture(t);
    const probe = prepareProbe(root, options);
    runMock(root, join(probe, "host"), add);
    runMock(root, join(probe, "host"), restore);
    assert.throws(() => assertExecution(root, baseline, "probe"), /Unapproved original fixture writes/);
  }
});
test("probe graders reject changed integration inputs or source", t => {
  const root = fixture(t);
  const probe = prepareProbe(root);
  writeFileSync(join(probe, "integrations/Shared/Shared.csproj"), '<Project Sdk="Changed.Sdk" />');
  runMock(root, join(probe, "host"), add);
  runMock(root, join(probe, "host"), restore);
  assert.throws(() => assertExecution(root, baseline, "probe"), /Build input changed/);
});
test("execution graders reject extra workspace writes and unapproved config entries", t => {
  const root = fixture(t);
  writeFileSync(join(root, "unapproved.txt"), "not in the fixture baseline");
  assert.throws(() => assertExecution(root, baseline, "denied"), /Unapproved original fixture writes/);
  const extra = fixture(t);
  const probe = prepareProbe(extra);
  const configPath = join(probe, "aspire.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.packages["Unapproved.Hosting"] = "13.6.0-dev";
  writeFileSync(configPath, JSON.stringify(config));
  runMock(extra, join(probe, "host"), add);
  runMock(extra, join(probe, "host"), restore);
  assert.throws(() => assertExecution(extra, baseline, "probe"), /Unapproved probe config changes/);
});
test("probe graders reject different copied targets for add and restore", t => {
  const root = fixture(t);
  const probe = prepareProbe(root);
  cpSync(join(probe, "host"), join(probe, "different-host"), { recursive: true });
  runMock(root, join(probe, "host"), add);
  runMock(root, join(probe, "different-host"), restore);
  assert.throws(() => assertExecution(root, baseline, "probe"), /same exact apphost/);
});
test("execution stimuli permit controlled commands with actual workspace graders", () => {
  const spec = parse(readFileSync(new URL("../evals/project-v2-migration/execution/eval.yaml", import.meta.url), "utf8"));
  assert.equal(spec.scoring, undefined, "Default all-graders-pass must apply");
  assert.equal(spec.stimuli.length, 3);
  for (const stimulus of spec.stimuli) {
    assert.ok(stimulus.graders.some(grader => grader.type === "program" && grader.config.args[0] === ".grader/grade-bootstrap.mjs"));
    assert.ok(stimulus.graders.some(grader => grader.type === "prompt"));
    assert.ok(stimulus.rubric.length >= 2);
  }
  const pattern = new RegExp(spec.stimuli[0].graders.find(grader => grader.type === "tool-calls").config.disallowed[0].args.command);
  assert.ok(pattern.test("aspire restore --apphost ./apphost.mts"));
  assert.ok(pattern.test("/usr/bin/dotnet restore"));
  assert.ok(pattern.test("./aspire restore"));
  assert.ok(pattern.test('gh repo clone spboyer/brain'));
  assert.ok(pattern.test('git fetch origin'));
  assert.ok(pattern.test('curl https://example.com'));
  assert.ok(!pattern.test("node ../mock-aspire.mjs restore --apphost ./apphost.mts --non-interactive"));
});

test("preparation guidance requires informed side-effect approval and real copy ownership", () => {
  const skill = readFileSync(new URL("../skills/aspire-project-v2-migration/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /package-manager installs, update lockfiles and execute lifecycle scripts/);
  assert.match(skill, /obtain explicit approval before restoring/);
  assert.match(skill, /legacy\s+`\.aspire\/settings\.json` but no `aspire\.config\.json`/);
  assert.match(skill, /even if restore later fails/);
  assert.match(skill, /obtain approval for its creation/);
  assert.match(skill, /including changes left by failure/);
  const reference = readFileSync(new URL("../skills/aspire-project-v2-migration/references/compatibility-and-validation.md", import.meta.url), "utf8");
  assert.match(reference, /copy-owned effective config/);
  assert.match(reference, /not a\s+symlink to the original/);
  assert.match(reference, /transitive build inputs/);
  assert.match(reference, /separate approval naming the external project\/paths and build effects/);
});
