# Aspire 13.4 Breaking Changes — Agent Reference

Single, agent-facing scrub list of every 13.4 breaking change that may affect agent-generated
code, scripts, CI snippets, deployment guidance, or skill routing. Source:
[Aspire 13.4 release notes](https://aspire.dev/whats-new/aspire-13-4/#breaking-changes).

> Use this page when reviewing AppHost code, CI YAML, shell snippets, deployment code, or
> TypeScript AppHost examples for 13.4 compatibility. Agents must scrub for these patterns
> before recommending or generating code.

## Quick scrub table

| Change | Migration |
|--------|-----------|
| `aspire exec` command removed, including its AppHost backchannel and feature flag | Remove scripts / workflows that call `aspire exec`; use `aspire resource <name> <command>` when the resource exposes a command. |
| `aspire ps` no longer accepts `--resources` / `--include-hidden` | Use `aspire describe --follow --apphost <path>` when hidden resources or full model details are required. |
| Generated TypeScript modules consolidated under `.aspire/modules/` | New TypeScript AppHosts import from `.aspire/modules/`; legacy `apphost.ts` projects keep `./.modules/` for compatibility. Update tooling and `.gitignore` entries. |
| Persistent executable/project lifetimes add DCP `persistent`, `start`, and `stop` fields | Review tooling pinned to the old executable schema. Persistent resources are proxyless by default, need concrete ports, do not support replicas, and are not compatible with IDE debugging. |
| Kubernetes `Ingress.WithRoute(...)` → `WithPath(...)`; `IngressPathType` split | Rename Ingress call sites and use `KubernetesIngressPathType` for Ingress or `KubernetesGatewayPathType` for Gateway API. Gateway `WithRoute(...)` is unchanged. |
| Kubernetes ingress/gateway routes now require external endpoints | Call `WithExternalHttpEndpoints()` on resources routed through ingress or gateway; otherwise publish throws `InvalidOperationException`. |
| Kubernetes Helm config consolidated on `WithHelm(...)` | Move chart name, version, description, release name, and namespace property assignments into the `WithHelm(...)` builder. |
| Azure Front Door uses Azure.Provisioning name generation | Set `Name` explicitly with `ConfigureInfrastructure`, or remove and re-add the resource to avoid duplicate endpoint / origin group / route names in existing deployments. |
| Foundry hosted agents renamed and reshaped | `PublishAsHostedAgent` → `WithComputeEnvironment`; `AddPromptAgent` now takes the resource name before the model; remove `AsHostedAgent` / `RunAsHostedAgent`. |
| `PublishAsNpmPackageScript` → `PublishAsPackageScript` | Rename call sites and change `startScriptName` to `scriptName`; the API now covers npm, pnpm, Yarn, and Bun. |
| Keycloak primary endpoint is HTTPS when the developer certificate is enabled | Update references and tests that assumed an HTTP primary endpoint. |
| `aspire update` requires `--yes` in non-interactive mode | Add `--yes` to non-interactive automation that intentionally updates project packages. |
| Resource-command arguments are named CLI options instead of positional values | Update scripts to pass command inputs as named options, including built-in parameter commands. |
| TypeScript AppHosts are validated before startup | Fix TypeScript / compile errors before `aspire start`; invalid AppHosts fail earlier than before. |
| `Aspire.Hosting.Testing` `CreateHttpClient` / `GetEndpointUriString` prefer HTTPS by default | Pass an explicit endpoint name when tests relied on the previous HTTP-first behavior. |
| Default RabbitMQ image moved from 4.2 to 4.3 | Fix transient non-exclusive queue declarations or pin a compatible image tag temporarily. |
| Default PostgreSQL image moved from 17.6 to 18.3; PG18's on-disk layout is **incompatible** with a PG17 `WithDataVolume()` data volume (container fails to start) | Pin `WithImageTag("17.6")` **before** `WithDataVolume()` to keep using the existing volume, or plan a dump/restore migration to PG18. See [PostgreSQL 18 data-volume incompatibility](#postgresql-18-data-volume-incompatibility). |
| `AddNatsClient` now registers `INatsClient` and a default serializer registry | Review DI and serializer-registry assumptions; user-provided registries still take precedence. |

## Kubernetes route and Helm migration

Kubernetes route APIs became stricter and more explicit in 13.4:

- Replace `ingress.WithRoute(...)` with `ingress.WithPath(...)`.
- Replace direct `IngressPathType` references with `KubernetesIngressPathType` for Ingress
  resources or `KubernetesGatewayPathType` for Gateway API resources.
- Leave Gateway API `gateway.WithRoute(...)` calls unchanged.
- Mark routed resource endpoints external with `WithExternalHttpEndpoints()` before publishing.
  Aspire now throws `InvalidOperationException` at publish time when an ingress or gateway
  route targets a non-external endpoint.
- Move Helm chart metadata from parallel `KubernetesEnvironmentResource` properties into
  `WithHelm(...)`.

## Foundry hosted-agent migration

Foundry hosted-agent APIs were aligned with the rest of the app model:

- Replace `PublishAsHostedAgent(...)` with `WithComputeEnvironment(...)`.
- Update `AddPromptAgent(...)` so the resource **name** is the first argument, before the
  model.
- Remove `AsHostedAgent()` and `RunAsHostedAgent()` call sites; those preview-only helpers are
  no longer available.

## TypeScript and JavaScript AppHost migration

New TypeScript AppHosts use `apphost.mts` and generated modules under `.aspire/modules/`.
Existing `apphost.ts` projects continue to use the legacy `./.modules/` layout for
compatibility when no `apphost.mts` is present, so do not rewrite legacy imports unless the
project is intentionally migrating.

For JavaScript package publish helpers, replace `PublishAsNpmPackageScript(...)` with
`PublishAsPackageScript(...)` and rename the `startScriptName` parameter to `scriptName`. The
new API covers npm, pnpm, Yarn, and Bun.

If a TypeScript AppHost is on Aspire 13.3.x, update the CLI with `aspire update --self`
before running `aspire update`; the 13.3.x CLI cannot load the 13.4 TypeScript code generator.

## PostgreSQL 18 data-volume incompatibility

The default PostgreSQL container image moved from **17.6** to **18.3**. PostgreSQL 18 changed
the on-disk data layout, so a `WithDataVolume()` data volume created on PostgreSQL 17 (Aspire
13.3 or earlier) is **incompatible** after upgrading — the container fails to start on the next
run with a data-directory version mismatch.

Two safe paths:

- **Stay on 17 (no migration):** pin the image tag back before declaring the data volume so the
  existing volume keeps working.

  ```csharp
  builder.AddPostgres("pg")
      .WithImageTag("17.6")
      .WithDataVolume("pg-data");
  ```

- **Move to 18 (migrate the data):** `pg_dump` from a temporary 17.6 container, start the 18.3
  container against a fresh volume, then `pg_restore`. Don't point the new image at the old
  volume directory.

This only affects **persisted** data volumes. Ephemeral databases (no `WithDataVolume()`) pick
up 18.3 automatically with no action.

## Migration from Aspire 13.3 to 13.4

Mirror of the upstream checklist plus the items above. Run through each step before
recommending Aspire-related changes against an existing repo.

1. **Update the CLI** — run `aspire update --self`. This is required before `aspire update`
   for TypeScript AppHosts on 13.3.x.
2. **Update your projects** — run `aspire update` from the repo root. In non-interactive
   automation, pass `--yes` only when the user has approved package-reference changes.
3. **Run `aspire doctor`** to check environment setup and spot conflicting CLI installs.
4. **Audit scripts and CI** for removed or changed commands: `aspire exec`,
   `aspire ps --resources`, `aspire ps --include-hidden`, positional resource-command
   arguments, and non-interactive `aspire update` calls without `--yes`.
5. **Review TypeScript AppHosts** for `.aspire/modules/` vs legacy `./.modules/` imports,
   TypeScript validation failures, and publish-script API renames.
6. **Update Kubernetes deployment code** — move Helm chart properties into `WithHelm(...)`,
   rename Ingress `WithRoute(...)` to `WithPath(...)`, use the split path-type enums, and mark
   routed endpoints external with `WithExternalHttpEndpoints()`.
7. **Update renamed APIs** — `PublishAsNpmPackageScript` → `PublishAsPackageScript`,
   `startScriptName` → `scriptName`, Foundry `PublishAsHostedAgent` →
   `WithComputeEnvironment`, and the new `AddPromptAgent` parameter order.
8. **Review Azure Front Door deployments** and set explicit names or re-add resources if
   existing endpoint / origin group / route names conflict with Azure.Provisioning generation.
9. **Review endpoint assumptions** — Keycloak's primary endpoint is HTTPS when the developer
   certificate is enabled, and `Aspire.Hosting.Testing` now prefers HTTPS when no endpoint name
   is supplied.
10. **Review integration behavior** — RabbitMQ defaults to image 4.3; the PostgreSQL default
    moves to 18.3 and breaks PG17 `WithDataVolume()` volumes (pin `WithImageTag("17.6")` or
    migrate); `AddNatsClient` registers `INatsClient` plus a default serializer registry; and
    persistent executable/project lifetimes have new DCP schema fields and endpoint constraints.
