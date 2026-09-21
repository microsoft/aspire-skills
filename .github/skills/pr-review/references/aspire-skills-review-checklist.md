# aspire-skills review checklist

The repo-specific rules a `pr-review` pass must enforce on PRs into
`microsoft/aspire-skills`. Each row links a check to a default severity. Adjust upward to
`blocking` when correctness or shipped safety is at stake; never use `nit`/`learning`/
`praise` — see [severity-labels.md](severity-labels.md).

> The authoritative repo sources are `CONTRIBUTING.md`, `evals/README.md`, and
> `evals/AUTHORING.md`. This file restates the rules a reviewer must hold in working
> memory and adds the cross-cutting checks that don't live in any single doc.

## 1. SKILL.md frontmatter

For every changed `skills/<skill>/SKILL.md`:

- `name` matches the directory name (`aspire`, `aspire-init`, `aspireify`,
  `aspire-orchestration`, `aspire-deployment`, `aspire-monitoring`).
- `description` is a folded scalar (`>-`) with **all** of:
  - A one-line role statement (e.g., `**WORKFLOW SKILL** — first-run flow...`).
  - A `USE FOR:` list of triggering phrases and Aspire CLI verbs.
  - A `DO NOT USE FOR:` list to prevent cross-skill activation.
  - An `INVOKES:` list naming sibling skills the router hands off to.
  - A `FOR SINGLE OPERATIONS:` shortcut for one-shot tasks where applicable.
- `license: MIT`.
- `metadata.author: Microsoft` and `metadata.version` present.

**Severity if any of the above is missing or regressed:** `important`. **Severity if the
trigger keyword list is silently shortened in a way that will demonstrably break routing
covered by `trigger_tests.yaml`:** `blocking`.

## 2. SKILL.md token budget

`SKILL.md` must stay under **5000 tokens** (per `CONTRIBUTING.md`). Heuristic: ~4 chars
per token, so ~20,000 characters is the soft limit. If a PR pushes a SKILL.md past that:

- Move overflow into `skills/<skill>/references/<topic>.md` and link from SKILL.md.
- Keep decision tables and routing in SKILL.md itself — those are what the agent reads
  on every activation.

**Severity:** `important`. Promote to `blocking` if a SKILL.md balloons past ~8000 tokens
— that's a clear sign progressive disclosure was abandoned.

## 3. Eval coverage

Any behavior, routing, or guardrail change in a skill **must** ship with matching evals:

- A new behavior gets a new `skills/<skill>/evals/tasks/<id>.yaml` with the `id`, `name`,
  `description`, `tags` (priority + topical), `inputs`, `expected`, and `graders` per
  `evals/AUTHORING.md`.
- A routing change (anything that affects the SKILL.md `description` keywords) gets
  matching adds/edits in `skills/<skill>/evals/trigger_tests.yaml` — and a prompt added
  to one skill's `should_trigger_prompts` should appear in `should_not_trigger_prompts`
  of every sibling that might claim it.
- A bug fix or guardrail tightening adds a regression task tagged with the
  `issue-NNNNN` / `known-bug` tag if applicable.

**Severity if no eval added:** `important`. **Severity if a routing change with no
trigger-test update is likely to drop accuracy below the per-skill threshold:** `blocking`.

## 4. Grader patterns

From `evals/AUTHORING.md`:

- Every `prompt` grader prompt **starts with or includes** the phrase "the assistant's
  response" so the judge evaluates the response, not the workspace files.
- Positive and negative checks are **split** — one `prompt` grader for intent + one
  `text` `not_contains` grader for forbidden patterns. No combined "do X but not Y" in
  one grader.
- `not_contains` lists use full command tokens (e.g., `"azd up"`, `"azd deploy"`), never
  bare nouns (`"azd"`, `"docker"`, `"kubectl"`, `"helm"`) — bare nouns fire on legitimate
  "do not use X" guidance.
- Aspire 13.5.3 facts the judge might not know are **stated in the grader prompt**.

**Severity:** `important` — these patterns are the difference between a useful eval and
one that mis-judges correct responses.

## 5. Fixtures

Eval tasks must reference the shared fixtures at repo-root `evals/`:

- `evals/csharp-apphost/` for C# AppHost scenarios.
- `evals/ts-apphost/` for TypeScript AppHost scenarios.
- `evals/non-aspire/` for "should not trigger" scenarios.

**Severity if a PR introduces per-skill fixture copies:** `important`. The shared
baseline exists so that cross-skill behavior is measured against the same project.

## 6. Plugin manifest version sync

Six canonical JSON files and all shipped skill metadata share a version. Release
preparation bumps them together only for shipped-content changes; ordinary feature
PRs keep them synchronized without needing a bump:

| File | Field |
|------|-------|
| `package.json` | `version` |
| `.plugin/plugin.json` | `version` |
| `.claude-plugin/plugin.json` | `version` |
| `.claude-plugin/marketplace.json` | `version` of the plugin named `aspire` |
| `.cursor-plugin/marketplace.json` | `version` of the plugin named `aspire` |
| `gemini-extension.json` | `version` |
| `skills/<name>/SKILL.md` | `metadata.version` |

