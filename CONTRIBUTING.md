# Contributing to aspire-skills

Thank you for your interest in contributing to the Aspire Skills plugin!

## Getting Started

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Skill File Format

Skills follow the standard SKILL.md format:
- Frontmatter with name, description, license, and metadata
- Quick Reference section
- Decision tables for routing
- Error handling tables
- References in `references/` subdirectory

## Testing

- Ensure SKILL.md files are under 5000 tokens
- Verify frontmatter compliance
- Test with at least one agent host (Copilot CLI, Claude Code, etc.)

## Releases

Keep the plugin version synchronized across `.plugin/plugin.json`,
`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
`.cursor-plugin/marketplace.json`, `gemini-extension.json`, and `package.json`.
When that version lands on `main`, the publish workflow validates the version
increase, runs the bundle tests, builds and attests both archives, creates the
missing `v<version>` tag at that commit, and publishes the GitHub release.
Only the skills archive is uploaded by default; extensions remain opt-in.

Manual runs on `main` also reject downgrades by comparing with the previous
distinct plugin version in first-parent history. To retry publication at an
existing tag's commit, run the workflow on that tag. Existing releases are
skipped by automatic branch runs; tag runs can replace their selected bundle
assets. Select `include_extensions` on a manual tag run to add extensions to an
existing release. At least one of `include_skills` and `include_extensions` must
be selected.

## Code of Conduct

This project follows the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
