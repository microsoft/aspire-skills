# Evolution: From Gist Proposal to Current State

## Timeline

### Phase 1: Original Gist Proposal
- **Gist**: https://gist.github.com/spboyer/d7a92a85b1a9f7699551739fcec56fcd
- **Structure**: 3 separate skills
  - `aspire-orchestration/` — Core lifecycle management (start/stop/wait/rebuild)
  - `aspire-deployment/` — Native multi-target deployment pipeline
  - `aspire-monitoring/` — Local diagnostics + azure-diagnostics bridge for production
- **7 reference files** across 3 skills
- **4 workflow diagrams** (end-to-end, lifecycle, file-lock recovery, ecosystem)
- **CLI command reference** appendix (18 commands)

### Phase 2: Thin-Plugin Pivot
After discovering PR #15745 (David Fowler's project-local skill with 9 reference files, 100% eval on 319 assertions), we pivoted:
- **Rationale**: PR #15745 already covers 95% of operational guidance
- **Decision**: Consolidate to 1 thin "safety-net" skill (`aspire/`)
- **Scope**: Detection, guardrails, diagnostics bridge, bootstrap recommendation
- **Gap**: Users who don't run `aspire agent init` get only thin coverage

### Phase 3: Audit & Corrections (Current State)
Three deep audits revealed critical errors in the thin skill:
- .NET version (9 → 10), install method (dotnet tool → standalone binary)
- Config file name (`aspire.json` → `aspire.config.json`)
- Deployment targets (Azure-only → multi-target)
- 15 missing CLI commands
- JSON output caveats, `--non-interactive`, known bugs

All corrections applied. Sensei score: **High**.

### Phase 4: Restructure to 3 Skills + PR #15745 Content (Next)
See [restructure-plan.md](restructure-plan.md).

## What Changed From the Gist

| Gist Proposal | Current State | Why |
|--------------|---------------|-----|
| 3 skills | 1 consolidated skill | Pivot based on PR #15745 |
| 7 reference files | 3 reference files | Consolidation |
| Root `plugin.json` | Not needed (`.plugin/plugin.json` sufficient) | azure-skills pattern |
| `.github/plugins/` partial | Full symlink mirror (14 links) | Best practice |
| Azure-only deployment | Multi-target (Azure, Docker, K8s) | Docs audit correction |
| `aspire.json` | `aspire.config.json` | Docs audit correction |
| .NET 9 | .NET 10.0 SDK | Docs audit correction |
| `dotnet tool install` | `curl -sSL https://aspire.dev/install.sh` | Docs audit correction |
| No sensei compliance | High sensei score | sensei skill audit |
| No known bugs | 6 bug rows with issue links | Issues audit |
| No `--non-interactive` | Rule 6 added | Issues audit |
| No project-local routing | 10-row routing table | Existing skill analysis |

## Lessons Learned

1. **Always verify CLI docs before writing skills** — the Aspire CLI changed significantly between proposal and audit
2. **The gist body wasn't updated when we pivoted** — caused confusion about intent
3. **Symlinks > file copies** for `.github/plugins/` mirror — single source of truth
4. **Sensei scoring catches routing gaps** — forced us to add USE FOR/DO NOT USE FOR/INVOKES
5. **Multi-target deployment is non-negotiable** — Aspire isn't Azure-only
