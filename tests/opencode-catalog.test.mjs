import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertSafePath, buildCatalog, createCatalog, validateIndex } from "../scripts/build-opencode-catalog.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontmatter = "---\nname: aspire\ndescription: Test skill\nmetadata:\n  version: \"0.0.2\"\n---\n";
const entry = (overrides = {}) => ({
  name: "aspire", version: `sha512-${"a".repeat(128)}`, files: ["aspire.md"], ...overrides
});
const output = (path, format = "v2") => `dist/opencode/${format}/${path}`;
const artifactRoot = root => join(root, "dist", "opencode");
const catalogRoot = (root, format = "v2") => join(artifactRoot(root), format);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "opencode-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, "skills/aspire/SKILL.md", `${frontmatter}\nRead [guide](references/guide.md).\n`);
  put(root, "skills/aspire/references/guide.md", "[Back](../SKILL.md#workflow)\n");
  return root;
}

function put(root, path, contents) {
  const target = join(root, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function read(root, path) {
  return readFileSync(join(root, ...path.split("/")));
}

function inventory(root, prefix = "") {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? inventory(join(root, entry.name), path) : [path];
  }).sort();
}

test("both catalog formats contain every canonical skill and supporting file without a duplicate source tree", () => {
  const names = readdirSync(join(repoRoot, "skills")).sort();
  for (const format of ["v2", "v1"]) {
    const { index, files } = createCatalog(repoRoot, { format });
    validateIndex(index, { format });
    assert.deepEqual(index.skills.map(skill => skill.name), names);
    for (const skill of index.skills) {
      const entryFile = format === "v1" ? "SKILL.md" : `${skill.name}.md`;
      const sourceFiles = inventory(join(repoRoot, "skills", skill.name))
        .filter(path => !path.startsWith("evals/"))
        .map(path => path === "SKILL.md" ? entryFile : path).sort();
      assert.deepEqual(skill.files, sourceFiles);
      assert.match(skill.version, /^sha512-[0-9a-f]{128}$/);
      const manifest = skill.files.map(path => [
        path, createHash("sha512").update(files.get(`${skill.name}/${path}`)).digest("hex")
      ]);
      assert.equal(skill.version, `sha512-${createHash("sha512").update(JSON.stringify(manifest)).digest("hex")}`);
      const canonical = read(repoRoot, `skills/${skill.name}/SKILL.md`).toString().replaceAll("\r\n", "\n");
      const published = files.get(`${skill.name}/${entryFile}`).toString();
      assert.equal(published.split("\n---\n")[0], canonical.split("\n---\n")[0]);
      assert.match(published, new RegExp(`^name: ${skill.name}$`, "m"));
    }
    assert.deepEqual([...files.keys()].sort(), [
      "index.json", ...index.skills.flatMap(skill => skill.files.map(path => `${skill.name}/${path}`))
    ].sort());
  }
  if (existsSync(join(repoRoot, "opencode"))) {
    assert.deepEqual(inventory(join(repoRoot, "opencode")), [], "catalog copies must not live in the repository source tree");
  }
  assert.match(read(repoRoot, ".gitignore").toString(), /^dist\/$/m);
});

test("Pages artifact serves separate V1 and V2 catalogs and all their files", async t => {
  const root = fixture(t);
  buildCatalog(root);
  const pagesRoot = join(root, "dist");
  assert.deepEqual(readdirSync(pagesRoot), ["opencode"]);
  const files = new Map(inventory(pagesRoot).map(path => [path, read(root, `dist/${path}`)]));
  assert.ok([...files.keys()].every(path => path.startsWith("opencode/")));
  const prefix = "/aspire-skills/";
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const content = url.pathname.startsWith(prefix) ? files.get(url.pathname.slice(prefix.length)) : undefined;
    response.writeHead(content ? 200 : 404);
    response.end(content);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const site = `http://127.0.0.1:${server.address().port}${prefix}`;
  assert.equal((await fetch(`${site}index.json`)).status, 404);
  assert.equal((await fetch(`${site}opencode/index.json`)).status, 404);
  for (const format of ["v2", "v1"]) {
    const base = `${site}opencode/${format}/`;
    const response = await fetch(`${base}index.json`);
    assert.equal(response.status, 200);
    const index = await response.json();
    validateIndex(index, { format });
    for (const skill of index.skills) {
      for (const path of skill.files) {
        const file = await fetch(new URL(`${skill.name}/${path}`, base));
        assert.equal(file.status, 200, `${format}/${skill.name}/${path}`);
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), files.get(`opencode/${format}/${skill.name}/${path}`));
      }
    }
  }
});

