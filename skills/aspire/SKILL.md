---
name: aspire
description: >-
  **WORKFLOW SKILL** - Detect .NET Aspire projects and enforce safety guardrails for AI agents.
  Prevents file-lock errors, orphaned processes, and incorrect CLI usage.
  USE FOR: Aspire AppHost detected, aspire start, aspire stop, aspire wait, aspire run,
  aspire resource restart, aspire deploy, aspire publish, aspire logs, aspire ps, aspire doctor,
  aspire new, aspire init, aspire add, distributed app orchestration, cloud-native .NET.
  DO NOT USE FOR: non-Aspire .NET projects (use standard dotnet commands), Azure resource
  provisioning without Aspire (use azure-prepare), deployed app diagnostics (use azure-diagnostics),
  creating skills or plugins (use skill-creator).
  INVOKES: aspire CLI commands, azure-diagnostics skill (for deployed apps only).
  FOR SINGLE OPERATIONS: Use aspire CLI directly when project-local skill exists.
license: MIT
metadata:
  author: Microsoft
  version: "1.0.0"
---

# Aspire

> **AUTHORITATIVE GUIDANCE — MANDATORY COMPLIANCE**
>
> This skill is a **safety net** for .NET Aspire projects. It detects Aspire AppHosts, enforces critical guardrails that prevent agent self-harm, bridges local ↔ deployed diagnostics, and recommends `aspire agent init` for comprehensive guidance.

## Quick Reference

| Property | Value |
|----------|-------|
| **Prerequisites** | .NET 10.0 SDK, Aspire CLI (`curl -sSL https://aspire.dev/install.sh \| bash`) |
| **Start app (agents)** | `aspire start` (background mode for agents) |
| **Stop app** | `aspire stop` |
| **Wait for ready** | `aspire wait <resource>` |
| **Check status** | `aspire ps` or `aspire describe` |
| **View logs** | `aspire logs <resource>` |
| **Rebuild resource** | `aspire resource <name> restart` |
| **Deploy** | `aspire deploy` (Azure, Docker Compose, K8s) |
| **Machine-readable** | Append `--format Json` to any command |
| **Run interactively** | `aspire run` (foreground, with dashboard) |
| **Run in background** | `aspire start` (for agents — preferred) |
| **Create new project** | `aspire new aspire-starter` |
| **Add to existing project** | `aspire init` |
| **Add integration** | `aspire add <package>` |
| **Search docs** | `aspire docs search <topic>` |
| **Diagnose environment** | `aspire doctor` |
| **Pipeline step** | `aspire do <step>` |

## Detection

Activate this skill when ANY of these signals are present:

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

