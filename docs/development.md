# Development

Use Node.js 22 or later, Git, and GitHub CLI. Create feature branches from `dev`
and target contributor PRs at `dev`. Before opening a PR, run:

```powershell
npm ci --ignore-scripts
npm test
```

See [CONTRIBUTING.md](../CONTRIBUTING.md) for skill formatting and agent-host checks.
Dev retains `CHANGELOG.md` and generated `opencode/` catalogs. Regenerate catalogs
with `npm run catalog` after changing shipped skills, references, or assets,
and commit them with the source changes. Run `npm run catalog:check` to check
the committed tree. CI rejects missing, extra, or stale V1 and V2 catalog files.
Only consumer-facing changes belong in the current version's changelog notes.
Keep internal repository automation, CI, and test-only changes in development
documentation. Preserve earlier entries and the coordinated version.

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

`.github/workflows/update-aspire.md` runs when a PR targeting `main` merges,
or manually for a selected PR, following Aspire's documentation-workflow
pattern. It assesses skill and extension behavior and opens draft PRs in
`microsoft/aspire` only when telemetry or its regression coverage needs updates.
It reads source directly; it does not publish, acquire, or refresh embedded
bundles.
Each review also checks `KnownMcpTools.All` against both compatibility scripts
and managed-hook classification, even when skill and extension inventories
are unchanged. An offline regression test must guard coverage before a no-op
is allowed.
`aspire-repo-bot[bot]` is allowlisted; the App must cover both repositories.
Configure `ASPIRE_BOT_APP_ID` and `ASPIRE_BOT_PRIVATE_KEY` as repository secrets.
Source research uses a read-only GitHub CLI proxy without the issues toolset.
Snapshots omit PR titles and descriptions; research instructions exclude
comments and linked pages and limit source reads to relevant pinned files.
Optional maintenance is disabled in `.github/workflows/aw.json`.
Regenerate the compiled workflow with
gh-aw v0.91.8 on Linux or WSL after editing its source or configuration:

```shell
gh aw compile --purge --validate \
  --action-mode action --action-tag 866158eb5c6cbfd3c614104e3d3d6634e246d220 \
  --no-check-update --schedule-seed microsoft/aspire-skills
```

Linux CI runs this command with the same pinned compiler and rejects modified,
deleted, or unexpected generated workflows and action pins.
Use `--force-refresh-action-pins` only when intentionally updating locked
action references.

