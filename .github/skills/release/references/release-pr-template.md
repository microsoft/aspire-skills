## Summary

<!-- Explain the change and its user-visible impact. Link related issues. -->

Release v<VERSION>.

Source range: https://github.com/<OWNER>/<REPO>/compare/<PREVIOUS_DEV_SHA>..<DEV_SHA>

Main baseline: `<MAIN_SHA>`
Selected dev snapshot: `<DEV_SHA>`

## Release Checklist

- [ ] This PR targets `main` from `release/<VERSION>` in `<OWNER>/<REPO>`.
- [ ] The source range and pinned dev snapshot are correct; later dev changes
  are excluded.
- [ ] Plugin, package, and skill versions are coordinated at `<VERSION>`.
- [ ] Generated OpenCode catalogs match the selected snapshot and release version.
- [ ] Changelog notes use nonempty Changed, Removed, and Added sections in that
  order, describe user-facing changes, are finalized, and preserve published history.
- [ ] Documentation changes needed for this release are reviewed and ready.
- [ ] Tests cover the changed behavior and all required PR checks pass.
- [ ] Maintainer review and approval are complete.
- [ ] Squash-merge into main.
- [ ] [Publish release artifacts](https://github.com/<OWNER>/<REPO>/actions/workflows/publish.yml)
  succeeds, and `v<VERSION>` points to the merged main commit.
- [ ] The GitHub release contains the attested `aspire-skills-v<VERSION>.tgz` bundle,
  and its notes match the approved changelog entry's notes, excluding the version
  heading and internal metadata marker.
- [ ] Using the target repository's remote, create
  `backport/pr-<RELEASE_PR_NUMBER>-to-dev` from updated main, retain its approved
  `CHANGELOG.md`, remove only `opencode/`, commit, and open a PR to dev.
- [ ] Review and merge the dev backflow PR, preserving later dev work when
  resolving conflicts.
