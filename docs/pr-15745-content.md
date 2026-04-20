Agent is idle (waiting for messages). agent_id: read-pr-refs, agent_type: explore, status: idle, description: Read PR #15745 reference files, elapsed: 79s, total_turns: 1

[Turn 0]
Perfect! Here are all the reference files from PR #15745 (branch: dapine/skill-evals) in the microsoft/aspire repository:

---

## File 1: `.agents/skills/aspire/SKILL.md`

```markdown
---
name: aspire
description: "Use this skill when the user is working with an Aspire distributed application and needs to operate the AppHost or its resources through the Aspire CLI: start, restart, stop, or wait on the app; inspect resources, logs, traces, docs, or health; add integrations; manage secrets or config; publish, deploy, or rerun a named pipeline step; initialize Aspire in an existing app; recover missing `.modules` files in a TypeScript AppHost; discover the right frontend URL for Playwright from Aspire state; expose custom dashboard/resource commands; or understand unfamiliar Aspire AppHost APIs in C# or TypeScript. Use it even if they describe the task in terms of an AppHost, resources, dashboard, existing app bootstrap, missing generated modules, Playwright URL discovery, C# API understanding, or local distributed app workflow without explicitly naming Aspire. Do not use it for non-Aspire .NET apps, container-only repos with no AppHost, or ordinary build and test tasks."
---

# Aspire Skill

Use this skill when the task is about operating an Aspire distributed application through the Aspire CLI rather than falling back to ad-hoc `dotnet`, `docker`, or shell workflows.

Resources are typically defined in an AppHost such as, `AppHost.cs`, `apphost.ts`, or `AppHost/AppHost.csproj (Program.cs)`.

## Use this skill for

- Starting, restarting, and stopping AppHosts with `aspire start` and `aspire stop`
- Initializing Aspire in an existing app with `aspire init`
- Inspecting resources, logs, traces, and docs
- Adding integrations with `aspire add`
- Recovering missing TypeScript AppHost support files with `aspire restore`
- Discovering the correct frontend URL before a Playwright handoff
- Understanding unfamiliar Aspire AppHost APIs before editing C# or TypeScript AppHosts
- Managing AppHost secrets and CLI config
- Publishing and deploying Aspire apps, including single named steps with `aspire do`
- Adding custom dashboard or resource commands with docs-backed AppHost patterns

## Do not use this skill for

- Non-Aspire .NET applications
- Container-only workflows that do not involve an Aspire AppHost
- Replacing normal build and test commands when the task is just compiling code or running unit tests

## Default workflow

1. Confirm that the workspace is an Aspire app and identify the AppHost.
2. Start the app with `aspire start`. Use `--isolated` in git worktrees or whenever shared local state would be risky.
3. Use `aspire wait <resource>` before interacting with a resource that needs to be healthy.
4. Inspect state with `aspire describe`, then use `aspire otel logs`, `aspire logs`, `aspire otel traces`, and `aspire export` before making code changes.
5. Before adding an integration, introducing a custom dashboard/resource command, or using an unfamiliar AppHost API, run `aspire docs search <topic>` and then `aspire docs get <slug>` for the pattern or API you plan to implement.
6. Re-run `aspire start` after AppHost changes. In git worktrees, re-run `aspire start --isolated` instead of switching to `aspire run`.

## C# AppHosts

When the AppHost is implemented in C# such as `AppHost.cs`, `apphost.cs`, or a `Program.cs`-based AppHost, use Aspire docs to understand the documented API or pattern before editing.

- Use `aspire docs search <topic>` and `aspire docs get <slug>` when you need official guidance for an unfamiliar C# API, resource builder pattern, or command shape.
- If the `dotnet-inspect` skill is available, use it to inspect local C# APIs, overloads, and builder chains when you need help understanding how the API surface is exposed in code.
- Keep `dotnet-inspect` scoped to understanding APIs and symbols; use Aspire docs for the documented workflow and recommended pattern.

## TypeScript AppHosts

When the AppHost is `apphost.ts`, the `.modules/` folder at the project root contains generated TypeScript modules that expose the Aspire APIs available to the AppHost. Common files include `.modules/aspire.ts`, `base.ts`, and `transport.ts`.

- Do not edit `.modules/` directly.
- Use `aspire add <package>` to add integrations and regenerate the available APIs.
- Inspect `.modules/aspire.ts` after `aspire add` to see the refreshed API surface.
- The local `tsconfig.json` often includes `.modules/**/*.ts` in its compilation scope.

## Key rules

- Prefer `aspire start` over `dotnet run` for AppHosts. `aspire run` blocks the terminal and is a poor fit for agent workflows.
- Re-running `aspire start` is the restart path. In git worktrees, `aspire start --isolated` is both the start and restart command. Do not combine `aspire stop` and `aspire run`.
- Use `--apphost <path>` when the workspace has multiple AppHosts or discovery is ambiguous.
- Use `--format Json` when another tool or script needs machine-readable output.
- Do not guess the integration or command shape for unfamiliar AppHost changes. Use `aspire docs search` first, then `aspire docs get` before editing AppHost code for integrations, `WithCommand`, or other non-trivial Aspire APIs.
- For unfamiliar C# AppHost APIs, use Aspire docs as the primary API reference and, if available, use `dotnet-inspect` only to inspect local symbols, overloads, and builder chains.
- Never install the obsolete Aspire workload.
- When a TypeScript AppHost uses `.modules/`, do not edit generated files directly. Use `aspire add` to regenerate APIs and inspect `.modules/aspire.ts` afterward.
- Prefer official docs from `aspire.dev`.

## Common capabilities

- Use `aspire ps` when you need to discover running AppHosts before targeting one.
- Use `aspire update` when the task is to refresh AppHost package references through the supported CLI workflow.
- Use `aspire doctor` as an early diagnostics step when the local Aspire environment looks unhealthy.
- Use `aspire resource`, `aspire secret`, `aspire config`, `aspire publish`, `aspire deploy`, and `aspire do` when the objective is resource operations, secrets/config management, or deployment.
- Use `aspire restore`, `aspire cache clear`, `aspire certs trust`, and `aspire certs clean` when the task is local environment maintenance or recovery.

## Playwright CLI

If Playwright CLI is already configured in the environment, use Aspire first to discover the running app and its endpoints, especially when multiple frontends exist. Prefer `aspire describe --format Json` when the handoff needs to be scriptable or you need to disambiguate which frontend URL Playwright should use, then hand browser testing off to Playwright CLI.

## References

- For app-level lifecycle, bootstrap, and AppHost-wide commands, see [references/app-commands.md](references/app-commands.md).
- For waiting on and operating on individual resources, see [references/resource-management.md](references/resource-management.md).
- For app state, logs, traces, and export workflows, see [references/monitoring.md](references/monitoring.md).
- For deployment and pipeline-step workflows, see [references/deployment.md](references/deployment.md).
- For docs, secrets, config, diagnostics, cache, and certificates, see [references/tools-and-configuration.md](references/tools-and-configuration.md).
- For C# AppHost API-understanding guidance, see [references/csharp-apphosts.md](references/csharp-apphosts.md).
- For TypeScript AppHost guidance, see [references/typescript-apphosts.md](references/typescript-apphosts.md).
- For Playwright handoff after Aspire endpoint discovery, see [references/playwright-handoff.md](references/playwright-handoff.md).
- For investigation order and common agent workflows, see [references/agent-workflows.md](references/agent-workflows.md).
```

