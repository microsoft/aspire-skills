# Monitoring

Use this when the task is about inspecting app state, logs, traces, endpoints, or sharable diagnostics.

## I Need To Know What Is Running And Where The Endpoints Are

```bash
aspire describe
aspire resources
aspire describe --apphost <path>
aspire describe --apphost <path> --format Json
```

- Use `aspire describe` first when you need current state before deciding what to do next.
- Use `--apphost <path>` when the workspace has multiple AppHosts.
- Prefer `--format Json` when another tool or script needs to consume the result.

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

## Production Monitoring Strategy

Aspire auto-configures Application Insights when `AddAzureApplicationInsights()` is used in the AppHost. Deployed apps export OpenTelemetry to App Insights automatically:

- Request traces and dependency tracking
- Exception logging
- Performance metrics
- Live Metrics stream
- Application Map (service topology)

No additional configuration needed — Aspire wires connection strings during deployment.

## Deployed App Monitoring — Route by Target

| Target | Tool | Commands |
|--------|------|----------|
| Azure Container Apps | azure-diagnostics | `az containerapp logs show`, App Insights |
| Azure App Service | azure-diagnostics | `az webapp log tail`, App Insights |
| Docker Compose | Docker CLI | `docker compose logs <service>` |
| Kubernetes | kubectl | `kubectl logs <pod>`, `kubectl top pods` |
