---
name: aspire-terminals
description: >-
  **WORKFLOW SKILL** - Author and automate Aspire terminals.
  USE FOR: WithTerminal, withTerminal, TerminalService, TerminalLaunchOptions,
  docked terminals, terminal prompts, PromptTerminalAsync, TerminalPlacement,
  AspireTerminalKey, WithRepl, withRepl, aspire terminal ps/attach/tape play,
  VHS tapes for Aspire, or terminal screen/input automation.
  DO NOT USE FOR: generic shell commands, ordinary AppHost resource wiring
  (aspireify), start/stop/wait (aspire-orchestration), logs/traces or browser
  telemetry (aspire-monitoring), deployment (aspire-deployment), or nonterminal
  Interaction Service prompts (aspireify).
  INVOKES: Aspire docs/API lookup, AppHost edits, Aspire terminal CLI;
  aspire-orchestration for lifecycle validation.
  FOR SINGLE OPERATIONS: Choose the terminal owner and lifetime first, then read
  the matching reference.
license: MIT
metadata:
  author: Microsoft
  version: "0.0.3"
---

# Aspire Terminals

Teach an agent to use the right terminal, not to replace every process with a shell.
Honor a project-local `.agents/skills/aspire-terminals/SKILL.md` when present;
retain the safety and ownership rules below.

## Required reference lookup

Before answering **or** editing, open the reference for the requested surface,
including for read-only questions. This overview is not enough to write correct
terminal code or tape syntax.

- Resource PTYs or REPLs: read [resource terminals](references/resource-terminals.md).
- Dock, prompts, cancellation or headless tools: read
  [AppHost terminals](references/apphost-terminals.md).
- Any tape question: read [tapes](references/tapes.md) and
  [automation and CLI](references/automation-and-cli.md). Use the actual syntax and
  output contracts there, not pseudo-VHS or memory of upstream VHS behavior.
- Include the applicable package/build capability boundary in recommendations.
  Source availability and installed-package availability are different facts.

## Choose the model before writing code

| Intent | Pattern | Owner and lifetime |
|--------|---------|--------------------|
| Make an existing orchestrated executable, project or container interactive | `WithTerminal()` / `withTerminal()` | Resource process and replicas; resource lifecycle owns stop/restart |
| Open an auxiliary shell/tool that remains available after its command returns | `TerminalService` + `TerminalPlacement.Dock` | AppHost-owned; closing its tab or stopping AppHost disposes it |
| Guide a person through a focused setup/authentication operation | `TerminalService` + `Dialog` + `PromptTerminalAsync` | Caller owns the terminal; prompt borrows it; explicit completion/cancellation |
| Drive a terminal-only tool without a dashboard interaction | `TerminalService` + `None` | Caller owns and disposes the headless process |
| Open an authenticated database/cache client | Integration `WithRepl()` / `withRepl()` | Built-in command opens a dock terminal; prefer over custom container exec |

`WithTerminal` changes **the resource's actual process execution**. It is not an
on-demand side shell. `TerminalService` launches a separate AppHost-owned process;
it does not implicitly enter a container or become a modeled resource.

### Lifecycle checklist for recommendations

When comparing terminal models, explicitly state cleanup for each model you
recommend, including headless alternatives:

- **Dock:** survives the opening command; do not scope the handle with `await using`
  in that command. Closing the tab or AppHost shutdown disposes it.
- **Dialog and None:** the caller disposes both, normally with `await using`.
  Headless placement does not transfer cleanup responsibility to the service.
- **Prompt completion is not terminal disposal:** successful `Work` closes the
  prompt, but the caller still disposes its terminal. Without `Work`, process exit
  does not close the prompt; explicit completion/cancellation is required.

## Capability check

1. Locate the exact AppHost and inspect its SDK, hosting and integration package
   versions. Do not upgrade the project just to make an example compile.
2. Use `aspire docs search terminal --non-interactive`, then
   `aspire docs api search <API> --language csharp|typescript --non-interactive`.
   If docs lag a preview, inspect that exact package's public API/source. A newer
   CLI alone does not add hosting APIs to an older AppHost.
3. `WithTerminal`/parameterless TS `withTerminal` exist in Aspire 13.5.
   `TerminalService`, terminal prompts, headless automation, tape playback and the
   six integration REPLs below are in the inspected **13.6 development source**.
   Verify the installed build contains them; do not promise all previews do.
4. Direct C# terminal APIs are experimental (`ASPIRETERMINAL001`): narrowly pair
   `#pragma warning disable ASPIRETERMINAL001` with `#pragma warning restore
   ASPIRETERMINAL001`. The examined integration `WithRepl` methods themselves
   do not require this suppression.
