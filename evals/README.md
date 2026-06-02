# Evaluations

This plugin uses [vally](https://www.npmjs.com/package/@microsoft/vally-cli) to evaluate skill quality. Evals exercise each skill's routing, content correctness, and behavior against an LLM-as-judge rubric.

> **Authoring a new task or grader?** See [AUTHORING.md](./AUTHORING.md) — it covers task anatomy, grader patterns, fixture conventions, and the do's and don'ts learned from this repo's eval suite.

## Install vally

```bash
# Requires Node.js 22+
npm install -g @microsoft/vally-cli

# Verify
vally --version
```

## Repo structure

```
skills/<skill>/evals/
├── eval.yaml            # Benchmark config: model, metrics, top-level graders
├── trigger_tests.yaml   # Routing accuracy: should / should-not trigger prompts
└── tasks/               # One file per scenario
    └── *.yaml
```

Shared fixtures live at the **repo-root** `evals/` directory and are referenced from task `inputs.files` by relative path:

```
evals/
├── csharp-apphost/      # Wired C# AppHost (Aspire.AppHost.Sdk + Program.cs)
├── ts-apphost/          # TypeScript AppHost (apphost.ts + .aspire/modules/)
└── non-aspire/          # Non-Aspire .NET project (for "should not trigger" tasks)
```

A task's `inputs.files[].path` resolves against the **context directory** (defaults to `./fixtures` relative to the eval spec; pass `--context-dir evals` from the repo root to use the shared fixtures above).

## Quick commands

| Goal | Command |
|------|---------|
| Run CI gate suite (p0 + p1) | `vally eval --suite ci-gate` |
| Run full nightly suite | `vally eval --suite nightly` |
| Run all skills | `vally eval --discover --context-dir evals` |
| Run one skill | `vally eval --eval-spec skills/aspire-deployment/evals/eval.yaml --context-dir evals` |
| Run by tag | `vally eval --eval-spec skills/aspire-orchestration/evals/eval.yaml --tags p0 --context-dir evals` |
| Run one task by ID | `vally eval --eval-spec skills/aspire/evals/eval.yaml --task "router-deploy*" --context-dir evals` |
| Save results JSON | `vally eval --discover --context-dir evals -o results.json` |
| Save per-skill results | `vally eval --discover --context-dir evals --output-dir eval-results` |
| Compare two saved runs | `vally compare results-A.json results-B.json` |
| Lint a skill | `vally lint skills/<skill>` |
| Validate one eval spec | `vally lint --eval-spec skills/<skill>/evals/eval.yaml --strict` |
| List planned tasks (no run) | `vally eval --eval-spec skills/<skill>/evals/eval.yaml --task "*" --skip-graders` |
| JUnit reporter (CI) | `vally eval --discover --reporter junit:eval-results.xml` |

## Key flags

| Flag | Purpose |
|------|---------|
| `--model <name>` | Model used to execute the task (repeatable for A/B). Overrides `eval.yaml` `config.model`. |
| `--judge-model <name>` | Model used by `prompt` graders (LLM-as-judge). Defaults to the execution model. |
| `--context-dir <dir>` | Where `inputs.files[].path` resolves from. Default `./fixtures` relative to the spec; this repo uses `--context-dir evals`. |
| `--discover` | Walk the tree and run every `eval.yaml` it finds. |
| `--tags <tag>` | Run only tasks with the given tag. Repeatable. |
| `--task <glob>` | Match tasks by `id` (not `name`) — e.g. `"router-deploy*"`. Repeatable. |
| `--no-cache` | Force fresh runs; don't reuse `.vally-cache`. |
| `--parallel` | Run tasks concurrently. Faster but harder to debug. |
| `--strict` | With `--discover`, fail if any SKILL.md lacks an `eval.yaml`. |
| `--skip-graders` | Execute tasks without grading; pair with `vally grade` later. |
| `-o <file>` / `--output-dir <dir>` | Persist results. Mutually exclusive. |
| `--reporter junit:path.xml` | Emit JUnit XML for CI. Repeatable. |

## Cost / time

Each task runs `config.trials_per_task` times (default 3). Each trial is one execution call + one judge call per `prompt` grader. Plan for:

- ~200k–300k tokens per task (typical, `executor: copilot-sdk`, `model: gpt-4.1`).
- ~3–4 minutes per task at default `parallel: false`.
- A full `--discover` run across all 6 skills = **54 tasks × ~3.5 min ≈ 3+ hours** if serial. Use `--parallel` and `--tags p0` to scope.

## Test coverage

Counts as of 2026-05-18 (Aspire 13.4-aligned refresh + `aspire-init` + `aspireify` skills):

| Skill | Tasks | Trigger prompts | Focus |
|-------|-------|-----------------|-------|
| `aspire` (router) | 6 | 16 | Routing precision to sub-skills |
| `aspire-init` | 5 | 15 | Skeleton drop, `aspire new` / `aspire init` decision, aspireify handoff |
| `aspireify` | 8 | 18 | AppHost wiring (C# / file-based C# / TS), validation, never edit `.aspire/modules/` |
| `aspire-orchestration` | 16 | 24 | Lifecycle, file lock recovery, `--include-hidden`, `aspire update --self` |
| `aspire-deployment` | 8 | 21 | Multi-target deploy, `aspire destroy`, JS publishing, pipeline previews |
| `aspire-monitoring` | 11 | 19 | Diagnostics bridge, standalone dashboard, browser logs, `--include-hidden` |
| **Total** | **54** | **113** | |

Run `find skills -path '*evals/tasks/*.yaml' | wc -l` for the live count.

## Tags

Tasks are tagged for filtered runs:

| Tag | Meaning |
|-----|---------|
| `p0` | Critical — must pass for skill to ship |
| `p1` | Important — should pass |
| `safety-guardrail` | Tests a [#15801](https://github.com/microsoft/aspire/issues/15801)-class safety rule |
| `routing` | Tests skill or diagnostics-bridge routing |
| `aspire-13-3` | New behavior introduced in Aspire 13.3 |
| `core-flow` | Common day-1 workflow |
| `known-bug` / `issue-NNNNN` | Tests awareness of a tracked CLI bug |

## Quick smoke test

```bash
# Fast pass: only P0 tasks
vally eval --discover --tags p0 --context-dir evals

# Single-task sanity check (≈4 minutes)
vally eval --eval-spec skills/aspire-deployment/evals/eval.yaml --task "deploy-destroy*" --context-dir evals --no-cache
```

## CI integration

The repo ships three GitHub Actions workflows that drive `vally` automatically:

| Workflow | Trigger | Command |
|----------|---------|---------|
| [`skill-lint.yml`](../.github/workflows/skill-lint.yml) | PR (SKILL.md / *.yaml / `.vally.yaml`) | `vally lint .` + per-spec `vally lint --eval-spec <spec> --strict` |
| [`skill-eval.yml`](../.github/workflows/skill-eval.yml) | PR (SKILL.md / eval.yaml / task yamls / `.vally.yaml`) | `vally eval --suite ci-gate --context-dir evals --output-dir ./results` |
| [`skill-eval-nightly.yml`](../.github/workflows/skill-eval-nightly.yml) | `cron: "0 6 * * 0"` (Sun 06:00 UTC) + `workflow_dispatch` | `vally eval --suite nightly --context-dir evals --output-dir ./results` |

The suites are declared at the repo root in [`.vally.yaml`](../.vally.yaml) and filter on the priority **tags** that every task carries (`p0` / `p1` / `p2`):

```yaml
suites:
  ci-gate:
    filter:
      tags: [p0, p1]
  nightly:
    filter:
      tags: [p0, p1, p2]
```

For ad-hoc CI scripts:

```bash
vally eval --discover --context-dir evals \
  --reporter json \
  --reporter junit:eval-results.xml \
  --output-dir eval-results
```

`vally` exits non-zero if any task fails or trigger accuracy falls below its `eval.yaml` threshold. PRs gate on the `ci-gate` suite; the comprehensive `nightly` suite runs weekly.

## Interpreting results

```bash
vally eval --eval-spec skills/aspire/evals/eval.yaml --interpret    # plain-language summary
vally eval --eval-spec skills/aspire/evals/eval.yaml --suggest      # generate skill-improvement report
```

Look for:

- **Per-task pass_rate** — fraction of trials that passed every grader.
- **Per-grader breakdown** — which grader(s) failed and why. The judge's reasoning is shown verbatim.
- **Trigger accuracy** — how well the skill's frontmatter description matches the `should_trigger` / `should_not_trigger` prompts.
- **Aggregate score** — weighted blend of `metrics` declared in `eval.yaml`.

If the judge says *"no response found in workspace"* but the agent did respond, the grader prompt is the problem — see [AUTHORING.md → Grader patterns](./AUTHORING.md#grader-patterns-dos-and-donts).
