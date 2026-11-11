import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

const sourceRepository = { owner: "microsoft", repo: "aspire-skills" };
const targetRepository = { owner: "microsoft", repo: "aspire" };
const catalogPath = "src/Aspire.Cli/Agents/Hooks/telemetry-catalog.json";
const branch = "update-aspire-telemetry-catalog";

function referenceFiles(directory, prefix) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...referenceFiles(join(directory, entry.name), path));
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      throw new Error(`References must be regular files or directories: ${path}`);
    }
  }
  return files;
}

export function generateTelemetryCatalog(directory) {
  const root = join(directory, "skills");
  if (!lstatSync(root).isDirectory()) throw new Error("Canonical skills must be a regular directory.");
  const skills = [];
  const references = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile()) continue;
    if (!entry.isDirectory()) throw new Error(`Skill must be a regular directory: ${entry.name}`);
    const path = join(root, entry.name);
    if (!lstatSync(join(path, "SKILL.md"), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Skill is missing a regular SKILL.md: ${entry.name}`);
    }
    skills.push(entry.name);
    const referenceDirectory = join(path, "references");
    const referenceEntry = lstatSync(referenceDirectory, { throwIfNoEntry: false });
    if (referenceEntry) {
      if (!referenceEntry.isDirectory()) throw new Error(`References must be a regular directory: ${entry.name}`);
      references.push(...referenceFiles(referenceDirectory, `${entry.name}/references`));
    }
  }
  if (!skills.length) throw new Error("The telemetry catalog must contain at least one skill.");
  return {
    skills: [...new Set(skills)].sort(),
    references: [...new Set(references)].sort()
  };
}

export async function resolveTelemetrySource({ github, context }) {
  const manual = context.eventName === "workflow_dispatch";
  const value = manual ? context.payload.inputs?.pr_number : String(context.payload.pull_request?.number);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || String(number) !== value) {
    throw new Error("pr_number must be a positive integer.");
  }
  const { data: pr } = await github.rest.pulls.get({ ...sourceRepository, pull_number: number });
  if (pr.base.ref !== "main" || pr.base.repo.full_name !== "microsoft/aspire-skills") {
    throw new Error("The source PR must target microsoft/aspire-skills main.");
  }
  if (!manual && (!pr.merged || pr.merge_commit_sha !== context.payload.pull_request.merge_commit_sha)) {
    throw new Error("Automatic synchronization requires the triggering merged PR.");
  }
  const commit = pr.merged ? pr.merge_commit_sha : pr.head.sha;
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("Source must be an immutable commit SHA.");
  return {
    number, commit,
    url: `https://github.com/microsoft/aspire-skills/pull/${number}`,
    dryRun: manual && [true, "true"].includes(context.payload.inputs?.dry_run)
  };
}

export async function syncTelemetryCatalog({ github, directory, source }) {
  const content = `${JSON.stringify(generateTelemetryCatalog(directory), null, 2)}\n`;
  const { data: main } = await github.rest.git.getRef({ ...targetRepository, ref: "heads/main" });
  const base = main.object.sha;
  const { data: current } = await github.rest.repos.getContent({
    ...targetRepository, path: catalogPath, ref: base
  });
  if (current.type !== "file" || current.encoding !== "base64") {
    throw new Error("The Aspire telemetry catalog must be a base64-encoded regular file.");
  }
  if (Buffer.from(current.content, "base64").toString("utf8") === content) {
    return { status: "unchanged", content };
  }
  if (source.dryRun) return { status: "preview", content };

  const { data: proposals } = await github.rest.pulls.list({
    ...targetRepository, state: "open", base: "main", head: `microsoft:${branch}`
  });
  let head;
  try {
    const { data } = await github.rest.git.getRef({ ...targetRepository, ref: `heads/${branch}` });
    head = data.object.sha;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  const { data: parent } = await github.rest.git.getCommit({ ...targetRepository, commit_sha: base });
  const { data: tree } = await github.rest.git.createTree({
    ...targetRepository, base_tree: parent.tree.sha,
    tree: [{ path: catalogPath, mode: "100644", type: "blob", content }]
  });
  const previous = head
    ? (await github.rest.git.getCommit({ ...targetRepository, commit_sha: head })).data
    : undefined;
  if (!previous || previous.tree.sha !== tree.sha || previous.parents.length !== 1 || previous.parents[0].sha !== base) {
    const { data: commit } = await github.rest.git.createCommit({
      ...targetRepository,
      message: `Sync telemetry catalog with microsoft/aspire-skills#${source.number}`,
      tree: tree.sha, parents: [base]
    });
    if (head) {
      await github.rest.git.updateRef({ ...targetRepository, ref: `heads/${branch}`, sha: commit.sha, force: true });
    } else {
      await github.rest.git.createRef({ ...targetRepository, ref: `refs/heads/${branch}`, sha: commit.sha });
    }
  }

  const title = "[telemetry] Sync aspire-skills catalog";
  const body = [
    `Sync the telemetry catalog with [microsoft/aspire-skills#${source.number}](${source.url})`,
    `at \`${source.commit}\`.`,
    "",
    "Generated from canonical `skills/` directories and their `references/` files.",
    "",
    "<!-- aspire-skills-telemetry-catalog -->"
  ].join("\n");
  let proposal;
  if (proposals.length) {
    ({ data: proposal } = await github.rest.pulls.update({
      ...targetRepository, pull_number: proposals[0].number, title, body
    }));
  } else {
    ({ data: proposal } = await github.rest.pulls.create({
      ...targetRepository, head: branch, base: "main", title, body,
      draft: true, maintainer_can_modify: false
    }));
    await github.rest.issues.addLabels({
      ...targetRepository, issue_number: proposal.number,
      labels: ["area-cli", "area-engineering-systems"]
    });
  }
  return { status: proposals.length ? "updated" : "created", content, url: proposal.html_url };
}
