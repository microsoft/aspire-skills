import { isUtf8 } from "node:buffer";
import { parseVersion } from "./release-versions.mjs";
import { repositoryUrl } from "./release-github.mjs";

export function readChangelog(repo, sha) {
  const contents = repo.read(sha, "CHANGELOG.md");
  if (!isUtf8(contents)) throw new Error("CHANGELOG.md must be UTF-8.");
  return contents.toString("utf8");
}

export function latestRelease(changelog) {
  const start = changelog.search(/^## /m);
  const next = start < 0 ? -1 : changelog.slice(start + 1).search(/^## /m);
  const end = next < 0 ? changelog.length : start + 1 + next;
  const entry = start < 0 ? "" : changelog.slice(start, end).trimEnd();
  const heading = /^## \[([0-9A-Za-z.+-]+)\]\(https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+\/releases\/tag\/v\1\)\r?\n/.exec(entry);
  if (!heading) throw new Error("The newest changelog entry must have a matching version/tag heading.");
  parseVersion(heading[1]);
  if (!heading[0].trimEnd().includes(`${repositoryUrl()}/releases/tag/v${heading[1]}`)) {
    throw new Error("The changelog tag link must identify the release repository.");
  }
  return { version: heading[1], notes: `${entry.slice(heading[0].length).trim().replaceAll("\r\n", "\n")}\n`, start, end };
}

export function releaseNotes(changelog) {
  const { notes } = latestRelease(changelog);
  const sections = notes.trimEnd().split(/^### /m);
  const preamble = sections.shift();
  let previous = -1;
  if (Buffer.byteLength(notes) > 32 * 1024 || preamble.trim() || !sections.length) {
    throw new Error("Release notes must contain user-facing Changed, Removed, or Added sections, not placeholders or metadata.");
  }
  for (const section of sections) {
    const [heading, ...lines] = section.split(/\r?\n/);
    const position = ["Changed", "Removed", "Added"].indexOf(heading);
    const body = lines.join("\n");
    if (position <= previous || !/^- \S/m.test(body) || /^#{1,6}\s/m.test(body)
      || /<!-- aspire-skills-|^_User-facing release notes are pending/m.test(body)) {
      throw new Error("Release notes must use nonempty Changed, Removed, and Added sections in that order; omit empty sections.");
    }
    previous = position;
  }
  return notes;
}

export function validateChangelog(changelog, version, previous) {
  const release = latestRelease(changelog);
  if (release.version !== version) throw new Error("Changelog version does not match the release.");
  releaseNotes(changelog);
  if (previous !== undefined) {
    const start = previous.search(/^## /m);
    if (start < 0 || changelog.slice(0, release.start) !== previous.slice(0, start)
      || changelog.slice(release.end) !== previous.slice(start)) {
      throw new Error("Released changelog history or its header was modified.");
    }
  }
}