The sandbox pins AWF v0.28.49 for Copilot custom-tool handling and
[model-supported endpoint discovery and recovery](https://github.com/github/gh-aw-firewall/pull/9559).
The runtime includes [live model endpoint selection](https://github.com/github/gh-aw/pull/67487),
so the harness selects the model's supported wire API without a workflow-level override.
The compiler also includes the
[reviewer image-propagation fix](https://github.com/github/gh-aw/pull/63014),
so both AI jobs use the digest-pinned sandbox images.

The workflow separates input resolution, agent editing, verification, and
publication:

- A trusted job snapshots the source PR's commit, Git diff, and file inventory,
  and pins Aspire's base commit. Manual runs can select unmerged PRs; neither
  their descriptions nor their contents become workflow instructions.
- A fresh verification job reads the existing publisher's compiled file policy,
  checks the proposed Git `.bundle` transport's actual changes, and freezes one
  candidate commit. The agent's checkout, Git configuration, and proposed commit
  history are not reused.
- A digest-pinned .NET SDK container restores only trusted base source. A second,
  unprivileged container runs all required telemetry tests, including PowerShell,
  against the proposed code with networking disabled. Both containers receive only
  disposable source and cache directories, not runner credentials, home, Actions
  control files, publication artifacts, or a Docker socket. There is no fallback
  to running candidate code on the host or restoring it online.
  The container's private `/tmp` permits execution so Bash tests can invoke
  their recording stubs; it never maps the runner's temporary directory.
- Only the trusted supervisor can produce the successful verification receipt.
  Native threat detection waits for that receipt and reviews the exact frozen
  output, patch, and bundle, replacing the original transports. An immutable
  review-input receipt is uploaded before the reviewer starts.
  Publication requires verifier success, a successful native review, matching
  verification and review receipts, matching artifact hashes, the same source
  commit, and the tested candidate tree and base. Source
  or target changes detected before publication require a new run. The native
  publisher's later fetches cannot silently move its signed replay onto a newer
  base. Before promoting any artifacts, the publication job independently checks
  the bundle's actual file changes against the same compiled policy; a clean
  companion patch cannot hide an out-of-scope bundle change.
- A clean publisher checks out the pinned Aspire base before validating frozen
  Git transports; its nested validator checkout cannot replace that repository.
  The publisher can create one draft PR in `microsoft/aspire` on `main`, restricted
  to telemetry paths and the protected-file policy. Its App token covers only
  Aspire; source research, input resolution, and verification use read-only
  tokens. Diagnostic issue reporting is disabled in both live and dry-run modes;
  failures remain in Actions logs and artifacts. The pinned compiler still grants
  source-repository contents and PR write permissions to native publishing and
  conclusion jobs; built-in permission overrides are additive, not restrictive.
  Those jobs never execute candidate build or test code, and conclusion receives
  no publishing App token.
- A read-only audit checks the native publisher's returned PR number and URL
  against the actual open draft in Aspire. The head repository and branch, base
  branch, commit tree, and single parent must match the verified proposal.
  Missing publication results, contradictory staged/no-op outputs, and incomplete
  work fail the run. This audit detects a bad outcome after publication; it
  cannot undo a write or prevent downstream CI from starting.

The receipt establishes which tree ran the required checks, not that the
agent's conclusions or proposed telemetry changes are safe. Human review and
downstream branch protection remain necessary. Draft status does not prevent
other workflows from executing; downstream CI must not expose privileged
credentials to proposed code.

### Manual runs

After the workflow is registered on `main`, open **Actions > Update Aspire
telemetry > Run workflow** and enter `pr_number` for a PR targeting `main`.
Like the documentation workflow, manual runs do not require a merged PR.
Leave the optional `dry_run` checkbox unchecked (the default) for normal draft
PR publication, or check it to stage outputs
without publishing PRs or diagnostic issues. Both modes run the same review
and checks; inspect the Actions summary and artifacts for dry-run previews.
Merge-triggered runs publish normally.

Source reads use the PR's merge commit when merged, or its head commit when
unmerged, independently of the workflow branch's SHA. Evidence is derived from
those Git objects, not a later mutable PR-files response.
Failed checks remain visible as failed runs.

### Verifier changes

The isolation supervisor and publication checks are in
`scripts/telemetry-workflow.mjs`. They use the pinned gh-aw runtime's path policy,
not a second allowlist. Keep its SDK image digest pinned when updating the
toolchain; the image must include PowerShell and be able to bootstrap the SDK
required by Aspire's pinned `global.json`. Preserve the same container paths
between trusted restore and offline tests so restored assets remain usable.
Populate sandbox source from a private clone of the trusted verifier checkout,
without copying credentials or sharing Git metadata; do not fetch the base twice.
Never mount runner state or re-enable candidate network access to fix a test.

Run `node --test tests/update-aspire-workflow.test.mjs` for behavioral coverage
of snapshot consistency, rejected proposals, file modes, isolated execution
arguments, artifact tampering, run binding, base drift, actual publication
outcomes, and compiled gates.

The Linux **Tests** job also runs
`node --test tests/telemetry-publication/*.test.mjs` with `GH_AW_ACTIONS_DIR`
pointing to the same pinned gh-aw setup runtime used by the workflow. These
regressions execute the compiled pre-publication script and native signed-PR
handler against local Git fixtures. Workflow, CODEOWNERS, unrelated source, and
project-file edits must be rejected both alone and mixed with valid telemetry,
before any API mutation or Git push. A misleading telemetry-only companion patch
must not bypass that boundary. A successful mocked native publisher exercises
signed commit creation, draft-PR creation, native result outputs, and the compiled
read-only audit; no test writes to GitHub. Additional cases cover staged
publication without mutations, late source/base changes, compiled admission
denials, generated-file drift, and hostile output on success and failure.

Linux CI also runs `node tests/telemetry-publication/isolation-canary.mjs`
against the pinned SDK image using the production Docker invocation and output
wrapper. This required check exercises cleared credentials, inaccessible host and
Actions-file canaries, no Docker socket, nonroot execution, dropped capabilities,
no-new-privileges, read-only root, loopback-only networking, and executable private
temporary files. Its command-like stdout must not become Actions commands.
The next step rejects any forged step output from that stdout.
Docker must already be running; the check fails rather than silently skipping.
Update the CI compiler and runtime pins alongside any workflow runtime upgrade.
