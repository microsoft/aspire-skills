# Aspire AppHosts canvas

A GitHub Copilot App canvas extension that brings Aspire AppHosts into a
canvas-native workbench: Workspace and Global discovery, a focused AppHost
switcher, live resource state, parented resources, endpoints, health checks,
commands, parameters, resource dependencies, and Dashboard-backed diagnostics.

Open the canvas with `open_aspire_apphosts`, or use canvas ID `aspire-apphosts`
with `open_canvas`.

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

Closing the canvas stops polling and closes its listener after in-flight
requests finish. It does not cancel an operation that has already started.

Snapshots carry a monotonic content revision across HTTP and server-sent events.
An older response cannot replace a newer model, and freshness updates apply only
to the model revision they describe. Selected context includes the owning
AppHost, stable item identity, and that AppHost's freshness, including retained
stale data.

On Windows, the default runner resolves `aspire.exe` from `PATH` and invokes it
directly by its fully qualified path. Bare `ASPIRE_CLI` names on `PATH` support
`.exe` completion, including names containing periods. An `ASPIRE_CLI` path
must also be fully qualified and name an executable rather than a `.cmd` or
`.bat` wrapper: batch-wrapper argument serialization cannot safely preserve
every command input.
Unsupported wrappers fail explicitly instead of silently changing arguments.
Executable lookup is included in each CLI operation's timeout.

## Security boundary

Explicit UNC/network paths are rejected before filesystem access. Mapped drives,
mounted shares, and local aliases to remote storage are not detected.

The provider projects an explicit allow-list of resource fields. It never sends
environment values, arbitrary resource properties, connection strings, volumes,
source paths, parameter values, or the token-bearing dashboard URL to the
renderer or Copilot. Endpoint userinfo, query strings, and fragments are removed.
Machine-readable commands can publish formatted allow-listed projections to the
Output panel, but their raw stdout remains provider-side.
Secret command inputs are redacted from command results and never persisted.
Redaction happens before output is truncated. Duplicate AppHosts use a bounded
directory-name hint and stable ID to distinguish targets, not a full source path.
Dashboard URLs remain provider-side. The provider resolves resource-specific
details, console logs, structured logs, traces, and metrics routes and opens
them in the registered integrated browser, or the default system browser when
the host has no browser canvas, while preserving the Aspire login token. Raw
resource JSON and `.env` exports remain inside the authenticated Dashboard and
never cross the canvas boundary. Browser errors remove complete HTTP(S) URLs
before reaching the renderer or provider log.

Each canvas instance serves its renderer from a random loopback port protected by
a per-instance token, host/origin checks, a strict Content Security Policy, and
bounded request bodies.

## Experience

- Workspace mode with a compact AppHost switcher and running hosts first.
- When CLI discovery is unavailable, the bounded filesystem fallback recognizes
  `apphost.cs`, `apphost.ts`, `apphost.mts`, and `apphost.go` case-insensitively in the workspace
  root and its immediate child directories, preserving the actual file spelling.
- Global mode with every running machine AppHost available from the same
  switcher and a bounded describe fanout of four.
- A responsive resource board with a nested resource roster beside a resource
  inspector. Narrow panels show one pane at a time with a Back control.
- The roster has collapsible **Resources** and **Parameters** sections. Parameters
  appear only when the AppHost declares them, and parameter values are never
  shown. Parameters with a missing value count toward resources that need
  attention because they block startup.
- Parent relationships drive roster nesting. The resource inspector lists
  **Depends on** and **Used by** with each related resource's state, merging
  Reference and WaitFor into one row per resource. Selecting a related name
  opens that resource.
- A resource in the Waiting state names the resources it is waiting for in its
  roster row.
- The resource inspector has compact labeled Endpoints and Health rows,
  endpoint name plus sanitized host/port, natural-width semantic health pills, and
  the commands the selected resource owns.
- Endpoint links prefer GitHub Copilot's registered integrated browser and use
  the default system browser in CLI hosts without that canvas. They expose a
  separate copy-URL control. Browser discovery and launch failures remain visible
  and do not trigger a fallback. System-browser requests acknowledge a detached
  opener without waiting for the browser to exit; later launcher failures appear
  as error notifications and in the provider log.
- The resource inspector opens authenticated Dashboard details, console logs,
  structured logs, traces, and metrics.
- Resources that explicitly advertise terminal support can open an attached
  terminal canvas.
