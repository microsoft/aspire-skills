# Aspire Doctor canvas

A GitHub Copilot App **canvas extension** that runs `aspire doctor` and renders
its environment checks as a live, scannable checklist in a side panel — ordered
by severity and category, with the status of every check, suggested fixes, a
summary, and the CLI installations detected on the machine.

## Features

- **Prescriptive ordering** — categories and checks with failures or warnings are
  shown first so the most useful call-to-action is visible immediately.
- **Status at a glance** — a toolbar subtitle and pass/warning/fail summary
  pills reflect the overall health of the environment.
- **Actionable fixes** — every warning/failure offers **Ask Copilot** and
  **Open terminal** actions; after Copilot finishes an **Ask Copilot** turn, the
  canvas refreshes diagnostics automatically.
- **Detected installations** — an always-visible section listing the CLI
  installations found on the machine, each with its path, version, channel,
  route, and `active`/`shadowed` state.
- **Re-run in place** — refresh the checks from the toolbar or via the agent
  without reloading the panel.
- **Native look & feel** — chrome is built on the documented app theme tokens
  and adapts to light/dark.
- **Loading UX** — shaped skeletons that mirror the real layout, shimmer, and
  View-Transition cross-fades (respecting `prefers-reduced-motion`).

## How it works

Each open canvas instance runs a small loopback HTTP server (`127.0.0.1`, random
port) that serves the static UI from `ui/` and a JSON API:

| Route | Purpose |
| --- | --- |
| `GET /` | Renderer page |
| `GET /api/diagnostics` | Run `aspire doctor`, parse it, return results JSON |
| `POST /api/ask-copilot` | Send a check to the current Copilot session |
| `POST /api/open-terminal` | Open a terminal canvas for a check |
| `POST /api/open-path` | Open a detected path |
| `GET /events` | Server-Sent Events used to push diagnostics after agent-driven re-runs |

Diagnostics are produced by shelling out to
`aspire doctor --format Json --non-interactive --nologo` and parsing the JSON.
`aspire` is resolved from `PATH`; set the `ASPIRE_CLI` environment variable to
an explicit executable path if the CLI is not on `PATH`.

## Agent actions & tools

- **`open_aspire_doctor`** `{ instanceId? }` *(tool)* — open or focus the canvas
  in the side panel.
- **`run_diagnostics`** `{}` *(canvas action)* — re-run `aspire doctor` and push
  fresh results to the open canvas over SSE, returning the summary.

The extension also registers two hooks that softly bridge the CLI's `doctor` MCP
tool (which returns text to the model) and this canvas (which renders it):

- **`onSessionStart`** — a once-per-session standing instruction to prefer
  surfacing environment diagnostics by opening the canvas rather than answering
  text-only.
- **`onPostToolUse`** — after the agent runs the doctor diagnostics tool, a nudge
  to open the canvas so the user sees the full visual report.

Both hooks only add hidden guidance — the agent decides whether opening the panel
fits the moment.

## Files

```
aspire-doctor/
  extension.mjs        wiring: server, routes, canvas + action + tool, hooks
  ui/index.html        renderer markup (toolbar + diagnostics + installations)
  ui/styles.css        og-preview-derived design system + app-theme chrome
  ui/app.js            client logic (fetch, render, SSE, path/fix actions, transitions)
```
