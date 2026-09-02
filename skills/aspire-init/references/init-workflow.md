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

`aspire.config.json` is the authoritative metadata for the authoring target. Resolve its
`appHost.path` relative to the configuration file; do not assume it is at the repository
root. `apphost.run.json` can coexist as legacy or single-file launch-profile metadata.
Recognize it during discovery, but do not use it as the file to author or as a replacement
for `appHost.path`.

### `aspireify` Skill

- A Markdown skill file is installed into the AI agent's skill directory — the same
  directory chosen by `aspire agent init` (e.g., `.agents/skills/aspireify/`,
  `.github/skills/aspireify/`, `.claude/skills/aspireify/`, or `.opencode/skill/aspireify/`).
- The skill instructs the agent to scan the repo, propose a resource graph, edit the
  AppHost, and validate via `aspire start`.

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
4. **Confirm `aspireify` skill installed** — the agent's skill directory contains
   `aspireify/SKILL.md`. If missing, run `aspire agent init` to install it.
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

`aspire init` installs `aspireify` into the project's skill directory when an agent skill location is detected.
When a project-local `.agents/skills/aspireify/SKILL.md` (or equivalent location) is
present, **defer to it and warn the user** — the project-local copy may carry repo-specific
guidance.

The same precedence applies to a legacy `.agents/skills/aspire-init/SKILL.md` from older
`aspire init` runs: warn and defer.

## Failure Modes and Recovery

| Symptom | Cause | Recovery |
|---------|-------|----------|
| `aspire init` reports an AppHost already exists | Repo is already an Aspire app | Stop. Route to `aspireify` or `aspire-orchestration` |
| `aspire init` fails without `--language` in `--non-interactive` | CLI needs the language explicitly when prompts are disabled | Re-run with `--language csharp` or `--language typescript` |
| Skeleton dropped but no `aspireify` skill | Agent skill directory not detected during init | Run `aspire agent init` to install `aspireify`, then continue |
| `apphost.cs` references a missing `#:package` | Channel mismatch or transient feed issue | Re-run with `--channel stable` (or `daily` for pre-release) |
| `aspire start` after wiring fails immediately | Wiring incomplete or wrong AppHost path | Re-invoke `aspireify`; confirm `aspire.config.json` `appHost.path` is correct |
| Existing TypeScript AppHost uses `apphost.ts` | Legacy entry point and package graph | Hand off to `aspire-orchestration`, which owns approval and `aspire update --migrate --yes --non-interactive`; return to aspireify only for later source authoring |

### pnpm build-policy recovery after partial TypeScript init

Before `aspire init --language typescript`, inspect the applicable
`pnpm-workspace.yaml` files for build-script policy. In pnpm 11+, an
`allowBuilds` entry such as `esbuild: false` denies the binary's build script. In older
pnpm versions, an `onlyBuiltDependencies` allow-list that omits `esbuild` has the same
effect.

If `aspire init` exits nonzero but has already created `aspire.config.json`, the configured
AppHost entry point, and its package manifest, treat this as **partial initialization**:

1. Read `aspire.config.json` first and confirm that its resolved `appHost.path` exists.
   Do not rerun `aspire init`, delete the generated files, or create a second AppHost.
2. Preserve the root `pnpm-workspace.yaml` exactly. Its build policy is a repository
   security boundary, not an Aspire setting to relax.
3. If the generated AppHost is the nested brownfield `aspire-apphost/` package, add a
   scoped `aspire-apphost/pnpm-workspace.yaml` after confirming the selected pnpm version:

   ```yaml
   # pnpm 11+
   packages:
     - "."
   allowBuilds:
     esbuild: true
   ```

   For a pnpm version that still uses the older allow-list, scope the equivalent to the
   nested AppHost only:

   ```yaml
   onlyBuiltDependencies:
     - esbuild
   ```

   Include `packages: ["."]` in either nested workspace form so it is an
   independent workspace containing the generated AppHost.

   Do not add unrelated build approvals. This nested workspace policy permits only the
   AppHost toolchain to build `esbuild`; it does not change application-package policy.
4. From that nested AppHost directory, repair its dependencies with
   `pnpm --config.workspaceDir="$PWD" install`, then use `aspire restore` if generated
   modules are absent. `--ignore-workspace` is not safe here: it ignores the nested
   `pnpm-workspace.yaml`, so pnpm still suppresses the `esbuild` postinstall. On
   PowerShell, use `pnpm --config.workspaceDir="$PWD" install`; on shells where `$PWD`
   is not the string path, substitute the nested AppHost's absolute path. Resume normal
   execution with `aspire start --non-interactive`.
5. Confirm the project-local `aspireify` skill exists. If the failed init did not install
   it, run `aspire agent init --skills aspireify`, then hand the recovered, still-unwired
   AppHost to `aspireify`. Do not perform resource wiring in the init workflow.

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
