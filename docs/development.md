# Development

Use Node.js 22 or later, Git, GitHub CLI, and Bash 4 or later available as `bash`
on `PATH`. Workflow-script tests use recursive globs, which macOS's system Bash
does not support. On macOS, install Bash with `brew install bash` and prepend
`$(brew --prefix bash)/bin` to `PATH`. On Windows, use Git Bash.

Create feature branches from `dev` and target contributor PRs at `dev`.
Before opening a PR, run:

```powershell
npm ci --ignore-scripts
npm test
```

See [CONTRIBUTING.md](../CONTRIBUTING.md) for skill formatting and agent-host checks.
Set `CHROME_BIN` to a Chromium executable when running `npm test` to include the
AppHosts native-browser number-input regression; without it, that check is skipped.
Dev retains `CHANGELOG.md` and generated `opencode/` catalogs. Regenerate catalogs
with `npm run catalog` after changing shipped skills, references, or assets,
and commit them with the source changes. Run `npm run catalog:check` to check
the committed tree. CI rejects missing, extra, or stale V1 and V2 catalog files.
Add only consumer-facing changes to the current changelog entry; preserve earlier
entries and the coordinated version.

Canvas extensions serve canonical theme and icon assets directly and retain
relative Git symlinks for packagers. Edit the canonical files directly; no
synchronization step is needed.
See [Shared canvas UI](canvas-ui.md) for token ownership, typography, icons,
standalone packages, plugin mirrors, and visual review.

The **Tests** workflow runs its three-OS matrix on PRs targeting main, dev, or
release branches, and on pushes to main or dev. Release-branch pushes rely on PR
checks instead of triggering a duplicate matrix.

The **OpenCode catalog check** runs on every PR, including stacked PRs, on
main/dev/release pushes, and on merge-queue candidates.

The **Release branch check** fails any PR into main unless its head is a
`release/<version>` branch in this repository.

## Expected release flow

1. **Cut the release.** Create `release/<version>` at the chosen dev commit.
2. **Advance dev.** Create `bump-dev/<next-version>` from current dev, run
   `npm run version:dev -- <next-version>`, and open a PR to dev. The command
   updates coordinated versions, adds the new changelog heading without changing
   existing entries, and regenerates catalogs.
3. **Prepare the candidate.** Backport needed fixes, finalize the changelog,
   regenerate catalogs with `npm run catalog`, and run `npm test`.
4. **Release to main.** Open the release PR to main. Maintainers approve and
   merge it; the publisher tags the exact merged commit, creates the GitHub
   release from the approved changelog notes, and uploads no generated archives.
5. **Merge back to dev.** Create `backport/pr-<release-pr>-to-dev` from current
   dev and merge main into it. Keep dev's next version and newer work, preserve
   non-version manifest changes and dev's current changelog entry, update earlier
   entries from main's approved changelog, and regenerate catalogs. Open a PR to dev
   and merge it with a merge commit.

## Publication

`.github/workflows/publish.yml` runs when a same-repository `release/*` PR
merges into main. It uses the event's `merge_commit_sha`, reruns the source,
catalog, and version checks, then tags that commit and creates a source-only
GitHub release from the approved changelog notes.

Publishing uses `GITHUB_TOKEN`; no repo bot or stored automation credentials
are needed. Maintainers create PRs and approve merges. Tags and releases are
published in the same run because workflow-token tag pushes do not trigger
another workflow. Reruns must preserve the tag's commit and approved notes.

## Aspire telemetry maintenance

The [update-aspire workflow](../.github/workflows/update-aspire.md) keeps Aspire CLI
telemetry for aspire-skills usage up to date, including which skills and extension
tools agents invoke.
It creates draft proposals with one isolated build/test attempt. Candidate build
and test failures are reported in the draft or no-op summary; verifier setup,
isolation, and security failures block publication.

## Upstream Aspire skills assessment (preparatory)

