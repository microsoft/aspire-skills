---
name: aspireify
description: >-
  **WORKFLOW SKILL** - Agentic AppHost wiring after `aspire init` drops a skeleton.
  Scans repo, proposes a resource graph, edits the AppHost (C#, file-based C#, or
  TypeScript), wires `Aspire.ServiceDefaults` + OTel, validates with `aspire start`,
  self-deactivates.
  USE FOR: wire AppHost, scaffold resource graph, add Postgres/Redis/Rabbit/Mongo
  to Aspire, connect frontend to API, after `aspire init` what next, `WithBrowserLogs`,
  `AddNextJsApp`, `AddViteApp`, file-based `apphost.cs`, `apphost.ts`, unified
  `withEnvironment`.
  DO NOT USE FOR: skeleton drop (use aspire-init), start/stop/wait/restart (use
  aspire-orchestration), publish/deploy/destroy (use aspire-deployment),
  logs/traces/dashboard (use aspire-monitoring).
  INVOKES: aspire CLI (`add`, `start`, `wait`, `describe`, `docs api search`,
  `stop`); AppHost source edits; ServiceDefaults wiring.
  FOR SINGLE OPERATIONS: Use `aspire add PACKAGE` directly for one-off integration
  installs.
license: MIT
metadata:
  author: Microsoft
  version: "1.0.0"
---

# Aspireify

