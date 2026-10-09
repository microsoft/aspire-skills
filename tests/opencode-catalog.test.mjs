import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertSafePath, buildCatalog, createCatalog } from "../scripts/build-opencode-catalog.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontmatter = "---\nname: aspire\ndescription: Test skill\nmetadata:\n  version: \"0.0.2\"\n---\n";
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

test("both catalog formats build and verify every canonical skill and supporting file", t => {
  const root = mkdtempSync(join(tmpdir(), "opencode-canonical-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(repoRoot, "skills"), join(root, "skills"), { recursive: true });
  buildCatalog(root);
  const names = readdirSync(join(repoRoot, "skills")).sort();
  for (const format of ["v2", "v1"]) {
    const { index, files } = createCatalog(repoRoot, { format });
    assert.deepEqual(JSON.parse(read(root, output("index.json", format))), index);
    assert.deepEqual(inventory(catalogRoot(root, format)), [...files.keys()].sort());
    for (const [path, contents] of files) {
      assert.deepEqual(read(root, output(path, format)), contents);
    }
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
  assert.match(read(repoRoot, ".gitignore").toString(), /^dist\/$/m);
});

test("local artifacts contain only separate V1 and V2 catalog roots", t => {
  const root = fixture(t);
  buildCatalog(root);
  assert.deepEqual(readdirSync(join(root, "dist")), ["opencode"]);
  assert.deepEqual(readdirSync(artifactRoot(root)).sort(), ["v1", "v2"]);
  assert.ok(!existsSync(join(root, "dist", "index.json")));
  assert.ok(!existsSync(join(artifactRoot(root), "index.json")));
});

test("generation preserves frontmatter, references, scripts, and binary assets and excludes development files", t => {
  const root = fixture(t);
  const metadata = '---\ndescription: \'Read [link](missing.md "Do not alter")\'\n---\n';
  const guide = [
    "[Back](../SKILL.md#workflow)",
    '[Titled](../SKILL.md#workflow "Workflow")',
    "[Single](../SKILL.md?mode=full#workflow 'Workflow')",
    "[Parentheses](../SKILL.md#workflow (Workflow))",
    '[Angle](<../SKILL.md#workflow> "Workflow")',
    "[Reference][entry]",
    '[Script](../scripts/run.sh "Run")',
    '[External](https://example.com/docs "Website")',
    '[Absolute](/SKILL.md#workflow "Absolute")',
    '[Anchor](#workflow "Local")',
    "",
    "[entry]: ../SKILL.md#workflow",
    "[titled]: ../SKILL.md#workflow 'Workflow'",
    '  [angle]: <../SKILL.md#workflow> "Workflow"',
    '[nested]: ../SKILL.md#workflow \'See [example](missing.md "Guide")\'',
    '[external]: <https://example.com/docs> "Website"',
    "[anchor]: #workflow",
    ""
  ].join("\n");
  put(root, "skills/aspire/references/guide.md", metadata + guide);
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
  assert.equal(read(root, output("aspire/references/guide.md")).toString(), metadata + guide.replaceAll("../SKILL.md", "../aspire.md"));
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
  assert.equal(read(root, output("aspire/references/guide.md", "v1")).toString(), metadata + guide);
  assert.equal(read(root, output("aspire/scripts/run.sh", "v1")).toString(), "#!/bin/sh\necho hello\n");
  assert.deepEqual(buildCatalog(root), index);
  assert.equal(existsSync(join(root, "opencode")), false);
});

test("cross-skill links use canonical URLs without assuming a shared cache directory", t => {
  const root = fixture(t);
  put(root, "skills/aspire-init/SKILL.md", "---\nname: aspire-init\n---\nInit\n");
  const guide = [
    "[init](../../aspire-init/SKILL.md#start)",
    '[titled](../../aspire-init/SKILL.md#start "Start")',
    "[reference][init]",
    "",
    '[init]: <../../aspire-init/SKILL.md#start> "Start"',
    ""
  ].join("\n");
  put(root, "skills/aspire/references/guide.md", guide);
  buildCatalog(root);
  assert.equal(read(root, output("aspire/references/guide.md")).toString(),
    guide.replaceAll("../../aspire-init/SKILL.md", "https://github.com/microsoft/aspire-skills/blob/main/skills/aspire-init/SKILL.md"));
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
  assert.deepEqual(buildCatalog(root), index);
});

test("removed skills and unlisted generated files are pruned without touching unrelated files", t => {
  const root = fixture(t);
  put(root, "skills/aspire-init/SKILL.md", "---\nname: aspire-init\n---\nInit\n");
  buildCatalog(root);
  unlinkSync(join(root, "skills", "aspire-init", "SKILL.md"));
  put(root, output("stale.txt"), "stale");
  put(root, "dist/unrelated.txt", "keep");
  buildCatalog(root);
  assert.deepEqual(inventory(artifactRoot(root)), [
    "v1/aspire/SKILL.md", "v1/aspire/references/guide.md", "v1/index.json",
    "v2/aspire/aspire.md", "v2/aspire/references/guide.md", "v2/index.json"
  ]);
  assert.equal(read(root, "dist/unrelated.txt").toString(), "keep");
});

for (const path of ["", "..", "../escape", "/absolute", "//host/path", "C:/file", "a\\b", "a/./b",
  "a//b", "a/../b", "a?query", "a#hash", "%2e%2e/file", "https://host/file", "a\nb", "a.", "con", "NUL.txt"]) {
  test(`rejects unsafe HTTP or filesystem path ${JSON.stringify(path)}`, () => {
    assert.throws(() => assertSafePath(path), /Unsafe catalog path/);
  });
}

test("source rejects invalid skill IDs and an empty skill set", t => {
  for (const name of ["Aspire-Bad", "aspire_bad", "a".repeat(65)]) {
    const root = fixture(t);
    put(root, `skills/${name}/SKILL.md`, frontmatter);
    assert.throws(() => buildCatalog(root), /lowercase kebab-case IDs/);
    assert.equal(existsSync(artifactRoot(root)), false);
  }
  const root = fixture(t);
  unlinkSync(join(root, "skills", "aspire", "SKILL.md"));
  assert.throws(() => buildCatalog(root), /at least one skill/);
});

test("each catalog format builds its own entry file and rejects unknown formats", t => {
  const root = fixture(t);
  const v2 = createCatalog(root);
  const v1 = createCatalog(root, { format: "v1" });
  assert.deepEqual(createCatalog(root, { format: "v2" }), v2);
  assert.ok(v1.files.has("aspire/SKILL.md"));
  assert.ok(v2.files.has("aspire/aspire.md"));
  assert.throws(() => createCatalog(root, { format: "v3" }), /Unsupported OpenCode catalog format/);
  put(root, "skills/aspire/references/SKILL.md", frontmatter);
  for (const format of ["v1", "v2"]) {
    assert.throws(() => createCatalog(root, { format }), /Unpublished catalog file/);
  }
});

test("broken links and named-entry collisions fail before writing a catalog", t => {
  const root = fixture(t);
  for (const link of [
    "[missing](missing.md)", '[missing](missing.md "Missing")',
    "[missing](<missing.md> 'Missing')", "[missing][entry]\n\n[entry]: missing.md",
    '[missing][entry]\n\n[entry]: <missing.md> "Missing"'
  ]) {
    put(root, "skills/aspire/references/guide.md", `${link}\n`);
    for (const format of ["v1", "v2"]) {
      assert.throws(() => createCatalog(root, { format }), /Broken relative Markdown link/);
    }
    assert.throws(() => buildCatalog(root), /Broken relative Markdown link/);
    assert.equal(existsSync(artifactRoot(root)), false);
  }
  put(root, "skills/aspire/references/guide.md", "Guide\n");
  put(root, "skills/aspire/ASPIRE.md", "collision\n");
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
