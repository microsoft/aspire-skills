# Monitoring

Use this when the task is about inspecting app state, logs, traces, endpoints, or sharable diagnostics.

## I Need To Know What Is Running And Where The Endpoints Are

```bash
aspire describe
aspire ps --format Json
aspire describe --apphost <path>
aspire describe --apphost <path> --format Json

# When an expected resource is missing (hidden-by-default in 13.3)
aspire ps --include-hidden --format Json
aspire describe --include-hidden --format Json
```

- Use `aspire describe` first when you need current state before deciding what to do next.
- Use `--apphost <path>` when the workspace has multiple AppHosts.
- Prefer `--format Json` when another tool or script needs to consume the result.
- Add `--include-hidden` when debugging proxies, helper containers, migrations, or when an expected resource is missing from the filtered output.

## Something Is Wrong — Investigate Before Editing Code

```bash
aspire otel logs [resource]
aspire otel traces [resource]
aspire otel spans [resource]
aspire otel logs --trace-id <id>
aspire logs [resource]
```

- Prefer structured telemetry (`aspire otel`) before raw console logs.
- Use `aspire logs` as a secondary console-output view after checking structured telemetry.
- Use trace-filtered logs when you have a trace id and want correlated log entries.

## I Need A Sharable Diagnostics Bundle

```bash
aspire export [resource]
```

- Use `aspire export` for a portable handoff artifact for deeper analysis or offline inspection.

## Production Monitoring Strategy (Azure)

Aspire auto-configures Application Insights when `AddAzureApplicationInsights()` is used in the AppHost. Deployed Azure apps export OpenTelemetry to App Insights automatically:

- Request traces and dependency tracking
- Exception logging
- Performance metrics
- Live Metrics stream
- Application Map (service topology)

No additional configuration needed for Azure — Aspire wires connection strings during deployment.

> **Docker Compose / Kubernetes**: Auto-configured App Insights does not apply. These targets require platform-native observability (Prometheus, Grafana, ELK, etc.) unless the app is explicitly configured to export OTEL to an external collector.

## Deployed App Monitoring — Route by Target

| Target | Tool | Commands |
|--------|------|----------|
| Azure Container Apps / App Service | azure-diagnostics | `az containerapp logs show`, `az webapp log tail`, App Insights |
| Azure resource health (Front Door, NSP, private endpoint, App Insights) | azure-diagnostics | AppLens, `az monitor app-insights query` |
| AKS workload (pods, workloads) | kubectl + Container Insights | `kubectl logs <pod>`, `kubectl describe pod <pod>`, Azure Monitor Container Insights |
| Docker / Compose | Docker CLI | `docker logs <container>`, `docker compose logs <service>` |

## Standalone Dashboard

`aspire dashboard run` launches the Aspire Dashboard with no AppHost — useful for collecting OTLP from any source. The command is **foreground/blocking**; run it as a long-running background process and capture the printed dashboard URL + `t=` token. Connect the CLI with `aspire otel logs --dashboard-url <url> --api-key <token>` (also accepted by `aspire otel traces`).

## Browser Telemetry

Frontend resources opted into `Aspire.Hosting.Browsers` via `WithBrowserLogs()` surface browser console logs, network requests, and screenshots in the dashboard alongside server-side telemetry. Inspecting them is monitoring's job; **adding `WithBrowserLogs()` is AppHost authoring — route to the `aspireify` skill.**