> **One-time wiring skill.** `aspire init` drops a skeleton; `aspireify` turns
> that skeleton into a working AppHost by scanning the repo, proposing a resource
> graph, editing the AppHost, wiring `Aspire.ServiceDefaults`, and validating end
> to end. Self-deactivates after a clean `aspire start`. Aligned with Aspire 13.3
> ([release notes](https://aspire.dev/whats-new/aspire-13-3/)).

## Project-Local Override

If `.agents/skills/aspireify/SKILL.md` exists (installed by `aspire init` or
`aspire agent init --skills aspireify`), **warn the user** that a project-local
copy is present and **defer to it**. The plugin version is the fallback.

```
⚠️ Project-local .agents/skills/aspireify/SKILL.md detected — deferring to it.
```

## Prerequisites

| Requirement | Install |
|-------------|---------|
| .NET 10.0 SDK (C# AppHost) | https://dotnet.microsoft.com/download |
| Node.js 20+ (TS AppHost) | https://nodejs.org |
| Aspire CLI | `curl -sSL https://aspire.dev/install.sh \| bash` or `dotnet tool install -g Aspire.Cli` |
| Skeleton already dropped | `aspire init` produced `aspire.config.json` + AppHost stub |

## Detection — When to Activate

Activate when ANY signal is present **AND** the AppHost is unwired (no resources
declared beyond the stub):

| Signal | How to Detect | Confidence |
|--------|---------------|------------|
| Skeleton just dropped | `aspire init` just ran in this session | ✅ Definitive |
| Empty AppHost stub | `apphost.cs` / `Program.cs` / `apphost.ts` only contains `Build().Run()` | ✅ Definitive |
| `aspire.config.json` without resources | Config present, AppHost has no `AddProject`/`addProject` | High |
| User asks to "wire" / "scaffold resource graph" | Verb match: wire, scaffold, integrate, hook up, add Postgres/Redis/etc. | High |
| User asks "what next after aspire init" | Direct handoff request | ✅ Definitive |
| Existing repo with services + new AppHost | Repo has `.csproj`/`package.json` projects but AppHost references none | High |

If the AppHost already has wired resources and the user wants to **start/stop**
the app → `aspire-orchestration`. If the user wants to **deploy** → `aspire-deployment`.

## Language Support

| AppHost Style | Detection | Edit Target |
|---------------|-----------|-------------|
| **C# SDK-style** | `.csproj` containing `<Sdk Name="Aspire.AppHost.Sdk" />` | `Program.cs` (top-level statements) |
| **File-based C#** | `apphost.cs` with `#:sdk Aspire.AppHost.Sdk` and `#:package` directives | `apphost.cs` itself |
| **TypeScript** | `apphost.ts` next to `.modules/` directory | `apphost.ts` only — **never edit `.modules/`** |

See [references/csharp-authoring.md](references/csharp-authoring.md) and
[references/typescript-authoring.md](references/typescript-authoring.md).

## Workflow Phases

```
1. SCAN     → discover projects, services, dependencies, integration candidates
2. PROPOSE  → resource graph + integration list, confirm with user
3. EDIT     → wire AppHost, add ServiceDefaults + OTel + health checks
4. VALIDATE → aspire start --non-interactive → aspire wait <each resource>
5. DEACTIVATE → confirm clean start, hand off to aspire-orchestration
```

### 1. Scan

Walk the repo and inventory:

| What | How |
|------|-----|
| .NET projects | `find . -name '*.csproj' -not -path '*/bin/*' -not -path '*/obj/*'` |
| Node services | `find . -name 'package.json' -not -path '*/node_modules/*'` |
| Python services | `find . -name 'pyproject.toml' -o -name 'requirements.txt'` |
| Container deps in compose | `docker-compose.yml`, `compose.yaml` (Postgres? Redis? Rabbit?) |
| Connection strings | grep `appsettings*.json`, `.env*`, `config/*` for `Postgres`, `Redis`, `Mongo`, `RabbitMQ`, `Cosmos`, `ServiceBus` |
| Integration packages | `dotnet list package` per project; package.json `dependencies` |
| Existing endpoints | hardcoded ports in `launchSettings.json`, `next.config.js`, `vite.config.ts` |

Full heuristics in [references/scan-and-propose.md](references/scan-and-propose.md).

### 2. Propose

Present a resource graph **before editing**. Ask clarifying questions:

- "I see Postgres in `docker-compose.yml` — should I model it as `AddPostgres('db')` or use Azure Database for PostgreSQL?"
- "Your React app hardcodes `http://localhost:5000` — replace with Aspire service discovery (`endpoint.url`)?"
- "Your API has an `/admin` endpoint — exclude it from `WithReference()` so consumers don't see it?"

### 3. Edit

Apply the proposed graph. Use the right authoring style for the AppHost language.

### 4. Validate

```bash
aspire start --non-interactive --format Json
aspire wait <resource>          # repeat for each declared resource
aspire describe --format Json   # sanity check graph
```

Full validation flow + recovery in [references/validation.md](references/validation.md).

### 5. Self-Deactivate

After a clean `aspire start`, announce:

```
✅ AppHost wired and validated. Handing off to aspire-orchestration for
   day-to-day start/stop/wait. Aspireify is done.
```

## Integration Discovery Catalog

Map detected services → Aspire integrations. See
[references/scan-and-propose.md](references/scan-and-propose.md) for the full
catalog.

| Detected | C# | TS |
|----------|----|----|
| Postgres in compose / `Npgsql` package | `AddPostgres("pg").AddDatabase("db")` | `addPostgres('pg').addDatabase('db')` |
| Redis in compose / `StackExchange.Redis` | `AddRedis("cache")` | `addRedis('cache')` |
| RabbitMQ | `AddRabbitMQ("mq")` (v7 client w/ pub-sub tracing) | `addRabbitMQ('mq')` |
| MongoDB | `AddMongoDB("mongo")` | `addMongoDB('mongo')` |
| Cosmos DB | `AddAzureCosmosDB("cosmos")` | `addAzureCosmosDB('cosmos')` |
| Azure Service Bus | `AddAzureServiceBus("sb")` | `addAzureServiceBus('sb')` |
| Azure Cache for Redis (Entra) | `AddAzureRedis("cache")` (now GA) | `addAzureRedis('cache')` |
| Next.js frontend | `AddNextJsApp("web", "./web")` | `addNextJsApp('web', '../web')` |
| Vite SPA | `AddViteApp("web", "./web")` | `addViteApp('web', '../web')` |
| Plain Node app | `AddNodeApp("api", "server.js")` | `addNodeApp('api', 'server.js')` |

## 13.3 Authoring Rules

| Rule | Why |
|------|-----|
| Use **unified `withEnvironment(name, value)`** in TS — never the deprecated per-kind helpers (`withEnvironmentEndpoint`, `withEnvironmentParameter`, etc.) | Single API handles all value kinds; per-kind helpers are `@deprecated` in 13.3 |
| Use `AddNextJsApp` / `AddViteApp` over hand-rolled Dockerfiles for JS frontends | First-class lifecycle + `PublishAs*` integration |
| Use `PublishAsStaticWebsite` / `PublishAsNodeServer` / `PublishAsNpmScript` for JS publish | Replaces hand-rolled Dockerfiles; SPA → static, SSR Node → NodeServer, npm-script SSR → NpmScript |
| Add `WithBrowserLogs()` to frontend resources for browser console + screenshots in dashboard | New `Aspire.Hosting.Browsers` integration in 13.3 |
| Bind every resource to a compute environment with `WithComputeEnvironment(env)` when multiple environments exist | 13.3 enforces explicit binding for multi-environment deploys |
| **Never edit `.modules/`** in TS AppHosts | Generated; edits get clobbered. Edit only `apphost.ts` |
| Use `WithEndpoint("name", e => ...)` to update endpoints | 13.3 updates rather than throws on duplicates |
| Mark admin endpoints with `ExcludeReferenceEndpoint = true` | Prevents consumers from receiving admin URLs via `WithReference()` |
| Look up unfamiliar API: `aspire docs api search <query> --language csharp\|typescript` | Don't guess overloads or builder chains |

## C# vs TS Quick Reference

| Concept | C# | TypeScript |
|---------|----|------------|
| Builder | `var builder = DistributedApplication.CreateBuilder(args);` | `const builder = await createBuilder();` |
| Add project | `builder.AddProject<Projects.Api>("api")` (SDK) or `AddProject("api", "../Api/Api.csproj")` | `await builder.addProject('api', '../Api/Api.csproj')` |
| Wire env var (any value type) | `.WithEnvironment("KEY", value)` | `.withEnvironment('KEY', value)` ← unified API |
| Wait for dependency | `.WaitFor(db)` | `.waitFor(db)` |
| Pass connection | `.WithReference(db)` | `.withReference(db)` |
| External HTTP | `.WithExternalHttpEndpoints()` | `.withExternalHttpEndpoints()` |
| Endpoint expression | `api.GetEndpoint("http")` | `api.getEndpoint('http').url` / `.host` / `.port` |
| Build + run | `builder.Build().Run();` | `await builder.build().run();` |

## ServiceDefaults Wiring

Each project should call `builder.AddServiceDefaults();` to opt into OpenTelemetry,
health checks, and service discovery. Add the `Aspire.ServiceDefaults` project
reference (or NuGet for non-monorepo). See
[references/service-defaults.md](references/service-defaults.md).

## Endpoint & Reference Conventions

```csharp
// Public-facing API. Mark "admin" endpoint as not-for-consumers.
var api = builder.AddProject<Projects.Api>("api")
    .WithExternalHttpEndpoints()
    .WithEndpoint("admin", e => e.ExcludeReferenceEndpoint = true);

// Frontend wires the API via service discovery.
builder.AddNextJsApp("web", "./web")
    .WithReference(api)        // injects services__api__http and __https
    .WaitFor(api)
    .WithBrowserLogs();        // 13.3: browser console + screenshots
```

## Validation & Recovery

| Symptom | Action |
|---------|--------|
| `aspire start` fails with build error | Fix code, re-run `aspire start` |
| `aspire wait` rejects resource name | Use `displayName` from `aspire ps --format Json` ([#15842](https://github.com/microsoft/aspire/issues/15842)) |
| File-lock errors during edit | Hand off to `aspire-orchestration` → `aspire stop` → retry |
| Resource missing from `aspire ps` | May be hidden — re-run with `--include-hidden` |
| TS AppHost change ignored | Confirm you edited `apphost.ts`, not `.modules/` |
| Mixed JSON output from `aspire start` | Strip non-JSON lines before parsing ([#15843](https://github.com/microsoft/aspire/issues/15843)) |

Full flow in [references/validation.md](references/validation.md).

## Handoff Rules

| Scenario | Route To |
|----------|----------|
| AppHost skeleton not yet dropped | → `aspire-init` skill |
| Day-to-day start/stop/wait/restart | → `aspire-orchestration` skill |
| Publish, deploy, destroy, pipeline steps | → `aspire-deployment` skill |
| Logs, traces, metrics, dashboard, browser log inspection | → `aspire-monitoring` skill |
| Deployed (Azure/AKS) app diagnostics | → `azure-diagnostics` skill (azure-skills) |

## References

- [scan-and-propose.md](references/scan-and-propose.md) — Repo scan heuristics + integration catalog
- [csharp-authoring.md](references/csharp-authoring.md) — C# AppHost patterns (incl. 13.3 features)
- [typescript-authoring.md](references/typescript-authoring.md) — TS AppHost patterns + parity APIs
- [service-defaults.md](references/service-defaults.md) — Wire OTel, health checks, service discovery
- [validation.md](references/validation.md) — End-to-end validation + recovery