---

## File 2: `.agents/skills/aspire/references/app-commands.md`

```markdown
# App Commands

Use this when the task is about app-level lifecycle, bootstrap, or AppHost-wide maintenance.

## Scenario: Start The App Safely In The Background

Use these commands when the user wants the AppHost running, needs a safe worktree session, or wants to pick up AppHost changes.

```bash
aspire start
aspire start --isolated
aspire stop
```

Keep these points in mind:

- Use `aspire start` for normal background AppHost execution.
- In git worktrees or when another local instance may already be running, use `aspire start --isolated`.
- To restart after AppHost changes, rerun the same start command. In a worktree, rerun `aspire start --isolated`.
- Use `aspire stop` only when the ask is explicitly to stop the app or clean up a running AppHost.
- Avoid `aspire run` in normal agent workflows because it blocks the terminal.

## Scenario: Create A New Aspire App Or Add Aspire To An Existing App

Use these commands when the task is to bootstrap Aspire support.

```bash
aspire new
aspire init
aspire init --language typescript
```

Keep these points in mind:

- Use `aspire new` when creating a brand-new Aspire app from scratch.
- Use `aspire init` when adding Aspire to an existing application.
- If the existing app flow needs a specific AppHost language, choose it explicitly rather than inventing unrelated scaffolding.

## Scenario: Find The Right AppHost Or Refresh AppHost-Wide Support

Use these commands when multiple AppHosts may be running locally, when the AppHost needs an integration, or when local AppHost support files need refresh or restore.

```bash
aspire ps
aspire add <package>
aspire update
aspire restore
```

Keep these points in mind:

- Use `aspire ps` first when you need to discover which AppHost is already running.
- Use `aspire add <package>` when the task is to add a supported integration or regenerate AppHost APIs.
- Use `aspire update` when the ask is specifically to refresh AppHost package references through the supported CLI workflow.
- Use `aspire restore` after pulls, cleans, or missing generated files when the AppHost needs its local support restored before running again.
```

