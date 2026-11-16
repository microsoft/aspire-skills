# `aspire init` Workflow

Reference for the `aspire init` flow on existing repositories. Source:
https://aspire.dev/reference/cli/commands/aspire-init/.

## What `aspire init` Does

`aspire init` initializes Aspire support in an existing repo or workspace. It scaffolds a
**minimal AppHost skeleton** and an `aspire.config.json`, then optionally configures agent
guidance. In Aspire 17.0 and later, setup can configure Copilot, Claude Code, or OpenCode
to load Aspire skills from a remote plugin or catalog. The default Aspire source includes
`aspireify` and other skills. Setup can also install `playwright-cli` and the
`dotnet-inspect` skill when selected. Earlier versions with agent setup copy selected
bundled skills instead.

It does **not**:

- Wire resources, projects, or integrations into the AppHost
- Change the repo's .NET SDK version (`global.json` is left alone)

Older CLIs may add project references to the AppHost in a solution or check the developer
certificate. Check `aspire init --help` for the installed version's behavior.

## Command and Options

```bash
aspire init [options]
```

| Option | Purpose |
|--------|---------|
| `--language` | `csharp`, `typescript`, or `go` (Aspire 17.0 or later). Required in `--non-interactive` mode if more than one path is available |
| `--channel` | `stable` (default), `staging`, `daily` |
| `--skills` | Comma-separated skills, `all`, or `none` |
| `--skill-locations` | Aspire 13.6 and earlier. Comma-separated agent skill locations, `all`, or `none` |
| `--agents` | Aspire 17.0 and later. Comma-separated agent clients to configure |
| `--scope` | Aspire 17.0 and later. `project` (default) or `global` |
| `--non-interactive` | **Required for agent execution.** Disables prompts and spinners |
| `--nologo` | Suppress startup banner / telemetry notice |
| `--banner` | Show the animated welcome banner |
| `-l, --log-level` | `Critical`, `Debug`, `Error`, `Information`, `None`, `Trace`, `Warning` |
| `--wait-for-debugger` | Pause until a debugger attaches |
| `-?, -h, --help` | Print help |

`--source` and `--version` are deprecated compatibility options and no longer affect
`aspire init`. Do not generate them in new commands.

## What Gets Dropped

### C# Path (`--language csharp`)

- **`apphost.cs`** — single-file AppHost using `#:sdk Aspire.AppHost.Sdk` and `#:package`
  directives. No `.csproj` is created in the file-based mode.
- The generated AppHost opts into the 13.5 CLI bundle with
  `#:property AspireUseCliBundle=true`.
- **`aspire.config.json`** at repo root.

When a `.sln` or `.slnx` exists, `aspire init` can create a project-based AppHost and add it
to the solution instead of creating a single-file AppHost.

### TypeScript Path (`--language typescript`)

- **`apphost.mts`** at repo root, or under `aspire-apphost/` when the repo already has a
 root `package.json`.
- **`.aspire/modules/`** generated folder (do not edit by hand — regenerate with `aspire add`).
- **`aspire.config.json`** at repo root.

### Go Path (`--language go`, Aspire 17.0 or later)

- **`apphost.go`** and **`go.mod`** in the current directory. The `go.mod` has a `replace` that
  points the generated `apphost/modules/aspire` module at `./.aspire/modules`.
- **`.aspire/modules/`** generated Go SDK (do not edit by hand; regenerate with `aspire add`
  or `aspire restore`). The scaffolded `.gitignore` ignores `.aspire/`.
- **`aspire.config.json`** next to `apphost.go`, with `appHost.language` set to `go`.
- Its `packages` includes `Aspire.Hosting.Go` at the selected SDK version. The empty
  template uses the same scaffold; the starter additionally includes Redis. This relies
  on the stable Go hosting package shipping with 17.0, not a nonexistent stable 13.x package.

`aspire init` has no output option, so it writes into the current directory and stops because
it would overwrite existing files when a `go.mod` is already there. In a repo that already has a
root `go.mod` (for example a Go service), run it from a new subdirectory such as `apphost/`.
The existing `go.mod` stays untouched and `aspire.config.json` lands next to `apphost.go`
instead of at the repo root.

### `aspireify` Skill

- **Aspire 13.6 and earlier:** Setup options vary by version. Some versions skip chained
  agent setup in non-interactive mode, so run `aspire agent init` interactively. If the
  CLI has no `aspire agent init` or does not offer `aspireify`, continue with the
  `aspireify` skill from aspire-skills. Aspire 13.6 copies selected bundled skills into a
  chosen skill directory: `.agents/skills` by default, or `.claude/skills`,
  `.github/skills`, or `.opencode/skill`. The default `.agents/skills` location writes
  copies both in the project and under `~/.agents/skills`.
