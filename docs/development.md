# Development

Use Node.js 22 or later, Git, and GitHub CLI. Create feature branches from `dev`
and target contributor PRs at `dev`. Before opening a PR, run:

```powershell
npm ci --ignore-scripts
npm test
```

See [CONTRIBUTING.md](../CONTRIBUTING.md) for skill formatting and agent-host checks.
Dev keeps published changelog history but not generated `opencode/` catalogs.
Ordinary feature PRs preserve its version and changelog.

## One-time transition after 0.0.4

Finish and publish `0.0.4` from main using the legacy publisher. Those source
changes already landed on main; do not recreate this release from dev.
Land the infrastructure only after `v0.0.4` is published. The one-time bootstrap
CI exception verifies that release while trusted main tooling is absent; it
does not bypass tests or maintainer approval.

Before accepting new dev work, a maintainer fast-forwards dev to the approved
main bootstrap commit. Stop if dev has unique commits; do not reset or
force-push it. Use the target repository's remote as `origin`:

```powershell
git fetch origin main dev --tags
git merge-base --is-ancestor origin/dev origin/main
git push origin origin/main:refs/heads/dev
git fetch origin dev
git switch -c initialize-dev/0.0.5 origin/dev
npm run version:dev -- 0.0.5
```

Review the staged version-only changes and catalog removal, then commit and
open a PR to dev. Merge it before new development. Enable branch protection
with administrator approval, not a workflow-token bypass.

## Expected release flow

1. **Cut the release from dev.** Choose the exact dev snapshot to release and
   create `release/<version>` directly at that commit. Its coordinated versions
   already identify the release; do not reconstruct its tree on main.
2. **Advance dev separately.** Create a PR from current dev that bumps the
   package, lockfile, plugin, and shipped skill versions to the next version.
   Merge it before continuing development.
3. **Prepare and validate the release.** Backport any needed dev fixes to the
   existing release branch, excluding unrelated work. Finalize the newest
   changelog entry while preserving main's published history. Run
   `npm run catalog` to generate the committed `opencode/` catalogs, then
   `npm test`. Regenerate catalogs after a shipped skill or reference changes.
4. **Open and merge the release PR.** Target main from `release/<version>`.
   Maintainers review, approve, and merge using an allowed merge method.
   The existing publisher tags the event's exact merged main commit, creates
   the GitHub release, and uploads the attested skills bundle.
5. **Merge main back into dev.** Open a backflow PR from current dev, preserving
   its next version and newer source work. Copy main's approved changelog,
   remove catalogs, and merge the PR with a merge commit to record main ancestry.

For example, cut `release/0.0.5` at the chosen full SHA:

```powershell
git fetch origin main dev --tags
git merge-base --is-ancestor <DEV_SHA> origin/dev
git switch -c release/0.0.5 <DEV_SHA>
```

In a separate checkout/session, prepare the next-version PR:

```powershell
git fetch origin dev
git switch -c bump-dev/0.0.6 origin/dev
npm run version:dev -- 0.0.6
```

Use `git cherry-pick <FIX_SHA>` to backport selected fixes; resolve version
conflicts in favor of the release version. Finalized notes use tag-linked
headings and nonempty Changed, Removed, and Added sections in that order,
omitting empty sections. No pending/done marker or special commit message is
required. GitHub release notes copy the approved notes without the version
heading.

Record the selected dev SHA and backports in the release PR. Confirm that
versions, finalized notes, catalogs, documentation, and required checks agree
before maintainer approval. Necessary tooling lives under `scripts/`.
CI also runs on release-branch pushes and backport PRs.

## Publication and Actions permissions

The existing `.github/workflows/publish.yml` runs only after a same-repository
`release/*` PR merges into main. It uses the event's `merge_commit_sha`, not the
latest main tip or the release-branch head. It builds and attests both archives
and uploads only `aspire-skills-v<version>.tgz`.

Publication uses the short-lived `GITHUB_TOKEN`, exposed as `GH_TOKEN`, with
`contents: write` for tags, releases, and uploads; `pull-requests: read` to
verify the merged PR; and OIDC/attestation write permissions for provenance.
It needs no Aspire repo bot, App credentials, or stored personal token.

The successful `v0.0.3` publisher created a GitHub release. A separate
[Actions-token probe](https://github.com/microsoft/aspire-skills/actions/runs/38612461257/job/116019025531)
confirmed comment creation/update and temporary branch creation/deletion.
Despite requested PR-write permission, draft PR creation failed with HTTP 403:
"GitHub Actions is not permitted to create or approve pull requests."
Tag-specific rules were not tested by that branch probe.

Maintainers therefore create PRs with their authenticated tools and control
approval and merging. This flow does not change Actions policy or assume a
protection bypass. The publisher creates the tag and release in the same run:
a tag pushed with `GITHUB_TOKEN` does not trigger another push workflow.
Reruns reuse only a tag pointing to the same commit and a release with matching
approved notes. Never move a published tag to recover a failed run.

## Backflow to dev

After publication, start from current dev:

```powershell
git fetch origin main dev
git switch -c backport/pr-<RELEASE_PR_NUMBER>-to-dev origin/dev
git merge --no-ff --no-commit origin/main
```

Resolve conflicts deliberately. Keep dev's next version and newer work, retain
non-version manifest changes from both branches, take main's approved
`CHANGELOG.md`, and remove `opencode/`. Do not choose one whole manifest merely
to resolve its version field. Review and validate the complete merge, commit,
and open a PR to dev.

Merge this PR with a **merge commit**, not squash or rebase. For the first
cycle, main stays at `0.0.5` and dev stays at `0.0.6`. CI rejects catalog files,
version downgrades, dropped cleanly mergeable source, changed published notes,
or missing main ancestry.
