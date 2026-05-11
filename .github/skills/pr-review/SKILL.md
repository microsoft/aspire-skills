---
name: pr-review
description: >-
  **AUTHOR SKILL (internal to microsoft/aspire-skills).** Reviews pull requests *into this
  repo* with repo-aware rigor: eval coverage for changed skills, SKILL.md frontmatter and
  token-budget compliance, fixture reuse, trigger-test coverage, version sync across the
  four plugin manifests, CHANGELOG entries, project-local override preservation, and
  safety-guardrail preservation. Then layers in general code-review best practices and a
  common-bugs scan.
  USE FOR: review this PR, review the current branch, gh pr view, gh pr diff, "what should
  I check before merging", PR review of changes to skills/, evals/, hooks/, .plugin/,
  .claude-plugin/, gemini-extension.json, CHANGELOG.md, copilot-hooks.json.
  DO NOT USE FOR: reviewing application code in *consumer* Aspire projects (this skill is
  scoped to microsoft/aspire-skills authoring); end-user Aspire workflows (use the shipped
  `aspire` router and its sub-skills); generic code review on unrelated repos.
  REFERENCES: aspire-skills-review-checklist.md, code-review-best-practices.md,
  common-bugs-checklist.md, severity-labels.md.
license: MIT
metadata:
  author: Microsoft
  version: "1.0.0"
  audience: repo-authors
---

# pr-review

> **Internal author skill.** Lives under `.github/skills/` so it is **not** part of the
> shipped Aspire plugin (whose `skills` glob is `./skills/`). Use this when reviewing PRs
> opened against `microsoft/aspire-skills`.

## When to activate

| Signal | Activate? |
|--------|-----------|
| User says "review this PR", "review the current branch", or "check before merge" | ✅ Yes |
| `gh pr view` / `gh pr diff` / GitHub PR URL in conversation | ✅ Yes |
| Working directory is `microsoft/aspire-skills` and there is a non-empty diff vs `main` | ✅ Yes |
| User asks to review code in a *consumer* Aspire app | ❌ No — defer to the user's normal review flow |
| User asks for runtime help with `aspire` CLI | ❌ No — route to the shipped `aspire` skill |

If you activate, immediately load the four reference files into your working memory:

1. [references/aspire-skills-review-checklist.md](references/aspire-skills-review-checklist.md) — repo-specific rules.
2. [references/code-review-best-practices.md](references/code-review-best-practices.md) — review philosophy & prioritization.
3. [references/common-bugs-checklist.md](references/common-bugs-checklist.md) — bug-pattern scan.
4. [references/severity-labels.md](references/severity-labels.md) — `blocking` / `important` / `suggestion` only.

## Review workflow (four phases)

Run the phases **in order**. Stop after Phase 2 only if you find a `blocking` issue that
makes deeper review wasteful (e.g., the PR removes a safety guardrail).

