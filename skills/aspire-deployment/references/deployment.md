# Deployment

Use this when the task is about deployment artifacts, deployment execution, or named pipeline steps.

## Regenerate Deployment Artifacts And Redeploy

```bash
aspire publish
aspire deploy
aspire deploy --clear-cache
```

- Use `aspire publish` when artifact generation is part of the request.
- Use `aspire deploy` when the goal is the full deployment flow, not just one step.
- Use `aspire deploy --clear-cache` when cached deployment state is stale or stuck.

## Run One Named Deployment Step

```bash
aspire do seed-data
aspire do push-containers
aspire do diagnostics
aspire do --list-steps
```

- Use `aspire do <step>` when the request is specifically about one named pipeline step.
- Common scenarios: seeding data, running diagnostics, pushing containers — step names are app-defined.
- Do not substitute `aspire deploy` when the request is to rerun only one step.
- Use `aspire do --list-steps` to discover available steps.

### `aspire do diagnostics` — Evaluate Pipeline Health

Use `aspire do diagnostics` to evaluate the steps in the current AppHost's deploy pipeline before executing deployment:

```bash
aspire do diagnostics
```

- This command inspects the AppHost's deployment configuration and reports on the pipeline steps, their order, and any potential issues.
- Use it as a **pre-flight check** before `aspire deploy` to understand what will happen.
- Useful for AI agents to evaluate the deploy pipeline without actually deploying.

## Multi-Target Publishing

Aspire generates deployment artifacts based on how resources are configured in the AppHost:

| Target | How It Works |
|--------|-------------|
| Azure Container Apps | AppHost generates Bicep + deploys via Azure SDK |
| Azure App Service | AppHost generates deployment config |
| Docker Compose | `aspire publish` generates `docker-compose.yml` |
| Kubernetes | `aspire publish` generates manifests → apply with `kubectl` |

The deployment pipeline runs **inside the AppHost** — not via external tools:
1. `aspire publish` invokes the AppHost in publish mode
2. AppHost generates artifacts from resource definitions
3. `aspire deploy` extends this to also apply the deployment

## ⚠️ No External Tooling Required (Azure Targets)

| Myth | Reality |
|------|---------|
| ~~Needs azd~~ | Aspire has its own pipeline |
| ~~Needs azure-prepare skill~~ | AppHost IS the deployment plan |
| ~~Needs Bicep CLI installed~~ | Aspire includes Bicep compiler |
| ~~Needs azure-deploy skill~~ | `aspire deploy` handles everything |

> **Note**: Kubernetes targets require `kubectl` for cluster apply. Docker targets require Docker running locally.
