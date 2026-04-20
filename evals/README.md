# Running Evaluations

This plugin uses [waza](https://github.com/microsoft/waza) to evaluate skill quality.

## Install waza

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/microsoft/waza/main/install.sh | bash

# Or from source (Go 1.26+)
git clone https://github.com/microsoft/waza.git && cd waza && go build -o waza ./cmd/waza

# Verify
waza -v
```

## Eval Structure

Each skill has its own eval suite under `skills/<skill>/evals/`:

```
skills/<skill>/evals/
├── eval.yaml              # Benchmark config (model, metrics, global graders)
├── trigger_tests.yaml     # Prompt routing accuracy (should/should-not trigger)
└── tasks/                 # Individual test scenarios
    └── *.yaml             # One file per test case
```

## Run All Evals

```bash
# From repo root — discovers and runs all 4 skill evals
waza run --discover --model gpt-4.1 --judge-model gpt-4.1

# Save results
waza run --discover --model gpt-4.1 --judge-model gpt-4.1 --output-dir ./eval-results
```

## Run One Skill

```bash
# By skill name
waza run aspire-orchestration --model gpt-4.1 --judge-model gpt-4.1

# By eval file path
waza run skills/aspire-orchestration/evals/eval.yaml --model gpt-4.1 --judge-model gpt-4.1
```

## Run Specific Tasks

```bash
# By tag (runs only P0 safety guardrails)
waza run aspire-orchestration --tags "p0" --model gpt-4.1

# By task name
waza run aspire-orchestration --task "start-app*" --model gpt-4.1
```

## Compare Models

```bash
# Run same evals against multiple models
waza run --discover --model gpt-4.1 --model claude-sonnet-4 -o results-comparison.json

# Or compare saved results
waza compare results-gpt41.json results-sonnet.json
```

## Key Flags

| Flag | Purpose |
|------|---------|
| `--model <name>` | Model for task execution (repeatable for comparison) |
| `--judge-model <name>` | Model for `prompt` graders (LLM-as-judge) |
| `--discover` | Auto-find all skill evals in the repo |
| `--output-dir <dir>` | Save structured results per skill |
| `-o <file>` | Save results to single JSON file |
| `--tags <tag>` | Filter tasks by tag (`p0`, `safety-guardrail`, etc.) |
| `--task <glob>` | Filter tasks by name/ID pattern |
| `--verbose` | Show prompts, responses, and grader details |
| `--parallel` | Run tasks concurrently |
| `--interpret` | Print plain-language interpretation of results |
| `--suggest` | Generate skill improvement suggestions from outcomes |
| `--baseline` | A/B comparison: with skills vs without |

## Grader Types Used

| Type | What It Checks | Example |
|------|---------------|---------|
| `text` | Substring contains / not_contains | Response must include `aspire start` |
| `prompt` | LLM-as-judge with rubric | "Does the response explain why dotnet run is wrong?" |
| `code` | Python assertion expressions | `"'aspire' in output.lower()"` |

## Test Coverage

| Skill | Tasks | Triggers | Focus |
|-------|-------|----------|-------|
| `aspire` (router) | 6 | 14 | Routing precision to sub-skills |
| `aspire-orchestration` | 8 | 18 | All 5 #15801 complaints + detection |
| `aspire-deployment` | 6 | 14 | Multi-target deploy, no-azd guardrail |
| `aspire-monitoring` | 8 | 15 | Diagnostics bridge, local vs deployed |
| **Total** | **28** | **61** | |

## Tags

Tasks are tagged for filtered runs:

| Tag | Meaning |
|-----|---------|
| `p0` | Critical — must pass for skill to ship |
| `p1` | Important — should pass |
| `safety-guardrail` | Tests a #15801 safety rule |
| `issue-NNNNN` | Derived from a specific GitHub issue |
| `routing` | Tests diagnostics bridge routing |
| `known-bug` | Tests awareness of a known CLI bug |

## Quick Smoke Test

```bash
# Fast check — trigger routing only (no LLM calls for tasks)
waza run --discover --model gpt-4.1 --tags "p0"
```

## CI Integration

```bash
# JUnit output for CI
waza run --discover --model gpt-4.1 --judge-model gpt-4.1 \
  --reporter json --reporter junit:eval-results.xml
```
