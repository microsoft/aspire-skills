# Shared canvas UI

All canvases should use shared themes, typography, controls, branding, and icons
while preserving their own workflows.

## Shared assets

Edit the canonical [stylesheet](../assets/canvas/theme.css) and
[icon sprite](../assets/canvas/icons.svg). Share them through relative symlinks,
not copied files or synchronization scripts.

Source checkouts must support symlinks. Published bundles must resolve those
links into regular files so each extension remains self-contained.

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
