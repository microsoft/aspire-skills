import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL(".", import.meta.url));
const reference = readFileSync(new URL("../../skills/aspire-terminals/references/apphost-terminals.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const recipes = [...reference.matchAll(/```csharp\n(#pragma[\s\S]*?)\n```/g)].map(match => match[1]);
assert.equal(recipes.length, 4, "Expected dock, manual prompt, Work prompt and headless recipes");
const resource = readFileSync(new URL("../../skills/aspire-terminals/references/resource-terminals.md", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n")
  .match(/```csharp\n([\s\S]*?)\n```/)[1].replace("worker.WithTerminal", "resource.WithTerminal");
const root = mkdtempSync(join(tmpdir(), "aspire-terminal-qualification-"));
try {
  cpSync(join(fixture, "app"), join(root, "app"), { recursive: true });
  cpSync(join(fixture, "NuGet.config"), join(root, "NuGet.config"));
  const source = readFileSync(join(root, "app/Program.cs"), "utf8");
  writeFileSync(join(root, "app/Program.cs"),
    source.replace("builder.Build().Run();", `${resource}\n${recipes.join("\n\n")}\n\nbuilder.Build().Run();`));
  execFileSync("dotnet", ["build", join(root, "app/AppHost.csproj"), "--nologo", "-v:q"], {
    cwd: root, stdio: "inherit", timeout: 240_000
  });
  cpSync(join(fixture, "app"), join(root, "legacy"), { recursive: true });
  const project = readFileSync(join(root, "legacy/AppHost.csproj"), "utf8")
    .replaceAll("13.6.0-preview.1.26474.10", "13.5.3");
  writeFileSync(join(root, "legacy/AppHost.csproj"), project);
  writeFileSync(join(root, "legacy/Program.cs"),
    source.replace("builder.Build().Run();", `${resource}\nbuilder.Build().Run();`));
  execFileSync("dotnet", ["build", join(root, "legacy/AppHost.csproj"), "--nologo", "-v:q"], {
    cwd: root, stdio: "inherit", timeout: 240_000
  });
  console.log("Four AppHost recipes and resource PTY compiled on 13.6; resource PTY also compiled on 13.5.3.");
  console.log("Compilation does not qualify dashboard, PTY or cancellation runtime behavior.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