- **Aspire 17.0 and later:** When Aspire skills are selected, the chained setup registers
  configured remote sources in the selected clients' settings. The default Aspire source
  includes `aspireify` and other skills. The client, not Aspire, fetches the content.
  Aspire does not copy an `aspireify/SKILL.md` into the project.

  For the default Aspire source:

  | Client | What Aspire writes (project scope) | How to check the registration |
  |--------|------------------------------------|-------------------------------|
  | GitHub Copilot CLI | `.github/copilot/settings.json`: the `aspire-skills` marketplace and the enabled `aspire@aspire-skills` plugin | `copilot plugin list` shows `aspire@aspire-skills` |
  | Claude Code | `.claude/settings.json`: the same marketplace and plugin entries | `claude plugin list` shows `aspire@aspire-skills` |
  | OpenCode | `opencode.json` or `opencode.jsonc`, at the project root or under `.opencode/`: an Aspire skill catalog URL in `skills` | The settings file contains the catalog URL |

  Global scope writes the same entries to the client's user settings. A registered
  plugin or catalog is not proof that a running session loaded it. Each client picks
  up the changed settings as follows:

  - **GitHub Copilot CLI:** Run `/restart` or start a new session in the project.
    Copilot installs and enables the plugins listed in `enabledPlugins`. A plugin
    enabled only in repository settings is active only in that repository. Update with
    `copilot plugin update aspire@aspire-skills`.
  - **Claude Code:** Start a session in the project and accept the workspace trust
    prompt. Claude Code then clones the marketplace in the background. With global
    scope, it also downloads the plugin and prompts you to run `/reload-plugins`. With
    project scope, it does not install the plugin, so run `/reload-plugins` in each
    session to load it. Update with `claude plugin update aspire@aspire-skills`, then
    run `/reload-plugins`.
  - **OpenCode:** Restart OpenCode so it reads the changed config. It downloads the
    catalog and refreshes its cache when the catalog version changes. If skills are
    missing, check the catalog URL and the `skill` permissions.

  Then confirm `aspireify` appears in the agent's available skills.
- `aspireify` guides the agent to scan the repo, propose a resource graph,
  edit the AppHost, and validate via `aspire start`.
- In Aspire 13.6 and later, chained setup does not offer Aspire MCP, so missing MCP config
  after a successful init is expected. Configure MCP only when the user explicitly asks,
  through standalone `aspire agent init --mcp`. In Aspire 13.5, MCP is an interactive opt-in.

## `aspire.config.json` Layout

| Field | Values | Meaning |
|-------|--------|---------|
| `appHost.language` | `"csharp"`, `"typescript/nodejs"`, or `"go"` | Which AppHost syntax to use |
| `appHost.path` | Path to AppHost file or directory | Where the AppHost lives |

C# has two sub-modes the agent may encounter:

- **Single-file** — `appHost.path` points at `apphost.cs` (uses `#:sdk` directive).
- **Full project** — `appHost.path` points at a directory containing a `.csproj` plus
  `Program.cs`. In solution-backed repos, full project mode lets the AppHost participate in IDE and solution workflows.

## End-to-End Sequence

1. **Pre-flight** — verify no AppHost already exists. If one does, stop and route to
   `aspireify` or `aspire-orchestration`.
2. **Run init**:
   ```bash
   aspire init --language <csharp|typescript|go> --non-interactive
   ```
3. **Confirm artifacts** — verify `aspire.config.json` (at the repo root, or next to
   `apphost.go` when a Go init ran in a subdirectory), resolve its `appHost.path` relative to
   that file, and confirm the selected `apphost.cs`, AppHost project, TypeScript `apphost.mts`,
   or Go `apphost.go` (next to its `go.mod`) exists there. For TypeScript and Go, also confirm
   the adjacent generated `.aspire/modules/`; do not assume the AppHost is at the repo root.
