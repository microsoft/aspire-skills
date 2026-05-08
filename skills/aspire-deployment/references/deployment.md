# Deployment

Use this when the task is about deployment artifacts, deployment execution, named pipeline steps,
or tearing down a previously-deployed Aspire app.

> ⚠️ **13.3 breaking change**: `--log-level` was renamed to `--pipeline-log-level` on
> `aspire publish` and `aspire deploy`. Audit any CI snippets that use the old flag.

## Regenerate Deployment Artifacts And Redeploy

```bash
aspire publish
aspire deploy
aspire deploy --clear-cache
aspire deploy --pipeline-log-level debug
```

- Use `aspire publish` when artifact generation is part of the request.
- Use `aspire deploy` when the goal is the full deployment flow, not just one step.
- Use `aspire deploy --clear-cache` when cached deployment state is stale or stuck.
- Use `aspire deploy --pipeline-log-level <level>` for verbose pipeline logs (replaces 13.2 `--log-level`).

## Tear Down a Deployment

```bash
aspire destroy
aspire destroy --non-interactive
aspire do --list-steps   # also lists destroy steps
```

`aspire destroy` is the inverse of `aspire deploy` — it tears down what was provisioned, using the
same `WithComputeEnvironment` bindings declared in your AppHost. One command, every target:

| Target | What `aspire destroy` does |
|--------|----------------------------|
| Azure | Resources deleted via Azure Resource Manager |
| Kubernetes / AKS | Helm releases uninstalled, namespaces removed |
| Docker Compose | Compose stacks stopped and removed (do **not** invoke the Compose CLI manually) |

Use it for CI cleanup, ephemeral preview deployments, and dev sandboxes — no hand-tracking what was deployed.

### ⚠️ Tear-Down Anti-Patterns (Never Recommend)

`aspire destroy` is the **only** correct tear-down command, regardless of which target
the user mentions. Recommending the underlying platform command bypasses Aspire's state
tracking and leaves orphaned resources, secrets, and pipeline metadata.

| User Phrasing | ❌ NEVER Suggest | ✅ ALWAYS Suggest |
|---------------|------------------|-------------------|
| "tear down my Aspire deployment" | Manual platform CLI calls (Azure resource-group delete, kubectl manifest delete, Helm uninstall, Compose stop) | `aspire destroy --non-interactive` |
| "stop my Compose stack that Aspire deployed" | Direct Compose CLI invocation | `aspire destroy --non-interactive` (Aspire owns the Compose stack — destroy unwinds it) |
| "delete my Helm release for the Aspire app" | A Helm uninstall command | `aspire destroy --non-interactive` (uninstalls Helm release **and** namespace via the destroy pipeline) |
| "delete the Azure resource group I deployed to" | An Azure CLI resource-group delete | `aspire destroy --non-interactive` (removes resources via Azure Resource Manager + cleans pipeline state) |
| "remove my AKS workload that Aspire shipped" | A `kubectl` manifest delete | `aspire destroy --non-interactive` |

If — and only if — the user explicitly says "Aspire never deployed this" or there is no
`WithComputeEnvironment` binding, fall back to the platform CLI. Otherwise, **`aspire destroy`
is the answer for every target Aspire deployed**, including Docker Compose.

## Run One Named Deployment Step

```bash
aspire do seed-data
aspire do push-containers
aspire do diagnostics
aspire do --list-steps
```

- Use `aspire do <step>` when the request is specifically about one named pipeline step.
- Common scenarios: seeding data, running diagnostics, pushing containers — step names are app-defined.
- Do not substitute `aspire deploy` when the request is to rerun only one step.
- Use `aspire do --list-steps` to discover available steps for `do`, `publish`, `deploy`, or `destroy`.

### `aspire do diagnostics` — Evaluate Pipeline Health

Use `aspire do diagnostics` to evaluate the steps in the current AppHost's deploy pipeline before executing deployment:

```bash
aspire do diagnostics
```

