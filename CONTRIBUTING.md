# Contributing to aspire-skills

Thank you for your interest in contributing to the Aspire Skills plugin!

## Getting Started

1. Fork the repository
2. Create a feature branch from `dev`
3. Make your changes
4. Submit a pull request targeting `dev`

Use the [PR template](.github/pull_request_template.md) to describe user impact,
testing, risk, and documentation changes. Main accepts only maintainer-prepared
releases and reviewed backports; see the [development guide](docs/development.md).

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

## Documentation Impact

For user-visible changes, update related repository documentation and identify
affected external documentation pages. Link each documentation issue or PR,
name its owner, and state when it should publish. If no page needs an update,
explain why. Maintainers collect documentation approval and publication receipts
in the release PR before and after release.

## Code of Conduct

This project follows the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