4. **Confirm Aspire agent guidance is available**:
   - On Aspire 17.0 or later, check the client registration described in
     [`aspireify` Skill](#aspireify-skill). A project-local `aspireify/SKILL.md` is not
     expected. If setup omitted the Aspire entries, rerun
     `aspire agent init --non-interactive --skills aspire --agents <client> --scope <project|global>`.
   - On Aspire 13.6 or earlier, confirm the chosen skill directory contains
     `aspireify/SKILL.md`. If it is missing, run `aspire agent init` interactively, if the
     CLI has it, and select the `aspireify` skill and a location. Otherwise, continue with
     the `aspireify` skill from aspire-skills.
5. **Hand off to `aspireify`** for wiring:
   - Scan repo and discover existing projects, services, containers
   - Ask the user clarifying questions (which services to orchestrate, hardcoded ports,
     whether to map env vars or switch to Aspire service discovery)
   - Wire resources with `WithReference`, `WaitFor`, endpoints, volumes
   - Optionally configure OpenTelemetry
   - For a TypeScript AppHost toolchain problem, detect and preserve the repository's
     existing package-manager convention before recommending a dependency command
   - For a Go AppHost toolchain problem, check that `go version` runs and the toolchain
     satisfies the `go` directive in `go.mod` (the scaffold declares `go 1.26`)
   - Validate with a smoke-test `aspire start`
6. **Validate** — once `aspireify` finishes wiring, run `aspire start` (handled by
   `aspire-orchestration`) and confirm resources reach a healthy state.

## Project-Local Skill Precedence

Aspire 13.6 and earlier could copy selected bundled skills, including `aspireify`, into
project and user skill directories. On those versions, when a project-local
`.agents/skills/aspireify/SKILL.md` (or equivalent location) is present, **defer to it and
warn the user**. The project-local copy may carry repo-specific guidance. The same
precedence applies to a legacy `.agents/skills/aspire-init/SKILL.md` from older
`aspire init` runs.

Aspire 17.0 and later register a remote source instead, so a local `aspireify/SKILL.md` is
not expected. A copy left by an older CLI is stale unless the user maintains it. A stale
copy may take precedence over the plugin. Use the plugin's skills instead and tell the user
the copy is stale. `aspire doctor` lists each copy and explains how to remove it.

## Failure Modes and Recovery

| Symptom | Cause | Recovery |
|---------|-------|----------|
| `aspire init` reports an AppHost already exists | Repo is already an Aspire app | Stop. Route to `aspireify` or `aspire-orchestration` |
| `aspire init` fails without `--language` in `--non-interactive` | CLI needs the language explicitly when prompts are disabled | Re-run with `--language csharp`, `--language typescript`, or `--language go` (Aspire 17.0 or later) |
| `aspire init --language go` stops because it would overwrite existing files | The directory already has a `go.mod`, for example a Go service at the repo root | Run it from a new subdirectory such as `apphost/`; leave the existing `go.mod` alone |
| Aspire 17.0+ setup succeeds but the agent cannot use `aspireify` | The client has not loaded the registered plugin or catalog, or Aspire `skillSources` settings point to another source | Reload the client as described in [`aspireify` Skill](#aspireify-skill). Check project and global Aspire `skillSources` for overrides. Do not require a local skill file or pass `--skills aspireify` |
| Aspire 13.6 or earlier setup leaves out the local `aspireify` skill | The skill was not selected, or no skill location was chosen | If the CLI has `aspire agent init` and offers `aspireify`, run it interactively and select the skill and a location. Otherwise, continue with the `aspireify` skill from aspire-skills |
| No MCP config after a successful init | Expected in 13.6+ — chained agent setup does not offer MCP | Leave as-is unless the user explicitly asks for MCP; then use `aspire agent init --mcp` (13.6+) |
| `apphost.cs` references a missing `#:package` | Channel mismatch or transient feed issue | Re-run with `--channel stable` (or `daily` for pre-release) |
| `aspire start` after wiring fails immediately | Wiring incomplete or wrong AppHost path | Re-invoke `aspireify`; confirm `aspire.config.json` `appHost.path` is correct |
| Existing TypeScript AppHost uses `apphost.ts` | Legacy entry point and package graph | Hand off to `aspire-orchestration`, which owns approval and `aspire update --migrate --yes --non-interactive`; return to aspireify only for later source authoring |

## Don't Do This

- **Don't run `aspire init` if any AppHost signal already exists** — it duplicates the
  skeleton and confuses subsequent tooling.
- **Don't edit `.aspire/modules/`** in TypeScript and Go AppHosts (the generated Go SDK lives
  there). Use `aspire add` to regenerate APIs; use `aspire restore` if files are missing.
- **Don't pick `--language go` because the repo contains Go services.** The AppHost language is
  the one the user wants to write the AppHost in; a Go service in a C# or TypeScript repo does
  not call for a Go AppHost.
- **Don't install the obsolete Aspire workload** (`dotnet workload install aspire`). Use
  `aspire init`, `aspire new`, or `aspire add` instead.
- **Don't perform the resource wiring inside this skill.** Hand off to `aspireify`. This
  skill's job ends when the skeleton + `aspire.config.json` + `aspireify` skill are in
  place.
