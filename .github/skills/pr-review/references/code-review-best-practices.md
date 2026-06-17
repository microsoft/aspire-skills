# Code-review best practices

> **Adapted from [`awesome-skills/code-review-skill`](https://github.com/awesome-skills/code-review-skill/blob/main/reference/code-review-best-practices.md)
> (MIT-licensed).** Trimmed to the practices that apply to PRs in
> `microsoft/aspire-skills` and supplemented with concrete examples drawn from this repo.

## Review philosophy

### Goals

- Catch correctness, safety, and regression issues before they ship to plugin consumers.
- Keep SKILL.md instruction sets crisp — they are what the agent reads on every
  activation, not docs the user reads once.
- Keep evals trustworthy — they're the only automated signal we have that a SKILL.md
  edit didn't drift.
- Share knowledge across the small set of authors via specific, actionable comments.

### What review is *not*

- A gatekeeping ritual. If you can't articulate the consequence of a finding, leave it
  out.
- A style audit. Linters and formatters cover style; this review covers behavior.
- A place to rewrite the author's prose to your taste. If the agent will route correctly,
  the phrasing is fine.

## Review depth

Pick the depth from the change surface, not the line count.

| Surface touched | Depth |
|-----------------|-------|
| Only `CHANGELOG.md`, `README.md`, or `CONTRIBUTING.md` | Skim — confirm consistency, no behavior claims that contradict the SKILL.md. |
| Only `evals/` or `skills/<skill>/evals/` | Standard — apply `evals/AUTHORING.md` grader patterns; confirm fixtures are shared. |
| `skills/<skill>/SKILL.md` or its `references/` | Standard+ — apply [aspire-skills-review-checklist.md](aspire-skills-review-checklist.md) §1–§5 and §10. |
| `.plugin/plugin.json` / `.claude-plugin/*.json` / `gemini-extension.json` | Deep — version sync, manifest consistency, marketplace metadata. |

## Communication

### Tone

Use collaborative phrasing. The author is on the same team; the goal is the right
behavior in the agent, not a rhetorical victory.

- "What do you think about pulling this paragraph into a reference file?" rather than
  "This needs to be moved out."
- "Could we add `trigger_tests.yaml` coverage for this new keyword?" rather than "You
  forgot the trigger test."
- "Is `aspire-13-3` still the right tag here, or has this rolled into a 13.4 surface?"
  rather than "Wrong tag."

### Be specific and actionable

- Quote the exact line or path you're commenting on.
- Cite the rule from `aspire-skills-review-checklist.md` (e.g., "§6 version sync").
- Show, don't tell — paste the corrected snippet when it's short enough.
- Link to the upstream Aspire doc, GitHub issue, or PR when the rationale isn't obvious.

### Handling disagreements

1. Seek to understand — ask the author what they tried and why this landed.
2. Acknowledge valid points before pushing back.
3. Bring data — eval results, `vally` runs, doc citations.
4. Escalate to the CODEOWNER when stuck.
5. Know when to let go — not every disagreement is worth blocking on. If neither side
   can articulate a concrete harm, default to the author's preference.

## Prioritization (maps to the three-label scheme)

| Tier | Label | Examples in this repo |
|------|-------|------------------------|
| Must fix | `blocking` | Removed safety guardrail; plugin manifest version out of sync; project-local override deference removed; unsanitized hook command. |
| Should fix | `important` | New routing without `trigger_tests.yaml` coverage; new eval task missing the "the assistant's response" anchor; SKILL.md frontmatter `INVOKES:` is stale; CHANGELOG entry missing for a user-visible change. |
| Nice to have | `suggestion` | Decision-table row could call out a current Aspire alternative; reference file could be split for focus; quick-reference table could be reordered for scan-ability. |

If a finding doesn't fit one of those three tiers, **drop it**. We deliberately do not
use `nit`, `learning`, or `praise` (see [severity-labels.md](severity-labels.md)).

## Anti-patterns to avoid

### Reviewer anti-patterns

- **Rubber-stamping** — approving a SKILL.md edit without rereading the
  description/`USE FOR` list. The description *is* the routing surface.
- **Bike-shedding** — debating the exact wording of a decision table when both
  variants route the same. Move on.
- **Scope creep** — "While you're at it, can you also add Helm engine notes?" If it's
  not on the PR's stated scope, file a follow-up issue.
- **Ghosting** — requesting changes and then not re-reviewing within a reasonable window.
- **Perfectionism** — blocking a correct, minimal change because the prose isn't yet to
  your taste.

### Author anti-patterns (push back gently when you see these)

- **Mega PRs** — bundling a new skill + new evals + a manifest bump + a CHANGELOG
  rewrite. Ask for a split when reviewability suffers.
- **No context** — empty PR description, no linked issue. Ask for context before
  reviewing.
- **Defensive responses** — arguing every comment. If you sense this, switch to a
  synchronous chat to unblock.
- **Silent updates** — pushing changes without resolving the comment threads. Ask the
  author to reply with "addressed in commit X" so the next reviewer can follow along.

## Pre-merge sanity sweep

Before approving, confirm:

- [ ] All `blocking` findings are addressed (or explicitly waived with a note).
- [ ] All `important` findings are addressed *or* tracked in a follow-up issue linked
  from the PR.
- [ ] CI is green, including the eval job for any touched skill.
- [ ] `CHANGELOG.md` reflects what merged.
- [ ] The PR description matches the final diff (no stale "this PR adds X" claims).

## Anti-pattern smell tests (Aspire-specific)

These are quick mental tests that catch most of the bugs we see:

- **"What if `.aspire/modules/` was edited?"** TS AppHost edits must regenerate via `aspire add`.
- **"Is `dotnet build` mentioned without `aspire resource <name> restart` nearby?"**
  Probably a guardrail regression.
- **"Did the SKILL.md description shrink?"** Shrinking trigger keywords usually drops
  routing accuracy — check `trigger_tests.yaml`.
- **"Does this eval rely on the judge knowing Aspire 13.4?"** State the current Aspire fact in the
  grader prompt instead.
- **"Does this snippet use `--non-interactive`?"** If it's agent-facing, it must.

When in doubt, run the affected skill's eval locally with
`vally eval --eval-spec skills/<skill>/evals/eval.yaml --context-dir evals --no-cache`.
