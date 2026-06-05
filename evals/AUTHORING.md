# Authoring evals

How to add or modify eval tasks for this plugin. Read [README.md](./README.md) first for how to *run* evals.

> **Why these conventions matter:** the patterns below were learned by running the suite and watching graders mis-fire. Following them keeps judges focused on the agent's response (not the input fixtures) and prevents false negatives that hide real regressions.

## Anatomy of a task file

`skills/<skill>/evals/tasks/<id>.yaml`:

```yaml
id: deploy-destroy-001                # unique within the skill, used by --task glob
name: Tear Down with aspire destroy   # human-readable title
description: >
  Agent should know `aspire destroy` (new in 13.3) tears down Azure / Kubernetes /
  Docker Compose deployments using the same WithComputeEnvironment bindings as
  `aspire deploy`.
tags:
  - core-flow
  - p1
  - aspire-13-3

inputs:
  prompt: "I'm done with this preview deployment — how do I tear down everything Aspire provisioned?"
  files:                              # paths resolve against --context-dir (this repo: evals/)
    - path: "csharp-apphost/MyApp.AppHost/MyApp.AppHost.csproj"
    - path: "csharp-apphost/MyApp.AppHost/Program.cs"
    - path: "csharp-apphost/aspire.config.json"

expected:                             # cheap pre-grader checks (string-level)
  output_contains:
    - "aspire destroy"
  output_not_contains:
    - "az group delete"
    - "kubectl delete"

graders:
  - name: uses_aspire_destroy
    type: prompt
    config:
      prompt: >
        Does the assistant's response recommend `aspire destroy` (new in Aspire 13.3)
        as the way to tear down a deployed Aspire app? Answer based on intent.

  - name: no_manual_teardown
    type: text
    config:
      not_contains:
        - "az group delete"
        - "kubectl delete"
        - "helm uninstall"
        - "docker compose down"

  - name: knows_destroy_is_cross_target
    type: prompt
    config:
      prompt: >
        The assistant's response should mention that `aspire destroy` is the inverse of
        `aspire deploy` and works across deployment targets — Azure, Kubernetes/AKS, and
        Docker Compose.
```

