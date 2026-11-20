import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";
import {
  generateTelemetryCatalog, resolveTelemetrySource, runTelemetrySync, syncTelemetryCatalog, telemetrySummary,
  validateTelemetryCatalog
} from "../scripts/update-aspire-workflow.mjs";

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
    "alpha/references/nested/config.yml"
  ]
};

function sourceClient(main = commit) {
  const comments = [];
  const calls = [];
  const issues = {};
  for (const [name, result] of Object.entries({
    listComments: () => comments,
    createComment: args => {
      const comment = { id: comments.length + 1, body: args.body, user: { login: "github-actions[bot]" } };
      comments.push(comment);
      return comment;
    },
    updateComment: args => {
      const comment = comments.find(comment => comment.id === args.comment_id);
      assert.ok(comment);
      comment.body = args.body;
      return comment;
    }
  })) {
    issues[name] = async args => {
      assert.equal(args.owner, "microsoft");
      assert.equal(args.repo, "aspire-skills");
      calls.push({ name, args });
      return { data: result(args) };
    };
  }
  return {
    comments, calls,
    paginate: async (method, args) => (await method(args)).data,
    rest: {
      issues,
      git: { getRef: async args => {
        assert.deepEqual(args, { owner: "microsoft", repo: "aspire-skills", ref: "heads/main" });
        return { data: { object: { sha: main } } };
      } }
    }
  };
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
    "pulls.list": () => existing ? [{ number: 42, node_id: "PR_42", draft: true, html_url: "https://github.com/microsoft/aspire/pull/42" }] : [],
    "git.getCommit": args => args.commit_sha === base
      ? { tree: { sha: "base-tree" }, parents: [] }
      : { tree: { sha: identicalHead ? "generated-tree" : "old-tree" }, parents: [{ sha: base }] },
    "git.createTree": () => ({ sha: "generated-tree" }),
    "git.createCommit": () => ({ sha: commit }),
    "git.createRef": () => ({}),
    "git.updateRef": () => ({}),
    "pulls.create": () => ({ number: 42, state: "open", draft: true, html_url: "https://github.com/microsoft/aspire/pull/42" }),
    "pulls.update": args => ({
      number: args.pull_number, state: args.state ?? "open", draft: true, html_url: `https://github.com/microsoft/aspire/pull/${args.pull_number}`
    }),
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
  return {
    github: {
      rest: methods,
      graphql: async (query, variables) => {
        calls.push({ name: "graphql", query, variables });
        return { convertPullRequestToDraft: { pullRequest: { isDraft: true } } };
      }
    },
    sourceGithub: sourceClient(main), calls
  };
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

test("an unchanged catalog without a proposal or branch performs no mutations", async t => {
  const directory = fixture(t);
  const f = publisher({ current: `${JSON.stringify(expected, null, 2)}\n` });
  const result = await syncTelemetryCatalog({ ...f, directory, source });
  assert.equal(result.status, "unchanged");
  assert.deepEqual(f.calls.map(call => call.name), [
    "git.getRef", "repos.getContent", "pulls.list", "git.getRef", "git.getRef"
  ]);
});

test("an unchanged catalog deletes an orphan bot branch without an open proposal", async t => {
  const directory = fixture(t);
  for (const [status, branchMissing, outcome] of [
    [undefined, false, "cleaned"], [404, true, "cleaned"], [422, true, "cleaned"], [422, false, /deletion failed/], [403, false, /deletion failed/]
  ]) {
    const f = publisher({ current: `${JSON.stringify(expected, null, 2)}\n`, existing: true });
    f.github.rest.pulls.list = async () => ({ data: [] });
    let deleted = false;
    const getRef = f.github.rest.git.getRef;
    f.github.rest.git.getRef = args => {
      if (args.ref !== "heads/main" && deleted && branchMissing) {
        throw Object.assign(new Error("Missing branch"), { status: 404 });
      }
      return getRef(args);
    };
    if (status) {
      f.github.rest.git.deleteRef = () => {
        deleted = true;
        throw Object.assign(new Error("Branch deletion failed"), { status });
      };
    }
    if (typeof outcome === "string") {
      assert.equal((await syncTelemetryCatalog({ ...f, directory, source })).status, outcome);
    } else {
      await assert.rejects(syncTelemetryCatalog({ ...f, directory, source }), outcome);
    }
    if (!status) {
      assert.deepEqual(f.calls.map(call => call.name).slice(2), ["git.getRef", "git.getRef", "git.deleteRef", "git.getRef"]);
      assert.equal(f.calls.find(call => call.name === "git.deleteRef").args.ref, "heads/update-aspire-telemetry-catalog");
    }
    assert.equal(f.calls.some(call => /create|update|Comment/.test(call.name)), false);
  }
});

test("dry runs never delete an orphan bot branch", async t => {
  const directory = fixture(t);
  const f = publisher({ current: `${JSON.stringify(expected, null, 2)}\n`, existing: true });
  const result = await syncTelemetryCatalog({ ...f, directory, source: { ...source, dryRun: true } });
  assert.equal(result.status, "unchanged");
  assert.deepEqual(f.calls.map(call => call.name), ["git.getRef", "repos.getContent"]);
});

test("an unchanged catalog closes an obsolete bot proposal and deletes its branch", async t => {
  const directory = fixture(t);
  const f = publisher({ current: `${JSON.stringify(expected, null, 2)}\n`, existing: true });
  const result = await syncTelemetryCatalog({ ...f, directory, source });
  assert.equal(result.status, "closed");
  assert.deepEqual(f.calls.map(call => call.name).slice(3), [
    "git.getRef", "issues.createComment", "pulls.update", "git.deleteRef", "git.getRef"
  ]);
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

test("superseded first attempts defer reporting, and final attempts fail with manual dispatch guidance", async t => {
  const directory = fixture(t);
  for (const final of [false, true]) {
    const f = publisher({ existing: true, main: newer });
    const outputs = {};
    const summaries = [];
    const core = {
      setOutput: (name, value) => { outputs[name] = value; },
      info: () => {},
      warning: message => assert.fail(message),
      summary: { addRaw: value => ({ write: async () => summaries.push(value) }) }
    };
    const run = runTelemetrySync({ ...f, core, directory, source, final });
    if (final) {
      await assert.rejects(run, /dispatch this workflow from main with the pr_number of a PR merged into main/);
    } else {
      assert.equal((await run).status, "superseded");
    }
    assert.deepEqual(outputs, { status: "superseded" });
    assert.deepEqual(f.calls.map(call => call.name), ["git.getRef", "repos.getContent"]);
    assert.equal(summaries.length, final ? 1 : 0);
    assert.equal(f.sourceGithub.calls.length, 0);
    if (final) assert.match(summaries[0], /Telemetry catalog: superseded/);
  }
});

test("completed syncs comment on the source PR with the proposal link or a no-change result", async t => {
  const directory = fixture(t);
  const content = `${JSON.stringify(expected, null, 2)}\n`;
  for (const [status, options, message, orphan] of [
    ["created", {}, /Opened a draft/],
    ["updated", { existing: true }, /Updated the draft/],
    ["unchanged", { current: content }, /No Aspire telemetry update needed/],
    ["closed", { current: content, existing: true }, /No Aspire telemetry update needed/],
    ["cleaned", { current: content }, /No Aspire telemetry update needed/, true]
  ]) {
    await t.test(status, async () => {
      const f = publisher(options);
      if (orphan) {
        const getRef = f.github.rest.git.getRef;
        f.github.rest.git.getRef = async args => args.ref === "heads/main"
          ? getRef(args)
          : { data: { object: { sha: head } } };
      }
      const core = {
        setOutput: () => {}, info: () => {}, warning: message => assert.fail(message),
        summary: { addRaw: () => ({ write: async () => {} }) }
      };
      const result = await runTelemetrySync({ ...f, core, directory, source, final: false });
      assert.equal(result.status, status);
      assert.deepEqual(f.sourceGithub.calls.map(call => call.name), ["listComments", "createComment"]);
      const comment = f.sourceGithub.calls[1].args;
      assert.equal(comment.issue_number, source.number);
      assert.match(comment.body, message);
      assert.ok(!comment.body.includes(source.commit));
      if (["created", "updated"].includes(status)) {
        assert.ok(comment.body.includes(`[PR in microsoft/aspire](${result.url})`));
      } else {
        assert.doesNotMatch(comment.body, /draft|\/pull\//);
      }
    });
  }
});

test("reruns update the bot's source comment without editing another user's comment or creating duplicates", async t => {
  const directory = fixture(t);
  const f = publisher();
  trackProposalState(f);
  const unrelated = {
    id: 100, body: "<!-- aspire-skills-telemetry-sync -->\n\nA user's comment.", user: { login: "someone" }
  };
  f.sourceGithub.comments.push(unrelated);
  const core = {
    setOutput: () => {}, info: () => {}, warning: message => assert.fail(message),
    summary: { addRaw: () => ({ write: async () => {} }) }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    await runTelemetrySync({ ...f, core, directory, source, final: false });
  }
  assert.equal(f.sourceGithub.calls.filter(call => call.name === "createComment").length, 1);
  const updates = f.sourceGithub.calls.filter(call => call.name === "updateComment");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].args.comment_id, f.sourceGithub.comments[1].id);
  assert.match(f.sourceGithub.comments[1].body, /Updated the draft/);
  assert.equal(unrelated.body, "<!-- aspire-skills-telemetry-sync -->\n\nA user's comment.");
});

test("dry runs summarize the generated catalog and never comment on the source PR", async t => {
  const directory = fixture(t);
  const content = `${JSON.stringify(expected, null, 2)}\n`;
  for (const [current, status] of [["{}", "preview"], [content, "unchanged"]]) {
    const f = publisher({ current });
    const summaries = [];
    const core = {
      setOutput: () => {}, info: () => {}, warning: message => assert.fail(message),
      summary: { addRaw: value => ({ write: async () => summaries.push(value) }) }
    };
    await runTelemetrySync({ ...f, core, directory, source: { ...source, dryRun: true }, final: false });
    assert.equal(summaries.length, 1);
    assert.match(summaries[0], new RegExp(`<h2>Telemetry catalog: ${status}</h2>`));
    assert.ok(summaries[0].includes(content.replaceAll('"', "&quot;")));
    assert.equal(f.sourceGithub.calls.length, 0);
  }
});

test("source comment failures propagate while preserving the publication summary", async t => {
  const directory = fixture(t);
  const f = publisher();
  const failure = Object.assign(new Error("Comment permission denied"), { status: 403 });
  f.sourceGithub.rest.issues.createComment = async () => { throw failure; };
  const summaries = [];
  const core = {
    setOutput: () => {}, info: () => {}, warning: message => assert.fail(message),
    summary: { addRaw: value => ({ write: async () => summaries.push(value) }) }
  };
  await assert.rejects(
    runTelemetrySync({ ...f, core, directory, source, final: false }),
    error => error === failure
  );
  assert.equal(f.calls.filter(call => call.name === "pulls.create").length, 1);
  assert.equal(summaries.length, 1);
  assert.match(summaries[0], /https:\/\/github\.com\/microsoft\/aspire\/pull\/42/);
});

test("a superseded run publishes the newly resolved main inventory on retry", async t => {
  const firstDirectory = fixture(t);
  const retryDirectory = fixture(t);
  write(retryDirectory, "skills/beta/SKILL.md");
  write(retryDirectory, "skills/beta/references/new.md");

  let currentMain = commit;
  const comparisons = [];
  const sourceGithub = sourceGithubFor({ merged: true, calls: comparisons });
  sourceGithub.rest.git.getRef = async args => {
    assert.deepEqual(args, { owner: "microsoft", repo: "aspire-skills", ref: "heads/main" });
    return { data: { object: { sha: currentMain } } };
  };
  const f = publisher();
  const outputs = [];
  const summaries = [];
  const core = {
    setOutput: (name, value) => outputs.push([name, value]),
    info: () => {},
    warning: message => assert.fail(message),
    summary: { addRaw: value => ({ write: async () => summaries.push(value) }) }
  };
  const context = sourceContext();
  const first = await resolveTelemetrySource({ github: sourceGithub, context });
  currentMain = newer;
  const superseded = await runTelemetrySync({
    ...f, sourceGithub, core, directory: firstDirectory, source: first, final: false
  });
  assert.equal(superseded.status, "superseded");
  assert.deepEqual(f.calls.map(call => call.name), ["git.getRef", "repos.getContent"]);
  assert.equal(summaries.length, 0);
  assert.equal(sourceGithub.calls.length, 0);

  const retry = await resolveTelemetrySource({ github: sourceGithub, context });
  const result = await runTelemetrySync({
    ...f, sourceGithub, core, directory: retryDirectory, source: retry, final: true
  });
  assert.equal(retry.commit, newer);
  assert.deepEqual(comparisons.map(comparison => comparison.head), [commit, newer]);
  assert.equal(result.status, "created");
  const published = f.calls.find(call => call.name === "git.createTree").args.tree[0].content;
  assert.deepEqual(JSON.parse(published), {
    skills: ["alpha", "beta", "zeta"],
    references: [...expected.references, "beta/references/new.md"]
  });
  assert.deepEqual(outputs, [["status", "superseded"], ["status", "created"]]);
  assert.equal(summaries.length, 1);
  assert.equal(sourceGithub.calls.filter(call => call.name === "createComment").length, 1);
  assert.ok(sourceGithub.comments[0].body.includes(`[PR in microsoft/aspire](${result.url})`));
  assert.ok(!sourceGithub.comments[0].body.includes(newer));
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
    [{ skills: ["a".repeat(129)], references: ["a".repeat(129) + "/references/a.md"] }, /Invalid skill identifier/],
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

test("reference paths reject names the Aspire telemetry hook would discard", () => {
  for (const path of [
    "alpha/references/r\u00e9sum\u00e9.md",
    "alpha/references/space name.md",
    "alpha/references/part..md",
    `alpha/references/${"a".repeat(256)}`
  ]) {
    assert.throws(() => validateTelemetryCatalog({
      skills: ["alpha"], references: [path]
    }), /Invalid reference path/);
  }
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
  rmSync(join(directory, "skills", "bad.name"), { recursive: true, force: true });
  write(directory, "skills/alpha/references/r\u00e9sum\u00e9.md");
  assert.throws(() => generateTelemetryCatalog(directory), /Invalid reference path/);
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
  assert.equal(pr.body, [
    `Sync the telemetry catalog with [microsoft/aspire-skills#123](${source.url}).`,
    "",
    "Generated from canonical `skills/` directories and their `references/` files.",
    "",
    "<!-- aspire-skills-telemetry-catalog -->"
  ].join("\n"));
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
  assert.deepEqual(f.calls.find(call => call.name === "issues.addLabels").args.labels, [
    "area-cli", "area-engineering-systems"
  ]);
});

test("a label failure is retried when an existing proposal is synchronized again", async t => {
  const directory = fixture(t);
  const f = publisher({ existing: true });
  let attempts = 0;
  f.github.rest.issues.addLabels = async args => {
    f.calls.push({ name: "issues.addLabels", args });
    if (attempts++ === 0) throw new Error("Temporary label failure");
    return { data: [] };
  };

  await assert.rejects(syncTelemetryCatalog({ ...f, directory, source }), /Temporary label failure/);
  assert.equal((await syncTelemetryCatalog({ ...f, directory, source })).status, "updated");
  assert.equal(attempts, 2);
});

test("a missing label on an open proposal surfaces instead of replacing the proposal", async t => {
  const directory = fixture(t);
  const f = publisher({ existing: true });
  const failure = Object.assign(new Error("Label not found"), { status: 404 });
  f.github.rest.issues.addLabels = async () => { throw failure; };
  await assert.rejects(syncTelemetryCatalog({ ...f, directory, source }), error => error === failure);
  assert.ok(!f.calls.some(call => call.name === "pulls.create"));
});

test("a ready proposal is returned to draft before its branch is updated", async t => {
  const directory = fixture(t);
  const f = publisher({ existing: true });
  f.github.rest.pulls.list = async args => {
    f.calls.push({ name: "pulls.list", args });
    return { data: [{
      number: 42, node_id: "PR_42", draft: false,
      html_url: "https://github.com/microsoft/aspire/pull/42"
    }] };
  };

  const result = await syncTelemetryCatalog({ ...f, directory, source });
  assert.equal(result.status, "updated");
  assert.ok(f.calls.findIndex(call => call.name === "graphql") < f.calls.findIndex(call => call.name === "git.updateRef"));
  assert.deepEqual(f.calls.find(call => call.name === "graphql").variables, { pullRequestId: "PR_42" });
});

test("a failed draft conversion prevents the proposal branch from being updated", async t => {
  const directory = fixture(t);
  const f = publisher({ existing: true });
  f.github.rest.pulls.list = async () => ({ data: [{
    number: 42, node_id: "PR_42", draft: false,
    html_url: "https://github.com/microsoft/aspire/pull/42"
  }] });
  f.github.graphql = async () => ({ convertPullRequestToDraft: { pullRequest: { isDraft: false } } });

  await assert.rejects(syncTelemetryCatalog({ ...f, directory, source }), /Unable to return the telemetry proposal to draft/);
  assert.ok(!f.calls.some(call => call.name === "git.updateRef"));
});

test("repeated publication reuses the already generated commit", async t => {
  const directory = fixture(t);
  const f = publisher({ existing: true, identicalHead: true });
  assert.equal((await syncTelemetryCatalog({ ...f, directory, source })).status, "updated");
  assert.ok(!f.calls.some(call => ["git.createCommit", "git.updateRef", "git.createRef"].includes(call.name)));
});

test("an identical tree on a stale or merge commit is rebuilt on current Aspire main", async t => {
  const directory = fixture(t);
  for (const parents of [[{ sha: moved }], [{ sha: base }, { sha: moved }]]) {
    const f = publisher({ existing: true, identicalHead: true });
    const getCommit = f.github.rest.git.getCommit;
    f.github.rest.git.getCommit = async args => args.commit_sha === head
      ? { data: { tree: { sha: "generated-tree" }, parents } }
      : getCommit(args);
    assert.equal((await syncTelemetryCatalog({ ...f, directory, source })).status, "updated");
    assert.deepEqual(f.calls.find(call => call.name === "git.createCommit").args.parents, [base]);
    assert.equal(f.calls.find(call => call.name === "git.updateRef").args.force, true);
  }
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

test("a branch deleted during update is recreated, while an existing branch error propagates", async t => {
  const directory = fixture(t);
  const f = publisher({ existing: true });
  let branchExists = true;
  const getRef = f.github.rest.git.getRef;
  f.github.rest.git.getRef = async args => {
    if (args.ref === "heads/update-aspire-telemetry-catalog" && !branchExists) {
      f.calls.push({ name: "git.getRef", args });
      throw Object.assign(new Error("Not found"), { status: 404 });
    }
    return getRef(args);
  };
  f.github.rest.git.updateRef = async args => {
    f.calls.push({ name: "git.updateRef", args });
    branchExists = false;
    throw Object.assign(new Error("Reference does not exist"), { status: 422 });
  };

  const result = await syncTelemetryCatalog({ ...f, directory, source });
  assert.equal(result.status, "updated");
  assert.equal(f.calls.filter(call => call.name === "git.createRef").length, 1);
  const branchLookups = f.calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => call.name === "git.getRef" && call.args.ref === "heads/update-aspire-telemetry-catalog");
  assert.equal(branchLookups.length, 2);
  assert.ok(branchLookups[0].index < f.calls.findIndex(call => call.name === "git.updateRef"));
  assert.ok(f.calls.findIndex(call => call.name === "git.updateRef") < branchLookups[1].index);
  assert.ok(branchLookups[1].index < f.calls.findIndex(call => call.name === "git.createRef"));

  const g = publisher({ existing: true });
  const updateFailure = Object.assign(new Error("Reference update rejected"), { status: 422 });
  g.github.rest.git.updateRef = async () => { throw updateFailure; };
  await assert.rejects(syncTelemetryCatalog({ ...g, directory, source }), error => error === updateFailure);
});

const moved = "5".repeat(40);

// Returns each Aspire main SHA in turn, repeating the last one, and serves catalog content per ref.
function moveTargetMain(f, shas, catalogs = {}) {
  const getRef = f.github.rest.git.getRef;
  let index = 0;
  f.github.rest.git.getRef = async args => {
    if (args.ref !== "heads/main") return getRef(args);
    f.calls.push({ name: "git.getRef", args });
    return { data: { object: { sha: shas[Math.min(index++, shas.length - 1)] } } };
  };
  const getContent = f.github.rest.repos.getContent;
  f.github.rest.repos.getContent = async args => {
    if (!(args.ref in catalogs)) return getContent(args);
    f.calls.push({ name: "repos.getContent", args });
    return { data: { type: "file", encoding: "base64", content: Buffer.from(catalogs[args.ref]).toString("base64") } };
  };
  const getCommit = f.github.rest.git.getCommit;
  f.github.rest.git.getCommit = async args => args.commit_sha === moved
    ? { data: { tree: { sha: "moved-tree" }, parents: [] } }
    : getCommit(args);
}

function sourceSequence(f, shas) {
  let index = 0;
  f.sourceGithub = { rest: { git: { getRef: async () => ({
    data: { object: { sha: shas[Math.min(index++, shas.length - 1)] } }
  }) } } };
}

test("source main moving during publication supersedes the published proposal for retry", async t => {
  const directory = fixture(t);
  const f = publisher();
  sourceSequence(f, [commit, newer]);
  const result = await syncTelemetryCatalog({ ...f, directory, source });
  assert.equal(result.status, "superseded");
  assert.equal(result.url, "https://github.com/microsoft/aspire/pull/42");
  assert.ok(f.calls.some(call => call.name === "pulls.create"));

  const summaries = [];
  const core = {
    setOutput: () => {}, info: () => {}, warning: message => assert.fail(message),
    summary: { addRaw: value => ({ write: async () => summaries.push(value) }) }
  };
  const g = publisher({ existing: true });
  sourceSequence(g, [commit, newer]);
  assert.equal((await runTelemetrySync({ ...g, core, directory, source, final: false })).status, "superseded");
  assert.equal(summaries.length, 0);
  sourceSequence(g, [commit, newer]);
  await assert.rejects(runTelemetrySync({ ...g, core, directory, source, final: true }), /may not reflect current main/);
  assert.match(summaries[0], /may not reflect current main/);
  assert.match(summaries[0], /https:\/\/github\.com\/microsoft\/aspire\/pull\/42/);
});

test("Aspire main moving before closure re-evaluates the catalog instead of closing the proposal", async t => {
  const directory = fixture(t);
  const f = publisher({ current: `${JSON.stringify(expected, null, 2)}\n`, existing: true });
  moveTargetMain(f, [base, moved], { [moved]: '{"skills":[],"references":[]}\n' });
  const result = await syncTelemetryCatalog({ ...f, directory, source });
  assert.equal(result.status, "updated");
  assert.ok(!f.calls.some(call => call.name === "issues.createComment" || call.name === "git.deleteRef"));
  assert.ok(!f.calls.some(call => call.name === "pulls.update" && call.args.state === "closed"));
  assert.deepEqual(f.calls.find(call => call.name === "git.createCommit").args.parents, [moved]);
  assert.equal(f.calls.find(call => call.name === "git.createTree").args.base_tree, "moved-tree");
});

// Makes open proposals and the bot branch follow the publisher's own close, delete, and create calls.
function trackProposalState(f, { open = [], branch = false } = {}) {
  const wrap = (group, method, effect) => {
    const original = f.github.rest[group][method];
    f.github.rest[group][method] = async args => {
      const response = await original(args);
      effect(args, response.data);
      return response;
    };
  };
  wrap("pulls", "create", (_, proposal) => { open = [proposal]; });
  wrap("pulls", "update", args => { if (args.state === "closed") open = []; });
  wrap("git", "createRef", () => { branch = true; });
  wrap("git", "deleteRef", () => { branch = false; });
  f.github.rest.pulls.list = async args => {
    f.calls.push({ name: "pulls.list", args });
    return { data: open };
  };
  const getRef = f.github.rest.git.getRef;
  f.github.rest.git.getRef = async args => {
    if (args.ref === "heads/main") return getRef(args);
    f.calls.push({ name: "git.getRef", args });
    if (!branch) throw Object.assign(new Error("Not found"), { status: 404 });
    return { data: { object: { sha: head } } };
  };
}

test("a source superseded during publication retries with the new inventory", async t => {
  const firstDirectory = fixture(t);
  const retryDirectory = fixture(t);
  write(retryDirectory, "skills/beta/SKILL.md");
  write(retryDirectory, "skills/beta/references/new.md");
  const f = publisher();
  trackProposalState(f);
  let currentMain = commit;
  const comparisons = [];
  f.sourceGithub = sourceGithubFor({ merged: true, calls: comparisons });
  f.sourceGithub.rest.git.getRef = async () => ({ data: { object: { sha: currentMain } } });
  const create = f.github.rest.pulls.create;
  f.github.rest.pulls.create = async args => {
    const result = await create(args);
    currentMain = newer;
    return result;
  };
  const outputs = [];
  const core = {
    setOutput: (_, value) => outputs.push(value), info: () => {}, warning: message => assert.fail(message),
    summary: { addRaw: () => ({ write: async () => {} }) }
  };
  const context = sourceContext();
  const first = await resolveTelemetrySource({ github: f.sourceGithub, context });
  assert.equal((await runTelemetrySync({
    ...f, core, directory: firstDirectory, source: first, final: false
  })).status, "superseded");
  const retry = await resolveTelemetrySource({ github: f.sourceGithub, context });
  assert.equal(retry.commit, newer);
  assert.deepEqual(comparisons.map(comparison => comparison.head), [commit, newer]);
  assert.equal((await runTelemetrySync({
    ...f, core, directory: retryDirectory, source: retry, final: true
  })).status, "updated");
  const trees = f.calls.filter(call => call.name === "git.createTree");
  assert.deepEqual(JSON.parse(trees.at(-1).args.tree[0].content), {
    skills: ["alpha", "beta", "zeta"],
    references: [...expected.references, "beta/references/new.md"]
  });
  assert.ok(!f.calls.find(call => call.name === "pulls.update").args.body.includes(newer));
  assert.deepEqual(outputs, ["superseded", "updated"]);
});

test("Aspire main moving after closure reconciles against the new main", async t => {
  const directory = fixture(t);
  const f = publisher({ current: `${JSON.stringify(expected, null, 2)}\n`, existing: true });
  // Closure succeeds against base, then main moves to a catalog that needs a proposal again.
  moveTargetMain(f, [base, base, moved], { [moved]: '{"skills":[],"references":[]}\n' });
  trackProposalState(f, { open: [{ number: 42, html_url: "https://github.com/microsoft/aspire/pull/42" }], branch: true });
  const result = await syncTelemetryCatalog({ ...f, directory, source });
  assert.equal(result.status, "created");
  assert.ok(f.calls.some(call => call.name === "pulls.update" && call.args.state === "closed"));
  assert.deepEqual(f.calls.find(call => call.name === "git.createCommit").args.parents, [moved]);
  assert.equal(f.calls.filter(call => call.name === "pulls.create").length, 1);
});

test("Aspire main moving during publication rebuilds the proposal on the current main", async t => {
  const directory = fixture(t);
  const f = publisher();
  // Attempt one publishes on base, then the post-publication check sees moved main.
  moveTargetMain(f, [base, base, moved]);
  trackProposalState(f);
  const result = await syncTelemetryCatalog({ ...f, directory, source });
  assert.equal(result.status, "created");
  assert.deepEqual(
    f.calls.filter(call => call.name === "git.createCommit").map(call => call.args.parents),
    [[base], [moved]]
  );
  assert.equal(f.calls.filter(call => call.name === "git.createRef").length, 1);
  assert.equal(f.calls.filter(call => call.name === "git.updateRef").length, 1);
  assert.equal(f.calls.filter(call => call.name === "pulls.create").length, 1);
});

test("Aspire main moving before branch publication rebuilds from the new main", async t => {
  const directory = fixture(t);
  const f = publisher();
  moveTargetMain(f, [base, moved]);
  const result = await syncTelemetryCatalog({ ...f, directory, source });
  assert.equal(result.status, "created");
  assert.deepEqual(f.calls.filter(call => call.name === "git.createCommit").map(call => call.args.parents), [[moved]]);
  assert.equal(f.calls.filter(call => call.name === "git.createRef").length, 1);
});

test("a target move that rejects PR creation is reconciled against the new catalog", async t => {
  const directory = fixture(t);
  const f = publisher();
  let currentMain = base;
  const getRef = f.github.rest.git.getRef;
  f.github.rest.git.getRef = async args => args.ref === "heads/main"
    ? { data: { object: { sha: currentMain } } }
    : getRef(args);
  const getContent = f.github.rest.repos.getContent;
  f.github.rest.repos.getContent = async args => args.ref === moved
    ? { data: { type: "file", encoding: "base64", content: Buffer.from(`${JSON.stringify(expected, null, 2)}\n`).toString("base64") } }
    : getContent(args);
  trackProposalState(f);
  f.github.rest.pulls.create = async () => {
    currentMain = moved;
    throw Object.assign(new Error("No commits between branches"), { status: 422 });
  };
  const result = await syncTelemetryCatalog({ ...f, directory, source });
  assert.equal(result.status, "cleaned");
  assert.ok(f.calls.some(call => call.name === "git.deleteRef"));
});

test("a label failure is not masked by a concurrent target move", async t => {
  const directory = fixture(t);
  const f = publisher();
  trackProposalState(f);
  let currentMain = base;
  const getRef = f.github.rest.git.getRef;
  f.github.rest.git.getRef = async args => args.ref === "heads/main"
    ? { data: { object: { sha: currentMain } } }
    : getRef(args);
  const failure = Object.assign(new Error("Label validation failed"), { status: 422 });
  f.github.rest.issues.addLabels = async () => {
    currentMain = moved;
    throw failure;
  };

  await assert.rejects(syncTelemetryCatalog({ ...f, directory, source }), error => error === failure);
  assert.equal(f.calls.filter(call => call.name === "pulls.create").length, 1);
  assert.ok(!f.calls.some(call => call.name === "pulls.update"));
});

test("Aspire main moving before every publication fails without mutations", async t => {
  const directory = fixture(t);
  const f = publisher();
  const shas = Array.from({ length: 10 }, (_, index) => String(index + 5).repeat(40).slice(0, 40));
  moveTargetMain(f, shas, Object.fromEntries(shas.map(sha => [sha, '{"skills":[],"references":[]}\n'])));
  await assert.rejects(syncTelemetryCatalog({ ...f, directory, source }), /Aspire main moved during 3 synchronization attempts/);
  assert.ok(!f.calls.some(call => /git\.(createCommit|createRef|updateRef)|pulls\.(create|update)|issues\./.test(call.name)));
});

test("a source superseded during repeated target races still triggers source retry", async t => {
  const directory = fixture(t);
  const f = publisher();
  const shas = Array.from({ length: 10 }, (_, index) => String(index + 5).repeat(40).slice(0, 40));
  moveTargetMain(f, shas, Object.fromEntries(shas.map(sha => [sha, '{"skills":[],"references":[]}\n'])));
  sourceSequence(f, [commit, commit, commit, newer]);
  assert.equal((await syncTelemetryCatalog({ ...f, directory, source })).status, "superseded");
});

test("a proposal closed or removed before update is replaced by one new draft PR", async t => {
  const directory = fixture(t);
  for (const failure of [{ state: "closed" }, { status: 404 }]) {
    const f = publisher({ existing: true });
    f.github.rest.pulls.update = async args => {
      f.calls.push({ name: "pulls.update", args });
      if (failure.status) throw Object.assign(new Error("Not found"), { status: failure.status });
      return { data: { number: args.pull_number, state: failure.state, html_url: "https://github.com/microsoft/aspire/pull/42" } };
    };
    const result = await syncTelemetryCatalog({ ...f, directory, source });
    assert.equal(result.status, "created");
    assert.equal(f.calls.filter(call => call.name === "pulls.create").length, 1);
    assert.equal(f.calls.find(call => call.name === "pulls.create").args.draft, true);
    assert.ok(f.calls.some(call => call.name === "issues.addLabels"));
  }
  const f = publisher({ existing: true });
  f.github.rest.pulls.update = async () => { throw Object.assign(new Error("Forbidden"), { status: 403 }); };
  await assert.rejects(syncTelemetryCatalog({ ...f, directory, source }), /Forbidden/);
  assert.ok(!f.calls.some(call => call.name === "pulls.create"));
});

test("a leftover branch from a closed proposal is reset and gets one new draft PR", async t => {
  const directory = fixture(t);
  const f = publisher({ existing: true });
  f.github.rest.pulls.list = async args => {
    f.calls.push({ name: "pulls.list", args });
    return { data: [] };
  };
  const result = await syncTelemetryCatalog({ ...f, directory, source });
  assert.equal(result.status, "created");
  assert.equal(f.calls.find(call => call.name === "git.updateRef").args.force, true);
  assert.ok(!f.calls.some(call => call.name === "git.createRef" || call.name === "pulls.update"));
  assert.equal(f.calls.filter(call => call.name === "pulls.create").length, 1);
});

test("a proposal opened concurrently is reused instead of duplicated", async t => {
  const directory = fixture(t);
  const f = publisher();
  let listed = 0;
  f.github.rest.pulls.list = async args => {
    f.calls.push({ name: "pulls.list", args });
    return { data: listed++ ? [{ number: 77, html_url: "https://github.com/microsoft/aspire/pull/77" }] : [] };
  };
  f.github.rest.pulls.create = async args => {
    f.calls.push({ name: "pulls.create", args });
    throw Object.assign(new Error("A pull request already exists"), { status: 422 });
  };
  const result = await syncTelemetryCatalog({ ...f, directory, source });
  assert.equal(result.status, "updated");
  assert.equal(result.url, "https://github.com/microsoft/aspire/pull/77");
  assert.equal(f.calls.find(call => call.name === "pulls.update").args.pull_number, 77);
  assert.ok(f.calls.some(call => call.name === "issues.addLabels"));

  const g = publisher();
  g.github.rest.pulls.create = async () => { throw Object.assign(new Error("Head missing"), { status: 422 }); };
  await assert.rejects(syncTelemetryCatalog({ ...g, directory, source }), /Head missing/);
});

test("a concurrently opened proposal that closes again is replaced, not reported as updated", async t => {
  const directory = fixture(t);
  const f = publisher();
  let created = 0;
  f.github.rest.pulls.create = async () => {
    if (created++ === 0) throw Object.assign(new Error("A pull request already exists"), { status: 422 });
    return { data: { number: 78, state: "open", html_url: "https://github.com/microsoft/aspire/pull/78" } };
  };
  let listed = 0;
  f.github.rest.pulls.list = async () => ({
    data: listed++ ? [{ number: 77, html_url: "https://github.com/microsoft/aspire/pull/77" }] : []
  });
  f.github.rest.pulls.update = async () => ({ data: { number: 77, state: "closed" } });
  const result = await syncTelemetryCatalog({ ...f, directory, source });
  assert.equal(result.status, "created");
  assert.equal(result.url, "https://github.com/microsoft/aspire/pull/78");
  assert.equal(created, 2);
});

test("repeatedly closed competing proposals fail instead of reporting success", async t => {
  const directory = fixture(t);
  const f = publisher();
  let listed = 0;
  f.github.rest.pulls.list = async () => ({ data: listed++ ? [{ number: 77 }] : [] });
  f.github.rest.pulls.create = async () => {
    throw Object.assign(new Error("A pull request already exists"), { status: 422 });
  };
  f.github.rest.pulls.update = async () => ({ data: { number: 77, state: "closed" } });
  await assert.rejects(syncTelemetryCatalog({ ...f, directory, source }), /Unable to keep a telemetry proposal open/);
});

function sourceGithubFor({
  merged, mergeSha = commit, main = newer, status = "ahead", calls = [],
  baseRef = "main", baseRepo = "microsoft/aspire-skills"
}) {
  const github = sourceClient(main);
  github.rest.pulls = { get: async args => {
    assert.deepEqual(args, { owner: "microsoft", repo: "aspire-skills", pull_number: 123 });
    return { data: {
      base: { ref: baseRef, repo: { full_name: baseRepo } },
      merged, merge_commit_sha: mergeSha, head: { sha: head }
    } };
  } };
  github.rest.repos = { compareCommits: async args => {
    calls.push(args);
    return { data: { status } };
  } };
  return github;
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

test("source resolution rejects malformed PR numbers, non-main targets, and mutable source refs", async () => {
  for (const value of ["12abc", "0", "-1", "1e2", "012", " 123", "", "9007199254740993", undefined]) {
    const github = sourceGithubFor({ merged: true });
    const get = github.rest.pulls.get;
    let fetched = false;
    github.rest.pulls.get = async args => { fetched = true; return get(args); };
    const context = sourceContext({ manual: true });
    context.payload.inputs.pr_number = value;
    await assert.rejects(resolveTelemetrySource({ github, context }), /pr_number must be a positive integer/, String(value));
    assert.equal(fetched, false);
  }
  for (const [options, message] of [
    [{ baseRef: "release/1.0" }, /must target microsoft\/aspire-skills main/],
    [{ baseRepo: "example/aspire-skills" }, /must target microsoft\/aspire-skills main/],
    [{ main: "main" }, /immutable commit SHA/],
    [{ main: "A".repeat(40) }, /immutable commit SHA/],
    [{ main: undefined }, /immutable commit SHA/]
  ]) {
    for (const manual of [false, true]) {
      const calls = [];
      const github = sourceGithubFor({ merged: true, calls, ...options });
      if ("main" in options && options.main === undefined) {
        github.rest.git.getRef = async () => ({ data: { object: {} } });
      }
      await assert.rejects(resolveTelemetrySource({ github, context: sourceContext({ manual }) }), message);
      assert.deepEqual(calls, []);
    }
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
  assert.deepEqual(workflow.permissions, { contents: "read", "pull-requests": "write" });
  assert.deepEqual(workflow.on.pull_request, { branches: ["main"], types: ["closed"] });
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, false);
  assert.equal(workflow.concurrency, undefined);
  const group = new Function("inputs", "github", "format", `return ${workflow.jobs.sync.concurrency.group.slice(3, -2)};`);
  const format = (pattern, ...args) => pattern.replace(/\{(\d+)\}/g, (_, index) => args[index]);
  assert.equal(group({ dry_run: false }, { run_id: 7 }, format), "aspire-skills-to-aspire");
  assert.equal(group({}, { run_id: 7 }, format), "aspire-skills-to-aspire");
  assert.equal(group({ dry_run: true }, { run_id: 7 }, format), "aspire-skills-to-aspire-preview-7");
  assert.equal(workflow.jobs.sync.concurrency["cancel-in-progress"], false);
  // The default single-slot queue would let a newer publishing job replace an already-pending one.
  assert.equal(workflow.jobs.sync.concurrency.queue, "max");
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
    { ref: "${{ steps.source.outputs.commit }}", path: "_source", "persist-credentials": false },
    { ref: "${{ steps.retry-source.outputs.commit }}", path: "_source-retry", "persist-credentials": false }
  ]);
  const token = workflow.jobs.sync.steps.find(step => step.uses?.startsWith("actions/create-github-app-token@"));
  assert.equal(token.if, "steps.source.outputs.dry-run != 'true'");
  assert.equal(token.with.repositories, "aspire");
  assert.equal(workflow.jobs.sync.steps.some(step => step.run), false);
  const scripts = workflow.jobs.sync.steps.filter(step => step.uses?.startsWith("actions/github-script@"));
  const [resolve, sync, retryResolve, retrySync] = scripts;
  assert.equal(scripts.length, 4);
  for (const step of scripts) {
    assert.match(step.with.script, /\/scripts\/update-aspire-workflow\.mjs/);
  }
  for (const step of [sync, retrySync]) {
    assert.equal(step.env.SOURCE_TOKEN, "${{ github.token }}");
    assert.match(step.with.script, /sourceGithub: getOctokit\(process\.env\.SOURCE_TOKEN\)/);
  }
  // The single retry re-runs the same guarded resolution against newer main, never the mutable branch head.
  assert.equal(resolve.with["github-token"], undefined);
  assert.equal(retryResolve.with["github-token"], undefined);
  assert.match(retryResolve.with.script, /resolveTelemetrySource\(\{ github, context \}\)/);
  assert.match(sync.with.script, /_source`,[\s\S]*final: false/);
  assert.match(retrySync.with.script, /_source-retry`,[\s\S]*final: true/);
  assert.equal(retrySync.env.TELEMETRY_SOURCE, "${{ steps.retry-source.outputs.source }}");
  const retrySteps = workflow.jobs.sync.steps.slice(workflow.jobs.sync.steps.indexOf(sync) + 1);
  assert.equal(retrySteps.length, 3);
  for (const step of retrySteps) assert.equal(step.if, "steps.sync.outputs.status == 'superseded'");
});

test("resolve steps set every source output that later workflow steps read", async () => {
  const steps = workflow.jobs.sync.steps;
  const text = JSON.stringify(steps);
  const AsyncFunction = (async () => {}).constructor;
  // A file URL keeps the workflow's `${GITHUB_WORKSPACE}/scripts/...` import valid on Windows too.
  const process = { env: { GITHUB_WORKSPACE: pathToFileURL(root).href } };
  for (const id of ["source", "retry-source"]) {
    const reads = new Set([...text.matchAll(new RegExp(`steps\\.${id}\\.outputs\\.([\\w-]+)`, "g"))].map(match => match[1]));
    assert.ok(reads.size > 0, id);
    const script = new AsyncFunction("github", "context", "core", "process", steps.find(step => step.id === id).with.script);
    for (const [options, dryRun] of [[{}, false], [{ manual: true, dryRun: true }, true]]) {
      const outputs = {};
      const core = { setOutput: (name, value) => { outputs[name] = value; } };
      await script(sourceGithubFor({ merged: true }), sourceContext(options), core, process);
      for (const name of reads) assert.ok(name in outputs, `${id} must set ${name}`);
      assert.equal(outputs.commit, newer);
      assert.deepEqual(JSON.parse(outputs.source), { ...source, commit: newer, dryRun });
      if ("dry-run" in outputs) assert.equal(outputs["dry-run"], String(dryRun));
    }
  }
});
