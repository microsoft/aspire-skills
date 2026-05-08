# TypeScript AppHost Authoring (13.3)

Patterns for editing `apphost.ts`. **Never edit `.modules/`** — that directory
is generated and any changes will be clobbered. Edit only `apphost.ts`.

> Look up unfamiliar API: `aspire docs api search <query> --language typescript`
> then `aspire docs api get <id>`.

## Skeleton

```ts
import { createBuilder } from '@aspire/hosting';

const builder = await createBuilder();

const pg = builder.addPostgres('pg').addDatabase('appdb');
const cache = builder.addRedis('cache');

const api = await builder.addProject('api', '../Api/Api.csproj')
    .withReference(pg)
    .withReference(cache)
    .waitFor(pg)
    .withExternalHttpEndpoints();

await builder.addNextJsApp('web', '../web')
    .withReference(api)
    .waitFor(api)
    .withBrowserLogs();

await builder.build().run();
```

## Unified `withEnvironment` API (13.3)

A **single** method handles every value kind — string, `ReferenceExpression`,
`EndpointReference`, parameter builder, connection-string resource builder, or
any `IExpressionValue`:

```ts
const apiKey = builder.addParameter('apiKey', { secret: true });
const cache = builder.addRedis('cache');
const db = builder.addPostgres('pg').addDatabase('appdb');

const api = await builder.addProject('api', '../Api/Api.csproj');
await api
    .withEnvironment('SERVICE_URL', cache.primaryEndpoint)   // endpoint
    .withEnvironment('API_KEY', apiKey)                       // parameter
    .withEnvironment('DB', db);                               // connection string
```

> **❌ DO NOT USE** the per-kind helpers — they are `@deprecated` in 13.3:
> `withEnvironmentEndpoint`, `withEnvironmentParameter`, `withEnvironmentConnectionString`,
> `withEnvironmentExpression`.
>
> ✅ Use unified `withEnvironment(name, value)` instead. Any agent suggesting
> the per-kind helpers is wrong for 13.3.

## Endpoint Property Expressions (13.3)

Endpoints expose `url`, `host`, and `port` properties usable inside expressions:

```ts
const api = await builder.addProject('api', '../Api/Api.csproj');
const httpEndpoint = api.getEndpoint('http');

await builder.addNodeApp('worker', 'worker.js')
    .withEnvironment('API_BASE', httpEndpoint.url)
    .withEnvironment('API_HOST', httpEndpoint.host)
    .withEnvironment('API_PORT', httpEndpoint.port);
```

## Endpoint Update Behavior (13.3)

`withEndpoint('name', cb)` updates an existing endpoint rather than throwing.
Use the `excludeReferenceEndpoint` flag to keep admin endpoints out of
`withReference()`:

```ts
await builder.addProject('api', '../Api/Api.csproj')
    .withEndpoint('admin', e => { e.excludeReferenceEndpoint = true; });
```

## JavaScript / TypeScript Frontends

| Helper | Use For |
|--------|---------|
| `addNextJsApp(name, projectPath)` | Next.js (auto standalone publish; set `output: 'standalone'` in `next.config.js`) |
| `addViteApp(name, projectPath)` | Vite (dev server) |
| `addNodeApp(name, scriptPath)` | Plain Node service |

Package managers: **Bun, Yarn, pnpm** are first-class in 13.3 alongside npm.

Publish hooks (mirror C# `PublishAs*`):

```ts
// Vite SPA → static website with optional API proxy
await builder.addViteApp('web', '../web')
    .withReference(api)
    .publishAsStaticWebsite({ apiPath: '/api', apiTarget: api });

// Pre-bundled Node server (TanStack Start, SvelteKit)
await builder.addViteApp('web', '../web')
    .publishAsNodeServer({ entryPoint: '.output/server/index.mjs', outputPath: '.output' });

// npm-script SSR (Remix, Astro, full Nitro Next.js)
await builder.addViteApp('web', '../web')
    .publishAsNpmScript({ scriptName: 'start' });
```

## Docker Compose Hooks (13.3 parity)

```ts
await builder.addContainer('netshoot', 'nicolaka/netshoot')
    .publishAsDockerComposeService((resource, service) => {
        service.privileged = true;
    });
```

## Dockerfile Builder APIs (13.3, experimental)

```ts
// Diagnostic ASPIREDOCKERFILEBUILDER001 — experimental warning
await builder.addDockerfileBuilder('myimage')
    .withDockerfileBuilder(b => b
        .from('node:20-alpine')
        .workdir('/app')
        .copy('package*.json', './')
        .run('npm ci')
        .copy('.', '.')
        .cmd(['node', 'server.js']));
```

## YARP Routing (13.3 parity)

```ts
const api = await builder.addProject('api', '../Api/Api.csproj');
const yarp = await builder.addYarp('gateway')
    .addRoute('/api/{**catch-all}', api.getEndpoint('http'))
    .addCatchAllRoute(web.getEndpoint('http'));
```

## Compute Environments

```ts
const aca = builder.addAzureContainerAppEnvironment('aca');
const aks = builder.addAzureKubernetesEnvironment('aks');

await builder.addProject('api', '../Api/Api.csproj')
    .withComputeEnvironment(aca);
```

ACA custom domain configuration is exposed in 13.3 TS:

```ts
await api.withComputeEnvironment(aca, e => {
    e.customDomains = [{ name: 'api.example.com', certificate: cert }];
});
```

## Predefined Value Catalogs (13.3)

The `[AspireValue]` attribute and predefined catalogs let you reference
well-known values:

```ts
import { FoundryModels } from '@aspire/hosting-azure';

await builder.addAzureFoundry('foundry')
    .addModel('chat', FoundryModels.OpenAI.Gpt41Mini);
```

## Other 13.3 TS Additions

| API | Purpose |
|-----|---------|
| `withAdminDeploymentScriptSubnet(...)` | Now exported in TS |
| `configureEnvFile(...)` | Generate `.env` files for compute environments |
| Image push options | Custom registry, tag, push behavior |
| Endpoint mutation callbacks | Modify endpoints after declaration |
| Builder pipeline | Custom pipeline steps from TS |

## Browser Logs (13.3)

```ts
await builder.addViteApp('frontend', '../frontend')
    .withBrowserLogs();
```

## Diagnostic IDs

| Diagnostic | What |
|------------|------|
| `ASPIREEXPORT013` | Build-time duplicate exported capability ID detection |
| `ASPIREJAVASCRIPT001` | Renamed from `ASPIREEXTENSION001` (13.3 breaking) |
| `ASPIREDOCKERFILEBUILDER001` | Experimental warning for `WithDockerfileBuilder` / `AddDockerfileBuilder` |
| `ASPIREDURABLETASK001` | Durable Task Scheduler experimental APIs |

## Hard Rules

| Rule | Why |
|------|-----|
| **Never edit `.modules/`** | Generated; edits are clobbered. Edit only `apphost.ts` |
| Use unified `withEnvironment(name, value)` | Per-kind helpers `@deprecated` in 13.3 |
| Use `addNextJsApp` / `addViteApp` over hand-rolled Dockerfiles | First-class lifecycle + publish helpers |
| Use `publishAs*` for JS publish — never raw Dockerfile when a helper fits | Maintained, tested, and works with `aspire deploy` |
| `package.json` `engines.node` no longer drives Node image selection in 13.3 | Pin via publish helper options instead |
