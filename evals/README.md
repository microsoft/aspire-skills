# Evaluations

This plugin uses [vally](https://www.npmjs.com/package/@microsoft/vally-cli) to evaluate skill quality. Evals exercise each skill's routing, content correctness, and behavior against built-in static graders and an LLM-as-judge rubric.

> **Authoring a new stimulus or grader?** See [AUTHORING.md](./AUTHORING.md) — it covers stimulus anatomy, grader patterns, fixture conventions, and the do's and don'ts learned from this repo's eval suite.

## Install vally

```bash
# Requires Node.js 22.12+
npm install -g @microsoft/vally-cli@0.16.0

# Verify
vally --version
```

## Repo structure

```
skills/<skill>/evals/
└── eval.yaml            # Vally eval spec: config + stimuli (inline)
```

Each `eval.yaml` is a single canonical [vally `EvalSchema`](https://www.npmjs.com/package/@microsoft/vally-cli) document containing:

- `defaults` — model, executor (`copilot-sdk`), runs per stimulus, timeout.
- `environment.skills` — **(vally 0.8.0)** the skill directories loaded for this spec. See [Skills & baselines](#skills--baselines-vally-080). Omit it and the stimuli run with **no skills** (the baseline).
- `tags` (optional) — record of `{ skill: <name>, priority: pN, area: <area> }` inherited by stimuli that don't override.
- `stimuli` — array of prompts to execute. Each stimulus has `name`, `prompt`, optional `tags`, optional `environment.files` (and may add `environment.skills`), and `graders`.
- `scoring` (optional) — explicit weights per grader plus a pass-rate threshold. When omitted, vally applies equal weights and threshold `1.0` (every grader must pass).

Shared fixtures live at the **repo-root** `evals/` directory and are referenced from `stimulus.environment.files` by `{ src, dest }` pairs:

```
evals/
├── csharp-apphost/      # Wired C# AppHost (Aspire.AppHost.Sdk + Program.cs)
├── ts-apphost/          # TypeScript AppHost (apphost.mts + .aspire/modules/)
├── non-aspire/          # Non-Aspire .NET project (for "should not trigger" stimuli)
├── project-v2-migration/ # Legacy inputs, captured-edit contracts, and qualification guidance
└── version-preservation/ # Read-only C# AppHost fixture with concrete, centrally managed Aspire versions
```

`src` is resolved relative to the eval spec file (so the canonical reference from `skills/<skill>/evals/eval.yaml` is `../../../evals/<fixture-path>`). `dest` is the workspace-relative path the executor sees.

## Skills & baselines (vally 0.8.0)

As of vally **0.8.0**, a run loads **no skills by default**. Each spec declares the skills it exercises via a top-level `environment.skills` list of skill **directories** (each containing a `SKILL.md`), resolved relative to the eval file:

```yaml
environment:
  skills:
    - ../../aspireify            # the skill under test
    - ../../aspire-orchestration # its in-repo dependency
```

Eval-level `environment.skills` is **union-merged** into every stimulus, so you declare the set once. During a normal eval run, a stimulus may *add* siblings (e.g. routing stimuli that need the full candidate set) but cannot remove them. Experiment variants are applied after that merge: a variant's `environment.skills` replaces the effective list wholesale, so `skills: []` also removes stimulus-level additions.

**Hybrid loading convention used here:**

- **Capability specs** load the skill under test **plus its transitive in-repo dependencies** (whatever its `SKILL.md` `INVOKES:`). E.g. `aspireify` loads `aspireify` + `aspire-orchestration` because it validates wiring by running `aspire start`.
- **Migration routing stimuli** load all **seven skills** so the new migration workflow competes with real siblings. Legacy specs retain their existing candidate sets; they have not all been expanded to seven.

**Activation assertions:** use a `skill-invocation` grader with `config.required` / `config.disallowed` to assert which skills the agent actually invoked. Vally 0.16.0 no longer accepts `constraints.expect_skills` / `constraints.reject_skills`.

### Router entry and read-only assessments

The router suite requires `aspire` for explicit router requests, broad CLI
overviews and project-local agent guidance. Clear single-domain requests instead
require the actual owning specialist; entering through `aspire` first is optional.
Naming the right skill without loading it is not sufficient. Deployed diagnostics
may enter through either the router's Azure handoff or the monitoring bridge;
`grade-routing-entry.mjs` checks Vally's normalized `skill_activation` events for
that alternative, not words in the response.

The Copilot SDK eval harness exposes the available skills but does not inject the
host runtime's mandatory "invoke a matching skill before acting" policy. Positive
routing stimuli therefore start with the same neutral instruction to invoke the
matching available Aspire skill or skills. The instruction never names the expected
owner, so the evaluation still measures owner selection and router handoff rather
than parroting a requested skill name. Negative cases omit it.

The router spec deliberately uses `gpt-5.6-sol-fast` instead of the repository's
usual `gpt-5-mini` executor so single-trial PR gates can enforce owner activation
without naming the owner in prompts. This increases router-suite cost, but avoids
weakening policy checks to accommodate small-model routing variance.

These assessments are read-only: explicit rubrics judge the route and guidance,
not successful live deployment or log retrieval, and `diff-empty` checks the
captured workspace. Report individual activation, outcome and read-only results
alongside the aggregate; a passing average does not mean every case passed.

### Gated result integrity

PR and nightly workflows run
`node scripts/check-eval-results.mjs <results> <expected-run>...` after attempted
evaluations, including failures, but not after cancellation or intentional skips.
Scoped PR runs pass every changed skill output root; single-process full/nightly
suites pass `.`. Every expected run must produce exactly one `results.jsonl`, and
the checker reconciles each summary's stimulus count plus every stimulus's complete
trial-index range. Execution/grading errors and missing, malformed, incomplete or
ungraded results fail the job even if Vally reported a passing aggregate.
Legitimate negative grading verdicts remain subject to the existing `--require-pass`
threshold; the checker does not replace or lower that threshold.

The checker requires no token. Redaction still runs after a failed check, and
artifact upload remains conditional on successful redaction. The comparative
experiment below remains informational rather than adopting this gating policy.

### Comparative baselines (`vally experiment`)

[`skill-lift.experiment.yaml`](../skill-lift.experiment.yaml) (repo root) runs every spec **twice** along a single axis — `/environment/skills` — to measure each skill's *lift* over a no-skill baseline:

```yaml
name: skill-lift
evals: [skills/*/evals/eval.yaml]
vary: [/environment/skills]
baseline: no-skills
variants:
  no-skills:   { environment: { skills: [] } }  # replace the effective list
  with-skills: {}                               # inherit each spec's skills
```

```bash
# Plan only (no model calls)
vally experiment run skill-lift.experiment.yaml --dry-run

# Full run
vally experiment run skill-lift.experiment.yaml --output-dir ./results
```

The `with-skills` − `no-skills` pass-rate delta is the measured lift. The experiment is **informational, never a gate**: the no-skills baseline is *expected* to fail grading, so `vally experiment run` exits non-zero by design. The PR gate in `skill-eval.yml` discovers the changed skill specs and runs their p0 + p1 stimuli directly; CI runs the experiment weekly via [`skill-experiment.yml`](../.github/workflows/skill-experiment.yml).

## Quick commands

| Goal | Command |
|------|---------|
| Reproduce the PR gate for one changed skill | `vally eval --eval-spec skills/<skill>/evals/eval.yaml --tag priority=p0,p1 --runs 1 --max-retries 2` |
| Run p0 + p1 across all skills | `vally eval --suite ci-gate` |
| Run full nightly suite | `vally eval --suite nightly` |
| Run one skill | `vally eval --eval-spec skills/aspire-deployment/evals/eval.yaml` |
| Run one stimulus by tag | `vally eval --eval-spec skills/aspire/evals/eval.yaml --tag area=routing` |
| Run the skill-lift baseline experiment | `vally experiment run skill-lift.experiment.yaml --output-dir ./results` |
| Plan the experiment (no model calls) | `vally experiment run skill-lift.experiment.yaml --dry-run` |
| Save PR-gate results for one skill | `vally eval --eval-spec skills/<skill>/evals/eval.yaml --tag priority=p0,p1 --output-dir ./results` |
| Emit JUnit XML for the all-skill p0 + p1 suite | `vally eval --suite ci-gate --junit --output-dir ./results` |
| Browse results in the dashboard | `vally serve ./results` |
| Persist runs to a SQLite store | `vally ingest ./results --store ./vally.sqlite` |
| Lint all skills | `vally lint skills` |
| Validate one eval spec | `vally lint --eval-spec skills/<skill>/evals/eval.yaml` |
| Execute agents without grading (not a dry run) | `vally eval --eval-spec skills/<skill>/evals/eval.yaml --skip-grade` |
| Validate actual Project v2 source edits | See the [migration fixture guide](./project-v2-migration/README.md#source-and-approval-gates) |

## Key flags

| Flag | Purpose |
|------|---------|
| `-e, --eval-spec <path>` | Eval spec to run. Repeatable. |
| `--skill-dir <dir>` | **(vally 0.8.0)** Discover skills from this directory. A spec's `environment.skills` takes precedence: when present it **replaces** `--skill-dir` discovery (it is not additive), so `--skill-dir` only applies to specs that omit `environment.skills`. With neither set, vally loads **no skills** (the baseline) — prefer declaring `environment.skills` in the spec. |
| `--workspace <dir>` | Preserve per-stimulus executor workspaces beneath this root. Defaults to temporary workspaces; set this when later validation must use actual agent-edited files. |
| `--suite <name>` | Run only stimuli matching a suite declared in `.vally.yaml`. |
| `--tag <key=values>` | Run only stimuli whose tag record matches. Comma-separate values; repeat for multiple keys. E.g. `--tag priority=p0,p1 --tag area=routing`. |
| `--model <name>` | Executor model. Overrides `defaults.model` in the spec. |
| `--judge-model <name>` | Overrides the judge used by `prompt` / `pairwise` graders. This repo explicitly sets `defaults.judge_model: gpt-5.6-sol` rather than relying on Vally's fallback. This does not select the executor or an end user's model. |
| `--runs <n>` | Override `defaults.runs` (number of executions per stimulus). |
| `--timeout <duration>` | Per-stimulus timeout (e.g. `120s`, `2m`). |
| `--workers <n>` | Parallel stimulus workers. Default 1. |
| `--max-retries <n>` | Retries for transient executor errors on single-trial stimuli. Vally disables retries when the effective run count is 2 or more. |
| `--output-dir <dir>` | Persist `results.jsonl` + `eval-results.md` to this directory. |
| `--output jsonl` | Stream JSONL records to stdout. |
| `--junit` | Write a JUnit XML report into `--output-dir` (boolean flag; default off). |
| `--skip-grade` | Execute stimuli without running graders. |
| `--skip-validate` | Skip spec validation before running. |
| `--keep-executor-session-logs` | Retain raw executor session traces in `--output-dir`. |
| `--verbose` | Print full stimulus output + grader reasoning. |

For the full surface, run `vally eval --help`, `vally lint --help`, `vally serve --help`.

## Cost / time

Each stimulus runs `defaults.runs` times (default 1 in vally; some specs override to 3). Each run is one executor call plus one judge call per `prompt` grader.

Rough budget with `executor: copilot-sdk` + `model: gpt-5-mini`:

- ~30k–80k tokens per stimulus (routing stimuli are at the lower end; deployment / orchestration stimuli with fixtures sit higher).
- ~10–45 seconds per stimulus.
- Each PR runs p0 + p1 for the skill specs it changes; the all-skill `ci-gate` suite covers the same priorities, and `nightly` adds p2.

Use `--workers 4` to fan stimuli out and shave wall-clock time; expect higher cost-per-second but the same total tokens.

## Test coverage

| Skill | Task stimuli | Routing stimuli | Focus |
|-------|--------------|-----------------|-------|
| `aspire` (router) | 2 | 23 | Routing precision to sub-skills; preserve selected release family |
| `aspire-init` | 6 | 15 | Skeleton drop, `aspire new` / `aspire init` decision, aspireify handoff |
| `aspireify` | 14 | 19 | AppHost wiring (C# / file-based C# / TS), package-manager resolution, validation, never edit `.aspire/modules/` |
| `aspire-orchestration` | 29 | 24 | Lifecycle tools, file lock recovery, `--include-hidden`, `aspire update --self` |
| `aspire-deployment` | 11 | 22 | Multi-target deploy, `aspire destroy`, JS publishing, pipeline previews |
| `aspire-monitoring` | 8 | 23 | Diagnostics bridge, standalone dashboard, browser logs, `--include-hidden` |
| `aspire-project-v2-migration` | 16 | 6 | Approval/capability stops, bounded actual edits, idempotence, and explicit migration intent |
| **Total** | **86** | **132** | **218 stimuli** |

Routing counts include `routing` in either a scalar or array `area` tag.

### Project v2 validation layers

The [migration fixture guide](./project-v2-migration/README.md) separates offline
regressions and model-backed source-edit gates from executable qualification:
compilation, runtime probes, publishing artifacts, and local image builds/smokes.
`npm test` never invokes models or starts containers. Runtime/publishing harness
development is a separate follow-up, not a dependency of the source grader.

Use the pinned Vally/Copilot runtime and existing authentication/redaction controls
below. Integration evidence is not safe to upload merely because a test passed.
Merged upstream source and a successful `aspire publish` are not, respectively,
proof of a released package or a successfully built image.

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

`vally compare --run-a <run-dir-A> --run-b <run-dir-B>` diff-prints two runs for ad-hoc regression triage without the dashboard (add `-e <spec>` to apply pairwise graders).

## Quick smoke test

```bash
# Validate every spec without running a model
vally lint skills
for spec in skills/*/evals/eval.yaml; do vally lint --eval-spec "$spec"; done

# Run just the p0 routing stimuli for the router skill (~2 minutes, ~150k tokens)
vally eval --eval-spec skills/aspire/evals/eval.yaml --tag priority=p0 --tag area=routing
```

## CI integration

The repo ships four GitHub Actions workflows that drive `vally` automatically:

| Workflow | Trigger | Command |
|----------|---------|---------|
| [`skill-lint.yml`](../.github/workflows/skill-lint.yml) | PR (`SKILL.md` / `*.yaml` / `.vally.yaml`) | `vally lint skills` + per-spec `vally lint --eval-spec <spec>` |
| [`skill-eval.yml`](../.github/workflows/skill-eval.yml) | PR (`SKILL.md` / `eval.yaml` / `.vally.yaml`) | `vally eval -e <changed-spec> [...] --tag priority=p0,p1 --runs 1 --max-retries 2 --output-dir ./results` |
| [`skill-eval-nightly.yml`](../.github/workflows/skill-eval-nightly.yml) | `cron: "0 6 * * 0"` (Sun 06:00 UTC) + `workflow_dispatch` | `vally eval --suite nightly --output-dir ./results` |
| [`skill-experiment.yml`](../.github/workflows/skill-experiment.yml) | `cron: "0 6 * * 6"` (Sat 06:00 UTC) + `workflow_dispatch` | `vally experiment run skill-lift.experiment.yaml --output-dir ./results` — informational baseline (skills vs no-skills), never gates |

The all-skill suites are declared at the repo root in [`.vally.yaml`](../.vally.yaml) and filter on the `priority` tag every stimulus carries:

```yaml
suites:
  ci-gate:
    filter:
      priority: [p0, p1]
  nightly:
    filter:
      priority: [p0, p1, p2]
```

The PR gate and main nightly suite use `vally eval --require-pass` so failed
evaluations, including authentication errors, fail their gated run. Because `--suite`
cannot be combined with explicit `-e` specs, the PR workflow discovers changed skill
specs and applies the `ci-gate`-equivalent `priority=p0,p1` filter only to them. PR
evaluations override the run count to one and allow two bounded retries so transient
executor timeouts and rate limits can recover; Vally intentionally disables those
retries for multi-trial plans. The comprehensive `nightly` suite keeps each spec's
repeated-run defaults. The comparative baseline remains informational.

## CI authentication

The `copilot-sdk` executor invokes Copilot models via [`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk) and the Copilot CLI runtime. CI uses the automatically generated, short-lived **Actions `GITHUB_TOKEN`**, not a stored personal access token (PAT). This is supported in ordinary GitHub Actions workflows; converting these evaluations to GitHub Agentic Workflows is not required.

| Context | How auth is supplied |
|---------|----------------------|
| **Local** (`vally eval ...`) | Set `COPILOT_GITHUB_TOKEN` from a Copilot-enabled `gh` login — e.g. `export COPILOT_GITHUB_TOKEN="$(gh auth token)"`. |
| **CI** (`skill-eval.yml`, `skill-eval-nightly.yml`, `skill-experiment.yml`) | Maps **`${{ github.token }}`** to **`COPILOT_GITHUB_TOKEN`** only in the evaluation and artifact-redaction steps. No repository or organization authentication secret is read. |

Each evaluation job grants only:

```yaml
permissions:
  contents: read
  copilot-requests: write
```

`copilot-requests: write` permits model requests; it does not grant repository write access. The workflow-level default remains `contents: read`, and unspecified token permissions are not granted.

### Vally authentication compatibility

Use `COPILOT_GITHUB_TOKEN: ${{ github.token }}` rather than exposing a `GITHUB_TOKEN` environment variable to Vally. Vally 0.16.0's LLM grader passes `GITHUB_TOKEN` (or `GITHUB_COPILOT_API_TOKEN`) through the SDK's explicit `gitHubToken` option. That option is for user tokens; installation tokens must use [runtime environment authentication](https://github.com/github/copilot-sdk/blob/main/docs/auth/server-to-server-tokens.md). Evaluation steps unset those overrides and `GH_TOKEN` before launching Vally. The separate PR-file-discovery step still uses `GH_TOKEN` for `gh pr diff`.

The workflows pin Vally 0.16.0 and its matching Copilot runtime 1.0.80, install them with npm lifecycle scripts disabled, and retain commit-SHA-pinned Actions. When updating these versions, exercise both the agent executor and the LLM judge; a successful CLI version check alone does not prove authentication works.

### Maintainer rollout and billing

1. Confirm the organization's **Copilot CLI > Allow use of Copilot CLI billed to the organization** policy is enabled. See [Using Copilot CLI in GitHub Actions with GITHUB_TOKEN](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli-in-actions).
2. Confirm organization-level spending controls before enabling or merging the migration. These workflows retain their automatic PR, scheduled, and manual triggers; there is no new repository opt-in. **User-level Copilot budgets do not apply to organization-billed requests.** Use organization usage monitoring and cost-center budgets, and review the existing eval run counts and concurrency. This change does not introduce a hard AI-credit cap.
3. Run a same-repository PR evaluation containing an LLM-graded stimulus, then exercise the nightly and baseline paths. Confirm successful model execution and grading, organization billing attribution, and redacted artifacts. A workflow version check or local offline test cannot verify organization policy or Actions-token authorization.
4. After successful rollout, remove the obsolete `COPILOT_GITHUB_TOKEN` secret and revoke its underlying PAT if no other consumer needs it. Removing a secret alone does not revoke a token. These workflows never fall back to that PAT.

Missing organization policy, permission, or runtime support is an authentication failure, not a successful soft-skip. The PR gate and nightly suite fail on evaluation errors; the baseline retains its existing informational behavior. `skill-lint.yml` remains independent of Copilot model access.

### Trust boundary and published results

- **Fork and Dependabot PRs remain excluded** from model-backed evaluation: they previously had no access to the Actions PAT secret. The job requires a same-repository PR and excludes both Dependabot authors and actors. Do not switch to `pull_request_target` or run fork code in a privileged follow-up workflow. Lint and offline tests still run for external contributions.
- **Same-repository PR authors and manual workflow operators remain trusted.** Skills, fixtures, and evaluation tools can execute code and read the evaluation process environment. A short-lived token limits credential lifetime and repository scope, but does not sandbox agents or prevent organization-billed misuse. Changes to workflows, skills, evals, and their dependencies still need normal maintainer review.
- **Checkout credentials are not persisted** in Git configuration. Tokens are not written to `GITHUB_ENV`, outputs, or the repository. Step-level environment scoping reduces accidental exposure; job permissions remain the actual Actions authorization boundary.
- **Artifacts and the baseline summary are published only after successful redaction**, including after failed evaluations. The shared redactor removes the literal token and common base64 representations from file contents, rejects those credentials in file or directory paths before accessing them, preserves unrelated bytes, and rejects linked/non-regular files. Cancellation or redaction failure prevents publication. This is defense in depth against accidental disclosure, not protection against malicious arbitrary encoding or exfiltration.

## Interpreting results

After a run that wrote `--output-dir ./results`, look at:

- **`results/<timestamp>/eval-results.md`** — human-readable summary table with per-stimulus verdict, grader breakdown, token usage, and footnote-style failure reasons.
- **`results/<timestamp>/results.jsonl`** — one record per stimulus run, with the full executor trajectory and every grader's reasoning. Pipe into `jq` for ad-hoc queries.
- **`vally serve ./results`** — same data, rendered as a dashboard with filtering, charts, and trajectory drill-down.

Common failure modes to grep for:

- **`skill-invocation` grader failed but the agent did invoke a skill** — the grader's `required: [...]` list is an exact match. If the agent picked a sibling skill (e.g. `aspire-orchestration` instead of `aspire`), that counts as a miss. Tune `required` to the set of acceptable skills, or switch to a `prompt` grader if "any of these N skills is fine" is the real intent.
- **`output-contains` failed despite the substring being in the output** — vally's substring grader is case-sensitive by default. Either lowercase the expected substring or set `case_sensitive: false` in the grader config.
- **`Timeout after Nms waiting for session.idle` while the agent is still doing useful work** — raise `defaults.timeout` or the per-stimulus timeout. Long-form authoring stimuli routinely need 90–120 s.
- **`Timeout after Nms waiting for session.idle` after the last tool already completed** — treat it as a transient executor stall, not evidence that the stimulus needs a longer timeout. Reproduce the PR policy with `--runs 1 --max-retries 2`; repeated-run nightly plans intentionally remain non-retryable.

The read-only router suite uses a 180-second hard timeout and 150-second agent budget:
225 successful historical router trials completed in under 90 seconds, so this leaves
headroom while making a stalled session retry much sooner than the previous 600-second wait.
