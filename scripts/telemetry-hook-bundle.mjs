import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const telemetryHookFileNames = [
  "track-telemetry.sh",
  "track-telemetry.ps1"
];

export const telemetryHookFileModes = {
  "track-telemetry.sh": 0o755,
  "track-telemetry.ps1": 0o644
};

export function normalizeHookBytes(bytes) {
  let text = Buffer.from(bytes).toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  return Buffer.from(text.replace(/\r\n?/g, "\n"), "utf8");
}

export function resolveSourceCommit(explicitCommit, repoRoot) {
  const commit = explicitCommit ?? readGitCommit(repoRoot);
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error(`Hook provenance must be a 40-character Git commit SHA; got '${commit}'.`);
  }

  return commit.toLowerCase();
}

export function publishTelemetryHooks({ sourceRoot, targetRoot, commitSha, repoRoot }) {
  mkdirSync(targetRoot, { recursive: true });
  const files = {};

  for (const fileName of telemetryHookFileNames) {
    const sourcePath = join(sourceRoot, fileName);
    const targetPath = join(targetRoot, fileName);
    const gitPath = relative(repoRoot, sourcePath).split(sep).join("/");
    const bytes = normalizeHookBytes(readFileSync(sourcePath));
    const committedBytes = normalizeHookBytes(readCommittedHookBytes(repoRoot, commitSha, gitPath));
    if (!bytes.equals(committedBytes)) {
      throw new Error(`Hook '${gitPath}' does not match commit '${commitSha}' after normalization.`);
    }

    writeFileSync(targetPath, bytes);
    chmodSync(targetPath, telemetryHookFileModes[fileName]);
    files[fileName] = createHash("sha512").update(bytes).digest("hex");
  }

  return {
    commitSha,
    files
  };
}

function readCommittedHookBytes(repoRoot, commitSha, gitPath) {
  const result = spawnSync("git", ["show", `${commitSha}:${gitPath}`], {
    cwd: repoRoot
  });

  if (result.error) {
    throw new Error(`Could not read hook '${gitPath}' from commit '${commitSha}': ${result.error.message}`);
  }

  if (result.status !== 0) {
    const detail = Buffer.from(result.stderr ?? "").toString("utf8").trim();
    throw new Error(
      `Could not read hook '${gitPath}' from commit '${commitSha}'${detail ? `: ${detail}` : "."}`
    );
  }

  return result.stdout;
}

function readGitCommit(repoRoot) {
  const result = spawnSync("git", ["rev-parse", "HEAD^{commit}"], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  if (result.error) {
    throw new Error(`Could not resolve hook source commit: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Could not resolve hook source commit: ${(result.stderr ?? "").trim()}`);
  }

  return result.stdout.trim();
}
