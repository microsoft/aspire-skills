import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, parseVersion } from "./release-versions.mjs";

export const sourceRepository = "microsoft/aspire-skills";
export const targetRepository = "microsoft/aspire";
export const embeddedDirectory = "src/Aspire.Cli/Agents/AspireSkills/Embedded";
export const metadataPath = `${embeddedDirectory}/aspire-skills.metadata.json`;
export const installerPath = "src/Aspire.Cli/Agents/AspireSkills/AspireSkillsInstaller.cs";
export const projectPath = "src/Aspire.Cli/Aspire.Cli.csproj";
const hookPaths = [
  "src/Aspire.Cli/Agents/Hooks/track-telemetry.sh",
  "src/Aspire.Cli/Agents/Hooks/track-telemetry.ps1"
];

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", timeout: 300_000, maxBuffer: 32 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function githubApi(endpoint) {
  return JSON.parse(run("gh", ["api", endpoint]));
}

function diskPath(root, path) {
  return join(root, ...path.split("/"));
}

function readJson(root, path) {
  return JSON.parse(readFileSync(diskPath(root, path), "utf8"));
}

function gitBlob(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function fileBlob(root, path) {
  return gitBlob(readFileSync(diskPath(root, path)));
}

function contentAt(api, path, ref) {
  const response = api(`repos/${targetRepository}/contents/${path}?ref=${ref}`);
  if (response.type !== "file") throw new Error(`Expected a regular file: ${path}`);
  return response;
}

export function releaseIdentity(version, sourceCommit) {
  parseVersion(version);
  if (typeof sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error("source_commit must be a full, lowercase Git commit SHA.");
  }
  return {
    version,
    sourceCommit,
    tag: `v${version}`,
    assetName: `aspire-skills-v${version}.tgz`,
    releaseUrl: `https://github.com/${sourceRepository}/releases/tag/v${version}`,
    branch: `update-aspire-skills-${sourceCommit}`,
    marker: `<!-- aspire-skills-release:${sourceCommit} -->`
  };
}

export function validateRelease(identity, release, commit) {
  if (release.tag_name !== identity.tag || release.draft !== false || !release.published_at) {
    throw new Error("The requested tag must identify a published, non-draft skills release.");
  }
  if (commit.sha !== identity.sourceCommit) {
    throw new Error("The release tag does not resolve to the expected source_commit.");
  }
  const assets = Array.isArray(release.assets)
    ? release.assets.filter(asset => asset.name === identity.assetName) : [];
  if (assets?.length !== 1 || assets[0].state !== "uploaded") {
    throw new Error(`The release must contain one uploaded ${identity.assetName}.`);
  }
}

export function inventory(manifest) {
  parseVersion(manifest.version);
  if (!Array.isArray(manifest.skills) || manifest.skills.length === 0) {
    throw new Error("The released manifest must contain a skill inventory.");
  }
  const skills = new Set();
  const references = new Set();
  for (const skill of manifest.skills) {
    if (typeof skill?.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)
      || skills.has(skill.name)) {
      throw new Error("The manifest contains an invalid or duplicate skill name.");
    }
    skills.add(skill.name);
    if (!Array.isArray(skill.files) || skill.files.length === 0) {
      throw new Error(`The manifest is missing the file inventory for ${skill.name}.`);
    }
    const paths = new Set();
    for (const file of skill.files) {
      const path = file?.relativePath;
      if (typeof path !== "string" || !/^[a-zA-Z0-9._/-]+$/.test(path)
        || path.split("/").some(part => !part || part === "." || part === "..")
        || paths.has(path)) {
        throw new Error(`The manifest contains an invalid or duplicate path for ${skill.name}.`);
      }
      paths.add(path);
      if (path.startsWith("references/")) references.add(`${skill.name}/${path}`);
    }
  }
  return { skills: [...skills].sort(), references: [...references].sort() };
}

