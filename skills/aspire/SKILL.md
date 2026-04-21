---
name: aspire
description: >-
  **WORKFLOW SKILL** - Top-level router for Aspire distributed applications. Detects Aspire
  projects, enforces safety guardrails, and routes to the correct sub-skill.
  USE FOR: Aspire AppHost detected, aspire CLI, distributed app, cloud-native .NET, AppHost
  project, aspire start, aspire deploy, aspire logs, aspire otel, aspire init, aspire new,
  aspire add, aspire wait, aspire describe, aspire ps, aspire doctor.
  DO NOT USE FOR: non-Aspire .NET projects (use standard dotnet commands), Azure resource
  provisioning without Aspire (use azure-prepare), container-only repos with no AppHost.
  INVOKES: aspire-orchestration, aspire-deployment, aspire-monitoring skills.
  FOR SINGLE OPERATIONS: Route directly to the appropriate sub-skill.
license: MIT
metadata:
  author: Microsoft
  version: "2.0.0"
---

# Aspire

Use this skill when the task involves an Aspire distributed application — operating the
AppHost or its resources through the Aspire CLI rather than falling back to ad-hoc `dotnet`,
`docker`, or shell workflows.

## Detection

Activate when ANY signal is present:

| Signal | How to Detect | Confidence |
|--------|---------------|------------|
| C# AppHost | `.csproj` containing `Aspire.AppHost.Sdk` | ✅ Definitive |
| File-based C# AppHost | `apphost.cs` with `#:sdk Aspire.AppHost.Sdk` | ✅ Definitive |
| TypeScript AppHost | `apphost.ts` file in project | ✅ Definitive |
| Aspire config | `aspire.config.json` in project root | High |
| Aspire settings | `.aspire/` directory present | High |
| Modules directory | `.modules/` directory present | High |
| Service defaults | `Aspire.ServiceDefaults` in project references | Medium |

## Default Workflow

1. Confirm workspace is Aspire — identify the AppHost
2. `aspire start` (or `aspire start --isolated` in worktrees)
3. `aspire wait <resource>` before interacting with any resource
4. Inspect state with `aspire describe`, then work
5. `aspire resource <name> restart` after code changes (never `dotnet build`)
6. `aspire stop` when task is complete — **always clean up**

## Key Rules

- **Always** `aspire start`, **never** `dotnet run` on AppHosts
- **Always** `aspire wait <resource>`, **never** manual HTTP polling
- **Always** `aspire resource <name> restart`, **never** `dotnet build` while Aspire is running
- **Always** `aspire stop` when done — leaving Aspire running causes file locks and port conflicts
- **Always** `aspire docs search <topic>` before editing unfamiliar AppHost APIs
- **Always** `aspire docs api search <query> --language csharp|typescript` for API reference before editing AppHost code
- **Always** `--non-interactive` for agent execution
- **Never** install the obsolete Aspire workload
- **Never** edit `.modules/` directly in TypeScript AppHosts

## Routing

| Task | Route To |
|------|----------|
| Start, stop, wait, restart, rebuild | → [aspire-orchestration](../aspire-orchestration/SKILL.md) |
| Initialize Aspire in existing project | → [aspire-orchestration](../aspire-orchestration/SKILL.md) (+ aspire-init skill if available) |
| Deploy, publish, pipeline steps | → [aspire-deployment](../aspire-deployment/SKILL.md) |
| Logs, traces, metrics, diagnostics | → [aspire-monitoring](../aspire-monitoring/SKILL.md) |
| Deployed app monitoring (Azure) | → `azure-diagnostics` skill (azure-skills plugin) |

## Sub-Skills

### aspire-orchestration
Lifecycle management: start, stop, wait, restart resources, detect projects, recover from file
locks. Safety guardrails that prevent agent self-harm.
Includes `aspire init` workflow guidance and routes to project-local aspire-init skill for
comprehensive initialization of existing projects.

### aspire-deployment
Multi-target deployment: `aspire deploy`, `aspire publish`, `aspire do <step>`.
Targets: Azure Container Apps, App Service, Docker Compose, Kubernetes.

### aspire-monitoring
Observability: `aspire logs`, `aspire otel`, `aspire describe`, `aspire export`.
Routes between local Aspire CLI diagnostics and deployed-app platform tools.

## Project-Local Skill

If `.agents/skills/aspire/SKILL.md` exists (from `aspire agent init`), the project-local
skill provides deeper, project-specific guidance for C# AppHost editing, TS AppHost patterns,
Playwright handoff, and investigation workflows. **These safety guardrails always apply.**

## Prerequisites

| Requirement | Install |
|-------------|---------|
| .NET 10.0 SDK | https://dotnet.microsoft.com/download |
| Aspire CLI | `curl -sSL https://aspire.dev/install.sh \| bash` |
