---
name: aspire-project-v2-migration
description: >-
  **WORKFLOW SKILL** - Safely migrates eligible Aspire 13.6+ AppHosts from legacy
  ProjectResource APIs to experimental DotnetProjectResource APIs after a
  per-resource assessment and explicit approval of exact edits.
  USE FOR: assess or migrate existing AddProject, addProject, AddCSharpApp,
  addCSharpApp, or AddBlazorGateway resources to Project v2; migrate
  ProjectResource to DotnetProjectResource; clean up the resulting obsolete
  AppHost ProjectReference edges.
  DO NOT USE FOR: upgrading Aspire versions, creating/wiring a new AppHost,
  Azure Functions migration, generic source modernization, ordinary C# resource
  wiring or adding a new AddProject resource (use aspireify), publishing,
  or build/lifecycle diagnostics.
  INVOKES: Aspire docs/API lookup, aspire add/restore/start/wait, AppHost and package edits.
  FOR SINGLE OPERATIONS: Assess first; never edit from a generic migration request alone.
license: MIT
metadata:
  author: Microsoft
  version: "0.0.7"
---

# Aspire Project v2 migration

Migrate supported legacy .NET project resources to the experimental
`DotnetProjectResource` model without silently changing application behavior.
This skill first applies to AppHosts targeting **Aspire 13.6 or newer**.

> **Approval boundary:** A request such as "migrate to Project v2" authorizes an
> assessment, not unseen edits. Present the exact per-resource and per-file plan,
> then obtain approval before changing AppHost, package, project-reference, or
> application files. Apply only explicitly approved subsets.

## Hard gates

1. Identify one exact AppHost and preserve unrelated local changes.
2. Resolve the AppHost's actual Aspire SDK/hosting version from project files,
   central package management, file directives, or resolved polyglot configuration.
3. Stop without edits if versions are older than 13.6, unresolved, or conflicting.
   Do not infer eligibility from the Aspire CLI version, .NET SDK, or service
   `TargetFramework`, and do not upgrade Aspire implicitly.
4. Verify the installed/resolved packages expose every needed API, including
   `AddDotnetProject`, publishing, EF, and Blazor capabilities used by the app.
   Development packages are development-build evidence, not released-package evidence.
5. Never manually edit generated `.aspire/modules/` files.
6. Use `aspire docs search` and `aspire docs api search ... --language
   csharp|typescript` before relying on unfamiliar or preview API shapes.
7. For TypeScript, require the resolved generated `addDotnetProject(name, path,
   options?: DotnetProjectOptions)` API with a flat DTO. Older handle-only target
   builds are a capability stop, not a second supported migration path.
   Legacy source `ProjectResourceOptions` values remain RPC handles.

The publishing and TypeScript options changes are merged upstream, but a 13.6
version label alone does not prove that a consumer's packages contain them.
See [compatibility-and-validation.md](references/compatibility-and-validation.md)
for the merged API baseline and publishing boundaries.

## Project-Local Skill Override

If `.agents/skills/aspire-project-v2-migration/SKILL.md` exists, check `aspire --version`.
On Aspire 13.6 and earlier, warn the user and defer to that project-local skill while
retaining these safety gates. On Aspire 17.0 and later, treat the copy as stale unless the
user says they maintain it. Use this skill, tell the user the copy is stale, and suggest
`aspire doctor`, which lists each copy and explains how to remove it.

## Workflow

### 1. Inventory actual behavior

Keep the assessment read-only in the application workspace. Inspect source and
already-resolved metadata; do not restore, build, run, or regenerate SDK files
before approval, even for capability discovery. If preparation is necessary to
verify eligibility or APIs, describe that prerequisite and request approval for
it rather than silently modifying the workspace.

Inspect the selected AppHost and every legacy candidate:

- `AddProject<Projects.T>`, path/directory `AddProject`, `AddCSharpApp`, and
  polyglot equivalents.
- Documented Blazor gateway patterns and attached EF operations.
- Names, paths, options, application arguments, environment callbacks, endpoints,
  launch settings, references, waits, health checks, replicas, build/publish
  configuration, and deployment annotations.
