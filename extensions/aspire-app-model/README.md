# Aspire App Model canvas

A GitHub Copilot App canvas extension that brings the Aspire VS Code
extension's AppHost tree into Copilot: Workspace and Global discovery, live
resource state, parented resources, endpoints, health checks, and commands.

## Data contract

The extension uses only the Aspire CLI's public JSON surfaces:

- `aspire ls --format Json` discovers workspace AppHost candidates.
- `aspire ps --format Json` discovers running AppHosts for Workspace and Global
  modes.
- `aspire describe --format Json --apphost <path>` retrieves the evaluated
  resource model and current state.
- `aspire resource <resource> <command> --apphost <path>` invokes commands that
  the AppHost exposes through its API command surface.

The canvas polls the public snapshots in place so discovery, model, and state
changes appear without reopening the panel. Opening the canvas never starts an
AppHost; Run, Stop, Deploy, Publish, and pipeline-step operations are explicit
and serialized per AppHost.

## Security boundary

The provider projects an explicit allow-list of resource fields. It never sends
environment values, arbitrary resource properties, connection strings, volumes,
source paths, parameter values, or the token-bearing dashboard URL to the
renderer or Copilot. Endpoint userinfo, query strings, and fragments are removed.
Secret command inputs are redacted from command results and never persisted.

Each canvas instance serves its renderer from a random loopback port protected by
a per-instance token, host/origin checks, a strict Content Security Policy, and
bounded request bodies.

## Experience

- Workspace mode with one explicit shell per AppHost, running hosts first, and
  VS Code-style resource flattening when only one AppHost is running.
- Global mode with every running machine AppHost as an explicit root and a
  bounded describe fanout of four.
- Searchable hierarchical resources with stable expansion and selection.
- Parent resources, endpoint links, health-check groups, and command groups in
  the same order as the Aspire VS Code extension.
- Sanitized **Ask Copilot** context for selected tree items.
- AppHost-defined command forms with validation and command-result feedback.
- Provider-owned dynamic command metadata remains authoritative through
  validation and execution. Loads for one command are serialized and stale
  renderer responses are ignored.
- Non-secret command defaults are preserved; secret defaults are removed before
  the model crosses into the renderer.
- Explicit Run, Stop, Deploy, Publish, and pipeline-step actions, with blocked
  operations explained in place and high-impact actions confirmed inline.
- Loading, empty, stale, partial-AppHost-failure, and error states.
- Optional hidden-resource inclusion.
- AppHost directory inputs resolve to one concrete project or source file before
  discovery, source opening, and operation locking.
- Older CLI compatibility retries only when the optional disabled-command flag
  is actually unsupported and marks the resulting model accordingly.

Explicit Reference and WaitFor visualization is intentionally deferred in this
iteration.