---

## File 3: `.agents/skills/aspire/references/resource-management.md`

```markdown
# Resource Management

Use this when the task is scoped to one resource or depends on a specific resource becoming healthy.

## Scenario: Wait For One Resource Before Touching It

Use these commands when the next step depends on one resource being ready, such as before calling an API, opening a frontend, or querying a database.

```bash
aspire wait <resource>
aspire wait <resource> --status up --timeout 60
```

Keep these points in mind:

- Use `aspire wait` before a dependent action when readiness is the real blocker.
- Add `--status` and `--timeout` when the ask calls for an explicit readiness condition rather than a generic wait.
- Treat readiness as a resource-scoped concern; a missing ready signal is not automatically a reason to restart the whole AppHost.

## Scenario: Fix Or Operate On One Resource Without Bouncing The Whole App

Use these commands when the user calls out one resource by name, such as Redis, Postgres, cache, or a single custom resource command.

```bash
aspire resource <resource> start
aspire resource <resource> stop
aspire resource <resource> restart
aspire resource <resource> <command>
```

Keep these points in mind:

- Prefer resource-scoped commands when the task does not require an AppHost-wide restart.
- If the user says one resource is wedged, use `aspire resource <resource> restart` before escalating to `aspire start`.
- Use `aspire resource <resource> <command>` when the AppHost exposes a resource-specific dashboard or operational command.
```

---

## File 4: `.agents/skills/aspire/references/monitoring.md`

```markdown
# Monitoring

Use this when the task is about inspecting app state, logs, traces, endpoints, or sharable diagnostics.

## Scenario: I Need To Know What Is Running And Where The Endpoints Are

Use these commands when the first job is to inspect current resource state, find URLs, or hand machine-readable app state to another tool.

```bash
aspire describe
aspire resources
aspire describe --apphost <path>
aspire describe --apphost <path> --format Json
```

Keep these points in mind:

- Use `aspire describe` first when you need the current state of the running app before deciding what to do next.
- Use `--apphost <path>` when the workspace has multiple AppHosts or discovery is ambiguous.
- Prefer `--format Json` when another tool or script needs to consume the result, such as a Playwright handoff or endpoint extraction.

## Scenario: Something Is Wrong, But Investigate Before Editing Code

Use these commands when the task is to diagnose behavior in the live app before making code changes.

```bash
aspire otel logs [resource]
aspire otel traces [resource]
aspire otel spans [resource]
aspire otel logs --trace-id <id>
aspire logs [resource]
```

Keep these points in mind:

- Prefer structured telemetry before raw console logs when possible.
- Use `aspire logs` as a secondary console-output view after checking structured telemetry.
- Use the trace-filtered log command when you already have a trace id and want the related log slice.

## Scenario: I Need A Sharable Diagnostics Bundle

Use this command when you need a portable handoff artifact for deeper analysis or for another person to inspect offline.

```bash
aspire export [resource]
```

Keep this point in mind:

- Use `aspire export` when you need a sharable bundle of telemetry and resource state.
```

---

## File 5: `.agents/skills/aspire/references/deployment.md`

```markdown
# Deployment

Use this when the task is about deployment artifacts, deployment execution, or named pipeline steps.

## Scenario: Regenerate Deployment Artifacts And Redeploy

Use these commands when the task is to build fresh deployment artifacts and run the full deployment flow.

```bash
aspire publish
aspire deploy
aspire deploy --clear-cache
```

Keep these points in mind:

- Use `aspire publish` when artifact generation is part of the request.
- Use `aspire deploy` when the goal is the full deployment flow, not just one step inside it.
- Use `aspire deploy --clear-cache` when cached deployment state is stale or stuck.

## Scenario: Run One Named Deployment Step Instead Of The Whole Deployment

Use these commands when the deployment pipeline already exists and the user wants only one step, such as seeding data, running diagnostics, or pushing containers/images.

```bash
aspire do seed-data
aspire do push-containers   # if the app defines this step
aspire do diagnostics       # if the app defines this step
```

Keep these points in mind:

- Use `aspire do <step>` when the request is specifically about one named pipeline step.
- Common scenarios include seeding data, running a diagnostics step, or pushing containers/images, but the step names are app-defined.
- Do not substitute `aspire deploy` when the request is to rerun only one step from the deployment pipeline.
```

