# Marketplace submission

How to distribute `microsoft/aspire-skills` across AI agent platforms (Claude Code, Cursor, Codex CLI, Gemini CLI, Copilot CLI, JetBrains, APM, MCP registries).

> **Reference implementation:** [`microsoft/azure-skills`](https://github.com/microsoft/azure-skills) is a sibling Microsoft project shipping the same plugin model across every channel below. It's the production template we mirror.

---

## TL;DR — install commands (once published)

| Platform | Command |
|---|---|
| Claude Code | `/plugin marketplace add microsoft/aspire-skills` then `/plugin install aspire@aspire-skills` |
| Cursor | Settings → Plugins → search "Aspire" (after Anysphere lists us in the marketplace) |
| Codex CLI | `codex plugin marketplace add microsoft/aspire-skills` |
| Gemini CLI | `gemini extensions install microsoft/aspire-skills` |
| Copilot CLI | `/mcp add` against `.mcp.json` (see [Copilot CLI section](#5-github-copilot-cli)) |
| JetBrains | `npx skills add https://github.com/microsoft/aspire-skills/tree/main/skills -a github-copilot -g -y` |
| APM (cross-platform) | `apm install microsoft/aspire-skills` |

All of the above require `microsoft/aspire-skills` to be **public**.

---

## Cross-cutting blockers

Resolve these before pursuing any single channel:

| # | Blocker | Owner | Notes |
|---|---|---|---|
| 1 | **Repo must be PUBLIC** | Microsoft IP / legal review | Single largest gate. All install commands above need URL-based fetch. |
| 2 | **Telemetry disclosure** | Engineering / privacy | `hooks/scripts/track-telemetry.sh` + `.ps1` collect data — audit + document opt-out env var (`ASPIRE_SKILLS_COLLECT_TELEMETRY=false` per azure-skills convention). |
| 3 | **Version string alignment** | Engineering | `plugin.json` says `2.0.0`; SKILL.md says `2.1.0`. Pick a single source (git tag or NBGV) and stamp. |
| 4 | **`marketplace.json` populated** | Engineering | `.claude-plugin/marketplace.json` and `.cursor-plugin/marketplace.json` are placeholders today — Claude Code submission and Codex CLI both require populated content. |
| 5 | **Microsoft brand check** | Legal / brand | `author.name: "Microsoft"` is fine (azure-skills uses it freely). VS Code Marketplace publisher (`ms-azuretools` / `ms-dotnet`) needs Azure DevOps PAT — only relevant if shipping a VS Code extension wrapper. |

---

## Channels

### 1. Claude Code Plugin Marketplace

- **Status:** ✅ Active and accepting submissions (May 2026)
- **Docs:** <https://code.claude.com/docs/en/plugins> · <https://code.claude.com/docs/en/plugin-marketplaces>
- **Directory:** <https://claude.com/plugins>

**Manifest:** `.claude-plugin/plugin.json` (✅ structurally correct in this repo).

**Marketplace manifest:** `.claude-plugin/marketplace.json` — must be a populated catalog, e.g.:

```json
{
  "name": "aspire-skills",
  "owner": { "name": "Microsoft", "email": "..." },
  "description": "Aspire skills plugin for AI coding agents",
  "plugins": [
    {
      "name": "aspire",
      "source": "./",
      "description": "Top-level router + 5 sub-skills for Aspire 13.3+",
      "version": "2.1.0",
      "author": { "name": "Microsoft" },
      "homepage": "https://github.com/microsoft/aspire-skills",
      "repository": "https://github.com/microsoft/aspire-skills",
      "license": "MIT",
      "category": "developer-tools",
      "tags": ["aspire", "dotnet", "cloud-native"],
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" }
    }
  ]
}
```

**Submission paths:**

- **Path A — official directory:** Visit <https://claude.com/plugins>, click "Share your plugin with the Claude community", fill the web form. Anthropic does basic automated review; a manual pass earns the "Anthropic Verified" badge. No published SLA.
- **Path B — self-distributed marketplace:** Anyone can `/plugin marketplace add microsoft/aspire-skills` once `marketplace.json` is populated and the repo is public.
- **Path C — Anthropic Partner Skills:** PR to [`anthropics/skills`](https://github.com/anthropics/skills) or partnership channel (only Notion listed today; Microsoft-grade brand should help).

**Versioning:** If `version` is set in `plugin.json`, users update on bump. If omitted, every commit SHA is treated as a new version. Keep `version` and bump on tag.

### 2. Cursor Marketplace

- **Status:** ✅ Active (live at <https://cursor.com/marketplace>; `microsoft/azure-skills` is listed there)
- **Docs:** <https://cursor.com/docs/skills>
- **Manifest:** uses the agentskills.io spec — same SKILL.md as Claude Code; `.cursor-plugin/marketplace.json` for catalog metadata.

**Submission:** Mechanism is not publicly documented. azure-skills got listed via direct contact with Anysphere. For aspire-skills: reach out via the existing Microsoft ↔ Anysphere business channel after the repo is public and `.cursor-plugin/marketplace.json` is populated.

**Install (post-listing):** Cursor → Settings → Plugins → search "Aspire".

### 3. OpenAI Codex CLI

- **Status:** ✅ Active (full plugin system)
- **Docs:** <https://developers.openai.com/codex/plugins/build>

**Big win:** Codex reads `.claude-plugin/marketplace.json` directly. Populating that one file covers both Claude Code AND Codex CLI.

**Codex-specific extras** in the marketplace manifest (already shown above): `policy.installation`, `policy.authentication`, `category`. Codex also accepts a `.codex-plugin/plugin.json` if a Codex-specific manifest is needed, but the Claude-style one is sufficient.

**Install:**

```bash
codex plugin marketplace add microsoft/aspire-skills
# /plugins → install aspire
```

### 4. Gemini CLI Extensions

- **Status:** ✅ Active (no central registry — pure git-based distribution)
- **Docs:** <https://google-gemini.github.io/gemini-cli/docs/extensions/>

**Manifest:** `gemini-extension.json` — fields: `name`, `version`, optional `mcpServers`, `contextFileName`, `excludeTools`. Microsoft's azure-skills also includes `description` (non-spec but harmless) — keep ours.

**Install paths:**

```bash
gemini extensions install microsoft/aspire-skills
gemini extensions install microsoft/aspire-skills --ref=v2.1.0
```

**GitHub Releases acceleration:** attach `.tar.gz`/`.zip` artifacts (named `darwin.arm64.aspire.tar.gz`, etc.) to GitHub releases — CLI auto-discovers the latest release.

**Update:** `gemini extensions update aspire`.

### 5. GitHub Copilot CLI

- **Status:** ✅ Active for **MCP servers**, no agent-skills marketplace path
- **Docs:** <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers>

Copilot CLI's extension mechanism is MCP, not skills. Our `.mcp.json` references `context7` — Copilot CLI users add it via `/mcp add` or `~/.copilot/mcp-config.json`.

**Copilot CLI MCP format requires `"type": "stdio"`** (not in plain MCP spec):

```json
{
  "mcpServers": {
    "context7": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"]
    }
  }
}
```

**To get on the curated [github.com/mcp](https://github.com/mcp) registry:** requires building a standalone `@microsoft/aspire-mcp` npm package (Aspire CLI ops as MCP tools). Microsoft already has multiple servers there (`azure-mcp`, `azure-devops-mcp`, `microsoft-docs-mcp`, `playwright-mcp`) — leverage that relationship for listing.

### 6. JetBrains IDEs (Rider, IntelliJ, etc.)

- **Status:** ✅ Active via `npx skills add` CLI
- **Compatibility:** works with the existing `skills/` directory structure — no extra manifest needed

**Install:**

```bash
npx skills add https://github.com/microsoft/aspire-skills/tree/main/skills \
  -a github-copilot -g -y
```

High-value for the **Rider** audience (.NET / Aspire developers).

### 7. APM — Agent Package Manager (cross-platform)

- **Status:** ✅ Active
- **Docs:** <https://github.com/microsoft/apm>

APM is Microsoft's cross-platform agent installer. Works against GitHub Copilot, Claude Code, Cursor, OpenCode, Codex, Gemini, Windsurf — from a single `apm.yml`.

```bash
apm install microsoft/aspire-skills
```

**Optional `apm.yml` in the repo root** lists dependencies (other plugins, MCP servers). Adding one is low effort and unlocks APM marketplace listings.

### 8. Anthropic Skills Hub (`anthropics/skills`)

- **Status:** ✅ Active
- **Docs:** <https://github.com/anthropics/skills>

Anthropic's open-source skills reference repo. Functions as a de facto directory:

```bash
/plugin marketplace add anthropics/skills
```

**To be listed in their "Partner Skills" section:** PR to `anthropics/skills` or partnership channel (only Notion listed today).

### 9. MCP Server Registries (future — requires building an MCP server)

These channels need a standalone `@microsoft/aspire-mcp` npm package. Out of scope for v1; tracked here for sequencing.

| Registry | URL | Status | Submission |
|---|---|---|---|
| Official MCP Registry | <https://registry.modelcontextprotocol.io> | Preview, GA forthcoming | `mcp-publisher publish` from microsoft org GitHub Actions OIDC |
| Smithery | <https://smithery.ai> | Active | npm package + submission |
| Glama | <https://glama.ai> | Active | Submit GitHub repo URL — auto-indexed (free) |
| GitHub MCP Registry | <https://github.com/mcp> | Active (curated) | Microsoft partner channel |

### 10. Azure AI Foundry (enterprise)

- **Status:** ✅ Active for tenant-scoped deployment; **no public skills marketplace**
- **Docs:** <https://learn.microsoft.com/en-us/azure/ai-foundry/agents/overview>

Possible internal path: package the skills' instructions as a Foundry **prompt agent template**, publish via Entra Agent Registry within the Microsoft tenant. Enterprise distribution, not public.

### 11. Channels NOT recommended

| Channel | Why not |
|---|---|
| OpenAI GPT Store | Architecture mismatch — GPTs are conversation-based, not file-system skills. |
| GitHub Copilot Extensions for IDE | Requires building a hosted GitHub App with Copilot Extensibility API. Major re-architecture. |
| OpenCode / Aider / Continue / Cline / Windsurf | No skills marketplace. MCP-based extension only. Adding `AGENTS.md` to repo is the most we can do. |
| agentskills.io | Domain unreachable (May 2026). The spec lives in `anthropics/skills`. |

---

## Recommended sequencing

### Phase 1 — Pre-publication (~1 week)

1. Audit `hooks/scripts/track-telemetry.sh` / `.ps1`; document opt-out env var.
2. Align version strings across manifests (single source, git tag).
3. Populate `.claude-plugin/marketplace.json` (also covers Codex).
4. Populate `.cursor-plugin/marketplace.json`.
5. Add `"type": "stdio"` to `.mcp.json` (Copilot CLI compatibility).
6. Add `apm.yml` for APM compatibility.
7. Update `README.md` with [Client Support Matrix](#client-support-matrix-template) and install commands.
8. Microsoft IP / legal review for public release.
9. Make the repo PUBLIC.

### Phase 2 — First submissions (week 1–2 post-public)

| Order | Channel | Action |
|---|---|---|
| 1 | Gemini CLI | Push GitHub release tag `v2.1.0` with archives. |
| 2 | Claude Code Marketplace | Submit at <https://claude.com/plugins>; verify `/plugin marketplace add microsoft/aspire-skills`. |
| 3 | Codex CLI | No extra step — `marketplace.json` is shared. Verify `codex plugin marketplace add`. |
| 4 | JetBrains | Document `npx skills add` install command in README. |
| 5 | APM | List on `microsoft/apm` or `github/awesome-copilot` marketplace. |
| 6 | Cursor Marketplace | Microsoft ↔ Anysphere business contact for listing. |
| 7 | Anthropic Partner Skills | PR to `anthropics/skills` or partnership channel. |

### Phase 3 — MCP expansion (1–2 sprints later)

8. Build `@microsoft/aspire-mcp` npm package wrapping Aspire CLI as MCP tools.
9. `mcp-publisher publish` to official MCP Registry.
10. Submit to Glama (free, auto-indexed).
11. Microsoft partner request for `github.com/mcp` listing.

### Phase 4 — Enterprise / IDE (ongoing)

12. Foundry prompt agent template via Entra Agent Registry.
13. (Optional) VS Code extension wrapper under `ms-azuretools` or `ms-dotnet` publisher.

---

## CI / CD patterns to borrow from `microsoft/GitHub-Copilot-for-Azure`

The Azure team's monorepo + sync architecture is directly applicable:

```
microsoft/aspire (private build)              microsoft/aspire-skills (public)
        │                                              ▲
        │  publish-to-marketplace.yml                  │
        │  (cron + workflow_dispatch)                  │
        │  npm run build → rsync → PR ─────────────────┘
        │
        └──▶  microsoft/skills (Anthropic claude-plugins-official registry)
```

Concrete workflows worth copying (sources cited):

| Workflow | Purpose | Source |
|---|---|---|
| `publish-to-marketplace.yml` | Cron + `workflow_dispatch` rsync from build to public skills repo, opens PR | [`GitHub-Copilot-for-Azure/.github/workflows/publish-to-marketplace.yml`](https://github.com/microsoft/GitHub-Copilot-for-Azure/blob/main/.github/workflows/publish-to-marketplace.yml) |
| `pr.yml` | Token analysis (`tokens check` / `compare`), frontmatter validation, plugin version check | [`pr.yml`](https://github.com/microsoft/GitHub-Copilot-for-Azure/blob/main/.github/workflows/pr.yml) |
| `eval.yml` | Runs `vally eval --suite ci-gate` on PR | [`eval.yml`](https://github.com/microsoft/GitHub-Copilot-for-Azure/blob/main/.github/workflows/eval.yml) |
| `skill-factory.yml` | `workflow_dispatch` opens an issue assigned to `@copilot` to scaffold new skills | [`skill-factory.yml`](https://github.com/microsoft/GitHub-Copilot-for-Azure/blob/main/.github/workflows/skill-factory.yml) |
| `pr-plugin-version-check.yml` | Enforces `version` is a placeholder on PRs (NBGV stamps real version at build) | [`pr-plugin-version-check.yml`](https://github.com/microsoft/GitHub-Copilot-for-Azure/blob/main/.github/workflows/pr-plugin-version-check.yml) |

**Versioning:** Azure team uses [Nerdbank.GitVersioning](https://github.com/dotnet/Nerdbank.GitVersioning) — `version.json` in repo, `nbgv` stamps the build. Simpler alternative for our scope: `git describe --tags` in a release workflow.

---

## Client Support Matrix (template)

Add this table to the top-level `README.md` to mirror the Azure pattern:

```markdown
| Client | Skills | MCP | Hooks | Marketplace | Manifest |
|--------|:------:|:---:|:-----:|:-----------:|----------|
| Copilot CLI | ✅ | ✅ | ✅ | `.plugin/` | `.plugin/plugin.json` |
| Claude Code | ✅ | ✅ | ✅ | `.claude-plugin/marketplace.json` | `.claude-plugin/plugin.json` |
| Codex CLI | ✅ | ✅ | ❌ | `.claude-plugin/marketplace.json` (Claude-style) | `.claude-plugin/plugin.json` |
| Cursor | ✅ | ✅ | WIP | `.cursor-plugin/marketplace.json` | `.cursor-plugin/plugin.json` |
| Gemini CLI | ✅ | ✅ | ❌ | none — git URL | `gemini-extension.json` |
| JetBrains | ✅ | ⚠️ | ❌ | `npx skills add` | `skills/` directory |
| APM | ✅ | ✅ | ✅ | `microsoft/apm` | `apm.yml` |
```

---

## Open questions

1. **Public-repo timeline** — when does Microsoft IP/legal sign off?
2. **Telemetry stance** — keep current hooks, make opt-out, or strip pre-publication?
3. **MCP server build** — does the team have appetite for a separate `@microsoft/aspire-mcp` package? Without it, MCP registries are unreachable.
4. **VS Code extension wrapper** — out of scope for skills, but worth discussing if the .NET team wants Aspire surfaces directly in the VS Code Copilot Chat panel.

---

## Sources

All citations from live fetches on 2026-05-08:

- <https://docs.anthropic.com/en/docs/agents-and-tools/agent-skills>
- <https://code.claude.com/docs/en/plugins> · <https://code.claude.com/docs/en/plugin-marketplaces> · <https://code.claude.com/docs/en/plugins-reference>
- <https://claude.com/plugins>
- <https://github.com/anthropics/skills>
- <https://cursor.com/docs/skills> · <https://cursor.com/marketplace>
- <https://developers.openai.com/codex/plugins/build>
- <https://google-gemini.github.io/gemini-cli/docs/extensions/> · <https://google-gemini.github.io/gemini-cli/docs/extensions/extension-releasing.html>
- <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers> · <https://github.com/mcp>
- <https://github.com/modelcontextprotocol/registry> · <https://glama.ai> · <https://smithery.ai>
- <https://github.com/microsoft/apm>
- <https://github.com/microsoft/GitHub-Copilot-for-Azure> · <https://github.com/microsoft/azure-skills>
- <https://learn.microsoft.com/en-us/azure/ai-foundry/agents/overview>
