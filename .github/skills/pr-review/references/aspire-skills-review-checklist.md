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
- Release-specific Aspire facts the judge might not know are **stated in the grader prompt**.

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

Six canonical JSON files, both lockfile root versions, and all seven shipped
skills share one version within a branch. Check them together whenever release
versions change. Ordinary feature and release-fix PRs preserve dev's current version:

Dedicated `bump-dev/<version>` PRs advance dev's coordinated version, add its
changelog heading, and regenerate catalogs. They preserve source and existing
changelog entries.

| File | Field |
|------|-------|
| `package.json` | `version` |
| `package-lock.json` | `version` and `packages[""].version` |
| `.plugin/plugin.json` | `version` |
| `.claude-plugin/plugin.json` | `version` |
| `.claude-plugin/marketplace.json` | `version` of the plugin named `aspire` |
| `.cursor-plugin/marketplace.json` | `version` of the plugin named `aspire` |
| `gemini-extension.json` | `version` |
| `skills/<name>/SKILL.md` | `metadata.version` |

The shipped skills are `aspire`, `aspire-init`, `aspireify`,
`aspire-project-v2-migration`, `aspire-orchestration`, `aspire-deployment`, and
`aspire-monitoring`. Their versions match the plugin release; do not require
independent per-skill bumps. Select the `aspire` marketplace entry by name;
unrelated catalog entries can have independent versions. Documentation-only
corrections do not require a new release version.

Plugin manifests and runtime skill/extension files under
`.github/plugins/aspire-skills/` remain relative symlinks to the root sources.
Review changes against those sources rather than treating the mirror as another
version authority. Internal author skills under `.github/skills/` are not part of
the shipped skill set.

**Severity for version skew or unrelated manifest edits:** `blocking`.

## 7. CHANGELOG

For release PRs, compare the previous published tag with the release branch.
The new entry must cover user-visible changes since that tag, not features
already shipped.

User-visible changes need a `CHANGELOG.md` entry under the appropriate version heading:

- New skill, removed skill, renamed skill.
- Safety-guardrail change (added, removed, or scope changed).
- New CLI command surface routed (e.g., adding `aspire destroy` mapping).
- New deployment target.

Pure refactors, doc fixes, and eval-only additions that don't change the shipped surface
don't need a CHANGELOG entry — but call them out in the PR description.
Keep version-bump housekeeping, repository inventory metadata, and test-only
changes out of release notes.

Release headings use Git tag links, not dates or `Unreleased`. Display versions
without a `v` prefix, but keep the actual tag name in the link target, for example
`## [0.0.4](https://github.com/microsoft/aspire-skills/releases/tag/v0.0.4)`.
Preserve historical release note bodies when updating headings or references.

Dev PRs keep the current version's `CHANGELOG.md` entry up to date as changes
land, preserving earlier entries. Version-bump PRs add the next version's
heading; `release/<version>` PRs finalize the notes for the selected snapshot.

**Severity:** `important`.

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

- `.mcp.json` changes need a CHANGELOG note **and** a quick
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

## 13. Release preparation and publication

Apply section 7 and the [development guide](../../../../docs/development.md).
For a release PR, verify:

- `release/<version>` starts at the selected dev commit, records that SHA and
  deliberate backports, and targets main. Coordinated versions match the branch
  and are newer than main's version. The Release branch check passes.
- Changelog notes are finalized in nonempty Changed, Removed, and Added sections,
  in that order, omitting empty sections and preserving published history.
- Committed V1 and V2 catalogs match the shipped source. Dev retains these
  catalogs too; regenerate them whenever shipped source changes.
- Tests, bundle builds and attestations, skills-only upload, and required checks
  agree. Distinguish local evidence from CI results.
- Maintainer approval and merge authorize the publisher to tag the exact merged
  main commit and publish matching changelog notes. Reruns preserve that tag and
  those notes; no manual tag step or token-triggered follow-up job is needed.

Backflow starts from current dev and merges main. Keep dev's next version,
current changelog notes, and newer work, including non-version manifest changes;
bring in main's approved changelog history and regenerate catalogs. Target dev
and merge with a merge commit, not squash or rebase.

**Severity:** `important` for inaccurate guidance or missing validation evidence;
`blocking` for source/version mismatches or publication of unapproved code.

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
8. Release preparation and publication (§13).
9. MCP (§11).
10. References hygiene (§10).
