# App Commands

Use this when the task is about app-level lifecycle, bootstrap, or AppHost-wide maintenance.

## Start The App Safely In The Background

```bash
aspire start
aspire start --isolated
aspire stop
```

- Use `aspire start` for normal background AppHost execution.
- In git worktrees or when another local instance may already be running, use `aspire start --isolated`.
- To restart after AppHost changes, rerun the same start command.
- Use `aspire stop` only when the ask is explicitly to stop the app.
- Avoid `aspire run` in agent workflows — it blocks the terminal.

### `aspire run` vs `aspire start`

| Command | Mode | Use Case |
|---------|------|----------|
| `aspire run` | Foreground (interactive) | Human developer at terminal |
| `aspire start` | Background (detached) | **AI agents — always prefer** |
| `aspire run --detach` | Background | Alternative to `aspire start` |

## Create A New Aspire App Or Add Aspire To An Existing App

```bash
aspire new
aspire init
aspire init --language typescript
```

- Use `aspire new` when creating a brand-new Aspire app from scratch.
- Use `aspire init` when adding Aspire to an existing application.

## Find The Right AppHost Or Refresh AppHost-Wide Support

```bash
aspire ps
aspire add <package>
aspire update
aspire restore
```

- Use `aspire ps` first to discover which AppHost is already running.
- Use `aspire add <package>` to add integrations and regenerate AppHost APIs.
- Use `aspire update` to refresh AppHost package references.
- Use `aspire restore` after pulls, cleans, or missing generated files.
- Use `--apphost <path>` when the workspace has multiple AppHosts.

## Key Rules

- **Never install the obsolete Aspire workload** (`dotnet workload install aspire`). Use `aspire add`, `aspire init`, or `aspire new` instead.
- **Never edit `.modules/` directly** in TypeScript AppHosts. Use `aspire add <package>` to regenerate APIs, `aspire restore` if files are missing.
- For unfamiliar C# AppHost APIs, use `aspire docs search` as primary reference. If the `dotnet-inspect` skill is available, use it to inspect local symbols and overloads — but keep docs as the source of truth.
- For custom dashboard or resource commands (`WithCommand`), always run `aspire docs search "custom resource commands"` before implementing.
