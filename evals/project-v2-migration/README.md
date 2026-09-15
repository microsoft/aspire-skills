# Project v2 migration evaluation fixtures

These fixtures exercise the `aspire-project-v2-migration` skill. Evaluation
executors copy them into disposable workspaces before edits.

## `runnable-csharp`

A small legacy ProjectResource application with:

- a C# AppHost targeting `13.6.0-dev`;
- a TypeScript AppHost using the same API, worker, shared library, and Redis;
- API and worker web services;
- a shared library referenced by both services and directly by the AppHost;
- Redis as a container dependency;
- named and explicitly excluded launch-profile cases;
- arguments, runtime environment, endpoints, references, waits, and replicas;
- explicit HTTP health checks for API and worker structured readiness;
- resource-only AppHost project references that may be removed after migration;
- a shared-library AppHost reference that must remain because AppHost code uses it;
- `AspireProjectMetadataTypeName` on the API reference, proving that paths cannot
  be guessed from `Projects.*` names.

`13.6.0-dev` denotes local development packages, not a released package. A
validator using locally built packages may replace that exact label in a
disposable copy with the produced package version. Do not rewrite this fixture
to imply a public 13.6 release exists.

Expected approved migration:

1. Add `Aspire.Hosting.Dotnet` at the same development version.
2. Convert `api` to `AddDotnetProject("api", "../Migration.Api/Migration.Api.csproj",
   options => options.LaunchProfileName = "http")`.
3. Convert `worker` to `AddDotnetProject("worker",
   "../Migration.Worker/Migration.Worker.csproj",
   options => options.ExcludeLaunchProfile = true)`.
4. Preserve every fluent call.
5. Add a paired, local `ASPIREDOTNETPROJECT001` suppression around migrated C#
   declarations so the actual AppHost compiles.
6. Remove only the API and worker AppHost project references.
7. Retain the shared-library AppHost project reference and service-to-library
   references, including `IsAspireProjectResource="false"` so it remains a real
   AppHost code reference.

The worker's `/probe` route calls the Aspire-injected API endpoint and returns
the API response, providing an end-to-end service-discovery check.

The TypeScript AppHost intentionally contains no `.aspire/modules` output.
Generate modules in a disposable copy through the matching local Aspire CLI.
Its approved migration adds `Aspire.Hosting.Dotnet` to `aspire.config.json` and
converts both default-options legacy `addProject` calls while preserving fluent
configuration. In TypeScript, omitting `launchProfileOrOptions` means default
launch-profile selection; it does not mean C#'s explicit-null exclusion. The
worker therefore continues selecting the fixture's `should-not-be-used` profile,
including its `--wrong-profile-argument` argument and `PROFILE_MARKER`, before
and after migration. Those intentionally conspicuous values prove that a
default-options TypeScript migration preserves the original profile behavior
rather than silently adopting C# semantics.

The focused `typescript` fixture represents an older handle-only generated API.
It proves that named/options calls remain unchanged when
`addDotnetProject` accepts only `Awaitable<ProjectResourceOptions>` and no
authored-code factory exists. The separate `typescript-named` fixture uses the
real legacy named-profile wrapper shape,
`{ launchProfileOrOptions: "http" }`. When the resolved package exposes the new
flattened `DotnetProjectOptions` DTO, its approved migration is
`{ launchProfileName: "http" }` directly as the third argument. It is not nested
under `options`.

The DTO also exposes `excludeLaunchProfile` and `excludeKestrelEndpoints`, but
those values may be emitted only when equivalent legacy behavior is proven from
source or asynchronous handle accessors. The fixtures do not invent a legacy
handle factory merely to manufacture those cases. Excluding Kestrel endpoints
only prevents Aspire from deriving model endpoints; it does not rewrite or
disable the service's own Kestrel configuration.

## Focused text fixtures

`eligibility`, `unsupported`, `typescript`, and `typescript-named` are
intentionally small and are used to grade assessment, no-edit, routing, options,
and compatibility behavior. They are not claims that every scenario is
independently runnable.
