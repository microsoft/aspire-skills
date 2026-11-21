import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
test("copied mock writes to the shared workspace audit", t => {
  const root = fixture(t);
  const probe = prepareProbe(root);
  runMock(probe, join(probe, "host"), add);
  runMock(probe, join(probe, "host"), restore);
  assertExecution(root, baseline, "probe");
  assert.ok(existsSync(join(root, "mock-audit.jsonl")));
  assert.ok(!existsSync(join(probe, "mock-audit.jsonl")));
});
test("mixed mock locations preserve invocation order and reject restore before add", t => {
  const root = fixture(t);
  const probe = prepareProbe(root);
  runMock(probe, join(probe, "host"), restore);
  runMock(root, join(probe, "host"), add);
  assert.throws(() => assertExecution(root, baseline, "probe"), /add before restore exactly once/);
  const ordered = fixture(t);
  const orderedProbe = prepareProbe(ordered);
  runMock(orderedProbe, join(orderedProbe, "host"), add);
  runMock(ordered, join(orderedProbe, "host"), restore);
  assertExecution(ordered, baseline, "probe");
});
test("validation failures remain audited and make a subsequent restore a retry", t => {
  const root = fixture(t);
  assert.throws(() => runMock(root, join(root, "legacy"), ["restore", "--non-interactive"]), /explicit --apphost/);
  const events = readFileSync(join(root, "mock-audit.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map(record => record.event), ["attempt", "result"]);
  assert.equal(events[1].exitCode, 1);
  assert.throws(() => assertExecution(root, baseline, "denied"), /not approved/);
  runMock(root, join(root, "legacy"), restore);
  assert.throws(() => assertExecution(root, baseline, "failure"), /exactly once/);
});
test("mock checks symlinks and junctions before creating directories or following files", t => {
  for (const target of [".aspire", "package-lock.json"]) {
    const root = fixture(t);
    const probe = prepareProbe(root);
    const outside = mkdtempSync(join(tmpdir(), "bootstrap-outside-"));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    const link = join(probe, "host", target);
    rmSync(link, { recursive: true, force: true });
    if (target === ".aspire") symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    else {
      writeFileSync(join(outside, "lock.json"), "unchanged\n");
      symlinkSync(join(outside, "lock.json"), link, "file");
    }
    const before = snapshot(outside);
    assert.throws(() => runMock(root, join(probe, "host"), restore), /symlink or junction/);
    assert.deepEqual(snapshot(outside), before, "No external directory or file may be changed");
    assert.ok(!existsSync(join(outside, "modules")), "Must reject before mkdir");
  }
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
  for (const command of [
    "aspire.exe restore --apphost .\\apphost.mts",
    ".\\aspire.exe restore",
    "C:\\tools\\aspire.exe restore",
    "npm.cmd install",
    "pnpm.cmd install",
    "yarn.bat install",
    "dotnet.exe restore",
    "git.exe fetch origin",
    ".\\git.exe fetch origin",
    "C:\\tools\\git.exe fetch origin",
    "echo preparing; npm.cmd install"
  ]) assert.ok(pattern.test(command), `Must reject Windows command: ${command}`);
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
  assert.match(reference, /each declared npm integration host directory/);
  assert.match(reference, /`npm install` in each host/);
  assert.match(reference, /Copy those hosts and their required inputs\/configuration/);
  assert.match(reference, /separate approval naming\s+its exact paths and install, lockfile and lifecycle-script effects/);
});
