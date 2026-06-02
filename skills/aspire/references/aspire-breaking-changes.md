# Aspire Breaking Changes — Agent Reference

Version-independent pointer to the **authoritative, always-current** list of Aspire breaking
changes. Aspire ships breaking changes in most releases, so this reference deliberately links
to the upstream release notes instead of pinning a single version — that way the guidance never
goes stale as new Aspire versions land.

> Use this page before reviewing or generating AppHost code, CI YAML, or shell snippets.
> Agents must scrub against the breaking-change list for the **installed** Aspire version
> before recommending or generating code.

## Where the breaking changes live

The breaking changes for each release are published under the **"Breaking changes"** heading
of that version's "What's new" page:

- **What's new index (all versions):** <https://aspire.dev/whats-new/>
- **Per-version page:** `https://aspire.dev/whats-new/aspire-<major>-<minor>/`
  (for example, [Aspire 13.4 what's new](https://aspire.dev/whats-new/aspire-13-4/)) — scroll
  to the **Breaking changes** section.
- **Latest official release notes:** <https://aka.ms/aspire/update-latest>

## How to use it

1. **Find the installed version** — run `aspire --version` (or check `Aspire.AppHost.Sdk` /
   `aspire.config.json`).
2. **Open that version's "What's new" page** and read the **Breaking changes** section.
   If the repo is several versions behind, read every intervening version's breaking changes,
   not just the newest one.
3. **Scrub the AppHost, CI/CD scripts, and shell snippets** for the removed/renamed APIs,
   environment variables, CLI flags, and templates called out there before recommending or
   generating code.
4. **Update the CLI and projects** when migrating across versions: `aspire update --self`
   (CLI) and `aspire update` from the repo root (project package references — get user
   approval before running in CI).

## Why link instead of inline

Inlining a single version's scrub list goes out of date the moment a new Aspire version ships
(this skill bundle targets the current Aspire CLI/SDK, which moves forward). Linking to the
upstream "What's new" pages keeps agents pointed at the complete, current breaking-change list
for whatever version is actually installed.
