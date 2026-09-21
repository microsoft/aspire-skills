# Project v2 migration evaluations

These fixtures are **legacy inputs**, not hand-written successful agent outputs.
The migration spec loads all seven sibling skills and contains 15 read-only cases
and seven actual-edit cases.

## Source and approval gates

```bash
npm ci --ignore-scripts
npm test
vally lint --eval-spec skills/aspire-project-v2-migration/evals/eval.yaml
vally eval -e skills/aspire-project-v2-migration/evals/eval.yaml \
  --model gpt-5.6-sol-fast --judge-model gpt-5.6-sol \
  --runs 1 --workers 1 --max-retries 0 --require-pass \
  --workspace /absolute/new/workspaces --output-dir /absolute/new/results
```

Use Vally 0.16.0, the pinned Copilot runtime 1.0.80, and Node 22.12+.
Keep the repository's existing authentication, required-pass and artifact-redaction
controls. `--skip-grade` executes agents; it is not a dry run.

No-edit cases require an empty captured diff. Actual-edit cases use a hidden
program grader that reconstructs the baseline by reverse-applying Vally's captured
diff to the actual final workspace. It checks the complete file boundary, each
selected resource/path/profile, package ownership, retained references, other
fluent behavior, and bounded experimental diagnostics. The full C# case also
requires an empty second-turn reassessment diff.

`scripts/project-v2-edit-contract.mjs` is intentionally fixture-specific, not a
general C#/TypeScript parser. Its offline mutation tests are negative controls for
the grader, **not** substitutes for actual model edits or compilation.
`npm test` never invokes models or containers. Runtime/publishing qualification
tooling is separate from this source-evaluation merge unit.

## Capability input and fixture cases

`capability-evidence.json` is an offline source-backed API input at
[`f856e006130459c4e11ed8cecd0b09e7e3873311`](https://github.com/microsoft/aspire/commit/f856e006130459c4e11ed8cecd0b09e7e3873311),
containing merged [microsoft/aspire#19997](https://github.com/microsoft/aspire/pull/19997)
and [microsoft/aspire#20157](https://github.com/microsoft/aspire/pull/20157).
It does not establish which public release or installed package contains those
APIs. Replace the `13.6.0-dev` fixture placeholder only in disposable validation
copies, using the same independently qualified toolchain on both sides.

`gateway-publishing-evidence.json` is a separate offline assessment input for
resolved framework/base-image/user differences. It is not an installation check,
agent output or image-build proof. The read-only cases require specific approval
when those values differ and approved discovery when they are unknown. The
positive edit case explicitly approves its resolved image changes without
authorizing service/client retargeting or claiming unchanged image parity. It
also requires removal of the legacy gateway-only `DockerfileBuildAnnotation`
image mutation: the Project v2 gateway uses SDK publishing, while the existing
`WithContainerBuildOptions` retains its image name, tag, and target platform.
The separate `clientpublish` Dockerfile annotation remains unchanged.

| Case | Contract |
|---|---|
| C# full/subset | Named API profile, explicit-null worker exclusion, metadata override, replicas, references, waits, environment, arguments, image settings, and the shared code reference |
| TypeScript default | Both resources migrate; omitted options retain the default profiles, unlike C# explicit-null exclusion |
| TypeScript named | The actual legacy named wrapper becomes the flat `launchProfileName` DTO |
| Publishing ownership | Preserve custom Dockerfile identity and publish-only prebuilt ownership; do not add prebuilt build/push steps |
| File app | Preserve `PublishAot=true`, runtime environment, and publishing options |
| EF/Blazor | Retain EF metadata/operation ownership and client configuration; handle the new EF overload's `ASPIREPROJECTS001`; require explicit approval of resolved gateway framework/base/user changes; remove only the obsolete gateway Dockerfile-image mutation while preserving SDK container options |
| Assessment/routing | No implicit edits, upgrades, or missing-capability workarounds; ordinary wiring routes to `aspireify` |

The generated TypeScript third argument is optional, not nullable.
`{ launchProfileName: null }` is valid and selects the default profile; literal
`null` as the third argument is not the generated API. Do not manufacture a legacy
RPC handle or keep a parallel handle-only target fallback.

## Executable qualification

Source grading alone is not a compile/runtime result. Validate **retained actual
edits**, not manually migrated copies, in distinct disposable before/after trees.
Keep source hashes and the captured diff so changed or substituted candidates fail.

Separate compilation, isolated local lifecycle, generated Compose/manifest
artifacts, local image/archive builds and smoke tests. `aspire publish` alone is
not an image-build result. Deploying, pushing images, or provisioning cloud/cluster
resources requires separate authorization.

Use `aspire start --isolated`, `aspire wait`, structured `aspire describe`, and
exact-AppHost `aspire stop`. Choose Podman with `ASPIRE_CONTAINER_RUNTIME=podman`
when appropriate; never install a Docker shim or prune shared resources.
Use local package configuration and approved feeds. An emulated CLI version is
not coherent toolchain proof: qualify hosting/codegen packages, SDK/runtimes and
the actual DCP/dashboard components.

For EF, require a successful startup migration and a repeated
`aspire resource api-migrations ef-database-update` against the owned database.
The migration resource must finish; its hidden tool must finish with
`exitCode: 0`. Check the seeded row through the API and
`/client/backend/api/probe`, plus the real client/framework files under `/client/`.

At this source baseline, the browser telemetry proxy
`/client/telemetry/v1/traces` is runtime-only; publish configuration intentionally
omits it. The Blazor fixture also explicitly marks the existing `clientpublish`
Dockerfile annotation `HasEntrypoint=false` on both sides: the upstream default
otherwise includes this build-only companion as a deployable service. This test
setup is not a migration fix to apply automatically to user applications.

The built-in gateway disables its own AOT. Ordinary file apps keep AOT:
positive Linux images need a matching target-OS builder. Host-negative diagnostics
depend on the selected SDK/platform and prerequisites; do not require a particular
macOS-to-Linux error before attempting a Linux positive. The fixture's `MIGRATION_IMAGE_ARCHIVE` setting
enables archive output without changing AOT. Custom MSBuild globals are not
forwarded to `dotnet-ef`; successful ordinary EF migration does not prove otherwise.

Use finite execution/process-cleanup bounds and record failed or unexecuted gates
explicitly. Preserve publishing ownership and only normalize specific approved
implementation differences. For a gateway, distinguish validated intentional
framework/base-image/user changes from unchanged behavior; functional probes do
not authorize those changes or establish image parity. A common validation-only
base-image pin needs explicit approval and scope disclosure; it does not prove
that the SDK's unmodified image inference works. Do not broadly scrub configuration
to force equality.
Raw workspaces/caches/archives are not safe upload artifacts; apply credential
review and the repository's redaction safeguards to curated evidence.

## Inspecting uncommitted bundle changes

Bundle tests require hook bytes to match a real source commit. If unchanged hook
bytes already exist in another fetched commit, `ASPIRE_TEST_SOURCE_COMMIT` can
select that matching commit for local tests. Production byte/provenance checks
still run. This neither creates a commit nor authorizes publishing. PowerShell
is required by cross-shell hook tests on macOS as well.
