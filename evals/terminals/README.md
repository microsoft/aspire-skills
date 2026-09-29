# Terminal evaluations and qualification

`skills/aspire-terminals/evals/eval.yaml` covers selection, actual C# edits,
capability/language gates, cancellation, ownership, REPLs, tape semantics and
negative routing. `grade-edit.mjs` requires an actual captured `app/Program.cs`
diff and checks fixture-specific API/lifetime invariants. It is not a compiler.
The prompt judge checks the full command shown in the agent response; omitted
or truncated tool output must not be mistaken for evidence of correct code.

Run deterministic contracts with:

```sh
node --test tests/terminal-skill.test.mjs tests/router-eval-contract.test.mjs tests/eval-spec-compat.test.mjs
```

Compile the actual documentation examples (downloads real packages to the normal
NuGet cache, creates and removes a temporary fixture):

```sh
node evals/terminals/qualify-examples.mjs
```

The fixture pins `13.6.0-preview.1.26474.10` from the official `dotnet9` development
feed. The script compiles the resource/dock/manual-prompt/Work-prompt/headless
recipes, plus the resource recipe on 13.5.3. It does not upgrade user projects,
fake public APIs, start an AppHost or prove runtime behavior.

## Qualification recorded for this change

On macOS, the four AppHost recipes compiled against that real 13.6 hosting build.
An isolated disposable fixture, started/stopped via Aspire CLI
`14.0.0-preview.1.26473.9`, additionally exercised:

- Resource PTY readiness, default 132x50 dimensions and owner-aware discovery.
- Dock persistence after the opening command returned, verified by a second
  command successfully waiting for its screen text.
- Headless input/waits and removal of the caller-disposed terminal registration.
- Prompt Work success, borrowed-handle lifetime, cancellation joining Work, and
  process exit not completing a manual prompt.
- Noninteractive resource-command refusal before creating a prompt-owned process.
- Tape input/waits, `.txt` and `.ascii` UTF-8/LF checkpoint separators, empty-tape
  snapshots, no-overwrite rejection and unsupported media preflight before input.
  The resource remained alive after playback and rejected input.

This is a **mixed CLI/hosting preview qualification**, not certification of the
eventual 13.6 CLI release. Re-run with the exact shipping CLI/hosting bundle.
Browser rendering/mobile/keyboard UX, database-client REPL authentication and
TypeScript generated-declaration compilation were not exercised in this runtime
fixture; their guidance is based on the cited upstream source. No production
resources, cloud deployments or shared running AppHosts were modified.

For a release smoke run, copy `app`, `Tool` and `NuGet.config` to a disposable
directory, build Tool, insert the relevant documented recipe in the AppHost,
then use exact-target isolated `aspire start`, `aspire wait worker` and
`aspire resource worker <command>`. Stop that exact AppHost afterward. Do not use
`--force` or run lifecycle tests against an unrelated user's AppHost.
