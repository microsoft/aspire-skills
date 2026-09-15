# Aspire Skills

Aspire Skills is a plugin, skill pack, and extension pack for AI coding agents working on Aspire distributed applications.

It helps agents recognize Aspire workspaces, use the Aspire CLI correctly, route common work to focused skills instead of ad hoc `dotnet`, `curl`, Docker, or shell workflows, and surface focused visual tools for Aspire-specific tasks.

## What's included

### Skills

| Skill | Purpose |
|-------|---------|
| `aspire` | Top-level router for Aspire projects |
| `aspire-init` | Creates a new Aspire project or adds an Aspire skeleton to an existing repo |
| `aspireify` | Wires an AppHost after `aspire init` |
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

Aspire's first-party agent setup installs Aspire skill files, extension files, and MCP configuration into detected agent environments.

```bash
# Create a new Aspire app and opt into agent guidance when prompted
aspire new

# Or add Aspire to an existing repo and opt into agent guidance when prompted
aspire init

# Add, update, or reconfigure Aspire guidance in an existing workspace
aspire agent init
```

### Agent plugins and extensions

#### GitHub Copilot app

The GitHub Copilot app plugin installs Aspire skills and canvas extensions for
the current user.

##### Prerequisites

Before you install, make sure you have:

- [GitHub Copilot app](https://gh.io/app) installed.
- A GitHub Copilot subscription (paid or free).

##### Install

Install the `microsoft/aspire-skills` marketplace through the GitHub Copilot
app:

1. Click [this link](https://github.com/copilot/app/launch?entry_point=aspire_skills_docs&open=ghapp%3A%2F%2Fplugins%2Fmarketplace%2Fadd%3Fsource%3Dmicrosoft%2Faspire-skills)
   to automatically open the **Settings** > **Plugins** window in the GitHub
   Copilot app.
2. In the **Add plugin marketplace?** dialog, select **Allow**.
3. The **Plugins** window opens with the `microsoft/aspire-skills` marketplace.
   Select **Add marketplace**.
4. Expand the `aspire-skills` entry and select **Install** on the `aspire`
   plugin.

#### Command-line hosts

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

## Repository layout

| Path | Purpose |
|------|---------|
| `skills/` | Source skill files, references, and evals |
| `extensions/` | Source GitHub Copilot app canvas extensions |
| `hooks/scripts/` | Canonical Aspire CLI agent telemetry hooks |
| `.plugin/`, `.claude-plugin/`, `.cursor-plugin/` | Plugin metadata for marketplaces |
| `.github/plugins/aspire-skills/` | Published plugin mirror |
| `evals/` | Shared evaluation fixtures and helpers |

## Development

```bash
npm run bundle
```

`npm run bundle` builds both published release artifacts:

| Artifact | Contents |
|----------|----------|
| `aspire-skills-v<version>.tgz` | Agent skill files, canonical telemetry hooks, and `skill-manifest.json` with hook commit/SHA-512 provenance |
| `aspire-extensions-v<version>.tgz` | GitHub Copilot app canvas extension files and `extension-manifest.json` |

The skills manifest records the release commit and LF-normalized SHA-512 hash for
each file under `hooks/scripts/`. Downstream consumers can copy the `hooks` object
directly instead of maintaining hook provenance separately.

Use `npm run bundle:skills` or `npm run bundle:extensions` to build one bundle type.

### Publishing releases

**Publish Aspire bundles** runs on version-tag pushes and manual dispatches.
Pushing a tag matching `v*` or `[0-9]*` publishes only `aspire-skills` to that
existing tag. The pushed name is preserved: pushing `0.0.3` publishes to `0.0.3`,
while pushing `v0.0.3` publishes to `v0.0.3`. Tag deletions do not publish.

For a manual run, select the source ref to release and provide a `version` such
as `0.0.3` or `v0.0.3`. Both inputs create `v0.0.3` at the checked-out commit if
that tag does not already exist. The version and resulting Git tag name are
validated before building. Manual runs expose two checkboxes:
`include_skills` (checked by default) and `include_extensions` (unchecked by
default). Select either bundle or both; selecting neither fails before testing or
publishing. Only selected bundles are built for release, attested, and uploaded.

Authentication uses the built-in, repository-scoped `GITHUB_TOKEN` with
`contents: write`. No additional GitHub App, repository variables, or secrets are
required.

A manual run creates a missing tag only after testing, building, and attesting
the selected bundles. Tags created using `GITHUB_TOKEN` do not trigger another
publish run. Runs are serialized without cancelling an in-progress release.
Up to 100 pending runs are retained instead of replacing an earlier queued
release; additional runs are cancelled if that queue is full.

An existing tag is reused only if it resolves to the same source commit;
otherwise, the run fails without publishing or moving the tag. A tag-push run
fails if its tag has since been deleted; it never recreates the tag. If a manual
run fails after tag creation, rerun it with the same version and source commit.
Reruns replace only selected release assets and do not delete unselected assets.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## License

[MIT](LICENSE)
