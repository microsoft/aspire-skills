import { isUtf8 } from "node:buffer";
import { compareVersions, parseVersion } from "./release-versions.mjs";

const tagUrl = "https://github.com/microsoft/aspire-skills/releases/tag/v";
const constructionToken = Symbol("Changelog");

export function changelogHeading(version) {
  parseVersion(version);
  return `## [${version}](${tagUrl}${version})`;
}

// Sections are stored trimmed, so a heading-only section has no newline.
function sectionBody(section) {
  const newline = section.indexOf("\n");
  return newline < 0 ? "" : section.slice(newline);
}

// Immutable view of CHANGELOG.md: a free-form prefix followed by uniquely versioned
// sections in strictly descending version order.
export class Changelog {
  #prefix;
  #sections;
  #newline;

  constructor(token, prefix, sections, newline) {
    if (token !== constructionToken) throw new Error("Use Changelog.parse or Changelog.read.");
    if (/^## /m.test(prefix)) throw new Error("The changelog prefix cannot contain a version heading.");
    let previous;
    for (const [version, section] of sections) {
      if (previous !== undefined && compareVersions(previous, version) <= 0) {
        throw new Error("Changelog versions must be unique and in descending order.");
      }
      if (!`${section}\n`.startsWith(`${changelogHeading(version)}\n`) || section !== section.trimEnd()
        || /\n## /.test(section)) {
        throw new Error(`Invalid changelog section for ${version}.`);
      }
      previous = version;
    }
    this.#prefix = prefix;
    this.#sections = sections;
    this.#newline = newline;
    Object.freeze(this);
  }

  static parse(text) {
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const normalized = text.replaceAll("\r\n", "\n");
    const start = normalized.search(/^## /m);
    if (start < 0) throw new Error("CHANGELOG.md needs a version heading.");
    const sections = new Map();
    for (const section of normalized.slice(start).split(/(?=^## )/m)) {
      const version = /^## \[([^\]]+)\]/.exec(section)?.[1];
      if (!version || sections.has(version)) throw new Error("Invalid or duplicate changelog heading.");
      sections.set(version, section.trimEnd());
    }
    return new Changelog(constructionToken, normalized.slice(0, start), sections, newline);
  }

  static read(repo, sha) {
    const bytes = repo.read(sha, "CHANGELOG.md");
    if (!isUtf8(bytes)) throw new Error("CHANGELOG.md must be UTF-8.");
    return Changelog.parse(bytes.toString("utf8"));
  }

  get newest() {
    return this.#sections.keys().next().value;
  }

  section(version) {
    return this.#sections.get(version);
  }

  notes(version) {
    const section = this.#sections.get(version);
    return section === undefined ? undefined : sectionBody(section).trim();
  }

  // Throws unless every section in baseline appears here unchanged.
  assertPreserves(baseline, describe) {
    for (const [version, section] of baseline.#sections) {
      if (this.#sections.get(version) !== section) throw new Error(describe(version));
    }
  }

  withNewSection(version) {
    if (this.#sections.has(version)) throw new Error(`Changelog already has ${version}.`);
    return this.#with(new Map([[version, changelogHeading(version)], ...this.#sections]));
  }

  toBuffer() {
    const text = this.#prefix + [...this.#sections.values()].join("\n\n") + "\n";
    return Buffer.from(this.#newline === "\n" ? text : text.replaceAll("\n", this.#newline));
  }

  #with(sections) {
    return new Changelog(constructionToken, this.#prefix, sections, this.#newline);
  }
}
