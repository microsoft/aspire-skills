---
name: aspire-monitoring
description: >-
  **ANALYSIS SKILL** - Observe .NET Aspire applications: logs, traces, metrics, resource state,
  and telemetry export. Routes between local Aspire CLI diagnostics and deployed-app monitoring.
  USE FOR: aspire logs, aspire otel logs, aspire otel traces, aspire otel spans, aspire describe,
  aspire export, aspire resources, dashboard, App Insights query, deployed app logs, production
  monitoring, telemetry, distributed traces, resource health, container app logs.
  DO NOT USE FOR: starting or stopping apps (use aspire-orchestration), deployment or publishing
  (use aspire-deployment), Azure infrastructure provisioning (use azure-prepare), non-Aspire
  .NET projects (use standard dotnet commands).
  INVOKES: aspire CLI (logs, otel, describe, export), azure-diagnostics skill (for deployed apps).
  FOR SINGLE OPERATIONS: Use aspire CLI directly for quick log or describe lookups.
license: MIT
metadata:
  author: Microsoft
  version: "1.0.0"
---

# Aspire Monitoring

> Aspire CLI provides full observability **locally**. For deployed apps, route to platform-specific tools.

## Diagnostics Bridge — Where To Look

| Need | Environment | Tool | Command |
|------|------------|------|---------|
| Console logs | Local dev | Aspire CLI | `aspire logs <resource>` |
| Structured logs | Local dev | Aspire CLI | `aspire otel logs [resource]` |
| Distributed traces | Local dev | Aspire CLI | `aspire otel traces [resource]` |
| Span detail | Local dev | Aspire CLI | `aspire otel spans [resource]` |
| Resource state | Local dev | Aspire CLI | `aspire describe` |
| Telemetry export | Local dev | Aspire CLI | `aspire export [resource]` |
| App logs | Deployed (Azure) | azure-diagnostics | → `azure-diagnostics` skill |
| Metrics | Deployed (Azure) | azure-diagnostics | → `azure-diagnostics` skill |
| App Insights | Deployed (Azure) | azure-diagnostics | → `azure-diagnostics` skill |
| Logs/metrics | Deployed (Docker/K8s) | Platform-native | `docker logs` / `kubectl logs` |

**Decision**: Local? → Aspire CLI. Deployed to Azure? → `azure-diagnostics`. Docker/K8s? → Platform-native.

See [diagnostics-bridge.md](references/diagnostics-bridge.md) for detailed routing.

## Investigation Workflow

When something is wrong, investigate before editing code:

1. `aspire describe` — check resource state and endpoints
2. `aspire otel logs <resource>` — structured logs first
3. `aspire logs <resource>` — console output as secondary view
4. `aspire otel traces <resource>` — cross-service activity
5. `aspire export` — zipped telemetry snapshot for deeper analysis

## Local Commands Reference

| Command | Purpose | Example |
|---------|---------|---------|
| `aspire logs <resource>` | Console stdout/stderr | `aspire logs apiservice` |
| `aspire logs --follow` | Stream logs in real-time | `aspire logs apiservice --follow` |
| `aspire otel logs` | Structured OpenTelemetry logs | `aspire otel logs` |
| `aspire otel traces` | Distributed trace data | `aspire otel traces` |
| `aspire otel spans` | Individual span detail | `aspire otel spans` |
| `aspire otel logs --trace-id <id>` | Logs correlated to trace (⚠️ verify flag) | `aspire otel logs --trace-id abc123` |
| `aspire describe` | Resource state, endpoints, health | `aspire describe --format Json` |
| `aspire resources` | Resource list | `aspire resources` |
| `aspire export` | Portable telemetry bundle | `aspire export` |

### Tips for Agents

```bash
# ✅ Always use --format Json for machine parsing
aspire describe --format Json

# ✅ Get endpoints from describe, not guessing ports
ENDPOINT=$(aspire describe apiservice --format Json | jq -r '.endpoints[0].url')

# ✅ Use --apphost <path> when multiple AppHosts exist
aspire describe --apphost ./src/MyApp.AppHost/
```

## Known Diagnostics Issues

| Issue | Symptom | Workaround |
|-------|---------|-----------|
| TS AppHost DNS failure ([#15782](https://github.com/microsoft/aspire/issues/15782)) | `aspire otel` "No such host" for `*.dev.localhost` | Use `--dashboard-url localhost:PORT` |
| Standalone dashboard ([#16236](https://github.com/microsoft/aspire/issues/16236)) | `aspire otel` fails without `--enable-api` | Start dashboard with `aspire dashboard run --enable-api` |
| `--isolated` mode telemetry ([#16107](https://github.com/microsoft/aspire/issues/16107)) | OTEL port not randomized in isolated mode | Avoid `--isolated` if telemetry is needed |

## Why Aspire CLI Can't Do Remote Diagnostics

The Aspire CLI uses a local backchannel socket at `~/.aspire/backchannels/`. This is **by design** — no remote connection capability. For deployed apps, always route to platform-specific tools.

**Exception**: If the Aspire Dashboard is deployed alongside the app, limited `aspire otel` commands can query it via `--dashboard-url`:

```bash
aspire otel logs --dashboard-url https://my-dashboard.azurecontainerapps.io
```

> ⚠️ `--dashboard-url` may not be available in all versions. Verify with `aspire otel --help`.

## Handoff Rules

| Scenario | Route To |
|----------|----------|
| Start/stop/wait/rebuild lifecycle | → `aspire-orchestration` skill |
| Deploy, publish, pipeline steps | → `aspire-deployment` skill |
| Deployed Azure app (App Insights, ACA logs) | → `azure-diagnostics` skill (azure-skills) |

## Project-Local Skill Routing

If `.agents/skills/aspire/SKILL.md` exists (from `aspire agent init`), see its
`references/monitoring.md` for deeper telemetry workflow guidance.

## References

- [diagnostics-bridge.md](references/diagnostics-bridge.md) — Local vs deployed routing detail
- [monitoring.md](references/monitoring.md) — Telemetry inspection and export patterns
