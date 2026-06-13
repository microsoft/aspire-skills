# Aspire Skills

Aspire Skills is a plugin and skill pack for AI coding agents working on Aspire distributed applications.

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

Choose the path that matches your agent host.

### Aspire CLI

Aspire's first-party agent setup installs Aspire skill files and MCP configuration into detected agent environments.

```bash
# Create a new Aspire app and opt into agent guidance when prompted
aspire new

# Or add Aspire to an existing repo and opt into agent guidance when prompted
aspire init

# Add, update, or reconfigure Aspire guidance in an existing workspace
aspire agent init
```

### Agent plugins and extensions

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
agent

# OpenCode
apm install microsoft/aspire-skills
opencode

# Ollama + Copilot CLI
ollama launch copilot
copilot plugin marketplace add microsoft/aspire-skills
copilot plugin install aspire@aspire-skills
```

### skills.sh via NPX

Use the Skills-compatible installer when your agent host supports skills.sh-managed skill locations.

```bash
npx skills add microsoft/aspire-skills
```

For hosts that need an explicit skills directory and target agent, install from the `skills/` folder:

```bash
npx skills add https://github.com/microsoft/aspire-skills/tree/main/skills \
  -a github-copilot -g -y
```

In that command, `-a github-copilot` selects the target agent, `-g` installs globally, and `-y` accepts prompts.

### skills via DNX

**On .NET 10 or later?** `dnx` ships with the .NET 10 SDK and runs [`skillz`](https://www.nuget.org/packages/skillz), which is like `skills` but natively a .NET tool, no Node.js required:

```bash
dnx skillz add microsoft/aspire-skills
```

## Repository layout

| Path | Purpose |
|------|---------|
| `skills/` | Source skill files, references, and evals |
| `hooks/` | Hook scripts used by supported agent hosts |
| `.plugin/`, `.claude-plugin/`, `.cursor-plugin/` | Plugin metadata for marketplaces |
| `.github/plugins/aspire-skills/` | Published plugin mirror |
| `evals/` | Shared evaluation fixtures and helpers |

## Development

```bash
npm run bundle
```

`npm run bundle` builds the published Aspire Skills plugin bundle.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## License

[MIT](LICENSE)