- Inspects the AppHost's deployment configuration, reports pipeline steps, order, and potential issues.
- Use it as a **pre-flight check** before `aspire deploy` to understand what will happen.
- Useful for AI agents to evaluate the deploy pipeline without actually deploying.

### Pipeline Step Behavior in 13.3

- A built-in **`check-container-runtime`** step runs first on `aspire deploy`, failing fast if Docker/Podman is missing.
- **Independent steps continue on sibling failure** — a single failed step no longer blocks unrelated work in the same pipeline run.
- Each `do` / `publish` / `deploy` / `destroy` run prints a **pipeline step summary** at the end (✓/✗ per step, durations, total time).

## Multi-Target Publishing

Aspire generates and applies deployment artifacts based on how resources are configured in the AppHost:

| Target | How It Works |
|--------|-------------|
| Azure Container Apps | AppHost generates Bicep + deploys via Azure SDK |
| Azure App Service | AppHost generates deployment config; HTTPS upgrade is automatic in 13.3 |
| Azure Kubernetes Service (AKS) | `AddAzureKubernetesEnvironment` → Bicep + Helm pipeline executed end-to-end by `aspire deploy` |
| Kubernetes (any cluster) | `AddKubernetesEnvironment` → Aspire generates a Helm chart and applies it end-to-end (preview) |
| Docker Compose | `aspire publish` / `aspire deploy` generates `docker-compose.yml`; Podman is supported out of the box |

The deployment pipeline runs **inside the AppHost** — not via external tools:
1. `aspire publish` invokes the AppHost in publish mode
2. AppHost generates artifacts from resource definitions
3. `aspire deploy` extends this to also apply the deployment (including Helm install for K8s/AKS)

## Kubernetes and AKS Deploy (13.3)

Aspire 13.3 ships a Helm-based Kubernetes deployment engine. Declare an environment, run
`aspire deploy`, and Aspire generates a complete Helm chart and applies it end-to-end against
your cluster — no separate `helm install`, `kustomize`, `kubectl apply`, or hand-rolled manifests
required. `aspire destroy` removes the Helm release and namespace cleanly.

```csharp
// Non-Azure cluster (preview)
var k8s = builder.AddKubernetesEnvironment("k8s");
builder.AddProject<Projects.Api>("api")
    .WithComputeEnvironment(k8s);
```

```csharp
// Azure Kubernetes Service — first-class hosting integration
var aks = builder.AddAzureKubernetesEnvironment("aks")
    .WithSystemNodePool("Standard_D2s_v5", minCount: 1, maxCount: 3);

builder.AddProject<Projects.Api>("api")
    .WithComputeEnvironment(aks);
```

> AKS control-plane defaults to the **Free** SKU. The `AksSkuTier` enum is no longer part of
> the public API — delete any references during 13.3 upgrade.

### Ingress and Gateway API routing

New first-class Ingress and Gateway API routing resources let you declare cluster traffic at the
AppHost level. Aspire generates the corresponding Ingress / IngressClass / Gateway / HTTPRoute
(and cert-manager `Certificate`) resources.

```csharp
var ingress = k8s.AddIngress("public")
    .WithIngressClass("nginx")
    .WithHostname("api.example.com")
    .WithTls("api-cert");

ingress.WithRoute("/", api.GetEndpoint("http"));
```

> Users still need cluster credentials (e.g., `az aks get-credentials`, kubeconfig context). Aspire
> just stops you from invoking `kubectl apply` or `helm install` by hand.

## JavaScript and Node.js Publishing

A unified `PublishAs*` family replaces hand-rolled Dockerfile plumbing for JS/TS apps:

| API | Use For | Notes |
|-----|---------|-------|
| `PublishAsStaticWebsite` (preview) | SPAs (Vite, plain Next.js export) | YARP-served static; optional `apiPath` + `apiTarget` reverse-proxy |
| `PublishAsNodeServer` | Pre-bundled Node entry-point (e.g., `server.js`) | No `node_modules` copied at runtime |
| `PublishAsNpmScript` | Full Nitro Next.js, Remix, Astro SSR | Runs npm `start`/`serve` with prod deps |
| `AddNextJsApp(name, path)` | First-class Next.js | Auto-configures standalone publish — set `output: "standalone"` in `next.config.js` |
| `AddViteApp(name, path)` | Vite dev server | Pair with `PublishAsStaticWebsite` (SPA) or `PublishAsNodeServer` (TanStack Start, SvelteKit) |