> ⚠️ **This is the most important section.** Violating these rules causes file locks, orphaned processes, and user frustration ([#15801](https://github.com/microsoft/aspire/issues/15801)).

| Situation | ✅ ALWAYS Do | ❌ NEVER Do |
|-----------|-------------|------------|
| Start an Aspire app | `aspire start` | `dotnet run` on AppHost |
| Wait for resource ready | `aspire wait <resource>` | `curl` / HTTP polling loops |
| Code changed in a resource | `aspire resource <name> restart` | `dotnet build` against locked files |
| Task complete | `aspire stop` | Leave processes running |
| Check resource status | `aspire describe` / `aspire ps` | Manual process inspection |
| View logs | `aspire logs` or `aspire otel logs` | Manual log file reading |
| Editing unfamiliar AppHost API | `aspire docs search <topic>` first | Guessing API shape |
| Working in git worktree | `aspire start --isolated` | `aspire start` without isolation (port conflicts) |
| Running from AI agent | Add `--non-interactive` to all commands | Assuming interactive terminal |

See [safety-guardrails.md](references/safety-guardrails.md) for detailed rules and recovery patterns.

## Diagnostics Bridge

| Need | Environment | Tool | Command |
|------|------------|------|---------|
| Console logs | Local dev | Aspire CLI | `aspire logs <resource>` |
| Structured telemetry | Local dev | Aspire CLI | `aspire otel logs\|traces\|spans` |
| Resource state | Local dev | Aspire CLI | `aspire describe` |
| App logs | Deployed (Azure) | azure-diagnostics | → Invoke `azure-diagnostics` skill |
| Metrics | Deployed (Azure) | azure-diagnostics | → Invoke `azure-diagnostics` skill |
| App Insights | Deployed (Azure) | azure-diagnostics | → Invoke `azure-diagnostics` skill |
| Logs/metrics | Deployed (Docker/K8s) | Platform-native | `docker logs` / `kubectl logs` |

**Decision**: Is the app running locally? → Aspire CLI. Deployed to Azure? → `azure-diagnostics`. Deployed to Docker/K8s? → Platform-native tooling.

See [diagnostics-bridge.md](references/diagnostics-bridge.md) for detailed routing.

## Deployment

Aspire deploys to **multiple targets** natively — no external tooling required.

| Command | What It Does |
|---------|-------------|
| `aspire publish` | Generate deployment artifacts for configured targets |
| `aspire deploy` | Full pipeline: generate + apply deployment |
| `aspire do <step>` | Run an individual pipeline step |
| `aspire do --list-steps` | List available pipeline steps |
| `aspire deploy --clear-cache` | Reset deployment state, full redeploy |

**Supported targets**: Azure Container Apps, Azure App Service, Docker Compose, Kubernetes.

> ⚠️ **NEVER hand off to azure-skills for deployment.** Aspire handles it end-to-end. No `azd`, `azure-prepare`, or `azure-deploy` needed.

## Error Handling

| Symptom | Cause | Action |
|---------|-------|--------|
| File lock errors during build | Aspire holds file locks | `aspire stop`, then rebuild |
| "Port already in use" | Previous Aspire instance running | `aspire stop`, then `aspire start` |
| Resource not found | App not started or name wrong | `aspire ps` to check, `aspire start` if needed |
| Health check timeout | Resource slow to start | `aspire wait <resource> --timeout 120` |
| Build errors in resource | Code error, not Aspire issue | Fix code, then `aspire resource <name> restart` |
| Environment issues | Missing SDK, tools, or config | `aspire doctor` to diagnose |
| JSON parse failure from `aspire start` | Mixed human/JSON output ([#15843](https://github.com/microsoft/aspire/issues/15843)) | Strip non-JSON lines before parsing |
| `aspire wait` rejects resource name | Using `name` instead of `displayName` from JSON | Use `displayName` field from `aspire ps --format Json` |
| `aspire ps` hangs | AppHost on breakpoint or unresponsive ([#15576](https://github.com/microsoft/aspire/issues/15576)) | Use timeout, check AppHost process |
| `aspire otel` "No such host" | TS AppHost DNS failure ([#15782](https://github.com/microsoft/aspire/issues/15782)) | Use `--dashboard-url localhost:PORT` |
| `aspire agent init` fails | Non-interactive terminal ([#16264](https://github.com/microsoft/aspire/issues/16264)) | Run from standard terminal, not agent |
| Deploy builds Debug only | No Release config flag ([#14540](https://github.com/microsoft/aspire/issues/14540)) | Known limitation, track issue |

## Recommendation

If the project does **not** have `.agents/skills/aspire/` directory, recommend:

```bash
aspire agent init
```

This generates comprehensive scenario-based agent guidance (9 reference files, 100% eval score on 319 assertions from [PR #15745](https://github.com/microsoft/aspire/pull/15745)).

## Handoff Rules

| Scenario | Route To |
|----------|----------|
| Deployed app diagnostics (logs, metrics, App Insights) | `azure-diagnostics` skill (azure-skills plugin) |
| Local development (start, stop, logs, resource restart) | Aspire CLI — handled natively |
| Deployment to Azure | Aspire CLI — `aspire deploy` handles everything |
| Everything else Aspire-related | Aspire CLI — no external handoff needed |

## Project-Local Skill Routing

If `.agents/skills/aspire/SKILL.md` exists in the repo (generated by `aspire agent init`),
**defer to it** for these scenarios — it has richer, scenario-based guidance:

| Scenario | Project-Local Reference |
|----------|------------------------|
| Editing C# AppHost code | `references/csharp-apphosts.md` |
| Editing TypeScript AppHost code | `references/typescript-apphosts.md` |
| Adding integrations (`aspire add`) | `references/app-commands.md` |
| Investigation before code changes | `references/agent-workflows.md` |
| Playwright browser testing | `references/playwright-handoff.md` |
| Docs/API lookup (`aspire docs`) | `references/tools-and-configuration.md` |
| Secrets & config management | `references/tools-and-configuration.md` |
| Deployment pipelines & `aspire do` | `references/deployment.md` |
| Resource wait/restart patterns | `references/resource-management.md` |
| Monitoring/logs/traces | `references/monitoring.md` |

**This plugin provides**: detection, safety guardrails, deployed-diagnostics routing.
**The project-local skill provides**: comprehensive operational guidance.
**Note**: Safety guardrails from this plugin ALWAYS apply, even when project-local skill is present.
