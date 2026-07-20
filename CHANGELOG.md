# Changelog

All notable changes to the aspire-skills plugin will be documented in this file.

## [Unreleased]

### Changed
- Synced skill guidance with the current Aspire 13.4 development branch:
  `.aspire/modules` TypeScript AppHost generated files, `aspire integration list/search`
  discovery, resource-command/watch/HMR lifecycle guidance, and `PublishAsPackageScript`
  JavaScript deployment naming.
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

### Added
- Added the `aspire-doctor` GitHub App canvas extension for viewing `aspire doctor`
  results as a live checklist in a side panel.
- Added a release bundle generator and `publish.yml` workflow for the verified
  `aspire-skills-v<version>.tgz` and `aspire-extensions-v<version>.tgz` GitHub
  release assets consumed by `aspire agent init`.
- Restored upstream migration reference content for AppHost wiring, Docker Compose,
  full-solution AppHosts, JavaScript workspaces, OpenTelemetry, Playwright handoff,
  agent workflows, and detailed monitoring/search/display guidance.
- Adopted [`@microsoft/vally-cli`](https://www.npmjs.com/package/@microsoft/vally-cli)
  as the skill-eval CLI in place of `waza`. Added `.vally.yaml` with `ci-gate`
  (`priority: [p0, p1]`) and `nightly` (`priority: [p0, p1, p2]`) suites, plus three
  new GitHub Actions workflows: `skill-lint.yml` (PR-gated lint of `skills/` + eval
  specs), `skill-eval.yml` (PR-gated `ci-gate` suite), and `skill-eval-nightly.yml`
  (Sunday 06:00 UTC `nightly` suite with trajectory artifact upload). Eval
  workflows soft-skip when `COPILOT_GITHUB_TOKEN` is unset (e.g. fork PRs);
  see `evals/README.md` for the CI authentication contract.

### Changed
- Migrated all six per-skill eval specs from the legacy `waza` schema to the
  canonical [vally `EvalSchema`](https://www.npmjs.com/package/@microsoft/vally-cli):
  folded 54 `evals/tasks/*.yaml` files and 6 `evals/trigger_tests.yaml` files
  into inline `stimuli:` arrays on each `skills/<skill>/evals/eval.yaml`.
  Mapped `waza.expected.output_contains` → built-in `output-contains` graders,
  `waza.tags: [pN, area]` → `tags: { priority: pN, area: <area> }`, `trial_per_task` →
  `runs`, `timeout_seconds` → ISO-style `timeout`, and folded trigger tests into
  `skill-invocation` graders. Updated the default executor model from `gpt-4.1`
  (no longer available via `@github/copilot-sdk`) to `gpt-5-mini`. `vally lint
  --eval-spec` now passes cleanly on every spec, and `skill-lint.yml` no longer
  needs `continue-on-error` on the eval-spec validation step.
- Rewrote `evals/README.md` to reflect the real vally CLI surface (`--suite`,
  `--tag key=values`, `--skill-dir`, `--workspace`, `--output-dir`, `--junit`,
  `--skip-grade`, `--workers`, `--runs`, etc.) and documented `vally serve`
  (local dashboard) and `vally ingest` (SQLite store) workflows.

## [0.0.1] - Unreleased

### Added
- Initial `aspire` skill with detection, safety guardrails, diagnostics bridge
- Plugin manifests for Copilot CLI, Claude Code, Gemini CLI, Cursor
