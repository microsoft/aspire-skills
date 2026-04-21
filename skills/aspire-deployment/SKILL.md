---
name: aspire-deployment
description: >-
  **WORKFLOW SKILL** - Deploy Aspire applications to multiple targets natively.
  Handles publish, deploy, and named pipeline steps without external tooling.
  USE FOR: aspire deploy, aspire publish, aspire do, deploy to Azure, deploy to Kubernetes,
  deploy to Docker Compose, push to production, ship it, go live, deployment pipeline,
  deployment artifacts, clear deployment cache, named pipeline step, seed data step.
  DO NOT USE FOR: local app lifecycle or starting apps (use aspire-orchestration), logs or
  traces or monitoring (use aspire-monitoring), Azure infrastructure without Aspire (use
  azure-prepare), deployed app diagnostics (use azure-diagnostics).
  INVOKES: aspire CLI (publish, deploy, do), aspire-orchestration (for pre-deploy checks).
  FOR SINGLE OPERATIONS: Use aspire CLI directly for simple publish/deploy commands.
license: MIT
metadata:
  author: Microsoft
  version: "1.0.0"
---

# Aspire Deployment

> Aspire handles deployment end-to-end for Azure targets — no `azd`, `azure-prepare`, or `azure-deploy` needed.
> For Kubernetes, Aspire generates manifests natively; cluster apply uses `kubectl`.

## Supported Targets

| Target | Method | External Tool Needed? |
|--------|--------|----------------------|
| Azure Container Apps | `aspire deploy` / `aspire publish` | No |
| Azure App Service | `aspire deploy` / `aspire publish` | No |
| Docker Compose | `aspire publish` | Docker must be running |
| Kubernetes | `aspire publish` → `kubectl apply` | Yes (`kubectl`) |

## Commands

| Command | What It Does |
|---------|-------------|
| `aspire publish` | Generate deployment artifacts for configured targets |
| `aspire deploy` | Full pipeline: generate + apply deployment |
| `aspire do <step>` | Run an individual named pipeline step |
| `aspire do --list-steps` | List available pipeline steps |
| `aspire deploy --clear-cache` | Reset deployment state, full redeploy |
| `aspire do diagnostics` | Evaluate deploy pipeline health for current AppHost |

## Decision Table

| Scenario | Command |
|----------|---------|
| First-time deploy | `aspire deploy` |
| Redeploy after code changes | `aspire deploy` |
| Reset stuck deployment state | `aspire deploy --clear-cache` |
| Generate artifacts only (no deploy) | `aspire publish` |
| Artifacts to specific directory | `aspire publish --output-path ./manifest` |
| Run one pipeline step (e.g., seed data) | `aspire do seed-data` |
| List available pipeline steps | `aspire do --list-steps` |
| Evaluate pipeline before deploy | `aspire do diagnostics` |

## Pre-Deploy Checklist

1. Ensure the app runs locally first: `aspire start` → `aspire wait <resource>` → verify
2. `aspire stop` before deploying
3. Run `aspire deploy` (or `aspire publish` for artifacts only)
4. Docker must be running for container-based targets

## Docs & Secrets (for deployment config)

| Task | Command |
|------|---------|
| Search docs for deployment patterns | `aspire docs search <topic>` |
| Get specific doc page | `aspire docs get <slug>` |
| Set deployment secret | `aspire secret set <key> <value>` |
| List secrets | `aspire secret list` |
| Check CLI config | `aspire config list` |

See [tools-and-config.md](references/tools-and-config.md) for full docs/secrets/config reference.

> **Agent execution**: Append `--non-interactive` to `aspire deploy` and `aspire publish` to prevent prompts.

## Known Deployment Gotchas

| Issue | Workaround |
|-------|-----------|
| Builds Debug config only ([#14540](https://github.com/microsoft/aspire/issues/14540)) | Known limitation — no Release flag yet |
| No selective resource deploy ([#16166](https://github.com/microsoft/aspire/issues/16166)) | Always full redeploy |
| Docker required for container targets | Ensure Docker Desktop is running |
| `aspire publish` not working with Vite apps ([#15621](https://github.com/microsoft/aspire/issues/15621)) | Track issue for fix |

## Error Handling

| Symptom | Cause | Action |
|---------|-------|--------|
| Deploy fails with auth error | Azure credentials expired | Re-authenticate with `az login` |
| Deploy hangs | Stuck cache state | `aspire deploy --clear-cache` |
| Publish generates no artifacts | Targets not configured in AppHost | Check AppHost code for publish targets |

## Handoff Rules

| Scenario | Route To |
|----------|----------|
| Start/stop/wait/rebuild app lifecycle | → `aspire-orchestration` skill |
| Logs, traces, metrics after deploy | → `aspire-monitoring` skill |
| Deployed app diagnostics (App Insights, ACA logs) | → `azure-diagnostics` skill (azure-skills) |

> ⚠️ **NEVER hand off to azure-skills for deployment.** Aspire handles it end-to-end.

## Project-Local Skill Routing

If `.agents/skills/aspire/SKILL.md` exists (from `aspire agent init`), see its
`references/deployment.md` for deeper pipeline and step guidance.

## References

- [deployment.md](references/deployment.md) — Publish, deploy, and pipeline step patterns
- [tools-and-config.md](references/tools-and-config.md) — Docs, secrets, config, diagnostics, certificates