Issue #77 has a separate, **upstream-to-skills** workflow:
[`upstream-skill-assessment.yml`](../.github/workflows/upstream-skill-assessment.yml).
It polls merged PRs in `microsoft/aspire` targeting `main` or `release/*` and
assesses guidance here, against an immutable snapshot of `aspire-skills` **dev**.
The telemetry workflow above runs in the **opposite** direction; neither its
trigger nor its publisher is reused.

**Readiness boundary:** this is a draft-scoped preparatory implementation.
No authenticated, end-to-end hosted agent run has been verified as part of this
change. It has **no write/publish job**, and does not apply skill patches, open
PRs/issues, or mark evaluations as passing. Validated JSON shape and exact source
quotes are provenance checks, not proof of API semantics or passing skill evals.
The bounded, tool-free agent adapter uses the SDK/runtime versions already used
by the skill-evaluation stack; its mocked contract tests are not a hosted smoke
test. Maintainers must verify runtime/authentication before treating its output
as an operational assessment.
The functional agent prompt is
[`upstream-skill-assessment.txt`](../.github/prompts/upstream-skill-assessment.txt);
the workflow is standard YAML, with no new Markdown workflow or design files.
Deterministic source-path checks only prefilter evidence. When enabled, Copilot
performs the two-pass routing/semantic assessment; without it, candidates are
explicitly blocked, not replaced with keyword-derived guidance.

### Activation and credentials

1. Land the workflow, helper scripts and text prompt on the repository's **default branch**.
   Scheduled workflows only run there; `workflow_dispatch` must also exist there
   before GitHub exposes it. This workflow additionally rejects non-default-branch
   runs, so merging to dev alone does **not** activate it or permit a first smoke
   run. Do not bypass this with `pull_request_target` or an upstream webhook.
2. Leave `UPSTREAM_SKILL_ASSESSMENT_ENABLED` unset until a maintainer has inspected
   a manual run. Manual dispatch is allowed independently; setting this repository
   variable to `true` enables six-hourly polling, with a 48-hour overlapping window.
3. Without `UPSTREAM_SKILL_AGENT_ENABLED=true` **and** a nonempty
   `UPSTREAM_SKILL_MODEL` repository variable naming an enabled Copilot model,
   manual runs only collect evidence and produce **blocked** handoffs. They do
   not pretend an agent ran or record candidates as completed. After enabling,
   verify a small manual PR assessment before enabling polling.
4. The workflow uses `GITHUB_TOKEN` with `contents: read`, `pull-requests: read`,
   `actions: read` (prior state artifacts), and `copilot-requests: write` (model
   inference only, as in Skill Eval). Public upstream reads need no upstream
   webhook, PAT, GitHub App, or cross-repository write access. Repository Actions
   policy, organization Copilot/model access and billing must permit this token
   and pinned runtime installation. These settings are **not assumed configured**.
   Missing runtime/auth/model support blocks or triages the assessment; it never
   permits publication. No existing telemetry App secrets are used.