## Field reference

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Stable; used by `--task` glob. Convention: `<skill-prefix>-<area>-<NNN>` (e.g. `deploy-destroy-001`, `mon-bridge-001`). |
| `name` | string | Shown in result output. |
| `description` | string | Why this task exists; what behavior it validates. |
| `tags` | string[] | Used by `--tags`. Always include a priority tag (`p0`/`p1`) and at least one topical tag. Use `aspire-13-3` for new-in-13.3 behavior. |
| `inputs.prompt` | string | The user prompt the executor sends. Phrase like a real user, not like a spec. |
| `inputs.files[].path` | string | Relative to `--context-dir` (this repo: `evals/`). Reference the **shared fixtures** rather than copy-pasting per skill. |
| `expected.output_contains` | string[] | Hard pre-grader: pulled into a built-in `text` grader. Cheap correctness signal — skip if your response wording can vary. |
| `expected.output_not_contains` | string[] | Same, inverse. Be **specific** — see [Issue: over-broad `not_contains`](#issue-over-broad-not_contains). |
| `graders` | object[] | Custom graders. See below. |

## Grader types

| Type | What it does | When to use |
|------|--------------|-------------|
| `text` | Checks `contains` / `not_contains` substrings against the response. Deterministic, cheap. | Specific command strings, forbidden anti-patterns. |
| `prompt` | LLM-as-judge — runs `--judge-model` against the agent's response with your prompt. | Intent / paraphrase tolerance. Anything that requires understanding. |
| `code` | Python expression evaluated against the response (`output` variable). | Programmatic checks (regex, parse JSON, count lines). |

`eval.yaml` can also declare **top-level graders** that run on every task in the suite (used in this repo for the global `never_azd` rule on `aspire-deployment`).

## Grader patterns (do's and don'ts)

These rules emerged from a 2026-05-08 audit that fixed 56 task files. Following them prevents false negatives and judge confusion.

### ✅ DO: prefix every `prompt` grader with "the assistant's response"

Without this, judges sometimes evaluate the input fixture files instead of the agent's response and report *"no response found in workspace"* for correct outputs.

```yaml
# ✅ Good
- name: uses_aspire_destroy
  type: prompt
  config:
    prompt: >
      Does the assistant's response recommend `aspire destroy` as the way to
      tear down a deployed Aspire app?

# ❌ Bad — judge may evaluate the workspace files, not the response
- name: uses_aspire_destroy
  type: prompt
  config:
    prompt: >
      Does the response recommend `aspire destroy`?
```

### ✅ DO: split positive / negative graders

A combined "Does X recommend Y? It should NOT do Z." prompt confuses judges — they sometimes fail the grader because the negative half *is* satisfied. Split into a focused positive `prompt` grader plus a `text` `not_contains` grader.

```yaml
# ✅ Good — two narrow graders
- name: uses_aspire_destroy
  type: prompt
  config:
    prompt: >
      Does the assistant's response recommend `aspire destroy`?

- name: no_manual_teardown
  type: text
  config:
    not_contains:
      - "az group delete"
      - "kubectl delete"
      - "helm uninstall"
      - "docker compose down"

# ❌ Bad — combined positive + negative confuses the judge
- name: uses_aspire_destroy
  type: prompt
  config:
    prompt: >
      Does the response recommend `aspire destroy`? It should NOT instruct
      the user to manually run `az group delete`, `kubectl delete`,
      `helm uninstall`, or `docker compose down`.
```

### ✅ DO: be specific in `not_contains`

#### Issue: over-broad `not_contains`

Forbidding the bare substring `"azd"` will fire on legitimate "do not use azd" guidance from the agent. Forbid full command tokens.

```yaml
# ✅ Good
not_contains:
  - "azd up"
  - "azd deploy"
  - "azd init"
  - "azd provision"

# ❌ Bad — fires on the literal letters "azd" anywhere in the response
not_contains:
  - "azd"
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
- name: uses_helm_engine
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

## Trigger tests

`skills/<skill>/evals/trigger_tests.yaml` measures how well the SKILL.md description routes prompts. Each entry:

```yaml
should_trigger_prompts:
  - prompt: "Tear down my Aspire deployment"
    reason: "aspire destroy is deployment"
    confidence: high

should_not_trigger_prompts:
  - prompt: "Show me logs from my deployed app"
    reason: "Deployed monitoring routes to azure-diagnostics"
    confidence: high
```

Rules:

- **A prompt must not appear in both lists** for the same skill (and a prompt in one skill's `should_trigger` should appear in `should_not_trigger` of every sibling that might claim it).
- **`reason` must agree with the bucket.** A prompt under `should_not_trigger_prompts` whose reason says "should trigger this skill" is a misclassification — fix it.
- **Phrase like a real user.** "I want to ship this" is more realistic than "Invoke aspire deploy."
- **Confidence is informational** — `high`/`medium`/`low`. Use `high` for unambiguous routing, `medium` when the prompt could plausibly route elsewhere.

## Adding a new task — checklist

1. **Pick the right skill.** Tear-down? `aspire-deployment`. Wiring? `aspireify`. Routing? `aspire` (router).
2. **Pick or create a fixture.** Reuse `evals/csharp-apphost/`, `evals/ts-apphost/`, or `evals/non-aspire/`. Add a new fixture only if existing ones don't capture the scenario.
3. **Write a realistic prompt.** Match how a developer or AI agent would actually phrase the request — not how the spec describes it.
4. **Pick at most 3 graders:**
   - One positive `prompt` grader for intent.
   - One `text` `not_contains` for forbidden anti-patterns.
   - Optionally a second `prompt` grader for a distinct bonus expectation.
5. **Apply the grader-pattern rules** above.
6. **Tag with priority + topic** — at least one of `p0`/`p1` plus a topical tag.
7. **Run `vally lint skills/<skill>`** to confirm schema validity.
8. **Run the task once** — `vally eval --eval-spec skills/<skill>/evals/eval.yaml --task "<id>" --context-dir evals --no-cache` — to confirm it executes and the graders behave as you expect.
9. **Update the trigger tests if needed** — if the new task validates a routing decision, add matching entries in `trigger_tests.yaml`.
10. **Commit with a focused message.**

## Common pitfalls

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Grader says *"no response found in workspace"* | `prompt` grader doesn't tell the judge to look at the response | Add "the assistant's response" to the grader prompt |
| Grader fails when response is correct | Combined positive + negative in one prompt | Split into separate `prompt` + `text` graders |
| `not_contains` fires on legitimate guidance | Substring is too broad (e.g., `"azd"`) | Forbid full commands (`"azd up"`, `"azd deploy"`) |
| Judge rejects response as outdated | Stale model knowledge of Aspire 13.3 | State the 13.3 fact in the grader prompt |
| Trigger accuracy below threshold | Description too dense, keywords don't match how users phrase it, or trigger prompts are too generic | Refine SKILL.md `description` triggers and / or trigger_tests.yaml prompts; iterate |
| `vally eval --task "name"` matches 0 tests | `--task` filters by `id`, not `name` | Use the `id:` field with a glob (e.g., `--task "deploy-destroy*"`) |
| Task hangs forever | `config.timeout_seconds` too low for slow models, or judge model unreachable | Raise `timeout_seconds` in `eval.yaml`; check `--judge-model` is available |

## When to update `eval.yaml`

The per-skill `eval.yaml` controls thresholds, model, and top-level graders. Update it when:

- A new metric is needed (e.g., `correctness_after_13_3`). Declare under `metrics:` with a weight and threshold.
- The skill ships a new globally forbidden pattern. Add a top-level `text` `not_contains` grader.
- You need a different default model — but prefer overriding via `--model` on the CLI for ad-hoc runs.

Don't touch `tasks: ["tasks/*.yaml"]` — leave it as the wildcard.

## See also

- [README.md](./README.md) — how to run evals
- [vally CLI](https://www.npmjs.com/package/@microsoft/vally-cli)
- [agentskills.io spec](https://agentskills.io) — frontmatter and SKILL.md rules vally checks against
