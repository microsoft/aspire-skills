# Bicep / IaC → AppHost conversion

Brownfield Azure apps often already ship infrastructure-as-code — hand-written `*.bicep`,
ARM JSON, or Bicep exported from an existing resource group (`az group export`, or the portal
"Export template"). This reference covers turning that IaC into an Aspire AppHost: model what
Aspire has a first-class integration for with standard `AddAzure*` APIs, customize the
generated infrastructure where the Bicep diverges from defaults, and fall back to **custom
Bicep embedded in the AppHost** (`AddBicepTemplate`) for everything Aspire doesn't model
natively.

> This is an `aspireify` wiring scenario: the AppHost becomes the source of truth and Aspire
> generates the deployment Bicep at `aspire publish` / `aspire deploy` time. Confirm the exact
> `AddAzure*` method and package before generating — `aspire docs api search <service>
> --language csharp` — because the Azure integration surface evolves between releases.

> [!IMPORTANT]
> **Do these two things on every conversion — they are the steps most often missed:**
>
> 1. **Map *every* resource that has a first-class Aspire integration to its `AddAzure*` API**
>    (e.g. `Microsoft.Storage/storageAccounts` → `AddAzureStorage`,
>    `Microsoft.ServiceBus/namespaces` → `AddAzureServiceBus`, Cosmos/Redis/SQL/Key Vault, …).
>    Only resources with **no** native integration (see the map below) fall back to
>    `AddBicepTemplate`. Don't dump natively-modeled services into raw Bicep.
> 2. **Always raise provision-new vs reference-existing before editing.** A naive conversion
>    makes Aspire **provision and own brand-new resources** at deploy time. For a **production**
>    app that must keep its existing resources, model them as existing (`AsExisting` /
>    `PublishAsExisting`, or `AddConnectionString`) instead of creating parallel copies — and
>    confirm the choice with the user.

## Conversion workflow