test("generation preserves frontmatter, references, scripts, and binary assets and excludes development files", t => {
  const root = fixture(t);
  put(root, "skills/aspire/scripts/run.sh", "#!/bin/sh\r\necho hello\r\n");
  put(root, "skills/aspire/assets/invalid-utf8.bin", Buffer.from([0xff, 0xfe, 0x0d, 0x0a]));
  put(root, "skills/aspire/assets/zero.bin", Buffer.from([0, 0x0d, 0x0a]));
  for (const path of ["evals/eval.yaml", "evals/fixtures/SKILL.md", "tests/test.mjs", ".DS_Store", "node_modules/a.js", "__pycache__/a.pyc"]) {
    put(root, `skills/aspire/${path}`, "development");
  }
  const index = buildCatalog(root);
  assert.deepEqual(index.skills[0].files, [
    "aspire.md", "assets/invalid-utf8.bin", "assets/zero.bin", "references/guide.md", "scripts/run.sh"
  ]);
  assert.equal(read(root, output("aspire/aspire.md")).toString(), `${frontmatter}\nRead [guide](references/guide.md).\n`);
  assert.equal(read(root, output("aspire/references/guide.md")).toString(), "[Back](../aspire.md#workflow)\n");
  assert.equal(read(root, output("aspire/scripts/run.sh")).toString(), "#!/bin/sh\necho hello\n");
  for (const asset of ["invalid-utf8.bin", "zero.bin"]) {
    assert.deepEqual(read(root, output(`aspire/assets/${asset}`)), read(root, `skills/aspire/assets/${asset}`));
    assert.deepEqual(read(root, output(`aspire/assets/${asset}`, "v1")), read(root, `skills/aspire/assets/${asset}`));
  }
  const v1 = JSON.parse(read(root, output("index.json", "v1")));
  assert.deepEqual(v1.skills[0].files, [
    "SKILL.md", "assets/invalid-utf8.bin", "assets/zero.bin", "references/guide.md", "scripts/run.sh"
  ]);
  assert.equal(read(root, output("aspire/SKILL.md", "v1")).toString(), `${frontmatter}\nRead [guide](references/guide.md).\n`);
  assert.equal(read(root, output("aspire/references/guide.md", "v1")).toString(), "[Back](../SKILL.md#workflow)\n");
  assert.equal(read(root, output("aspire/scripts/run.sh", "v1")).toString(), "#!/bin/sh\necho hello\n");
  assert.deepEqual(buildCatalog(root, { check: true }), index);
  assert.equal(existsSync(join(root, "opencode")), false);
});

test("cross-skill links use canonical URLs without assuming a shared cache directory", t => {
  const root = fixture(t);
  put(root, "skills/aspire-init/SKILL.md", "---\nname: aspire-init\n---\nInit\n");
  put(root, "skills/aspire/references/guide.md", "[init](../../aspire-init/SKILL.md#start)\n");
  buildCatalog(root);
  assert.equal(read(root, output("aspire/references/guide.md")).toString(),
    "[init](https://github.com/microsoft/aspire-skills/blob/main/skills/aspire-init/SKILL.md#start)\n");
  assert.deepEqual(read(root, output("aspire/references/guide.md", "v1")), read(root, output("aspire/references/guide.md")));
});

test("versions change only for affected skills, including additions, renames, and removals", t => {
  const root = fixture(t);
  put(root, "skills/aspire-init/SKILL.md", "---\nname: aspire-init\n---\nInit\n");
  const versions = () => {
    const v2 = buildCatalog(root);
    const v1 = JSON.parse(read(root, output("index.json", "v1")));
    return [...v2.skills, ...v1.skills].map(skill => skill.version);
  };
  const initial = versions();
  const indexBytes = read(root, output("index.json"));
  assert.deepEqual(versions(), initial);
  assert.deepEqual(read(root, output("index.json")), indexBytes);
  let previous = initial;
  const changed = () => {
    const next = versions();
    assert.notEqual(next[0], previous[0]);
    assert.equal(next[1], initial[1]);
    assert.notEqual(next[2], previous[2]);
    assert.equal(next[3], initial[3]);
    previous = next;
  };
  put(root, "skills/aspire/references/guide.md", "Changed\n");
  changed();
  const contentOnly = previous;
  put(root, "skills/aspire/scripts/check.sh", "check\n");
  changed();
  unlinkSync(join(root, "skills", "aspire", "scripts", "check.sh"));
  put(root, "skills/aspire/scripts/renamed.sh", "check\n");
  changed();
  unlinkSync(join(root, "skills", "aspire", "scripts", "renamed.sh"));
  changed();
  assert.deepEqual(previous, contentOnly);
  assert.deepEqual(inventory(join(catalogRoot(root), "aspire")), ["aspire.md", "references/guide.md"]);
});

