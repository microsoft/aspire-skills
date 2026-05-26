# Severity labels

`pr-review` for `microsoft/aspire-skills` uses **only three** severity labels:

- `blocking`
- `important`
- `suggestion`

We deliberately do **not** use `nit`, `learning`, or `praise`. The justification is below
— if you find yourself reaching for one of those, the finding probably doesn't belong in
the review at all.

## `blocking`

A finding is `blocking` when **shipping the PR as-is would cause concrete harm** that
the author would want to know about before merge.

Use `blocking` when the PR…

- Removes or weakens a documented safety guardrail (e.g., the `dotnet run` →
  `aspire start` mapping disappears from `skills/aspire-orchestration/SKILL.md`).
- Leaves the four plugin manifests out of version sync (see
  `aspire-skills-review-checklist.md` §6).
- Drops or shadows the project-local override deference block (`§8`).
- Introduces a routing change with no `trigger_tests.yaml` update **and** the change is
  likely to drop accuracy below the per-skill threshold.
- Adds a shell snippet to a hook that has unsanitized variable expansion or swallows
  errors.
- Edits `.aspire/modules/` directly in a TypeScript AppHost example.
- Surfaces an Aspire CLI command without `--non-interactive` in an agent-facing context.
- Breaks valid JSON / YAML in a manifest or eval file.

`blocking` findings drive a `REQUEST_CHANGES` recommendation.

## `important`

A finding is `important` when **the PR is correct but a quality, coverage, or
maintainability obligation is unmet**, and resolving it has a clear path.

Use `important` when the PR…

- Changes skill behavior without adding or updating an eval task.
- Adds new routing keywords without `trigger_tests.yaml` coverage (and the change is
  unlikely to immediately break thresholds — but you still want the coverage).
- Has a SKILL.md frontmatter `INVOKES:` list that lies about what the skill calls.
- Pushes SKILL.md past the 5000-token authoring budget without splitting into
  `references/`.
- Bumps no plugin version on a user-visible change (even if all four manifests agree at
  the current value).
- Lacks a CHANGELOG entry for a user-visible change.
- Uses a bare `not_contains` substring (e.g., `"azd"`) instead of full command tokens.
- Omits the "the assistant's response" anchor in a `prompt` grader.
- Copies fixtures per-skill instead of reusing the shared `evals/` baseline.

`important` findings drive a `COMMENT` recommendation (or `REQUEST_CHANGES` if the
author wants the strict gate). The default is `COMMENT` with the expectation that the
author will address them or open a follow-up.

## `suggestion`

A finding is `suggestion` when **the PR is fine to merge but you have an improvement
the author might appreciate**.

Use `suggestion` when the PR…

- Has a decision-table row that would be sharper with a current Aspire alternative called out.
- Has a reference file that's growing toward the token budget and would benefit from a
  split.
- Could reuse an existing fixture instead of introducing a near-duplicate.
- Has a quick-reference table whose order could surface the hot path first.
- Includes a CLI example that's correct but where a shorter form exists.

`suggestion` findings never drive `REQUEST_CHANGES`. They surface as `COMMENT` or
`APPROVE`-with-comments.

## Why we don't use `nit` / `learning` / `praise`

### No `nit`

Nits are noise. If a finding only matters at the level of "the comma should be a
semicolon", drop it. The author can spot that themselves on re-read; surfacing it
dilutes the signal of the real findings. Linters cover the cases that need to be
mechanical.

### No `learning`

"Learning" comments belong in pairing sessions, design docs, or chat — not in PR review.
Reviews should answer "is this safe to merge?", not "is there an interesting detour
worth explaining?". If you have a teaching point that doesn't tie to a concrete review
finding, send it as a follow-up note.

### No `praise`

Praise is appropriate in person, in stand-up, or in a release announcement. Adding
`praise` comments to a PR review pads the comment count and makes it harder for the
author to scan for what's actionable. Approve the PR; tell the author you liked it in a
direct message.

## Summary table

| Label | When | Recommendation |
|-------|------|----------------|
| `blocking` | Concrete harm if merged as-is. | `REQUEST_CHANGES` |
| `important` | Coverage / quality obligation unmet; clear fix exists. | `COMMENT` (or `REQUEST_CHANGES` if strict gate). |
| `suggestion` | Optional improvement; author can take or leave. | `COMMENT` or `APPROVE`. |

## Calibration check

If you're not sure which label to apply, ask yourself:

1. *"If this merges unchanged, will an agent or a downstream consumer behave wrong?"*
   - Yes → `blocking`.
2. *"If this merges unchanged, will the next reviewer or release have to clean it up?"*
   - Yes → `important`.
3. *"Could the author land this and the repo would still be in a healthy state?"*
   - Yes → `suggestion` (or drop).

If the answer to all three is "no", **drop the finding**. A short, focused review is a
better review.
