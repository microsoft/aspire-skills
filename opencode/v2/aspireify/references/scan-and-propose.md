# Scan & Propose

Heuristics for the **scan** and **propose** phases of `aspireify`.

## Scan Checklist

| Inventory | How |
|-----------|-----|
| .NET projects | `find . -name '*.csproj' -not -path '*/bin/*' -not -path '*/obj/*'` |
| Top-level Node services | `find . -maxdepth 4 -name 'package.json' -not -path '*/node_modules/*'` |
| Python services | `find . -maxdepth 4 -name 'pyproject.toml' -o -name 'requirements.txt'` |
| Go services | `find . -maxdepth 4 -name 'go.mod' -not -path '*/.aspire/*'` |
| Container deps | `cat docker-compose*.y*ml compose*.y*ml 2>/dev/null` |
| Connection strings | Locate configuration keys and their consumers in `appsettings*.json`, `.env*`, `*.config`; record source locations, not connection-string values |
| Hardcoded URLs | Locate files with `grep -rlIE 'http://localhost:[0-9]+' --include='*.ts' --include='*.tsx' --include='*.js' --include='*.cs' --include='*.go'`; report keys/locations, not potentially authenticated URL values |
| Significant external dependencies | Trace HTTPS API clients, WebSocket subscriptions and SDK constructors/options to configuration keys/sources; inspect setup docs and package references as leads, not proof |
| Existing integration packages | `dotnet list package` per `.csproj`; `jq .dependencies package.json` per Node project; the `require` block of each Go `go.mod` |
| Existing endpoints | `launchSettings.json`, `next.config.js`, `vite.config.ts`, `apphost.mts`, `apphost.go` |
| Existing AppHost references | `apphost.cs` / `Program.cs` / `apphost.go` / current `apphost.mts` / legacy `apphost.ts` — what's already wired? |

### Significant dependency inventory

Inventory application-level dependencies that materially affect features, data,
authentication, messaging, or streaming, whether local or remote. Do not enumerate
every request, SDK-internal endpoint, or transitive package. Package presence alone
does not prove an active dependency; find its consumer. Keep local runnable services
in the existing `services`/resource graph, using `serviceId` mappings and
`serviceTreatments` for unmapped services. The external dependency disposition and
payload flow below applies only to separately operated or provider-managed
dependencies, not AppHost-launched local services.

For each significant dependency, record:

- **Purpose and consumers** — the feature it supports and the code that uses it.
- **Configuration key/source** — key names and file/line or setup-document evidence,
  including environment, user secrets, or credential-provider sources. Never copy
  secret values, connection strings, tokens, or authenticated URLs into the inventory,
  proposal, chat, or canvas.
- **Lifecycle ownership** — AppHost-launched, separately operated, or provider-managed;
  separately note client/SDK ownership of authentication, transport and recovery.
- **Endpoint selection** — explicit configured address versus dynamic SDK selection
  (for example region, account, environment or discovery). Record the selection
  inputs; do not invent a stable URL for an SDK-selected endpoint.
- **Evidence and uncertainty** — source locations for the above, and unknowns that
  affect scope, wiring, or behavior. Do not infer a health endpoint from an API URL.

A local-process-only AppHost can be correct. It is not permission to silently omit
remote dependencies: explain the inventory and exclusions, and clarify material
scope in chat before confirmation. If evidence is insufficient, ask or agree to
defer the investigation rather than fabricate an endpoint or resource.

### Choose a disposition and canvas treatment

