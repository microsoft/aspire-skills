# Contributing to aspire-skills

Thank you for your interest in contributing to the Aspire Skills plugin!

## Getting Started

1. Fork the repository
2. Create a feature branch from `dev`
3. Make your changes
4. Submit a pull request targeting `dev`

`dev` contains development sources; `main` contains reviewed releases. Do not add
root `opencode/` copies or `CHANGELOG.md` to development branches. Release preparation
generates them from the selected source commit and preserves the released changelog.
Release preparation keeps plugin/package and shipped skill versions aligned,
bumping them together only when shipped content changes. Ordinary feature PRs
do not need a release-version bump; repository-only updates retain main's version.

## Skill File Format

Skills follow the standard SKILL.md format:
- Frontmatter with name, description, license, and metadata
- Quick Reference section
- Decision tables for routing
- Error handling tables
- References in `references/` subdirectory

## Testing

See the [development guide](docs/development.md) for test commands, the isolated
release rehearsal, and the planned development/release branch workflow.

- Ensure SKILL.md files are under 5000 tokens
- Verify frontmatter compliance
- Test with at least one agent host (Copilot CLI, Claude Code, etc.)

## Code of Conduct

This project follows the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
