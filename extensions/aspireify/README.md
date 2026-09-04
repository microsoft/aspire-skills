# Aspireify canvas

This canvas is Aspireify's strict Step 3 confirmation boundary: one generated,
timestamped AppHost proposal snapshot shown before AppHost wiring begins.

The Aspireify skill owns scanning, proposal logic, AppHost edits, and validation.
Discovery questions and implementation tradeoffs stay in chat; the proposal is the
only interactive decision surface shown in the canvas.
The canvas only:

1. opens through `open_aspireify`;
2. receives the detected AppHost style and discovered runnable services through
   `load_discovery`, using the skill's existing stable ID, name, type, framework,
   HTTP exposure, path, inclusion, resource name, and Service Defaults fields;
3. receives resources and connections through `set_proposal`, using the current
   `proposalGeneration` and the skill's existing resource and edge fields;
4. explicitly maps source services to proposed Aspire resources without showing
   discovered services that the skill did not include in the proposal;
5. uses a compact mapping-first review for one or two resources and a role-grouped
   overview with one focused inspector for larger plans;
6. lets the user add or remove plan resources, add their initial connections
   atomically, rename or retype resources within their section, enable Service
   Defaults on any .NET project, and manage connections from each resource
   editor using constrained Aspire-aware resource-type selectors;
7. tracks up to 50 saved proposal edits per AppHost so users can undo and redo
   resource and connection changes, reset all generated resource fields together,
   or reset an edited generated connection;
8. identifies every invalid or duplicate resource name on its card, explains the
   violated naming rule, and prevents invalid edits from being saved;
9. keeps unresolved implementation tradeoffs in chat rather than inventing new
   canvas data; and
10. returns the confirmed service choices, exact structured plan, generation,
    and stable proposal hash through `get_confirmation`.

After confirmation, the canvas becomes read-only and `get_confirmation` returns
the immutable submitted snapshot even if a stale client attempts a later mutation.
The confirmed surface states that implementation continues in chat; it never
becomes a startup, editing, validation, or execution tracker.

Connections are directed: `from` references, waits for, or is a child of `to`.
Each selected resource shows both outgoing and incoming relationships, while an
expanded canonical list presents every connection once.

The AppHost style is read-only in this surface. Loading only indicates that the
generated proposal snapshot is being received. Scanning, clarification, proposal
generation, implementation, startup, and validation remain in the Aspireify skill
and chat.

Extension hooks advertise the canvas at session start, reinforce the Step 3
handoff for Aspireify-intent prompts and skill activation, guide the agent after
opening and populating the canvas, and treat `[aspireify canvas: ...]` callbacks
as explicit user requests.

It intentionally has no repository detector, scanner, proposal generator,
AppHost editor, deployment controls, initialization flow, or validation workflow.

## Troubleshooting

- **The canvas never opens.** Some clients cannot host the canvas surface. The
  skill falls back to presenting and confirming the same proposal in chat, so
  continue there instead of waiting on a panel.
- **The panel shows "Proposal unavailable" with a "Try again" button.** The
  initial snapshot request failed (for example, a dropped connection to the
  extension's local server). Select **Try again**, or ask the agent to reopen
  the canvas if it keeps failing.
- **"Proposal generation failed" with a "Retry proposal" button.** The skill's
  most recent proposal regeneration errored. Select **Retry proposal**; if it
  keeps failing, describe the problem in chat so the skill can adjust the
  proposal before retrying.
- **A stale or duplicate canvas tab shows "Missing or invalid Aspireify
  token" or won't load at all.** The canvas backend issues a fresh token each
  time it starts, so a bookmarked or reopened old tab stops matching it. Close
  the stale tab and reopen the canvas from the agent instead of reusing a
  saved URL.
- **Edits fail with "The confirmed resource plan is read-only."** The proposal
  was already confirmed, so the canvas is displaying the immutable submitted
  snapshot. If more changes are needed, ask the agent for a new proposal.
- **Undo or redo reports "Undo and redo are unavailable while the proposal is
  changing."** A new proposal snapshot is still arriving. Wait for it to
  finish loading, then retry.
- **A resource card is stuck on "Needs attention" and won't save.** The
  resource name violates an Aspire naming rule; the card explains which rule
  and blocks the save until the name is fixed (see point 8 above).
- **Copying a resource's path doesn't populate the clipboard.** Some hosts
  restrict clipboard access. Select the path text shown next to **Copy path**
  and copy it manually instead.
