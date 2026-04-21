# Plan: IDE vs CLI Context-Aware Skill Routing

## Problem

The aspire-skills plugin runs across 4 different host environments:

| Host | Type | Capabilities |
|------|------|-------------|
| VS Code (Copilot Chat) | IDE | File editing, terminal, workspace context, diagnostics panel |
| Cursor | IDE | Same as VS Code (no unique marker) |
| Copilot CLI | Terminal | Shell commands only, no editor access |
| Claude Code | Terminal | Shell commands, file editing via tools |

The same SKILL.md content is loaded in all hosts, but the **optimal agent behavior differs**:

| Scenario | IDE (VS Code/Cursor) | CLI (Copilot CLI, Claude Code) |
|----------|---------------------|-------------------------------|
| View logs | Open Aspire Dashboard in browser, or use Output panel | `aspire logs <resource>` in terminal |
| Edit AppHost | Open file in editor, suggest code changes inline | `aspire docs api search` then describe changes |
| Start app | Can use Run/Debug config OR `aspire start` | `aspire start` only |
| View traces | Link to Dashboard URL | `aspire otel traces` in terminal |
| Deploy | Integrated terminal + progress in Output panel | `aspire deploy --non-interactive` |
| Show endpoints | Can open in browser via link | `aspire describe --format Json` |

## Detection Methods (from azure-skills research)

Skills **cannot directly read environment variables**. Detection works through **hook JSON structure**:

### Primary: Hook Field Naming

| Signal | Client |
|--------|--------|
| `"toolArgs"` (camelCase) | Copilot CLI |
| `"hook_event_name"` + `"__vscode"` in `tool_use_id` | VS Code |
| `"hook_event_name"` + no `"__vscode"` | Claude Code |
| Cursor | Treated as VS Code (no unique marker) |

### Secondary: Installation Path

| Path Pattern | Client |
|-------------|--------|
| `~/.vscode/agent-plugins/...` | VS Code |
| `~/.vscode-insiders/agent-plugins/...` | VS Code Insiders |
| `~/.claude/plugins/...` | Claude Code |
| `~/.copilot/installed-plugins/...` | Copilot CLI |

### Current State

azure-skills uses this detection for **telemetry only** — not behavioral changes.
No existing plugin uses IDE detection to change skill routing.

## Proposed Approach

### Option A: Conditional Guidance in SKILL.md (Recommended)

Add an "Environment-Aware Guidance" section to each SKILL.md that the LLM can use
to adapt its behavior based on what it observes about its environment:

```markdown
## Environment-Aware Guidance

Detect your environment and adapt:

| Signal | You're In | Prefer |
|--------|-----------|--------|
| Can open files in editor | IDE (VS Code/Cursor) | Inline code suggestions, open Dashboard URL |
| Terminal-only, no editor | CLI | `aspire` CLI commands, `--format Json` output |

### IDE Path (VS Code / Cursor)
- Open Aspire Dashboard URL in browser for visual monitoring
- Use editor to modify AppHost code directly
- Suggest Run/Debug configurations for `aspire start`
- Link to Dashboard for traces/logs instead of CLI commands

### CLI Path (Copilot CLI / Claude Code)
- Always use `aspire start` (never suggest Run configurations)
- Always append `--non-interactive` to commands
- Use `--format Json` for all output parsing
- Use `aspire logs` and `aspire otel` for diagnostics (no Dashboard links)
```

**Pros**: No infrastructure changes, works today, LLM can self-detect
**Cons**: Relies on LLM correctly inferring its environment

### Option B: Hook-Based Detection with Environment File

Use the PostToolUse hook to detect client and write a `.aspire-skills-env` file:

```bash
# In track-telemetry.sh, detect client and write env hint
echo "HOST_TYPE=$clientName" > "${PLUGIN_ROOT}/.aspire-skills-env"
```

Skills can then reference this file. But SKILL.md files are static markdown —
they can't read files. This only helps if the LLM is told to check the file.

**Pros**: Reliable detection
**Cons**: Requires LLM to read the file, race condition on first load

### Option C: Separate SKILL.md per Host (Not Recommended)

Create host-specific skill variants:
```
skills/aspire-orchestration/
├── SKILL.md              # Shared core
├── SKILL.vscode.md       # VS Code additions
└── SKILL.cli.md          # CLI additions
```

**Pros**: Clean separation
**Cons**: No host supports this pattern today, duplication

## Recommendation

**Go with Option A** — add environment-aware guidance sections to SKILL.md files.
The LLM already knows whether it can open files, use an editor, or is terminal-only.
We just need to give it the decision table for what to do in each context.

## Implementation

### Files to Update

1. **skills/aspire/SKILL.md** (router) — Add environment detection guidance
2. **skills/aspire-orchestration/SKILL.md** — IDE: suggest Dashboard + editor; CLI: `aspire start`
3. **skills/aspire-monitoring/SKILL.md** — IDE: open Dashboard URL; CLI: `aspire otel` commands
4. **skills/aspire-deployment/SKILL.md** — IDE: integrated terminal; CLI: `--non-interactive`
5. **evals** — Add tasks testing IDE vs CLI routing

### Key Behavioral Differences to Encode

| Area | IDE Guidance | CLI Guidance |
|------|-------------|-------------|
| **Monitoring** | "Open Dashboard at the URL from `aspire describe`" | "Use `aspire otel logs\|traces`" |
| **Starting** | "Can use VS Code Run config or `aspire start`" | "Always `aspire start --non-interactive`" |
| **Editing AppHost** | "Open file in editor, suggest inline changes" | "Use `aspire docs api search` first, describe changes" |
| **Viewing endpoints** | "Open URL in browser" | "`aspire describe --format Json`" |
| **Errors** | "Check Problems panel + `aspire describe`" | "`aspire describe --format Json`" |
| **Deploy** | "Use integrated terminal, watch Output panel" | "`aspire deploy --non-interactive`" |
