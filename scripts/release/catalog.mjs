import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertSafePath, createCatalog, isDevelopmentPath } from "../build-opencode-catalog.mjs";
import { updateVersion, versionSnapshot } from "./versions.mjs";

export function expectedCatalog(repo, source, version = versionSnapshot(repo, source).version) {
  const manifests = versionSnapshot(repo, source).manifests;
  const snapshot = mkdtempSync(join(tmpdir(), "aspire-release-source-"));
  try {
    mkdirSync(join(snapshot, "skills"));
    const entries = [...repo.files(source, ["skills"])].filter(([path]) => !isDevelopmentPath(path));
    const contents = repo.contents(entries.map(([, entry]) => entry));
    const paths = new Map();
    for (const [path, entry] of entries) {
      if (!path.startsWith("skills/")) throw new Error("skills must be a directory.");
      const relative = path.slice("skills/".length);
      assertSafePath(relative);
      const parts = relative.split("/");
      for (let length = 1; length <= parts.length; length++) {
        const prefix = parts.slice(0, length).join("/");
        const previous = paths.get(prefix.toLowerCase());
        if (previous && previous !== prefix) throw new Error(`Case-colliding skill paths: ${previous}, ${prefix}`);
        paths.set(prefix.toLowerCase(), prefix);
      }
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
        throw new Error(`Only regular skill files may be published: ${path}`);
      }
      const destination = join(snapshot, ...path.split("/"));
      mkdirSync(dirname(destination), { recursive: true });
      const bytes = contents.get(entry.oid);
      writeFileSync(destination, manifests.has(path) ? updateVersion(bytes, path, version) : bytes);
    }
    const files = new Map();
    for (const format of ["v1", "v2"]) {
      for (const [path, contents] of createCatalog(snapshot, { format }).files) {
        files.set(`opencode/${format}/${path}`, contents);
      }
    }
    return files;
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

export function validateCatalog(repo, candidate, expected) {
  const actual = repo.files(candidate, ["opencode"]);
  if (JSON.stringify([...actual.keys()].sort()) !== JSON.stringify([...expected.keys()].sort())) {
    throw new Error("Catalog paths do not match the selected source.");
  }
  const contents = repo.contents(actual.values());
  for (const [path, bytes] of expected) {
    const entry = actual.get(path);
    if (entry.mode !== "100644" || !contents.get(entry.oid).equals(bytes)) {
      throw new Error(`Catalog bytes or SHA-512 content version do not match: ${path}`);
    }
  }
}
