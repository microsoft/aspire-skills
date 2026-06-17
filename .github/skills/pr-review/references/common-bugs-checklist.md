# Common-bugs checklist

> **Adapted from [`awesome-skills/code-review-skill`](https://github.com/awesome-skills/code-review-skill/blob/main/reference/common-bugs-checklist.md)
> (MIT-licensed).** Pruned to the stacks actually used in `microsoft/aspire-skills`:
> YAML (evals), Markdown (SKILL.md), JSON (manifests, MCP), TypeScript (AppHost
> snippets), C# / .NET (AppHost snippets), and Shell/CLI. Vue/Svelte/
> Kotlin/Qt and the like are intentionally omitted.

Use this list during **Phase 4 — Bug scan** of the review workflow. For each touched
file type, walk the matching section.

---

## Universal issues

### Logic

- Off-by-one in loops, ranges, or slicing.
- Incorrect boolean logic — De Morgan flips, double-negatives, conflated `and`/`or`.
- Missing null / undefined / empty checks (e.g., `if (resource)` vs `if (resource != null)`).
- Race conditions in any async / concurrent code path.
- Wrong comparison operator (`==` vs `===`, `=` vs `==`).
- Integer over/underflow, especially in size calculations.
- Floating-point equality without tolerance.

### Resource management

- Open file / stream / process never closed.
- Event listeners never removed.
- Timers / intervals never cleared.
- Spawned processes never reaped (especially relevant to Aspire safety guardrails —
  `aspire stop` must run).

### Error handling

- Swallowed exceptions (empty `catch`, `catch (e) {}`).
- Generic `catch (Exception)` that hides the specific failure.
- Missing error propagation up the call stack.
- Wrong exception type thrown — leaks an implementation detail.
- Missing cleanup in `finally` / `using` / `defer`.

---

## YAML — evals (`skills/<skill>/evals/**/*.yaml`)

The vast majority of YAML in this repo is eval task files. The rules from
`evals/AUTHORING.md` apply; this checklist surfaces the bug shapes those rules prevent.

- [ ] `id` field is unique within the skill (used by `--task` glob).
- [ ] `id` follows the `<skill-prefix>-<area>-<NNN>` convention (e.g.,
      `deploy-destroy-001`, `mon-bridge-001`).
- [ ] `tags` includes a priority (`p0` / `p1`) **and** at least one topical tag.
- [ ] `inputs.files[].path` resolves under `evals/` (the context dir) — fixtures live in
      the shared `evals/{csharp-apphost,ts-apphost,non-aspire}` trees, **not** in per-skill
      fixture folders.
- [ ] `expected.output_not_contains` uses full command tokens, not bare nouns (`"azd up"`,
      not `"azd"`).
- [ ] Every `graders[].config.prompt` for a `prompt` grader mentions "the assistant's
      response".
- [ ] Combined positive + negative graders are split into a `prompt` + `text` pair.
- [ ] Aspire 13.4 facts the judge might not know are stated in-grader.
- [ ] No YAML duplicate keys; folded scalars (`>` / `>-`) are used for multi-line prose.
- [ ] No tabs (YAML doesn't accept them); indentation is consistent (2 spaces).
- [ ] String fields aren't accidentally booleans (`yes`, `no`, `on`, `off`, `true`,
      `false` get coerced — quote them).

### `trigger_tests.yaml`

- [ ] A prompt doesn't appear in both `should_trigger_prompts` and
      `should_not_trigger_prompts` for the same skill.
- [ ] A prompt under `should_not_trigger_prompts` with a reason saying "should trigger
      this skill" is a misclassification — fix it.
- [ ] `confidence` is `high` / `medium` / `low`; mass `high` is a smell — be honest.
- [ ] Phrased like a real user, not like a spec ("Tear down my Aspire deployment", not
      "Invoke aspire destroy").

---

## Markdown — SKILL.md and references

SKILL.md files are instruction sets the agent reads on every activation. Bugs here cause
routing failures and silently degraded agent behavior.

- [ ] Frontmatter `description` is a folded scalar (`>-`) with no surprising line breaks
      mid-keyword (`aspire st\nart` will not be matched).
- [ ] Trigger keyword lists (`USE FOR:` / `DO NOT USE FOR:`) are still comprehensive —
      keyword shrinkage is the #1 cause of routing regressions.
- [ ] Decision tables (`| Signal | How to detect | ... |`) have consistent column counts
      across rows (one extra `|` will silently break Markdown rendering).
- [ ] Cross-skill links (`../aspireify/SKILL.md`) resolve — `../<wrong-name>/SKILL.md`
      will silently render but never open.
- [ ] Backticks around command names (`` `aspire start` ``) so the agent doesn't
      paraphrase them.
- [ ] No mixing of `aspire` and `azd` mid-paragraph (`azd` is forbidden in this repo's
      guidance — confirm context).
- [ ] No stale references to Aspire ≤13.2 surfaces (`aspire publish manifest`,
      removed deployment templates, etc.) — see
      `skills/aspire/references/aspire-13-3-breaking-changes.md`.
- [ ] No `dotnet new aspire-*` templates (removed in 13.3 in favor of `aspire new`).
- [ ] CLI snippets include `--non-interactive` for agent-facing flows.
- [ ] TypeScript AppHost snippets do not edit `.aspire/modules/`.

---

## JSON — manifests and MCP

Files: `.plugin/plugin.json`, `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`, `gemini-extension.json`, `.mcp.json`.

- [ ] Valid JSON (no trailing commas, no comments — these silently break some loaders).
- [ ] `version` fields are consistent across all four plugin manifests (see
      `aspire-skills-review-checklist.md` §6).
- [ ] `name`, `description`, `repository`, `homepage`, `license` match across manifests.
- [ ] `keywords` and `tags` lists don't diverge — divergence confuses marketplace
      indexing.
- [ ] `skills` glob in `.plugin/plugin.json` and `.claude-plugin/plugin.json` is still
      `./skills/` (never `./.github/skills/` — author skills must stay invisible to the
      published plugin).
- [ ] `mcpServers` paths are correct relative paths.
- [ ] No secrets, tokens, or environment-specific paths committed.

---

## TypeScript (for `apphost.ts` snippets and TS examples in references)

- [ ] `==` is not used — use `===`.
- [ ] No `any` — prefer `unknown` with type guards.
- [ ] No missing `await` on async APIs (especially `aspire` SDK calls).
- [ ] No unhandled promise rejections — every `await` is inside a `try` / `catch` or has
      a documented top-level handler.
- [ ] No `this` capture mistakes in callbacks.
- [ ] No closure-captured stale loop variables (use `let` not `var`).
- [ ] No mutation of arrays / objects while iterating.
- [ ] `parseInt` has an explicit radix.
- [ ] `apphost.ts` snippets do **not** show edits to `.aspire/modules/` — that folder is
      generated by `aspire add`.
- [ ] Uses the unified `withEnvironment` API (deprecation of `withEnvironment*` in 13.3).

---

## C# / .NET (for `apphost.cs`, `.csproj`, and C# examples in references)

- [ ] `.csproj` for an AppHost references `Aspire.AppHost.Sdk` — not a hand-rolled SDK.
- [ ] File-based `apphost.cs` uses `#:sdk Aspire.AppHost.Sdk` and `#:package` directives,
      no `.csproj` companion.
- [ ] `using` / `IDisposable` / `IAsyncDisposable` patterns properly close resources.
- [ ] `async` methods are awaited; `async void` is only used in event handlers.
- [ ] `string` comparison uses the right `StringComparison` overload.
- [ ] `ConfigureAwait(false)` decisions are deliberate, not cargo-culted.
- [ ] `AddNextJsApp`, `WithBrowserLogs()`, `ExcludeReferenceEndpoint`, and other current Aspire
      APIs are spelled exactly — typos here silently fall through to base overloads.
- [ ] `NameOutputReference` (not the renamed-away `NameOutput`).
- [ ] No `AddAndPublishPromptAgent` (removed in 13.3) — use `AddPromptAgent`.

---

## Shell / CLI snippets

Anywhere shell appears (SKILL.md examples, README, eval prompts):

- [ ] Quoted variables to handle spaces and globs (`"$path"`, not `$path`).
- [ ] `set -euo pipefail` (or PowerShell `$ErrorActionPreference = 'Stop'`) on
      non-trivial scripts.
- [ ] No `&&` chaining for steps that should run independently with their own error
      handling.
- [ ] Aspire commands use `--non-interactive`.
- [ ] No `dotnet run` on an AppHost.
- [ ] No `curl` polling — use `aspire wait <resource>`.
- [ ] No `dotnet build` while Aspire is running — use `aspire resource <name> restart`.
- [ ] `aspire stop` appears at the end of any "start, do work, stop" example.

---

## SQL (for any DB-related skill content, e.g., `WithPostgres` examples)

- [ ] No string concatenation for queries — parameterize.
- [ ] No `SELECT *` in examples — name the columns.
- [ ] `NULL` comparisons use `IS NULL` / `IS NOT NULL`.
- [ ] Transactions wrap related writes.
- [ ] `LIMIT` is present on examples that scan large tables.

---

## Testing (for evals and any test-shaped fixtures)

- [ ] Tests target user-visible behavior, not implementation details.
- [ ] Edge cases are covered (empty inputs, missing fields, large inputs).
- [ ] No flaky / non-deterministic tests (e.g., wall-clock-dependent without freezing
      time).
- [ ] No external dependencies in eval task fixtures — everything lives under
      `evals/` so the suite is hermetic.

---

## API design (for any new CLI / hook surface in this repo)

- [ ] Consistent naming with the rest of the Aspire CLI (`aspire <verb> <noun>`).
- [ ] Correct exit codes — `0` for success, non-zero for failures.
- [ ] Help text mentions `--non-interactive` for agent-facing flows.
- [ ] No client-side-only validation that the server (or agent) is also relying on.

---

## When to escalate from this checklist

If you find a class of bug that isn't covered here but recurs across PRs, **add a row**
in a follow-up PR. This file should evolve as new patterns emerge — that's how it stays
useful.
