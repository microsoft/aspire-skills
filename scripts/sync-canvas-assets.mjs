import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  throw new Error("Usage: node scripts/sync-canvas-assets.mjs [--check]");
}

const check = args.includes("--check");
const extensions = ["aspire-apphosts", "aspire-doctor", "aspireify"];
const assets = ["theme.css", "icons.svg"].map(name => ({
  name: `canvas-${name}`,
  contents: readFileSync(join(repoRoot, "assets", "canvas", name))
}));
let updated = 0;

for (const extension of extensions) {
  for (const asset of assets) {
    const target = join(repoRoot, "extensions", extension, "ui", asset.name);
    if (existsSync(target) && readFileSync(target).equals(asset.contents)) {
      continue;
    }
    if (check) {
      console.error(`${relative(repoRoot, target)} is missing or stale. Run npm run canvas:sync.`);
      process.exitCode = 1;
    } else {
      writeFileSync(target, asset.contents);
      updated++;
    }
  }
}

if (!check) {
  console.log(`Canvas assets synchronized (${updated} updated).`);
}
