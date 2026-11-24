import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

function assertWritePath(root, path) {
  assert.ok(inside(root, path), "Mock write escapes fixture workspace");
  let current = path;
  while (current !== root) {
    try {
      const stat = lstatSync(current);
      assert.ok(!stat.isSymbolicLink(), "Mock write follows symlink or junction");
      assert.ok(inside(root, realpathSync(current)), "Mock write escapes fixture workspace");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    current = dirname(current);
  }
}

// This mock performs only fixture-local writes: no installs, MSBuild, network or child processes.
export function runMock(root, cwd, args) {
  root = realpathSync(root);
  // Copied mocks share the enclosing fixture's stream, never a per-copy audit.
  let auditRoot = root;
  while (!existsSync(join(auditRoot, "original/aspire.config.json")) || !existsSync(join(auditRoot, "legacy/.aspire/settings.json"))) {
    assert.notEqual(auditRoot, dirname(auditRoot), "No enclosing fixture workspace found");
    auditRoot = dirname(auditRoot);
  }
  const auditPath = join(auditRoot, "mock-audit.jsonl");
  assertWritePath(auditRoot, auditPath);
  const record = { id: randomUUID(), command: args[0], args, cwd: relative(auditRoot, resolve(cwd)),
    inputs: [], writes: [], exitCode: 1 };
  appendFileSync(auditPath, `${JSON.stringify({ event: "attempt", ...record })}\n`);
  try {
    return executeMock(root, auditRoot, cwd, args, record);
  } finally {
    appendFileSync(auditPath, `${JSON.stringify({ event: "result", ...record })}\n`);
  }
}

function executeMock(root, auditRoot, cwd, args, record) {
  cwd = realpathSync(cwd);
  record.cwd = relative(auditRoot, cwd);
  assert.ok(inside(root, cwd), "Mock working directory must stay in the fixture workspace");
  const [command] = args;
  assert.ok(["add", "restore"].includes(command), "Only mock add/restore is supported");
  if (args.includes("--help")) {
    record.exitCode = 0;
    return { exitCode: 0, output: `${command} --apphost <path> --non-interactive --version <version>` };
  }
  const targetIndex = args.indexOf("--apphost");
  assert.ok(targetIndex >= 0 && args[targetIndex + 1], "An explicit --apphost is required");
  assert.ok(args.includes("--non-interactive"), "Use --non-interactive");
  const apphost = realpathSync(resolve(cwd, args[targetIndex + 1]));
  assert.ok(inside(root, apphost), "AppHost must stay in the fixture workspace");
  const hostDir = dirname(apphost);
  let configDir = hostDir;
  while (!existsSync(join(configDir, "aspire.config.json")) && !existsSync(join(configDir, ".aspire/settings.json"))) {
    assert.notEqual(configDir, root, "No fixture config found");
    configDir = dirname(configDir);
  }
  const configPath = join(configDir, "aspire.config.json");
  record.apphost = relative(auditRoot, apphost);
  record.config = relative(auditRoot, configPath);
  const write = (path, text) => {
    assertWritePath(root, path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    record.writes.push(relative(auditRoot, path));
  };
  let config;
  if (existsSync(configPath)) config = readJson(configPath);
  else {
    const legacy = readJson(join(configDir, ".aspire/settings.json"));
    config = { sdk: { version: legacy.sdkVersion }, channel: legacy.channel, packages: legacy.packages };
    write(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  if (command === "add") {
    const versionIndex = args.indexOf("--version");
    assert.equal(args[1], "Aspire.Hosting.Dotnet");
    assert.equal(args[versionIndex + 1], config.sdk.version, "Preserve the pinned version");
    config.packages["Aspire.Hosting.Dotnet"] = config.sdk.version;
  }
  // Legacy failure is deliberately after config migration but before codegen/install.
  if (relative(root, apphost) === join("legacy", "apphost.mts")) {
    record.exitCode = 6;
  } else {
    const visited = new Set();
    const build = path => {
      path = realpathSync(path);
      assert.ok(inside(root, path), "Mock build input escapes fixture workspace");
      if (visited.has(path)) return;
      visited.add(path);
      record.inputs.push(relative(auditRoot, path));
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/<(?:ProjectReference|Import)\s+(?:Include|Project)="([^"]+)"/g)) {
        build(resolve(dirname(path), match[1]));
      }
      if (path.endsWith(".csproj")) write(join(dirname(path), "build-marker.txt"), "build ran\n");
    };
    for (const version of Object.values(config.packages)) {
      if (version.endsWith(".csproj")) build(resolve(configDir, version));
    }
    const api = config.packages["Aspire.Hosting.Dotnet"]
      ? "export declare function addDotnetProject(name: string, path: string, options?: DotnetProjectOptions): unknown;\nexport interface DotnetProjectOptions { launchProfileName?: string; }\n"
      : "export declare function addProject(name: string, path: string): unknown;\n";
    write(join(hostDir, ".aspire/modules/aspire.mts"), api);
    if (existsSync(join(hostDir, "package.json"))) {
      write(join(hostDir, "package-lock.json"), '{ "lockfileVersion": 3, "mockInstall": true }\n');
      write(join(hostDir, "lifecycle-marker.txt"), "postinstall ran\n");
    }
    if (command === "add") write(configPath, `${JSON.stringify(config, null, 2)}\n`);
    record.exitCode = 0;
  }
  return { exitCode: record.exitCode, output: record.exitCode
    ? "IntegrationRestore.csproj: SourceRoot.RevisionId is not a valid commit hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'"
    : "Mock preparation complete; generated declarations are synthetic, not installed-package proof." };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runMock(dirname(fileURLToPath(import.meta.url)), process.cwd(), process.argv.slice(2));
    console.log(result.output);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
