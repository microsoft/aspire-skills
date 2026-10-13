import { isUtf8 } from "node:buffer";
import { fullSha } from "./git.mjs";
import { onlyVersionChanges, parseVersion } from "./versions.mjs";
import { repositoryUrl } from "./github.mjs";

const notesPattern = /^<!-- aspire-skills-changelog(-done)? from=([0-9a-f]{40}) to=([0-9a-f]{40}) base=([0-9A-Za-z.+-]*) -->$/;
const notesPlaceholder = "_User-facing release notes are pending. Complete the release skill and review this entry before committing; do not copy the source commit list._";

export function releaseHeading(version) {
  parseVersion(version);
  return `## [${version}](${repositoryUrl()}/releases/tag/v${version})`;
}

export function releaseMessage(context) {
  parseVersion(context.version);
  const from = fullSha(context.from, "previous release source");
  const source = fullSha(context.source, "selected release source");
  return Object.freeze({
    title: `Release v${context.version}`,
    body: `Source range: ${repositoryUrl()}/compare/${from}..${source}`
  });
}

export function readChangelog(repo, sha) {
  const contents = repo.read(sha, "CHANGELOG.md");
  if (!isUtf8(contents)) throw new Error("CHANGELOG.md must be UTF-8.");
  return contents.toString("utf8");
}

export function latestRelease(changelog, { optional = false } = {}) {
  const start = changelog.search(/^## /m);
  const end = start < 0 ? -1 : changelog.slice(start + 1).search(/^## /m);
  const entry = start < 0 ? "" : changelog.slice(start, end < 0 ? undefined : start + 1 + end).trimEnd();
  const heading = /^## \[([0-9A-Za-z.+-]+)\]\(https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+\/releases\/tag\/v\1\)\r?$/m.exec(entry);
  const notesMarkers = entry.split(/\r?\n/).filter(line => line.trimStart().startsWith("<!-- aspire-skills-changelog"));
  const notes = notesMarkers.length === 1 && notesPattern.exec(notesMarkers[0]);
  if (!notesMarkers.length && optional) return undefined;
  if (!heading || !entry.startsWith(heading[0]) || !notes
    || entry.includes("<!-- aspire-skills-release")) {
    throw new Error("The newest release entry must contain valid release metadata and a matching version/tag heading.");
  }
  parseVersion(heading[1]);
  if (notes[4]) parseVersion(notes[4]);
  return Object.freeze({
    from: fullSha(notes[2]), source: fullSha(notes[3]), version: heading[1],
    baselineVersion: notes[4],
    notesState: notes[1] === "-done" ? "finalized" : "pending", entry
  });
}

export function changelogStateMarker(context, state) {
  if (!["pending", "finalized"].includes(state)) throw new Error("Invalid changelog generation state.");
  parseVersion(context.baselineVersion);
  return `<!-- aspire-skills-changelog${state === "finalized" ? "-done" : ""} from=${context.from} to=${context.source} base=${context.baselineVersion} -->`;
}

export function developmentChanges(repo, from, source) {
  repo.requireAncestor(from, source);
  const rows = repo.run([
    "log", "--first-parent", "--reverse", "--format=%H%x09%P%x09%s", `${from}..${source}`
  ]).trimEnd().split("\n").filter(Boolean).map(line => {
    const [sha, lineage, ...subject] = line.split("\t");
    return { sha: fullSha(sha), parents: lineage.split(" ").filter(Boolean), subject: subject.join("\t") };
  });
  let previous = from;
  const changes = [];
  for (const row of rows) {
    if (row.parents[0] !== previous) {
      throw new Error("The previous release source is not on dev's first-parent history. Reconcile rewritten source history explicitly.");
    }
    if (!onlyVersionChanges(repo, previous, row.sha)) changes.push(row);
    previous = row.sha;
  }
  if (previous !== source) throw new Error("The selected development range is incomplete.");
  return changes;
}

function combine(previous, entry) {
  const start = previous.search(/^## /m);
  const header = start < 0 ? previous : previous.slice(0, start);
  const history = start < 0 ? "" : previous.slice(start);
  return `${header}${header.endsWith("\n\n") ? "" : "\n\n"}${entry}\n${history ? `\n${history}` : ""}`;
}

export function changelogEntry(context) {
  return [
    releaseHeading(context.version), "", changelogStateMarker(context, "pending"), "", notesPlaceholder
  ].join("\n");
}

export function generateChangelog(context, entry = changelogEntry(context)) {
  return combine(context.previousChangelog, entry);
}

export function validateChangelog(context, changelog, { allowPending = true } = {}) {
  const actual = latestRelease(changelog);
  for (const key of ["from", "source", "version"]) {
    if (actual[key] !== context[key]) throw new Error(`Changelog ${key} does not match the selected release.`);
  }
  if (actual.baselineVersion !== context.baselineVersion) {
    throw new Error("Changelog base version does not match the previous release.");
  }
  if (combine(context.previousChangelog, actual.entry) !== changelog) {
    throw new Error("Released changelog history or its header was modified.");
  }
  if (actual.notesState === "finalized") {
    const prefix = [
      releaseHeading(context.version), "", changelogStateMarker(context, "finalized"), "", ""
    ].join("\n");
    if (!actual.entry.startsWith(prefix) || !/^- \S/m.test(actual.entry.slice(prefix.length))
      || actual.entry.includes(notesPlaceholder) || actual.entry.includes("### Provisional changes")) {
      throw new Error("Finalized release notes must replace the placeholder and contain user-facing Markdown bullets.");
    }
    return;
  }
  if (actual.entry !== changelogEntry(context)) {
    throw new Error("Pending release notes must retain their metadata and placeholder without a raw commit list.");
  }
  if (!allowPending) {
    throw new Error("Release notes are pending. Review the proposed notes and finalize the entry as a maintainer before merging.");
  }
}
