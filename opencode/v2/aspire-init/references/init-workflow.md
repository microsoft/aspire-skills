# `aspire init` Workflow

Reference for the `aspire init` flow on existing repositories. Source:
https://aspire.dev/reference/cli/commands/aspire-init/.

## What `aspire init` Does

`aspire init` initializes Aspire support in an existing repo or workspace. It scaffolds a
**minimal AppHost skeleton** plus an `aspire.config.json`, then optionally installs the
**`aspireify`** agent skill so the AI coding agent can complete the wiring.

It does **not**:

- Wire resources, projects, or integrations into the AppHost
- Modify existing project files
- Change the repo's .NET SDK version (`global.json` is left alone)
- Trust the developer certificate (run `aspire certs trust` separately if needed)

## Command and Options

```bash
aspire init [options]
```

| Option | Purpose |
|--------|---------|
| `--language` | `csharp` or `typescript`. Required in `--non-interactive` mode if both paths are available |
| `--channel` | `stable` (default), `staging`, `daily` |
| `--skill-locations` | Comma-separated agent skill locations, `all`, or `none` |
| `--skills` | Comma-separated skills, `all`, or `none` |
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

### `aspireify` Skill

- **Aspire 13.6:** The chained setup installs selected bundled skills, including
  `aspireify`, into a detected agent skill directory.
- **Aspire 17.0 and later:** The chained setup registers the selected Aspire skill source
  in agent settings. The agent client fetches the plugin content; Aspire does not copy an
  `aspireify/SKILL.md` into the project. Verify the source registration and agent-client
  availability instead of requiring a local file.
- In both versions, `aspireify` guides the agent to scan the repo, propose a resource graph,
  edit the AppHost, and validate via `aspire start`.
- Chained setup does not configure Aspire MCP. Missing MCP config after a successful init
  is expected. Configure MCP only when the user explicitly asks, through standalone
  `aspire agent init --mcp` on Aspire 13.6 or later.

## `aspire.config.json` Layout

| Field | Values | Meaning |
|-------|--------|---------|
| `appHost.language` | `"csharp"` or `"typescript/nodejs"` | Which AppHost syntax to use |
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
   aspire init --language <csharp|typescript> --non-interactive
   ```
3. **Confirm artifacts** — verify root `aspire.config.json`, resolve its
   `appHost.path` relative to that file, and confirm the selected `apphost.cs`, AppHost
   project, or TypeScript `apphost.mts` exists there. For TypeScript, also confirm the
   adjacent generated `.aspire/modules/`; do not assume the AppHost is at the repo root.
4. **Confirm Aspire agent guidance is available**:
   - On Aspire 17.0 or later, confirm the selected agent has the Aspire source registered
     and can load its plugin. A project-local `aspireify/SKILL.md` is not expected. If setup
     omitted the Aspire skill, rerun `aspire agent init --non-interactive --skills aspire`
     with the intended agent and scope.
   - On Aspire 13.6, confirm the selected agent's skill directory contains the bundled
     `aspireify/SKILL.md`. If it is missing, run `aspire agent init` interactively and select
     the Aspire skill and a detected location.
5. **Hand off to `aspireify`** for wiring:
   - Scan repo and discover existing projects, services, containers
   - Ask the user clarifying questions (which services to orchestrate, hardcoded ports,
     whether to map env vars or switch to Aspire service discovery)
   - Wire resources with `WithReference`, `WaitFor`, endpoints, volumes
   - Optionally configure OpenTelemetry
   - For a TypeScript AppHost toolchain problem, detect and preserve the repository's
     existing package-manager convention before recommending a dependency command
   - Validate with a smoke-test `aspire start`
6. **Validate** — once `aspireify` finishes wiring, run `aspire start` (handled by
   `aspire-orchestration`) and confirm resources reach a healthy state.

## Project-Local Skill Precedence

Aspire 13.6 installs the selected bundled `aspireify` skill into a detected agent skill
directory. Aspire 17.0 and later register a remote source instead, so a local
`.agents/skills/aspireify/SKILL.md` is not expected. An older local Aspire skill copy may
still take precedence over the remote plugin. **Defer to that copy and warn the user** if it
exists. If the Aspire 17.0 CLI supports `--remove-skill-copies`, it can remove replaced
copies only after the user opts in.

The same precedence applies to a legacy `.agents/skills/aspire-init/SKILL.md` from older
`aspire init` runs: warn and defer.

## Failure Modes and Recovery

| Symptom | Cause | Recovery |
|---------|-------|----------|
| `aspire init` reports an AppHost already exists | Repo is already an Aspire app | Stop. Route to `aspireify` or `aspire-orchestration` |
| `aspire init` fails without `--language` in `--non-interactive` | CLI needs the language explicitly when prompts are disabled | Re-run with `--language csharp` or `--language typescript` |
| Aspire 17.0+ setup succeeds but the agent cannot use `aspireify` | The selected agent has not loaded the registered source, or another source/configuration overrides it | Check the selected agent's source registration and configured `skillSources`; reload the agent client. Do not require a local skill file or pass `--skills aspireify` |
| Aspire 13.5 setup leaves out the local `aspireify` skill | The skill was not selected, or no agent skill location was detected | Run `aspire agent init` interactively and select the bundled Aspire skill and a detected location |
| No MCP config after a successful init | Expected in 13.6+ — chained agent setup does not offer MCP | Leave as-is unless the user explicitly asks for MCP; then use `aspire agent init --mcp` (13.6+) |
| `apphost.cs` references a missing `#:package` | Channel mismatch or transient feed issue | Re-run with `--channel stable` (or `daily` for pre-release) |
| `aspire start` after wiring fails immediately | Wiring incomplete or wrong AppHost path | Re-invoke `aspireify`; confirm `aspire.config.json` `appHost.path` is correct |
| Existing TypeScript AppHost uses `apphost.ts` | Legacy entry point and package graph | Hand off to `aspire-orchestration`, which owns approval and `aspire update --migrate --yes --non-interactive`; return to aspireify only for later source authoring |

## Don't Do This

- **Don't run `aspire init` if any AppHost signal already exists** — it duplicates the
  skeleton and confuses subsequent tooling.
- **Don't edit `.aspire/modules/`** in TypeScript AppHosts. Use `aspire add` to regenerate APIs;
  use `aspire restore` if files are missing.
- **Don't install the obsolete Aspire workload** (`dotnet workload install aspire`). Use
  `aspire init`, `aspire new`, or `aspire add` instead.
- **Don't perform the resource wiring inside this skill.** Hand off to `aspireify`. This
  skill's job ends when the skeleton + `aspire.config.json` + `aspireify` skill are in
  place.