Apply the [external modeling policy](apphost-wiring.md#external-dependency-modeling).
Importance alone neither requires nor rules out `AddExternalService`. Record each
disposition with the canvas treatment it maps to; the disposition is the evidence-backed
rationale, not a separate status.

| Disposition (rationale) | Canvas treatment | Evidence-backed rationale to present |
|-------------------------|------------------|--------------------------------------|
| **Proposed resource** | `externalDependencyId` mapping | Name the concrete benefit: descriptive-only dashboard visibility, a consumer that understands discovery, deliberate endpoint wiring, or meaningful opt-in diagnostics. State what ownership and behavior remain unchanged. |
| **Retained configuration/SDK ownership** | `not-modeled`; `reason` names what keeps ownership | Explain why existing configuration or SDK-selected endpoints/authentication/transport/recovery are more accurate; an optional URL parameter is still configuration, not a service. |
| **Outside the agreed scope** | `not-modeled`; `reason` names the agreed scope boundary | Cite the scope decision from chat that excludes it (for example, a separately owned feature or environment). |
| **Agreed deferred investigation** | `deferred`; `reason` plus `unresolved` (the missing evidence or open question) | State the missing evidence, the question to resolve, and the user's agreement to defer. |
| (none supplied) | `not-assessed` | Shown by the canvas when no mapping or treatment exists; it must not remain at confirmation. |

Before confirmation, every significant discovered external dependency needs a mapping or a
treatment with a rationale tied to evidence; out-of-scope dependencies are
`not-modeled`, never left `not-assessed`. Resolve material scope and behavior
questions in chat first (including whether a resource is descriptive-only, whether
configuration moves, and whether diagnostics or startup behavior changes).

### Send the canvas payload

Keep this accounting separate from the runnable resource graph:

- If the canvas host is unavailable, present the same external inventory, resource
  mappings, treatments, reasons, and unresolved questions with the proposal in chat.
  Obtain explicit user confirmation before implementation; do not fabricate a
  `get_confirmation` result or bypass an available canvas's approval boundary.
- Send discovered external APIs, WebSocket streams, and SDK-selected endpoints through
  `load_discovery.externalDependencies`. Do not put external dependencies in runnable
  `services` or fabricate resource types/edges to make the accounting fit. Use the
  action schemas for fields; supply configuration key names and evidence, never
  secret values or authenticated URLs.
- Map proposal resources with `externalDependencyId`, not `serviceId`.
- For unmapped dependencies, pass `set_proposal.externalDependencyTreatments`:
  `not-modeled` with a `reason`, or `deferred` with a `reason` and `unresolved`.
  Keep only the rationale discussion in chat.
- Do not invent resources merely for visibility or change configuration,
  SDK/authentication, health-check, or startup ownership.
- Carry `get_confirmation.externalDependencies`, including its `resourceMappings`
  and decisions, into implementation. Omitting inventory or treatments preserves
  them within the current run; explicit empty arrays clear them.

## Heuristics

| Signal | Suggest |
|--------|---------|
| `.csproj` references `Microsoft.AspNetCore.App` | API project → `AddProject` + `WithExternalHttpEndpoints()` if user-facing |
| `.csproj` references `Microsoft.NET.Sdk.Worker` | Background worker → `AddProject`, no external endpoints |
| `package.json` has `"next"` dependency | `AddNextJsApp` — confirm `next.config.js` has `output: 'standalone'` |
| `package.json` has `"vite"` + SPA bundle | `AddViteApp` + `PublishAsStaticWebsite(apiPath, apiTarget)` |
| `package.json` has `"vite"` + `.output/server/index.mjs` (TanStack/SvelteKit) | `AddViteApp` (dev) + `PublishAsNodeServer` (publish) |
| `package.json` has Remix / Astro / Nitro Next | `PublishAsPackageScript` |
| `pyproject.toml` with FastAPI/Flask | `AddPythonApp` (or model under TS AppHost) |
| `go.mod` with a `main` package (a Go service, not the AppHost's own `go.mod`) | `AddGoApp` (`aspire add go`): preview from 13.4, stable from 17.0; on 13.x require approval and an explicit compatible preview version. |
| `Program.cs` reads `ConnectionStrings:Postgres*` / DI calls `AddNpgsql*` | `AddPostgres('pg').AddDatabase('appdb')` + `WithReference` |
| `Program.cs` calls `AddStackExchangeRedisCache` | `AddRedis('cache')` + `WithReference` |
| MongoClient / `MongoDB.Driver` | `AddMongoDB('mongo')` |
| Code refs `RabbitMQ.Client` / `IConnection` | `AddRabbitMQ('mq')` (v7 client — pub/sub tracing) |
| Code refs `Microsoft.Azure.Cosmos` | `AddAzureCosmosDB('cosmos')` |
| Code refs `Azure.Messaging.ServiceBus` | `AddAzureServiceBus('sb')` |
| Frontend hardcodes `http://localhost:5000` | Replace with service discovery: `endpoint.url` (TS) or `WithReference(api)` |

## Integration Catalog

The tables show C# and TypeScript shapes; Go AppHost method names come from the generated SDK (see [go-authoring.md](go-authoring.md)).

### Datastores

| Service | C# integration | TS integration | Notes |
|---------|----------------|----------------|-------|
| Postgres | `AddPostgres("pg").AddDatabase("appdb")` | `addPostgres('pg').addDatabase('appdb')` | Npgsql metrics align to .NET 10 |
| SQL Server | `AddSqlServer("sql").AddDatabase("appdb")` | `addSqlServer('sql').addDatabase('appdb')` | Container-backed locally |
| MySQL | `AddMySql("my").AddDatabase("appdb")` | `addMySql('my').addDatabase('appdb')` | |
| MongoDB | `AddMongoDB("mongo").AddDatabase("app")` | `addMongoDB('mongo').addDatabase('app')` | |
| Redis | `AddRedis("cache")` | `addRedis('cache')` | |
| Azure Cache for Redis | `AddAzureRedis("cache")` | `addAzureRedis('cache')` | `Aspire.Microsoft.Azure.StackExchangeRedis` is GA |
| Cosmos DB | `AddAzureCosmosDB("cosmos")` | `addAzureCosmosDB('cosmos')` | |
| Azure SQL | `AddAzureSqlServer("sql")` | `addAzureSqlServer('sql')` | |
| Azure Storage | `AddAzureStorage("storage")` | `addAzureStorage('storage')` | |

### Messaging

| Service | C# | TS | Notes |
|---------|----|----|-------|
| RabbitMQ | `AddRabbitMQ("mq")` | `addRabbitMQ('mq')` | v7 client, OTel pub/sub tracing |
| Azure Service Bus | `AddAzureServiceBus("sb")` | `addAzureServiceBus('sb')` | |
| Kafka | `AddKafka("kafka")` | `addKafka('kafka')` | |
| Azure Event Hubs | `AddAzureEventHubs("eh")` | `addAzureEventHubs('eh')` | |
| Durable Task Scheduler | `AddDurableTaskScheduler(...)` | n/a | Experimental: `ASPIREDURABLETASK001` |

### Frontends (JS/TS)

| Pattern | Add | Publish |
|---------|-----|---------|
| Next.js (SSR or static) | `AddNextJsApp("web", "./web")` | Auto — Next.js standalone (set `output: 'standalone'` in `next.config.js`) |
| Vite SPA | `AddViteApp("web", "./web")` | `PublishAsStaticWebsite(apiPath: "/api", apiTarget: api)` |
| Vite + TanStack/SvelteKit (SSR via Node) | `AddViteApp("web", "./web")` | `PublishAsNodeServer(entryPoint: ".output/server/index.mjs", outputPath: ".output")` |
| Remix / Astro SSR / Nitro | `AddNodeApp` or `AddViteApp` | `PublishAsPackageScript(scriptName: "start")` |
| Plain Node | `AddNodeApp("api", "./api", "server.js")` | `PublishAsNodeServer` |

Bun, Yarn, and pnpm are first-class in TS AppHosts (npm remains the default).

### Go services

| Pattern | Add |
|---------|-----|
| Go module with a `main` package, preview from 13.4 / stable from 17.0 | `AddGoApp("api", "./api")` after `aspire add go` (TS: `addGoApp('api', '../api')`; Go AppHost: `builder.AddGoApp("api", "./api")`). On 13.x, get approval and select a compatible preview with `--version`. |

### AI / Foundry

| Pattern | API |
|---------|-----|
| Azure AI Foundry Prompt Agent | `AddPromptAgent(...)` (replaces non-functional `AddAndPublishPromptAgent`) |
| Predefined Foundry models in TS | `[AspireValue]` + catalogs like `FoundryModels.OpenAI.Gpt41Mini` |

### Compute environments (binding)

| Target | API |
|--------|-----|
| Azure Container Apps | `AddAzureContainerAppEnvironment("aca")` |
| Azure App Service | `AddAzureAppServiceEnvironment("appsvc")` |
| Azure Kubernetes Service | `AddAzureKubernetesEnvironment("aks").WithSystemNodePool(...)` |
| Plain Kubernetes | `AddKubernetesEnvironment("k8s")` (Helm-based) |
| Docker Compose | `AddDockerComposeEnvironment("compose")` |

Bind a resource: `.WithComputeEnvironment(env)`. **Required** when multiple
environments are declared.

## Proposal Template

When presenting the proposed graph to the user, structure it as:

```
SCAN RESULTS
  Projects: Api (csproj), Worker (csproj)
  Frontends: web (Next.js)
  Local infrastructure: Postgres (compose), Redis (compose)
  External dependencies: catalog HTTPS API, event WebSocket, regional storage SDK
  Connection strings hardcoded in: Api/appsettings.Development.json

PROPOSED RESOURCE GRAPH
  - pg (Postgres)
    - appdb (database)
  - cache (Redis)
  - api (Project) → references pg, cache; waits for both; external HTTP
  - worker (Project) → references pg
  - web (Next.js) → references api; waits for api; WithBrowserLogs

DEPENDENCY DISPOSITIONS (evidence locations, never secret values)
  - catalog: product lookup for api; Catalog:BaseUrl in Api/appsettings.json,
    consumed in Api/CatalogClient.cs; explicit HTTPS, provider-operated.
    Proposed catalog ExternalService for descriptive-only visibility; existing
    configuration and authenticated client remain unchanged; no checks or waits.
  - events: updates for worker; EVENTS_URL in setup docs, consumed in Worker/stream.py;
    explicit WSS, provider-operated. Retain configuration and SDK auth/reconnect;
    no HTTP health check and no startup gate.
  - storage: archival for worker; STORAGE_REGION in setup docs, used by SDK factory
    in Worker/storage.py; provider-managed, SDK-selected endpoint. Defer modeling
    pending account/region evidence only if user agrees; retain SDK behavior meanwhile.

QUESTIONS BEFORE I EDIT
  1. Replace appsettings Postgres connection string with Aspire service discovery? [Y/n]
  2. Mark Api's /admin endpoint as ExcludeReferenceEndpoint? [Y/n]
  3. Bind everything to a default compute environment, or wait for deploy? [skip/aca/aks]
  4. Is catalog visibility useful without moving its config? May storage investigation
     be deferred with SDK ownership unchanged, or should we resolve it before approval?
```

Resolve these questions and complete the external dependency dispositions and
treatments in the canvas (or chat fallback), then wait for confirmation before editing. The external dependencies
above are not runnable services.
