# Scan & Propose

Heuristics for the **scan** and **propose** phases of `aspireify`.

## Scan Checklist

| Inventory | How |
|-----------|-----|
| .NET projects | `find . -name '*.csproj' -not -path '*/bin/*' -not -path '*/obj/*'` |
| Top-level Node services | `find . -maxdepth 4 -name 'package.json' -not -path '*/node_modules/*'` |
| Python services | `find . -maxdepth 4 -name 'pyproject.toml' -o -name 'requirements.txt'` |
| Compose launch modes | Inventory every `compose*.yaml` / `docker-compose*.yaml`, any `-f` script arguments, profiles, and `extends` chains |
| Connection strings | `grep -rIE '(Postgres\|Redis\|Mongo\|RabbitMQ\|Cosmos\|ServiceBus\|AMQP)' --include='*.json' --include='.env*' --include='*.config'` |
| Hardcoded URLs | `grep -rIE 'http://localhost:[0-9]+' --include='*.ts' --include='*.tsx' --include='*.js' --include='*.cs'` |
| Existing integration packages | `dotnet list package` per `.csproj`; `jq .dependencies package.json` per Node project |
| Existing endpoints | `launchSettings.json`, `next.config.js`, `vite.config.ts`, and the metadata-selected AppHost |
| Existing AppHost references | Read `aspire.config.json` `appHost.path` first, then inspect its source; fall back to `apphost.cs` / `Program.cs` / current `apphost.mts` / legacy `apphost.ts` only when metadata is absent |

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
| `Program.cs` reads `ConnectionStrings:Postgres*` / DI calls `AddNpgsql*` | `AddPostgres('pg').AddDatabase('appdb')` + `WithReference` |
| `Program.cs` calls `AddStackExchangeRedisCache` | `AddRedis('cache')` + `WithReference` |
| Valkey image or `valkey://` configuration | `AddValkey('cache')` + `WithReference` |
| MongoClient / `MongoDB.Driver` | `AddMongoDB('mongo')` |
| Code refs `RabbitMQ.Client` / `IConnection` | `AddRabbitMQ('mq')` (v7 client — pub/sub tracing) |
| Code refs `Microsoft.Azure.Cosmos` | `AddAzureCosmosDB('cosmos')` |
| Code refs `Azure.Messaging.ServiceBus` | `AddAzureServiceBus('sb')` |
| Frontend hardcodes `http://localhost:5000` | Replace with service discovery: `endpoint.url` (TS) or `WithReference(api)` |

## Integration Catalog

### Datastores

| Service | C# integration | TS integration | Notes |
|---------|----------------|----------------|-------|
| Postgres | `AddPostgres("pg").AddDatabase("appdb")` | `addPostgres('pg').addDatabase('appdb')` | Npgsql metrics align to .NET 10 |
| SQL Server | `AddSqlServer("sql").AddDatabase("appdb")` | `addSqlServer('sql').addDatabase('appdb')` | Container-backed locally |
| MySQL | `AddMySql("my").AddDatabase("appdb")` | `addMySql('my').addDatabase('appdb')` | |
| MongoDB | `AddMongoDB("mongo").AddDatabase("app")` | `addMongoDB('mongo').addDatabase('app')` | |
| Redis | `AddRedis("cache")` | `addRedis('cache')` | |
| Valkey | `AddValkey("cache")` | `addValkey('cache')` | First-party `Aspire.Hosting.Valkey`; retain the Valkey name |
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
| Plain Node | `AddNodeApp("api", "server.js")` | `PublishAsNodeServer` |

Bun, Yarn, and pnpm are first-class in TS AppHosts (npm remains the default).

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

## Compose and monorepo authority

Do not merge every discovered Compose service or package manifest into one graph. First
expand each Compose candidate's `extends` chain, record its active profiles, and inspect the
actual local launch commands (`docker compose -f ... --profile ...`, package scripts, and
task runners). If more than one Compose file, profile combination, or launch mode can start
services, require an explicit authority decision before proposing edits:

> "I found these local launch modes: `<command/profile A>`, `<command/profile B>`, and
> `<package script>`. Which one is authoritative for the normal Aspire development graph?"

Services without profiles are included by the selected Compose mode; profile services are
included only when that profile is selected. Treat `extends` as inherited service
configuration, not a second runnable service.

Deduplicate Compose and package-manifest discoveries by **runtime identity**, not package or
service name. Resolve declaration paths relative to their files and normalize the resulting
paths. A package runtime identity is its package directory plus selected script or entry
point; a Compose identity is its resolved build context (when source-backed) or its resolved
image plus Compose service identity. When a Compose service and package manifest describe the
same resolved runtime, produce one candidate and retain both sources as evidence. Keep
distinct candidates when their command, build context, image, or selected profile differs.

By default, exclude packages and Compose services under or intended for `docs`, `test`,
`tests`, `e2e`, `examples`, `samples`, Storybook, code generation, and developer tooling.
List them as excluded discovery results and add one only if the user selects it as part of
the authoritative launch mode.

## Proposal Template

When presenting the proposed graph to the user, structure it as:

```
SCAN RESULTS
  Projects: Api (csproj), Worker (csproj)
  Frontends: web (Next.js)
  External deps: Postgres (compose), Valkey (compose)
  Connection strings hardcoded in: Api/appsettings.Development.json

PROPOSED RESOURCE GRAPH
  - pg (Postgres)
    - appdb (database)
  - cache (Valkey)
  - api (Project) → references pg, cache; waits for both; external HTTP
  - worker (Project) → references pg
  - web (Next.js) → references api; waits for api; WithBrowserLogs

QUESTIONS BEFORE I EDIT
  1. Replace appsettings Postgres connection string with Aspire service discovery? [Y/n]
  2. Mark Api's /admin endpoint as ExcludeReferenceEndpoint? [Y/n]
  3. Bind everything to a default compute environment, or wait for deploy? [skip/aca/aks]
  4. Which discovered Compose file/profile or package script is authoritative for normal local development?
```

Wait for confirmation before editing.
