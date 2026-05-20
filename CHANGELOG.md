# Changelog

All notable changes to the aspire-skills plugin will be documented in this file.

## [Unreleased]

### Changed
- Reset all skill `metadata.version` values to `0.0.1` ahead of the initial release.
- Synced `aspire-deployment` skill routing description with
  [microsoft/aspire#17209](https://github.com/microsoft/aspire/pull/17209).
  Replaced the verbose `USE FOR:` / `DO NOT USE FOR:` folded-scalar description with the
  upstream cross-model optimized single-line format: `**WORKFLOW SKILL**` prefix, five quoted
  `WHEN:` triggers, concise `INVOKES:` clause, and tightened `FOR SINGLE OPERATIONS:` guidance.
- Synced `aspire-deployment` skill with [microsoft/aspire#17182](https://github.com/microsoft/aspire/pull/17182).
  Replaced the quick-reference SKILL.md and broad `deployment.md` / `tools-and-config.md` references with the
  upstream workflow-style SKILL.md and per-target references (`aws.md`, `azure.md`, `cicd.md`,
  `docker-compose.md`, `github-actions-azure-csharp.yml`, `github-actions-azure-typescript.yml`,
  `javascript.md`, `kubernetes.md`, `preflight.md`).
- Aligned `aspire-deployment` SKILL.md frontmatter with repo convention: folded scalar `description`
  with `**WORKFLOW SKILL**` / `USE FOR:` / `DO NOT USE FOR:` / `INVOKES:` / `FOR SINGLE OPERATIONS:` markers.
- Restored `## Agent execution` (`--non-interactive` guidance), `## Handoff Rules` (cross-skill routing
  to `aspire-orchestration`, `aspire-monitoring`, `aspireify`, `azure-diagnostics`), and `## Project-Local
  Skill Override` deference block in `aspire-deployment` SKILL.md.

### Removed
- Retired three eval tasks that graded for behaviors no longer surfaced by the synced SKILL.md:
  `azure-13-3-integrations.yaml`, `deployment-gotchas.yaml`. Renamed `pipeline-diagnostics.yaml` to
  `pipeline-list-steps.yaml` and re-pointed it at `aspire publish --list-steps` /
  `aspire deploy --list-steps`.
- Replaced three `trigger_tests.yaml` prompts that referenced removed surfaces (`AddAzureFrontDoor`,
  `aspire do diagnostics`, `--clear-cache`) with prompts aligned to the new content
  (AWS deploy, deployment-plan validation, `--list-steps` pipeline preview).

## [0.0.1] - Unreleased

### Added
- Initial `aspire` skill with detection, safety guardrails, diagnostics bridge
- Plugin manifests for Copilot CLI, Claude Code, Gemini CLI, Cursor
- Telemetry hooks (placeholder)
