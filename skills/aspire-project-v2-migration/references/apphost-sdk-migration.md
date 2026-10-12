# Migrating off Aspire.AppHost.Sdk

## Capability and approval boundaries

SDK removal and Project v2 resource migration are related but separate edits.
Include both in the exact per-file plan when requested; retain the SDK for a
partial migration if remaining resources depend on generated `Projects.*`
metadata. Never infer approval from an `ASPIRE012` warning alone.

The deprecation/package-only defaults are being introduced for Aspire 17 in
[microsoft/aspire#20867](https://github.com/microsoft/aspire/pull/20867).
This is preview source provenance, not proof of a released package or a removal
date. Verify that the application's selected `Aspire.Hosting.AppHost` package
establishes `IsAspireHost` without the SDK and supports its required CLI bundle.
Stop if these capabilities are absent or unresolved; do not upgrade the app
implicitly or inject `IsAspireHost` to hide missing package support.

`Aspire.AppHost.Sdk` remains functional for staged migration, including original
`ProjectReference` resources. Its deprecation does not deprecate `AddProject`.
The CLI version does not establish the app's SDK/package capabilities.

## Approved project changes

For a project-based C# AppHost:

1. Replace the Aspire SDK declaration with unversioned `Microsoft.NET.Sdk`.
   Inspect root SDK attributes, SDK elements, explicit imports and shared props;
   edit the actual owning file, not a duplicate declaration in the project.
   Treat conditional/shared declarations affecting other projects as a decision.
2. Keep or add explicit `Aspire.Hosting.AppHost` and `Aspire.Hosting.Dotnet`
   package references at verified compatible versions. The latter supplies
   `AddDotnetProject`; the former alone does not.
3. Replace only approved resource declarations using the resolved project paths.
   Preserve names, launch options, endpoints, arguments, environment, references,
   waits and integration configuration. Follow the main skill's API/diagnostic
   capability checks instead of assuming every overload has an equivalent.
4. Remove only proven-exclusive resource project references. Retain library,
   build-only and unmigrated-resource edges; do not guess paths from `Projects.*`.

Representative shape, using actual versions from the selected package graph:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Aspire.Hosting.AppHost" Version="$(AspireVersion)" />
    <PackageReference Include="Aspire.Hosting.Dotnet" Version="$(AspireVersion)" />
  </ItemGroup>
</Project>
```

```csharp
var api = builder.AddDotnetProject("api", "../Api/Api.csproj");
```

Under Central Package Management, place versions on `PackageVersion` entries
in `Directory.Packages.props` and omit `Version` from these `PackageReference`
entries. Keep the explicit AppHost reference. Explicit-version templates need
manual centralization before restore under an existing CPM root; matching central
versions alone do not prevent `NU1008`. Do not turn off CPM or add overrides to
conceal that limitation.

For a file-based AppHost, replace its Aspire SDK directive with explicit
AppHost/Dotnet package directives using verified versions. Preserve actual
library directives and remove resource `#:project` directives only after all
their generated-metadata consumers have migrated. Verify the AppHost package's
file-app AOT behavior; this does not authorize changing Native AOT on service
file apps.

## Bundle, diagnostics and version skew

The new C# AppHost behavior requires a CLI bundle. An explicit
`AspireUseCliBundle=true` can remain, but is the default for the affected packages.
Remove `AspireUseCliBundle=false` only within the approved migration.

| Diagnostic | Response |
|---|---|
| `ASPIRE012` | New SDK's suppressible deprecation warning. Plan migration or temporarily set `SuppressAspireAppHostSdkObsoleteWarning=true` / `NoWarn=ASPIRE012`; suppression is not migration. |
| `ASPIRE010` | New C# targets reject bundle opt-out. Remove the false setting and install/resolve the bundle; `NoWarn` cannot make opt-out work. |
| `ASPIRE009` | Bundle resolution failed. Inspect CLI installation, PATH and explicit `AspireCliPath` / `AspireCliBundlePath`; do not disable the bundle. |
| `ASPIRE007` | Retained SDK is below the target's supported minimum. Stop for a separately approved upgrade or migration. |
| `NU1008` | Explicit package versions conflict with CPM. Centralize versions while preserving package references. |

A CLI-only upgrade does not rewrite SDK, package or resource declarations and
does not introduce `ASPIRE012` into an older SDK. Warning behavior comes from
the resolved SDK targets. Do not promise that an arbitrary old CLI supports a
new package: qualify the actual combination. PATH mode is not a strict
version-equality check; pinned DNX follows the AppHost package version rather
than an older retained SDK. Version-probe/setup failures require their actual
diagnostic and package-source evidence, not an invented compatibility fallback.

## Behavior and validation

Original resource references build services when building the AppHost.
`AddDotnetProject` builds its services at runtime; AppHost-only builds no longer
prove the service projects compile. Keep service projects in solution/CI
build and publish inputs, and report that intentional build-graph change.

After approved edits, use the same qualified toolchain for before/after checks:

1. Restore/build the AppHost and the solution's service projects.
2. Start the exact AppHost with the CLI; wait for healthy resources and verify
   real service HTTP, references/waits and rendered Dashboard resource state.
3. Exercise Restart/Rebuild, not compilation alone.
4. Run `aspire update` against a disposable migrated copy and verify it preserves
   `Microsoft.NET.Sdk` and explicit AppHost/Dotnet references.
5. In a disposable copy, verify an invalid bundle path fails with actionable
   `ASPIRE009`; restore normal configuration and check the source is unchanged.
6. Reassess to prove idempotence: no duplicate references or SDK reintroduction.

Report exact CLI/SDK/package versions, source SHA for preview artifacts, commands,
outcomes and untested combinations. Keep audit/feed failures, platform skips and
GUI/publish limitations distinct from passes. If a temporary HTTP/2 workaround
is necessary for NuGet restore, scope it to that build operation; carrying it
into runtime breaks Dashboard gRPC connectivity and invalidates GUI acceptance.
