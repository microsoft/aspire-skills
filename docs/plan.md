# Plan: `aspire-skills` — Thin Always-On Plugin for Aspire

## Problem Statement

[microsoft/aspire#15801](https://github.com/microsoft/aspire/issues/15801) — AI agents (Copilot, Claude, Cursor, Gemini) cause active harm in Aspire projects: `dotnet run` instead of `aspire start`, `curl` polling instead of `aspire wait`, `dotnet build` into file-lock errors, orphaned processes. The root cause: Aspire ships great agent guidance via `aspire agent init`, but most developers never run it.

## Approach: One Thin Plugin Skill

**Original proposal**: 3 comprehensive skills (orchestration, deployment, monitoring).
**Revised after PR #15745 analysis**: 1 thin plugin skill — a safety net, not a replacement.

PR #15745 (merged by @IEvangelist) already provides 9 scenario-based reference files with 100% eval score on 319 assertions. The plugin should NOT duplicate this. Instead:

1. **Detect** — Recognize Aspire AppHost projects (`.csproj` with `Aspire.AppHost.Sdk`, `apphost.ts`)
2. **Guard** — Enforce critical safety rules that prevent agent self-harm
3. **Bridge** — Route to the right tool (Aspire CLI local, azure-diagnostics deployed)
4. **Recommend** — Tell developers to run `aspire agent init` for comprehensive guidance

## Repository Structure

```
aspire-skills/
├── plugin.json                         # Copilot CLI manifest
├── .plugin/plugin.json                 # Generic host manifest
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── .cursor-plugin/
│   └── marketplace.json
├── .mcp.json                           # MCP server config
├── gemini-extension.json               # Gemini CLI integration
├── hooks/
│   ├── copilot-hooks.json
│   ├── hooks.json
│   └── scripts/
│       ├── track-telemetry.sh
│       └── track-telemetry.ps1
├── skills/
│   └── aspire/
│       ├── SKILL.md                    # < 5000 tokens — detection, guardrails, bridge
│       └── references/
│           ├── safety-guardrails.md    # Detailed do/don't rules
│           ├── diagnostics-bridge.md   # Local vs deployed routing
│           └── detection.md            # How to recognize Aspire projects
├── .github/
│   ├── CODEOWNERS
│   └── plugins/
│       └── aspire-skills/              # Published plugin (mirrors root)
├── README.md
├── LICENSE                             # MIT
├── CHANGELOG.md
├── SECURITY.md
├── CODE_OF_CONDUCT.md
└── CONTRIBUTING.md
```

## Todos

### 1. `repo-scaffold` — Create repo structure and infrastructure files

Initialize `~/github/aspire-skills/` with:
- `git init`
- Root manifests: `plugin.json`, `.mcp.json`, `gemini-extension.json`
- Host manifests: `.plugin/plugin.json`, `.claude-plugin/`, `.cursor-plugin/`
- Hooks: `hooks/copilot-hooks.json`, `hooks/hooks.json`, `hooks/scripts/`
- Published plugin mirror: `.github/plugins/aspire-skills/`
- Repo files: README.md, LICENSE (MIT), SECURITY.md, CODE_OF_CONDUCT.md, CONTRIBUTING.md, CHANGELOG.md

**Depends on**: nothing

### 2. `aspire-skill` — Create skills/aspire/SKILL.md

Single thin skill covering:
- **Frontmatter**: name: aspire, description with trigger phrases, MIT, v1.0.0
- **Quick Reference**: key commands, prerequisites
- **Detection**: How to recognize Aspire AppHost projects
- **Safety Guardrails** (decision table):
  - ✅ `aspire start` — NEVER `dotnet run` for AppHosts
  - ✅ `aspire wait <resource>` — NEVER `curl` health polling
  - ✅ `aspire resource <name> restart` — NEVER `dotnet build` against locked files
  - ✅ `aspire stop` when done — NEVER leave processes running
- **Diagnostics Bridge** (decision table):
  - Local → Aspire CLI (`aspire logs`, `aspire otel`, `aspire describe`)
  - Deployed → azure-diagnostics (App Insights, ACA logs, `az monitor`)
- **Deployment**: Aspire deploys natively (`aspire publish`, `aspire deploy`, `aspire do`)
- **Recommendation**: Run `aspire agent init` for comprehensive guidance
- **Error Handling table**: file-locks, compile errors, port conflicts

**Depends on**: `repo-scaffold`

### 3. `aspire-refs` — Create reference files

- `references/safety-guardrails.md` — Detailed do/don't rules, error recovery patterns
- `references/diagnostics-bridge.md` — Local vs deployed decision table, azure-diagnostics handoff
- `references/detection.md` — Project fingerprinting (AppHost SDK, apphost.ts, .modules/)

**Depends on**: `aspire-skill`

### 4. `readme-and-docs` — Write README and repo docs

- README.md with installation for all 4 hosts, skill overview, relationship diagram
- CHANGELOG.md, CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md

**Depends on**: `aspire-skill`

### 5. `validate` — Test and verify

- Verify plugin.json schema matches azure-skills format
- Ensure SKILL.md < 5000 tokens
- Verify frontmatter compliance
- Test install commands (dry run)

**Depends on**: `aspire-refs`, `readme-and-docs`

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **One thin skill** | PR #15745 provides comprehensive coverage; plugin avoids duplication |
| **Plugin, not project-local** | Solves discoverability — no `aspire agent init` required |
| **Aspire deploys natively** | No azure-skills handoff — Aspire uses Bicep + Azure SDK directly |
| **azure-diagnostics bridge** | Aspire CLI is local-only; azure-diagnostics fills the deployed gap |
| **Follows azure-skills model** | Proven multi-host distribution to Copilot CLI, Claude, Gemini, Cursor |

## Open Questions (for Aspire team)

1. **Repo home**: `microsoft/aspire-skills` (separate) or directory in `microsoft/aspire`?
2. **Skill overlap**: Precedence when both plugin and project-local skills are present?
3. **CLI integration**: Would they accept `aspire skills init` PR?
4. **MCP server**: Plans for an Aspire MCP server?
5. **Telemetry**: Same hooks as azure-skills or different?
6. **Release cadence**: Align with Aspire CLI releases or independent?

## Reference Materials

- **Proposal gist**: https://gist.github.com/spboyer/d7a92a85b1a9f7699551739fcec56fcd
- **Issue**: [microsoft/aspire#15801](https://github.com/microsoft/aspire/issues/15801)
- **PR #15745**: Scenario-based skill rewrite (merged, 100% eval score)
- **PR #15918**: aspire-init skill spike (Maddy)
- **PR #15598**: `aspire resource rebuild` command
- **azure-skills**: Model repo at `microsoft/azure-skills`
