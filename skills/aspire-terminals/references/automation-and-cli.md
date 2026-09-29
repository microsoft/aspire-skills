# Terminal automation and CLI

## C# screen and input

Use the recipes in [AppHost terminals](apphost-terminals.md) for ownership,
disposal and cancellation. On a live `AspireTerminal`:

| API | Meaning |
|-----|---------|
| `Start()` | Idempotent, nonblocking start; not readiness or successful exit |
| `Show()` | Reveal/activate a dock terminal |
| `SendTextAsync(text, cancellationToken)` | Send literal text, including Unicode; no implicit Enter |
| `SendKeyAsync(key, cancellationToken)` | Send a terminal key or chord |
| `WaitForTextAsync(text, timeout, cancellationToken)` | Wait for literal screen text, default 30 seconds; not regex/log history |
| `GetScreenText()` | Read current screen text; not exit status or structured telemetry |
| `DisposeAsync()` | AppHost owner: stop process; resource owner: disconnect automation peer |

`AspireTerminalKey` includes letters/digits, navigation, function and punctuation
keys, with Ctrl/Shift/Alt modifiers. For example,
`AspireTerminalKey.Ctrl(AspireTerminalKey.R)` sends Control+R. Compose modifiers
using these methods, not bitwise enum flags, tape key strings or OS key-down/up.

Use explicit wait budgets and cancellation. Check that output proves the desired
result rather than matching input echo, stale output or a generic shell prompt.
`WaitForTextAsync` polls screen state, including text already displayed; it is not
a future-output event subscription that must be armed before sending Enter.
Use a fresh process/marker and output that remains on screen long enough to match.
Shared human/agent input is not isolated; do not auto-retry actions that may have
already changed state. Never log screens indiscriminately if they may hold secrets.

`TerminalService.TryGetTerminal(id, out terminal)` supports known terminal IDs.
There is no public resource-name/replica lookup API in the inspected baseline.
Do **not** synthesize internal `resource:{name}:{replica}` IDs. Resource automation
connects lazily as a secondary peer and does not resize, start or stop the workload.

## Check capabilities, then discover owners

Terminal commands no longer require feature-flag enablement. If commands are
absent, check the installed version and help rather than setting the removed
flag or guessing alternative syntax.

```sh
aspire terminal --help
aspire terminal ps --format json --verbose --apphost <apphost-path> --non-interactive
```

The 13.6 JSON output is an **array discriminated by `owner`**, not one uniform
resource list:

| Owner | Fields and implications |
|-------|-------------------------|
| `resource` | Resource name/display name, configured dimensions, reachability and replicas (liveness, peers, restarts); verbose includes peer details |
| `apphost` | Terminal ID/display name/placement; independently launched session |

Inspect actual fields from the installed CLI rather than deriving IDs from titles.
Both owners can appear in discovery, but **attach and tape play target resource
names, not arbitrary AppHost terminal IDs**.

For a resource, use `aspire describe --apphost <path> --non-interactive` and
`aspire wait <resource> --apphost <path> --non-interactive` before input. If several
AppHosts/replicas exist, choose the exact target. Lifecycle operations belong to
`aspire-orchestration`, logs/traces to `aspire-monitoring`.

## Interactive attach is for a human terminal

```sh
aspire terminal attach <resource> --replica <zero-based-index> --apphost <apphost-path>
```

This command runs an interactive TUI. Do not launch it as an unattended agent
substitute for screen automation. Ctrl+B then D detaches; Ctrl+B then T takes
primary control. `--viewer` connects as a secondary sizing peer: it is **not**
read-only authorization and must not be sold as a safe input lock.

Each replica has a separate terminal. Multiple replicas require explicit selection
in noninteractive contexts. Detach disconnects the viewer without stopping the
resource; use resource lifecycle commands for stop/restart.

## Unattended resource automation: tapes

```sh
aspire terminal tape play <resource> --tape-file <path/to/probe.tape> --replica <index> --apphost <apphost-path> --timeout 60 --non-interactive
```

Requires a build with tape support (13.6 development baseline). The CLI attaches
as a secondary peer to an existing resource terminal. It neither launches a
shell nor resizes/stops the producer. The overall timeout defaults to 120 seconds
and bounds producer waiting, connection and playback. Per-command wait budgets
are separate and must fit inside it.

Final screen text is stdout; diagnostics are stderr. A tape-command playback
failure also prints its failure screen; discovery/validation/connection failures
need not. Check the exit status and a meaningful output assertion. Completing a
tape does not prove every command typed into the shell succeeded.

Read [Aspire's VHS subset and output formats](tapes.md) before writing any tape.
Empty/comment-only tapes capture the current screen after the initial snapshot,
without sending input. Prefer them for inspection.

## Source evidence

- [Terminal CLI commands](https://github.com/microsoft/aspire/tree/34db30a7d3733229da64a403dfc4e4e4d7a1a43b/src/Aspire.Cli/Commands)
- [Resource lookup proposal, not an available API](https://github.com/microsoft/aspire/issues/20219)
- [Terminal-command feature-flag removal](https://github.com/microsoft/aspire/pull/20525)
