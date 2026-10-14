import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Repository } from "../scripts/release-git.mjs";
import { buildCatalog } from "../scripts/build-opencode-catalog.mjs";
import { parse } from "yaml";

test("catalog parity runs on every PR, supported pushes, and merge groups without skips", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/catalog-check.yml", import.meta.url), "utf8"));
  assert.ok(Object.hasOwn(workflow.on, "merge_group"));
  assert.equal(workflow.on.pull_request.branches, undefined);
  assert.equal(workflow.on.pull_request.paths, undefined);
  assert.deepEqual(workflow.on.push, { branches: ["main", "dev", "release/**"] });
  const job = workflow.jobs["catalog-check"];
  assert.equal(job.name, "OpenCode catalog check");
  assert.equal(job.if, undefined);
  assert.ok(job.steps.every(step => step.if === undefined && step["continue-on-error"] === undefined));
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "catalog-parity-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const initialized = spawnSync("git", ["init", "--quiet", root], {
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const repo = new Repository(root);
  const write = (path, contents) => {
    const destination = join(root, ...path.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  };
  const commit = () => {
    repo.run(["add", "--all"]);
    repo.run(["commit", "--quiet", "-m", "Select catalog tree"]);
  };
  const script = fileURLToPath(new URL("../scripts/check-opencode-catalog.mjs", import.meta.url));
  const check = () => spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8", timeout: 30_000 });
  const skill = "---\nname: aspire\nmetadata:\n  version: 0.0.4\n---\n\n# Aspire\n";
  write("skills/aspire/SKILL.md", skill);
  write("skills/aspire/references/usage.md", "[Entry](../SKILL.md#usage)\n");
  write("CHANGELOG.md", "# Changelog\n");
  buildCatalog(root);
  commit();
  return { root, repo, write, commit, check, skill };
}

test("catalog check uses the committed source and payload without modifying the worktree", t => {
  const f = fixture(t);
  f.write("skills/aspire/SKILL.md", "Uncommitted source is not the selected tree.\n");
  f.write("opencode/v2/aspire/aspire.md", "Uncommitted catalog is not the selected tree.\n");
  f.write("opencode/v2/untracked.md", "Untracked output.\n");
  const before = f.repo.run(["status", "--porcelain"]);
  const result = f.check();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.repo.run(["status", "--porcelain"]), before);
});

for (const [name, mutate] of [
  ["missing catalogs", f => f.repo.run(["rm", "-r", "--", "opencode"])],
  ["unexpected payload", f => f.write("opencode/v2/orphan.md", "Orphan.\n")],
  ["stale skill body", f => f.write("skills/aspire/SKILL.md", f.skill + "\nNew instructions.\n")],
  ["wrong content version", f => {
    const path = join(f.root, "opencode", "v1", "index.json");
    const index = JSON.parse(readFileSync(path));
    index.skills[0].version = "sha512-" + "0".repeat(128);
    f.write("opencode/v1/index.json", JSON.stringify(index, null, 2) + "\n");
  }]
]) {
  test(`catalog check rejects ${name}`, t => {
    const f = fixture(t);
    mutate(f);
    f.commit();
    const result = f.check();
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.length > 0);
  });
}

test("regeneration fixes source drift and removes orphaned catalog files", t => {
  const f = fixture(t);
  f.write("skills/aspire/SKILL.md", f.skill + "\nNew instructions.\n");
  f.write("opencode/v2/orphan.md", "Orphan.\n");
  f.commit();
  assert.equal(f.check().status, 1);
  buildCatalog(f.root);
  f.commit();
  assert.equal(f.check().status, 0);
});

test("catalog parity does not depend on release manifests or installed packages", t => {
  const f = fixture(t);
  f.write("package.json", '{"version":"9.9.9"}\n');
  f.write(".plugin/plugin.json", "Not part of the catalog source.\n");
  f.commit();
  const result = f.check();
  assert.equal(result.status, 0, result.stderr);
});

test("catalog generation leaves literal links in code spans and fenced blocks untouched", t => {
  const f = fixture(t);
  const examples = [
    "Real [entry](../SKILL.md) link.",
    "",
    "Inline `[Entry](SKILL.md)` and ``[Missing](missing.md)`` examples.",
    "",
    "```md",
    "[Example](example.md)",
    "[ref]: ../SKILL.md",
    "```",
    "",
    "~~~",
    "[Other](missing.md)",
    "~~~",
    ""
  ].join("\n");
  f.write("skills/aspire/references/examples.md", examples);
  buildCatalog(f.root);
  const generated = readFileSync(join(f.root, "opencode", "v2", "aspire", "references", "examples.md"), "utf8");
  assert.equal(generated, examples.replace("[entry](../SKILL.md)", "[entry](../aspire.md)"));
});

test("catalog generation still rejects broken links outside code", t => {
  const f = fixture(t);
  f.write("skills/aspire/references/broken.md", "`[Ok](missing.md)` but [broken](missing.md).\n");
  assert.throws(() => buildCatalog(f.root), /Broken relative Markdown link/);
});

test("regeneration replaces a file with a directory and back", t => {
  const f = fixture(t);
  const guide = join(f.root, "skills", "aspire", "guide");
  f.write("skills/aspire/guide", "File.\n");
  buildCatalog(f.root);
  rmSync(guide);
  f.write("skills/aspire/guide/usage.md", "Directory.\n");
  buildCatalog(f.root);
  assert.equal(readFileSync(join(f.root, "opencode", "v2", "aspire", "guide", "usage.md"), "utf8"), "Directory.\n");
  rmSync(guide, { recursive: true });
  f.write("skills/aspire/guide", "File.\n");
  buildCatalog(f.root);
  assert.equal(readFileSync(join(f.root, "opencode", "v2", "aspire", "guide"), "utf8"), "File.\n");
});