function bundleManifest(root, metadata, execute) {
  parseVersion(metadata.version);
  if (metadata.assetName !== `aspire-skills-v${metadata.version}.tgz`) {
    throw new Error("The embedded skills bundle must use the published .tgz naming convention.");
  }
  const manifest = JSON.parse(execute("tar", [
    "-xOf", diskPath(root, `${embeddedDirectory}/${metadata.assetName}`),
    `aspire-skills-v${metadata.version}/skill-manifest.json`
  ], root));
  if (manifest.version !== metadata.version) throw new Error("Bundle and manifest versions disagree.");
  return { ...inventory(manifest), supports: manifest.supports };
}

function unrelatedChanges(root, execute) {
  const diff = execute("git", [
    "diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--", ".",
    `:(exclude)${metadataPath}`, `:(exclude)${installerPath}`, `:(exclude)${projectPath}`,
    `:(exclude,glob)${embeddedDirectory}/aspire-skills-v*.tgz`
  ], root);
  const untracked = execute("git", ["ls-files", "--others", "--exclude-standard", "-z"], root)
    .split("\0").filter(Boolean)
    .filter(path => !path.startsWith(`${embeddedDirectory}/aspire-skills-v`) || !path.endsWith(".tgz"))
    .sort();
  return JSON.stringify({ diff, untracked });
}

export function assertBundleOnlyRefresh(root, previousHooks, metadata, identity) {
  for (const path of hookPaths) {
    if (fileBlob(root, path) !== previousHooks[path]) {
      throw new Error("The Aspire bundle updater changed a telemetry script. Land Aspire-side ownership first.");
    }
  }
  if (Object.hasOwn(metadata, "hooks")) {
    throw new Error("The Aspire bundle updater still records upstream hook provenance. Land Aspire-side ownership first.");
  }
  if (metadata.version !== identity.version || metadata.repository !== sourceRepository
    || metadata.tag !== identity.tag || metadata.assetName !== identity.assetName) {
    throw new Error("The Aspire bundle updater did not pin the requested release.");
  }
  const bytes = readFileSync(diskPath(root, `${embeddedDirectory}/${identity.assetName}`));
  if (createHash("sha512").update(bytes).digest("hex") !== metadata.sha512) {
    throw new Error("The refreshed archive does not match its recorded SHA-512.");
  }
}

