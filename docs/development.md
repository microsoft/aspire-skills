# Development guide

This guide covers testing, building, and publishing Aspire Skills.

## Prerequisites

Use Node.js 22 or later and Git. Release bundle builds also require `tar` on your
PATH. Run the commands below from the repository root.

## Running tests

```bash
npm test
```

The [Tests workflow](../.github/workflows/test.yml) runs the tests, builds the
OpenCode catalog, checks its generated content, and builds release-equivalent
bundles on Linux, macOS, and Windows.

## OpenCode catalog

```bash
npm run catalog
npm run catalog:check
```

`npm run catalog` builds the HTTP catalogs in `dist/opencode/` from `skills/`:

| Output | Contents |
|--------|----------|
| `v2/index.json`, `v2/<name>/` | V2 catalog with named Markdown entries and supporting files |
| `v1/index.json`, `v1/<name>/` | V1 catalog with `SKILL.md` entries and supporting files |

`npm run catalog:check` validates both catalogs against the sources. Each uses
SHA-512 cache versions that change when a skill's published files change.

The [Publish OpenCode catalog](../.github/workflows/publish-opencode-catalog.yml) workflow
publishes both catalogs under `/opencode/` on GitHub Pages when `main` changes affect
skills, references, the generator, or its build configuration. It also supports
manual runs on `main`.
Publishing requires `write`, `maintain`, or `admin` repository access, matching
[Aspire's extension-release policy](https://github.com/microsoft/aspire/blob/c7536dd42be390dae9c772c3fd541f66a92961e8/.github/workflows/extension-release.yml).

## Release bundles

```bash
npm run bundle
```

`npm run bundle` builds both published release artifacts:

| Artifact | Contents |
|----------|----------|
| `aspire-skills-v<version>.tgz` | Agent skill files, canonical telemetry hooks, and `skill-manifest.json` with hook commit/SHA-512 provenance |
| `aspire-extensions-v<version>.tgz` | GitHub Copilot app canvas extension files and `extension-manifest.json` |

The skills manifest records the release commit and LF-normalized SHA-512 hash for
each file under `hooks/scripts/`. Downstream consumers can copy the `hooks` object
directly instead of maintaining hook provenance separately.

Use `npm run bundle:skills` or `npm run bundle:extensions` to build one bundle type.
