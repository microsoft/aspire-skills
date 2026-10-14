# Development

Use Node.js 22 or later, Git, and GitHub CLI. Run local checks from the repository
root.

## One-time transition after 0.0.4

Finish, review, and publish `0.0.4` from main using the existing tag-based bundle
workflow. Its source changes already landed on main; do not recreate this release
from dev. Land the release infrastructure only after `v0.0.4` exists.
The bootstrap PR has a one-time CI exception while trusted main release tooling
is absent. It still requires tests and maintainer approval. Once the tooling is
on main, the exception cannot admit another bootstrap PR.

Before accepting new dev work, fast-forward the existing dev branch to the
approved main bootstrap commit. Verify that dev is an ancestor of main; stop if
dev has unique commits rather than resetting or force-pushing it. A maintainer
performs this initial fast-forward before enabling dev protection:

```powershell
git fetch origin main dev --tags
git merge-base --is-ancestor origin/dev origin/main
git push origin origin/main:refs/heads/dev
git fetch origin dev
git switch -c initialize-dev/0.0.5 origin/dev
npm run version:dev -- 0.0.5
```

Use the target repository's remote as `origin` for development preparation.
The command stages coordinated versions and removes catalogs, without changing
source or changelog history. Review, test, commit, and open a PR to dev.
Merge it before redirecting contributor PRs to dev. Enable dev protection and
required checks with administrator approval; the workflow token does not bypass
protection.

The first release through the new flow is `0.0.5`. Its previous source is the
exact `v0.0.4` tag commit. Legacy changelog entries need no metadata rewrite:
preparation verifies that tag's version and main ancestry and preserves the
historical text.

## Making changes

Create branches from `dev` and target ordinary contributor PRs at `dev`. Main
accepts maintainer-created `release/<version>` and
`backport/pr-<number>-to-main` PRs.

`dev` retains published `CHANGELOG.md` history but must not contain generated
`opencode/` catalogs. Ordinary dev PRs cannot add, edit, or delete the changelog;
release backflow copies main's approved history without edits.
Before opening a PR, run:

```powershell
npm ci --ignore-scripts
npm test
```

See [CONTRIBUTING.md](../CONTRIBUTING.md) for skill formatting and agent-host checks.

## Releasing

Run the [release skill](../.github/skills/release/SKILL.md) with a version and
full dev commit SHA. It selects the target repository's remote, prepares the
branch, generates notes, validates, commits, pushes, and opens a draft PR to main.
Follow the Release Checklist in that PR.

After cutting the candidate, advance dev's coordinated versions before further
development. Use a separate checkout/session so the pinned release branch stays
unchanged. For example, after cutting `release/0.0.5`:

```powershell
git fetch origin main dev --tags
git switch -c bump-dev/0.0.6 origin/dev
npm run version:dev -- 0.0.6
```

Review, test, commit, and open the version-only PR to dev. Ordinary feature PRs
preserve dev's version; only `initialize-dev/<version>` and `bump-dev/<version>`
PRs advance it. Release fixes enter dev before deliberately selecting a replacement
candidate. Do not merge later dev work into the existing candidate implicitly.

Preparation always extends main's changelog history, even if the pinned dev
snapshot carries an older copy. Only release PRs author new entries.

Squash-merge the release PR using GitHub's normal commit message. Publication
reads the version and source range from the finalized changelog metadata, not
the squash message, and verifies that the squash tree matches the reviewed PR.

New changelog notes use nonempty Changed, Removed, and Added sections in that
order. GitHub release notes copy the approved notes without the version heading
or internal metadata marker; Git tag annotations remain brief. Publication rejects
an existing GitHub release whose notes differ from the approved changelog.

## Actions permissions and maintainer handoffs

Publication uses the short-lived `GITHUB_TOKEN`, exposed to GitHub CLI as
`GH_TOKEN`. It requests `contents: write` for tags, releases, and asset uploads;
`pull-requests: read` to verify the merged release PR; and `id-token: write` plus
`attestations: write` for bundle provenance. It requires no Aspire repo bot,
GitHub App credentials, or stored personal token.