export function prepareUpdate({
  root, version, sourceCommit, api = githubApi, execute = run
}) {
  const identity = releaseIdentity(version, sourceCommit);
  const release = api(`repos/${sourceRepository}/releases/tags/${encodeURIComponent(identity.tag)}`);
  const commit = api(`repos/${sourceRepository}/commits/${encodeURIComponent(identity.tag)}`);
  validateRelease(identity, release, commit);

  const previous = readJson(root, metadataPath);
  parseVersion(previous.version);
  if (Object.hasOwn(previous, "hooks")) {
    throw new Error("Aspire still treats aspire-skills hooks as canonical. Land the Aspire ownership PR before running this workflow.");
  }
  if (existsSync(diskPath(root, ".github/workflows/update-aspire-skills-bundle.yml"))) {
    throw new Error("Retire Aspire's standalone bundle-update workflow before enabling the source-hosted replacement.");
  }
  const context = {
    ...identity,
    targetRepository,
    base: "main",
    previousVersion: previous.version,
    bundleUpdateRequired: compareVersions(version, previous.version) > 0,
    releaseNotes: release.body ?? ""
  };
  if (compareVersions(version, previous.version) < 0) {
    return { ...context, status: "superseded" };
  }

  const previousInventory = bundleManifest(root, previous, execute);
  const previousHooks = Object.fromEntries(hookPaths.map(path => [path, fileBlob(root, path)]));
  const beforeRefresh = unrelatedChanges(root, execute);
  const bundlePaths = [metadataPath, installerPath, projectPath, `${embeddedDirectory}/${identity.assetName}`];
  const previousFiles = Object.fromEntries(bundlePaths.map(path => [
    path, existsSync(diskPath(root, path)) ? fileBlob(root, path) : null
  ]));
  execute("pwsh", [
    "-NoProfile", "-File", diskPath(root, "eng/scripts/update-aspire-skills-bundle.ps1"),
    "-Version", version
  ], root);
  const metadata = readJson(root, metadataPath);
  assertBundleOnlyRefresh(root, previousHooks, metadata, identity);
  if (unrelatedChanges(root, execute) !== beforeRefresh) {
    throw new Error("The bundle updater changed files outside the bundle and its version/resource metadata.");
  }
  execute("gh", [
    "attestation", "verify", diskPath(root, `${embeddedDirectory}/${identity.assetName}`),
    "--repo", sourceRepository,
    "--signer-workflow", `${sourceRepository}/.github/workflows/publish.yml`,
    "--source-digest", sourceCommit,
    "--cert-oidc-issuer", "https://token.actions.githubusercontent.com"
  ], root);
  const releasedInventory = bundleManifest(root, metadata, execute);
  const expectedFiles = Object.fromEntries(bundlePaths.map(path => [path, fileBlob(root, path)]));
  const requiredBundlePaths = bundlePaths.filter(path => expectedFiles[path] !== previousFiles[path]);
  const difference = (left, right) => left.filter(value => !right.includes(value));
  Object.assign(context, {
    status: "prepared",
    expectedFiles,
    requiredBundlePaths,
    bundleUpdateRequired: requiredBundlePaths.length > 0,
    previousAssetName: previous.assetName,
    inventory: releasedInventory,
    addedSkills: difference(releasedInventory.skills, previousInventory.skills),
    removedSkills: difference(previousInventory.skills, releasedInventory.skills),
    addedReferences: difference(releasedInventory.references, previousInventory.references),
    removedReferences: difference(previousInventory.references, releasedInventory.references)
  });

  const prs = api(`repos/${targetRepository}/pulls?state=all&base=main&head=microsoft:${identity.branch}&per_page=100`);
  if (!Array.isArray(prs) || prs.length >= 100) throw new Error("Could not conclusively enumerate release update PRs.");
  for (const pr of prs) {
    if (pr.head?.repo?.full_name !== targetRepository || pr.head.ref !== identity.branch
      || pr.base?.ref !== "main" || !pr.body?.includes(identity.marker)) {
      throw new Error("The release update branch is associated with an unexpected pull request.");
    }
    if (pr.state === "open") {
      if (context.existingPrUrl) throw new Error("Multiple open PRs already propose this release.");
      validateProposedFiles(context, pr, api);
      context.existingPrUrl = pr.html_url;
      context.status = "already_proposed";
    } else if (!pr.merged_at) {
      throw new Error(`A previous proposal was closed without merging: ${pr.html_url}. Resolve that proposal before retrying.`);
    }
  }
  if (context.status === "prepared") execute("git", ["switch", "-c", identity.branch], root);
  return context;
}

function validateProposedFiles(context, pr, api) {
  if (pr.base?.repo?.full_name !== targetRepository || pr.base.ref !== "main"
    || pr.head?.repo?.full_name !== targetRepository || pr.head.ref !== context.branch
    || !/^[0-9a-f]{40}$/.test(pr.head.sha) || pr.state !== "open" || pr.draft !== true
    || !pr.body?.includes(context.marker) || !pr.body.includes(context.releaseUrl)) {
    throw new Error("The proposed update must be a draft PR on the expected Aspire branch, linked to this release.");
  }
  for (const [path, expectedBlob] of Object.entries(context.expectedFiles)) {
    if (contentAt(api, path, pr.head.sha).sha !== expectedBlob) {
      throw new Error(`The proposed PR changed or omitted the prepared bundle file: ${path}`);
    }
  }
  const files = api(`repos/${targetRepository}/pulls/${pr.number}/files?per_page=100`);
  if (!Array.isArray(files) || files.length === 0 || files.length >= 100) {
    throw new Error("The update must contain a bounded, nonempty patch.");
  }
  if (context.bundleUpdateRequired) {
    const changed = new Set(files.map(file => file.filename));
    for (const path of context.requiredBundlePaths) {
      if (!changed.has(path)) throw new Error(`The required bundle update omitted ${path}.`);
    }
    const previousArchive = `${embeddedDirectory}/${context.previousAssetName}`;
    if (context.previousAssetName !== context.assetName
      && !files.some(file => (file.filename === previousArchive && file.status === "removed")
        || (file.previous_filename === previousArchive && file.status === "renamed"))) {
      throw new Error("The update did not remove the previous embedded archive.");
    }
  }
}

