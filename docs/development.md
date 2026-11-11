# Development

Use Node.js 22 or later, Git, GitHub CLI, and Bash 4 or later available as `bash`
on `PATH`. Workflow-script tests use recursive globs, which macOS's system Bash
does not support. On macOS, install Bash with `brew install bash` and prepend
`$(brew --prefix bash)/bin` to `PATH`. On Windows, use Git Bash.

Create feature branches from `dev` and target contributor PRs at `dev`.
Before opening a PR, run:

```powershell
npm ci --ignore-scripts
npm test
```

See [CONTRIBUTING.md](../CONTRIBUTING.md) for skill formatting and agent-host checks.
Set `CHROME_BIN` to a Chromium executable when running `npm test` to include the
AppHosts native-browser number-input regression; without it, that check is skipped.
Dev retains `CHANGELOG.md` and generated `opencode/` catalogs. Regenerate catalogs
with `npm run catalog` after changing shipped skills, references, or assets,
and commit them with the source changes. Run `npm run catalog:check` to check
the committed tree. CI rejects missing, extra, or stale V1 and V2 catalog files.
Add only consumer-facing changes to the current changelog entry; preserve earlier
entries and the coordinated version.

Canvas extensions serve canonical theme and icon assets directly and retain
relative Git symlinks for packagers. Edit the canonical files directly; no
synchronization step is needed.
See [Shared canvas UI](canvas-ui.md) for token ownership, typography, icons,
standalone packages, plugin mirrors, and visual review.

The **Tests** workflow runs its three-OS matrix on PRs targeting main, dev, or
release branches, and on pushes to main or dev. Release-branch pushes rely on PR
checks instead of triggering a duplicate matrix.

The **OpenCode catalog check** runs on every PR, including stacked PRs, on
main/dev/release pushes, and on merge-queue candidates.

The **Release branch check** fails any PR into main unless its head is a
`release/<version>` branch in this repository.

## Expected release flow

1. **Cut the release.** Create `release/<version>` at the chosen dev commit.
2. **Advance dev.** Create `bump-dev/<next-version>` from current dev, run
   `npm run version:dev -- <next-version>`, and open a PR to dev. The command
   updates coordinated versions, adds the new changelog heading without changing
   existing entries, and regenerates catalogs.
3. **Prepare the candidate.** Backport needed fixes, finalize the changelog,
   regenerate catalogs with `npm run catalog`, and run `npm test`.
4. **Release to main.** Open the release PR to main. Maintainers approve and
   merge it; the publisher tags the exact merged commit, creates the GitHub
   release from the approved changelog notes, and uploads no generated archives.
5. **Merge back to dev.** Create `backport/pr-<release-pr>-to-dev` from current
   dev and merge main into it. Keep dev's next version and newer work, preserve
   non-version manifest changes and dev's current changelog entry, update earlier
   entries from main's approved changelog, and regenerate catalogs. Open a PR to dev
   and merge it with a merge commit.

## Publication

`.github/workflows/publish.yml` runs when a same-repository `release/*` PR
merges into main. It uses the event's `merge_commit_sha`, reruns the source,
catalog, and version checks, then tags that commit and creates a source-only
GitHub release from the approved changelog notes.

Publishing uses `GITHUB_TOKEN`; no repo bot or stored automation credentials
are needed. Maintainers create PRs and approve merges. Tags and releases are
published in the same run because workflow-token tag pushes do not trigger
another workflow. Reruns must preserve the tag's commit and approved notes.

## Aspire telemetry maintenance

The [update-aspire workflow](../.github/workflows/update-aspire.yml) deterministically
generates Aspire's telemetry catalog from canonical `skills/<name>/` directories
and their `references/**` files. It writes
`src/Aspire.Cli/Agents/Hooks/telemetry-catalog.json` in `microsoft/aspire`,
with ordinally sorted, unique `skills` and `references` arrays. Reference names use
`<skill>/references/<path>` with forward slashes. JSON uses two-space indentation,
LF line endings, and a trailing newline. Mirrors under `.github/plugins/`,
`opencode/`, and `.github/skills/` are not scanned.
The catalog must already exist in Aspire; this workflow does not introduce its reader
or embedding.

The catalog is validated against Aspire's parser contract before any API call:
both arrays are non-empty, skill names match `[a-zA-Z0-9_-]+`, entries are unique
ignoring case and ordinally sorted, and each reference names a cataloged skill
with no backslashes or empty, `.`, or `..` segments. A violation fails the run.

The workflow runs after a PR merges into main, or manually with a source
`pr_number`. A merged PR always publishes the current aspire-skills main commit,
after confirming the PR merge commit is contained in it, so stale or out-of-order
events cannot roll back newer skills or references. Runs are serialized, and a run
whose main snapshot is no longer current exits without changes. An unmerged PR's
head can only be previewed with `dry_run`.

A changed catalog creates or updates one draft PR on the automation-owned
`update-aspire-telemetry-catalog` branch in Aspire using the existing bot app.
Each update rebuilds that branch from Aspire's current main and changes only the
catalog file, so do not edit the generated branch by hand. When Aspire main
already matches the generated catalog, any open bot proposal is closed with a
comment and its branch is deleted. Manual `dry_run` previews the generated JSON
in the Actions summary without creating a write token or publishing changes.

No agent, destination code execution, or content interpretation is needed.
Extension tools and behavior are not part of this inventory; their telemetry cannot
be inferred from skill and reference paths. Aspire owns its MCP tool catalog.
