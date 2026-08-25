# Aspireify canvas

This canvas is Aspireify's strict Step 3 confirmation boundary: one generated,
timestamped AppHost proposal snapshot shown before any files change.

The Aspireify skill owns scanning, proposal logic, AppHost edits, and validation.
Discovery questions and implementation tradeoffs stay in chat; the proposal is the
only interactive decision surface shown in the canvas.
The canvas only:

1. opens through `open_aspireify`;
2. receives the detected AppHost style and discovered runnable services through
   `load_discovery`, using a stable unique ID, exact type label, path, command,
   ports, ownership, and service-code impact when known;
3. receives resources and connections through `set_proposal`, using the current
   `proposalGeneration`, plus the generated timestamp, exact Aspire types,
   packages and versions, ownership, scope, assumptions, risks, and chat-decision
   state;
4. explicitly maps source services to proposed Aspire resources and keeps
   external infrastructure that is not in the proposal out of the Aspire graph;
5. uses a compact mapping-first review for one or two resources and grouped,
   relationship-oriented cards for larger plans;
6. lets the user add or remove plan resources, add their initial connections
   atomically, rename or retype resources within their section, enable Service
   Defaults on any .NET project, and manage connections from each resource
   editor using constrained Aspire-aware resource-type selectors;
7. identifies every invalid or duplicate resource name on its card, explains the
   violated naming rule, and prevents invalid edits from being saved;
8. displays agent-supplied assumptions and risks without performing platform or
   feasibility checks;
9. blocks confirmation while a tradeoff is marked `needs-chat-decision` or a
   supplied risk is blocking, leaving resolution in chat; and
10. returns the confirmed service choices, exact structured plan, generation,
    and stable proposal hash through `get_confirmation`.

After confirmation, the canvas becomes read-only and `get_confirmation` returns
the immutable submitted snapshot even if a stale client attempts a later mutation.
The confirmed surface states that implementation continues in chat; it never
becomes a startup, editing, validation, or execution tracker.

Connections are directed: `from` references, waits for, or is a child of `to`.
Each resource card shows both outgoing and incoming relationships so the proposal
remains readable without relying on a topology layout.

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
