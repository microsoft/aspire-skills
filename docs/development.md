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
main/dev/release pushes, and on merge-queue candidates. Candidates targeting
main must also have synchronized versions and unchanged published changelog
history.

The **Release branch check** fails any PR into main unless its head is a
`release/<version>` branch in this repository.

## Release flow

1. **Prepare the PRs.** Run **Prepare release** from main with the full selected
   dev commit SHA, release version, and next dev version (versions omit `v`).
   It creates `release/<version>` and its PR to main, generates the release
   catalogs, and creates `bump-dev/<next-version>` and its PR to dev. The dev
   bump updates coordinated versions, adds a changelog heading without
   changing earlier notes, and regenerates catalogs. The workflow has separate
   steps for preparing commits, pushing branches, and opening PRs; the push
   and PR steps use the Aspire App token. Links to both PRs appear in the run
   summary. Both PRs require review.
2. **Prepare candidate fixes.** Run **Backport PR to branch** from main with a
   merged dev PR number and its target `release/<version>`. The copied
   Arcade-derived workflow from `microsoft/aspire` applies the PR patch using
   `git am` and opens `backport/pr-<number>-to-<target>` for review.
   Backports skip generated catalog hunks and regenerate catalogs for the target.
   There is no `/backport` comment trigger.
3. **Finalize the candidate.** Maintainers finalize the release notes and merge
   approved fixes into the release branch.
4. **Release to main.** Maintainers approve and merge the release PR after all
   required checks pass. The publisher validates and tags the exact merged
   commit and creates a source-only GitHub release with no generated archives.
5. **Review the automatic backport.** Every same-repository PR merged into main
   triggers the Arcade patch-copy flow back to dev. It opens a reviewable
   `backport/pr-<number>-to-dev` PR when patch application and preservation
   checks succeed. This is a patch backport, not a real merge: it does not
   retain merge ancestry, and it does not require merge-commit-only merging.

Main-to-dev backports exclude coordinated version manifests and generated
catalogs from the patch so a release cannot overwrite dev's next version.
They merge main's approved release notes while preserving dev's current
changelog entry, newer work, and non-version manifest edits, then regenerate
catalogs for dev. A release that changes anything in a version manifest beyond
its version fails the automatic backport so that content is backported manually.
Other patch conflicts or preservation-check failures stop the operation and post
a source-PR comment with the workflow link; they may occur before a PR is opened.
Resolve those backports manually, preserving these invariants, rather than
accepting one side wholesale.

Reruns reuse matching open PRs and can recover from a branch push followed by a
PR-creation failure. They do not reopen closed PRs, replace maintainer edits, or
reuse unrelated branches. Stale operations fail rather than overwrite newer
work. Retry against current refs; investigate a conflicting operation identity
instead of force-pushing over it.

The `release-automation.mjs prepare` command only prepares local commits and
prints a JSON plan. It does not push branches or call the GitHub PR API; those
operations belong to the workflow.

## Automation setup

Install the Aspire repository GitHub App for this repository and make
`ASPIRE_BOT_APP_ID` and `ASPIRE_BOT_PRIVATE_KEY` available as Actions secrets.
Branch/PR automation uses short-lived, repository-scoped App tokens with only
the necessary permissions. Release preparation and backports also need the App's
workflow-write permission so selected workflow-file changes can be pushed.
App pushes trigger normal PR checks, unlike workflow-token pushes.

After the workflows and helpers land on dev, the first rollout still needs a
maintainer-prepared `release/<version>` PR to main: align its versions, finalize
its changelog, and generate and commit its stable catalogs with `npm run catalog`.
Dispatch workflows cannot prepare this bootstrap PR before the helpers exist on
main. Configure the App before merging that PR. Subsequent releases use the
automated preparation flow.

Keep the existing required check names. A maintainer must require **OpenCode catalog check** and
**Test (ubuntu-latest)**, **Test (macos-latest)**, and **Test (windows-latest)**
on main as well as dev, retaining **Release branch check** on main. This code
does not change rulesets, approval requirements, or repository settings.

## Publication

`.github/workflows/publish.yml` runs when a same-repository `release/*` PR
merges into main. It uses the event's `merge_commit_sha`, reruns the source,
catalog, and version checks, then tags that commit and creates a source-only
GitHub release from the approved changelog notes.

Tag/release publication still uses `GITHUB_TOKEN`; branch and PR preparation uses
the Aspire App. Maintainers approve and merge PRs. Tags and releases are
published in the same run because workflow-token tag pushes do not trigger
another workflow. Reruns must preserve the tag's commit and approved notes.

## Aspire telemetry maintenance

The [update-aspire workflow](../.github/workflows/update-aspire.md) keeps Aspire CLI
telemetry for aspire-skills usage up to date, including which skills and extension
tools agents invoke.
It creates draft proposals with one isolated build/test attempt. Candidate build
and test failures are reported in the draft or no-op summary; verifier setup,
isolation, and security failures block publication.