| # | Phase | Goal | Time box |
|---|-------|------|----------|
| 1 | **Scope** | Understand intent: read PR title, description, linked issues, CI status, and the file-change overview. | ~5 min |
| 2 | **Repo-specific checks** | Apply [aspire-skills-review-checklist.md](references/aspire-skills-review-checklist.md) — evals, frontmatter, fixtures, version sync, CHANGELOG, project-local overrides, safety guardrails. | 10–20 min |
| 3 | **General best practices** | Apply [code-review-best-practices.md](references/code-review-best-practices.md) — clarity, maintainability, scope discipline, tone of feedback. | 10–15 min |
| 4 | **Bug scan** | Walk the relevant sections of [common-bugs-checklist.md](references/common-bugs-checklist.md) for files touched (YAML for evals, Markdown for SKILL.md, TS for `apphost.ts` snippets, C# for `apphost.cs`/.csproj). | 5–15 min |

## Repo-specific must-checks (summary)

Every finding below has detail in [references/aspire-skills-review-checklist.md](references/aspire-skills-review-checklist.md).

| Area | Quick check | Default severity if missing |
|------|-------------|-----------------------------|
| **Eval coverage** | Skill behavior or routing changed → new/updated task in `skills/<skill>/evals/tasks/` and matching `trigger_tests.yaml` entries. | `important` |
| **Frontmatter** | `name`, `description`, `license`, `metadata.author`, `metadata.version` all present; description includes `USE FOR` and `DO NOT USE FOR`; INVOKES list accurate. | `important` |
| **Token budget** | `SKILL.md` < 5000 tokens (per `CONTRIBUTING.md`); spill into `references/` if not. | `important` |
| **Fixtures** | New eval tasks reference shared `evals/{csharp-apphost,ts-apphost,non-aspire}` rather than per-skill copies. | `important` |
| **Grader patterns** | `prompt` graders mention "the assistant's response"; positive/negative graders split; `not_contains` uses full command tokens, not bare nouns. | `important` |
| **Version sync** | Plugin version bumped consistently across `.plugin/plugin.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `gemini-extension.json`. | `blocking` if a manifest is out of sync |
| **CHANGELOG** | User-visible behavior change → entry in `CHANGELOG.md`. | `important` |
| **Project-local override** | The "defer to `.agents/skills/<skill>/SKILL.md`" block must survive edits — don't let the in-plugin skill silently shadow project-local ones. | `blocking` |
| **Safety guardrails** | The `dotnet run` → `aspire start`, `curl` → `aspire wait`, `dotnet build` → `aspire resource restart`, `aspire stop` rules must remain enforced. | `blocking` |
| **`--non-interactive`** | Any new agent-facing CLI snippet uses `--non-interactive`. | `important` |
| **`.modules/` edits** | TS AppHost changes must not edit `.modules/` directly. | `blocking` |

## Severity labels (only three)

| Label | Use for | Example |
|-------|---------|---------|
| `blocking` | Must fix before merge — correctness, safety, or regression in shipped behavior. | Removes the "never `dotnet run`" guardrail; manifests disagree on plugin version. |
| `important` | Should fix before merge — quality, coverage, or maintainability gap with a clear path to resolution. | New routing added without corresponding `trigger_tests.yaml` entries. |
| `suggestion` | Optional improvement — clearer phrasing, lower-friction wording, broader applicability. | Decision-table row could call out the 13.3 alternative. |

We **do not** use `nit`, `learning`, or `praise`. If a finding is small enough to feel
like a nit, drop it — reviews should focus on what matters most. See
[references/severity-labels.md](references/severity-labels.md) for the rationale and more
examples.

## How to deliver findings

For each finding, give the reviewer / author:

1. **File and line** (path + line number, or a stable anchor for SKILL.md sections).
2. **Severity** — `blocking` / `important` / `suggestion`.
3. **Observation** — one sentence on what's wrong.
4. **Why it matters** — the concrete consequence (broken routing, eval regression, etc.).
5. **Suggested fix** — actionable; cite the rule from the relevant reference file.

Use collaborative phrasing — questions over commands, suggestions over mandates. See
[code-review-best-practices.md → Communication Guidelines](references/code-review-best-practices.md#communication-guidelines).

## Output shape

End the review with a short summary:

```
Severity counts: blocking=N, important=N, suggestion=N
Recommendation: REQUEST_CHANGES | APPROVE | COMMENT
Top three things to address:
  1. ...
  2. ...
  3. ...
```

`REQUEST_CHANGES` if any `blocking`. `APPROVE` if zero `blocking` and zero `important`.
`COMMENT` in between — call it out and let the author decide what to land vs defer.

## Error handling

| Symptom | Cause | Action |
|---------|-------|--------|
| Can't tell what changed | No PR description, no linked issue | Ask the author to expand the description before reviewing; don't guess intent. |
| Eval task added but not registered | `tasks/*.yaml` glob already covers it; just confirm | Run `waza check skills/<skill>` from `evals/README.md` mentally — not a finding. |
| Plugin version unchanged on behavior change | Author forgot to bump | `blocking` if any manifest is out of sync; `important` if all four match but the bump itself is missing. |
| Frontmatter changed but description regressed | Routing keywords stripped | `important` — point to the original keyword list and `trigger_tests.yaml`. |
| New reference file > 5000 tokens | Too much in one file | `suggestion` — split into focused references. |

## References

- [aspire-skills-review-checklist.md](references/aspire-skills-review-checklist.md) — the repo-specific rule book.
- [code-review-best-practices.md](references/code-review-best-practices.md) — adapted from `awesome-skills/code-review-skill` (MIT).
- [common-bugs-checklist.md](references/common-bugs-checklist.md) — adapted from `awesome-skills/code-review-skill` (MIT); pruned to the stacks this repo actually uses.
- [severity-labels.md](references/severity-labels.md) — the three-label scheme this skill uses.
