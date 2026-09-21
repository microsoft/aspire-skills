# Aspire Skills

Aspire Skills is a plugin, skill pack, and extension pack for AI coding agents working on Aspire distributed applications.

It helps agents recognize Aspire workspaces, use the Aspire CLI correctly, route common work to focused skills instead of ad hoc `dotnet`, `curl`, Docker, or shell workflows, and surface focused visual tools for Aspire-specific tasks.

## What's included

### Skills

| Skill | Purpose |
|-------|---------|
| `aspire` | Top-level router for Aspire projects |
| `aspire-init` | Creates a new Aspire project or adds an Aspire skeleton to an existing repo |
| `aspireify` | Wires a new AppHost or extends an existing application graph |
| `aspire-project-v2-migration` | Assesses and migrates eligible Aspire 13.6+ legacy project resources to Project v2 after explicit edit approval |
| `aspire-orchestration` | Starts, stops, waits for, and manages Aspire resources |
| `aspire-deployment` | Publishes, deploys, and tears down Aspire apps |
| `aspire-monitoring` | Routes logs, traces, dashboard, telemetry, and diagnostics work |

### Extensions

| Extension | Purpose |
|-----------|---------|
| `aspire-doctor` | Visualizes `aspire doctor` environment checks, suggested fixes, and detected CLI installations |
| `aspireify` | Presents Aspireify findings and the proposed resource plan for confirmation before AppHost edits |
| `aspire-apphosts` | Workspace and Global AppHost workbench |

## Install

Choose the path that matches your agent host.

### Aspire CLI

Aspire's first-party agent setup installs Aspire skill files and extension files into detected agent environments. Aspire MCP server configuration is separate and opt-in.

- In Aspire 13.6 and later, the agent setup that `aspire new` and `aspire init` run preselects the recommended repository-local skills, including `aspireify`. It doesn't offer MCP configuration.
- Standalone `aspire agent init` keeps an MCP choice that's off by default. It doesn't configure MCP in non-interactive runs unless you pass `--mcp`.

**Create a new Aspire app** and opt into agent guidance when prompted:

```bash
aspire new
```

**Add Aspire to an existing repository** and opt into agent guidance when prompted:

```bash
aspire init
```

**Add, update, or reconfigure agent guidance** in an existing Aspire workspace:

```bash
aspire agent init
```

**Configure the Aspire MCP server** only when you want it (Aspire 13.6+):

```bash
aspire agent init --mcp
```

In Aspire 13.5, run `aspire agent init` interactively and select the MCP server option; 13.5 has no `--mcp` flag.

### GitHub Copilot app

The GitHub Copilot app plugin installs Aspire skills and canvas extensions for
the current user.

**Prerequisites:**

- [GitHub Copilot app](https://gh.io/app) installed.
- A GitHub Copilot subscription (paid or free).

**Install the plugin:**

1. Click [this link](https://github.com/copilot/app/launch?entry_point=aspire_skills_docs&open=ghapp%3A%2F%2Fplugins%2Fmarketplace%2Fadd%3Fsource%3Dmicrosoft%2Faspire-skills)
   to automatically open the **Settings** > **Plugins** window in the GitHub
   Copilot app.
2. In the **Add plugin marketplace?** dialog, select **Allow**.
3. The **Plugins** window opens with the `microsoft/aspire-skills` marketplace.
   Select **Add marketplace**.
4. Expand the `aspire-skills` entry and select **Install** on the `aspire`
   plugin.

### GitHub Copilot CLI

Start Copilot CLI with `copilot`, then run the following commands inside it.

**Add the marketplace** (first time only):

```text
/plugin marketplace add microsoft/aspire-skills
```

**Install the plugin:**

```text
/plugin install aspire@aspire-skills
```

**Update the plugin:**

```text
/plugin update aspire@aspire-skills
```

### Claude Code

Start Claude Code with `claude`, then run the following commands inside it.

**Add the marketplace** (first time only):

```text
/plugin marketplace add microsoft/aspire-skills
```

**Install the plugin:**

```text
/plugin install aspire@aspire-skills
```

**Update the plugin:**

```text
/plugin update aspire@aspire-skills
```

### Gemini CLI

**Install the extension:**

```bash
gemini extensions install https://github.com/microsoft/aspire-skills
```

### Cursor CLI

**Install the skills:**

```bash
mkdir -p ~/.cursor/skills
git clone https://github.com/microsoft/aspire-skills ~/.cursor/skills/aspire-skills
```

**Start Cursor CLI:**

```bash
agent
```

### Codex CLI

**Add the marketplace** (first time only):

```bash
codex plugin marketplace add microsoft/aspire-skills
```

**Install the plugin:**

Start Codex with `codex`, run `/plugins`, and install `aspire` from the
`aspire-skills` marketplace.

### OpenCode

**Install using [APM](https://github.com/microsoft/apm), then start OpenCode:**

```bash
apm install microsoft/aspire-skills
opencode
```

### Ollama + Copilot CLI

**Launch Copilot with Ollama:**

```bash
ollama launch copilot
```

In the Copilot session that opens, run the `/plugin` commands from
[GitHub Copilot CLI](#github-copilot-cli) above to add the marketplace and install
or update `aspire`.

### skills.sh via NPX

Use the Skills-compatible installer when your agent host supports skills.sh-managed skill locations.

**Install the skills:**

```bash
npx skills add microsoft/aspire-skills
```

For hosts that need an explicit skills directory and target agent, install from the `skills/` folder:

```bash
npx skills add https://github.com/microsoft/aspire-skills/tree/main/skills \
  -a github-copilot -g -y
```

In that command, `-a github-copilot` selects the target agent, `-g` installs globally, and `-y` accepts prompts.

## Repository layout

| Path | Purpose |
|------|---------|
| `skills/` | Source skill files, references, and evals |
| `docs/` | Documentation |
| `extensions/` | Source GitHub Copilot app canvas extensions |
| `hooks/scripts/` | Canonical Aspire CLI agent telemetry hooks |
| `.plugin/`, `.claude-plugin/`, `.cursor-plugin/` | Plugin metadata for marketplaces |
| `.github/plugins/aspire-skills/` | Published plugin mirror |
| `evals/` | Shared evaluation fixtures and helpers |

## Development

Install test dependencies without lifecycle scripts, then run the repository checks:

```bash
npm ci --ignore-scripts
npm test
npm run catalog
```

Catalog generation should leave the checked-in `opencode/` output unchanged for
a clean tree. Releases are source-only:
[the release workflow](.github/workflows/release.yml) uses trusted `main` tooling
to prepare and verify a draft release PR, then tags and publishes the exact
reviewed `main` merge. See the [development guide](docs/development.md) for the
release flow.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.
See the [development guide](docs/development.md) for local development.

## License

[MIT](LICENSE)
