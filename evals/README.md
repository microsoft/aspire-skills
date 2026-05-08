# Evaluations

This plugin uses [waza](https://github.com/microsoft/waza) to evaluate skill quality. Evals exercise each skill's routing, content correctness, and behavior against an LLM-as-judge rubric.

> **Authoring a new task or grader?** See [AUTHORING.md](./AUTHORING.md) — it covers task anatomy, grader patterns, fixture conventions, and the do's and don'ts learned from this repo's eval suite.

## Install waza

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/microsoft/waza/main/install.sh | bash

# From source (Go 1.26+)
git clone https://github.com/microsoft/waza.git && cd waza && go build -o waza ./cmd/waza

# Verify
waza -v
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
├── ts-apphost/          # TypeScript AppHost (apphost.ts + .modules/)
└── non-aspire/          # Non-Aspire .NET project (for "should not trigger" tasks)
```

A task's `inputs.files[].path` resolves against the **context directory** (defaults to `./fixtures` relative to the eval spec; pass `--context-dir evals` from the repo root to use the shared fixtures above).

## Quick commands

| Goal | Command |
|------|---------|
| Run all skills | `waza run --discover --context-dir evals` |
| Run one skill | `waza run skills/aspire-deployment/evals/eval.yaml --context-dir evals` |
| Run by tag | `waza run skills/aspire-orchestration/evals/eval.yaml --tags p0 --context-dir evals` |
| Run one task by ID | `waza run skills/aspire/evals/eval.yaml --task "router-deploy*" --context-dir evals` |
| Save results JSON | `waza run --discover --context-dir evals -o results.json` |
| Save per-skill results | `waza run --discover --context-dir evals --output-dir eval-results` |
| Compare two saved runs | `waza compare results-A.json results-B.json` |
| Check schema only (no run) | `waza check skills/<skill>` |
| List planned tasks (no run) | `waza run skills/<skill>/evals/eval.yaml --task "*" --skip-graders` |
| JUnit reporter (CI) | `waza run --discover --reporter junit:eval-results.xml` |

## Key flags

| Flag | Purpose |
|------|---------|
| `--model <name>` | Model used to execute the task (repeatable for A/B). Overrides `eval.yaml` `config.model`. |
| `--judge-model <name>` | Model used by `prompt` graders (LLM-as-judge). Defaults to the execution model. |
| `--context-dir <dir>` | Where `inputs.files[].path` resolves from. Default `./fixtures` relative to the spec; this repo uses `--context-dir evals`. |
| `--discover` | Walk the tree and run every `eval.yaml` it finds. |
| `--tags <tag>` | Run only tasks with the given tag. Repeatable. |
| `--task <glob>` | Match tasks by `id` (not `name`) — e.g. `"router-deploy*"`. Repeatable. |
| `--no-cache` | Force fresh runs; don't reuse `.waza-cache`. |
| `--parallel` | Run tasks concurrently. Faster but harder to debug. |
| `--strict` | With `--discover`, fail if any SKILL.md lacks an `eval.yaml`. |
| `--skip-graders` | Execute tasks without grading; pair with `waza grade` later. |
| `-o <file>` / `--output-dir <dir>` | Persist results. Mutually exclusive. |
| `--reporter junit:path.xml` | Emit JUnit XML for CI. Repeatable. |

## Cost / time

Each task runs `config.trials_per_task` times (default 3). Each trial is one execution call + one judge call per `prompt` grader. Plan for:

- ~200k–300k tokens per task (typical, `executor: copilot-sdk`, `model: gpt-4.1`).
- ~3–4 minutes per task at default `parallel: false`.
- A full `--discover` run across all 6 skills = **~56 tasks × ~3.5 min ≈ 3+ hours** if serial. Use `--parallel` and `--tags p0` to scope.

## Test coverage

Counts as of 2026-05-08 (Aspire 13.3 refresh + `aspire-init` + `aspireify` skills):

| Skill | Tasks | Trigger prompts | Focus |
|-------|-------|-----------------|-------|
| `aspire` (router) | 6 | ~14 | Routing precision to sub-skills |
| `aspire-init` | 5 | ~15 | Skeleton drop, `aspire new` / `aspire init` decision, aspireify handoff |
| `aspireify` | 8 | ~15 | AppHost wiring (C# / file-based C# / TS), validation, never edit `.modules/` |
| `aspire-orchestration` | 16 | ~25 | Lifecycle, file lock recovery, `--include-hidden`, `aspire update --self` |
| `aspire-deployment` | 10 | ~20 | Multi-target deploy + native K8s Helm, `aspire destroy`, JS publishing, Azure 13.3 |
| `aspire-monitoring` | 11 | ~20 | Diagnostics bridge, standalone dashboard, browser logs, `--include-hidden` |
| **Total** | **56** | **~109** | |

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
waza run --discover --tags p0 --context-dir evals

# Single-task sanity check (≈4 minutes)
waza run skills/aspire-deployment/evals/eval.yaml --task "deploy-destroy*" --context-dir evals --no-cache
```

## CI integration

```bash
waza run --discover --context-dir evals \
  --reporter json \
  --reporter junit:eval-results.xml \
  --output-dir eval-results
```

`waza` exits non-zero if any task fails or trigger accuracy falls below its `eval.yaml` threshold. Use `--tags p0` in CI to keep wall-clock manageable; run the full suite nightly.

## Interpreting results

```bash
waza run skills/aspire/evals/eval.yaml --interpret    # plain-language summary
waza run skills/aspire/evals/eval.yaml --suggest      # generate skill-improvement report
```

Look for:

- **Per-task pass_rate** — fraction of trials that passed every grader.
- **Per-grader breakdown** — which grader(s) failed and why. The judge's reasoning is shown verbatim.
- **Trigger accuracy** — how well the skill's frontmatter description matches the `should_trigger` / `should_not_trigger` prompts.
- **Aggregate score** — weighted blend of `metrics` declared in `eval.yaml`.

If the judge says *"no response found in workspace"* but the agent did respond, the grader prompt is the problem — see [AUTHORING.md → Grader patterns](./AUTHORING.md#grader-patterns-dos-and-donts).
