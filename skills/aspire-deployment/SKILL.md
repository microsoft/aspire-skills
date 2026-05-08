---
name: aspire-deployment
description: >-
  **WORKFLOW SKILL** - Deploy and tear down Aspire 13.3 apps natively across Azure, Kubernetes
  (Helm), and Docker Compose — no azd, kubectl, or Bicep CLI required.
  USE FOR: aspire deploy, aspire publish, aspire destroy, aspire do, deploy to Azure, deploy to
  AKS, deploy to Kubernetes, deploy to Docker Compose, tear down deployment, named pipeline step,
  JavaScript publish, Next.js deploy, Azure Front Door, AKS hosting, AddPromptAgent.
  DO NOT USE FOR: local app lifecycle (use aspire-orchestration), logs or traces or monitoring
  (use aspire-monitoring), Azure infrastructure without Aspire (use azure-prepare), deployed app
  diagnostics (use azure-diagnostics).
  INVOKES: aspire CLI (publish, deploy, destroy, do), aspire-orchestration (for pre-deploy checks).
  FOR SINGLE OPERATIONS: Use aspire CLI directly for simple publish/deploy/destroy commands.
license: MIT
metadata:
  author: Microsoft
  version: "1.1.0"
---

# Aspire Deployment

> Aspire handles deployment end-to-end for Azure, Kubernetes, and Docker Compose targets — no
> `azd`, `azure-prepare`, `azure-deploy`, `kubectl apply`, `helm install`, or Bicep CLI needed.
> Users still need cluster/cloud credentials; Aspire just stops you from invoking those tools by hand.

> ⚠️ **13.3 breaking change**: `--log-level` was renamed to `--pipeline-log-level` on
> `aspire publish` / `aspire deploy`. Update CI snippets accordingly.

## Supported Targets

| Target | Method | External Tool Needed? |
|--------|--------|----------------------|
| Azure Container Apps | `aspire deploy` / `aspire publish` | No (just `az login` credentials) |
| Azure App Service | `aspire deploy` / `aspire publish` | No (auto HTTPS upgrade in 13.3) |
| Azure Kubernetes Service (AKS) | `aspire deploy` (Bicep + Helm pipeline) | No (just `az login` credentials) |
| Kubernetes (any cluster) | `aspire deploy` (Helm-based, **preview**) | No — cluster credentials only |
| Docker Compose | `aspire publish` / `aspire deploy` | Docker or Podman runtime |

## Commands

| Command | What It Does |
|---------|-------------|
| `aspire publish` | Generate deployment artifacts for configured targets |
| `aspire deploy` | Full pipeline: generate + apply deployment (runs `check-container-runtime` first) |
| `aspire destroy` | Tear down provisioned resources across Azure / K8s / Compose |
| `aspire do <step>` | Run an individual named pipeline step |
| `aspire do --list-steps` | List pipeline steps for `do` / `publish` / `deploy` / `destroy` without executing |
| `aspire deploy --clear-cache` | Reset deployment state, full redeploy |
| `aspire do diagnostics` | Evaluate deploy pipeline health for current AppHost |
| `aspire deploy --pipeline-log-level <level>` | Verbose pipeline logs (renamed from `--log-level` in 13.3) |

> Each `do` / `publish` / `deploy` / `destroy` run prints a **pipeline step summary** at the end
> (✓/✗ per step, duration, total). Independent steps continue on sibling failure in 13.3.

## Decision Table

| Scenario | Command |
|----------|---------|
| First-time deploy | `aspire deploy` |
| Redeploy after code changes | `aspire deploy` |
| Reset stuck deployment state | `aspire deploy --clear-cache` |
| Tear down everything Aspire deployed | `aspire destroy` |
| Generate artifacts only (no deploy) | `aspire publish` |
| Artifacts to specific directory | `aspire publish --output-path ./manifest` |
| Deploy to AKS | Declare `AddAzureKubernetesEnvironment(...)` + `WithComputeEnvironment(...)`, then `aspire deploy` |
| Deploy to a non-Azure K8s cluster | Declare `AddKubernetesEnvironment(...)` + `WithComputeEnvironment(...)`, then `aspire deploy` |
| Run one pipeline step (e.g., seed data) | `aspire do seed-data` |
| List available pipeline steps | `aspire do --list-steps` |
| Evaluate pipeline before deploy | `aspire do diagnostics` |
| Verbose pipeline output | `aspire deploy --pipeline-log-level debug` |

## Pre-Deploy Checklist

1. Ensure the app runs locally first: `aspire start` → `aspire wait <resource>` → verify
2. `aspire stop` before deploying
3. Run `aspire deploy` (or `aspire publish` for artifacts only)
4. Docker must be running for container-based targets

## JavaScript and Node.js Publishing (13.3)

A unified `PublishAs*` family replaces hand-rolled Dockerfile plumbing for JS/TS apps:

| API | Use For | Notes |
|-----|---------|-------|
| `PublishAsStaticWebsite` (preview) | SPAs (Vite, plain Next.js export) | YARP-served static; optional `apiPath` + `apiTarget` reverse-proxy to backend |
| `PublishAsNodeServer` | Pre-bundled Node entry-point (e.g., `server.js`) | No `node_modules` copied at runtime — slim runtime container |
| `PublishAsNpmScript` | Full Nitro Next.js, Remix, Astro SSR | Runs an npm `start`/`serve` script with prod deps |
| `AddNextJsApp(name, path)` | First-class Next.js | Auto-configures standalone publishing — set `output: "standalone"` in `next.config.js` |
| `AddViteApp(name, path)` | Vite dev server | Pair with `PublishAsStaticWebsite` for SPA, or `PublishAsNodeServer` for SSR (TanStack Start, SvelteKit) |

