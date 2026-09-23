# Authoring evals

How to add or modify eval stimuli for this plugin. Read [README.md](./README.md) first for how to *run* evals.

> **Why these conventions matter:** the patterns below were learned by running the suite and watching graders mis-fire. Following them keeps judges focused on the agent's response (not the input fixtures) and prevents false negatives that hide real regressions.

## Anatomy of a stimulus

Stimuli are declared **inline** in `skills/<skill>/evals/eval.yaml` under the top-level `stimuli:` array. There is no `tasks/<id>.yaml` file and no `--context-dir` flag — both were removed when the suite moved to vally's canonical `EvalSchema`.

```yaml
stimuli:
  - name: deploy-destroy-001              # unique within the spec
    prompt: >                             # phrase like a real user, not a spec
      I'm done with this preview deployment — how do I tear down everything
      Aspire provisioned?
    rubric:
      - The assistant's response recommends Aspire-native teardown with aspire destroy.
    tags:                                 # record; merged over eval-level tags
      priority: p1
      area:
        - core-flow
        - 13-3
    environment:
      files:                              # { src, dest } pairs (see field reference)
        - src: ../../../evals/csharp-apphost/MyApp.AppHost/Program.cs
          dest: csharp-apphost/MyApp.AppHost/Program.cs
        - src: ../../../evals/csharp-apphost/aspire.config.json
          dest: csharp-apphost/aspire.config.json
    graders:
      - type: prompt
        name: uses-aspire-destroy
        config:
          prompt: >
            Does the assistant's response recommend `aspire destroy` (new in
            Aspire 13.3) as the way to tear down a deployed Aspire app? Answer
            based on intent.
      - type: output-not-contains
        name: no-manual-teardown
        config:
          substring: "az group delete"
      - type: skill-invocation
        name: routes-to-deployment
        config:
          required: [aspire-deployment]
```

