# Aspire Skills

Aspire Skills is a plugin and skill pack for AI coding agents working on .NET Aspire distributed applications.

It helps agents recognize Aspire workspaces, use the Aspire CLI correctly, and route common work to focused skills instead of falling back to ad hoc `dotnet`, `curl`, Docker, or shell workflows.

## What's included

| Skill | Purpose |
|-------|---------|
| `aspire` | Top-level router for Aspire projects |
| `aspire-init` | Creates a new Aspire project or adds an Aspire skeleton to an existing repo |
| `aspireify` | Wires an AppHost after `aspire init` |
| `aspire-orchestration` | Starts, stops, waits for, and manages Aspire resources |
| `aspire-deployment` | Publishes, deploys, and tears down Aspire apps |
| `aspire-monitoring` | Routes logs, traces, dashboard, telemetry, and diagnostics work |

## Install

Choose the command for your agent host:

```bash
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

# OpenCode
apm install microsoft/aspire-skills

# skills.sh
npx skills add microsoft/aspire-skills
```

## Repository layout

| Path | Purpose |
|------|---------|
| `skills/` | Source skill files, references, and evals |
| `hooks/` | Hook scripts used by supported agent hosts |
| `.plugin/`, `.claude-plugin/`, `.cursor-plugin/` | Plugin metadata for marketplaces |
| `.github/plugins/aspire-skills/` | Published plugin mirror |
| `evals/` | Shared evaluation fixtures and helpers |
| `src/`, `docs/`, `public/` | Documentation site source and assets |

## Development

```bash
npm install
npm run build
npm run bundle
```

`npm run build` validates the Astro documentation site. `npm run bundle` builds the published Aspire Skills plugin bundle.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## License

[MIT](LICENSE)
