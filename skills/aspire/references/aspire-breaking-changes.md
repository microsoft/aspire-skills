# Aspire Breaking Changes — Version Index

Version-aware entry point for Aspire breaking-change scrubs. Prefer the local per-version
agent references when this bundle includes one because they are grep-friendly, offline, and
written for code-review / code-generation workflows. Use the upstream release notes for newer
or intervening Aspire versions that do not yet have a local scrub file.

> Use this page before reviewing or generating AppHost code, CI YAML, or shell snippets.
> Agents must scrub against the breaking-change list for the installed Aspire version and any
> intervening versions before recommending or generating code.

## Local scrub lists

- [Aspire 13.4 breaking changes](aspire-13-4-breaking-changes.md) — `aspire exec` removal,
  `aspire ps` flag removals, TypeScript `.aspire/modules/`, persistent lifetimes, Kubernetes
  route / Helm changes, Azure Front Door naming, Foundry hosted-agent API changes,
  `PublishAsPackageScript`, Keycloak HTTPS, the PostgreSQL 18 data-volume incompatibility, and
  behavior audits.
- [Aspire 13.3 breaking changes](aspire-13-3-breaking-changes.md) — pipeline log-level
  rename, dashboard MCP removal, Azure `NameOutputReference`, removed / renamed hosting APIs,
  TypeScript `withEnvironment`, and the 13.2 → 13.3 migration checklist.

## Upstream release notes

The authoritative breaking changes for each release are published under the **"Breaking
changes"** heading of that version's "What's new" page:

- **What's new index (all versions):** <https://aspire.dev/whats-new/>
- **Per-version page:** `https://aspire.dev/whats-new/aspire-<major>-<minor>/`
  (for example, [Aspire 13.4 what's new](https://aspire.dev/whats-new/aspire-13-4/)) — scroll
  to the **Breaking changes** section.
- **Latest official release notes:** <https://aka.ms/aspire/update-latest>

## How to use it

1. **Find the installed version** — run `aspire --version` (or check `Aspire.AppHost.Sdk` /
   `aspire.config.json`).
2. **Read every relevant local scrub list** in order when the repo is migrating across one of
   the versions above.
3. **Fetch upstream release notes for gaps** — if the installed version is newer than the
   latest local scrub list, read every intervening **Breaking changes** section on
   `aspire.dev`.
4. **Scrub the AppHost, CI/CD scripts, and shell snippets** for removed/renamed APIs,
   environment variables, CLI flags, generated paths, endpoint assumptions, and image-version
   behavior changes before recommending or generating code.
5. **Update the CLI and projects** when migrating across versions: `aspire update --self`
   (CLI) and `aspire update` from the repo root (project package references — get user
   approval before running in CI).
