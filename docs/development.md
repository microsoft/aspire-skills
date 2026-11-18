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

## Upstream Aspire skills assessment

Issue #77 uses the separate **upstream-to-skills**
[`upstream-skill-assessment.yml`](../.github/workflows/upstream-skill-assessment.yml).
It polls merged `microsoft/aspire` PRs targeting `main` or `release/*`, assesses
immutable guidance from **dev**, validates grounded documentation replacements,
and offers **draft PRs to dev** behind an exact-preview approval gate.
The telemetry workflow above runs in the opposite direction and is not reused.

### Activation, hosted smoke and credentials

1. Follow the normal reviewed **dev → release branch → main** release flow.
   The workflow and helpers must reach the repository's **default branch**
   before schedules or dispatch can activate them. Merging to dev alone does
   **not** activate anything. Non-default-branch runs are rejected; do not bypass
   this using `pull_request_target` or an upstream webhook.
2. Leave `UPSTREAM_SKILL_ASSESSMENT_ENABLED` and `UPSTREAM_SKILL_PUBLISH_ENABLED`
   unset initially. Configure `UPSTREAM_SKILL_AGENT_ENABLED=true` and
   `UPSTREAM_SKILL_MODEL` to an organization-enabled Copilot model.
   Repository Actions policy, Copilot/model access and billing must allow the
   pinned SDK/runtime and `GITHUB_TOKEN` inference. These are external setup
   requirements, not assumed capabilities.
3. Manually dispatch one historical merged source PR with `smoke_only=true`.
   This executes a real tool-free model request, checks its response, and then
   assesses the source without applying patches or publishing. Require
   `runtime: started` and `smoke: passed` in the review artifact. An offline SDK
   contract test is **not** evidence of successful hosted authentication.
4. Configure the `upstream-skill-publication` environment **before** enabling
   publication: required maintainer/team reviewers, prevent self-review,
   administrator bypass disabled, and selected deployment branches restricted
   to exactly the default branch (branch rule, not tag rule). The read-only
   preflight checks these settings through GitHub APIs and fails if absent,
   unreadable or permissive; it does not create/configure an environment.
5. The publisher uses the existing `ASPIRE_BOT_APP_ID` and
   `ASPIRE_BOT_PRIVATE_KEY` secret naming convention. Its GitHub App installation
   must include **aspire-skills** with contents and pull requests write access.
   The issued installation token is narrowed to **only aspire-skills** and those
   two permissions, is obtained only after environment approval, and is revoked
   by the token action. No upstream write access, general PAT, workflow write
   permission or model credential is given to the writer. Existing secret names
   do not prove that the installation has the required access.
6. Dispatch again without `smoke_only`. Inspect actual validation logs and the
   exact `preview.txt` title/body/diff. Set `UPSTREAM_SKILL_PUBLISH_ENABLED=true`
   only when ready for gated draft creation. Approve the artifact-linked
   environment deployment **only after reviewing that exact run/attempt and
   publication.json SHA-256**. Disabled/missing gates fail explicitly; candidate
   drafts remain retryable. After a successful manual run, setting
   `UPSTREAM_SKILL_ASSESSMENT_ENABLED=true` enables six-hourly polling.

**Hosted setup remains blocked until a maintainer completes these steps.**
Read-only inspection on 2026-11-18 found no `upstream-skill-publication`
environment and no repository variable names. The existing `copilot` environment
had no reviewers and allowed administrator bypass; `github-pages` had only a
branch policy. Neither satisfies this publisher's human-approval gate.
Only the secret names `ASPIRE_BOT_APP_ID`, `ASPIRE_BOT_PRIVATE_KEY` and
`COPILOT_GITHUB_TOKEN` were visible; no values were read. Reading the repository's
workflow-permissions policy returned HTTP 403, so no PR-creation policy was
verified. The writer deliberately uses a scoped App token, not an assumed
write-capable workflow token; its actual installation and write access still
require maintainer verification. Local/mock verification is not a successful
hosted publication smoke, and none of these findings authorizes settings changes.

The assessment/validation job has `contents: read`, `pull-requests: read`,
`actions: read` (state artifacts), and `copilot-requests: write` (inference).
Upstream public evidence needs no webhook or cross-repository credential.
The writer runs on a **fresh runner**, checks out only the trusted workflow SHA,
downloads only the current run/attempt artifact, and verifies its digest,
repository, workflow, event, branch, run, attempt and SHA before obtaining a
writer token. A pure-data patch applier verifies the exact preview against
commit-pinned base blobs and every outbound file; a digest alone cannot hide
different content behind a reviewed diff. The writer repeats origin/gate,
preview and stale-source/base checks before writes.
It never executes downloaded files, generated commands, source code, tests,
package installers or models with that credential. Git Data APIs create only
the approved Markdown/catalog blobs, a commit, a new branch and a draft PR.
There is no merge, ready-for-review, release/tag or force-push operation.