export function validateOutcome(context, payload, createdPrUrl, api = githubApi) {
  if (!["prepared", "already_proposed", "superseded"].includes(context.status)) {
    throw new Error("Unknown prepared release status.");
  }
  const items = payload?.items;
  if (!Array.isArray(items)) throw new Error("The agent did not produce canonical safe outputs.");
  if (items.some(item => !["create_pull_request", "noop"].includes(item?.type))) {
    throw new Error("The agent reported an incomplete or unsupported release outcome.");
  }
  const creates = items.filter(item => item?.type === "create_pull_request");
  const noops = items.filter(item => item?.type === "noop");
  if (createdPrUrl) {
    if (context.status !== "prepared" || creates.length !== 1 || noops.length) {
      throw new Error("PR creation does not match the prepared release outcome.");
    }
    const match = /^https:\/\/github\.com\/microsoft\/aspire\/pull\/([1-9][0-9]*)$/.exec(createdPrUrl);
    if (!match) throw new Error("Safe outputs did not return a microsoft/aspire PR URL.");
    validateProposedFiles(context, api(`repos/${targetRepository}/pulls/${match[1]}`), api);
    return `Draft Aspire update: ${createdPrUrl}`;
  }
  if (creates.length || noops.length !== 1
    || typeof noops[0].message !== "string" || !noops[0].message.trim()) {
    throw new Error("The run did not produce a confirmed PR or an explicit no-change outcome.");
  }
  if (context.status === "already_proposed") {
    const match = /^https:\/\/github\.com\/microsoft\/aspire\/pull\/([1-9][0-9]*)$/.exec(context.existingPrUrl);
    if (!match) throw new Error("Invalid existing release PR URL.");
    validateProposedFiles(context, api(`repos/${targetRepository}/pulls/${match[1]}`), api);
    return `Release already proposed: ${context.existingPrUrl}`;
  }
  if (context.bundleUpdateRequired) {
    throw new Error("A newer skills release requires a bundle-update PR even when telemetry needs no changes.");
  }
  return context.status === "superseded"
    ? `Release ${context.tag} is superseded by embedded ${context.previousVersion}.`
    : `Embedded ${context.tag} needs no additional telemetry changes: ${noops[0].message}`;
}

function main() {
  const mode = process.argv[2];
  if (mode === "prepare") {
    const context = prepareUpdate({
      root: process.env.GITHUB_WORKSPACE,
      version: process.env.RELEASE_VERSION,
      sourceCommit: process.env.RELEASE_COMMIT
    });
    const directory = join(process.env.GITHUB_WORKSPACE, ".aspire-update");
    const trustedDirectory = join(process.env.RUNNER_TEMP, "aspire-update-context");
    mkdirSync(directory, { recursive: true });
    mkdirSync(trustedDirectory, { recursive: true });
    const json = `${JSON.stringify(context, null, 2)}\n`;
    writeFileSync(join(directory, "release.json"), json);
    writeFileSync(join(trustedDirectory, "release.json"), json);
  } else if (mode === "validate") {
    if (process.env.AGENT_RESULT !== "success" || process.env.SAFE_OUTPUTS_RESULT !== "success") {
      throw new Error("The agent and safe-output publication must both succeed.");
    }
    const context = JSON.parse(readFileSync(join(process.env.RUNNER_TEMP, "aspire-update-context", "release.json"), "utf8"));
    const payload = JSON.parse(readFileSync(join(process.env.RUNNER_TEMP, "aspire-update-agent", "agent_output.json"), "utf8"));
    const summary = validateOutcome(context, payload, process.env.CREATED_PR_URL ?? "");
    console.log(summary);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n\nSource release: ${context.releaseUrl}\n`);
  } else {
    throw new Error("Expected prepare or validate.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