test("fresh builds reproduce versions without a Git history, saved index, or previous deployment", t => {
  const root = fixture(t);
  const index = buildCatalog(root);
  const files = inventory(artifactRoot(root)).map(path => [path, read(root, `dist/opencode/${path}`)]);
  rmSync(artifactRoot(root), { recursive: true });
  assert.deepEqual(buildCatalog(root), index);
  for (const [path, contents] of files) assert.deepEqual(read(root, `dist/opencode/${path}`), contents);
  put(root, "skills/aspire/evals/eval.yaml", "changed evaluation");
  assert.deepEqual(buildCatalog(root), index);
});

test("CRLF checkouts do not change published content or versions", t => {
  const root = fixture(t);
  const index = buildCatalog(root);
  for (const path of [
    "skills/aspire/SKILL.md", output("aspire/aspire.md"), output("index.json"),
    output("aspire/SKILL.md", "v1"), output("index.json", "v1")
  ]) {
    put(root, path, read(root, path).toString().replaceAll("\n", "\r\n"));
  }
  assert.deepEqual(buildCatalog(root, { check: true }), index);
  assert.deepEqual(buildCatalog(root), index);
});

test("removed skills and unlisted generated files are pruned without touching unrelated files", t => {
  const root = fixture(t);
  put(root, "skills/aspire-init/SKILL.md", "---\nname: aspire-init\n---\nInit\n");
  buildCatalog(root);
  unlinkSync(join(root, "skills", "aspire-init", "SKILL.md"));
  put(root, output("stale.txt"), "stale");
  put(root, "dist/unrelated.txt", "keep");
  assert.throws(() => buildCatalog(root, { check: true }), /out of sync/);
  buildCatalog(root);
  assert.deepEqual(inventory(artifactRoot(root)), [
    "v1/aspire/SKILL.md", "v1/aspire/references/guide.md", "v1/index.json",
    "v2/aspire/aspire.md", "v2/aspire/references/guide.md", "v2/index.json"
  ]);
  assert.equal(read(root, "dist/unrelated.txt").toString(), "keep");
});

for (const format of ["v2", "v1"]) {
  for (const mutation of ["missing", "changed", "unlisted", "incomplete-list", "bad-json", "stale-version"]) {
    test(`check mode rejects ${format} ${mutation} output and does not repair files`, t => {
      const root = fixture(t);
      buildCatalog(root);
      const index = JSON.parse(read(root, output("index.json", format)));
      const entryFile = format === "v1" ? "SKILL.md" : "aspire.md";
      if (mutation === "missing") unlinkSync(join(catalogRoot(root, format), "aspire", entryFile));
      if (mutation === "changed") put(root, output(`aspire/${entryFile}`, format), "tampered");
      if (mutation === "unlisted") put(root, output("extra.md", format), "extra");
      if (mutation === "incomplete-list") {
        index.skills[0].files = [entryFile];
        put(root, output("index.json", format), JSON.stringify(index));
      }
      if (mutation === "bad-json") put(root, output("index.json", format), "{");
      if (mutation === "stale-version") {
        put(root, "skills/aspire/references/guide.md", "changed source");
        buildCatalog(root);
        put(root, output("index.json", format), `${JSON.stringify(index, null, 2)}\n`);
      }
      const before = inventory(artifactRoot(root)).map(path => [path, read(root, `dist/opencode/${path}`)]);
      assert.throws(() => buildCatalog(root, { check: true }));
      for (const [path, contents] of before) assert.deepEqual(read(root, `dist/opencode/${path}`), contents);
    });
  }
}

for (const path of ["", "..", "../escape", "/absolute", "//host/path", "C:/file", "a\\b", "a/./b",
  "a//b", "a/../b", "a?query", "a#hash", "%2e%2e/file", "https://host/file", "a\nb", "a.", "con", "NUL.txt"]) {
  test(`rejects unsafe HTTP or filesystem path ${JSON.stringify(path)}`, () => {
    assert.throws(() => assertSafePath(path), /Unsafe catalog path/);
    assert.throws(() => validateIndex({ skills: [entry({ files: ["aspire.md", path] })] }));
    assert.throws(() => validateIndex({ skills: [entry({ files: ["SKILL.md", path] })] }, { format: "v1" }));
  });
}