5. General `TerminalService` and terminal-prompt APIs are **not exported to
   TypeScript** in this baseline. Do not invent TS equivalents or edit generated
   `.aspire/modules/`. Supported TS entry points are `withTerminal()` and the
   applicable integration's `withRepl()`.
6. Check `aspire terminal --help` for the installed CLI. Terminal commands no
   longer require feature-flag enablement. If a command is absent, check the
   installed version and help rather than setting the removed flag.

The references are qualified against Aspire `release/13.6` commit
`34db30a7d3733229da64a403dfc4e4e4d7a1a43b` (terminal code also present in main
`22bee5e1266b7b66ff53008957dde86efb370c79`), compared with shipped `v13.5.0`.
Terminal-command availability guidance also reflects the subsequent
[feature-flag removal](https://github.com/microsoft/aspire/pull/20525).
Recheck capabilities against the user's actual build.

## Authoring workflow

1. Identify which process needs the PTY and whether it should remain visible,
   block a focused workflow, or run headlessly. Ask if the lifetime is unclear.
2. Read [resource terminals](references/resource-terminals.md) for `WithTerminal`
   and built-in REPLs; read [AppHost terminals](references/apphost-terminals.md)
   for complete dock, manual prompt, automated prompt and headless recipes.
3. Keep terminal-specific edits separate from unrelated resource/dependency changes.
   Use `aspireify` for new general resource wiring and `aspire-init` if no AppHost
   exists. Do not turn a terminal request into a migration or version upgrade.
4. Resolve actual executable paths, working directories and OS shell choices.
   Use argument lists, not concatenated untrusted shell input. Children inherit
   the AppHost environment; add only the necessary overrides.
5. Guard AppHost-owned terminal commands with `builder.ExecutionContext.IsRunMode`.
   Do not launch tools at model-construction time or during publish/deploy.
6. Validate the changed code, then route lifecycle work to `aspire-orchestration`.
   Use the exact AppHost, worktree isolation and bounded resource readiness.
   Validate the requested lifetime, cancellation and visible result, not merely
   that the AppHost compiled.

## Non-negotiable ownership and completion rules

- Terminal types are in `Aspire.Hosting.ApplicationModel`, not the old
  `Aspire.Hosting.Terminals` namespace. `TerminalService` is already registered;
  resolve it from built services or command `context.Services`. Do not construct
  it or register another singleton.
- A dock command that should leave a terminal open **must not** use `await using`
  for its handle. `Start()` is nonblocking/idempotent; `Show()` activates the dock.
  Command success means "opened", not "process exited successfully".
- Dialog and headless terminals normally use `await using`. Disposing an
  AppHost-owned handle stops its process; `PromptTerminalAsync` does **not**
  dispose it for you.
- Check `IInteractionService.IsAvailable` **before** launching a prompt-owned
  process. Noninteractive resource commands can make it false. Do not silently
  replace human interaction/approval with headless success.
- A prompt needs the exact registered instance from the same AppHost, with
  `TerminalPlacement.Dialog`. `ResourceView` is not valid for `CreateTerminal`.
- With `Work`, successful callback completion closes the dialog; observe
  `TerminalContext.CancellationToken` on every wait/input. Cancellation signals
  and joins Work; unrelated errors propagate. Without Work, process exit does
  not close the prompt: explicitly define completion/cancellation.
- No public `ExitCode` or `WaitForExitAsync` is available on `AspireTerminal`.
  Do not infer success from `Start()`, delivered keystrokes, prompt visibility,
  or disappearance of a process. Assert a meaningful fresh output marker.
- Viewers and automation share input. `--viewer` affects sizing ownership,
  not read-only authorization. Do not blindly retry non-idempotent input.
- Treat screen output and tapes as sensitive. Do not commit credentials or
  capture tokens in transcripts. Tape `Hide` is not redaction.

## Driving terminals

Read [automation and CLI](references/automation-and-cli.md) for C# screen/key
operations, owner-aware discovery and interactive attach. Use
[tapes](references/tapes.md) for unattended resource-terminal playback: supported
VHS syntax, explicit examples, stdout versus `.txt`/`.ascii` checkpoints, and
unsupported output formats. Do not install VHS or assume its whole feature set.

For missing/disconnected terminals, inspect resource state and terminal discovery;
route console logs/traces to `aspire-monitoring`. Terminal views supplement logs,
not replace them. Publishing a resource does not publish a development PTY or
grant production shell access.
