import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";
import {
  embeddedDirectory, installerPath, inventory, metadataPath, prepareUpdate, projectPath,
  releaseIdentity, sourceRepository, targetRepository, validateOutcome, validateRelease
} from "../scripts/aspire-release-update.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const commit = "a".repeat(40);
const head = "b".repeat(40);
const noop = { items: [{ type: "noop", message: "The released behavior is already covered." }] };
const create = { items: [{ type: "create_pull_request" }] };
const hookPath = "src/Aspire.Cli/Agents/Hooks/track-telemetry.sh";
const managedPath = "src/Aspire.Cli/Agents/Hooks/AgentTelemetryHook.cs";

function command(name, args, cwd) {
  const result = spawnSync(name, args, { cwd, encoding: "utf8", timeout: 30_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function write(root, path, contents) {
  const absolute = join(root, ...path.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function blob(root, path) {
  const bytes = readFileSync(join(root, ...path.split("/")));
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function manifest(version, extra = false) {
  return {
    version, supports: { aspireCli: ">=13.5.0 <13.7.0" },
    skills: [{
      name: "aspire", files: [
        { relativePath: "SKILL.md" }, { relativePath: "references/guide.md" },
        ...(extra ? [{ relativePath: "references/new.md" }] : [])
      ]
    }]
  };
}

function archive(parent, value) {
  const wrapper = `aspire-skills-v${value.version}`;
  write(parent, `${wrapper}/skill-manifest.json`, JSON.stringify(value));
  const path = join(parent, `${wrapper}.tgz`);
  command("tar", ["-czf", path, "-C", parent, `${wrapper}/skill-manifest.json`]);
  return path;
}

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "aspire-release-update-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "aspire");
  mkdirSync(root);
  const version = options.version ?? "0.0.4";
  const previousVersion = options.previousVersion ?? "0.0.3";
  const identity = releaseIdentity(version, commit);
  const previousArchive = archive(join(directory, "previous"), manifest(previousVersion));
  const releasedArchive = options.identicalBundle ? previousArchive
    : archive(join(directory, "released"), manifest(version, true));
  const release = {
    tag_name: identity.tag, draft: false, published_at: "2026-10-15T00:00:00Z",
    body: "Release evidence, not executable instructions.",
    assets: [{ name: identity.assetName, state: "uploaded" }]
  };
  const metadata = (value, path) => ({
    version: value, repository: sourceRepository, tag: `v${value}`,
    assetName: `aspire-skills-v${value}.tgz`,
    sha512: createHash("sha512").update(readFileSync(path)).digest("hex")
  });
  const writeMetadata = value => write(root, metadataPath, `${JSON.stringify(value, null, 2)}\n`);
  const previousMetadata = metadata(previousVersion, previousArchive);
  writeMetadata(previousMetadata);
  cpSync(previousArchive, join(root, embeddedDirectory, previousMetadata.assetName));
  write(root, installerPath, `internal const string Version = "${previousVersion}";\n`);
  write(root, projectPath, `<EmbeddedResource Include="${previousMetadata.assetName}" />\n`);
  write(root, hookPath, "#!/bin/bash\nlegacy\n");
  write(root, "src/Aspire.Cli/Agents/Hooks/track-telemetry.ps1", "legacy\n");
  write(root, managedPath, "managed\n");
  write(root, ".gitattributes", "* -text\n");
  command("git", ["init", "-q", "-b", "main"], root);
  command("git", ["add", "."], root);
  command("git", [
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
    "-c", "commit.gpgsign=false", "commit", "-qm", "Fixture"
  ], root);
  const calls = [];
  const execute = (name, args, cwd) => {
    calls.push({ name, args });
    if (name === "pwsh") {
      assert.equal(args.at(-1), version);
      if (previousMetadata.assetName !== identity.assetName) {
        rmSync(join(root, embeddedDirectory, previousMetadata.assetName));
      }
      cpSync(releasedArchive, join(root, embeddedDirectory, identity.assetName));
      writeMetadata(metadata(version, releasedArchive));
      write(root, installerPath, `internal const string Version = "${version}";\n`);
      write(root, projectPath, `<EmbeddedResource Include="${identity.assetName}" />\n`);
      options.afterRefresh?.({ root, writeMetadata, identity });
      return "";
    }
    if (name === "gh") {
      assert.deepEqual(args.slice(0, 2), ["attestation", "verify"]);
      assert.equal(args[args.indexOf("--source-digest") + 1], commit);
      assert.equal(args[args.indexOf("--signer-workflow") + 1],
        `${sourceRepository}/.github/workflows/publish.yml`);
      return "";
    }
    return command(name, args, cwd);
  };
  const proposal = {
    number: 42, html_url: "https://github.com/microsoft/aspire/pull/42",
    state: "open", draft: true, body: `${identity.releaseUrl}\n${identity.marker}`,
    head: { ref: identity.branch, sha: head, repo: { full_name: targetRepository } },
    base: { ref: "main", repo: { full_name: targetRepository } }
  };
  const api = endpoint => {
    if (endpoint.includes("/releases/tags/")) return release;
    if (endpoint.includes("/commits/")) return { sha: commit };
    if (endpoint.includes("/pulls?")) return options.proposals ? [proposal] : [];
    if (endpoint.endsWith("/pulls/42")) return proposal;
    if (endpoint.includes("/contents/")) {
      const path = endpoint.split("/contents/")[1].split("?")[0];
      return { type: "file", sha: blob(root, path) };
    }
    if (endpoint.includes("/pulls/42/files?")) {
      return [
        ...[metadataPath, installerPath, projectPath, `${embeddedDirectory}/${identity.assetName}`]
          .map(filename => ({ filename, status: "modified" })),
        { filename: `${embeddedDirectory}/${previousMetadata.assetName}`, status: "removed" }
      ];
    }
    throw new Error(`Unexpected GitHub API request: ${endpoint}`);
  };
  return {
    root, version, sourceCommit: commit, api, execute, calls, release, proposal,
    identity, writeMetadata, previousMetadata
  };
}

test("release inputs use SemVer and full immutable commit SHAs", () => {
  assert.equal(releaseIdentity("1.2.3-preview.4+build", commit).tag, "v1.2.3-preview.4+build");
  for (const version of ["v1.2.3", "1.2.3\n", "../main", "1.2.03", "1.2.3;command"]) {
    assert.throws(() => releaseIdentity(version, commit));
  }
  for (const value of ["main", commit.slice(1), commit.toUpperCase(), `${commit}\n`]) {
    assert.throws(() => releaseIdentity("1.2.3", value), /full, lowercase/);
  }
});

test("only a published release, matching commit and complete asset can be prepared", () => {
  const identity = releaseIdentity("1.2.3", commit);
  const release = {
    tag_name: identity.tag, draft: false, published_at: "2026-10-15",
    assets: [{ name: identity.assetName, state: "uploaded" }]
  };
  validateRelease(identity, release, { sha: commit });
  for (const patch of [
    { draft: true }, { tag_name: "v1.2.4" }, { published_at: null },
    { assets: [] }, { assets: [...release.assets, ...release.assets] },
    { assets: [{ name: identity.assetName, state: "new" }] }
  ]) {
    assert.throws(() => validateRelease(identity, { ...release, ...patch }, { sha: commit }));
  }
  assert.throws(() => validateRelease(identity, release, { sha: head }), /expected source_commit/);
});

test("telemetry inventory includes only manifest-owned skills and reference paths", () => {
  const value = manifest("1.2.3");
  value.skills[0].files.push({ relativePath: "scripts/helper.sh" }, { relativePath: "evals/private.json" });
  assert.deepEqual(inventory(value), { skills: ["aspire"], references: ["aspire/references/guide.md"] });
  for (const relativePath of ["../private.md", "/private.md", "references\\private.md", "references/../private.md", "references//x"]) {
    const invalid = manifest("1.2.3");
    invalid.skills[0].files.push({ relativePath });
    assert.throws(() => inventory(invalid), /invalid or duplicate path/);
  }
  const duplicate = manifest("1.2.3");
  duplicate.skills.push(duplicate.skills[0]);
  assert.throws(() => inventory(duplicate), /duplicate skill/);
});

test("preparation refreshes a real archive, pins provenance and preserves both telemetry paths", t => {
  const f = fixture(t);
  const context = prepareUpdate(f);
  assert.equal(context.status, "prepared");
  assert.equal(context.bundleUpdateRequired, true);
  assert.deepEqual(context.addedReferences, ["aspire/references/new.md"]);
  assert.deepEqual(context.removedReferences, []);
  assert.equal(Object.keys(context.expectedFiles).length, 4);
  assert.equal(readFileSync(join(f.root, hookPath), "utf8"), "#!/bin/bash\nlegacy\n");
  assert.equal(readFileSync(join(f.root, managedPath), "utf8"), "managed\n");
  assert.ok(f.calls.some(call => call.name === "gh"));
  assert.equal(command("git", ["branch", "--show-current"], f.root).trim(), context.branch);
  assert.equal(validateOutcome(context, create, f.proposal.html_url, f.api),
    `Draft Aspire update: ${f.proposal.html_url}`);
});

test("Aspire ownership and retiring the competing updater are prerequisites", t => {
  const f = fixture(t);
  f.writeMetadata({ ...f.previousMetadata, hooks: null });
  assert.throws(() => prepareUpdate(f), /ownership PR/);
  f.writeMetadata(f.previousMetadata);
  write(f.root, ".github/workflows/update-aspire-skills-bundle.yml", "name: Old updater\n");
  assert.throws(() => prepareUpdate(f), /standalone bundle-update/);
  assert.equal(f.calls.some(call => call.name === "pwsh"), false);
});

for (const [name, afterRefresh, pattern] of [
  ["script overwrite", ({ root }) => write(root, hookPath, "overwritten\n"), /changed a telemetry script/],
  ["managed runtime overwrite", ({ root }) => write(root, managedPath, "overwritten\n"), /outside the bundle/],
  ["unrelated new file", ({ root }) => write(root, "unrelated.txt", "new\n"), /outside the bundle/],
  ["upstream hook provenance", ({ root, writeMetadata }) => {
    const value = JSON.parse(readFileSync(join(root, metadataPath), "utf8"));
    writeMetadata({ ...value, hooks: {} });
  }, /upstream hook provenance/],
  ["wrong release pin", ({ root, writeMetadata }) => {
    const value = JSON.parse(readFileSync(join(root, metadataPath), "utf8"));
    writeMetadata({ ...value, tag: "v9.9.9" });
  }, /did not pin/],
  ["invalid archive digest", ({ root, writeMetadata }) => {
    const value = JSON.parse(readFileSync(join(root, metadataPath), "utf8"));
    writeMetadata({ ...value, sha512: "0".repeat(128) });
  }, /recorded SHA-512/]
]) {
  test(`bundle preparation rejects ${name}`, t => {
    const f = fixture(t, { afterRefresh });
    assert.throws(() => prepareUpdate(f), pattern);
  });
}

test("newer bundles cannot be silently skipped when telemetry needs no changes", t => {
  const f = fixture(t);
  assert.throws(() => validateOutcome(prepareUpdate(f), noop, "", f.api), /requires a bundle-update PR/);
});

test("the same attested bundle may produce an explicit telemetry no-op", t => {
  const f = fixture(t, { version: "0.0.3", identicalBundle: true });
  const context = prepareUpdate(f);
  assert.equal(context.bundleUpdateRequired, false);
  assert.match(validateOutcome(context, noop, "", f.api), /needs no additional telemetry changes/);
});

test("changed bytes at the same version still require a bundle proposal", t => {
  const f = fixture(t, { version: "0.0.3" });
  const context = prepareUpdate(f);
  assert.equal(context.bundleUpdateRequired, true);
  assert.deepEqual(context.requiredBundlePaths.sort(),
    [metadataPath, `${embeddedDirectory}/${f.identity.assetName}`].sort());
  assert.throws(() => validateOutcome(context, noop, "", f.api), /requires a bundle-update PR/);
});

test("an older release is reported as superseded without running the updater", t => {
  const f = fixture(t, { version: "0.0.2" });
  const context = prepareUpdate(f);
  assert.equal(context.status, "superseded");
  assert.equal(f.calls.some(call => call.name === "pwsh"), false);
  assert.match(validateOutcome(context, noop, "", f.api), /superseded by embedded 0.0.3/);
});

test("reruns verify and report the existing draft rather than duplicating or overwriting it", t => {
  const f = fixture(t, { proposals: true });
  const context = prepareUpdate(f);
  assert.equal(context.status, "already_proposed");
  assert.equal(command("git", ["branch", "--show-current"], f.root).trim(), "main");
  assert.match(validateOutcome(context, noop, "", f.api), /already proposed/);
  assert.throws(() => validateOutcome(context, create, f.proposal.html_url, f.api), /does not match/);
});

test("closed unmerged proposals require a human decision before retrying", t => {
  const f = fixture(t, { proposals: true });
  f.proposal.state = "closed";
  assert.throws(() => prepareUpdate(f), /closed without merging/);
});

test("missing, contradictory and incomplete safe outputs fail conclusively", t => {
  const f = fixture(t);
  const context = prepareUpdate(f);
  for (const payload of [
    {}, { items: [] }, { items: [{ type: "noop", message: "" }] },
    { items: [...create.items, ...noop.items] },
    { items: [...noop.items, { type: "report_incomplete" }] }, create
  ]) {
    assert.throws(() => validateOutcome(context, payload, "", f.api));
  }
  assert.throws(() => validateOutcome(context, noop, f.proposal.html_url, f.api));
  assert.throws(() => validateOutcome(context, create, "https://github.com/microsoft/aspire-skills/pull/42", f.api));
});

test("publication must preserve the prepared binary archive and metadata", t => {
  const f = fixture(t);
  const context = prepareUpdate(f);
  const alteredApi = endpoint => endpoint.includes(`/contents/${embeddedDirectory}/aspire-skills-v`)
    ? { type: "file", sha: "0".repeat(40) } : f.api(endpoint);
  assert.throws(() => validateOutcome(context, create, f.proposal.html_url, alteredApi), /prepared bundle file/);
});

test("a draft on the wrong branch, repository, base or release is not success", t => {
  const f = fixture(t);
  const context = prepareUpdate(f);
  for (const patch of [
    { draft: false }, { state: "closed" }, { body: f.identity.releaseUrl },
    { head: { ...f.proposal.head, ref: "unrelated" } },
    { head: { ...f.proposal.head, repo: { full_name: "someone/fork" } } },
    { base: { ...f.proposal.base, ref: "release/13.6" } }
  ]) {
    const api = endpoint => endpoint.endsWith("/pulls/42") ? { ...f.proposal, ...patch } : f.api(endpoint);
    assert.throws(() => validateOutcome(context, create, f.proposal.html_url, api), /expected Aspire branch/);
  }
});

test("a bundle PR must contain every generated change and remove the old archive", t => {
  const f = fixture(t);
  const context = prepareUpdate(f);
  for (const omitted of [...context.requiredBundlePaths, `${embeddedDirectory}/${context.previousAssetName}`]) {
    const api = endpoint => {
      const result = f.api(endpoint);
      return endpoint.includes("/files?") ? result.filter(file => file.filename !== omitted) : result;
    };
    assert.throws(() => validateOutcome(context, create, f.proposal.html_url, api), /omitted|previous embedded archive/);
  }
});

test("GitHub may report the replaced binary archive as a rename", t => {
  const f = fixture(t);
  const context = prepareUpdate(f);
  const previousArchive = `${embeddedDirectory}/${context.previousAssetName}`;
  const api = endpoint => {
    const result = f.api(endpoint);
    if (!endpoint.includes("/files?")) return result;
    return result.filter(file => file.filename !== previousArchive).map(file =>
      file.filename === `${embeddedDirectory}/${context.assetName}`
        ? { ...file, status: "renamed", previous_filename: previousArchive } : file);
  };
  assert.match(validateOutcome(context, create, f.proposal.html_url, api), /Draft Aspire update/);
});

const source = readFileSync(join(repoRoot, ".github", "workflows", "update-aspire.md"), "utf8");
const workflow = parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(source)[1]);
const publisher = parse(readFileSync(join(repoRoot, ".github", "workflows", "publish.yml"), "utf8"));
const validation = parse(readFileSync(join(repoRoot, ".github", "workflows", "validate-agentic-workflows.yml"), "utf8"));

test("the source-hosted workflow edits one Aspire checkout and publishes only draft Aspire PRs", () => {
  assert.match(workflow.if, /microsoft\/aspire-skills/);
  assert.match(workflow.if, /refs\/heads\/main/);
  assert.deepEqual(workflow.checkout.map(item => [item.repository, item.path, item.current]),
    [["microsoft/aspire", ".", true]]);
  const output = workflow["safe-outputs"]["create-pull-request"];
  assert.equal(output["target-repo"], targetRepository);
  assert.equal(output["base-branch"], "main");
  assert.deepEqual(output["allowed-base-branches"], ["main"]);
  assert.equal(output.draft, true);
  assert.equal(output["fallback-as-issue"], false);
  assert.equal(output["patch-format"], "bundle");
  assert.equal(output["protected-files"].policy, "blocked");
  assert.deepEqual(output["protected-files"].exclude, [projectPath]);
  assert.ok(output["allowed-files"].includes(hookPath));
  assert.ok(output["allowed-files"].includes("src/Aspire.Cli/Agents/Hooks/*.cs"));
  assert.ok(!output["allowed-files"].some(path => path.startsWith(".github/")));
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.permissions["pull-requests"], "read");
  assert.match(source, /pr-docs-check\.md/);
});

test("trusted preparation and outcome validation are pinned to the workflow source", () => {
  const checkout = workflow["pre-agent-steps"].find(step => step.name === "Check out trusted release-update helpers");
  assert.equal(checkout.with.ref, "${{ github.workflow_sha }}");
  const upload = workflow["pre-agent-steps"].find(step => step.name === "Preserve trusted release expectations");
  assert.equal(upload.with.name, "aspire-update-context");
  assert.match(upload.with.path, /runner\.temp/);
  const outcome = workflow.jobs["validate-update-outcome"];
  assert.deepEqual(outcome.needs, ["agent", "safe_outputs"]);
  assert.equal(outcome.steps[0].with.ref, "${{ github.workflow_sha }}");
  assert.equal(outcome.steps.at(-1).env.CREATED_PR_URL, "${{ needs.safe_outputs.outputs.created_pr_url }}");
  const token = workflow["pre-agent-steps"].find(step => step.id === "prepare-token");
  assert.equal(token.with["permission-contents"], "read");
  assert.equal(token.with["permission-pull-requests"], "read");
});

test("only successful publication dispatches the updater, with least-privilege Actions write", () => {
  const publish = publisher.jobs.publish;
  assert.equal(publish.steps.at(-1).name, "Upload skills bundle");
  assert.equal(publish.permissions.actions, undefined);
  const update = publisher.jobs["update-aspire"];
  assert.equal(update.needs, "publish");
  assert.match(update.if, /needs\.publish\.result == 'success'/);
  assert.equal(update.permissions.actions, "write");
  assert.equal(update.permissions.contents, "read");
  const dispatch = update.steps[0];
  assert.equal(dispatch.env.RELEASE_VERSION, "${{ needs.publish.outputs.version }}");
  assert.equal(dispatch.env.RELEASE_COMMIT, "${{ github.event.pull_request.merge_commit_sha }}");
  assert.match(dispatch.run, /workflow run update-aspire\.lock\.yml/);
  assert.match(dispatch.run, /--ref main/);
  assert.match(dispatch.run, /--field "source_commit=\$RELEASE_COMMIT"/);
});

test("dedicated CI recompiles with Aspire's pinned compiler and rejects generated drift", () => {
  const steps = validation.jobs.validate.steps;
  const compiler = steps.find(step => step.name === "Install pinned agentic workflow compiler");
  assert.equal(compiler.with.version, "v0.89.17");
  assert.match(steps.find(step => step.name === "Compile agentic workflows").run,
    /--schedule-seed microsoft\/aspire-skills/);
  assert.match(steps.find(step => step.name === "Reject generated-file drift").run, /actions-lock\.json/);
  assert.equal(steps.at(-1).run, "gh aw lint --shellcheck");
});