- AppHost `ProjectReference` / file-based `#:project` edges and every consumer of
  generated project metadata. Resolve `Projects.*` through real
  `IProjectMetadata`, project-reference metadata, and
  `AspireProjectMetadataTypeName`; never guess a path from a type name.
- Custom code coupled to `ProjectResource`, including casts, constraints,
  `GetProjectResources()`, publishers, image managers, direct constructors, or
  specialized subclasses.
- SDK selection, custom build properties, build-only requirements, file-app AOT
  settings, and existing local changes.
- For Blazor gateway publishing, the effective before/after target framework,
  SDK, runtime/base image and OS/platform, process user, working directory,
  entrypoint, and port configuration. The AppHost's target framework does not
  establish the packaged gateway file app's publishing framework.

An already migrated app or an app with no matching resources is a no-op.

### 1a. Fresh polyglot worktree / capability bootstrap

Missing `.aspire/modules/` and resolved integration metadata in a fresh TypeScript
or other polyglot worktree is normal, git-ignored generated state, not missing
application source or an Aspire defect. Do not treat online docs or a version
label as proof of the installed API.

1. Request bounded preparation approval for restoring the **unchanged exact AppHost once**.
   Name its working directory, command, existing SDK/integration pins and channel,
   and expected restore downloads/cache/generated-file writes. Guest restore can
   also run package-manager installs, update lockfiles and execute lifecycle scripts
   with their own side effects. Inspect package-manager configuration and scripts
   read-only; disclose those effects and obtain explicit approval before restoring.
   Resolve the effective config root, including ancestor settings. If it has legacy
   `.aspire/settings.json` but no `aspire.config.json`, restore can create
   `aspire.config.json` there before SDK generation, even if restore later fails.
   Name that exact configuration path and obtain approval for its creation; generic
   cache/generated-file approval is insufficient. Also disclose local integration
   builds and their MSBuild targets when present. Keep assessment read-only while
   waiting; no integration additions or migration edits are included. If any
   required effect is outside approval, stop and request the missing permission.
