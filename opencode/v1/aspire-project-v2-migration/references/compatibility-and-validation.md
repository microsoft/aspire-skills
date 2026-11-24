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

Check the exact capabilities required by each candidate. The supported source
baseline includes both merged changes:

- [Project v2 publishing, EF, and Blazor support](https://github.com/microsoft/aspire/pull/19997).
- [Flat polyglot `DotnetProjectOptions`](https://github.com/microsoft/aspire/pull/20157).

[Commit `f856e006`](https://github.com/microsoft/aspire/commit/f856e006130459c4e11ed8cecd0b09e7e3873311)
contains both. This is source provenance, not a minimum published package version:
earlier 13.6 development builds can lack either capability. Verify the resolved
package/generated API or a known matching build; edit approval and package
declarations alone are not capability evidence.

### Bounded unchanged-AppHost restore

Before requesting preparation approval, keep the assessment read-only. Name the
exact AppHost, working directory, command, existing SDK/integration pins and
channel, and expected downloads, cache and generated-file writes. Inspect
package-manager configuration, npm integration hosts, and lifecycle scripts
read-only. Guest restore can run package-manager installs, update lockfiles and
execute lifecycle scripts with side effects. Name the affected host paths,
disclose these effects and local integration builds and their MSBuild targets,
and obtain explicit approval before restoring. If any required effect lies
outside approval, stop and request the missing permission.

Resolve the effective config root, including ancestor settings. If it has legacy
`.aspire/settings.json` but no `aspire.config.json`, restore can create
`aspire.config.json` there before SDK generation, even if restore later fails.
Name that exact configuration path and obtain explicit approval for its
creation; generic cache/generated-file approval is insufficient.

After approval, run only the selected unchanged AppHost's restore once; no
integration additions or migration edits are included. For a selected
`apphost.mts`, from its directory:

```text
aspire restore --apphost apphost.mts --non-interactive
```

After either outcome, inspect and report actual config, lockfile, script and
build effects within the approved scope, including changes left by failure. Do
not silently undo them or claim the workspace is unchanged.

For an offline restore plan, describe both conditional outcomes without executing
either or claiming they happened: report failure and stop, or on success inspect
resolved capabilities read-only within the user's permitted scope, with separately
approved disposable probing if Dotnet is absent. If the user permits restore only,
leave capability inspection pending. Neither outcome authorizes an in-place
integration addition or execution of a disposable probe.

### Bounded polyglot capability probe

Restoring existing integrations may not expose `addDotnetProject` when
`Aspire.Hosting.Dotnet` is absent; that alone does not establish a handle-only
API. If an approved unchanged-AppHost restore succeeds but the Dotnet integration
is absent, request separate approval for a disposable-copy probe, not package
changes in the application. Identify the copy location, exact AppHost,
integration/version to add, commands, expected downloads/generated writes, and
cleanup scope. The approval request must explicitly preserve the exact AppHost,
SDK/integration pins, channel and package feeds; merely saying configuration will
be copied is insufficient. Disclose package-manager installs, possible lockfile updates and
lifecycle-script effects, legacy configuration creation and local
integration/MSBuild execution. Obtain approval for those effects, not only cache
and generated SDK writes.

- Preserve the pinned SDK, integrations, channel and feeds, including effective
  `global.json`, NuGet and package-manager configuration and relevant ancestor
  settings. Name these invariants explicitly in the approval request, not merely
  the copied configuration. A copy outside those settings must carry equivalent configuration;
  otherwise it is not evidence for this app. Do not switch to latest/stable or
  use another SDK merely to make the probe pass.
- Before add/restore, resolve and verify a **copy-owned effective config**:
  place equivalent `aspire.config.json` inside the approved copy, preserve all
  pins/channel/settings and rebase relative paths to the copied inputs. Do not
  rely on an original ancestor config: `aspire add` can save the package to that
  ancestor even when the AppHost itself was copied. Resolve upward from the
  copied entry point and verify the config's real path is inside the copy, not a
  symlink to the original. Legacy settings migration must likewise write only
  to an explicitly approved copy-owned config path.
- Resolve every local integration project path and its transitive build inputs
  (project references, imported props/targets and relevant ancestor settings).
  Include that local integration closure in the approved copy with equivalent
  path relationships. Verify real paths, including symlink targets, before
  execution: a relative reference can still reach an original project and run
  its MSBuild targets. If any build input remains outside the copy, stop for
  separate approval naming the external project/paths and build effects, or
  expand the approved copy; disposable-probe approval alone does not permit
  external builds. Do not drop integrations or rewrite their behavior to pass.
- Resolve each declared npm integration host directory too: restore runs
  `npm install` in each host, which can update lockfiles and run lifecycle
  scripts. Copy those hosts and their required inputs/configuration into the
  approved copy, rebase references and verify real paths before execution.
  If any npm host remains outside the copy, stop for separate approval naming
  its exact paths and install, lockfile and lifecycle-script effects, or expand
  the approved copy. Probe approval does not authorize effects in original hosts.
- Confirm targeting/version/source flags with the selected CLI's `aspire add --help`
  and `aspire restore --help`. Use its supported add/restore flow **only in the
  approved copy**: for example, where supported,
  `aspire add Aspire.Hosting.Dotnet --version <compatible-pinned-version> --apphost <copied-apphost-path> --non-interactive`,
  then restore the copy's exact AppHost. Keep existing integration pins unchanged;
  if a matching package cannot be resolved without upgrades, stop for a decision.
- Inspect the resulting package graph and generated declarations for the flat
  `addDotnetProject(name, path, options?: DotnetProjectOptions)` contract and the
  other APIs required by the selected resources. A successful restore alone is
  not capability proof. Record the resolved versions and declaration evidence.
- Do not copy probe changes back. Clean up only the task-owned copy as approved,
  then present the exact application resource/file/package plan for migration-edit
  approval. Preparation never authorizes starting resources or publishing.

At either restore failure, report the command, exit code and actual diagnostic,
including the working directory and exact failed command in the final answer.
Quote the actual diagnostic rather than only telling the user to report it;
distinguish a user-supplied offline result from a command you executed.
Preserve application source and integration pins. Report any approved
configuration migration, lockfile updates, script or build effects that already
occurred, including on failure; do not claim source/configuration stayed unchanged
merely because restore failed, and do not silently revert those effects.
In particular,
`IntegrationRestore.csproj` can fail with a SourceLink `SourceRoot.RevisionId`
invalid-commit-hash error for a valid 64-character SHA-256 Git revision. This is
the upstream failure tracked by [microsoft/aspire#21735](https://github.com/microsoft/aspire/issues/21735),
not proof that application source or the generated SDK is missing. Preserve that
diagnostic and stop; do not retry unchanged commands or edit generated targets.
Never add blanket SourceLink suppression or silently change toolchains to bypass it.
Explicitly state that toolchains remain unchanged and capability verification is
blocked; restore approval does not authorize package/migration edits or runtime
and publish actions.

## Unsupported and decision-required patterns

| Pattern | Required response |
|---|---|
| Azure Functions or unknown specialized `ProjectResource` subtype | Unsupported automatic migration. Preserve subtype-specific storage, launch, environment, references, and deployment. |
| F# `.fsproj` or VB `.vbproj` | Assessment only; do not treat Project v2 as a general replacement. |
| Direct `new ProjectResource(...)` | Manual design. `DotnetProjectResource` needs metadata, defaults, coordinated-build wiring, and publishing opt-in supplied by the builder API. |
| `GetProjectResources()`, casts, concrete generic constraints | Identify every call site and request a design decision. Do not replace wholesale with `IDotnetProgramResource`. |
| Custom publisher or image manager | Verify executable identity and `SupportsDotnetProgramPublishing()` capability; preserve or redesign only with approval. |
| Blazor gateway with changed or unresolved publishing defaults | Require explicit approval of resolved framework, SDK/base image/OS, and process-user changes. Generic API or SDK-publishing approval is insufficient; unknown values require approved discovery, not assumed parity. |
| File `.cs` app + build-only environment | Unsupported; do not invent an equivalent. |
| File `.cs` app + EF CLI | Unsupported. |
| EF + custom build properties | Warn that `dotnet-ef` does not receive those custom global properties. |
| Ambiguous project directory or metadata mapping | Stop; require an unambiguous path. |
| Build-only setting with unclear intent | Preserve current behavior and request approval before introducing `WithBuildEnvironment`. |
| Unsupported AppHost language | Assessment/manual guidance only. |
| TypeScript generated API exposes flat `DotnetProjectOptions` | Use the flat third argument for values proven from legacy source or resolved handle accessors. |
| TypeScript target API still requires a `ProjectResourceOptions` handle | Capability stop. Do not emit a plain object, silently discard options, or maintain an older-preview migration path. |

## Publishing boundaries

- Resources added through `AddDotnetProject` opt into .NET SDK publishing.
  Directly constructing the resource does not.
- Preserve supported `WithContainerBuildOptions` identity, destination, archive
  format, and platform settings.
- Preserve an explicit `PublishAsDockerFile()` override and its Dockerfile build
  ownership, including a callback's `WithDockerfile(contextPath, dockerfilePath)`.
  Dockerfile image identity uses the container callback's `WithImage(name, tag)`
  after `WithDockerfile`; `WithContainerBuildOptions.LocalImageName/LocalImageTag`
  control SDK publishing, not Dockerfile build identity.
  Preserve an existing prebuilt `ContainerImageAnnotation` applied through
  `WithAnnotation(..., ResourceAnnotationMutationBehavior.Replace)`: without a
  Dockerfile build annotation it must not acquire SDK build/push steps.
  Preserve any publish-only guard around that annotation: applying it in run mode
  can make DCP treat the project as a container for endpoint/target-port validation.
  Do not invent a project-specific `WithContainerImage`/`WithImage` overload or
  combine prebuilt ownership with `PublishAsDockerFile`. These supported cases
  are distinct from arbitrary custom publishers coupled to `ProjectResource`.
- The Project v2 Blazor gateway uses .NET SDK publishing rather than the legacy
  custom Dockerfile. Treat this as an approval-required intentional difference.
  Compare its effective target framework and SDK, runtime/base image and OS/platform,
  process user, working directory, entrypoint and ports before approving the change.
  The legacy image tag is selected from the AppHost runtime and the package's
  stamped image version; the v2 file app can instead follow the publishing SDK.
  A newer SDK can therefore change the gateway's runtime major version even when
  the AppHost/client project frameworks remain unchanged. Do not assume root and
  non-root images are interchangeable: writable paths, mounted files and privileged
  ports can be affected.
  If values or consequences are unresolved, retain the gateway pending a decision;
  do not silently choose a base, force root, edit the packaged script, or retarget it.
  A separately approved subset or owned Dockerfile publishing policy is a design
  alternative, not an automatic fallback. Do not use `WithBuildEnvironment` to
  control a file-based gateway: that API supports project files only.
  Its built-in gateway source already sets `PublishAot=false`; do not apply the
  generic file-app AOT warning to that gateway or change the user's client settings.
- File-based apps retain .NET SDK Native AOT defaults. Cross-operating-system
  publishing requires a target-OS build or explicit approval to set
  `PublishAot=false`; never disable AOT silently.
- Do not claim watch, hot reload, partial-run, or debugging improvements unless
  the targeted package actually implements and validation exercises them.

## Validation contract

Compare the actual edited application with a legacy baseline on the same
qualified toolchain where practical. Account for executable-based identity and
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
| Publish | manifest inclusion, generated environment artifacts, selected pipeline, container options, and separately built image/archive |
| Approved gateway image changes | exact accepted framework/runtime, base/OS/platform and process user; entrypoint, directory and ports; all unapproved image settings unchanged |
| References | only proven-obsolete AppHost build edges removed |

Compilation must cover overload changes, not just creation calls.
`AddEFMigrations` on `IDotnetProgramResource` requires a narrow, paired
`ASPIREPROJECTS001` suppression in addition to `ASPIREDOTNETPROJECT001` on Project
v2 creation calls. Preserve necessary existing Blazor diagnostic scopes.

Run the repository's smallest relevant restore/build checks, then validate the
exact AppHost through Aspire:

```text
aspire start --non-interactive --isolated --apphost <path>
aspire wait <resource> --apphost <path> --non-interactive
aspire describe --apphost <path> --include-hidden --format Json --non-interactive
aspire stop --apphost <path> --non-interactive
```

Use orchestration and monitoring guidance for the installed CLI's exact syntax.
Do not substitute `dotnet run` for AppHost lifecycle or manual HTTP polling for
`aspire wait`.

When publish validation is approved, separate these stages:

| Stage | Check |
|---|---|
| Artifact generation | `aspire publish --apphost <path> -o <output> --non-interactive`; compare resource inclusion, configuration, endpoints, references, and target artifacts |
| Image build | `aspire do build --apphost <path> --non-interactive`; inspect the resulting image/archive and preserve build ownership |
| Deployment | Separate authorization; never implicitly push images or provision cloud/cluster resources |

Use `ASPIRE_CONTAINER_RUNTIME=podman` when Podman is the selected runtime; a
Docker shim is not required for Aspire's native Podman path. Validate only
task-owned resources and use distinct output directories/image tags.

Keep raw before/after image evidence. Exact equivalent paths such as `/app` and
`/app/` may be compared semantically, but never scrub runtime versions, image
identity or USER to force equality. With explicit approval, validate and report
the intended target image contract separately from unchanged behavior. A passing
probe does not prove unchanged deployment policy or authorize additional changes.

`--list-steps` avoids executing pipeline actions but still evaluates AppHost code,
step factories, and hosted services. It is not a read-only assessment shortcut.
Inspect custom behavior before running validation; use orchestration guidance to
stop the exact AppHost afterward, without affecting unrelated applications.

## Failure and idempotence

If restore, API lookup, compile, run, or publish validation fails:

- report the exact failed step and evidence;
- preserve migrated and unrelated user edits;
- do not fabricate a fallback API or success;
- do not weaken reference cleanup or disable AOT to make a check pass.

A second assessment after successful migration must produce no duplicate package
references, resources, diagnostic suppressions, or options.
