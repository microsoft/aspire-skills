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
   release, and uploads the skills bundle.
5. **Merge back to dev.** Create `backport/pr-<release-pr>-to-dev` from current
   dev and merge main into it. Keep dev's next version and newer work, preserve
   non-version manifest changes and dev's current changelog entry, update earlier
   entries from main's approved changelog, and regenerate catalogs. Open a PR to dev
   and merge it with a merge commit.

## Publication

`.github/workflows/publish.yml` runs when a same-repository `release/*` PR
merges into main. It uses the event's `merge_commit_sha`, builds and attests
both bundles, and uploads only `aspire-skills-v<version>.tgz`.

Publishing uses `GITHUB_TOKEN`; no repo bot or stored automation credentials
are needed. Maintainers create PRs and approve merges. Tags and releases are
published in the same run because workflow-token tag pushes do not trigger
another workflow. Reruns must preserve the tag's commit and approved notes.

## Release-driven Aspire updates

`.github/workflows/update-aspire.md` runs on published releases and opens draft
PRs in `microsoft/aspire` only when released skills or integration changes require
telemetry updates. It compares release source and inventory directly; it does not
publish, acquire, or refresh embedded bundles. Bundle support is retired separately
in [#74](https://github.com/microsoft/aspire-skills/pull/74), which lands first.
[microsoft/aspire#20947](https://github.com/microsoft/aspire/pull/20947) is the
prerequisite for Aspire-owned scripts and retirement of the old bundle machinery.
`aspire-repo-bot[bot]` is allowlisted; the App must cover both repositories.
Configure `ASPIRE_BOT_APP_ID` and `ASPIRE_BOT_PRIVATE_KEY` as repository secrets.
Source research uses a read-only GitHub CLI proxy. Optional maintenance is
disabled in `.github/workflows/aw.json`. Regenerate the compiled workflow with
gh-aw v0.89.17 after editing its source or configuration.

### Manual runs

After the workflow is registered on `main`, open **Actions > Update Aspire
telemetry from skills release > Run workflow** and enter a published
`release_tag`, such as `v0.0.4`. Leave the optional `dry_run` checkbox unchecked
(the default) for normal draft PR publication, or check it to stage outputs
without publishing PRs or diagnostic issues. Both modes run the same review
and checks; inspect the Actions summary and artifacts for dry-run previews.
Release-triggered runs continue to publish normally.

The selected tag is resolved independently of the workflow branch's SHA.
Aspire-side prerequisite checks still apply; dry runs do not bypass ownership
or bundle-retirement gates. Failed checks remain visible as failed runs.