> **Skills must be declared.** As of vally 0.8.0 a run loads **no skills** unless the spec sets a top-level `environment.skills` list. See [README → Skills & baselines](./README.md#skills--baselines-vally-080) for the hybrid-loading convention this repo follows.

## Stimulus field reference

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Unique within the spec; shown in result output and usable for filtering. Convention: `<skill-prefix>-<area>-<NNN>` (e.g. `deploy-destroy-001`, `mon-bridge-001`). |
| `prompt` | string | The user prompt the executor sends. Phrase like a real user, not like a spec. |
| `tags` | record | Merged over the eval-level `tags`. Always include a `priority` (`p0`/`p1`/`p2`) and at least one `area` (a single value or a list). |
| `environment.files[]` | `{ src, dest }[]` | `src` resolves **relative to the eval spec file** (shared fixtures: `../../../evals/<fixture>`); `dest` is the workspace-relative path the executor sees. Reference the **shared fixtures** rather than copy-pasting per skill. |
| `environment.skills[]` | string[] | (Optional) skill dirs to **add** for this stimulus on top of the eval-level set — used by routing stimuli to pull in siblings. Union-merged during normal eval runs; experiment variants replace the resolved list wholesale. |
| `constraints.max_agent_duration` | string | (Optional) constrain agent execution duration. Use a `skill-invocation` grader for skill activation assertions. |
| `graders[]` | object[] | One or more graders. See below. |
| `scoring` | object | (Optional) per-grader weights + pass threshold. Omitted → equal weights, threshold `1.0` (every grader must pass). |

## Grader types

Each grader has a `type`, an optional `name`, and a `config`. The types this suite uses:

When supplied, grader names must match `[a-z0-9][a-z0-9-]{0,59}`: use lowercase letters, digits, and hyphens, not underscores. Names must be unique across the entire eval file, not just within each stimulus; add a descriptive or numeric suffix when repeating an assertion. Vally 0.16.0 rejects invalid or duplicate grader names before executing any trials. This restriction applies to grader names, not stimulus names.

| Type | What it does | `config` keys | When to use |
|------|--------------|---------------|-------------|
| `prompt` | LLM-as-judge — runs `--judge-model` against the agent's response with your rubric. | `prompt` | Intent / paraphrase tolerance. Anything that needs understanding. |
| `output-contains` | Substring must appear in the response. Deterministic, cheap. | `substring` | A specific command string that must be present. |
| `output-not-contains` | Substring must **not** appear. | `substring` | A forbidden anti-pattern (be specific — see below). |
| `output-matches` | Regex match against the response. | `pattern` | Patterned correctness (e.g. a flag with any value). |
| `skill-invocation` | Asserts which skill(s) the agent activated. | `required` and/or `disallowed` | **Routing** — the primary mechanism here (replaces the old `trigger_tests.yaml`). |
| `pairwise` / `panel` | Compare two runs / judge with a panel of models. | varies | Regression comparisons; higher-confidence judging. |

Other static graders exist (`file-exists`, `file-contains`, `file-matches`, `tool-call`, `run-command`, `program`, `metric-threshold`); run `vally lint --eval-spec <spec>` and see the [vally docs](https://www.npmjs.com/package/@microsoft/vally-cli) for the full set.

`eval.yaml` can also declare **top-level graders** that run on every stimulus in the spec (used in this repo for the global `never-azd` rule on `aspire-deployment`).

New `prompt` graders need a stimulus-level `rubric` containing the scored
criteria. `config.prompt` adds judge instructions; without a rubric, Vally uses
default criteria and emits a warning. Grader-only examples below assume an
appropriate rubric on the containing stimulus.

## Grader patterns (do's and don'ts)

These rules emerged from a 2026-05-08 audit that fixed 56 task files. Following them prevents false negatives and judge confusion.

### ✅ DO: prefix every `prompt` grader with "the assistant's response"

Without this, judges sometimes evaluate the input fixture files instead of the agent's response and report *"no response found in workspace"* for correct outputs.

```yaml
# ✅ Good
- name: uses-aspire-destroy
  type: prompt
  config:
    prompt: >
      Does the assistant's response recommend `aspire destroy` as the way to
      tear down a deployed Aspire app?

# ❌ Bad — judge may evaluate the workspace files, not the response
- name: uses-aspire-destroy
  type: prompt
  config:
    prompt: >
      Does the response recommend `aspire destroy`?
```

### ✅ DO: split positive / negative graders

A combined "Does X recommend Y? It should NOT do Z." prompt confuses judges — they sometimes fail the grader because the negative half *is* satisfied. Split into a focused positive `prompt` grader plus a `text` `not_contains` grader.

```yaml
# ✅ Good — two narrow graders
- name: uses-aspire-destroy
  type: prompt
  config:
    prompt: >
      Does the assistant's response recommend `aspire destroy`?

- name: no-az-group-delete
  type: output-not-contains
  config:
    substring: "az group delete"

# ❌ Bad — combined positive + negative confuses the judge
- name: uses-aspire-destroy
  type: prompt
  config:
    prompt: >
      Does the response recommend `aspire destroy`? It should NOT instruct
      the user to manually run `az group delete`, `kubectl delete`,
      `helm uninstall`, or `docker compose down`.
```

### ✅ DO: be specific in `not_contains`

#### Issue: over-broad `not_contains`

Forbidding the bare substring `"azd"` will fire on legitimate "do not use azd" guidance from the agent. Forbid full command tokens — one `output-not-contains` grader per token.

```yaml
# ✅ Good — specific command tokens
- { type: output-not-contains, name: no-azd-up,      config: { substring: "azd up" } }
- { type: output-not-contains, name: no-azd-deploy,  config: { substring: "azd deploy" } }
- { type: output-not-contains, name: no-azd-provision, config: { substring: "azd provision" } }

# ❌ Bad — fires on the literal letters "azd" anywhere in the response
- { type: output-not-contains, name: no-azd, config: { substring: "azd" } }
```

The same applies to bare `"docker"`, `"kubectl"`, `"helm"` — agents will mention them in valid context (e.g., "Aspire generates a Helm chart; you do not need to run `helm install` yourself"). Forbid the **action** (`docker compose down`, `kubectl apply`, `helm install`), not the noun.

### ✅ DO: keep grader prompts short and focused

A grader that checks one thing scores cleanly. A grader that bundles a checklist of 5 bullet points loses signal — pass/fail becomes opaque.

### ✅ DO: tag graders with realistic intent

Use `Answer based on intent.` (or similar) at the end of `prompt` grader prompts so judges don't enforce exact-string matching of your example phrasing.

### ❌ DON'T: rely on judge knowledge of Aspire 13.3

The judge model (typically `gpt-4.1`) may have stale Aspire knowledge. If your grader hinges on a 13.3 fact, **state the fact in the grader prompt** so the judge doesn't reject a correct response as wrong.

```yaml
# ✅ Good — grader teaches the judge
- name: uses-helm-engine
  type: prompt
  config:
    prompt: >
      Aspire 13.3 added a Helm-based Kubernetes deployment engine: declaring
      `AddKubernetesEnvironment` and running `aspire deploy` generates and
      applies a Helm chart end-to-end. Does the assistant's response use this
      native flow rather than telling the user to run `kubectl apply` by hand?
```

### ❌ DON'T: copy fixtures per skill

Use the shared `evals/` directory at the repo root. Cross-skill fixture drift defeats the point of a shared baseline.

## Routing assertions (`skill-invocation`)

Routing is graded **inline** with the `skill-invocation` grader (there is no separate `trigger_tests.yaml`). It inspects which skill(s) the agent activated and passes when the `required` set was invoked and none of the `disallowed` set were:

```yaml
# In the router spec, a prompt that must land on aspire-deployment and must NOT
# be poached by aspire-monitoring:
- name: route-teardown-001
  prompt: "I want to tear down everything I deployed for this preview."
  tags: { priority: p0, area: routing }
  graders:
    - type: skill-invocation
      name: routes-to-deployment
      config:
        required: [aspire-deployment]
        disallowed: [aspire-monitoring]
```

Rules:

- **Routing stimuli must load the full skill set** so the decision is made against real siblings — add the siblings via stimulus-level `environment.skills` (union-merged on top of the eval-level list). See [README → Skills & baselines](./README.md#skills--baselines-vally-080).
- **A skill cannot be in both `required` and `disallowed`** (vally errors). Every skill in `required` must be invoked. For an "any of these N is fine" intent, use a rubric-backed `prompt` grader rather than requiring them all.
- **Pair routing with a content check.** `skill-invocation` proves *which* skill ran; add a `prompt` or `output-contains` grader if the *answer* also matters.
- **Do not use `constraints.expect_skills` / `reject_skills`.** Vally 0.16.0 removed these fields. Express the same requirements with `skill-invocation` grader `config.required` / `config.disallowed`; extend an existing invocation grader instead of duplicating it.
- **Mirror the host activation policy without naming the owner.** The Copilot SDK eval harness lists skills but does not require matching-skill activation. Positive gated routing prompts use a neutral "invoke the matching available Aspire skill or skills" preamble; keep the scenario itself natural and never name the expected specialist.
- **Phrase like a real user.** "I want to ship this" is more realistic than "Invoke aspire deploy."

## Adding a new stimulus — checklist

1. **Pick the right skill.** Tear-down? `aspire-deployment`. Wiring? `aspireify`. Routing? `aspire` (router).
2. **Pick or create a fixture.** Reuse `evals/csharp-apphost/`, `evals/ts-apphost/`, or `evals/non-aspire/`. Add a new fixture only if existing ones don't capture the scenario.
3. **Write a realistic prompt.** Match how a developer or AI agent would actually phrase the request — not how the spec describes it.
4. **Pick at most 3 graders:**
   - One positive `prompt` grader for intent.
   - One `output-not-contains` for a forbidden anti-pattern (one substring each).
   - Optionally a `skill-invocation` grader for the routing decision, or a second `prompt` grader for a distinct bonus expectation.
5. **Apply the grader-pattern rules** above.
6. **Tag with priority + area** — at least one of `p0`/`p1`/`p2` plus a topical `area`.
7. **Confirm skills are loaded** — the spec's `environment.skills` must include the skill under test (capability) or the full set (routing). See [README → Skills & baselines](./README.md#skills--baselines-vally-080).
8. **Run `vally lint --eval-spec skills/<skill>/evals/eval.yaml`** to confirm schema validity (or `vally lint skills` for all).
9. **Run the stimulus once** — `vally eval --eval-spec skills/<skill>/evals/eval.yaml --tag <key>=<value> --runs 1` (with `COPILOT_GITHUB_TOKEN` set) — to confirm it executes and the graders behave as you expect. `--tag` filters by the stimulus's `tags` record.
10. **Commit with a focused message.**

## Common pitfalls

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Every stimulus runs with **no skill loaded** (`Skills used 0`) | Spec is missing top-level `environment.skills` (vally 0.8.0 default) | Declare `environment.skills` — see [README → Skills & baselines](./README.md#skills--baselines-vally-080) |
| Grader says *"no response found in workspace"* | `prompt` grader doesn't tell the judge to look at the response | Add "the assistant's response" to the grader prompt |
| Grader fails when response is correct | Combined positive + negative in one prompt | Split into a focused `prompt` grader + `output-not-contains` grader(s) |
| `output-not-contains` fires on legitimate guidance | Substring is too broad (e.g., `"azd"`) | Forbid full commands (`"azd up"`, `"azd deploy"`) |
| Judge rejects response as outdated | Stale model knowledge of Aspire 13.x | State the fact in the grader prompt |
| `skill-invocation` grader misses | Required skill wasn't loaded for that stimulus, or a sibling was picked | Ensure the routing stimulus loads the full set via `environment.skills`; tune `required`/`disallowed` |
| Stimulus times out while still making progress | `defaults.timeout` too low for slow models, or judge model unreachable | Raise `defaults.timeout` (e.g. `"180s"`) or the per-stimulus `timeout`; check `--judge-model` is available |
| Stimulus times out after its last tool completed | Transient executor/session stall | Reproduce the PR policy with `--runs 1 --max-retries 2`; do not lengthen an already-idle 600-second wait |

## When to update `eval.yaml` defaults

The per-skill `eval.yaml` `defaults` block controls model, executor, runs, and timeout; the top level also holds `environment.skills`, `scoring`, and any spec-wide graders. Update it when:

- The skill's dependency closure changes — adjust `environment.skills`.
- The skill ships a new globally forbidden pattern — add a top-level `output-not-contains` (or `prompt`) grader so it runs on every stimulus.
- You need different scoring weights or a pass threshold — add a `scoring` block (omitted → equal weights, threshold `1.0`).
- You need a different default model — but prefer overriding via `--model` on the CLI for ad-hoc runs.

## See also

- [README.md](./README.md) — how to run evals
- [vally CLI](https://www.npmjs.com/package/@microsoft/vally-cli)
- [agentskills.io spec](https://agentskills.io) — frontmatter and SKILL.md rules vally checks against
