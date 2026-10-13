import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function gitEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("GIT_")) delete environment[name];
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  // Git for Windows recognizes /dev/null, but not NUL, as a config path.
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

export function fullSha(value, label = "commit") {
  if (typeof value !== "string" || value.length !== 40 || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${label} must be a full Git commit SHA.`);
  }
  return value.toLowerCase();
}

export class Repository {
  constructor(root) {
    this.root = realpathSync.native(resolve(root));
    const actual = realpathSync.native(this.run(["rev-parse", "--show-toplevel"]).trim());
    const comparable = path => process.platform === "win32" ? path.toLowerCase() : path;
    if (comparable(actual) !== comparable(this.root)) {
      throw new Error("RELEASE_REPO must be the Git repository root.");
    }
    this.blobs = new Map();
    this.trees = new Map();
    this.commits = new Set();
    this.parentLists = new Map();
    this.firstParentHistories = new Map();
  }

  run(args, { statuses = [0], binary = false, input, indexFile } = {}) {
    const environment = gitEnvironment();
    if (indexFile) environment.GIT_INDEX_FILE = indexFile;
    const result = spawnSync("git", [
      "-c", `safe.directory=${this.root}`, "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false",
      "-c", "core.autocrlf=false", "-c", "user.name=Aspire Skills Bot",
      "-c", "user.email=aspire-skills-bot@users.noreply.github.com", ...args
    ], {
      cwd: this.root, env: environment, encoding: binary ? undefined : "utf8",
      maxBuffer: 64 * 1024 * 1024, input
    });
    if (result.error) throw result.error;
    if (!statuses.includes(result.status)) {
      throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`);
    }
    return statuses.length === 1 ? result.stdout : result;
  }

  sha(ref) {
    const sha = fullSha(this.run(["rev-parse", "--verify", `${ref}^{commit}`]).trim());
    this.commits.add(sha);
    return sha;
  }

  selected(value, label) {
    const sha = fullSha(value, label);
    if (!this.commits.has(sha) && this.sha(sha) !== sha) throw new Error(`${label} must identify a commit, not a tag.`);
    return sha;
  }

  hasRef(ref) {
    return this.run(["show-ref", "--verify", "--quiet", ref], { statuses: [0, 1] }).status === 0;
  }

  ancestor(older, newer) {
    return this.run(["merge-base", "--is-ancestor", older, newer], { statuses: [0, 1] }).status === 0;
  }

  requireAncestor(older, newer) {
    if (!this.ancestor(older, newer)) throw new Error(`${older} must be an ancestor of ${newer}.`);
  }

  firstParentAncestor(older, newer) {
    fullSha(newer);
    if (!this.firstParentHistories.has(newer)) {
      this.firstParentHistories.set(newer, new Set(this.run(["rev-list", "--first-parent", newer]).trim().split("\n")));
    }
    return this.firstParentHistories.get(newer).has(older);
  }

  requireFirstParent(older, newer) {
    if (!this.firstParentAncestor(older, newer)) {
      throw new Error(`${older} must be on ${newer}'s first-parent development history.`);
    }
  }

  withIndex(action) {
    const directory = mkdtempSync(join(tmpdir(), "aspire-release-index-"));
    try {
      return action(join(directory, "index"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  mergeTree(first, second) {
    const result = this.run(["merge-tree", "--write-tree", "--name-only", "-z", first, second], { statuses: [0, 1] });
    const separator = result.stdout.indexOf("\0");
    const tree = fullSha(result.stdout.slice(0, separator), "merge tree");
    const end = result.stdout.indexOf("\0\0", separator);
    const conflicts = result.status === 0 ? []
      : result.stdout.slice(separator + 1, end).split("\0").filter(Boolean);
    if (result.status !== 0 && (end < 0 || !conflicts.length)) {
      throw new Error("Git merge failed without identifying conflicted paths.");
    }
    return { tree, conflicts };
  }

  commitTree(tree, parents, message) {
    return this.run([
      "commit-tree", tree, ...parents.flatMap(parent => ["-p", parent]), "-m", message,
      "-m", "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
    ]).trim();
  }

  parents(sha) {
    fullSha(sha);
    if (!this.parentLists.has(sha)) {
      this.parentLists.set(sha, this.run(["show", "-s", "--format=%P", sha]).trim().split(" ").filter(Boolean));
    }
    return this.parentLists.get(sha);
  }

  files(sha, paths = []) {
    fullSha(sha);
    const key = JSON.stringify([sha, paths]);
    if (!this.trees.has(key)) {
      const entries = this.run(["ls-tree", "-r", "-z", sha, "--", ...paths]).split("\0").filter(Boolean);
      this.trees.set(key, new Map(entries.map(record => {
        const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/.exec(record);
        if (!match) throw new Error("Invalid Git tree entry.");
        return [match[4], { mode: match[1], type: match[2], oid: match[3] }];
      })));
    }
    return this.trees.get(key);
  }

  contents(entries) {
    const missing = [...new Set([...entries].map(entry => entry.oid))].filter(oid => !this.blobs.has(oid));
    if (missing.length) {
      const output = this.run(["cat-file", "--batch"], { binary: true, input: `${missing.join("\n")}\n` });
      let position = 0;
      for (const oid of missing) {
        const end = output.indexOf(10, position);
        const header = /^([0-9a-f]{40}) blob (\d+)$/.exec(output.subarray(position, end).toString("utf8"));
        if (!header || header[1] !== oid) throw new Error("Invalid Git blob batch.");
        const size = Number(header[2]);
        position = end + 1;
        if (!Number.isSafeInteger(size) || position + size >= output.length || output[position + size] !== 10) {
          throw new Error("Truncated Git blob batch.");
        }
        this.blobs.set(oid, output.subarray(position, position + size));
        position += size + 1;
      }
    }
    return this.blobs;
  }

  read(sha, path) {
    const entry = this.files(sha, [path]).get(path);
    if (entry?.mode !== "100644" || entry.type !== "blob") {
      throw new Error(`Expected a regular committed file: ${path}`);
    }
    return this.contents([entry]).get(entry.oid);
  }

  sameTree(source, ref, { exclude = [] } = {}) {
    return this.run([
      "diff", "--no-ext-diff", "--no-textconv", "--quiet",
      source, ref, "--", ".", ...exclude.map(path => `:(top,exclude)${path}`)
    ], { statuses: [0, 1] }).status === 0;
  }
}
