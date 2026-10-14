# Development

Use Node.js 22 or later, Git, and GitHub CLI. Run local checks from the repository
root.

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

Preparation always extends main's changelog history, even if the pinned dev
snapshot carries an older copy. Only release PRs author new entries.

Squash-merge the release PR using GitHub's normal commit message. Publication
reads the version and source range from the finalized changelog metadata, not
the squash message, and verifies that the squash tree matches the reviewed PR.

New changelog notes use nonempty Changed, Removed, and Added sections in that
order. GitHub release notes copy the approved notes without the version heading
or internal metadata marker; Git tag annotations remain brief. Publication rejects
an existing GitHub release whose notes differ from the approved changelog.

## Backports

Create a backflow branch from updated main, retain its approved `CHANGELOG.md`,
and remove only `opencode/`. Then open, review, and merge a PR to dev without
discarding later dev work.
