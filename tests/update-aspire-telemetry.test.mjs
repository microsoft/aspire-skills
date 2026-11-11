import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";
import {
  generateTelemetryCatalog, resolveTelemetrySource, syncTelemetryCatalog, telemetrySummary, validateTelemetryCatalog
} from "../scripts/update-aspire-telemetry.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = parse(readFileSync(join(root, ".github", "workflows", "update-aspire.yml"), "utf8"));
const catalogPath = "src/Aspire.Cli/Agents/Hooks/telemetry-catalog.json";
const base = "1".repeat(40);
const head = "2".repeat(40);
const commit = "3".repeat(40);
const newer = "4".repeat(40);
const source = {
  number: 123, commit, snapshot: "main",
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

function sourceClient(main = commit) {
  return { rest: { git: { getRef: async args => {
    assert.deepEqual(args, { owner: "microsoft", repo: "aspire-skills", ref: "heads/main" });
    return { data: { object: { sha: main } } };
  } } } };
}

function publisher({
  current = '{"skills":[],"references":[]}\n', existing = false, identicalHead = false, main = commit
} = {}) {
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
    "pulls.list": () => existing ? [{ number: 42, html_url: "https://github.com/microsoft/aspire/pull/42" }] : [],
    "git.getCommit": args => args.commit_sha === base
      ? { tree: { sha: "base-tree" }, parents: [] }
      : { tree: { sha: identicalHead ? "generated-tree" : "old-tree" }, parents: [{ sha: base }] },
    "git.createTree": () => ({ sha: "generated-tree" }),
    "git.createCommit": () => ({ sha: commit }),
    "git.createRef": () => ({}),
    "git.updateRef": () => ({}),
    "pulls.create": () => ({ number: 42, html_url: "https://github.com/microsoft/aspire/pull/42" }),
    "pulls.update": () => ({ number: 42, html_url: "https://github.com/microsoft/aspire/pull/42" }),
    "issues.addLabels": () => ({}),
    "issues.createComment": () => ({}),
    "git.deleteRef": () => ({})
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
  return { github: { rest: methods }, sourceGithub: sourceClient(main), calls };
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

test("an unchanged catalog without a proposal performs no mutations", async t => {
  const directory = fixture(t);
  const f = publisher({ current: `${JSON.stringify(expected, null, 2)}\n` });
  const result = await syncTelemetryCatalog({ ...f, directory, source });
  assert.equal(result.status, "unchanged");
  assert.deepEqual(f.calls.map(call => call.name), ["git.getRef", "repos.getContent", "pulls.list"]);
});

test("an unchanged catalog closes an obsolete bot proposal and deletes its branch", async t => {
  const directory = fixture(t);
  const f = publisher({ current: `${JSON.stringify(expected, null, 2)}\n`, existing: true });
  const result = await syncTelemetryCatalog({ ...f, directory, source });
  assert.equal(result.status, "closed");
  assert.deepEqual(f.calls.map(call => call.name).slice(3), ["issues.createComment", "pulls.update", "git.deleteRef"]);
  assert.equal(f.calls.find(call => call.name === "pulls.update").args.state, "closed");
  assert.equal(f.calls.find(call => call.name === "git.deleteRef").args.ref, "heads/update-aspire-telemetry-catalog");
});

test("branch cleanup ignores missing refs but surfaces other deletion failures", async t => {
  const directory = fixture(t);
  for (const [status, branchMissing] of [[404, true], [422, true], [422, false], [403, false]]) {
    const f = publisher({ current: `${JSON.stringify(expected, null, 2)}\n`, existing: true });
    const getRef = f.github.rest.git.getRef;
    f.github.rest.git.getRef = args => {
      if (args.ref !== "heads/main" && branchMissing) {
        throw Object.assign(new Error("Missing branch"), { status: 404 });
      }
      return getRef(args);
    };
    f.github.rest.git.deleteRef = () => {
      throw Object.assign(new Error("Branch deletion failed"), { status });
    };
    if (branchMissing) {
      assert.equal((await syncTelemetryCatalog({ ...f, directory, source })).status, "closed");
    } else {
      await assert.rejects(syncTelemetryCatalog({ ...f, directory, source }), /Branch deletion failed/);
    }
  }
});

test("a snapshot superseded by newer main performs no mutations", async t => {
  const directory = fixture(t);
  for (const current of ['{"skills":[],"references":[]}\n', `${JSON.stringify(expected, null, 2)}\n`]) {
    const f = publisher({ current, existing: true, main: newer });
    assert.equal((await syncTelemetryCatalog({ ...f, directory, source })).status, "superseded");
    assert.deepEqual(f.calls.map(call => call.name), ["git.getRef", "repos.getContent"]);
  }
});

test("unmerged PR head snapshots can only be previewed", async t => {
  const directory = fixture(t);
  const f = publisher();
  await assert.rejects(
    syncTelemetryCatalog({ ...f, directory, source: { ...source, snapshot: "head" } }),
    /Only current main snapshots/
  );
  assert.equal(f.calls.length, 0);
  const preview = await syncTelemetryCatalog({ ...f, directory, source: { ...source, snapshot: "head", dryRun: true } });
  assert.equal(preview.status, "preview");
});

test("catalog validation enforces Aspire's parser contract", () => {
  assert.equal(validateTelemetryCatalog(expected), expected);
  for (const [catalog, error] of [
    [{ skills: ["alpha"], references: [] }, /non-empty references/],
    [{ skills: [], references: ["alpha/references/a.md"] }, /non-empty skills/],
    [{ ...expected, mcpTools: ["x"] }, /only skills and references/],
    [{ skills: ["alpha.beta"], references: ["alpha.beta/references/a.md"] }, /Invalid skill identifier/],
    [{ skills: ["Alpha", "alpha"], references: ["alpha/references/a.md"] }, /Duplicate skills/],
    [{ skills: ["zeta", "alpha"], references: ["alpha/references/a.md"] }, /sorted ordinally/],
    [{ skills: ["alpha"], references: ["alpha/references/A.md", "alpha/references/a.md"] }, /Duplicate references/],
    [{ skills: ["alpha"], references: ["alpha/references/a\\b.md"] }, /Invalid reference path/],
    [{ skills: ["alpha"], references: ["alpha/references/../a.md"] }, /Invalid reference path/],
    [{ skills: ["alpha"], references: ["beta/references/a.md"] }, /Invalid reference path/],
    [{ skills: ["alpha"], references: ["alpha/assets/a.md"] }, /Invalid reference path/],
    [{ skills: ["alpha"], references: ["alpha/references"] }, /Invalid reference path/]
  ]) {
    assert.throws(() => validateTelemetryCatalog(catalog), error);
  }
});

test("Unicode references reject ordinal case collisions without rejecting distinct filenames", () => {
  for (const names of [
    ["\u03c2.md", "\u03c3.md"],
    ["\u1f80.md", "\u1f88.md"]
  ]) {
    const catalog = {
      skills: ["alpha"],
      references: names.map(name => `alpha/references/${name}`)
    };
    assert.throws(() => validateTelemetryCatalog(catalog), /Duplicate references/);
  }

  const distinct = {
    skills: ["alpha"],
    references: ["S.md", "SS.md", "S\u00df.md", "\u00df.md", "\u00dfS.md", "\u00e4.md", "\u017f.md", "\u1e9e.md"]
      .map(name => `alpha/references/${name}`)
  };
  assert.equal(validateTelemetryCatalog(distinct), distinct);
});

test("ambiguous Unicode uppercase collisions are rejected conservatively", () => {
  assert.throws(() => validateTelemetryCatalog({
    skills: ["alpha"],
    references: ["alpha/references/\u0390.md", "alpha/references/\u1fd3.md"]
  }), /Duplicate references/);
});

test("reference skill names must not fold non-ASCII characters into ASCII", () => {
  assert.throws(() => validateTelemetryCatalog({
    skills: ["k"], references: ["\u212a/references/a.md"]
  }), /Invalid reference path/);
});

test("generated inventories that Aspire would reject fail before any API call", async t => {
  const directory = fixture(t);
  for (const path of ["skills/alpha/references", "skills/zeta/references"]) rmSync(join(directory, path), { recursive: true, force: true });
  const f = publisher();
  await assert.rejects(syncTelemetryCatalog({ ...f, directory, source }), /non-empty references/);
  assert.equal(f.calls.length, 0);
  write(directory, "skills/alpha/references/a.md");
  write(directory, "skills/bad.name/SKILL.md");
  assert.throws(() => generateTelemetryCatalog(directory), /Invalid skill identifier: bad\.name/);
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

function sourceGithubFor({ merged, mergeSha = commit, main = newer, status = "ahead", calls = [] }) {
  return { rest: {
    pulls: { get: async args => {
      assert.deepEqual(args, { owner: "microsoft", repo: "aspire-skills", pull_number: 123 });
      return { data: {
        base: { ref: "main", repo: { full_name: "microsoft/aspire-skills" } },
        merged, merge_commit_sha: mergeSha, head: { sha: head }
      } };
    } },
    git: { getRef: async () => ({ data: { object: { sha: main } } }) },
    repos: { compareCommits: async args => {
      calls.push(args);
      return { data: { status } };
    } }
  } };
}

function sourceContext({ manual = false, dryRun = false, ref = "refs/heads/main" } = {}) {
  return {
    eventName: manual ? "workflow_dispatch" : "pull_request",
    ref,
    payload: {
      inputs: { pr_number: "123", dry_run: String(dryRun) },
      pull_request: { number: 123, merge_commit_sha: commit }
    }
  };
}

test("merged sources publish current main so stale or out-of-order events cannot roll back inventory", async () => {
  for (const [manual, dryRun] of [[false, false], [true, false], [true, true]]) {
    const calls = [];
    const github = sourceGithubFor({ merged: true, calls });
    assert.deepEqual(await resolveTelemetrySource({ github, context: sourceContext({ manual, dryRun }) }), {
      ...source, commit: newer, dryRun
    });
    assert.deepEqual(calls, [{ owner: "microsoft", repo: "aspire-skills", base: commit, head: newer }]);
  }
});

test("merged sources must be contained in main", async () => {
  for (const status of ["behind", "diverged"]) {
    const github = sourceGithubFor({ merged: true, status });
    await assert.rejects(resolveTelemetrySource({ github, context: sourceContext() }), /not contained in main/);
  }
});

test("unmerged manual sources preview their head but cannot publish", async () => {
  const github = sourceGithubFor({ merged: false });
  assert.deepEqual(await resolveTelemetrySource({ github, context: sourceContext({ manual: true, dryRun: true }) }), {
    ...source, commit: head, snapshot: "head", dryRun: true
  });
  await assert.rejects(
    resolveTelemetrySource({ github, context: sourceContext({ manual: true }) }),
    /only be previewed with dry_run/
  );
});

test("automatic source resolution rejects unmerged or mismatched events", async () => {
  for (const [merged, mergeSha] of [[false, commit], [true, head]]) {
    const github = sourceGithubFor({ merged, mergeSha });
    await assert.rejects(resolveTelemetrySource({ github, context: sourceContext() }), /requires the triggering merged PR/);
  }
});

test("manual runs, including previews, require the main workflow ref", async () => {
  const github = sourceGithubFor({ merged: true });
  for (const dryRun of [false, true]) {
    await assert.rejects(
      resolveTelemetrySource({ github, context: sourceContext({ manual: true, dryRun, ref: "refs/heads/feature" }) }),
      /must use the workflow from main/
    );
  }
});

test("job summary escapes source-controlled catalog content", () => {
  const summary = telemetrySummary({
    status: "preview", url: 'https://example.test/"><x>',
    content: '{"references":["a/references/<img src=x onerror=alert(1)>&\'.md"]}\n'
  });
  assert.doesNotMatch(summary, /<img|<x>|onerror=alert\(1\)>/);
  assert.match(summary, /&lt;img src=x onerror=alert\(1\)&gt;&amp;&#39;\.md/);
  assert.match(summary, /href="https:\/\/example\.test\/&quot;&gt;&lt;x&gt;"/);
});

test("workflow retains activation and separates trusted scripts from read-only source evidence", () => {
  assert.deepEqual(workflow.on.pull_request, { branches: ["main"], types: ["closed"] });
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, false);
  assert.equal(workflow.concurrency, undefined);
  const group = new Function("inputs", "github", "format", `return ${workflow.jobs.sync.concurrency.group.slice(3, -2)};`);
  const format = (pattern, ...args) => pattern.replace(/\{(\d+)\}/g, (_, index) => args[index]);
  assert.equal(group({ dry_run: false }, { run_id: 7 }, format), "aspire-skills-to-aspire");
  assert.equal(group({}, { run_id: 7 }, format), "aspire-skills-to-aspire");
  assert.equal(group({ dry_run: true }, { run_id: 7 }, format), "aspire-skills-to-aspire-preview-7");
  assert.equal(workflow.jobs.sync.concurrency["cancel-in-progress"], false);
  const accepts = new Function("github", `return (${workflow.jobs.sync.if});`);
  for (const [event, merged, repository, headRepo, expected, ref = "refs/heads/main"] of [
    ["pull_request", true, "microsoft/aspire-skills", 1, true, "refs/pull/1/merge"],
    ["pull_request", true, "microsoft/aspire-skills", 2, false],
    ["pull_request", false, "microsoft/aspire-skills", 1, false],
    ["workflow_dispatch", false, "microsoft/aspire-skills", undefined, true],
    ["workflow_dispatch", false, "microsoft/aspire-skills", undefined, false, "refs/heads/feature"],
    ["workflow_dispatch", false, "example/fork", undefined, false]
  ]) {
    assert.equal(accepts({
      event_name: event, repository, repository_id: 1, ref,
      event: { pull_request: { merged, head: { repo: { id: headRepo } } } }
    }), expected);
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
  const sync = workflow.jobs.sync.steps.at(-1);
  assert.equal(sync.env.SOURCE_TOKEN, "${{ github.token }}");
  assert.match(sync.with.script, /sourceGithub: getOctokit\(process\.env\.SOURCE_TOKEN\)/);
});