TypeScript AppHosts now have first-class **Bun, Yarn, and pnpm** support (npm remains default).
TS AppHosts can also build Dockerfiles programmatically via `WithDockerfileBuilder` /
`AddDockerfileBuilder` — covered by experimental diagnostic
[`ASPIREDOCKERFILEBUILDER001`](https://aspire.dev/diagnostics/aspiredockerfilebuilder001/).

## Azure 13.3 Integrations

| Integration | API | What It Does |
|-------------|-----|--------------|
| Azure Front Door | `AddAzureFrontDoor("frontdoor").WithOrigin(api).WithOrigin(web)` | Provisions Front Door (Standard SKU default); each `WithOrigin` creates its own endpoint, origin group, route, `*.azurefd.net` host |
| Network Security Perimeter | `AddNetworkSecurityPerimeter("nsp").WithAccessRule(...)` then `.WithNetworkSecurityPerimeter(nsp)` on resources | PaaS-layer boundary; Enforced (block) / Learning (log-only) modes |
| Azure Kubernetes Service | `AddAzureKubernetesEnvironment("aks").WithSystemNodePool(vmSize, minCount, maxCount)` | First-class AKS; control-plane defaults to **Free** SKU (`AksSkuTier` enum REMOVED) |
| Foundry Prompt Agent | `AddPromptAgent(...)` | Replaces non-functional `AddAndPublishPromptAgent` (REMOVED) |
| Private endpoints | `.WithPrivateEndpoint()` on ACR / Azure OpenAI / Foundry | Resource reachable over VNet without public exposure |
| App Service HTTPS | Automatic | Endpoints deployed to App Service auto-upgrade HTTP→HTTPS |
| Credential timeout | `Azure:CredentialProcessTimeoutSeconds` config | Tune timeout for slow auth round-trips |
| Multi-environment binding | `.WithComputeEnvironment(env)` per resource (REQUIRED) | Prevents accidental cross-environment leakage |

Deployment summaries now print **clickable Azure Portal links** for each provisioned resource.

## Docker Compose (13.3)

- **Podman** is supported out of the box — Aspire detects Podman and generates `podman-compose`-compatible files.
- **Privileged containers**: `PublishAsDockerComposeService((resource, service) => service.Privileged = true)` for low-level networking utilities or nested containers.

## Docs & Secrets (for deployment config)

| Task | Command |
|------|---------|
| Search docs for deployment patterns | `aspire docs search <topic>` |
| Get specific doc page | `aspire docs get <slug>` |
| Set deployment secret | `aspire secret set <key> <value>` |
| List secrets | `aspire secret list` |
| Check CLI config | `aspire config list` |

See [tools-and-config.md](references/tools-and-config.md) for full docs/secrets/config reference.

> **Agent execution**: Append `--non-interactive` to `aspire deploy`, `aspire publish`, and
> `aspire destroy` to prevent prompts.

## Known Deployment Gotchas

| Issue | Workaround |
|-------|-----------|
| Builds Debug config only ([#14540](https://github.com/microsoft/aspire/issues/14540)) | Known limitation — no Release flag yet |
| No selective resource deploy ([#16166](https://github.com/microsoft/aspire/issues/16166)) | Always full redeploy |
| Docker / Podman required for container targets | `check-container-runtime` step fails fast in 13.3; start runtime, retry |
| Vite publish quirks ([#15621](https://github.com/microsoft/aspire/issues/15621)) | For new Vite deployments, prefer `PublishAsStaticWebsite`; #15621 may still apply to legacy Vite publish paths |

## Error Handling

| Symptom | Cause | Action |
|---------|-------|--------|
| Deploy fails with auth error | Azure credentials expired | Re-authenticate with `az login` |
| Deploy hangs | Stuck cache state | `aspire deploy --clear-cache` |
| Publish generates no artifacts | Targets not configured in AppHost | Check AppHost code for publish targets |
| `check-container-runtime` step fails | No Docker / Podman available | Start container runtime, retry |
| Resource not torn down by `aspire destroy` | Resource missing `WithComputeEnvironment` binding | Add binding, redeploy, retry destroy |
| `AddAndPublishPromptAgent` not found | Removed in 13.3 | Replace with `AddPromptAgent` |
| `AksSkuTier` not found | Enum removed in 13.3 | Delete reference; control-plane defaults to Free |
| `--log-level` rejected | Renamed in 13.3 | Use `--pipeline-log-level` |

## Handoff Rules

| Scenario | Route To |
|----------|----------|
| Start/stop/wait/rebuild app lifecycle | → `aspire-orchestration` skill |
| Logs, traces, metrics after deploy | → `aspire-monitoring` skill |
| AppHost authoring (adding `AddAzureFrontDoor`, `WithBrowserLogs`, etc.) | → `aspireify` skill |
| Deployed app diagnostics (App Insights, ACA logs, AKS Container Insights) | → `azure-diagnostics` skill (azure-skills) |

> ⚠️ **NEVER hand off to azure-skills for deployment.** Aspire handles it end-to-end.

## Project-Local Skill Routing

If `.agents/skills/aspire/SKILL.md` exists (from `aspire agent init`), see its
`references/deployment.md` for deeper pipeline and step guidance.

## References

- [deployment.md](references/deployment.md) — Publish, deploy, destroy, JS publishing, K8s/AKS, pipeline steps
- [tools-and-config.md](references/tools-and-config.md) — Docs, secrets, config, diagnostics, certificates
