# CI overview

This repo runs three GitHub Actions workflows. They map onto the three tiers of
quality gating discussed in the [evals authoring guide](../evals/AUTHORING.md):

| Workflow | Trigger | What it does | Cost |
|---|---|---|---|
| [`lint.yml`](../.github/workflows/lint.yml) | every PR + push to `main` | Schema / structural lint of all skills + eval YAML. No LLM calls. | Free, ~30 s |
| [`eval-p0.yml`](../.github/workflows/eval-p0.yml) | PR (internal only) when `skills/`, `evals/`, or plugin manifests change | Runs `waza --tags p0` (the ship-blocking subset) and posts a PR comment. | ~10–20 tasks × 3 trials, ~15–25 min |
| [`eval-manual.yml`](../.github/workflows/eval-manual.yml) | `workflow_dispatch` only | Maintainer-triggered eval against a specific reviewed SHA. Used for fork PRs. | Variable |
| [`eval-full.yml`](../.github/workflows/eval-full.yml) | weekly (Mon 08:00 UTC) + `workflow_dispatch` | Runs the entire suite. Opens / appends a tracking issue on failure. | All ~56 tasks × 3 trials |

## Why the split?

A full eval run is ~3 hours and burns Copilot API quota; running it on every
push is wasteful and slow. Lint catches structural mistakes for free, p0 catches
the bugs that matter most on every PR, and the weekly full run catches drift
across the long tail.

## Fork PR flow

Eval workflows do **not** run automatically on PRs from forks. This is a
deliberate security boundary:

- A malicious fork PR could include a fixture or task prompt designed to
  jailbreak the executor or burn API quota.
- The default `GITHUB_TOKEN` from a fork is read-only, but it still consumes
  Copilot entitlement and runner minutes.

The `eval-p0` workflow detects fork PRs and posts a comment pointing the
contributor to the manual flow. After reviewing the diff, a maintainer runs
the [`Eval (manual)`](../.github/workflows/eval-manual.yml) workflow:

1. Open **Actions → Eval (manual) → Run workflow**.
2. Paste the **exact commit SHA** they reviewed (not a branch name — branches
   can be force-pushed between review and run).
3. Optionally pass the PR number so the result is commented on the PR.

## Secrets

Both eval workflows use the auto-issued `GITHUB_TOKEN` to authenticate the
`copilot-sdk` executor. Per
[microsoft/waza/docs/SKILLS_CI_INTEGRATION.md](https://github.com/microsoft/waza/blob/main/docs/SKILLS_CI_INTEGRATION.md),
that's the supported flow for the in-CI Copilot SDK executor in
GitHub-hosted org repos.

If a dedicated entitlement token becomes necessary (e.g. quota separation):

1. Add a repo secret named `COPILOT_TOKEN`.
2. In each workflow, replace `secrets.GITHUB_TOKEN` with `secrets.COPILOT_TOKEN`
   in the `env:` block of the run step.
3. Do **not** expose the secret to fork-triggered jobs.

If the judge model moves to Azure OpenAI:

1. Use OIDC federated identity (`azure/login` action with `id-token: write`).
2. Do **not** store an Azure OpenAI API key as a long-lived repo secret.
3. The `permissions:` block of the eval job needs `id-token: write` added.

## Security model summary

| Concern | Mitigation |
|---|---|
| Code execution from fork PR | `pull_request` (never `pull_request_target`); eval jobs gated to internal PRs |
| Stale approval / force-push | Manual flow uses pasted SHA, not branch name |
| Token scope | Per-job `permissions:` (write only on the comment job) |
| Supply chain (third-party actions) | All actions pinned to commit SHAs; Dependabot will keep current |
| Supply chain (waza binary) | `WAZA_VERSION` pins the install script URL to an immutable tag |
| Cost / quota burn | `--tags p0` for PR runs, `concurrency: cancel-in-progress`, `timeout-minutes`, path filters |
| Prompt-injected fixtures | CODEOWNERS requires owner review on `evals/` and `skills/*/evals/`; eval cannot reach an LLM on a fork PR |
| Workflow tampering | CODEOWNERS requires owner review on `.github/workflows/` |

## Recommended repo settings (cannot be set via PR)

These belong in **Settings → Actions** and are listed here so they don't get
lost:

- **Fork pull request workflows from outside collaborators** → `Require approval
  for first-time contributors who are new to GitHub` (or stricter).
- **Workflow permissions** → `Read repository contents and packages
  permissions` (default to read-only).
- **Allow GitHub Actions to create and approve pull requests** → off.
- Promote `Lint / structural-lint` to a required status check on `main` after
  the first green run.
- Promote `Eval (p0) / waza --tags p0` to a required status check after
  ~1–2 weeks of observation (watch flake rate first).

## Updating the waza pin

Bumping waza is a deliberate, reviewable change:

1. Update `WAZA_VERSION` in all three eval workflows (find/replace).
2. Run `eval-manual.yml` on `main` (no PR number) to smoke-test.
3. Open a PR — the change touches `.github/workflows/`, which is
   CODEOWNER-protected.