test("index rejects invalid IDs, versions, entry files, duplicates, collisions, and development files", () => {
  for (const index of [null, {}, { skills: [] }, { skills: [entry(), entry()] },
    ...[
      { name: "../aspire" }, { name: "Aspire" }, { name: "a".repeat(65) },
      { version: 1 }, { version: "" }, { version: "1" }, { version: `sha512-${"g".repeat(128)}` },
      { version: `sha256-${"a".repeat(64)}` }, { version: `sha512-${"a".repeat(64)}` },
      { files: ["SKILL.md"] }, { files: ["aspire.md", "SKILL.md"] },
      { files: ["aspire.md", "aspire.md"] }, { files: ["aspire.md", "ASPIRE.md"] },
      { files: ["aspire.md", "evals/eval.yaml"] }
    ].map(overrides => ({ skills: [entry(overrides)] }))]) {
    assert.throws(() => validateIndex(index));
  }
});

test("each catalog format requires its own entry file and rejects unknown formats", t => {
  const root = fixture(t);
  const v2 = createCatalog(root);
  const v1 = createCatalog(root, { format: "v1" });
  assert.deepEqual(createCatalog(root, { format: "v2" }), v2);
  assert.throws(() => validateIndex(v1.index), /aspire.md entry/);
  assert.throws(() => validateIndex(v2.index, { format: "v1" }), /SKILL.md entry/);
  assert.throws(() => validateIndex({
    skills: [entry({ files: ["SKILL.md", "references/SKILL.md"] })]
  }, { format: "v1" }), /Unpublished catalog file/);
  assert.throws(() => createCatalog(root, { format: "v3" }), /Unsupported OpenCode catalog format/);
  assert.throws(() => validateIndex(v2.index, { format: "v3" }), /Unsupported OpenCode catalog format/);
});

test("broken links and named-entry collisions fail before writing a catalog", t => {
  const root = fixture(t);
  put(root, "skills/aspire/references/guide.md", "[missing](missing.md)\n");
  assert.throws(() => buildCatalog(root), /Broken relative Markdown link/);
  put(root, "skills/aspire/references/guide.md", "Guide\n");
  put(root, "skills/aspire/aspire.md", "collision\n");
  assert.throws(() => buildCatalog(root), /collides/);
});

test("source and output symlinks are rejected without following them", t => {
  const root = fixture(t);
  const outside = join(root, "outside");
  mkdirSync(outside);
  const link = join(root, "skills", "aspire", "references", "linked");
  symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => buildCatalog(root), /Only regular files/);
  unlinkSync(link);
  symlinkSync(outside, join(root, "dist"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => buildCatalog(root), /Symbolic links/);
  unlinkSync(join(root, "dist"));
  mkdirSync(join(root, "dist"));
  symlinkSync(outside, artifactRoot(root), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => buildCatalog(root), /Symbolic links/);
  assert.deepEqual(readdirSync(outside), []);
});

test("CI validates canonical and generator changes on pull requests and main", () => {
  const workflow = read(repoRoot, ".github/workflows/test.yml").toString().replaceAll("\r\n", "\n");
  assert.equal(workflow.match(/- "skills\/\*\*"/g)?.length, 2);
  assert.equal(workflow.match(/- "\.github\/workflows\/publish-opencode-catalog\.yml"/g)?.length, 2);
  assert.match(workflow, /run: npm run catalog\n/);
  assert.match(workflow, /run: npm run catalog:check/);
  assert.doesNotMatch(workflow, /--base-ref/);
});

