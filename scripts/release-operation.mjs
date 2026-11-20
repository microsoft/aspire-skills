import { fullSha } from "./release-git.mjs";
import { compareVersions, parseVersion } from "./release-versions.mjs";

const constructionToken = Symbol("ReleaseOperation");
const fields = String.raw`Aspire-Release-Source: (\S+)\nAspire-Release-Version: (\S+)\nAspire-Next-Version: (\S+?)`;
const block = new RegExp(String.raw`^(?:<!-- ${fields} -->|${fields})$`, "gim");
const field = /^(?:<!-- )?Aspire-(?:Release-Source|Release-Version|Next-Version):/gim;

// One release preparation: the dev commit it snapshots, the release version, and the next dev version.
// Instances are always valid, so serialized markers cannot carry forged or extra lines.
// Serialized as a commit trailer on the dev bump and as an HTML comment in both PR bodies.
export class ReleaseOperation {
  #source;
  #version;
  #nextVersion;

  constructor(token, source, version, nextVersion) {
    if (token !== constructionToken) throw new Error("Use ReleaseOperation.create or ReleaseOperation.parse.");
    parseVersion(version);
    parseVersion(nextVersion);
    if (compareVersions(nextVersion, version) <= 0) throw new Error("Next dev version must be newer than the release.");
    this.#source = fullSha(source, "Release source");
    this.#version = version;
    this.#nextVersion = nextVersion;
    Object.freeze(this);
  }

  static create({ source, version, nextVersion }) {
    return new ReleaseOperation(constructionToken, source, version, nextVersion);
  }

  // Returns the recorded operation, or null when none is recorded. Partial, malformed,
  // or conflicting markers throw so callers never act on an ambiguous source.
  static parse(text) {
    const normalized = (text ?? "").replaceAll("\r\n", "\n");
    const blocks = [...normalized.matchAll(block)];
    if ([...normalized.matchAll(field)].length !== blocks.length * 3) {
      throw new Error("The release operation marker is incomplete or malformed.");
    }
    const operations = blocks.map(match => {
      const [source, version, nextVersion] = match.slice(1).filter(value => value !== undefined);
      return new ReleaseOperation(constructionToken, source, version, nextVersion);
    });
    if (operations.some(operation => !operation.equals(operations[0]))) {
      throw new Error("More than one release operation is recorded.");
    }
    return operations[0] ?? null;
  }

  get source() {
    return this.#source;
  }

  get version() {
    return this.#version;
  }

  get nextVersion() {
    return this.#nextVersion;
  }

  equals(other) {
    return typeof other === "object" && other !== null && #source in other && this.#source === other.#source
      && this.#version === other.#version && this.#nextVersion === other.#nextVersion;
  }

  trailer() {
    return `Aspire-Release-Source: ${this.#source}\nAspire-Release-Version: ${this.#version}\nAspire-Next-Version: ${this.#nextVersion}`;
  }

  comment() {
    return `<!-- ${this.trailer()} -->`;
  }

  toJSON() {
    return { source: this.#source, version: this.#version, nextVersion: this.#nextVersion };
  }
}
