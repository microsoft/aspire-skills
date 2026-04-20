# Diagnostics Bridge — Local vs Deployed

> **Purpose**: Route diagnostics requests to the correct tool based on where the application is running.

## Decision Flowchart

```
Is the app running locally (via aspire start)?
│
├── YES → Use Aspire CLI
│   ├── Console logs     → aspire logs <resource>
│   ├── Structured logs  → aspire otel logs
│   ├── Traces           → aspire otel traces
│   ├── Spans            → aspire otel spans
│   ├── Resource state   → aspire describe
│   ├── Export telemetry → aspire export
│   └── Filter by trace  → aspire otel logs --trace-id <id> (verify flag exists)
│
└── NO (deployed) → Route by target
    ├── Azure → Use azure-diagnostics skill
    │   ├── App logs          → az containerapp logs show
    │   ├── Metrics           → az monitor metrics list
    │   ├── App Insights      → az monitor app-insights query
    │   └── Resource health   → az resource show / AppLens
    │
    ├── Docker Compose → Use Docker tooling
    │   ├── App logs          → docker compose logs <service>
    │   └── Resource state    → docker compose ps
    │
    └── Kubernetes → Use kubectl
        ├── App logs          → kubectl logs <pod>
        ├── Resource state    → kubectl get pods
        └── Metrics           → kubectl top pods
```

---

## Local Development — Full Aspire CLI Support

When the app is running locally via `aspire start`, the Aspire CLI provides complete observability:

### How It Works

The Aspire CLI communicates with the running AppHost through a **backchannel socket** at `~/.aspire/backchannels/`. This is a local-only IPC mechanism — it cannot connect to remote instances.

### Available Commands

| Command | Purpose | Example |
|---------|---------|---------|
| `aspire logs <resource>` | Console stdout/stderr from a resource | `aspire logs apiservice` |
| `aspire logs --follow` | Stream logs in real-time | `aspire logs apiservice --follow` |
| `aspire otel logs` | Structured OpenTelemetry log records | `aspire otel logs` |
| `aspire otel traces` | Distributed trace data | `aspire otel traces` |
| `aspire otel spans` | Individual span-level detail | `aspire otel spans` |
| `aspire otel logs --trace-id <id>` | Logs correlated to a specific trace (⚠️ verify flag in your version) | `aspire otel logs --trace-id abc123` |
| `aspire describe` | Resource state, endpoints, health | `aspire describe --format Json` |
| `aspire export` | Export portable telemetry bundle | `aspire export` |

### Tips for Agents

```bash
# ✅ Always use --format Json for machine parsing
aspire describe --format Json

# ✅ Get endpoints from describe, not guessing ports
ENDPOINT=$(aspire describe apiservice --format Json | jq -r '.endpoints[0].url')

# ✅ Correlate logs to a specific request
aspire otel logs --trace-id <trace-id-from-otel-traces>
```

---

## Deployed Applications — azure-diagnostics Bridge

### Why Aspire CLI Cannot Help

The Aspire CLI's diagnostics commands (`aspire logs`, `aspire describe`) use the local backchannel socket at `~/.aspire/backchannels/`. This is **by design** — there is no remote connection capability. When an app is deployed to Azure, the Aspire CLI has no way to reach it.

### Exception: `--dashboard-url`

If the Aspire Dashboard is deployed alongside the app, some `aspire otel` commands can query it remotely:

```bash
# Limited remote support via deployed Dashboard
aspire otel logs --dashboard-url https://my-dashboard.azurecontainerapps.io
aspire otel traces --dashboard-url https://my-dashboard.azurecontainerapps.io
```

> ⚠️ The `--dashboard-url` flag may not be available in all versions. Verify with `aspire otel --help` before using.

> ⚠️ This requires the Dashboard to be deployed and accessible. It does NOT work for `aspire logs` or `aspire describe`.

### Route to azure-diagnostics

For deployed applications, invoke the `azure-diagnostics` skill from the azure-skills plugin:

| Need | azure-diagnostics Approach |
|------|---------------------------|
| Application logs | `az containerapp logs show --name APP -g RG --follow` |
| Metrics | `az monitor metrics list --resource RESOURCE_ID` |
| App Insights queries | `az monitor app-insights query --analytics-query "KQL"` |
| Resource health | AppLens MCP tool or `az resource show` |
| Activity log | `az monitor activity-log list -g RG` |

### Production Telemetry — Automatic Configuration

Aspire auto-configures Application Insights when `AddAzureApplicationInsights()` is used in the AppHost. Deployed apps export OpenTelemetry data to App Insights automatically, providing:

- Request traces and dependency tracking
- Exception logging
- Performance metrics
- Live Metrics stream
- Application Map (service topology)

No additional configuration is needed — Aspire wires the connection string during deployment.

## Known Diagnostics Issues

| Issue | Symptom | Workaround |
|-------|---------|-----------|
| TS AppHost DNS failure ([#15782](https://github.com/microsoft/aspire/issues/15782)) | `aspire otel` returns "No such host" for `*.dev.localhost` | Use `--dashboard-url localhost:PORT` directly |
| Standalone dashboard ([#16236](https://github.com/microsoft/aspire/issues/16236)) | `aspire otel` fails without `--enable-api` on dashboard | ⚠️ Verify `aspire dashboard` command exists in your version — may require manual dashboard config |
| `--isolated` mode telemetry ([#16107](https://github.com/microsoft/aspire/issues/16107)) | OTEL port not randomized in isolated mode | Avoid `--isolated` if telemetry is needed |

---

## Summary: Where to Look

| Question | Local Dev | Deployed |
|----------|-----------|----------|
| "What's the status of my resources?" | `aspire describe` | Azure Portal / `az containerapp show` |
| "Show me the logs" | `aspire logs <resource>` | `az containerapp logs show` |
| "Show me distributed traces" | `aspire otel traces` | App Insights → Transaction Search |
| "Why is this resource unhealthy?" | `aspire describe` + `aspire logs` | AppLens / azure-diagnostics |
| "What metrics are available?" | Aspire Dashboard (auto-launched) | Azure Monitor / App Insights |
| "Export telemetry for analysis" | `aspire export` | App Insights export / KQL query |
