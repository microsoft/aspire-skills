---
name: aspire-project-v2-migration
description: >-
  **WORKFLOW SKILL** - Safely migrates eligible Aspire 13.6+ AppHosts from legacy
  ProjectResource APIs to experimental DotnetProjectResource APIs after a
  per-resource assessment and explicit approval of exact edits.
  USE FOR: migrate AddProject, addProject, AddCSharpApp, addCSharpApp,
  AddBlazorGateway, ProjectResource to DotnetProjectResource, Project v2,
  coordinated .NET builds, or remove obsolete AppHost ProjectReference edges.
  DO NOT USE FOR: upgrading Aspire versions, creating/wiring a new AppHost,
  Azure Functions migration, generic source modernization, or lifecycle-only work.
  INVOKES: Aspire docs/API lookup, aspire add/restore/start/wait, AppHost and package edits.
  FOR SINGLE OPERATIONS: Assess first; never edit from a generic migration request alone.
license: MIT
metadata:
  author: Microsoft
  version: "0.0.2"
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
7. For TypeScript, inspect the resolved generated `addDotnetProject` signature
   before proposing edits. Migrate option-bearing calls only when that build
   exposes the constructible, flattened `DotnetProjectOptions` DTO. If it still
   accepts only the shared `ProjectResourceOptions` RPC handle, migrate only
   calls that need default options and classify option-bearing calls as a
   capability stop. Never treat the handle as a plain object or assume every
   Aspire 13.6 build contains the DTO.

## Project-Local Skill Override

If `.agents/skills/aspire-project-v2-migration/SKILL.md` exists, warn the user and
defer to that project-local skill while retaining these safety gates.

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

An already migrated app or an app with no matching resources is a no-op.

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

End the assessment with an actual approval request, not just a description of
what approval would mean. Use the host's user-question tool when available;
otherwise ask explicitly whether the user approves the listed resource and file
changes. Wait for the answer before editing. An unavailable user is not approval.

### 3. Apply approved mappings

Load [migration-patterns.md](references/migration-patterns.md) and follow its exact
language-specific mappings.

- Add `Aspire.Hosting.Dotnet` at a version compatible with the already-targeted
  AppHost, preserving central package management and repository conventions.
- For TypeScript options, use the new flat `DotnetProjectOptions` object only
  when the resolved generated API exposes it. Preserve legacy `addProject` and
  `addCSharpApp` call shapes; this migration does not redesign those APIs or the
  shared `ProjectResourceOptions` handle.
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
3. Use `aspire wait <resource>` and structured Aspire inspection, not manual polling.
4. Validate preserved names, paths, arguments, environment, endpoints, references,
   waits, replicas, launch profiles, and publishing intent.
5. Separate compile, local-run, and publish evidence. Do not claim unexecuted,
   skipped, or unavailable checks passed.
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
