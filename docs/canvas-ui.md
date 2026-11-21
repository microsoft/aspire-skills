# Shared canvas UI

All canvases should use shared themes, typography, controls, branding, and icons
while preserving their own workflows.

## Shared assets

Edit the canonical [stylesheet](../assets/canvas/theme.css) and
[icon sprite](../assets/canvas/icons.svg). The canvas providers serve
`/canvas-theme.css` and `/canvas-icons.svg` directly from these files under the
plugin root. Keep this single source of truth; do not add per-canvas copies or
synchronization scripts.

The extension `ui/` directories retain relative symlinks for existing packagers.
Git for Windows can check these links out as ordinary path-text files when
`core.symlinks` is `false`. Providers in a source checkout or full-root plugin
installation do not depend on these UI links, so styling and icons still work.

When the canonical asset is absent (`ENOENT`) or an ancestor is not a directory
(`ENOTDIR`), providers fall back to the corresponding file in their own `ui/`
directory. Standalone extension packages without the
plugin root must therefore supply readable CSS and SVG there, not Git
placeholder files or dangling links. Other read errors do not trigger fallback.

The published plugin mirror still uses relative symlinks to the canonical
extension sources. Direct asset serving does not change how those mirror links
are packaged or resolved.

## Conventions

- Put common styles and icons in the shared assets. Keep only workflow-specific
  layout and interactions local.
- Load shared styles before local styles.
- Follow the host's theme and fonts rather than defining independent palettes
  or overriding host-owned values.
- Preserve accessible labels, keyboard focus, contrast, and reduced-motion
  support.
- Review changes in light and dark themes and at narrow and wide sizes without
  changing the canvas's workflow.

## Chat delivery contract

- **Add to chat** prepares context for attachment and never starts a turn.
  **Ask Copilot** starts a turn now.
- Report success only after the relevant delivery boundary is confirmed.
  Preparing or queuing context is **pending**, not confirmed model delivery.
  Explain any extra step at click time, and do not claim a composer attachment
  without host confirmation.
- Show request and clipboard failures in the canvas. Report unmatched references
  through the prompt hook so Copilot can tell the user what was not attached and
  ask them to re-add it.
- Serialize canvas data sent to the model and explicitly mark it as untrusted
  data, not instructions.

AppHosts uses a reference-based bridge: Add to chat shows a persistent, copyable
reference and focuses its copy control. Only a root prompt in the owning session
and workspace that includes that reference receives the snapshot. An ordinary
message without a reference attaches nothing. The bridge confirms handoff to
`onUserPromptSubmitted.additionalContext`, not end-to-end model delivery; another
hook can still block the turn. Requests still in flight when the foreground
prompt hook executes fail visibly and must be retried. This is a hook-time fence,
not a submission-time ordering guarantee or proof of user authorship.

Doctor's existing early "Queued for Copilot" status and rejected-send logging
do not yet meet this contract; fixing those is separate from the AppHosts bridge.
