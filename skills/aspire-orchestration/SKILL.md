---
name: aspire-orchestration
description: >-
  **WORKFLOW SKILL** - Manage .NET Aspire AppHost lifecycle: start, stop, wait, restart resources,
  and recover from file-lock errors. Detects Aspire projects automatically.
  USE FOR: aspire start, aspire stop, aspire wait, aspire run, aspire ps, aspire resource restart,
  aspire new, aspire init, aspire add, aspire restore, aspire doctor, AppHost detected, file lock
  error, port conflict, code change rebuild, distributed app orchestration.
  DO NOT USE FOR: deployment or publishing (use aspire-deployment), logs or traces or monitoring
  (use aspire-monitoring), deployed app diagnostics (use azure-diagnostics), non-Aspire .NET
  projects (use standard dotnet commands).
  INVOKES: aspire CLI (start, stop, wait, ps, resource, add, init, new, doctor, restore).
  FOR SINGLE OPERATIONS: Use aspire CLI directly when project-local skill exists.
license: MIT
metadata:
  author: Microsoft
  version: "1.0.0"
---

# Aspire Orchestration

> **MANDATORY COMPLIANCE** — This skill prevents agent self-harm in Aspire projects.
> Violating these rules causes file locks, orphaned processes, and user frustration ([#15801](https://github.com/microsoft/aspire/issues/15801)).

## Prerequisites

| Requirement | Install |
|-------------|---------|
| .NET 10.0 SDK | https://dotnet.microsoft.com/download |
| Aspire CLI | `curl -sSL https://aspire.dev/install.sh \| bash` |

## Detection

Activate when ANY signal is present:

| Signal | How to Detect | Confidence |
|--------|---------------|------------|
| C# AppHost | `.csproj` containing `Aspire.AppHost.Sdk` | ✅ Definitive |
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
| Editing unfamiliar API | `aspire docs search <topic>` first | Guessing API shape |
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
| Check status | `aspire ps` or `aspire describe` |
| Restart one resource | `aspire resource <name> restart` |
| Create new project | `aspire new aspire-starter` |
| Add Aspire to existing | `aspire init` |
| Add integration | `aspire add <package>` |
| Restore generated files | `aspire restore` |
| Diagnose environment | `aspire doctor` |
| Machine-readable output | Append `--format Json` to any command |

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

## Handoff Rules

| Scenario | Route To |
|----------|----------|
| Deploy, publish, pipeline steps | → `aspire-deployment` skill |
| Logs, traces, metrics, monitoring | → `aspire-monitoring` skill |
| Deployed app diagnostics | → `azure-diagnostics` skill (azure-skills) |

## Project-Local Skill Routing

If `.agents/skills/aspire/SKILL.md` exists (from `aspire agent init`), defer to it for:
C# AppHost editing, TS AppHost editing, Playwright handoff, investigation workflows.
Safety guardrails from this plugin ALWAYS apply.

## References

- [safety-guardrails.md](references/safety-guardrails.md) — Detailed rules and recovery patterns
- [detection.md](references/detection.md) — Project fingerprinting
- [app-commands.md](references/app-commands.md) — App lifecycle and bootstrap commands
- [resource-management.md](references/resource-management.md) — Resource wait, restart, and operations
