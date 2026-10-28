# Development

Use Node.js 22 or later, Git, and GitHub CLI. Create feature branches from `dev`
and target contributor PRs at `dev`. Before opening a PR, run:

```powershell
npm ci --ignore-scripts
npm test
```

See [CONTRIBUTING.md](../CONTRIBUTING.md) for skill formatting and agent-host checks.
Dev retains `CHANGELOG.md` and generated `opencode/` catalogs. Regenerate catalogs
with `npm run catalog` after changing shipped skills, references, or assets,
and commit them with the source changes. Run `npm run catalog:check` to check
the committed tree. CI rejects missing, extra, or stale V1 and V2 catalog files.
Feature PRs update the current version's changelog notes and preserve earlier
entries and the coordinated version.

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

`.github/workflows/update-aspire.md` runs when a PR targeting `main` merges,
or manually for a selected PR, following Aspire's documentation-workflow
pattern. It assesses skill and extension behavior and opens draft PRs in
`microsoft/aspire` only when telemetry or its regression coverage needs updates.
It reads source directly; it does not publish, acquire, or refresh embedded
bundles. Bundle support is retired separately in
[#74](https://github.com/microsoft/aspire-skills/pull/74), which lands first.
Each review also checks `KnownMcpTools.All` against both compatibility scripts
and managed-hook classification, even when skill and extension inventories
are unchanged. An offline regression test must guard coverage before a no-op
is allowed.
[microsoft/aspire#20947](https://github.com/microsoft/aspire/pull/20947) is the
prerequisite for Aspire-owned scripts and retirement of the old bundle machinery.
`aspire-repo-bot[bot]` is allowlisted; the App must cover both repositories.
Configure `ASPIRE_BOT_APP_ID` and `ASPIRE_BOT_PRIVATE_KEY` as repository secrets.
Source research uses a read-only GitHub CLI proxy. Optional maintenance is
disabled in `.github/workflows/aw.json`. Regenerate the compiled workflow with
gh-aw v0.89.17 after editing its source or configuration.
Dependency restore must succeed before targeted tests begin. Restore failures
retain diagnostics and produce an incomplete outcome rather than an unverified PR.

### Manual runs

After the workflow is registered on `main`, open **Actions > Update Aspire
telemetry > Run workflow** and enter `pr_number` for a PR targeting `main`.
Like the documentation workflow, manual runs do not require a merged PR.
Leave the optional `dry_run` checkbox unchecked (the default) for normal draft
PR publication, or check it to stage outputs
without publishing PRs or diagnostic issues. Both modes run the same review
and checks; inspect the Actions summary and artifacts for dry-run previews.
Merge-triggered runs publish normally.

Source reads use the PR's merge commit when merged, or its head commit when
unmerged, independently of the workflow branch's SHA.
Aspire-side prerequisite checks still apply; dry runs do not bypass ownership
or bundle-retirement gates. Failed checks remain visible as failed runs.
