# Development

Use Node.js 22 or later, Git, and GitHub CLI. Create feature branches from `dev`
and target contributor PRs at `dev`. Before opening a PR, run:

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
release branches, on pushes to main or dev, and on merge-queue candidates.
Release-branch pushes rely on PR checks instead of triggering a duplicate matrix.

The **OpenCode catalog check** runs on every PR, including stacked PRs, on
main/dev/release pushes, and on merge-queue candidates. It rejects missing,
extra, or stale catalog files.

The **Changelog check** runs on PRs into `dev`, `dev` pushes, and merge-queue
candidates. It rejects edits to published or shipped changelog entries, and new
entries under a version that has a release branch once `dev` has moved past it.

The **Release branch check** fails any PR into main unless its head is a
`release/<version>` branch in this repository. It also requires the branch
name, coordinated versions, and newest changelog heading to agree on a version
newer than main's, finalized notes for that version, and unchanged entries for
published releases.

## Release flow

1. **Prepare.** Run **Prepare release** from `main` with a full `dev` commit
   SHA and the next dev version. It opens a `release/<version>` PR to `main`
   at that commit, using that commit's version, and a `bump-dev/<next>` PR that
   advances `dev`. Until the bump PR merges, keep adding entries under the
   release version. After each merge into `dev`, **Sync changelog** rebuilds the
   bump PR on the latest `dev` and moves entries added after the cut to the next
   version.
2. **Backport fixes.** Comment `/backport to release/<version>` on merged `dev`
   PRs. Resolve any conflicts manually.
3. **Publish.** Finalize the notes on the release branch and merge the release
   PR. The publisher tags the merged commit and creates the GitHub release.
4. **Merge back.** Open a PR from `main` to `dev`, keep dev's version and newer
   work, and merge it with a merge commit.

After the bump merges, the **Changelog check** rejects PRs that add entries
under an older version. Because `dev` requires branches to be up to date, PRs
that passed before the bump rerun the check when they update.

## Automation setup

Install the Aspire repository GitHub App with write access to contents, pull
requests, and workflows. Add its `ASPIRE_BOT_APP_ID` and
`ASPIRE_BOT_PRIVATE_KEY` as Actions secrets.

**Prepare release**, **Sync changelog**, and the backport workflow use the app
token. Prepare release and backport run from `main`, so prepare the first
release manually: cut `release/<version>` from `dev`, open a PR to `main`, and
advance `dev` with `npm run version:dev -- <next-version>`.

Require **OpenCode catalog check** and the three **Test** jobs on `main` and
`dev`, **Changelog check** on `dev`, and **Release branch check** on `main`.
On `dev`, also enable **Require branches to be up to date before merging**.

## Aspire telemetry maintenance

The [update-aspire workflow](../.github/workflows/update-aspire.md) keeps Aspire CLI
telemetry for aspire-skills usage up to date, including which skills and extension
tools agents invoke.
It creates draft proposals with one isolated build/test attempt. Candidate build
and test failures are reported in the draft or no-op summary; verifier setup,
isolation, and security failures block publication.
