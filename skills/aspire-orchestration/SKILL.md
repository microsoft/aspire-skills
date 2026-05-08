---
name: aspire-orchestration
description: >-
  **WORKFLOW SKILL** — Manage Aspire AppHost lifecycle and recover from file locks,
  port conflicts, orphaned processes. WHEN: "start my Aspire app", "aspire wait",
  "restart the API service", "file lock error", "port in use", "upgrade Aspire CLI",
  "proxies missing". INVOKES: aspire CLI (start, stop, wait, ps, resource, add, init,
  doctor, update). FOR SINGLE OPERATIONS: Run the aspire CLI directly.
license: MIT
metadata:
  author: Microsoft
  version: "1.1.0"
---

# Aspire Orchestration

> **MANDATORY COMPLIANCE** — This skill prevents agent self-harm in Aspire projects.
> Violating these rules causes file locks, orphaned processes, and user frustration ([#15801](https://github.com/microsoft/aspire/issues/15801)).

## Prerequisites

| Requirement | Install |
|-------------|---------|
| .NET 10.0 SDK | https://dotnet.microsoft.com/download |
| Aspire CLI (curl/PowerShell) | `curl -sSL https://aspire.dev/install.sh \| bash` |
| Aspire CLI (NativeAOT global tool, .NET 10) | `dotnet tool install -g Aspire.Cli` |

Either install method works. The `dotnet tool install` path produces a NativeAOT binary
(instant startup, no JIT warmup) and is the recommended option when .NET 10 is already present.

## Detection

Activate when ANY signal is present:

| Signal | How to Detect | Confidence |
|--------|---------------|------------|
| C# AppHost | `.csproj` containing `Aspire.AppHost.Sdk` | ✅ Definitive |
| File-based C# AppHost | `apphost.cs` or `.cs` file with `#:sdk Aspire.AppHost.Sdk` | ✅ Definitive |
| TypeScript AppHost | `apphost.ts` file in project | ✅ Definitive |
| Aspire config | `aspire.config.json` in project root | High |
| Aspire settings | `.aspire/` directory present | High |
| Modules directory | `.modules/` directory present | High |
| Service defaults | `Aspire.ServiceDefaults` in project references | Medium |

See [detection.md](references/detection.md) for detailed fingerprinting.

## Safety Guardrails

| Situation | ✅ ALWAYS Do | ❌ NEVER Do |
|-----------|-------------|------------|
| Start an Aspire app | `aspire start` | `dotnet run` on AppHost |
| Wait for resource ready | `aspire wait <resource>` | `curl` / HTTP polling loops |
| Code changed in a resource | `aspire resource <name> restart` | `dotnet build` against locked files |
| Task complete | `aspire stop` | Leave processes running |
| Check resource status | `aspire describe` / `aspire ps` | Manual process inspection |
| Working in git worktree | `aspire start --isolated` | `aspire start` without isolation |
| Running from AI agent | Add `--non-interactive` to all commands | Assuming interactive terminal |
| Editing unfamiliar API | `aspire docs search <topic>` then `aspire docs api search <query>` for API reference | Guessing API shape |
| C# AppHost API inspection | Use `dotnet-inspect` skill (if available) for local symbols | Guessing overloads or builder chains |
| Adding custom dashboard/resource commands | `aspire docs search "custom resource commands"` first | Inventing `WithCommand` patterns without docs |
| Installing Aspire support | Use `aspire add` or `aspire init` | ~~`dotnet workload install aspire`~~ (obsolete) |

See [safety-guardrails.md](references/safety-guardrails.md) for detailed rules and recovery patterns.

## Default Workflow

1. Confirm workspace is Aspire — identify the AppHost
2. `aspire start` (or `aspire start --isolated` in worktrees)
3. `aspire wait <resource>` before interacting with any resource
4. `aspire describe` to inspect state, then work
5. `aspire resource <name> restart` after code changes
6. `aspire stop` when task is complete

## Quick Reference

| Task | Command |
|------|---------|
| Start app (agents) | `aspire start` (background, preferred) |
| Start app (human) | `aspire run` (foreground, dashboard) |
| Stop app | `aspire stop` |
| Wait for resource | `aspire wait <resource>` |
| Check status | `aspire ps` or `aspire describe` (13.3+ also shows the dashboard URL in `aspire ps`) |
| Show hidden resources (proxies, helpers, migrations) | `aspire ps --include-hidden` / `aspire describe --include-hidden` |
| Restart one resource | `aspire resource <name> restart` |
| Create new project | `aspire new aspire-starter` |
| Add Aspire to existing | `aspire init` (then hand off to `aspireify` skill for wiring) |
| Add integration | `aspire add <package>` |
| Upgrade the CLI itself | `aspire update --self` |
| Update project package refs | `aspire update` (modifies project files — get user approval) |
| Restore generated files | `aspire restore` |
| Diagnose environment | `aspire doctor` |
| Machine-readable output | `--format Json` (supported: `ps`, `describe`, `start`) |
| Look up API reference | `aspire docs api search <query> --language csharp\|typescript` |
| Browse API entries | `aspire docs api list <scope>` |
| Get API detail | `aspire docs api get <id>` |

## Error Handling

| Symptom | Cause | Action |
|---------|-------|--------|
| File lock errors during build | Aspire holds file locks | `aspire stop`, then rebuild |
| "Port already in use" | Previous instance running | `aspire stop`, then `aspire start` |
| Resource not found | App not started or name wrong | `aspire ps` to check |
| Build errors in resource | Code error, not Aspire issue | Fix code, `aspire resource <name> restart` |
| Environment issues | Missing SDK or tools | `aspire doctor` to diagnose |
| JSON parse failure from `aspire start` | Mixed human/JSON output ([#15843](https://github.com/microsoft/aspire/issues/15843)) | Strip non-JSON lines before parsing |
| `aspire wait` rejects name | Use `displayName` not `name` ([#15842](https://github.com/microsoft/aspire/issues/15842)) | Use `displayName` from `aspire ps --format Json` |
| `aspire ps` hangs | AppHost on breakpoint ([#15576](https://github.com/microsoft/aspire/issues/15576)) | Use timeout, check AppHost process |
| `aspire agent init` fails | Non-interactive terminal ([#16264](https://github.com/microsoft/aspire/issues/16264)) | Run from standard terminal |
| Docker daemon unavailable | Container-backed resources fail to start | Start Docker Desktop, then `aspire start` |
| Multiple AppHosts detected | Wrong AppHost targeted | Use `--apphost <path>` to specify explicitly |

## Handoff Rules

| Scenario | Route To |
|----------|----------|
| AppHost wiring after `aspire init` (scan repo, add resources, ServiceDefaults/OTel) | → `aspireify` skill ([`../aspireify/SKILL.md`](../aspireify/SKILL.md)) or project-local `.agents/skills/aspireify/SKILL.md` |
| Browser logs (`Aspire.Hosting.Browsers` / `WithBrowserLogs()`) and dashboard authoring | → `aspireify` skill (code edits) and `aspire-monitoring` (discovery) |
| Custom resource commands (`WithCommand`, `ExecuteCommandResult`, `HttpCommandResultMode`) | → `aspireify` skill |
| Lifecycle hooks (`SubscribeBeforeStart`, `SubscribeAfterResourcesCreated`, BeforeStart pipeline phase) | → `aspireify` skill |
| Endpoint authoring (`WithEndpoint` updates, `ExcludeReferenceEndpoint` flag) | → `aspireify` skill |
| Deploy, publish, pipeline steps, `aspire destroy` | → `aspire-deployment` skill |
| Logs, traces, metrics, dashboard, `aspire dashboard run` | → `aspire-monitoring` skill |
| Deployed app diagnostics | → `azure-diagnostics` skill (azure-skills) |

## Environment Variables (Aspire 13.3)

| Variable | Default | Purpose |
|----------|---------|---------|
| `ASPIRE_ENABLE_CONTAINER_TUNNEL` | `true` | Container tunnel is **on by default** in 13.3 — provides uniform host connectivity across Docker Desktop, Docker Engine, and Podman. Set to `false` to opt out. |
| `ASPIRE_ENVIRONMENT` | unset | Selects the environment-specific config profile — controls which `appsettings.{environment}.json` is loaded and which environment is reported in dashboard telemetry. |
| `ASPIRE_DCP_USE_DEVELOPER_CERTIFICATE` | `true` | The Aspire trusted developer certificate is now used by DCP on Windows (replaces the ephemeral cert DCP previously generated). Set to `false` to opt out. |

## TypeScript AppHost Note

Detection covers TS AppHosts (`apphost.ts`), but **all TS AppHost authoring is delegated to `aspireify`**.
Key 13.3 rules to apply when handing off:

| Rule | Why |
|------|-----|
| Prefer unified `withEnvironment(name, value)` over deprecated per-kind helpers (`withEnvironmentEndpoint`, `withEnvironmentParameter`, `withEnvironmentConnectionString`, `withEnvironmentExpression`, `withEnvironmentFromOutput`, `withEnvironmentFromKeyVaultSecret`) | Per-kind helpers are `@deprecated` in 13.3 — single API now handles all value types |
| Never edit `.modules/` directly | Generated; use `aspire add <package>` to regenerate |
| Use `aspire docs api search <query> --language typescript` for API lookup | TS surface differs from C# |

## Skill Routing — In-Plugin Sibling Skills

After `aspire init` drops a skeleton AppHost + `aspire.config.json`, route AppHost wiring
(scan repo → propose resource graph → edit AppHost → wire `Aspire.ServiceDefaults` / OTel →
validate via `aspire start`) to the in-plugin **aspireify** skill: [`../aspireify/SKILL.md`](../aspireify/SKILL.md).
For first-run flows that only need the skeleton drop, see the in-plugin **aspire-init** skill:
[`../aspire-init/SKILL.md`](../aspire-init/SKILL.md). This orchestration skill stays focused
on lifecycle (start/stop/wait/restart) and never edits AppHost code itself.

## Project-Local Skill Precedence

If `.agents/skills/aspire/SKILL.md` exists (from `aspire agent init`), defer to it for:
C# AppHost editing, TS AppHost editing, Playwright handoff, investigation workflows.
Safety guardrails from this plugin ALWAYS apply.

If `.agents/skills/aspireify/SKILL.md` exists project-locally (installed by `aspire init` in
13.3+), **warn the user** that a project-local aspireify skill is present and **defer to it**
for AppHost wiring instead of the in-plugin sibling. Same precedence rule as the project-local
`aspire` skill above: project-local wins, plugin guardrails still apply.

## References

- [safety-guardrails.md](references/safety-guardrails.md) — Detailed rules and recovery patterns
- [detection.md](references/detection.md) — Project fingerprinting
- [app-commands.md](references/app-commands.md) — App lifecycle and bootstrap commands
- [resource-management.md](references/resource-management.md) — Resource wait, restart, and operations
