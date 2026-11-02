# Shared canvas UI

All canvases should use shared themes, typography, controls, branding, and icons
while preserving their own workflows.

## Shared assets

Edit the canonical [stylesheet](../assets/canvas/theme.css) and
[icon sprite](../assets/canvas/icons.svg). Share them through relative symlinks,
not copied files or synchronization scripts.

Source checkouts must support symlinks. The published plugin mirror preserves
these relative links to the canonical extension sources.

### Windows source checkouts

Git for Windows can check out symlinks as ordinary files when `core.symlinks` is
`false`. In that checkout, `canvas-theme.css` contains a relative path instead of
CSS, and `canvas-icons.svg` is not an SVG document. Canvas styling and icons break,
and shared-asset tests fail.

Enable Windows Developer Mode or use a terminal with the required symlink
privilege, subject to your machine's policies. Then clone into a new directory
with symlinks enabled for that repository:

```powershell
git clone --config core.symlinks=true https://github.com/microsoft/aspire-skills.git aspire-skills-symlinks
Set-Location aspire-skills-symlinks
git config --show-origin --get core.symlinks
Get-Item -LiteralPath .\extensions\aspire-doctor\ui\canvas-theme.css | Select-Object LinkType, Target
```

The configuration should report `true`, and `LinkType` should be `SymbolicLink`.
Git must also have permission to create the links; setting the configuration alone
does not grant that permission.

Changing `core.symlinks` after checkout does not replace existing placeholder
files. Prefer a fresh clone rather than overwriting files in a checkout with local
changes. Do not copy shared assets into each canvas or disable the symlink tests
to work around the checkout prerequisite.

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
