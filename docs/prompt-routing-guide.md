# Prompt Routing Guide

How user prompts are routed across the 4 aspire-skills. The top-level `aspire` skill catches all Aspire-related prompts and routes to the appropriate sub-skill.

## Routing Flow

```
User prompt
    │
    ▼
┌─────────────────────┐
│  aspire (router)    │  ← Catches any Aspire context
│  Detection:         │
│  • Aspire.AppHost.Sdk│
│  • apphost.ts       │
│  • aspire.config.json│
└────┬───┬───┬───┬────┘
     │   │   │   │
     ▼   │   │   ▼
  orch.  │   │  azure-diagnostics
     │   ▼   │  (external, azure-skills)
     │ deploy │
     │   │   ▼
     │   │  monitoring
     ▼   ▼   ▼
```

## aspire-orchestration

**Owns**: App lifecycle, safety guardrails, project detection, resource management.

| Prompt | Why It Routes Here |
|--------|--------------------|
| "Start my Aspire app" | App lifecycle — `aspire start` |
| "Run the AppHost" | App lifecycle — `aspire start` |
| "Stop the app, I'm done" | Cleanup — `aspire stop` |
| "Wait for the database to come up" | Resource readiness — `aspire wait` |
| "I changed the API code, how do I see my changes?" | Resource restart — `aspire resource restart` |
| "Getting file lock errors on build" | Error recovery — stop Aspire, then rebuild |
| "Port 5000 is already in use" | Orphaned instance — `aspire stop` |
| "Is this an Aspire project?" | Detection — check for AppHost SDK |
| "Create a new Aspire project" | Bootstrap — `aspire new` |
| "Add Redis to my app" | Integration — `aspire add redis` |
| "Add Aspire to my existing app" | Init — `aspire init` |
| "Something is wrong with my environment" | Diagnostics — `aspire doctor` |
| "I'm in a git worktree, how do I start?" | Isolation — `aspire start --isolated` |
| "Restore the generated TypeScript files" | Recovery — `aspire restore` |
| "How do I use WithCommand in my AppHost?" | Docs first — `aspire docs search` |

### Key commands owned

`aspire start`, `aspire stop`, `aspire wait`, `aspire ps`, `aspire resource`, `aspire new`, `aspire init`, `aspire add`, `aspire restore`, `aspire doctor`, `aspire docs search`

---

## aspire-deployment

**Owns**: Publishing, deploying, pipeline steps, deployment config.

| Prompt | Why It Routes Here |
|--------|--------------------|
| "Deploy my app to Azure" | Full deploy — `aspire deploy` |
| "Push to production" | Full deploy — `aspire deploy` |
| "Ship it" | Full deploy — `aspire deploy` |
| "Generate deployment manifests for Kubernetes" | Artifact generation — `aspire publish` |
| "Just re-seed the database, don't redeploy everything" | Named step — `aspire do seed-data` |
| "What pipeline steps are available?" | Discovery — `aspire do --list-steps` |
| "My deployment is stuck" | Recovery — `aspire deploy --clear-cache` |
| "Deploy to Docker Compose" | Multi-target — `aspire publish` |
| "What tools do I need to deploy?" | Education — Aspire handles it natively |
| "Set a deployment secret" | Config — `aspire secret set` |
| "Check my CLI config" | Config — `aspire config list` |
| "My deploy is building in Debug mode" | Known issue — #14540, no Release flag yet |
| "Vite app fails during publish" | Known issue — #15621 |

### Key commands owned

`aspire deploy`, `aspire publish`, `aspire do`, `aspire secret`, `aspire config`

### Anti-patterns (never suggest)

| Wrong | Right |
|-------|-------|
| `azd up` | `aspire deploy` |
| `azd deploy` | `aspire deploy` |
| `azure-prepare` skill | Aspire AppHost IS the deployment plan |
| `azure-deploy` skill | `aspire deploy` handles everything |

---

## aspire-monitoring

**Owns**: Logs, traces, metrics, telemetry, diagnostics bridge (local ↔ deployed).

| Prompt | Why It Routes Here |
|--------|--------------------|
| "Show me the API service logs" | Local logs — `aspire logs apiservice` |
| "What's happening with my app?" | Investigation — `aspire describe` → `aspire otel logs` |
| "Check the distributed traces" | Tracing — `aspire otel traces` |
| "Show me the OpenTelemetry spans" | Spans — `aspire otel spans` |
| "What endpoints are available?" | State — `aspire describe --format Json` |
| "Export diagnostics for the team" | Bundle — `aspire export` |
| "Debug my deployed Azure app" | Bridge → `azure-diagnostics` skill |
| "Check App Insights for errors" | Bridge → `azure-diagnostics` skill |
| "Container app logs for my deployed service" | Bridge → `az containerapp logs show` |
| "Check logs on my Docker Compose deployment" | Bridge → `docker compose logs` |
| "K8s pod is failing, check logs" | Bridge → `kubectl logs` |
| "aspire otel gives 'No such host' error" | Known bug #15782 — TS AppHost DNS |
| "Dashboard OTEL API not working" | Known bug #16236 — `--enable-api` needed |

### Diagnostics bridge routing

```
Is the app local?
├── YES → Aspire CLI (aspire logs, otel, describe, export)
└── NO → Where is it deployed?
    ├── Azure    → azure-diagnostics skill
    ├── Docker   → docker compose logs
    └── K8s      → kubectl logs
```

### Key commands owned

`aspire logs`, `aspire otel logs|traces|spans`, `aspire describe`, `aspire export`

---

## aspire (router)

**Owns**: Detection, safety guardrail summary, sub-skill routing, `aspire agent init` recommendation.

| Prompt | Routes To |
|--------|-----------|
| "Help me with my Aspire app" | Asks clarifying question, then routes |
| "I want better AI support for my Aspire project" | Recommends `aspire agent init` |
| "How do I run my .NET console app?" (no Aspire) | **Does NOT activate** — uses `dotnet run` |
| "Build my React frontend" (no Aspire) | **Does NOT activate** — not Aspire |

---

## Cross-Skill Handoffs

| From | Trigger | To |
|------|---------|-----|
| orchestration | "deploy", "publish" | → deployment |
| orchestration | "logs", "traces", "dashboard" | → monitoring |
| deployment | "start", "stop", "rebuild" | → orchestration |
| deployment | "logs after deploy" | → monitoring |
| monitoring | "restart resource" | → orchestration |
| monitoring | "deployed to Azure" | → azure-diagnostics |
| monitoring | "deployed to Docker/K8s" | → platform-native tools |

## Project-Local Skill Deference

When `.agents/skills/aspire/SKILL.md` exists (from `aspire agent init`), **all sub-skills defer** to the project-local skill for:

| Scenario | Defers To |
|----------|-----------|
| C# AppHost code editing | `references/csharp-apphosts.md` |
| TypeScript AppHost editing | `references/typescript-apphosts.md` |
| Playwright browser testing | `references/playwright-handoff.md` |
| Investigation workflows | `references/agent-workflows.md` |

Safety guardrails from this plugin **always apply** regardless.