test("Pages deploys trusted main changes with isolated permissions and a catalog-only artifact", () => {
  const workflow = read(repoRoot, ".github/workflows/publish-opencode-catalog.yml").toString().replaceAll("\r\n", "\n");
  assert.match(workflow, /push:\s+branches:\s+- main/);
  assert.match(workflow, /- "skills\/\*\*"/);
  assert.match(workflow, /- "scripts\/build-opencode-catalog\.mjs"/);
  assert.doesNotMatch(workflow, /- "\.gitattributes"/);
  assert.doesNotMatch(workflow, /- "\.github\/workflows\/publish-opencode-catalog\.yml"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request|contents: write|secrets\./);
  assert.equal(workflow.match(/if: github\.repository == 'microsoft\/aspire-skills' && github\.ref == 'refs\/heads\/main'/g)?.length, 2);
  const [build, deploy] = workflow.split("\n  deploy:");
  assert.match(build, /permissions:\s+contents: read/);
  assert.doesNotMatch(build, /pages: write|id-token: write/);
  assert.match(build, /persist-credentials: false/);
  assert.match(build, /run: node --test tests\/opencode-catalog\.test\.mjs/);
  assert.match(build, /run: npm run catalog\n/);
  assert.match(build, /run: npm run catalog:check/);
  assert.ok(build.includes('assert.deepEqual(readdirSync("dist"), ["opencode"], "Only the catalog may be published");'));
  assert.match(build, /path: dist\n/);
  assert.match(deploy, /needs: build/);
  assert.match(deploy, /permissions:\s+pages: write\s+id-token: write/);
  assert.match(deploy, /environment:\s+name: github-pages/);
  assert.match(deploy, /url: \$\{\{ steps\.catalog\.outputs\.url \}\}/);
  assert.match(deploy, /PAGE_URL: \$\{\{ steps\.deployment\.outputs\.page_url \}\}/);
  assert.ok(deploy.includes('run: echo "url=${PAGE_URL%/}/opencode/v2/" >> "$GITHUB_OUTPUT"'));
  for (const [, action] of workflow.matchAll(/uses: ([^\s]+)/g)) {
    assert.match(action, /^actions\/[a-z-]+@[0-9a-f]{40}$/);
  }
});

function publishingAuthorization() {
  const workflow = read(repoRoot, ".github/workflows/publish-opencode-catalog.yml").toString().replaceAll("\r\n", "\n");
  const step = workflow.split(/^      - name: /m).find(step => step.startsWith("Check publishing permissions\n"));
  assert.ok(step, "the publishing permission check must exist");
  const script = step.split("        run: |\n")[1];
  assert.ok(script, "the publishing permission check must execute a script");
  return { workflow, step, script: script.replace(/^          /gm, "") };
}

test("publishing checks the original and rerun actors before checkout without expanding token permissions", () => {
  const { workflow, step, script } = publishingAuthorization();
  assert.ok(workflow.indexOf("name: Check publishing permissions") < workflow.indexOf("name: Checkout"));
  assert.match(step, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(step, /REPOSITORY: \$\{\{ github\.repository \}\}/);
  assert.match(step, /ACTOR: \$\{\{ github\.actor \}\}/);
  assert.match(step, /TRIGGERING_ACTOR: \$\{\{ github\.triggering_actor \}\}/);
  assert.match(script, /set -euo pipefail/);
  assert.doesNotMatch(script, /\$\{\{|\|\| true/);
});

for (const scenario of [
  { actor: "write", rerunner: "write", allowed: true },
  { actor: "maintain", rerunner: "admin", allowed: true },
  { actor: "admin", rerunner: "maintain", allowed: true },
  { actor: "read", rerunner: "admin", allowed: false },
  { actor: "triage", rerunner: "admin", allowed: false },
  { actor: "none", rerunner: "admin", allowed: false },
  { actor: "admin", rerunner: "read", allowed: false },
  { actor: "admin", rerunner: "unknown", allowed: false },
  { actor: "", rerunner: "admin", allowed: false },
  { actor: "api-error", rerunner: "admin", allowed: false },
  { actor: "admin", rerunner: "api-error", allowed: false }
]) {
  test(`publishing authorization: actor=${scenario.actor || "empty"}, rerunner=${scenario.rerunner}`, {
    skip: process.platform === "win32" ? "The publishing workflow runs Bash on Ubuntu." : false
  }, () => {
    const { script } = publishingAuthorization();
    const mock = `
gh() {
  if [[ "$1" != "api" || "$3" != "--jq" || "$4" != ".permission" ]]; then return 2; fi
  case "$2" in
    repos/microsoft/aspire-skills/collaborators/original/permission) result="$ACTOR_PERMISSION" ;;
    repos/microsoft/aspire-skills/collaborators/rerunner/permission) result="$RERUNNER_PERMISSION" ;;
    *) return 2 ;;
  esac
  if [[ "$result" == "api-error" ]]; then
    echo "GitHub permission lookup failed" >&2
    return 1
  fi
  printf '%s\\n' "$result"
}
`;
    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", mock + script], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        REPOSITORY: "microsoft/aspire-skills",
        ACTOR: "original",
        TRIGGERING_ACTOR: "rerunner",
        ACTOR_PERMISSION: scenario.actor,
        RERUNNER_PERMISSION: scenario.rerunner
      }
    });
    assert.ifError(result.error);
    assert.equal(result.status === 0, scenario.allowed, result.stdout + result.stderr);
    if (!scenario.allowed) assert.match(result.stdout + result.stderr, /::error::|GitHub permission lookup failed/);
  });
}