Runtime/API contracts:
[Copilot SDK](https://github.com/github/copilot-sdk/blob/v1.0.11/nodejs/README.md),
[default-branch event rules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows),
[environment protection](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments),
and [workflow permissions](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token).

### Evidence, bounds and triage

- Manual input selects one merged upstream PR, or both `since`/`until` UTC
  timestamps (`YYYY-MM-DDTHH:mm:ssZ`) spanning at most seven past days. Otherwise
  the window is 48 hours, frozen at the original run creation time on reruns.
  At most 100 search hits and five relevant candidates are accepted; incomplete
  discovery or larger batches fail closed and require narrower manual scoping.
- Only `src/Aspire.Cli/`, `src/Aspire.Hosting*/` and `src/Aspire.AppHost.Sdk/`
  source changes are candidates. Other merges become no-ops without model calls.
  This conservative classifier can miss changes elsewhere; maintainers must
  review its coverage. Each source PR is limited to 100 changed files, six source
  files, four tests, 48 KiB per full file, 256 KiB combined full evidence,
  128 KiB patches and a 16 KiB PR body. Removed/renamed, binary, incomplete or
  oversized evidence becomes human triage, never truncated semantic inference.
  Rename checks include both paths, including moves out of monitored directories.
- Evidence includes canonical PR links, base/head/merge SHAs, target branch,
  merge time, full implementation/test snapshots, blob SHAs, digests and
  commit-pinned citations. `main` is unreleased; a release branch is **not**
  proof of a published version. Shipping version stays explicitly unknown.
- The tool-free, two-pass assessor sees bounded evidence and canonical Markdown;
  it has no tools, MCP, config/skill discovery, shared session store,
  logged-in-user fallback or permission approvals. Source text is untrusted
  evidence, not instructions, and is never executed. It selects at most six
  documents and proposes at most three exact replacements in existing selected
  Markdown files. Both immutable implementation **and changed tests** must
  contain the quoted evidence. Missing semantics or required version knowledge
  produce maintainer questions, not invented guidance.
- `upstream-assessment-review` contains `evidence.json` and `review.json` with
  no-op, triage, blocked, duplicate or unvalidated-draft outcomes. Read these
  artifacts for triage; there is no automatic issue/comment/notification.
  Runtime/auth/session/transport and unexpected implementation failures fail
  without completing sources. Expected evidence/model-response policy failures
  become triage. Recognized GitHub HTTP read failures are sanitized, blocked and
  retryable; unknown errors propagate. Clients are cleaned up before review/state
  persistence.

### Isolated validation and exact publication preview

Each proposed source change gets its own fresh local clone at the recorded dev
SHA. The validator rechecks the canonical source and current dev, validates the
selected tracked regular Markdown files, and applies only exact replacements.
It runs these existing checks, stopping on nonzero results:

- `npm ci --ignore-scripts --no-audit --no-fund`;
- `npm run catalog`, then an isolated local commit of only skills/catalogs;
- `npm test`, `vally lint skills`, affected root/nested eval-spec lint;
- `npm run catalog:check` against the **new candidate commit**, not old dev;
- affected-skill `vally eval --require-pass --runs 1 --max-retries 2`,
  all root/nested specs, `--tag priority=p0,p1 --workers 1`;
- `node scripts/check-eval-results.mjs` for every expected affected skill, plus
  independent nonempty spec coverage and passing-grade checks.

Missing checks, missing/empty evals, unavailable models, failed grades, stale
sources/base, modified candidate code or out-of-scope generated files block
publication. The final tracked candidate must be unchanged after validation.
Clones are removed even on failure. Only canonical edited Markdown, matching V1
and V2 mirrors and their catalog indexes may be included in the publication.

`upstream-publication-<run>-<attempt>` retains actual command argv/exit statuses
and logs, `publication.json`, and `preview.txt` for 90 days. The preview contains
the **exact PR title, body and complete diff**, including catalog changes.
The body records source PR/SHA/branch/release scope, affected API/CLI command,
rationale, exact citations and actual validation/eval results. The assessment
summary publishes only fixed labels, counters, artifact URL and SHA-256; raw
model/source text is kept in artifacts. A failed gate does not erase the preview.
Maintainers must review normal PR checks before merge; only the existing release
flow publishes skill updates.

### Durable idempotency and retries

Source identity hashes repository, source PR, merge SHA and target branch, so
main and release backports remain distinct. Before analysis and before PR
creation, the workflow looks for **open and closed** destination PRs by a stable
source branch and a source-identity body marker. Truncated/incomplete search fails
closed. Closed/merged proposals are not reopened or duplicated, and existing
maintainer work is never silently overwritten. A branch created before a failed
PR request can be reused only when its base and tree still match the approved
preview; otherwise maintainers must reconcile it. There are no force pushes.
After a partial hosted failure, use **Re-run all jobs**: failed-job-only reruns
cannot substitute a previous attempt's artifact for the current attempt's exact
preview and approval. A new approved attempt still reuses matching orphan branches
or recognizes an existing PR.

The fourteen-day, 2,000-entry state artifact is only an analysis optimization for
completed no-op/triage outcomes, merged with newer successful-run and prior-attempt
state. Drafts (including old preparatory draft entries), blocked checks and failed
publication are **not completed** by that ledger. Expired artifacts may repeat
analysis but cannot bypass durable PR deduplication. `reassess=true` revisits
triage/no-op results, not existing PRs. Runs are serialized. Poll gaps beyond
48 hours require a manual historical PR/window.

Local deterministic checks:

```powershell
node --test tests/upstream-skill-assessment.test.mjs tests/upstream-skill-publication.test.mjs tests/upstream-sdk-contract.test.mjs
```

The publication tests really clone/apply, run Node tests, regenerate and check
committed catalogs; model responses/eval records and outbound GitHub writes are
explicit **offline contract fixtures**, not hosted/model evidence. The SDK
contract test exercises the actual pinned SDK when installed (set
`UPSTREAM_SKILL_SDK_ROOT=.test-artifacts\upstream-agent-tools` to require it).
A hosted smoke and approved live draft still require the external setup above.
Keep the SDK and runtime pins compatible: a newer globally installed CLI can use
a different RPC protocol and is not necessarily a drop-in replacement. A local
tool-free smoke with the existing user's login and a public synthetic fixture
can verify the model/session contract without inspecting or copying tokens, but
does not verify Actions-token authentication or hosted environment approvals.
The production adapter intentionally keeps logged-in-user fallback disabled.
