# Shared canvas UI

Aspire AppHosts, Aspire Doctor, and Aspireify share Aspireify's compact visual
language: neutral surfaces, restrained accents, a single type scale, and consistent
controls and branding. They do not depend on another extension at runtime.
Each extension ships local copies of
the canonical [theme](../assets/canvas/theme.css) and
[SVG sprite](../assets/canvas/icons.svg).

## Edit and synchronize

Edit the canonical assets, not the generated `ui/canvas-theme.css` or
`ui/canvas-icons.svg` files. Then run from the repository root:

```powershell
npm run canvas:sync
npm run canvas:check
npm test
```

Commit the canonical assets and all generated copies together. The check command
reports missing or stale copies without changing files. Tests also enforce exact
copies, valid icon references, host-token ownership, fallback contrast, static
asset responses, and the published plugin's relative Git symlinks.

## Theme ownership

The shared stylesheet maps host-owned tokens to canvas roles. It never assigns
values to host tokens such as `--background-color-default`, `--text-color-default`,
`--font-sans`, or `--color-focus-outline`.

| Canvas role | Meaning |
| --- | --- |
| `--surface`, `--text`, `--muted`, `--border` | Default background, text, secondary text, and boundaries |
| `--accent`, `--accent-fg` | Primary action and its label |
| `--brand`, `--brand-fg` | Aspire identity and its contrasting label |
| `--healthy`, `--warning`, `--failure` | Success, warning, and failure |
| `--danger-fg` | Label on a filled destructive action |
| `--focus`, `--control-border` | Keyboard focus and control boundaries |
| `--card-surface`, `--surface-muted`, `--surface-inset` | Derived component surfaces |

Mappings apply on both the root and body so either can receive host tokens.
Fallback colors use `light-dark()`: an explicit root `data-color-mode` wins,
otherwise a body attribute selects the theme, otherwise the system preference
applies. Theme and host-token changes take effect through CSS without reloading
the renderer or replacing form state.

Use semantic roles in component styles rather than fixed light/dark palettes.
Keep text and action-label contrast at least 4.5:1 and focus/control boundaries
at least 3:1 against adjacent surfaces. On tinted surfaces, mix label colors
toward `--text` rather than reusing a hue intended for a plain background.
The fallback-palette tests cover both themes, including tinted labels and
relationship hover states; custom host colors still need visual and contrast
review.

## Typography and controls

Body and code families consume the host's sans-serif and monospace tokens.
Use the shared size roles instead of introducing fractional component scales.

| Role | Default size | Use |
| --- | --- | --- |
| `--text-title` | 20px | Main work-area title |
| `--text-section` | 18px | Section or dialog title |
| `--text-heading` | 15px | Canvas heading and resource title |
| `--text-body` | 14px | Body text and default controls |
| `--text-detail` | 13px | Detail text and compact content |
| `--text-meta` | 12px | Metadata and small controls |
| `--text-compact` | 11px | Dense operational labels |
| `--text-code` | 12px | Paths, commands, and code |

The matching `--leading-body`, `--leading-heading`, `--leading-title`,
`--leading-detail`, and `--leading-meta` roles define common line heights.
Shared `.btn`, `.button`, and `.tray-action` rules provide control typography,
spacing, sizing, and primary, outline, quiet, and destructive variants.
Shared `.canvas-toolbar`, `.canvas-heading`, `.canvas-subtitle`, and
`.canvas-brand` classes keep the canvas chrome consistent.
Component styles retain responsive hit targets
and workflow-specific layout.

The foundation supplies `:focus-visible` outlines, native select colors,
decorative icon sizing behavior, scrollbars, and reduced-motion control
transitions. Preserve component-specific reduced-motion rules for skeletons,
graphs, and view transitions.

## Icons

Use a symbol from the local sprite instead of copying path data, adding a
webfont, or loading a remote icon library:

```html
<button type="button" aria-label="Refresh resources">
  <svg class="canvas-icon" width="16" height="16" viewBox="0 0 16 16"
       aria-hidden="true" focusable="false">
    <use href="/canvas-icons.svg#restart"></use>
  </svg>
</button>
```

Most symbols use a 16-by-16 viewBox and inherit `currentColor`. The official
`aspire` mark uses a 32-by-32 viewBox and preserves its multicolor paths.
Use `pass`, `warning`, and `error` for status; `restart`, `add`, and `close`
for their matching actions. Add missing symbols to the canonical sprite.

Decorative SVGs stay hidden from assistive technology and out of the tab order.
Put the accessible name on the surrounding button or link, and retain visible
status text so color and shape are not the only cues. Dynamically created icons
follow the same contract.

## Adopt the foundation

1. Add the extension to the target list in
   [sync-canvas-assets.mjs](../scripts/sync-canvas-assets.mjs) and synchronize.
2. Load `/canvas-theme.css` before the component stylesheet. Serve it and
   `/canvas-icons.svg` through the provider's exact static allowlist, with
   `text/css` and `image/svg+xml` MIME types. Preserve existing authorization,
   path containment, and Content Security Policy.
3. Consume shared roles and remove duplicate base palettes, font stacks, resets,
   and icon geometry. Keep resource-kind palettes and component layout local.
4. Add the generated files to the published plugin mirror as relative Git
   symlinks (mode `120000`), matching the other extension files.
5. Add the extension to the shared asset tests and review the browser states
   below.

## Browser review

Run the read-only preview from the repository root:

```powershell
node tests\fixtures\canvas-preview.mjs
```

It prints one loopback URL per extension and serves the shipped UI with synthetic
API and event data. It does not load the SDK, run the CLI, or open a real
Aspireify confirmation. Resource mutations and external actions are disabled;
AppHosts refresh only replays the fixture, and selection only acknowledges focus.

Add `&state=loading`, `empty`, `error`, `long`, or `populated` to a printed URL.
Aspireify also supports `confirmed` for its read-only submitted state. Stop the
preview with Ctrl+C.

Review each state at 320px and wide desktop widths in light and dark mode.
While a populated page remains open, switch `data-color-mode` on the root or
body, including opposite system/explicit themes, and change host color and font
tokens. Check that drafts, selection, expanded details, confirmation state,
keyboard focus, native controls, and SVG rendering remain intact. Inspect long
paths and labels for overflow.

## Intentional differences

All three canvases use the same `--surface` page background.

AppHosts keeps its operational board, dense labels, resource
cards, and relationship graph. Doctor keeps its severity-ordered diagnostic
report, summary pills, and expandable details. Aspireify keeps resource-kind
colors, mapping and relationship editors, and its immutable confirmation
boundary. These differences express each workflow; they do not introduce
separate base themes, font families, or icon sets.
