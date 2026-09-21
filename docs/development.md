# Development

Use Node.js 22 or later, Git, and PowerShell 7. Run commands from the repository root.

## Making changes

Create a feature branch from `dev` and open your pull request against `dev`.
Skills live in `skills/`, canvas extensions in `extensions/`, and telemetry hooks
in `hooks/scripts/`.

Before opening a PR, run:

```bash
npm test
npm run catalog
npm run catalog:check
```

Catalog builds write to `dist/opencode/` for local inspection. Do not commit
generated catalogs to dev. Follow [CONTRIBUTING.md](../CONTRIBUTING.md) for skill
formatting and agent-host checks.

## Releasing

Releases use a preparation PR and an Actions approval:

1. Run [Prepare Release](../.github/workflows/prepare-release.yml) from `main`.
   Supply a version such as `0.0.3` without a `v` prefix. The workflow uses the
   current dev commit unless you provide its full SHA.
2. Review the generated `prepare-release/<version>` PR into dev. It updates
   versions and the changelog. You may edit `README.md`
   in this PR before merging; other source changes belong on dev and require
   a new preparation. Merge with a **merge commit**.
   **Note:** This PR intentionally does not generate the OpenCode catalog. The
   catalog belongs on `main`, not `dev`.
3. After the preparation PR merges, [Promote Release](../.github/workflows/promote-release.yml)
   automatically builds the catalogs from that exact reviewed dev snapshot,
   without waiting for post-merge CI.
4. Approve the `release-main` deployment in GitHub Actions. The workflow
   publishes an `Update to v<version>` merge commit using a normal fast-forward
   push to main. No main-targeted PR is created, and automation never force-pushes.

Dev holds current source, versions, and the changelog. Main holds the released
snapshot plus catalogs. Promotion starts automatically, but main is updated only
after approval.

If dev advances before preparation merges, or main advances before promotion,
prepare again. Delete merged preparation branches before reusing the same version.
Maintainers must configure the publication App, environment approval, and branch protections; see
[#72](https://github.com/microsoft/aspire-skills/issues/72) for rollout details.