- **Add to chat** captures a sanitized snapshot in memory. A visible **Pending
  selected context** area lists the snapshots; **Clear pending context** cancels
  them across all open AppHosts canvases. Every canvas shows the shared list,
  and Clear targets its displayed revision: if the list changed, the request
  fails without deleting newer snapshots. Merely selecting an item never queues
  context. Nothing is sent automatically, and no native composer attachment pill
  is created.
  Each snapshot shows a fresh `aspire-ctx-…` reference. A root message in the
  same foreground session that contains a snapshot's reference consumes that
  snapshot once through the supported `onUserPromptSubmitted.additionalContext`
  hook, framed as untrusted data; snapshots it does not reference stay pending.
  The hook input carries no message identity, provenance, or submission time,
  so only explicit reference matching is enforced. It is not authenticated
  authorship, an in-flight fence, or submission-order protection: any root
  prompt that contains a known reference, including canvas-generated
  `session.send()` messages or relayed text, receives the snapshot. An Add that
  is still in flight when a prompt is submitted can finish later; its snapshot
  then stays pending for a later message that contains its reference.
  Consumption means handoff to that runtime hook, not proof of model
  delivery: if another hook blocks the turn, re-add the context.
  Repeated clicks update the snapshot for that item and rotate its reference, so
  a message quoting the old reference receives nothing. Limits are 16 snapshots,
  16 KiB per snapshot, and 64 KiB total across open AppHosts canvases; rejected
  additions never discard existing snapshots. Only queue metadata reaches the UI.
  Closing the owning canvas or starting a foreground session clears its pending
  context; nothing is persisted to disk. Subagent hooks cannot consume it.
- AppHost-defined command forms with validation and command-result feedback.
- Provider-owned dynamic command metadata remains authoritative through
  validation and execution. Loads for one command are serialized and stale
  renderer responses are ignored. Metadata is bound to its dependency values;
  changing those values, a pending reload, or a failed reload blocks execution
  until matching inputs are loaded. Live schema changes and effective non-secret
  defaults are reconciled before execution; unstable metadata or an authority
  conflict exposes **Retry inputs** without automatically retrying the command.
- Non-secret command defaults and submitted values follow Aspire Hosting's
  whitespace trimming. Forms show trimmed defaults and normalize edits when
  committed or submitted. Trimming scans only the ends so long interior whitespace
  does not stall editing. Length limits validate the normalized value without
  shortening it. Secret defaults are removed before the model crosses into the
  renderer, and submitted secret values are not trimmed.
- Number inputs use text controls with a decimal keyboard hint so the browser
  cannot silently hide preserved defaults. The provider validates and converts
  the displayed value before execution.
- Explicit Run, Stop, Deploy, Publish, and pipeline-step actions, with blocked
  operations explained in place. Stop, Deploy, and Publish are confirmed inline.
  If the last Run failed, the AppHost shows **Start failed** with links to its
  output and a retry.
- The **Output** panel shows commands for the selected AppHost. Check
  **All AppHosts** to see every AppHost, or **Show automatic refreshes** to include
  background status checks.
- **View dashboard** opens the authenticated Aspire Dashboard in the registered
  integrated browser, or the default system browser when the host has no browser
  canvas.
- Loading, empty, stale, partial-AppHost-failure, and error states.
- Background and explicit refreshes preserve the last complete board or empty
  state; the full skeleton appears only before the first complete snapshot.
- Optional hidden-resource inclusion.
- AppHost directory inputs resolve to one concrete project or source file before
  discovery, source opening, and operation locking.
- Workspace containment accepts child directory names beginning with `..` while
  still rejecting parent-directory traversal for source opening.
- Older CLI compatibility retries only when the optional disabled-command flag
  is actually unsupported and marks the resulting model accordingly.

## Shared canvas UI

The workbench uses the shared canvas theme, typography, controls, and local SVG
sprite. Its resource board and dense operational labels remain specific to
AppHosts. See [Shared canvas UI](../../docs/canvas-ui.md) before changing the
canonical assets linked by `ui/canvas-theme.css` and `ui/canvas-icons.svg`.

## Regression coverage

Run `npm test` from the repository root. It includes the AppHosts model,
provider, renderer, plugin-mirror, and shared-canvas suites as well as the
nested Aspireify suites. Provider and renderer boundary fixtures use synthetic
data and do not start, stop or deploy a real Aspire application.
