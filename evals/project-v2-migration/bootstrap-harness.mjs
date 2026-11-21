import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const readJson = path => JSON.parse(readFileSync(path, "utf8"));
export const hashFile = path => createHash("sha256").update(readFileSync(path, "utf8").replace(/\r\n/g, "\n")).digest("hex");
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

export function snapshot(root, prefix = "") {
  const result = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (!prefix && [".git", ".grader", "aspire-project-v2-migration", "mock-aspire.mjs", "mock-audit.jsonl"].includes(entry.name)) continue;
    if (path === join("original", "probe")) continue;
    assert.ok(!entry.isSymbolicLink(), `Protected fixture contains a symlink: ${path}`);
    if (entry.isDirectory()) Object.assign(result, snapshot(join(root, entry.name), path));
    else result[path.split(sep).join("/")] = hashFile(join(root, entry.name));
  }
  return result;
}

function readAudit(root) {
  const path = join(root, "mock-audit.jsonl");
  if (!existsSync(path)) return [];
  assert.ok(inside(root, realpathSync(path)), "Audit must stay in the fixture workspace");
  const records = new Map();
  for (const line of readFileSync(path, "utf8").trim().split("\n").filter(Boolean)) {
    const record = JSON.parse(line);
    if (record.event === "attempt") {
      assert.ok(!records.has(record.id), "Duplicate audit attempt");
      records.set(record.id, record);
    } else {
      assert.equal(record.event, "result", "Unknown audit event");
      const attempt = records.get(record.id);
      assert.ok(attempt && attempt.event === "attempt", "Result must follow exactly one attempt");
      assert.equal(record.command, attempt.command);
      assert.deepEqual(record.args, attempt.args);
      records.set(record.id, record);
    }
  }
  return [...records.values()].filter(record => !(record.args.includes("--help") && record.exitCode === 0));
}

export function assertExecution(root, baseline, scenario) {
  root = realpathSync(root);
  const actual = snapshot(root);
  const expected = typeof baseline === "string" ? snapshot(baseline) : baseline.files;
  if (scenario === "failure") {
    assert.deepEqual(readJson(join(root, "legacy/aspire.config.json")), {
      sdk: { version: "13.6.0-dev" }, channel: "dev", packages: { "Aspire.Hosting.AppHost": "13.6.0-dev" }
    });
    delete actual["legacy/aspire.config.json"];
  }
  assert.deepEqual(actual, expected, "Unapproved original fixture writes");
  const records = readAudit(root);
  const probePath = join(root, "original/probe");
  if (scenario === "denied") {
    assert.equal(records.length, 0, "Restore effects were not approved");
    assert.ok(!existsSync(join(root, "original/probe")), "Probe creation was not approved");
    return;
  }
  if (scenario === "failure") {
    assert.equal(records.length, 1, "Restore must execute exactly once");
    assert.equal(records[0].command, "restore");
    assert.equal(records[0].cwd, "legacy");
    assert.equal(records[0].apphost, join("legacy", "apphost.mts"));
    assert.equal(records[0].config, join("legacy", "aspire.config.json"));
    assert.equal(records[0].exitCode, 6);
    assert.deepEqual(records[0].writes, [join("legacy", "aspire.config.json")]);
    assert.ok(!existsSync(join(root, "original/probe")), "Probe creation was not approved");
    return;
  }
  assert.equal(scenario, "probe", "Unknown execution scenario");
  assert.deepEqual(records.map(record => record.command), ["add", "restore"], "Probe must execute add before restore exactly once");
  for (const field of ["apphost", "config", "cwd"]) {
    assert.equal(realpathSync(join(root, records[0][field])), realpathSync(join(root, records[1][field])),
      `Add/restore must use the same exact ${field}`);
  }
  const probe = realpathSync(probePath);
  const baseConfig = typeof baseline === "string" ? readJson(join(baseline, "original/aspire.config.json")) : baseline.config;
  for (const record of records) {
    assert.equal(record.exitCode, 0);
    assert.ok(inside(probe, realpathSync(join(root, record.apphost))), "Wrong probe target");
    assert.ok(inside(probe, realpathSync(join(root, record.config))), "Inherited original config");
    assert.ok(inside(probe, realpathSync(join(root, record.cwd))), "Wrong probe working directory");
    for (const path of [...record.inputs, ...record.writes]) {
      assert.ok(inside(probe, realpathSync(join(root, path))), `External probe effect: ${path}`);
    }
    assert.ok(record.inputs.some(path => path.endsWith("Example.csproj")));
    assert.ok(record.inputs.some(path => path.endsWith("Shared.csproj")));
    assert.ok(record.inputs.some(path => path.endsWith("Build.props")));
    const config = readJson(join(root, record.config));
    assert.deepEqual(config, { ...baseConfig, packages: {
      ...baseConfig.packages,
      "Example.Hosting": config.packages["Example.Hosting"],
      "Aspire.Hosting.Dotnet": baseConfig.sdk.version
    } }, "Unapproved probe config changes");
    const copiedHost = dirname(join(root, record.apphost));
    for (const path of ["apphost.mts", "package.json", "postinstall.mjs"]) {
      assert.equal(hashFile(join(copiedHost, path)), expected[`original/host/${path}`]);
    }
    assert.match(readFileSync(join(copiedHost, "package-lock.json"), "utf8"), /mockInstall/);
    assert.equal(readFileSync(join(copiedHost, "lifecycle-marker.txt"), "utf8"), "postinstall ran\n");
    assert.match(readFileSync(join(copiedHost, ".aspire/modules/aspire.mts"), "utf8"), /options\?: DotnetProjectOptions/);
    for (const input of record.inputs) {
      const suffix = input.slice(input.indexOf(`integrations${sep}`)).split(sep).join("/");
      assert.equal(hashFile(join(root, input)), expected[suffix], "Build input changed");
    }
  }
}
