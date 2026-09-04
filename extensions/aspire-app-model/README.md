# Aspire App Model canvas

A GitHub Copilot App canvas extension that brings Aspire AppHosts into a
canvas-native workbench: Workspace and Global discovery, a focused AppHost
switcher, live resource state, parented resources, endpoints, health checks,
commands, and Dashboard-backed diagnostics.

## Data contract

The extension uses the Aspire CLI's public surfaces:

- `aspire ls --format Json` discovers workspace AppHost candidates.
- `aspire ps --format Json` discovers running AppHosts for Workspace and Global
  modes.
- `aspire describe --format Json --apphost <path>` retrieves the evaluated
  resource model and current state.
- `aspire resource <resource> <command> --apphost <path>` invokes commands that
  the AppHost exposes through its API command surface.
- `aspire terminal attach <resource> --apphost <path>` opens an integrated
  terminal only when the resource advertises terminal support.

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
Dashboard URLs remain provider-side. The provider resolves resource-specific
details, console logs, structured logs, traces, and metrics routes and opens
them in the integrated browser while preserving the Aspire login token. Raw
resource JSON and `.env` exports remain inside the authenticated Dashboard and
never cross the canvas boundary.

Each canvas instance serves its renderer from a random loopback port protected by
a per-instance token, host/origin checks, a strict Content Security Policy, and
bounded request bodies.

## Experience

- Workspace mode with a compact AppHost switcher and running hosts first.
- Global mode with every running machine AppHost available from the same
  switcher and a bounded describe fanout of four.
- A responsive resource board that removes explorer-style nesting while
  preserving parent ownership.
- Resource rows size to their content while keeping cards aligned within each
  row, so sparse boards do not stretch cards into unused canvas space.
- Endpoint links, health checks, diagnostics, and commands grouped directly
  with the resource that owns them.
- Endpoint links open in GitHub Copilot's integrated browser and expose a
  separate copy-URL control.
- A visible **Console logs** action opens the authenticated Dashboard filtered
  to the resource. Details, structured logs, traces, and metrics remain
  available from the resource overflow menu.
- Resources that explicitly advertise terminal support can open an attached
  terminal canvas.
- Sanitized AppHost or resource context can be added to the Copilot composer as
  an attachment; the user writes and sends the actual question.
- AppHost-defined command forms with validation and command-result feedback.
- Provider-owned dynamic command metadata remains authoritative through
  validation and execution. Loads for one command are serialized and stale
  renderer responses are ignored.
- Non-secret command defaults are preserved; secret defaults are removed before
  the model crosses into the renderer.
- Explicit Run, Stop, Deploy, Publish, and pipeline-step actions, with blocked
  operations explained in place and high-impact actions confirmed inline.
- **View dashboard** opens the authenticated Aspire Dashboard in GitHub
  Copilot's integrated browser.
- Loading, empty, stale, partial-AppHost-failure, and error states.
- Background and explicit refreshes preserve the last complete board or empty
  state; the full skeleton appears only before the first complete snapshot.
- Optional hidden-resource inclusion.
- AppHost directory inputs resolve to one concrete project or source file before
  discovery, source opening, and operation locking.
- Older CLI compatibility retries only when the optional disabled-command flag
  is actually unsupported and marks the resulting model accordingly.

Explicit Reference and WaitFor visualization is intentionally deferred in this
iteration.
