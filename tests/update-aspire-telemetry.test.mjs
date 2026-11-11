import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";
import {
  generateTelemetryCatalog, resolveTelemetrySource, syncTelemetryCatalog
} from "../scripts/update-aspire-telemetry.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = parse(readFileSync(join(root, ".github", "workflows", "update-aspire.yml"), "utf8"));
const catalogPath = "src/Aspire.Cli/Agents/Hooks/telemetry-catalog.json";
const base = "1".repeat(40);
const head = "2".repeat(40);
const commit = "3".repeat(40);
const source = {
  number: 123, commit,
  url: "https://github.com/microsoft/aspire-skills/pull/123", dryRun: false
};

function write(directory, path, value = "fixture\n") {
  const file = join(directory, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "telemetry-catalog-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  write(directory, "skills/zeta/SKILL.md");
  write(directory, "skills/alpha/SKILL.md");
  write(directory, "skills/alpha/references/nested/config.yml");
  write(directory, "skills/alpha/references/a.md");
  write(directory, "skills/alpha/references/Z.md");
  write(directory, "skills/alpha/references/\u00e4.md");
  write(directory, "skills/alpha/assets/not-a-reference.md");
  write(directory, "skills/README.md");
  for (const prefix of [".github/plugins/mirror", ".github", "opencode"]) {
    write(directory, `${prefix}/skills/not-canonical/SKILL.md`);
    write(directory, `${prefix}/skills/not-canonical/references/ignored.md`);
  }
  write(directory, "extensions/not-a-skill/extension.mjs");
  return directory;
}

const expected = {
  skills: ["alpha", "zeta"],
  references: [
    "alpha/references/Z.md",
    "alpha/references/a.md",
    "alpha/references/nested/config.yml",
    "alpha/references/\u00e4.md"
  ]
};

function publisher({ current = '{"skills":[],"references":[]}\n', existing = false, identicalHead = false } = {}) {
  const calls = [];
  const methods = {};
  const results = {
    "git.getRef": args => {
      if (args.ref === "heads/main") return { object: { sha: base } };
      if (!existing) throw Object.assign(new Error("Not found"), { status: 404 });
      return { object: { sha: head } };
    },
    "repos.getContent": () => ({
      type: "file", encoding: "base64", content: Buffer.from(current).toString("base64")
    }),
    "pulls.list": () => existing ? [{ number: 42 }] : [],
    "git.getCommit": args => args.commit_sha === base
      ? { tree: { sha: "base-tree" }, parents: [] }
      : { tree: { sha: identicalHead ? "generated-tree" : "old-tree" }, parents: [{ sha: base }] },
    "git.createTree": () => ({ sha: "generated-tree" }),
    "git.createCommit": () => ({ sha: commit }),
    "git.createRef": () => ({}),
    "git.updateRef": () => ({}),
    "pulls.create": () => ({ number: 42, html_url: "https://github.com/microsoft/aspire/pull/42" }),
    "pulls.update": () => ({ number: 42, html_url: "https://github.com/microsoft/aspire/pull/42" }),
    "issues.addLabels": () => ({})
  };
  for (const [name, result] of Object.entries(results)) {
    const [group, method] = name.split(".");
    methods[group] ??= {};
    methods[group][method] = async args => {
      assert.equal(args.owner, "microsoft");
      assert.equal(args.repo, "aspire");
      calls.push({ name, args });
      return { data: result(args) };
    };
  }
  return { github: { rest: methods }, calls };
}

test("catalog inventories only canonical skills and all reference files in ordinal order", t => {
  const directory = fixture(t);
  assert.deepEqual(generateTelemetryCatalog(directory), expected);
});

test("incomplete skills and empty inventories fail instead of publishing destructive defaults", t => {
  const directory = fixture(t);
  mkdirSync(join(directory, "skills", "incomplete"));
  assert.throws(() => generateTelemetryCatalog(directory), /missing a regular SKILL\.md/);
  rmSync(join(directory, "skills"), { recursive: true });
  mkdirSync(join(directory, "skills"));
  assert.throws(() => generateTelemetryCatalog(directory), /at least one skill/);
});

test("linked skill and reference directories are rejected rather than traversed", t => {
  const directory = fixture(t);
  const target = join(directory, "outside");
  mkdirSync(target);
  symlinkSync(target, join(directory, "skills", "linked"), "junction");
  assert.throws(() => generateTelemetryCatalog(directory), /Skill must be a regular directory/);
  rmSync(join(directory, "skills", "linked"));
  symlinkSync(target, join(directory, "skills", "alpha", "references", "linked"), "junction");
  assert.throws(() => generateTelemetryCatalog(directory), /References must be regular files or directories/);
});

test("dry-run previews exact two-field JSON with stable formatting and performs no mutations", async t => {
  const directory = fixture(t);
  const f = publisher();
  const result = await syncTelemetryCatalog({ ...f, directory, source: { ...source, dryRun: true } });
  assert.equal(result.status, "preview");
  assert.equal(result.content, `${JSON.stringify(expected, null, 2)}\n`);
  assert.deepEqual(f.calls.map(call => call.name), ["git.getRef", "repos.getContent"]);
  assert.equal(f.calls[1].args.ref, base);
  assert.equal(f.calls[1].args.path, catalogPath);
});

test("an unchanged catalog performs no mutations", async t => {
  const directory = fixture(t);
  const f = publisher({ current: `${JSON.stringify(expected, null, 2)}\n` });
  const result = await syncTelemetryCatalog({ ...f, directory, source });
  assert.equal(result.status, "unchanged");
  assert.deepEqual(f.calls.map(call => call.name), ["git.getRef", "repos.getContent"]);
});

test("changed inventory creates a draft Aspire PR whose commit changes only the catalog", async t => {
  const directory = fixture(t);
  const f = publisher();
  const result = await syncTelemetryCatalog({ ...f, directory, source });
  assert.equal(result.status, "created");
  assert.equal(result.url, "https://github.com/microsoft/aspire/pull/42");
  const tree = f.calls.find(call => call.name === "git.createTree").args;
  assert.equal(tree.base_tree, "base-tree");
  assert.deepEqual(tree.tree, [{
    path: catalogPath, mode: "100644", type: "blob", content: `${JSON.stringify(expected, null, 2)}\n`
  }]);
  assert.deepEqual(f.calls.find(call => call.name === "git.createCommit").args.parents, [base]);
  assert.equal(f.calls.find(call => call.name === "git.createRef").args.sha, commit);
  const pr = f.calls.find(call => call.name === "pulls.create").args;
  assert.equal(pr.draft, true);
  assert.equal(pr.base, "main");
  assert.equal(pr.head, "update-aspire-telemetry-catalog");
  assert.match(pr.body, new RegExp(source.commit));
  assert.match(pr.body, /microsoft\/aspire-skills#123/);
});

test("subsequent inventory updates replace only the automation branch and reuse its open PR", async t => {
  const directory = fixture(t);
  const f = publisher({ existing: true });
  const result = await syncTelemetryCatalog({ ...f, directory, source });
  assert.equal(result.status, "updated");
  assert.ok(!f.calls.some(call => ["git.createRef", "pulls.create"].includes(call.name)));
  assert.deepEqual(f.calls.find(call => call.name === "git.updateRef").args, {
    owner: "microsoft", repo: "aspire", ref: "heads/update-aspire-telemetry-catalog", sha: commit, force: true
  });
  assert.equal(f.calls.find(call => call.name === "pulls.update").args.pull_number, 42);
});

test("repeated publication reuses the already generated commit", async t => {
  const directory = fixture(t);
  const f = publisher({ existing: true, identicalHead: true });
  assert.equal((await syncTelemetryCatalog({ ...f, directory, source })).status, "updated");
  assert.ok(!f.calls.some(call => ["git.createCommit", "git.updateRef", "git.createRef"].includes(call.name)));
});

test("publication fails explicitly on permission failures instead of treating them as a missing branch", async t => {
  const directory = fixture(t);
  const f = publisher();
  const original = f.github.rest.git.getRef;
  f.github.rest.git.getRef = args => {
    if (args.ref !== "heads/main") throw Object.assign(new Error("Forbidden"), { status: 403 });
    return original(args);
  };
  await assert.rejects(syncTelemetryCatalog({ ...f, directory, source }), /Forbidden/);
  assert.ok(!f.calls.some(call => call.name.startsWith("git.create")));
});

test("source resolution pins merge commits and manual heads without reading their content", async () => {
  for (const [manual, merged, dryRun] of [
    [false, true, false], [true, true, true], [true, false, false]
  ]) {
    const context = {
      eventName: manual ? "workflow_dispatch" : "pull_request",
      payload: {
        inputs: { pr_number: "123", dry_run: String(dryRun) },
        pull_request: { number: 123, merge_commit_sha: commit }
      }
    };
    const github = { rest: { pulls: { get: async args => {
      assert.deepEqual(args, { owner: "microsoft", repo: "aspire-skills", pull_number: 123 });
      return { data: {
        base: { ref: "main", repo: { full_name: "microsoft/aspire-skills" } },
        merged, merge_commit_sha: commit, head: { sha: head }
      } };
    } } } };
    assert.deepEqual(await resolveTelemetrySource({ github, context }), {
      ...source, commit: merged ? commit : head, dryRun
    });
  }
});

test("automatic source resolution rejects unmerged or mismatched events", async () => {
  const context = { eventName: "pull_request", payload: { pull_request: { number: 123, merge_commit_sha: commit } } };
  for (const pr of [
    { merged: false, merge_commit_sha: commit },
    { merged: true, merge_commit_sha: head }
  ]) {
    const github = { rest: { pulls: { get: async () => ({ data: {
      ...pr, base: { ref: "main", repo: { full_name: "microsoft/aspire-skills" } }
    } }) } } };
    await assert.rejects(resolveTelemetrySource({ github, context }), /requires the triggering merged PR/);
  }
});

test("workflow retains activation and separates trusted scripts from read-only source evidence", () => {
  assert.deepEqual(workflow.on.pull_request, { branches: ["main"], types: ["closed"] });
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, false);
  const accepts = new Function("github", `return (${workflow.jobs.sync.if});`);
  for (const [event, merged, repository, expected] of [
    ["pull_request", true, "microsoft/aspire-skills", true],
    ["pull_request", false, "microsoft/aspire-skills", false],
    ["workflow_dispatch", false, "microsoft/aspire-skills", true],
    ["workflow_dispatch", false, "example/fork", false]
  ]) {
    assert.equal(accepts({ event_name: event, event: { pull_request: { merged } }, repository }), expected);
  }
  const checkouts = workflow.jobs.sync.steps.filter(step => step.uses?.startsWith("actions/checkout@"));
  assert.deepEqual(checkouts.map(step => step.with), [
    { ref: "${{ github.workflow_sha }}", "persist-credentials": false },
    { ref: "${{ steps.source.outputs.commit }}", path: "_source", "persist-credentials": false }
  ]);
  const token = workflow.jobs.sync.steps.find(step => step.uses?.startsWith("actions/create-github-app-token@"));
  assert.equal(token.if, "steps.source.outputs.dry-run != 'true'");
  assert.equal(token.with.repositories, "aspire");
  assert.equal(workflow.jobs.sync.steps.some(step => step.run), false);
});
