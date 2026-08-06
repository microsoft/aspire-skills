# Aspireify canvas

This canvas is Aspireify's Step 3 confirmation boundary: a snapshot of the
findings and proposed AppHost resource plan shown before any files change.

The Aspireify skill owns scanning, proposal logic, AppHost edits, and validation.
Discovery questions and implementation tradeoffs stay in chat; the proposal is the
only interactive decision surface shown in the canvas.
The canvas only:

1. opens through `open_aspireify`;
2. receives the detected AppHost style and discovered runnable services through
   `load_discovery`, using a stable unique ID for each service and the latest
   `scanGeneration` from a re-scan callback;
3. receives resources and connections through `set_proposal`, using the current
   `proposalGeneration` returned by `load_discovery` or included in a
   proposal-regeneration callback;
4. presents those findings as grouped resource cards with connections shown as
   secondary relationship chips;
5. organizes resources into collapsible sections and cards with contextual add
   controls, with empty sections collapsed by default;
6. lets the user add or remove plan resources, add their initial connections
   atomically, rename or retype resources, enable Service Defaults, and manage
   connections from each resource editor using constrained Aspire-aware
   resource-type selectors;
7. identifies every invalid or duplicate resource name on its card, explains the
   violated naming rule, and prevents invalid edits from being saved;
8. requests a regenerated proposal when a service-level choice changes while
   preserving user-added resources and connections; and
9. returns the confirmed service choices and edited plan through
   `get_confirmation`.

After confirmation, the canvas becomes read-only and `get_confirmation` returns
the immutable submitted snapshot even if a stale client attempts a later mutation.

Connections are directed: `from` references, waits for, or is a child of `to`.
Each resource card shows both outgoing and incoming relationships so the proposal
remains readable without relying on a topology layout.

The AppHost style is read-only in this surface. Re-scan asks the Aspireify skill
to run discovery again and is disabled while findings or a proposal are loading.

Extension hooks advertise the canvas at session start, reinforce the Step 3
handoff for Aspireify-intent prompts and skill activation, guide the agent after
opening and populating the canvas, and treat `[aspireify canvas: ...]` callbacks
as explicit user requests.

It intentionally has no repository detector, scanner, proposal generator,
AppHost editor, deployment controls, initialization flow, or validation workflow.
