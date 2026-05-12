# aspire-skills

Always-on AI agent safety net for Aspire projects.

## Problem

AI coding agents cause active harm in Aspire projects ([microsoft/aspire#15801](https://github.com/microsoft/aspire/issues/15801)). They run `dotnet run` instead of `aspire start`, poll with `curl` instead of `aspire wait`, `dotnet build` into file-lock errors, and leave orphaned processes. The root cause: Aspire ships great agent guidance via `aspire agent init`, but most developers never run it.

This plugin is the safety net — it's always on, installed from the marketplace, and catches dangerous commands before they cause damage.

## What This Plugin Does

A single thin skill with four layers:

### 1. Detects — Recognizes Aspire AppHost projects

Identifies `.csproj` files referencing `Aspire.AppHost.Sdk`, `apphost.ts` files, and other Aspire project markers to activate guardrails automatically.

### 2. Guards — Enforces safety rules

| Instead of… | Use… | Why |
|---|---|---|
| `dotnet run` | `aspire start` | Starts the full orchestrator, not just one project |
| `curl` polling | `aspire wait <resource>` | Waits for actual readiness, not just HTTP 200 |
| `dotnet build` (while running) | `aspire resource <name> restart` | Avoids file-lock errors on running processes |
| Leaving processes running | `aspire stop` | Prevents orphaned DCP/dashboard processes |

### 3. Bridges — Routes diagnostics to the right tool

| Environment | Tool | Examples |
|---|---|---|
| **Local** | Aspire CLI | `aspire logs`, `aspire describe`, `aspire otel` |
| **Deployed** | azure-diagnostics | App Insights, ACA logs, `az monitor` |

### 4. Recommends — Suggests comprehensive setup

Tells developers to run `aspire agent init` for scenario-based reference files (PR [#15745](https://github.com/microsoft/aspire/pull/15745)) covering all Aspire workflows.

## Installation

```bash
# Aspire CLI
aspire new
# select y when prompted to configure AI agent environments

aspire init
# select y when prompted to install Aspire agent guidance

aspire agent init

# GitHub Copilot CLI
copilot plugin marketplace add microsoft/aspire-skills
copilot plugin install aspire@aspire-skills

# Claude Code CLI
claude
/plugin marketplace add microsoft/aspire-skills
/plugin install aspire@aspire-skills

# Codex CLI
codex plugin marketplace add microsoft/aspire-skills
# then open /plugins and install aspire

# Gemini CLI
gemini extensions install https://github.com/microsoft/aspire-skills

# Cursor CLI
mkdir -p ~/.cursor/skills
git clone https://github.com/microsoft/aspire-skills ~/.cursor/skills/aspire-skills
agent

# OpenCode
apm install microsoft/aspire-skills
opencode

# Ollama + Copilot CLI
ollama launch copilot
copilot plugin marketplace add microsoft/aspire-skills
copilot plugin install aspire@aspire-skills

# skills.sh via NPX
npx skills add microsoft/aspire-skills
```

## How It Fits Together

```
┌─────────────────────────────────────────────────────────┐
│  1. aspire-skills plugin (always-on via marketplace)    │  ← You are here
│     Detects, guards, bridges, recommends                │
├─────────────────────────────────────────────────────────┤
│  2. Project-local skill (after `aspire agent init`)     │  ← PR #15745
│     9 scenario files, 319 assertions, 100% eval score   │
├─────────────────────────────────────────────────────────┤
│  3. aspire-init skill (one-time setup)                  │  ← PR #15918
│     Scaffolds agent guidance into any Aspire project    │
├─────────────────────────────────────────────────────────┤
│  4. azure-skills plugin (production monitoring)         │  ← microsoft/azure-skills
│     Azure diagnostics, deployment, cost management      │
└─────────────────────────────────────────────────────────┘
```

The plugin (layer 1) is the safety net that catches mistakes even when project-local guidance hasn't been set up. Once `aspire agent init` runs (layer 2), the project-local skill provides comprehensive coverage and the plugin defers to it.

## Quick Reference

Key Aspire CLI commands the plugin enforces and routes to:

| Command | Purpose |
|---------|---------|
| `aspire start` | Start the AppHost orchestrator |
| `aspire stop` | Stop all resources and the dashboard |
| `aspire wait <resource>` | Wait for a resource to be ready |
| `aspire resource <name> restart` | Restart a changed resource |
| `aspire logs` | View console logs |
| `aspire describe` | Show resource state and endpoints |
| `aspire publish` | Generate deployment artifacts (Bicep, manifests) |
| `aspire deploy` | Full deployment pipeline |

## Related Projects

- [microsoft/aspire](https://github.com/microsoft/aspire) — Aspire framework and CLI
- [microsoft/azure-skills](https://github.com/microsoft/azure-skills) — Azure skills plugin (model for this repo)
- [aspire#15745](https://github.com/microsoft/aspire/pull/15745) — Scenario-based agent guidance (merged)
- [aspire#15918](https://github.com/microsoft/aspire/pull/15918) — `aspire agent init` skill spike

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to contribute to this project.

## License

[MIT](LICENSE)
