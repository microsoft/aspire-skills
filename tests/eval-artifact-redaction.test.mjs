import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { redactEvalArtifacts } from "../scripts/redact-eval-artifacts.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const token = "synthetic-eval-credential.$[1]|&";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "aspire-eval-redaction-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("redacts literal and encoded credentials from nested trajectories and captured output", t => {
  const directory = fixture(t);
  const results = join(directory, "results");
  mkdirSync(join(results, "trial"), { recursive: true });
  const trajectory = join(results, "trial", "results.jsonl");
  const output = join(directory, "experiment-output.txt");
  writeFileSync(trajectory, JSON.stringify({
    raw: token,
    repeated: `${token} ${token}`,
    encoded: Buffer.from(token).toString("base64"),
    basic: Buffer.from(`x-access-token:${token}`).toString("base64"),
    score: 1,
  }));
  writeFileSync(output, `start\n${token}\nend\n`);

  redactEvalArtifacts([results, output], token);

  assert.deepEqual(JSON.parse(readFileSync(trajectory, "utf8")), {
    raw: "***", repeated: "*** ***", encoded: "***", basic: "***", score: 1,
  });
  assert.equal(readFileSync(output, "utf8"), "start\n***\nend\n");
});

test("preserves binary bytes and unchanged files", t => {
  const directory = fixture(t);
  const file = join(directory, "binary");
  const prefix = Buffer.from([0, 255, 254, 128]);
  writeFileSync(file, Buffer.concat([prefix, Buffer.from(token), prefix]));
  const unchanged = join(directory, "unchanged");
  writeFileSync(unchanged, prefix);
  utimesSync(unchanged, new Date("2000-01-01"), new Date("2000-01-01"));
  const modifiedAt = statSync(unchanged).mtimeMs;

  redactEvalArtifacts([directory], token);

  assert.deepEqual(readFileSync(file), Buffer.concat([prefix, Buffer.from("***"), prefix]));
  assert.deepEqual(readFileSync(unchanged), prefix);
  assert.equal(statSync(unchanged).mtimeMs, modifiedAt);
});

const pathToken = "ghs_synthetic_artifact_credential";
const credentialForms = [
  ["literal", pathToken],
  ["base64", Buffer.from(pathToken).toString("base64")],
  ["basic", Buffer.from(`x-access-token:${pathToken}`).toString("base64")],
];

for (const [label, value] of credentialForms) {
  for (const kind of ["file", "directory"]) {
    for (const scope of ["root", "nested"]) {
      test(`rejects ${label} credentials in ${scope} ${kind} names before modifying contents`, t => {
        const directory = fixture(t);
        const results = join(directory, "results");
        mkdirSync(results);
        const target = join(results, `trace-${value}`);
        if (kind === "directory") mkdirSync(target);
        const file = kind === "directory" ? join(target, "trace.json") : target;
        writeFileSync(file, pathToken);

        assert.throws(
          () => redactEvalArtifacts([scope === "root" ? target : results], pathToken),
          /credential-bearing evaluation artifact paths/,
        );
        assert.equal(readFileSync(file, "utf8"), pathToken);
      });
    }
  }
}

test("detects base64 credentials spanning path separators on every platform", t => {
  const directory = fixture(t);
  const secret = "credential???";
  const encoded = Buffer.from(secret).toString("base64");
  assert.ok(encoded.includes("/"));
  const target = join(directory, ...encoded.split("/"));
  mkdirSync(target, { recursive: true });
  const file = join(target, "trace.json");
  writeFileSync(file, secret);

  assert.throws(() => redactEvalArtifacts([directory], secret), /credential-bearing/);
  assert.equal(readFileSync(file, "utf8"), secret);
});

test("rejects credential-bearing paths even when optional outputs do not exist", t => {
  const directory = fixture(t);
  assert.throws(() => redactEvalArtifacts([join(directory, pathToken)], pathToken), /credential-bearing/);
});

for (const [label, value] of credentialForms) {
  test(`CLI blocks publication without printing ${label} credential-bearing paths`, t => {
    const directory = fixture(t);
    const file = join(directory, `trace-${value}.json`);
    writeFileSync(file, "innocuous content");
    const result = spawnSync(process.execPath, [
      join(repoRoot, "scripts", "redact-eval-artifacts.mjs"), directory,
    ], {
      env: { ...process.env, COPILOT_GITHUB_TOKEN: pathToken },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /must not be published/);
    assert.ok(!result.stderr.includes(value));
    assert.ok(!result.stderr.includes(pathToken));
    assert.ok(!result.stderr.includes(file));
  });
}

test("tolerates missing outputs but fails closed without a token or output paths", t => {
  const directory = fixture(t);
  assert.doesNotThrow(() => redactEvalArtifacts([join(directory, "missing")], token));
  assert.throws(() => redactEvalArtifacts([directory], ""), /required/);
  assert.throws(() => redactEvalArtifacts([], token), /required/);
});

test("rejects directory links without reading or modifying their target", t => {
  const directory = fixture(t);
  const results = join(directory, "results");
  const outside = join(directory, "outside");
  mkdirSync(results);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret"), token);
  symlinkSync(outside, join(results, "linked"), process.platform === "win32" ? "junction" : "dir");

  assert.throws(() => redactEvalArtifacts([results], token), /linked/);
  assert.throws(() => redactEvalArtifacts([join(results, "linked")], token), /linked/);
  assert.equal(readFileSync(join(outside, "secret"), "utf8"), token);
});

test("rejects hard links without modifying their target", t => {
  const directory = fixture(t);
  const target = join(directory, "target");
  const linked = join(directory, "linked");
  writeFileSync(target, token);
  linkSync(target, linked);

  assert.throws(() => redactEvalArtifacts([linked], token), /hard-linked/);
  assert.equal(readFileSync(target, "utf8"), token);
});

test("CLI fails nonzero without printing credential-bearing paths", t => {
  const directory = fixture(t);
  const env = { ...process.env };
  delete env.COPILOT_GITHUB_TOKEN;
  const result = spawnSync(process.execPath, [
    join(repoRoot, "scripts", "redact-eval-artifacts.mjs"),
    join(directory, token),
  ], { env, encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must not be published/);
  assert.ok(!result.stderr.includes(token));
});

test("CLI redacts with an environment token and never prints it", t => {
  const directory = fixture(t);
  const output = join(directory, "output");
  writeFileSync(output, token);
  const result = spawnSync(process.execPath, [
    join(repoRoot, "scripts", "redact-eval-artifacts.mjs"), output,
  ], {
    env: { ...process.env, COPILOT_GITHUB_TOKEN: token },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), "***");
  assert.equal(result.stdout + result.stderr, "");
});

test("CLI fails closed when linked artifacts cannot be safely redacted", t => {
  const directory = fixture(t);
  const target = join(directory, "target");
  const linked = join(directory, "linked");
  writeFileSync(target, token);
  linkSync(target, linked);
  const result = spawnSync(process.execPath, [
    join(repoRoot, "scripts", "redact-eval-artifacts.mjs"), linked,
  ], {
    env: { ...process.env, COPILOT_GITHUB_TOKEN: token },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(token));
  assert.equal(readFileSync(target, "utf8"), token);
});
