# Changelog

All notable changes to the aspire-skills plugin will be documented in this file.

## [Unreleased]

### Changed
- Synced `aspire-deployment` skill with [microsoft/aspire#17182](https://github.com/microsoft/aspire/pull/17182).
  Replaced the quick-reference SKILL.md and broad `deployment.md` / `tools-and-config.md` references with the
  upstream workflow-style SKILL.md and per-target references (`aws.md`, `azure.md`, `cicd.md`,
  `docker-compose.md`, `github-actions-azure-csharp.yml`, `github-actions-azure-typescript.yml`,
  `javascript.md`, `kubernetes.md`, `preflight.md`).

## [1.0.0] - Unreleased

### Added
- Initial `aspire` skill with detection, safety guardrails, diagnostics bridge
- Plugin manifests for Copilot CLI, Claude Code, Gemini CLI, Cursor
- Telemetry hooks (placeholder)
