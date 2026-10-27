import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function redactEvalArtifacts(paths, token) {
  if (!token) {
    throw new Error("COPILOT_GITHUB_TOKEN is required to redact evaluation artifacts.");
  }
  if (paths.length === 0) {
    throw new Error("At least one evaluation artifact path is required.");
  }

  // Actions log masking does not apply to artifacts or encoded credentials.
  const secrets = [
    token,
    Buffer.from(token).toString("base64"),
    Buffer.from(`x-access-token:${token}`).toString("base64"),
  ].map(value => Buffer.from(value)).sort((a, b) => b.length - a.length);
  const replacement = Buffer.from("***");

  function redact(path, optional = false) {
    const rawPath = Buffer.from(path);
    // Base64 can span directory separators, which Windows joins with backslashes.
    const portablePath = Buffer.from(path.replaceAll("\\", "/"));
    if (secrets.some(secret => rawPath.includes(secret) || portablePath.includes(secret))) {
      throw new Error("Refusing to publish credential-bearing evaluation artifact paths.");
    }
    const stat = lstatSync(path, { throwIfNoEntry: !optional });
    if (!stat) {
      return;
    }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error("Refusing to publish linked or non-regular evaluation artifacts.");
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) {
        redact(join(path, name));
      }
      return;
    }
    if (stat.nlink !== 1) {
      throw new Error("Refusing to publish hard-linked evaluation artifacts.");
    }

    const original = readFileSync(path);
    let redacted = original;
    for (const secret of secrets) {
      const chunks = [];
      let start = 0;
      let index;
      while ((index = redacted.indexOf(secret, start)) !== -1) {
        chunks.push(redacted.subarray(start, index), replacement);
        start = index + secret.length;
      }
      if (chunks.length > 0) {
        chunks.push(redacted.subarray(start));
        redacted = Buffer.concat(chunks);
      }
    }
    if (redacted !== original) {
      writeFileSync(path, redacted);
    }
  }

  for (const path of paths) {
    // Failed evaluations may not have created every output.
    redact(path, true);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    redactEvalArtifacts(process.argv.slice(2), process.env.COPILOT_GITHUB_TOKEN);
  } catch {
    // Do not echo paths or filesystem errors that might contain a credential.
    console.error("Evaluation artifact redaction failed; results must not be published.");
    process.exitCode = 1;
  }
}
