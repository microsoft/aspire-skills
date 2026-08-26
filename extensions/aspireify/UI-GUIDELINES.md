# Aspireify canvas UI/UX guidance

The Aspireify canvas is a review-and-confirm surface for one generated AppHost
proposal. It is not a repository scanner, configuration wizard, implementation
tracker, or validation dashboard.

## Information model

Every visible value must have clear provenance:

- **Detected facts** come from `load_discovery`: source service identity, type,
  framework, HTTP exposure, and path. They are read-only because changing them
  would misrepresent the skill's scan.
- **Proposal choices** come from `set_proposal`: Aspire resource name, exact
  Aspire type, proposal detail, Service Defaults, inclusion, and connections.
  They are directly editable because confirmation applies to this proposal.
- **Canvas metadata** is generated locally: proposal timestamp, generation, and
  hash. It identifies the snapshot but makes no repository claim.

Do not display fields the skill did not supply. Do not infer a source mapping
when a proposal resource has no explicit `serviceId`. Do not render unproposed
discovery services in a separate section.

## Interaction model

- Editable proposal values look and behave like controls in place. Do not hide
  routine edits behind a generic **Edit** action.
- Read-only discovery facts use plain text, chips, or path treatment—not
  disabled inputs—so the distinction is visible rather than surprising.
- Resource and type edits save on change; Enter commits text fields.
- Service Defaults uses a labeled checkbox.
- Every resource exposes **Add connection**. Existing connection chips open
  their connection editor. Removal remains explicit and guarded.
- Resource groups and resource cards are accordions. Their full title and
  description area is one hit target, with accurate `aria-expanded` and
  `aria-controls`.
- After confirmation, all proposal controls are read-only and the canvas states
  that implementation continues in chat.

## Visual hierarchy

Follow the Aspire Doctor canvas:

- Use documented semantic theme tokens and the shared typography ramp.
- Use one outer scroll container; never nest a clipped resource-list scrollbar.
- Keep the toolbar compact and use its subtitle for snapshot status.
- Use flat bordered sections and cards, restrained inset rows, and no decorative
  color rails or shadows.
- Use normal UI typography for names and descriptions. Reserve monospace for
  paths, hashes, and code-shaped values.
- Keep the sticky footer minimal: validation feedback when needed and a single
  **Confirm** button.

## Adaptive layout

- One or two resources use a compact list.
- Larger proposals use grouped resource sections with relationship chips.
- Empty groups may collapse by default, but their add action remains available.
- On narrow panels, inputs and footer actions use the full available width.

## Loading, errors, and concurrency

- Loading means only that the generated proposal snapshot is being received.
  Reuse Aspire Doctor's skeleton cards and indeterminate progress treatment.
- Never imply that the canvas is scanning, editing, starting, or validating.
- Proposal-generation errors replace the skeleton with a retryable error state.
- Disable confirmation while any inline save is pending.
- Confirmation and all mutation routes must enforce the same server-side
  generation, validation, and read-only guards as the UI.

## Accessibility

- Buttons and inputs need specific accessible names.
- Focus outlines use the canvas focus token.
- Interactive rows must be keyboard operable.
- Reduced-motion mode disables shimmer, progress, and entrance animations.
- Do not rely on color alone for state or editability.