Runtime and activation contracts:
[pinned Copilot SDK](https://github.com/github/copilot-sdk/blob/v1.0.11/nodejs/README.md),
[Actions events/default-branch rules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows),
and [GITHUB_TOKEN permissions](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token).

The agent receives only bounded snapshots, with no tools, MCP servers, loaded
skills/config discovery, shared session store, logged-in-user fallback, or
permission approvals. Upstream code is **read**, never checked out or executed.
PR text/diffs and source files are untrusted evidence, not instructions. Model
responses cannot name arbitrary paths, execute commands, or grant permissions.
Only fixed summary counters appear in the run summary; raw model/source text is
kept in the review artifact.

### Bounds, replay and human handoff

- Manual input selects **one merged upstream PR**, including historical PRs, or
  both `since` and `until` UTC timestamps (`YYYY-MM-DDTHH:mm:ssZ`), spanning at most
  seven days and ending in the past. With neither, it uses 48 hours. The run's
  original creation time freezes the default window on reruns.
- One complete search response is limited to 100 merged PRs. Incomplete/truncated
  search fails closed with instructions to narrow the window. Search hits are
  re-read and checked for repository, merged state, branch, timestamp and SHA.
  At most five relevant PRs enter the agent; larger batches are blocked for manual
  scoping, not presented as an exhaustive assessment.
- Only `src/Aspire.Cli/`, `src/Aspire.Hosting*/` and `src/Aspire.AppHost.Sdk/`
  source changes are candidates. Other merges are recorded as no-ops without
  model calls or PR noise. This intentionally conservative path classifier can
  miss changes elsewhere: maintainers must review its coverage as Aspire evolves.
  Each PR is limited to 100 changed files, six relevant source files, four changed
  test files, 48 KiB per full source/test file, 256 KiB combined full evidence,
  128 KiB combined patches and a 16 KiB PR body. Unsupported, removed, renamed,
  binary, missing or oversized evidence goes to human triage, never truncated
  semantic inference.
- Evidence records canonical source PR links, reported base/head SHAs, immutable
  merge SHA and merge time, target main/release branch, full source/test snapshots,
  blob SHAs, content digests and commit-pinned source links. `main` is unreleased;
  a release branch **does not establish a published version**. Release evidence
  explicitly leaves shipping release unknown. Advice needing an unknown release
  or uncertain behavior must become a triage question.
- Routing sees the canonical Markdown inventory and skill entrypoints, then
  selects at most six documents for assessment. Draft suggestions are limited to
  three exact replacements in existing selected skill Markdown files. Each
  requires exact quotes from **both full source and changed tests** at the merge
  SHA. Diff-only claims, fabricated citations, stale original text, unsafe paths,
  unknown output types and malformed/oversized model responses cannot become drafts.
- `upstream-assessment-review` contains `evidence.json` and `review.json` with
  `noop`, `triage`, `blocked`, `duplicate`, or **unvalidated draft** outcomes.
  Uncertain items include maintainer questions, not invented guidance or automatic
  issues. Maintainers must inspect these artifacts; no notification service is
  configured. A failed runtime request produces triage, not a passing assessment.
- `upstream-assessment-state` retains completed source identities (repository,
  PR, merge SHA and target branch) via a hash for fourteen days after assessment, capped
  at 2,000 entries. The latest available successful default-branch run is restored;
  prior-attempt state takes precedence on reruns. Runs are serialized. Main and
  release backports remain distinct. Explicit `reassess=true` revisits recorded
  triage/no-op/draft outcomes. Blocked setup/budget outcomes remain retryable.
  Artifacts expire after 90 days; missing/expired state can repeat **analysis**,
  but cannot duplicate PRs because there is no publisher. Poll delays, outages
  beyond 48 hours, or older historical replays require a manual window/PR.

### Turning a handoff into a reviewed change

1. Inspect the complete source PR, commit-pinned implementation/tests, target
   branch/release evidence and proposed replacements. Resolve triage questions
   with an Aspire maintainer or authoritative documentation; do not infer missing
   semantics or a shipping version from PR prose alone.
2. On a contributor branch from the recorded dev base (or reassess if stale),
   apply only confirmed guidance updates. Add relevant regression tests/evals,
   regenerate catalogs (`npm run catalog`), and run the applicable existing Node
   tests, skill lint, catalog checks and affected-skill agent-host evals described
   above and in CONTRIBUTING.md. Record exact commands/results; suggestions in an
   artifact are **not** executed validation.
3. Preview the **exact outbound title/body/diff** with the maintainer before any
   publication. The eventual **draft PR to dev** must link source PR(s), source
   merge SHA(s), branch/release evidence, affected API/CLI command and compatibility
   range (or explicitly unknown), rationale, and actual test/eval results. Search
   existing open **and closed** PRs for the source identity before creating one;
   update the existing handoff rather than duplicating it.
4. Require maintainer review and normal repository checks before merging. Existing
   release flow, not this assessor, publishes skill updates. Automated patch
   application/draft-PR creation is deliberately deferred until a separate,
   validated, least-privilege writer with durable open/closed-PR deduplication
   and an approved outbound preview is implemented and verified.

Local deterministic checks (no model credentials or upstream writes):

```powershell
node --test tests/upstream-skill-assessment.test.mjs
```
