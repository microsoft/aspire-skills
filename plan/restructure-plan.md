# Restructure Plan: 3 Skills + PR #15745 Content

## Goal

Restructure from 1 consolidated skill to 3 focused skills (matching the gist proposal),
incorporating universal content from microsoft/aspire PR #15745's reference files.

## Why

1. **Discoverability** — Users get comprehensive guidance on plugin install, no `aspire agent init` needed
2. **Routing precision** — Separate skills = LLM picks the right one faster (azure-skills pattern)
3. **Solves #15801 completely** — Agents get full guidance out of the box, not a thin safety net
4. **Best practice** — azure-skills has 25+ focused skills, not one mega-skill

## New Structure

```
skills/
├── aspire-orchestration/           # Lifecycle management
│   ├── SKILL.md                    # Detection, guardrails, decision tables
│   └── references/
│       ├── safety-guardrails.md    # Existing — rules + recovery patterns
│       ├── detection.md            # Existing — project fingerprinting
│       ├── app-commands.md         # FROM PR #15745 — CLI command patterns
│       └── resource-management.md  # FROM PR #15745 — wait/restart/rebuild
│
├── aspire-deployment/              # Deployment pipeline
│   ├── SKILL.md                    # Multi-target deploy decision tables
│   └── references/
│       ├── deployment.md           # FROM PR #15745 — publish/deploy/do
│       └── tools-and-config.md     # FROM PR #15745 — docs/secrets/config
│
└── aspire-monitoring/              # Observability & diagnostics
    ├── SKILL.md                    # Local vs deployed routing
    └── references/
        ├── diagnostics-bridge.md   # Existing — local/deployed/multi-target
        └── monitoring.md           # FROM PR #15745 — logs/traces/metrics
```

## Content Mapping

### What gets pulled from PR #15745 (universal, belongs in plugin)

| PR #15745 File | → Plugin Skill | Rationale |
|----------------|---------------|-----------|
| `app-commands.md` | `aspire-orchestration/references/` | CLI command patterns are universal |
| `resource-management.md` | `aspire-orchestration/references/` | Wait/restart/rebuild patterns are universal |
| `monitoring.md` | `aspire-monitoring/references/` | Logs/traces/metrics patterns are universal |
| `deployment.md` | `aspire-deployment/references/` | Deploy pipeline is universal |
| `tools-and-configuration.md` | `aspire-deployment/references/` | Docs/secrets/config are universal |

### What stays project-local (specific, NOT pulled in)

| PR #15745 File | Why It Stays Project-Local |
|----------------|--------------------------|
| `csharp-apphosts.md` | C# AppHost editing is deeply project-specific |
| `typescript-apphosts.md` | TS AppHost editing is deeply project-specific |
| `playwright-handoff.md` | Browser testing patterns are project-specific |
| `agent-workflows.md` | Investigation patterns reference project structure |

### What we keep from current implementation

| Current File | → New Location | Changes |
|-------------|---------------|---------|
| `SKILL.md` | Split into 3 SKILL.md files | Each gets relevant sections |
| `detection.md` | `aspire-orchestration/references/` | No changes |
| `safety-guardrails.md` | `aspire-orchestration/references/` | No changes |
| `diagnostics-bridge.md` | `aspire-monitoring/references/` | No changes |

## SKILL.md Design (per skill)

Each SKILL.md needs High sensei compliance:
- `**WORKFLOW SKILL**` prefix
- `USE FOR:` trigger phrases (5+)
- `DO NOT USE FOR:` anti-triggers with routing to other skills
- `INVOKES:` tool relationships
- Under 5000 tokens (SKILL.md), under 2000 tokens (references)

### aspire-orchestration SKILL.md
- **Triggers**: aspire start, aspire stop, aspire wait, aspire run, aspire ps, rebuild resource, code change workflow, file lock error, AppHost detected
- **Anti-triggers**: deployment (→ aspire-deployment), logs/traces/monitoring (→ aspire-monitoring), non-Aspire .NET (use dotnet)
- **Content**: Detection table, safety guardrails table, error recovery table, recommendation for `aspire agent init`

### aspire-deployment SKILL.md
- **Triggers**: deploy, publish, push to Azure, aspire deploy, aspire publish, aspire do, ship it, go live, Docker Compose, Kubernetes
- **Anti-triggers**: local dev lifecycle (→ aspire-orchestration), monitoring (→ aspire-monitoring), Azure infra without Aspire (→ azure-prepare)
- **Content**: Multi-target deployment table, pipeline commands, deployment gotchas

### aspire-monitoring SKILL.md
- **Triggers**: logs, traces, metrics, aspire logs, aspire otel, dashboard, describe, export, debug deployed app, App Insights
- **Anti-triggers**: local lifecycle (→ aspire-orchestration), deployment (→ aspire-deployment), Azure resource creation (→ azure-prepare)
- **Content**: Diagnostics bridge table, local vs deployed routing, known OTEL issues

## Handoff Rules (between the 3 skills)

```
aspire-orchestration ←→ aspire-deployment
    "deploy" / "publish" → aspire-deployment
    "start" / "stop" / "rebuild" → aspire-orchestration

aspire-orchestration ←→ aspire-monitoring
    "logs" / "traces" / "dashboard" → aspire-monitoring
    "start" / "wait" / "rebuild" → aspire-orchestration

aspire-monitoring → azure-diagnostics (azure-skills)
    "deployed app logs" / "production App Insights" → azure-diagnostics
```

## Implementation Steps

1. Read PR #15745 reference files (universal ones)
2. Create 3 new skill directories with SKILL.md files (High sensei compliance)
3. Move existing references to correct skill
4. Adapt PR #15745 content for plugin context (strip project-local assumptions)
5. Update `.plugin/plugin.json` to reflect 3 skills
6. Update README.md
7. Update `.github/plugins/` mirror symlinks
8. Run sensei scoring on all 3 skills
9. Commit

## Project-Local Routing (kept in each SKILL.md)

Each skill still includes a routing note:
> If `.agents/skills/aspire/` exists (from `aspire agent init`), the project-local skill provides
> deeper, project-specific guidance for C# AppHost editing, TS AppHost patterns, Playwright testing,
> and investigation workflows. This plugin's safety guardrails ALWAYS apply.

## Token Budget

| File | Target | Hard Limit |
|------|--------|------------|
| Each SKILL.md | < 500 | 5000 |
| Each reference/*.md | < 1000 | 2000 |
| Total per skill | < 3000 | — |
