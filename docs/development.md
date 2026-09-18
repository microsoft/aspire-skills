# Development guide

Use Node.js 22 or later and Git. Run commands from the repository root.

## Tests and local catalogs

```bash
npm test
npm run catalog
npm run catalog:check
```

The [Tests workflow](../.github/workflows/test.yml) runs the unit suites and
catalog checks on Linux, macOS, and Windows without path filters. Catalog builds
write only to `dist/opencode/`; they do not publish files to `main`.
Both V1 and V2 indices use SHA-512 content cache keys, not the plugin version.

### Rehearse the release flow before merge

On Linux with Node.js, Git, Bash, and PowerShell 7 available:

```bash
npm run test:release-workflow
```

Linux PR CI runs this after `npm test`, so the rehearsal's nested unit suite
does not compete with another copy. The rehearsal snapshots the current worktree,
including uncommitted changes, into disposable repositories. It executes the
release workflow's actual shell steps: role checks, source resolution, trusted
tests, candidate generation, artifact verification, and publication to a local
bare origin. It checks the first `0.0.2` release, preserved changelog notes,
versions, ancestry, catalog hashes, permission failures, tampering, and collisions.
Pushes to GitHub and unexpected refs are blocked.

GitHub API calls, checkout/artifact services, and App-token issuance are
simulated. A green rehearsal does not verify real App credentials or production
publication. Hosted PR CI runs the real scripts and rehearsal before merge;
the manual workflow becomes available after setup lands on `main`.

For a Windows worktree accessed through WSL, first export its Git inventory with
Windows Node:

```powershell
node tests\helpers\workflow-snapshot.mjs .release-workflow-test-index.json
```

Set `RELEASE_WORKFLOW_E2E_INDEX` to that file's WSL path before the Linux command.
`RELEASE_WORKFLOW_E2E_TOOL_PATH` can identify a directory containing `pwsh`.
Remove the temporary inventory afterward. Native Windows skips this rehearsal.

## Staged rollout

This setup adds release tooling and normal CI, not steady-state branch-policy
enforcement. It leaves `CHANGELOG.md` and all product versions intact and does
not create `dev`, a release branch, a catalog on `main`, or repository settings.

1. Merge the setup PR into `main`.
2. Create `dev` from that updated `main`. In a development commit, remove root
   `CHANGELOG.md` and any root `opencode/` copies so dev contains only sources.
3. Add the **Branch check** and **Release validation** jobs and their regression
   tests on `dev`, updating the setup-only workflow assertions there. Branch
   routing should accept `release/*` into main and ordinary branches into dev.
   Content validation should use trusted base tooling and exact PR head SHAs,
   run independently on main/dev PRs and pushes, and have no path filters.
4. Run [Prepare release](../.github/workflows/prepare-release.yml) **from `main`**,
   with the full selected dev SHA in `source_commit`, `release_version=0.0.2`,
   and the default `dry_run=true`. The source must include the cleanup and policy
   commits; the workflow itself must not run from dev.
5. After reviewing the dry-run artifacts and configuring publication credentials,
   rerun from main with the same source/version and `dry_run=false`. Review the
   generated `release/0.0.2` draft PR. Its new policy jobs can use the trusted
   release tooling already on main. Do not manually add jobs or edit source on
   the generated branch: that breaks source provenance.
6. After the first release passes its checks, have an administrator activate
   the agreed branch protections. Merge release PRs with a **merge commit**,
   not squash or rebase, to preserve dev ancestry. Catalog URLs become usable
   when the first generated release is merged into main.

With only cleanup, policy, test, and documentation changes since setup, the
first release keeps `0.0.2`. It finalizes main's existing `[0.0.2] - Unreleased`
section without losing notes or history. There is no dev-less bootstrap bypass.
After rollout, feature branches and PRs use dev; main receives prepared releases.

## Release guarantees

`release_version` is always required. Shipped-content changes require a SemVer
greater than both selected source and main versions. Package metadata, the five
canonical plugin/client manifests, and every canonical skill's `metadata.version`
stay aligned; plugin mirror symlink objects do not change. Repository-only
changes must explicitly supply main's existing version. Optional `source_commit`
must be a full SHA reachable from dev; an older unreleased snapshot is allowed.
Omitting it resolves dev's tip once.

Preparation starts from main and merges the selected dev ancestry. Only
release-owned files and proven version-only conflicts are resolved automatically.
Other source conflicts or main-only source drift must be reconciled on dev.
Generated catalogs, changelog, and PR metadata record and verify the exact
source/base commits and release/source/base versions.

Read-only preparation creates a checked Git bundle and PR body. A separate
publisher runner uses trusted main tooling to verify the bundle's exact ref,
candidate, provenance, catalog bytes, and changelog before requesting an App
token. It never checks out or executes candidate code with that token.
Publication creates `release/<version>` and a draft main PR; an existing branch
is an error, and an atomic create-only push also rejects concurrent collisions.
Fix source on dev and prepare again if main advances or validation fails.

### Administrator prerequisites

Keep main as the default branch and retain merge commits for release PRs.
Coordinate required checks and protections after the staged rollout, not as
bootstrap exceptions. No ruleset preset or settings change is included here.

Enable the existing Aspire bot for this repository through its owner; a new App
is not required. Make `ASPIRE_BOT_APP_ID` and `ASPIRE_BOT_PRIVATE_KEY` available as
repository secrets, matching
[Aspire's extension-release setup](https://github.com/microsoft/aspire/blob/2f175f2cde7be0b0241849419b772ac946f471f4/.github/workflows/extension-release.yml).
The pinned App-token action uses the ID as `client-id`. The installation needs
Contents and Pull requests write access, plus Workflows write when promoting
workflow changes. Each token is repository-scoped and requests workflow write
only when needed. This setup does not configure credentials or permissions.

Both the original actor and the rerun actor must have write, maintain, or admin
access. Each runner checks both actors before checkout; API errors and unknown
roles fail closed.

## Legacy compatibility builds

`npm run bundle`, `bundle:skills`, and `bundle:extensions` remain available for
local compatibility testing, including telemetry-hook provenance; they require
`tar`. The obsolete tag-driven tar-asset publisher is removed. Release delivery
uses reviewed source and generated catalogs on main, not GitHub release assets.