1. **Inventory the IaC.** For each `*.bicep` / ARM file, list every `resource`, its `type`
   (`Microsoft.*/...`), `params`, `outputs`, and inter-resource references (`dependsOn`,
   `properties` that reference another resource's id/endpoint). Note which outputs feed app
   configuration (connection strings, endpoints, keys).
2. **Classify each resource** into one of four buckets (see the decision tree below):
   native Aspire integration, native + `ConfigureInfrastructure` tweak, custom
   `AddBicepTemplate`, or *reference an existing resource* (don't re-provision).
3. **Decide provision-new vs reference-existing.** This is the critical question for a
   **production** app. Aspire *provisions and owns* the resources it models, so a naive
   conversion will create **new** resources at deploy time. If the app must keep using existing
   production resources, model them as existing (`AsExisting` / `PublishAsExisting`, or
   `AddConnectionString`) rather than letting Aspire create parallel copies. Always confirm with
   the user before generating something that would provision new infrastructure.
4. **Propose the mapping** as a table (Bicep resource → Aspire API → provision/reference) and
   get sign-off before editing — same as the standard aspireify Propose step.
5. **Wire the AppHost.** Add resources, thread Bicep `outputs` into consumers as references
   (not hardcoded strings), and migrate `params` to AppHost parameters / Key Vault.
6. **Validate the generated infrastructure**, not just local run:
   - `aspire start` confirms the app model is valid and resources start (emulators where
     supported).
   - `aspire publish --output-path ./infra-preview` (or `aspire deploy --what-if` style review)
     generates the Bicep Aspire would deploy — **diff it against the original IaC** to confirm
     SKUs, networking, and settings match before deploying against real subscriptions.

## Bicep type → Aspire integration map

Confirm exact names with `aspire docs api search`; this is the common set, not exhaustive.

| Bicep `type` | Aspire API | Notes |
|--------------|-----------|-------|
| `Microsoft.Storage/storageAccounts` | `AddAzureStorage("storage")` | `.AddBlobs()` / `.AddQueues()` / `.AddTables()`; `.RunAsEmulator()` (Azurite) locally |
| `Microsoft.DocumentDB/databaseAccounts` | `AddAzureCosmosDB("cosmos")` | `.AddDatabase(...)`; emulator locally |
| `Microsoft.ServiceBus/namespaces` | `AddAzureServiceBus("sb")` | `.AddQueue(...)` / `.AddTopic(...)`; emulator locally |
| `Microsoft.Cache/redis*` | `AddAzureRedis("cache")` | Entra-auth GA; `.RunAsContainer()` locally |
| `Microsoft.Sql/servers` (+ `/databases`) | `AddAzureSqlServer("sql").AddDatabase("db")` | `.RunAsContainer()` locally |
| `Microsoft.DBforPostgreSQL/flexibleServers` | `AddAzurePostgresFlexibleServer("pg").AddDatabase("db")` | container locally |
| `Microsoft.KeyVault/vaults` | `AddAzureKeyVault("kv")` | Prefer over porting raw secret outputs |
| `Microsoft.AppConfiguration/configurationStores` | `AddAzureAppConfiguration("config")` | |
| `Microsoft.EventHub/namespaces` | `AddAzureEventHubs("eh")` | |
| `Microsoft.SignalRService/signalR` | `AddAzureSignalR("signalr")` | |
| `Microsoft.SignalRService/webPubSub` | `AddAzureWebPubSub("wps")` | |
| `Microsoft.CognitiveServices/accounts` (OpenAI/Foundry) | `AddAzureOpenAI("openai")` / `AddAzureAIFoundry(...)` | confirm name per release |
| `Microsoft.Search/searchServices` | `AddAzureSearch("search")` | |
| `Microsoft.Insights/components` | `AddAzureApplicationInsights("ai")` | |
| `Microsoft.OperationalInsights/workspaces` | `AddAzureLogAnalyticsWorkspace("logs")` | |
| `Microsoft.Network/virtualNetworks` (+ subnets / NSG / private endpoints) | `AddAzureVirtualNetwork("vnet")` | or custom infra for advanced topologies |
| `Microsoft.App/managedEnvironments` | `AddAzureContainerAppEnvironment("aca")` | compute target, not a resource ref |
| `Microsoft.Web/serverfarms` + `sites` | `AddAzureAppServiceEnvironment("appsvc")` | compute target |
| `Microsoft.ContainerService/managedClusters` | `AddAzureKubernetesEnvironment("aks").WithSystemNodePool(...)` | compute target |
| `Microsoft.Cdn/profiles` (Front Door) | `AddAzureFrontDoor("frontdoor").WithOrigin(...)` | |
| `Microsoft.ManagedIdentity/userAssignedIdentities` | *(usually omit)* | Aspire generates identities; see "What not to port" |
| `Microsoft.Authorization/roleAssignments` | *(usually omit)* | Aspire emits its own via `WithRoleAssignments(...)` |
| anything not modeled above | `AddBicepTemplate(...)` | see custom-Bicep fallback |

## Custom Bicep fallback (`AddBicepTemplate`)

When a resource has no first-class integration — or the team wants to keep an audited,
hand-tuned module verbatim — embed the original `.bicep` file directly. Aspire deploys it as
part of the app's infrastructure and lets you thread parameters in and outputs out.

```csharp
var custom = builder.AddBicepTemplate("analytics", "../infra/analytics.bicep")
    .WithParameter("skuName", "Standard")
    .WithParameter("location", builder.AddParameter("location"))
    // well-known parameters Aspire can supply automatically:
    .WithParameter(AzureBicepResource.KnownParameters.PrincipalId)
    .WithParameter(AzureBicepResource.KnownParameters.PrincipalType);

// Thread a Bicep `output` into a consumer instead of hardcoding it:
builder.AddProject<Projects.Api>("api")
    .WithEnvironment("ANALYTICS_ENDPOINT", custom.GetOutput("endpoint"));
```

- `WithParameter(name, value)` accepts strings, AppHost parameters, endpoint references, and
  other resources' outputs — chain resources by passing one's `GetOutput(...)` as another's
  parameter.
- `GetOutput("name")` returns a `BicepOutputReference` that resolves at deploy time; pass it to
  `WithEnvironment` / `WithReference`.
- **Secrets:** don't expose secret values as plain `output`s. Route them through Key Vault
  (`AddAzureKeyVault`) or a secret parameter so they aren't written to plaintext config.
- For **programmatic** infra (no `.bicep` file), `AddAzureInfrastructure("name", infra => { ... })`
  builds resources with Azure.Provisioning (the same CDK Aspire uses internally).

## Customizing generated infrastructure (`ConfigureInfrastructure`)

When the Bicep mostly matches a native integration but tweaks a SKU, tier, or property, use the
native `AddAzure*` API and adjust the generated resource with Azure.Provisioning instead of
dropping to a full custom template:

```csharp
builder.AddAzureStorage("storage")
    .ConfigureInfrastructure(infra =>
    {
        var account = infra.GetProvisionableResources().OfType<StorageAccount>().Single();
        account.Sku = new StorageSku { Name = StorageSkuName.StandardGrs };
        account.AllowBlobPublicAccess = false;
    });
```

This keeps Aspire's connection wiring, health checks, and role assignments while honoring the
original IaC's non-default settings.

## Referencing existing production resources

If the IaC describes resources that already exist and must **not** be re-provisioned, model
them as existing rather than letting Aspire create new ones:

- **`AddConnectionString("name")`** — simplest: Aspire reads the connection string / endpoint
  from configuration (user secrets, env, Key Vault) and injects it via `WithReference`, without
  modeling the resource at all. Best when you only consume the resource.
- **`AsExisting(...)` / `RunAsExisting(...)` / `PublishAsExisting(...)`** — supported on many
  Azure resources to bind to an existing instance by name / resource group while keeping the
  typed integration. Confirm availability per resource with
  `aspire docs api search existing --language csharp`.

State this trade-off explicitly to the user: converting to provision-new gives Aspire full
lifecycle ownership (and a reproducible environment), but will create parallel resources unless
you point at the existing ones.

## What not to port

- **Role assignments / managed identities** (`Microsoft.Authorization/roleAssignments`,
  `Microsoft.ManagedIdentity/*`) — Aspire generates managed identities and least-privilege role
  assignments for the resources it models. Re-expressing them by hand causes duplicates. Use
  `WithRoleAssignments(...)` only to *add* non-default access.
- **Resource group / subscription scaffolding** — Aspire targets a resource group selected at
  deploy time; don't model the group itself.
- **Naming / `uniqueString()` schemes** — Aspire owns resource naming. If exact names matter
  (existing resources, DNS), set them explicitly via `ConfigureInfrastructure` or reference the
  existing resource instead.
- **Diagnostic settings / alerts wired purely for ops** — port only if the app depends on them;
  otherwise keep them in separate ops IaC.

## Decision tree

```
For each Bicep resource:
  ├─ Already exists & must stay?            → AddConnectionString / *AsExisting
  ├─ Native Aspire integration exists?
  │     ├─ Defaults match the Bicep?        → AddAzure<Service>(...)
  │     └─ Bicep tweaks SKU/settings?       → AddAzure<Service>(...).ConfigureInfrastructure(...)
  ├─ No native integration?                 → AddBicepTemplate("name", "module.bicep")
  └─ Pure RBAC / identity / group scaffold? → omit (Aspire generates it)
```

## Handoff

After wiring, validate (`aspire start`, then diff `aspire publish` output against the original
IaC), then self-deactivate to `aspire-orchestration` for day-to-day lifecycle and to
`aspire-deployment` for the actual `aspire deploy`. Flag any resource left as a custom
`AddBicepTemplate` so the user knows what Aspire is deploying verbatim vs. modeling natively.
