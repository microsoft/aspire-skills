# Aspire tapes: supported VHS syntax and output formats

Read the [Charmbracelet VHS command reference](https://github.com/charmbracelet/vhs#vhs-command-reference)
and [VHS integration-testing guidance](https://github.com/charmbracelet/vhs#integration-testing)
for background. **Aspire implements a subset against an existing resource
terminal.** It does not run VHS or inherit all its commands/output formats.
Do not install VHS, ttyd or ffmpeg to play Aspire tapes.

This allowlist is based on Aspire `release/13.6` at
`34db30a7d3733229da64a403dfc4e4e4d7a1a43b`, using
[Hex1b v0.168.0](https://github.com/mitchdenny/hex1b/tree/v0.168.0)
(`d87cce18e6eaa1260305ce4a5278c14d7e79a95d`), whose reference grammar is VHS
v0.11.0. The current upstream README can describe newer syntax. Qualify the
installed Aspire build rather than assuming upstream additions work.

## Supported subset

| Syntax | Example | Use and boundary |
|--------|---------|------------------|
| Comment | `# Wait for the REPL` | Explain assumptions; no input sent |
| Quoted text | `Type "help"` | Type literal text; does **not** press Enter |
| Typing speed | `Set TypingSpeed 0`, `Type@50ms "help"` | Fast automation or deliberate per-character pacing |
| Named keys | `Enter`, `Space`, `Tab`, `Escape`, `Backspace`, `Delete`, `Insert`, `Up`, `Down`, `Left`, `Right`, `PageUp`, `PageDown` | Send application input; page keys do not directly scroll the viewer |
| Repeat and delay | `Up 2`, `Backspace@100ms 3` | Repeat keys or pace editing |
| Modifier chord | `Ctrl+a`, `Shift+Tab`, `Alt+x` | Tool-dependent shortcuts; not every C# key has a tape mapping |
| Default prompt regex | `Set WaitPattern "repl>$"` then `Wait` | Use a tool-specific pattern; bare Wait has Line scope |
| Cursor-row wait | `Wait+Line /repl>$/` | Match the cursor's current row |
| Screen wait | `Wait+Screen /Operation complete/` | Match screen output, not logs or process exit |
| Wait budget | `Set WaitTimeout 10s`, `Wait+Screen@5s /Ready/` | Default/per-command timeout, separate from CLI overall timeout |
| Fixed delay | `Sleep 100ms` | Pacing only; prefer output waits for readiness |
| Include | `Source "common/ready.tape"` | Trusted reusable commands; paths remain root-tape-relative |
| Text output | `Output "probe.txt"` or `Output "probe.ascii"` | One distinct text checkpoint destination |
| Checkpoint visibility | `Hide`, commands, `Show` | Skip intermediate capture checkpoints, **not** input execution or secret redaction |

Put `Output`, `Set WaitPattern` and `Set WaitTimeout` in the initial setup block.
Only TypingSpeed should change dynamically; late wait settings are ignored with
diagnostics. Defaults in the player are 50ms typing, 15s waits and pattern `>$`;
set them explicitly for a predictable test.

Use VHS quoted strings, not assumed JSON/C# escapes. Pick a quote delimiter that
does not collide with the input, for example `Type 'echo "hello"'`. A shell escape
such as `\n` in the recipe below belongs to `printf`, not a tape newline/Enter.
Use separate `Enter` commands to submit input.

Use simple regexes (literal text, character classes, anchors). Neither arbitrary
.NET regex syntax nor all Go regex features are supported. In particular, do not
depend on `i`/`U` flags, word boundaries, Unicode-property or POSIX classes.
The tape key catalog is smaller than `AspireTerminalKey`; even a parsed name such
as `End` need not have a supported playback mapping. Stick to the keys above.

## Output formats and how to use them

| Output | Contents | Appropriate use |
|--------|----------|-----------------|
| stdout | Final plain-text screen on success; failure screen for tape-command playback failures | One-shot inspection, separate captured final snapshot; not JSON or replay |
| `Output "probe.txt"` | UTF-8 text checkpoints after visible executed commands | Intermediate-state diagnostics, artifacts, deterministic golden comparisons |
| `Output "probe.ascii"` | **Identical** checkpoint encoding to `.txt` | VHS-style golden naming; not ASCII-only and not ANSI-styled |
| stderr | Discovery, warnings and source-located diagnostics | Keep separate from screen/golden assertions |

Text checkpoint encoding: UTF-8 without BOM, LF newlines, trailing whitespace
trimmed from each row, and an 80-character U+2500 box-drawing separator between
checkpoints. Repeated snapshots are retained. No styling or cursor metadata is
recorded. Checkpoints use terminal-height rows from the active buffer start,
which can differ from the visible viewport after scrollback.

Only **one distinct text Output destination** is supported per tape; VHS's
multiple-output workflows do not carry over. Parent directories must already
exist, and output files are **not overwritten**. Use a fresh actual-output filename
for each run; don't write over an expected golden. A partial file after a failed
playback is not a passing test artifact.

All Source and Output paths resolve from the **root tape directory on the CLI
host**, not the resource/container working directory. Nested includes do not
change that base. Includes must be `.tape` files, cycles are rejected, and
included Output directives are ignored. Review included commands before playback.

**Not supported through Aspire:** GIF, MP4, WebM, PNG/screenshots/frame output,
or `.cast` recordings. Hex1b's separate programmatic Asciinema support does not
expose an Aspire CLI capture flag. Don't advertise video/image/replay formats
based on renderer capabilities or VHS docs.

Also unsupported: clipboard `Copy`/`Paste`, viewer `ScrollUp`/`ScrollDown`,
`Require`, `Env`, `Set Shell`, dimensions, fonts, themes and presentation settings.
Aspire connects to an existing terminal instead of configuring a VHS recording
environment. Unsupported effects fail preflight before preceding input executes.

`Hide` does **not** remove secrets: later checkpoints, stdout or other viewers
can still show them. Never type credentials into committed tapes or treat hidden
commands as safe to capture.

## Recipe: verify real shell output and save checkpoints

Prerequisites: an idle, compatible POSIX shell is already the selected resource's
process; its current prompt ends in `$`, `#` or `>`, and the success marker is not
already on screen. Do not run shell syntax into an arbitrary REPL.

```tape
Output "probe.txt"
Set TypingSpeed 0
Set WaitTimeout 10s
Wait+Line /[$#>]$/
Type "printf 'ASPIRE_TAPE_%s\n' ready"
Enter
Wait+Screen /ASPIRE_TAPE_ready/
```

The matched marker is not contiguous in the typed command, so ordinary input
echo alone cannot satisfy the assertion. Still use a fresh fixture/unique marker
when repeating tests; stale screen text can otherwise produce a false pass.
Adapt the initial prompt pattern to the actual shell (including trailing spaces).

```sh
aspire terminal tape play shell --tape-file ./probe.tape --replica 0 --apphost <apphost-path> --timeout 60 --non-interactive
```

`--timeout` bounds the whole operation (default 120s), including producer wait and
connection. It is not `Set WaitTimeout`. Playback runs as a secondary peer:
no new shell, resizing, producer shutdown or exclusive input lock. Do not retry
non-idempotent input automatically.

## Recipe: inspect without input

```tape
# Snapshot only: this tape intentionally sends no input.
```

Play this tape and capture stdout separately from stderr. It reads the current
screen after the initial snapshot. An Output-only tape has no executed-command
checkpoints to rely on; stdout is the right interface for one-shot inspection.
Always check the CLI exit status; non-playback failures may have no screen.

## Recipe: deterministic REPL golden

For a resource-hosted REPL whose actual protocol is `repl>` and `help`:

```tape
Output "actual.ascii"
Set TypingSpeed 0
Set WaitPattern "repl>$"
Set WaitTimeout 10s
Wait
Type "help"
Enter
Wait+Screen /Available commands/
Wait
```

Compare the fresh `actual.ascii` to a separate reviewed expected file only after
successful playback. Stabilize fixture dimensions outside the tape, input state
and output; avoid timestamps/PIDs. Checkpoint comparison is text comparison,
not a timed replay. For final-state assertions only, compare stdout instead.

This CLI cannot target an AppHost-owned dock REPL by terminal ID. Integration
`WithRepl` creates a dock terminal; automate its handle using public AppHost APIs
where available, or use a deliberately resource-hosted fixture for tape tests.
