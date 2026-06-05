# Evaluations

This plugin uses [vally](https://www.npmjs.com/package/@microsoft/vally-cli) to evaluate skill quality. Evals exercise each skill's routing, content correctness, and behavior against built-in static graders and an LLM-as-judge rubric.

> **Authoring a new stimulus or grader?** See [AUTHORING.md](./AUTHORING.md) — it covers stimulus anatomy, grader patterns, fixture conventions, and the do's and don'ts learned from this repo's eval suite.

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
└── eval.yaml            # Vally eval spec: config + stimuli (inline)
```

Each `eval.yaml` is a single canonical [vally `EvalSchema`](https://www.npmjs.com/package/@microsoft/vally-cli) document containing:

- `config` — model, executor (`copilot-sdk`), runs per stimulus, timeout, judge model.
- `tags` (optional) — record of `{ priority: pN, area: <area> }` inherited by stimuli that don't override.
- `stimuli` — array of prompts to execute. Each stimulus has `name`, `prompt`, optional `environment.files`, and `graders`.
- `scoring` (optional) — explicit weights per grader plus a pass-rate threshold. When omitted, vally applies equal weights and threshold `1.0` (every grader must pass).

Shared fixtures live at the **repo-root** `evals/` directory and are referenced from `stimulus.environment.files` by `{ src, dest }` pairs:

```
evals/
├── csharp-apphost/      # Wired C# AppHost (Aspire.AppHost.Sdk + Program.cs)
├── ts-apphost/          # TypeScript AppHost (apphost.ts + .aspire/modules/)
└── non-aspire/          # Non-Aspire .NET project (for "should not trigger" stimuli)
```

`src` is resolved relative to the eval spec file (so the canonical reference from `skills/<skill>/evals/eval.yaml` is `../../../evals/<fixture-path>`). `dest` is the workspace-relative path the executor sees.

## Quick commands

| Goal | Command |
|------|---------|
| Run CI gate suite (p0 + p1) | `vally eval --suite ci-gate` |
| Run full nightly suite | `vally eval --suite nightly` |
| Run one skill | `vally eval --eval-spec skills/aspire-deployment/evals/eval.yaml --skill-dir skills/aspire-deployment` |
| Run one stimulus by tag | `vally eval --eval-spec skills/aspire/evals/eval.yaml --tag area=routing` |
| Save per-skill results | `vally eval --suite ci-gate --output-dir ./results` |
| Emit JUnit XML for CI | `vally eval --suite ci-gate --junit ./results/junit.xml` |
| Browse results in the dashboard | `vally serve ./results` |
| Persist runs to a SQLite store | `vally ingest ./results --store ./vally.sqlite` |
| Lint all skills | `vally lint skills` |
| Validate one eval spec | `vally lint --eval-spec skills/<skill>/evals/eval.yaml` |
| Plan a run without grading | `vally eval --eval-spec skills/<skill>/evals/eval.yaml --skip-grade` |

## Key flags

| Flag | Purpose |
|------|---------|
| `-e, --eval-spec <path>` | Eval spec to run. Repeatable. |
| `--skill-dir <dir>` | Skill directory the executor surfaces to the model. Defaults to the eval spec's parent. |
| `--workspace <dir>` | Working directory for the executor (fixtures get copied here). Defaults to a per-stimulus temp dir. |
| `--suite <name>` | Run only stimuli matching a suite declared in `.vally.yaml`. |
| `--tag <key=values>` | Run only stimuli whose tag record matches. Comma-separate values; repeat for multiple keys. E.g. `--tag priority=p0,p1 --tag area=routing`. |
| `--model <name>` | Executor model. Overrides `config.model` in the spec. |
| `--judge-model <name>` | Model used by `prompt` / `pairwise` graders. Defaults to `claude-sonnet-4.6`. |
| `--runs <n>` | Override `config.runs` (number of executions per stimulus). |
| `--timeout <duration>` | Per-stimulus timeout (e.g. `120s`, `2m`). |
| `--workers <n>` | Parallel stimulus workers. Default 1. |
| `--max-retries <n>` | Retries for transient executor errors. |
| `--output-dir <dir>` | Persist `results.jsonl` + `eval-results.md` to this directory. |
| `--output jsonl` | Stream JSONL records to stdout. |
| `--junit <path>` | Write JUnit XML alongside the run. |
| `--skip-grade` | Execute stimuli without running graders. |
| `--skip-validate` | Skip spec validation before running. |
| `--keep-executor-session-logs` | Retain raw executor session traces in `--output-dir`. |
| `--verbose` | Print full stimulus output + grader reasoning. |

For the full surface, run `vally eval --help`, `vally lint --help`, `vally serve --help`.

## Cost / time

Each stimulus runs `config.runs` times (default 1 in vally; some specs override to 3). Each run is one executor call plus one judge call per `prompt` grader.

Rough budget with `executor: copilot-sdk` + `model: gpt-5-mini`:

- ~30k–80k tokens per stimulus (routing stimuli are at the lower end; deployment / orchestration stimuli with fixtures sit higher).
- ~10–45 seconds per stimulus.
- The `ci-gate` suite (p0 + p1) is the per-PR gate; `nightly` covers p0 + p1 + p2.

Use `--workers 4` to fan stimuli out and shave wall-clock time; expect higher cost-per-second but the same total tokens.

## Test coverage

| Skill | Task stimuli | Routing stimuli | Focus |
|-------|--------------|-----------------|-------|
| `aspire` (router) | 6 | 16 | Routing precision to sub-skills |
| `aspire-init` | 5 | 15 | Skeleton drop, `aspire new` / `aspire init` decision, aspireify handoff |
| `aspireify` | 8 | 18 | AppHost wiring (C# / file-based C# / TS), validation, never edit `.aspire/modules/` |
| `aspire-orchestration` | 16 | 24 | Lifecycle, file lock recovery, `--include-hidden`, `aspire update --self` |
| `aspire-deployment` | 8 | 21 | Multi-target deploy, `aspire destroy`, JS publishing, pipeline previews |
| `aspire-monitoring` | 11 | 19 | Diagnostics bridge, standalone dashboard, browser logs, `--include-hidden` |
| **Total** | **54** | **113** | |

Run `vally lint --eval-spec skills/<skill>/evals/eval.yaml --verbose` to dump the per-spec stimulus list.

## Tags

Vally tags are **records**, not bare arrays. Stimuli inherit eval-level tags and may override or extend them. Suite filters in `.vally.yaml` match with AND across keys / OR within values.

| Key | Common values | Meaning |
|-----|---------------|---------|
| `priority` | `p0`, `p1`, `p2` | `p0` must pass for the skill to ship, `p1` should pass, `p2` is aspirational. |
| `area` | `routing`, `safety-guardrail`, `core-flow`, `known-bug`, `aspire-13-3` | Functional area the stimulus probes. |

Filter examples:

```bash
# All p0 + p1 routing stimuli across every spec
vally eval --suite ci-gate --tag area=routing

# Only the known-bug regressions for one skill
vally eval --eval-spec skills/aspire-orchestration/evals/eval.yaml --tag area=known-bug
```

## Dashboard (`vally serve`)

`vally serve` boots a local Aspire-style dashboard for browsing runs:

```bash
# After a run
vally eval --suite ci-gate --output-dir ./results

# Browse pass/fail, per-grader breakdown, full executor traces
vally serve ./results
# → http://127.0.0.1:3200
```

Flags worth knowing:

| Flag | Purpose |
|------|---------|
| `--port <n>` | Bind to a custom port. Default `3200`. |
| `--host <addr>` | Bind address. Default `127.0.0.1`. |
| `--cors` | Enable CORS (handy for embedding the dashboard in another tool). |
| `--store <sqlite>` | Serve historical runs from a SQLite store populated by `vally ingest`. |

## Historical mode (`vally ingest` + `--store`)

For longitudinal trend tracking across nightly runs:

```bash
# In CI, after each nightly:
vally ingest ./results --store ./vally.sqlite

# Locally, browse the full history:
vally serve --store ./vally.sqlite
```

`vally compare <run-dir-A> <run-dir-B>` diff-prints two runs for ad-hoc regression triage without the dashboard.

## Quick smoke test

```bash
# Validate every spec without running a model
vally lint skills
for spec in skills/*/evals/eval.yaml; do vally lint --eval-spec "$spec"; done

# Run just the p0 routing stimuli for the router skill (~2 minutes, ~150k tokens)
vally eval --eval-spec skills/aspire/evals/eval.yaml --tag priority=p0 --tag area=routing
```

## CI integration

The repo ships three GitHub Actions workflows that drive `vally` automatically:

| Workflow | Trigger | Command |
|----------|---------|---------|
| [`skill-lint.yml`](../.github/workflows/skill-lint.yml) | PR (`SKILL.md` / `*.yaml` / `.vally.yaml`) | `vally lint skills` + per-spec `vally lint --eval-spec <spec>` |
| [`skill-eval.yml`](../.github/workflows/skill-eval.yml) | PR (`SKILL.md` / `eval.yaml` / `.vally.yaml`) | `vally eval --suite ci-gate --output-dir ./results` |
| [`skill-eval-nightly.yml`](../.github/workflows/skill-eval-nightly.yml) | `cron: "0 6 * * 0"` (Sun 06:00 UTC) + `workflow_dispatch` | `vally eval --suite nightly --output-dir ./results` |

The suites are declared at the repo root in [`.vally.yaml`](../.vally.yaml) and filter on the `priority` tag every stimulus carries:

```yaml
suites:
  ci-gate:
    filter:
      priority: [p0, p1]
  nightly:
    filter:
      priority: [p0, p1, p2]
```

`vally` exits non-zero if any stimulus fails grading. PRs gate on `ci-gate`; the comprehensive `nightly` suite runs weekly and uploads the full `./results` directory as a workflow artifact for later dashboard inspection.

## CI authentication

The `copilot-sdk` executor (declared by every `skills/<skill>/evals/eval.yaml`) invokes Copilot models via the [`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk) package. That package reads the **`COPILOT_GITHUB_TOKEN`** environment variable.

| Context | How auth is supplied |
|---------|----------------------|
| **Local** (`vally eval ...`) | Set `COPILOT_GITHUB_TOKEN` from a Copilot-enabled `gh` login — e.g. `export COPILOT_GITHUB_TOKEN="$(gh auth token)"`. |
| **CI** (`skill-eval.yml`, `skill-eval-nightly.yml`) | Reads the **`COPILOT_GITHUB_TOKEN`** repository (or org) secret and exposes it as the env var of the same name **at step level only** (so checkout / install / artifact-upload steps never see it). |

The workflow's default `secrets.GITHUB_TOKEN` is the **wrong** token — it has repo scopes but **no Copilot model access**, so the SDK 401s on it.

### One-time maintainer setup

1. Mint a Copilot-enabled GitHub token for the bot / service identity you want CI to run as. Personal PATs work for spike testing; a dedicated service account is the right long-term choice so eval history isn't tied to one human.
2. Repo → **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `COPILOT_GITHUB_TOKEN`
   - Value: the token from step 1
3. Optionally promote to a **GitHub Environment** (e.g. `aspire-skills-evals`) with required reviewers and protected-branch policy for an extra approval gate.

### Behavior when the secret is missing

- `skill-eval.yml` and `skill-eval-nightly.yml` **soft-skip** with a `::warning::` annotation and a `$GITHUB_STEP_SUMMARY` block pointing back at this section. The job stays green so a missing-secret state never blocks merges or paints scheduled runs red — but the warning + summary are highly visible in the PR / run UI until a maintainer provisions the secret.
- `skill-eval.yml` additionally **does not run at all** for PRs opened from forks (GitHub does not forward secrets to fork-triggered workflows), so external contributors get a clean skip rather than a confusing warning they can't act on. `skill-lint.yml` still runs for forks since it needs no token.
- `skill-lint.yml` always hard-gates schema and wiring correctness regardless of whether the model token is configured.

## Interpreting results

After a run that wrote `--output-dir ./results`, look at:

- **`results/<timestamp>/eval-results.md`** — human-readable summary table with per-stimulus verdict, grader breakdown, token usage, and footnote-style failure reasons.
- **`results/<timestamp>/results.jsonl`** — one record per stimulus run, with the full executor trajectory and every grader's reasoning. Pipe into `jq` for ad-hoc queries.
- **`vally serve ./results`** — same data, rendered as a dashboard with filtering, charts, and trajectory drill-down.

Common failure modes to grep for:

- **`skill-invocation` grader failed but the agent did invoke a skill** — the grader's `required: [...]` list is an exact match. If the agent picked a sibling skill (e.g. `aspire-orchestration` instead of `aspire`), that counts as a miss. Tune `required` to the set of acceptable skills, or switch to a `prompt` grader if "any of these N skills is fine" is the real intent.
- **`output-contains` failed despite the substring being in the output** — vally's substring grader is case-sensitive by default. Either lowercase the expected substring or set `case_sensitive: false` in the grader config.
- **`Timeout after Nms waiting for session.idle`** — bump `config.timeout` (e.g. `"180s"`) or the per-stimulus `timeout`. Long-form authoring stimuli routinely need 90–120 s.