---

## File 6: `.agents/skills/aspire/references/tools-and-configuration.md`

```markdown
# Tools And Configuration

Use this when the task is about docs lookup, secrets, CLI configuration, diagnostics, cache cleanup, or local certificates.

## Scenario: I Need Docs Before I Change The AppHost Or Use An Unfamiliar API

Use these commands when the task is to confirm the right Aspire workflow before editing code.

```bash
aspire docs search <query>
aspire docs list
aspire docs get <slug>
```

Keep these points in mind:

- Use docs commands before changing integrations when you need to confirm the supported path.
- Use docs commands before implementing custom resource commands or unfamiliar AppHost APIs such as `WithCommand`.
- Use docs commands when the user needs help understanding an Aspire API, not just when they need a task workflow.
- Use `aspire docs list` when you need to browse the available doc set before narrowing to a specific page.

## Scenario: I Need To Inspect Or Change AppHost Secrets

Use these commands when the task is about AppHost user secrets such as connection strings, passwords, or API keys.

```bash
aspire secret set <key> <value>
aspire secret get <key>
aspire secret list
aspire secret path
aspire secret delete <key>
```

Keep these points in mind:

- Use `aspire secret` for AppHost user secrets instead of inventing another storage path.
- Use `aspire secret path` when the task is to locate the backing store without opening it manually.

## Scenario: I Need To Explain Where Aspire CLI Settings Came From

Use these commands when the question is about effective Aspire CLI configuration or conflicting local versus global settings.

```bash
aspire config set <key> <value>
aspire config get <key>
aspire config list
aspire config delete <key>
aspire config info
```

Keep these points in mind:

- Use `aspire config info` when the user wants to know where settings come from, which settings files are in play, or why the CLI is behaving a certain way locally.

## Scenario: My Local Aspire Setup Feels Broken

Use these commands when the local Aspire environment looks unhealthy and needs recovery steps rather than AppHost code changes.

```bash
aspire doctor
aspire cache clear
aspire certs trust
aspire certs clean
```

Keep these points in mind:

- Use `aspire doctor` early when the symptoms suggest local environment drift rather than an app bug.
- Use `aspire cache clear` when cached state is stale or interfering with normal operation.
- Use `aspire certs trust` and `aspire certs clean` when local certificate state is part of the problem.
```

---

## File 7: `.agents/skills/aspire/references/agent-workflows.md`

```markdown
# Aspire Agent Workflows

Use these patterns when a task needs investigation or orchestration rather than a one-off command lookup.

## Scenario: I Am In A Worktree And Need A Safe Background Run

Start the AppHost with `aspire start` so the CLI manages background execution. In git worktrees, use `--isolated` to avoid port conflicts and shared local state:

```bash
aspire start --isolated
```

If the next step depends on one resource, wait for it explicitly:

```bash
aspire start --isolated
aspire wait myapi
```

Keep these points in mind:

- In a git worktree, rerun `aspire start --isolated` whenever AppHost changes need to be picked up.
- Outside worktrees, rerun `aspire start`.
- Avoid `aspire run` in normal agent workflows because it blocks the terminal.

## Scenario: Something Is Wrong, But Do Not Edit Code Yet

Inspect the live app before editing code:

1. `aspire describe` to check resource state.
2. `aspire otel logs <resource>` to inspect structured logs.
3. `aspire logs <resource>` to inspect console output.
4. `aspire otel traces <resource>` to follow cross-service activity.
5. `aspire export` when you need a zipped telemetry snapshot for deeper analysis or handoff.

## Scenario: I Need To Add An Integration, Understand An API, Or Add A Custom Command Safely

Use the docs commands first, then add the integration or edit the AppHost:

```bash
aspire docs search postgres
aspire docs get <slug>
aspire add <package>
```

For dashboard or custom resource commands, use the docs first:

```bash
aspire docs search "custom resource commands"
aspire docs get custom-resource-commands
```

Keep these points in mind:

- Read the docs before editing the AppHost so the implementation follows a documented Aspire pattern instead of guessing the API shape.
- If the AppHost is C# and you need to understand local overloads or builder chains, use the `dotnet-inspect` skill if it is available, but keep Aspire docs as the primary source of documented guidance.
- After adding an integration, restart with `aspire start` so the updated AppHost takes effect.

## Scenario: The AppHost Is TypeScript And Generated APIs Matter

If the AppHost is `apphost.ts`, the `.modules/` directory contains generated TypeScript modules that expose Aspire APIs.

- Do not edit `.modules/` directly.
- Use `aspire add <package>` to regenerate the available APIs when adding integrations.
- Use `aspire restore` if `.modules/` disappeared after a pull, clean, or branch switch.
- Inspect `.modules/aspire.ts` after regeneration or restore to see the newly available APIs.

## Scenario: I Need Secrets, Deployment, Or A Playwright Handoff

Use `aspire secret` for AppHost user secrets, especially connection strings and passwords:

```bash
aspire secret set Parameters:postgres-password MySecretValue
aspire secret list
```

Use `aspire publish` and `aspire deploy` for full deployment work, or `aspire do <step>` when the user only wants one named pipeline step such as seeding data or pushing containers.

If Playwright CLI is configured in the environment, use Aspire to discover the endpoint first and let Playwright use that discovered URL afterward. When multiple frontends exist or the URL needs to be passed to another tool, prefer `aspire describe --format Json` before the Playwright handoff.
```

