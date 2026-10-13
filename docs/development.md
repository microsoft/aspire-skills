# Development

Use Node.js 22 or later, Git, and GitHub CLI. Run local checks from the repository
root.

## Making changes

Create branches from `dev` and target ordinary contributor PRs at `dev`. Main
accepts maintainer-created `release/<version>` and
`backport/pr-<number>-to-main` PRs.

`dev` must not contain `CHANGELOG.md` or generated `opencode/` catalogs.
Before opening a PR, run:

```powershell
npm ci --ignore-scripts
npm test
```

See [CONTRIBUTING.md](../CONTRIBUTING.md) for skill formatting, documentation
impact, and agent-host checks.

## Releasing

Run the [release skill](../.github/skills/release/SKILL.md) with a version and
full dev commit SHA. It selects the target repository's remote, prepares the
branch, generates notes, validates, commits, pushes, and opens a draft PR to main.
Follow the Release Checklist in that PR.

Squash-merge the release PR using GitHub's normal commit message. Publication
reads the version and source range from the finalized changelog metadata, not
the squash message, and verifies that the squash tree matches the reviewed PR.

## Backports

Create a backflow branch from main, remove `CHANGELOG.md` and `opencode/`,
then open, review, and merge a PR to dev without discarding later dev work.
