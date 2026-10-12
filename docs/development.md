# Development

Use Node.js 22 or later and Git. Run commands from the repository root.

## Making changes

Create branches from `dev` and target ordinary contributor PRs at `dev`. Main
accepts generated release and backport PRs.

Use **Squash and merge** for every PR, regardless of its target branch. Merge
commits and rebase merges are unsupported.

`dev` must not contain `CHANGELOG.md` or generated `opencode/` catalogs.
Before opening a PR, run:

```bash
npm ci --ignore-scripts
npm test
```

See [CONTRIBUTING.md](../CONTRIBUTING.md) for skill formatting and agent-host checks.

## Backporting without a release

Comment `/backport to <branch>` on a PR.

[Backport PR to branch](../.github/workflows/backport.yml) accepts the configured
App bot or a commenter with write access, applies the PR patch, and opens
`backport/pr-<number>-to-<branch>`. Conflicts require a manual backport.

Every backport targeting `dev` excludes `CHANGELOG.md` and `opencode/`, regardless
of its source branch. The dev validator also rejects those files in ordinary PRs.

## Releasing

Dispatch [Release](../.github/workflows/release.yml) from `main`.

The workflow selects a dev snapshot, updates its canonical versions, generates
the changelog placeholder and OpenCode catalogs, and opens a draft
`release/<version>` PR into `main`. Changelog metadata identifies the previous
release. Later dev commits stay out unless you select a later snapshot.

The `aspire-skills-release` label triggers
[Release Changelog](../.github/workflows/release-changelog.md). Copilot writes
notes for the selected dev range and may change only the newest changelog entry.

Review the notes before merging. A pending placeholder blocks the release. If
generation fails, fix the error and reapply the label, or finalize the entry
manually without changing its release metadata.

Describe what changes for users of plugins, skills, canvases, hooks, and catalogs.
Leave out CI, build, and release infrastructure. The PR's source commit list is
review evidence, not a substitute for release notes. The pending/done HTML comment records the selected source range, baseline
version, and whether notes are complete; it is not part of the published release
description. The ordinary staging commit pins the main baseline. No separate
`aspire-skills-release` comment is added to the changelog.

The release PR title is `Release v<version>`. Its body contains only
`Source range: https://github.com/<owner>/<repo>/compare/<from-sha>..<source-sha>`,
using the full pinned SHAs. With squash defaults set to the PR title and body,
GitHub supplies that concise commit message rather than the branch's commit
history. Keep this message when using **Squash and merge**; GitHub's PR-number
suffix and author trailers are allowed.

The workflow verifies the squash against the exact reviewed PR head, tags that
one-parent main commit, and publishes a source-only GitHub release with the
reviewed notes. The changelog's done marker selects the next source range even
though the original dev commits are not ancestors of the main squash.

After the merge, the bot requests the standard dev backport described below.
Review and merge the resulting PR. It carries the version changes, which bumps
`dev` to the new release version.

## Automatic main-to-dev backports

[Backport PR to branch](../.github/workflows/backport.yml) posts `/backport to dev`
after every PR merged into `main`. The comment uses the configured App's token,
not `GITHUB_TOKEN`, so it triggers the same command handler used for manual
backports. Rerunning the merge-triggered job reuses an existing bot request.

The handler opens `backport/pr-<number>-to-dev` under the general dev exclusions.
Review and merge that PR. Conflicts are reported on the source PR and require a
manual backport.

## Testing releases in a fork

The same release, changelog, and backport workflows can run in a fork. Each run
uses its `GITHUB_REPOSITORY`; publication rejects any fetch or push origin that
points elsewhere. New changelog and PR links point to the fork, while copied
published changelog history stays unchanged.

Changelog generation checks out the trusted release base explicitly and validates
the selected PR with pinned main tooling. Copilot submits only the Markdown notes
through `record_changelog`; trusted code preserves the release metadata and all
published history, then appends one `CHANGELOG.md`-only commit to the exact
triggering PR head. An advanced head rejects the push. A final read-only check
fails if notes remain pending, even when the agent reports a no-op.

This uses the SDK's supported custom safe-output job, not its automatic fork
checkout or full-branch file-push check. Neither the agent nor its output can
choose a repository, branch, version, commit range, or file to write.

Install a dedicated GitHub App on only the fork, with Contents, Pull requests,
and Workflows write permissions. Add its Client ID as `ASPIRE_BOT_APP_ID` and
its PEM private key as `ASPIRE_BOT_PRIVATE_KEY` in the fork's Actions secrets.
Set the `ASPIRE_BOT_LOGIN` Actions variable to its slug without `[bot]`.

Keep `main` and source-only `dev` initialized as described above and choose an
unused version greater than `main`'s version. Dispatch Release from the fork's
`main`. A dry run prepares and tests artifacts without publication. A full run
opens the fork's release PR and triggers changelog generation. Review and merge
that PR to create the fork's tag and GitHub release, then review and merge its
automatic dev backport. These are real fork changes, not disposable previews;
never move or delete a published version tag.
