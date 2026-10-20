# Development

Use Node.js 22 or later, Git, and GitHub CLI. Create feature branches from `dev`
and target contributor PRs at `dev`. Before opening a PR, run:

```powershell
npm ci --ignore-scripts
npm test
```

See [CONTRIBUTING.md](../CONTRIBUTING.md) for skill formatting and agent-host checks.
Ordinary contributions, including forks and release fixes, do not run catalog
commands or commit generated files. Dev retains `CHANGELOG.md` and, after the
first automated release, the last released `opencode/` snapshot. That snapshot
does not track development source.
Feature PRs update the current version's changelog notes and preserve earlier
entries and the coordinated version.

The **OpenCode catalog check** generates V1 and V2 catalogs from committed source
on every PR, including forks and stacked PRs, supported pushes, and merge-queue
candidates. Source PRs need no generated commits. Candidates targeting main must
also have exact committed catalog parity, synchronized versions, and unchanged
published changelog history. For an optional local source check, run
`npm run catalog:check -- --source-only`. `npm run catalog:check` without that
option checks a release snapshot, not ordinary dev source.

The **Release branch check** fails any PR into main unless its head is a
`release/<version>` branch in this repository.

## Testing development skills

After a change merges into dev, **Publish development catalogs** publishes to the
output-only `opencode-dev` branch. Configure the HTTP catalog source for your
OpenCode version:

| Format | Development catalog URL |
|--------|-------------------------|
| V1 | `https://raw.githubusercontent.com/microsoft/aspire-skills/opencode-dev/opencode/v1/` |
| V2 | `https://raw.githubusercontent.com/microsoft/aspire-skills/opencode-dev/opencode/v2/` |

The index is `index.json` under each URL. The branch's
[`source.json`](https://raw.githubusercontent.com/microsoft/aspire-skills/opencode-dev/source.json)
records the dev source commit; cross-skill links use that immutable SHA. Stable
catalogs remain under `main/opencode/v1/` and `main/opencode/v2/`, with their
existing URL layout and link behavior.

For an unmerged change, use the local checkout's `skills/` directory as the
agent host's local skill source. There is no per-PR HTTP preview.

A failed publication is a failed Actions run, not a successful fallback to old
output. Inspect its source SHA and error, then manually run **Publish development
catalogs** from main to retry the current dev tip. Older runs cannot overwrite a
newer publication.

## Release flow

1. **Prepare the PRs.** Run **Prepare release** from main with the full selected
   dev commit SHA, release version, and next dev version (versions omit `v`).
   It creates `release/<version>` and its PR to main, generates the release
   catalogs, and creates `bump-dev/<next-version>` and its PR to dev. The dev
   bump updates coordinated versions and adds a changelog heading without
   changing earlier notes or regenerating catalogs. Both PRs require review.
2. **Prepare candidate fixes.** Run **Backport PR to branch** from main with a
   merged dev PR number and its target `release/<version>`. The copied
   Arcade-derived workflow from `microsoft/aspire` applies the PR patch using
   `git am` and opens `backport/pr-<number>-to-<target>` for review.
   There is no `/backport` comment trigger.
3. **Finalize the candidate.** Maintainers finalize the release notes and merge
   approved fixes into the release branch. **Refresh release catalogs**
   regenerates its snapshot after each candidate change. Main's catalog check
   remains failing until the final generated commit passes. The refresh
   workflow can also be dispatched from main with the release branch name.
4. **Release to main.** Maintainers approve and merge the release PR after all
   required checks pass. The publisher validates and tags the exact merged
   commit, creates the GitHub release, and uploads the skills bundle.
5. **Review the automatic backport.** Every same-repository PR merged into main
   triggers the Arcade patch-copy flow back to dev. It opens a reviewable
   `backport/pr-<number>-to-dev` PR when patch application and preservation
   checks succeed. This is a patch backport, not a real merge: it does not
   retain merge ancestry, and it does not require merge-commit-only merging.

Main-to-dev backports preserve dev's next version, current changelog notes, newer
work, and non-version manifest edits; they carry main's approved history and the
exact released catalog snapshot without regenerating against newer dev skills.
Arcade's patch application can conflict, especially when release versions differ
from dev. Conflicts or preservation-check failures stop the operation and post
a source-PR comment with the workflow link; they may occur before a PR is opened.
Resolve those backports manually, preserving these invariants, rather than
accepting one side wholesale. Source PRs targeting release branches still do not
need generated catalog commits; the release-branch refresh handles them.

Reruns reuse matching open PRs and can recover from a branch push followed by a
PR-creation failure. They do not reopen closed PRs, replace maintainer edits, or
reuse unrelated branches. Stale operations fail rather than overwrite newer
work. Retry against current refs; investigate a conflicting operation identity
instead of force-pushing over it.

## Automation setup

Install the Aspire repository GitHub App for this repository and make
`ASPIRE_BOT_APP_ID` and `ASPIRE_BOT_PRIVATE_KEY` available as Actions secrets.
Branch/PR automation uses short-lived, repository-scoped App tokens with only
the necessary permissions. Release preparation and backports also need the App's
workflow-write permission so selected workflow-file changes can be pushed.
App pushes trigger normal PR checks, unlike workflow-token pushes.

The first rollout needs a maintainer-prepared `release/<version>` PR: align its
versions, finalize its changelog, and generate and commit its stable catalogs
with `npm run catalog`. Dispatch workflows cannot prepare this bootstrap PR
before the helpers exist on main. Configure the App before merging that PR,
then make the workflows and helpers available on dev. Subsequent releases use
the automated preparation flow; ordinary contributors never generate catalogs.
Keep the existing
required check names. A maintainer must require **OpenCode catalog check** and
**Test (ubuntu-latest)**, **Test (macos-latest)**, and **Test (windows-latest)**
on main as well as dev, retaining **Release branch check** on main. This code
does not change rulesets, approval requirements, or repository settings.

## Publication

`.github/workflows/publish.yml` runs when a same-repository `release/*` PR
merges into main. It uses the event's `merge_commit_sha`, builds and attests
both bundles, and uploads only `aspire-skills-v<version>.tgz`.

Tag/release publication still uses `GITHUB_TOKEN`; branch and PR preparation uses
the Aspire App. Maintainers approve and merge PRs. Tags and releases are
published in the same run because workflow-token tag pushes do not trigger
another workflow. Reruns must preserve the tag's commit and approved notes.