---

## File 8: `.agents/skills/aspire/references/csharp-apphosts.md`

```markdown
# C# AppHosts

Use this when the AppHost is implemented in C# and the task involves understanding APIs, extension methods, overloads, or builder chains before editing code.

## Scenario: I Need Official Docs For An Unfamiliar C# AppHost API

Use these commands when you need the documented Aspire pattern before changing C# AppHost code.

```bash
aspire docs search <query>
aspire docs get <slug>
```

Keep these points in mind:

- Use Aspire docs first when the task is about understanding an unfamiliar resource builder API, extension method, dashboard command pattern, or integration workflow.
- Search for the resource or pattern name before guessing the C# API shape.
- Use the docs to confirm the recommended pattern before editing the AppHost.

## Scenario: I Need To Read The Local C# API Surface More Closely

Use this when the docs tell you what concept to use, but you still need to inspect local symbols, signatures, or overloads in C# code.

Keep these points in mind:

- If the `dotnet-inspect` skill is available, use it to inspect local C# APIs, extension methods, overloads, and chained builder return types.
- Keep `dotnet-inspect` scoped to understanding APIs and symbols; do not treat it as a replacement for Aspire docs.
- When `dotnet-inspect` is not available, fall back to reading local AppHost code together with the relevant Aspire docs pages.
```

---

## File 9: `.agents/skills/aspire/references/typescript-apphosts.md`

```markdown
# TypeScript AppHosts

Use this when the AppHost is `apphost.ts` and the task involves generated APIs or TypeScript-specific Aspire workflows.

## Scenario: I Added An Integration And Need New APIs To Show Up In `apphost.ts`

Use this when the task touches `.modules/` or newly added integrations.

```bash
aspire add <package>
```

Keep these points in mind:

- The `.modules/` folder contains generated TypeScript modules that expose Aspire APIs to the AppHost.
- Common generated files include `.modules/aspire.ts`, `base.ts`, and `transport.ts`.
- Do not edit `.modules/` directly.
- Use `aspire add <package>` to regenerate the available APIs after adding an integration.
- Inspect `.modules/aspire.ts` after `aspire add` to see the refreshed API surface available to `apphost.ts`.
- The local `tsconfig.json` often includes `.modules/**/*.ts` in its compilation scope.

## Scenario: `.modules/` Disappeared After A Pull, Clean, Or Branch Switch

Use this when generated support files are missing or stale and the TypeScript AppHost needs to be restored.

```bash
aspire restore
```

Keep these points in mind:

- Try `aspire restore` first when generated `.modules/*` files are missing.
- `aspire restore` restores and regenerates the TypeScript AppHost support files under `.modules/`.
- Do not manually recreate or edit generated module files.
- After recovery, inspect `.modules/aspire.ts` to confirm the available API surface.
```

---

## File 10: `.agents/skills/aspire/references/playwright-handoff.md`

```markdown
# Playwright Handoff

Use this when Playwright CLI is already configured and the next step is browser testing against a running Aspire app.

## Scenario: I Need The Right Frontend URL Before Browser Testing

Use these commands when the task is to discover the live frontend endpoint from Aspire state and then hand that URL to Playwright.

```bash
aspire describe --format Json
aspire describe --apphost <path> --format Json
playwright-cli --help
```

Keep these points in mind:

- Aspire discovers the endpoint first; Playwright uses the discovered endpoint after the handoff.
- Prefer `aspire describe --format Json` when the URL needs to be consumed by a script or passed to another tool.
- Use `--apphost <path>` when multiple AppHosts exist and the user is asking about one specific app.
- Do not guess frontend endpoints without first consulting Aspire state.
- If multiple frontends exist, use Aspire state to disambiguate which URL Playwright should use.
```

---

These are all 10 files from PR #15745 with their complete content as requested.