```csharp
// Next.js (first-class)
builder.AddNextJsApp("web", "./web");

// Vite SPA with reverse-proxy to API
var api = builder.AddProject<Projects.Api>("api");
builder.AddViteApp("web", "./web")
    .WithReference(api)
    .PublishAsStaticWebsite(apiPath: "/api", apiTarget: api);

// SSR (TanStack Start, SvelteKit)
builder.AddViteApp("web", "./web")
    .PublishAsNodeServer(entryPoint: ".output/server/index.mjs",
        outputPath: ".output");
```

TypeScript AppHosts now have first-class **Bun, Yarn, and pnpm** support (npm remains default).
TS AppHosts can also build Dockerfiles programmatically with `WithDockerfileBuilder` /
`AddDockerfileBuilder` (experimental, diagnostic
[`ASPIREDOCKERFILEBUILDER001`](https://aspire.dev/diagnostics/aspiredockerfilebuilder001/)).

## Azure 13.3 Integrations

```csharp
// Azure Front Door — global edge in one API call
builder.AddAzureFrontDoor("frontdoor")
    .WithOrigin(api)
    .WithOrigin(web);

// Network Security Perimeter (Enforced or Learning mode)
var nsp = builder.AddNetworkSecurityPerimeter("my-nsp")
    .WithAccessRule(new AzureNspAccessRule
    {
        Name = "allow-my-ip",
        Direction = NetworkSecurityPerimeterAccessRuleDirection.Inbound,
        AddressPrefixes = { "203.0.113.0/24" }
    });
builder.AddAzureStorage("storage").WithNetworkSecurityPerimeter(nsp);
builder.AddAzureKeyVault("kv").WithNetworkSecurityPerimeter(nsp);

// Foundry Prompt Agent (replaces removed AddAndPublishPromptAgent)
builder.AddPromptAgent(/* ... */);

// Private endpoints on ACR / OpenAI / Foundry
builder.AddAzureContainerRegistry("acr").WithPrivateEndpoint();
```

Other 13.3 Azure deployment quality-of-life:
- Endpoints on Azure App Service auto-upgrade HTTP→HTTPS.
- Tune slow auth via `Azure:CredentialProcessTimeoutSeconds` config.
- Multi-environment deploys **require explicit** `WithComputeEnvironment` per resource — prevents accidental cross-environment leakage.
- Deployment summaries print **clickable Azure Portal links** for each provisioned resource.

## Docker Compose (13.3)

- **Podman** is supported out of the box — Aspire detects Podman and generates `podman-compose`-compatible files.
- **Privileged mode** for low-level networking utilities or nested containers:

```csharp
builder.AddContainer("netshoot", "nicolaka/netshoot")
    .PublishAsDockerComposeService((resource, service) =>
    {
        service.Privileged = true;
    });
```

## ⚠️ No External Tooling Required

| Myth | Reality |
|------|---------|
| ~~Needs azd~~ | Aspire has its own pipeline |
| ~~Needs azure-prepare skill~~ | AppHost IS the deployment plan |
| ~~Needs Bicep CLI installed~~ | Aspire includes Bicep compiler |
| ~~Needs azure-deploy skill~~ | `aspire deploy` handles everything |
| ~~Needs `kubectl apply`~~ | `aspire deploy` runs Helm install end-to-end (13.3) |
| ~~Needs `helm install`~~ | Aspire generates and applies the chart |

> **Note**: Container targets need a runtime (Docker or Podman). Kubernetes/AKS targets need
> cluster credentials (`az aks get-credentials`, kubeconfig). Aspire just stops you from invoking
> the underlying tools by hand.