The `.github/plugins/aspire-skills/` mirrors remain symlinks to these manifests.
For shipped-content changes, preparation versions must advance main's released
version and must not lower dev's version. A corrected preparation may reuse an
unpromoted version on dev. Repository-only releases keep main's version.
Preparation changes only version scalar tokens in selected JSON/skill sources;
promotion preserves the prepared versions and all other source bytes.

**Severity if versions are out of sync or preparation omits a required product
version bump:** `blocking`. Ordinary feature PRs do not need a bump.

## 7. CHANGELOG

Development PRs target `dev`, which retains `CHANGELOG.md` but excludes root
`opencode/`. Ordinary PRs leave the changelog unchanged from their dev base.
Use descriptive commit subjects and PR context for user-visible changes:

- New skill, removed skill, renamed skill.
- Safety-guardrail change (added, removed, or scope changed).
- New CLI command surface routed (e.g., adding `aspire destroy` mapping).
- New deployment target.
- New eval tag or new fixture.

`prepare-release/<version>` PRs into dev update aligned versions and the generated
changelog, preserving main's released history. Require exact validation against
the selected dev baseline and current main. Maintainers may add commits editing
the regular root `README.md` on the preparation branch. Other source edits belong
on dev and require new preparation; versions and changelog remain workflow-owned.

Merge preparation with a merge commit. Promote Release starts automatically for
that exact reviewed merge without waiting for post-merge CI. It uses trusted main
tooling and preserves every prepared source byte, including README, versions,
and changelog, while adding catalogs.

Promotion opens a generated `release/<version>` draft PR into main. Require
review and passing checks, then merge with a merge commit to preserve ancestry.
The bot publishes branches and opens PRs; it does not bypass main protections,
update main directly, force-push, or auto-merge either PR.

**Severity for invalid release provenance or changes outside the stage's
permitted files:** `blocking`. Unclear release-note source text is `important`.

## 8. Project-local override pattern

Every skill's SKILL.md contains a "Project-Local Skill Override" section that defers to
`.agents/skills/<skill>/SKILL.md` when present (installed by `aspire agent init` /
`aspire init`). This pattern **must survive** edits — the in-plugin skill must
never silently shadow the project-local copy.

**Severity if a PR removes or weakens the deference:** `blocking`. The plugin's safety
guardrails apply even when project-local skills are active, but everything else defers.

## 9. Safety guardrails

The core safety rules from `README.md` and the `aspire` router must remain enforced in
the relevant skills (mainly `aspire-orchestration`):

| Instead of | Use | Why |
|------------|-----|-----|
| `dotnet run` | `aspire start` | Starts the full orchestrator |
| `curl` polling | `aspire wait <resource>` | Waits for actual readiness |
| `dotnet build` (while running) | `aspire resource <name> restart` | Avoids file-lock errors |
| Leaving processes running | `aspire stop` | Prevents orphaned DCP/dashboard processes |

Plus the rules from `skills/aspire/SKILL.md`:

- `--non-interactive` on every agent-facing CLI snippet.
- Never install the obsolete Aspire workload.
- Never edit `.aspire/modules/` directly in TypeScript AppHosts.

**Severity if any guardrail is removed or weakened without a documented reason:**
`blocking`.

## 10. Reference-folder hygiene

Per `CONTRIBUTING.md`, overflow content lives in `skills/<skill>/references/`. When a PR
adds a new reference file:

- It is linked from `SKILL.md` (no orphan files).
- It is focused on one topic — don't recreate the whole SKILL.md inside a reference.
- It stays under ~5000 tokens itself; spill further if needed.
- It cites authoritative sources (Aspire docs, CLI help output, GitHub issues / PRs).

**Severity:** `suggestion` unless the new file is unlinked, which is `important`.

## 11. MCP

- `.mcp.json` changes need a descriptive commit subject **and** a quick
  scan for shell-injection or path-traversal risk in any new shell snippet.
- New MCP commands must use `--non-interactive` on Aspire CLI calls and must not
  swallow errors.

**Severity:** `important`; `blocking` for any unsanitized shell snippet or missing error
propagation.

## 12. Cross-cutting: what the agent will actually do

A SKILL.md isn't a doc — it's an instruction set the agent reads on every activation.
Two questions to ask on every change:

1. **"Will the agent change its behavior in the right direction because of this edit?"**
   If you can't answer "yes, in this concrete scenario," the edit is probably noise.
2. **"Could a stale or imprecise phrase here cause the agent to ignore a guardrail or
   misroute a request?"** If yes, fix the phrasing before approving.

These are the questions Phase 2 of the review workflow exists to answer.

## Quick-scan order

When time-boxed, walk the checks in this order — they catch the highest-impact issues
first:

1. Safety guardrails (§9).
2. Project-local override (§8).
3. Plugin manifest version sync (§6).
4. Eval coverage (§3) + grader patterns (§4).
5. SKILL.md frontmatter (§1) + token budget (§2).
6. Fixtures (§5).
7. CHANGELOG (§7).
8. MCP (§11).
9. References hygiene (§10).