The successful `v0.0.3` publisher received contents and attestations write
permissions and created the GitHub release. A separate
[Actions-token probe](https://github.com/microsoft/aspire-skills/actions/runs/38612461257/job/116019025531)
confirmed that `GITHUB_TOKEN` can create and update PR comments and create and
delete a temporary branch. Despite an explicit `pull-requests: write` grant,
creating a draft PR failed with HTTP 403: "GitHub Actions is not permitted to
create or approve pull requests." The temporary branch was deleted.

PR creation is therefore currently blocked by repository or organization Actions
policy, not by missing Aspire repo bot credentials. An administrator can review
the "Allow GitHub Actions to create and approve pull requests" setting separately;
this bootstrap does not change it or assume a branch-protection bypass.
Until policy permits PR creation, maintainers create release, version-bump, and
backflow PRs with their authenticated GitHub CLI or agent session. Approval and
merging remain maintainer decisions.

The publisher tags and publishes in the same run. A tag pushed with
`GITHUB_TOKEN` does not trigger another push workflow; publication does not rely
on a downstream tag-triggered job. Rerun a failed publishing job rather than
moving an existing tag.

## Automated PR findings

The GitHub Agentic Workflow in `.github/workflows/pr-review.md` reviews non-draft,
same-repository PRs into main or dev when opened, reopened, updated, or marked
ready for review. GitHub Agentic Workflows also checks the triggering actor's
trusted repository role; fork PRs and untrusted actors are not enabled. It uses
the internal `pr-review` skill and references from the trusted PR base branch,
not instructions supplied by the proposed changes.

Its `pull_request_target` trigger deliberately loads the approved base workflow
and local skill during activation. This is not the PR-code-execution pattern:
forks are excluded, there is no PR checkout, and the reviewer cannot run shell
commands or write to GitHub. Keep those boundaries intact when editing it.

The agent has read-only GitHub tools, no shell, and no PR checkout. Copilot
inference uses `copilot-requests: write` with the short-lived workflow token,
not a PAT or repo bot. Only a separate safe-output job can post a findings
comment on the triggering PR. That job rejects closed PRs and changed head SHAs
before posting. Findings include the reviewed commit and exact source permalinks;
existing findings are deduplicated. A complete review with no new findings posts
no comment. Incomplete reviews are reported as incomplete, not clean.

This workflow cannot approve, request changes, modify code, create PRs, merge,
tag, or publish. It starts serving PRs after the workflow and skill guidance land
on their trusted base branch; it does not self-review its initial bootstrap.
Rerun it through GitHub Actions when needed. It is advisory and does not replace
maintainer approval or existing checks.

Edit the Markdown source and regenerate the committed `.lock.yml` using
GitHub Agentic Workflows CLI **v0.89.21**:

```powershell
gh aw compile pr-review --validate --strict
node --test tests/pr-review-workflow.test.mjs
```

Do not edit the generated lockfile by hand or enable broader write outputs to
work around a failure.

## Backflow to dev

After publication succeeds, create `backport/pr-<release-pr-number>-to-dev`
from current dev, then merge updated main into that branch with
`git merge --no-ff --no-commit origin/main`. Resolve conflicts deliberately:
keep dev's current coordinated version and newer source work, take main's
approved `CHANGELOG.md`, and remove `opencode/`. Preserve non-version manifest
changes from both branches; do not choose one whole manifest just to resolve its
version field. Review and validate the complete merge before committing.

Open the PR to dev and merge it with a **merge commit**, not squash or rebase.
This records main ancestry while keeping dev's first-parent source history.
For the first cycle, main stays at `0.0.5` and dev stays at `0.0.6`.
Backflow checks reject version downgrades, dropped cleanly mergeable source,
modified published notes, catalogs, or missing main merge ancestry.
