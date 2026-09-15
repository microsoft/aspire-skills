# Project v2 compatibility and validation

## Eligibility evidence

Resolve the selected AppHost's version from its own configuration:

| AppHost style | Evidence |
|---|---|
| Project-based C# | `Aspire.AppHost.Sdk`, `Aspire.Hosting.AppHost`, central package/version properties, imported props/targets, and resolved package graph |
| File-based C# | `#:sdk`, `#:package`, `#:property`, `global.json`, and resolved directives |
| TypeScript | configured AppHost entry point, package graph, Aspire config, and generated SDK/package resolution (read-only) |

The installed CLI, service target framework, or a neighboring AppHost is not
eligibility evidence. Stop without edits for `<13.6`, unknown, or inconsistent
versions. Never upgrade the AppHost as part of this migration.

Check the exact capabilities required by each candidate. Development work can
contain some Project v2 stages but not others.

## Unsupported and decision-required patterns

| Pattern | Required response |
|---|---|
| Azure Functions or unknown specialized `ProjectResource` subtype | Unsupported automatic migration. Preserve subtype-specific storage, launch, environment, references, and deployment. |
| F# `.fsproj` or VB `.vbproj` | Assessment only; do not treat Project v2 as a general replacement. |
| Direct `new ProjectResource(...)` | Manual design. `DotnetProjectResource` needs metadata, defaults, coordinated-build wiring, and publishing opt-in supplied by the builder API. |
| `GetProjectResources()`, casts, concrete generic constraints | Identify every call site and request a design decision. Do not replace wholesale with `IDotnetProgramResource`. |
| Custom publisher or image manager | Verify executable identity and `SupportsDotnetProgramPublishing()` capability; preserve or redesign only with approval. |
| File `.cs` app + build-only environment | Unsupported; do not invent an equivalent. |
| File `.cs` app + EF CLI | Unsupported. |
| EF + custom build properties | Warn that `dotnet-ef` does not receive those custom global properties. |
| Ambiguous project directory or metadata mapping | Stop; require an unambiguous path. |
| Build-only setting with unclear intent | Preserve current behavior and request approval before introducing `WithBuildEnvironment`. |
| Unsupported AppHost language | Assessment/manual guidance only. |
| TypeScript generated API exposes flat `DotnetProjectOptions` | Option-bearing `addDotnetProject` migration is supported for values proven from legacy source or resolved handle accessors. |
| TypeScript generated API exposes only `Awaitable<ProjectResourceOptions>` | Migrate default-options calls only. Preserve option-bearing resources and report a capability stop. |

## Publishing boundaries

- Resources added through `AddDotnetProject` opt into .NET SDK publishing.
  Directly constructing the resource does not.
- Preserve supported `WithContainerBuildOptions` identity, destination, archive
  format, and platform settings.
- The Project v2 Blazor gateway uses .NET SDK publishing rather than the legacy
  custom Dockerfile. Treat this as an approval-required intentional difference.
- File-based apps retain .NET SDK Native AOT defaults. Cross-operating-system
  publishing requires a target-OS build or explicit approval to set
  `PublishAot=false`; never disable AOT silently.
- Do not claim watch, hot reload, partial-run, or debugging improvements unless
  the targeted package actually implements and validation exercises them.

## Validation contract

Compare behavior before and after where practical. Account for Project v2's
expected hidden coordinated-build resources, but do not broadly scrub the model.

| Area | Verify |
|---|---|
| Identity | user resource names and approved resource set |
| Source | normalized resolved project/file paths and working directories |
| Launch | default/named/excluded profile semantics and application arguments |
| Runtime | environment callbacks and values; evidence-backed option-handle values |
| Networking | endpoints, launch-settings/Kestrel behavior, external exposure; `excludeKestrelEndpoints` stops Aspire model derivation but does not disable service Kestrel configuration |
| Dependencies | service references, endpoint references, waits, completion waits |
| Scale and health | replicas, health checks, lifecycle relationships |
| Build | clean initial build, shared-library build correctness, required SDK |
| Publish | manifest inclusion, selected publishing pipeline, container options |
| References | only proven-obsolete AppHost build edges removed |

Run the repository's smallest relevant restore/build checks, then validate the
exact AppHost through Aspire:

```text
aspire start --non-interactive --isolated --apphost <path>
aspire wait <resource>
aspire describe --apphost <path>
```

Use orchestration and monitoring guidance for the installed CLI's exact syntax.
Do not substitute `dotnet run` for AppHost lifecycle or manual HTTP polling for
`aspire wait`.

For publish checks, distinguish generated-artifact validation from a real
container build and from deployment. Never push images or provision cloud
resources without separate authorization.

## Failure and idempotence

If restore, API lookup, compile, run, or publish validation fails:

- report the exact failed step and evidence;
- preserve migrated and unrelated user edits;
- do not fabricate a fallback API or success;
- do not weaken reference cleanup or disable AOT to make a check pass.

A second assessment after successful migration must produce no duplicate package
references, resources, diagnostic suppressions, or options.