2. Only after that approval, run the exact scoped restore. For a selected
   `apphost.mts`, from its directory:

   ```powershell
   aspire restore --apphost .\apphost.mts --non-interactive
   ```

   Use the actual selected entry point, not another AppHost. After either outcome,
   inspect and report actual config/lockfile/script/build effects within the approved
   scope, including changes left by failure; do not silently undo them or claim the
   workspace is unchanged. If restore fails, stop
   and report the exact failed command, working directory, exit code and actual
   diagnostic **in the answer**, not merely a promise to report them. For the
   `IntegrationRestore.csproj` SourceLink `SourceRoot.RevisionId` invalid-commit-hash
   failure with a valid 64-character SHA-256 revision, identify
   [microsoft/aspire#21735](https://github.com/microsoft/aspire/issues/21735), not
   missing application source. State that capability verification remains blocked:
   no retries, generated-target edits, SourceLink suppression or toolchain changes.
3. On success, inspect the resolved integration graph and generated API read-only
   within the user's permitted scope. A successful restore is not capability proof.
   Restoring existing integrations may not expose `addDotnetProject` when
   `Aspire.Hosting.Dotnet` is not referenced. That is not yet a handle-only API
   failure. Request a separately approved capability probe using the supported
   add/restore flow in a disposable copy, preserving the app's pins and channel.
   Follow the [bounded probe and failure rules](references/compatibility-and-validation.md#bounded-polyglot-capability-probe).
4. Require the resolved `addDotnetProject(name, path, options?)` with flat `DotnetProjectOptions`
   and every other needed capability. Missing/older APIs remain a capability stop.
   Once verified, return to **Classify and propose** (workflow step 2) for the exact
   per-resource/per-file plan and request migration-edit approval; never copy probe
   edits into the application as preparation.

Preparation approval is not migration-edit, runtime, or publish approval. Run only
the approved preparation; never hand-edit generated modules or upgrade implicitly.
For an offline restore plan, describe both conditional outcomes without executing
either: failure reporting and the read-only success handoff, including separately
approved disposable probing if Dotnet is absent. If the user limits the task to
the restore alone, leave capability inspection pending rather than extending the
task. Never turn a plan or a failure report into permission for additional actions.

### 2. Classify and propose

Present a table before editing:

| Resource | Current API and source | Proposed replacement | Behavior retained / intentional change | Package and reference edits | Classification |
|---|---|---|---|---|---|
| `api` | `AddProject<Projects.Api>` → resolved path | `AddDotnetProject("api", path)` | args, profiles, endpoints, env, refs, waits, replicas, publishing | add `Aspire.Hosting.Dotnet`; remove only proven-exclusive edge | supported / decision / unsupported |

Explain:

- `ASPIREDOTNETPROJECT001` is an experimental API diagnostic.
- Project v2 resources have executable-based identity and coordinated initial builds.
- Known publishing or validation differences, especially Blazor gateway publishing,
  EF custom build inputs, and cross-OS file-app Native AOT.
- Exactly which files and resource subset would change and which legacy resources
  would remain.

Ask for approval of that exact plan. Do not migrate a "safe-looking" subset until
the subset and retained resources are explicitly approved.

For a Blazor gateway, approval of the API replacement or "Dockerfile to SDK"
switch alone is not approval of an implicit framework, base-image, or process-user
change. List the resolved deployment differences and obtain explicit approval
for them before editing. Briefly explain runtime/OS compatibility and non-root
file/volume-permission implications; a list of changed values alone is not informed
approval. If those values cannot be established read-only, classify
the gateway as decision-required and request approval for the preparation needed
to resolve them. Do not invent defaults or assume deployment equivalence.
Preserve exact prerelease identifiers from the resolved evidence when reporting
or requesting approval: for example, say `.NET 11 RC1` and `11.0.0-rc.1`, not
the less specific `.NET 11 RC` or `11.0 prerelease`. Approval applies to the
specific resolved runtime and image, not merely its release channel.
End that assessment with the gateway decision: request approval for specific
bounded discovery, or ask whether to retain the gateway/review an owned publishing
policy. Asking only about API edits does not resolve the gateway approval boundary.

Before sending an assessment with an unresolved gateway, check the final question:
it must explicitly ask the user to choose gateway bounded discovery or gateway
retention plus owned publishing-policy review. Never end with only API-edit
approval while the gateway is still decision-required.

End the assessment with an actual approval request, not just a description of
what approval would mean. Use the host's user-question tool when available;
otherwise ask explicitly whether the user approves the listed resource and file
changes. Wait for the answer before editing. An unavailable user is not approval.

After approval, capture the legacy behavior in a disposable copy when validation
is authorized and feasible. Use the same qualified toolchain before and after;
report pre-existing failures rather than attributing them to the migration.

### 3. Apply approved mappings

Load [migration-patterns.md](references/migration-patterns.md) and follow its exact
language-specific mappings.

- Add `Aspire.Hosting.Dotnet` at a version compatible with the already-targeted
  AppHost, preserving central package management and repository conventions.
- For TypeScript, use the flat `DotnetProjectOptions` object. Preserve the
  established values from legacy source; do not redesign `addProject`,
  `addCSharpApp`, or the shared `ProjectResourceOptions` handle.
- Use the Aspire CLI's normal integration acquisition/regeneration flow when
  available; do not hand-edit generated SDK modules.
- Preserve fluent configuration and application arguments in their original
  runtime role.
- Update only straightforward local `IResourceBuilder<ProjectResource>` annotations
  tied to approved resources. Do not broadly rewrite public/custom contracts.
- C# migrations **must** handle `ASPIREDOTNETPROJECT001` narrowly so the edited
  AppHost compiles. Prefer paired `#pragma warning disable
  ASPIREDOTNETPROJECT001` / `#pragma warning restore
  ASPIREDOTNETPROJECT001` immediately around the approved Project v2 declarations.
  Use a project-level `NoWarn` only when repository convention and the approved
  migration scope make that equally narrow. Never suppress unrelated diagnostics
  or leave an unbounded disable.
  The `AddEFMigrations` overload selected for `IDotnetProgramResource` also requires
  a paired `ASPIREPROJECTS001` suppression around that EF declaration; the legacy
  overload did not. Include this compilation-required edit in the approval scope.
  Preserve existing `ASPIREBLAZOR001` scopes where the client/gateway calls need them.

### 4. Clean project references conservatively

Remove an AppHost `ProjectReference` or `#:project` only when it is proven to exist
exclusively for approved migrated resources and no generated metadata consumer
remains. Retain:

- code/library references and service-to-library references;
- edges used by unmigrated resources, EF migration metadata, Blazor WASM metadata,
  conditional code, or other `Projects.*` consumers;
- ambiguous references and build-only edges whose intent is not established.

`ReferenceOutputAssembly="false"` does not prevent an AppHost reference from
participating in the build and is not a substitute for safe cleanup.

### 5. Preserve build and runtime intent

Keep runtime `WithEnvironment` values at runtime. Add `WithBuildEnvironment` only
for an established, approved MSBuild input; never move environment configuration
wholesale or treat runtime working directory as build context.

Use `WithContainerBuildOptions` for supported image identity, destination, format,
and target-platform settings. Do not translate those settings into prohibited
build-environment properties.

### 6. Validate and report

After approved edits:

1. Restore/build through repository conventions.
2. Start the exact AppHost with `aspire start --non-interactive --isolated
   --apphost <path>` when isolation is needed.
3. Use `aspire wait <resource> --apphost <path> --non-interactive` and structured
   Aspire inspection, not manual polling.
4. Validate preserved names, paths, arguments, environment, endpoints, references,
   waits, replicas, launch profiles, and publishing intent.
5. Separate compile, local-run, generated publish artifacts, and image-build
   evidence. `aspire publish` is not proof that an image was built. Run only the
   authorized validation stages; never push images or deploy as an implicit check.
   Do not claim unexecuted, skipped, or unavailable checks passed.
   For approved gateway image changes, verify the exact accepted target contract
   and unchanged behavior separately. Report the intentional differences, not
   "image parity"; a smoke-test pass does not authorize new framework/user changes.
6. Run the migration assessment again to prove idempotence: no duplicate package,
   resource, suppression, or configuration edits.

Report migrated, intentionally retained, and blocked resources, plus actual
validation and manual follow-up. Preserve the user's edits if validation fails.

## Compatibility boundaries

Load [compatibility-and-validation.md](references/compatibility-and-validation.md)
for the full decision matrix. Never automatically replace:

- Azure Functions or unknown specialized `ProjectResource` subtypes;
- F# or Visual Basic services;
- direct `new ProjectResource(...)`;
- custom publishers, image managers, casts, generic constraints, or
  `GetProjectResources()` consumers without a user decision;
- file-app build-only environment or file-app EF CLI operations.

`IDotnetProgramResource` is an identity marker. It does not by itself configure
publishing; `SupportsDotnetProgramPublishing()` is a capability check, not a reason
to rewrite every `ProjectResource` constraint.

For every file-based `.cs` candidate, the assessment must explicitly state that
it requires .NET 10+, does not support `WithBuildEnvironment` or EF CLI
operations, keeps runtime `WithEnvironment` values unchanged, and preserves
Native AOT unless the user separately approves `PublishAot=false` or chooses a
target-OS publishing environment.

Do not disable file-app Native AOT, replace a custom publishing model, or promise
unfinished watch/hot-reload/partial-run behavior without explicit evidence and
approval.

## Routing

| Request | Route |
|---|---|
| Migrate legacy project resources to Project v2 | This skill |
| Upgrade Aspire packages or CLI only | `aspire-orchestration` |
| Create or wire an AppHost | `aspire-init` / `aspireify` |
| Start, stop, wait, or rebuild only | `aspire-orchestration` |
| Deploy or publish after migration | `aspire-deployment` |
| Diagnose runtime behavior | `aspire-monitoring` |
