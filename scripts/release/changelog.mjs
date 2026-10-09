import { isUtf8 } from "node:buffer";
import { fullSha } from "./git.mjs";
import { onlyVersionChanges, parseVersion } from "./versions.mjs";
import { repositoryUrl } from "./github.mjs";

const markerPattern = /^<!-- aspire-skills-release from=([0-9a-f]{40}) to=([0-9a-f]{40}) main=([0-9a-f]{40}) -->$/;
const notesPattern = /^<!-- aspire-skills-changelog(-done)? from=([0-9a-f]{40}) to=([0-9a-f]{40}) base=([0-9A-Za-z.+-]*) -->$/;
const notesPlaceholder = "_User-facing release notes are pending. The release-changelog workflow will generate them. If generation fails, write and review the notes before merging; do not copy the source commit list._";

export function releaseHeading(version) {
  parseVersion(version);
  return `## [v${version}](${repositoryUrl()}/releases/tag/v${version})`;
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
  const markers = entry.split(/\r?\n/).filter(line => line.includes("aspire-skills-release"));
  const marker = markers.length === 1 && markerPattern.exec(markers[0]);
  const heading = /^## \[v([0-9A-Za-z.+-]+)\]\(https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+\/releases\/tag\/v\1\)\r?$/m.exec(entry);
  const notesMarkers = entry.split(/\r?\n/).filter(line => line.trimStart().startsWith("<!-- aspire-skills-changelog"));
  const notes = notesMarkers.length === 1 && notesPattern.exec(notesMarkers[0]);
  if (!markers.length && !notesMarkers.length && optional) return undefined;
  if (!heading || !entry.startsWith(heading[0]) || !notes
    || (markers.length && !marker) || (!marker && notes[1] !== "-done")) {
    throw new Error("The newest release entry must contain valid release metadata and a matching version/tag heading.");
  }
  if (marker && (notes[2] !== marker[1] || notes[3] !== marker[2])) {
    throw new Error("The changelog state marker must match the selected release's exact commit range and main baseline.");
  }
  parseVersion(heading[1]);
  if (notes[4]) parseVersion(notes[4]);
  return Object.freeze({
    from: fullSha(marker ? marker[1] : notes[2]), source: fullSha(marker ? marker[2] : notes[3]),
    base: marker ? fullSha(marker[3]) : undefined, version: heading[1],
    baselineVersion: notes[4],
    notesState: notes[1] === "-done" ? "finalized" : "pending", entry
  });
}

export function releaseMarker(context) {
  return `<!-- aspire-skills-release from=${context.from} to=${context.source} main=${context.base} -->`;
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

function escapeMarkdown(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/[\\`*_[\]#!|]/g, "\\$&").replace(/[\u0000-\u001f\u007f]/g, " ");
}

function combine(previous, entry) {
  const start = previous.search(/^## /m);
  const header = start < 0 ? previous : previous.slice(0, start);
  const history = start < 0 ? "" : previous.slice(start);
  return `${header}${header.endsWith("\n\n") ? "" : "\n\n"}${entry}\n${history ? `\n${history}` : ""}`;
}

function emptyNote(repo, base) {
  return repo.files(base, ["opencode"]).size
    ? "- No source changes beyond release-cycle metadata."
    : "- Initial source release and OpenCode catalogs.";
}

export function commitLog(context) {
  return context.changes.map(change => `${change.sha}\t${change.subject}\n`).join("");
}

export function releaseNotes(repo, context) {
  const url = repositoryUrl();
  const notes = context.changes.map(change =>
    `- ${escapeMarkdown(change.subject)} ([${change.sha.slice(0, 12)}](${url}/commit/${change.sha}))`);
  return `${notes.length ? notes.join("\n") : emptyNote(repo, context.base)}\n`;
}

export function changelogEntry(context) {
  return [
    releaseHeading(context.version), "", releaseMarker(context), "",
    changelogStateMarker(context, "pending"), "", notesPlaceholder
  ].join("\n");
}

export function generateChangelog(context, entry = changelogEntry(context)) {
  return combine(context.previousChangelog, entry);
}

export function validateChangelog(context, changelog, { allowPending = true } = {}) {
  const actual = latestRelease(changelog);
  for (const key of ["from", "source", "base", "version"]) {
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
      releaseHeading(context.version), "", releaseMarker(context), "",
      changelogStateMarker(context, "finalized"), "", ""
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
    throw new Error("Release notes are pending. Complete the agentic changelog or finalize the entry manually before merging.");
  }
}
