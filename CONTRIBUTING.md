# Contributing to aspire-skills

Thank you for your interest in contributing to the Aspire Skills plugin!

## Getting Started

1. Fork the repository
2. Create a feature branch from `dev`
3. Make your changes
4. Submit a pull request targeting `dev`

## Skill File Format

Skills follow the standard SKILL.md format:
- Frontmatter with name, description, license, and metadata
- Quick Reference section
- Decision tables for routing
- Error handling tables
- References in `references/` subdirectory

## Version-Specific Guidance

Avoid fixed Aspire release targets in general skill descriptions and workflows.
Keep documented prerequisites, compatibility boundaries, breaking changes, and affected/fixed
release ranges. Concrete examples should not imply that the skill only applies to that version.

## Testing

See the [development guide](docs/development.md) for local checks and the release
process.

- Ensure SKILL.md files are under 5000 tokens
- Verify frontmatter compliance
- Test with at least one agent host (Copilot CLI, Claude Code, etc.)

## Preparing and Publishing a Release

For releases after `0.0.4`, follow the [development guide](docs/development.md)
and the [release skill](.github/skills/release/SKILL.md). The instructions below
document the legacy main-based flow used through `0.0.4`, before the replacement
release infrastructure in PR #69 lands. That legacy workflow does not publish
on PR merge; a version-tag push or manual workflow dispatch requires separate
authorization.

### Prepare the Legacy Release PR

Start from `main` and identify the exact commit behind the previous published
version tag. Review the full range from that commit, not just the release PR, to
distinguish new behavior from features already shipped.

Keep the release version aligned across `package.json`, both root versions in
`package-lock.json`, the canonical plugin and Gemini manifests, the plugin named
`aspire` in both marketplaces, and `metadata.version` in all seven shipped skills.
Internal author skills under `.github/skills/` are not release-version authorities.
Preserve the published plugin mirror's relative Git symlinks.

Write changelog entries for user-visible changes only. Omit version-bump
housekeeping, repository inventory metadata, and test-only changes; describe those
in the PR instead. Do not move previously published features into the new release.
Use tag-linked headings without a displayed `v` prefix, for example
`## [0.0.4](https://github.com/microsoft/aspire-skills/releases/tag/v0.0.4)`,
and preserve historical note bodies.

Validate the prepared commit with Node 22:

```powershell
npm ci --ignore-scripts
npm test
npm run bundle -- --out dist --source-commit (git rev-parse 'HEAD^{commit}')
```

Both bundles must build, and the PR's tests, bundle builds, and skill/eval checks
must pass before publication. Record the prepared source commit and any remaining
blockers in the PR. Local build commands do not publish anything.

### Publish the Legacy Release After Explicit Authorization

After the release PR merges, select and verify the exact final commit on `main`
that contains the approved release changes. A squash or merge commit can differ
from the prepared branch tip. Confirm its package and shipped metadata versions
match the intended tag before creating and pushing `v<version>` at that commit.
Do not tag whichever commit happens to be the latest `main`, move an existing
published tag, or publish an unmerged preparation branch.

The legacy tag push starts **Publish Aspire bundles**. It tests the tagged source,
builds and attests both archives, then uploads only `aspire-skills-v<version>.tgz`
by default. Verify the run succeeded, the tag resolves to the selected commit, and
the GitHub release contains the expected archive and provenance attestation.

To publish extensions with the legacy workflow, separately authorize a manual
run of `publish.yml` against that same version tag. Select `include_extensions`;
leave `include_skills` off when only extensions are needed. At least one bundle
must be selected. Manual runs from a branch fail, and the legacy workflow never
creates a tag.

The legacy workflow creates generic release notes rather than extracting
`CHANGELOG.md`. If approved, update the GitHub release body with that version's
finalized notes. Existing release assets are uploaded with `--clobber`, so reruns
can replace assets; do not rerun publication for older releases as routine
maintenance.

## Code of Conduct

This project follows the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
