import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = new URL("../", import.meta.url);
const extensions = ["aspire-apphosts", "aspire-doctor", "aspireify"];
const theme = await readFile(new URL("assets/canvas/theme.css", repoRoot), "utf8");
const icons = await readFile(new URL("assets/canvas/icons.svg", repoRoot), "utf8");
const symbols = [...icons.matchAll(/<symbol id="([^"]+)" viewBox="([^"]+)"/g)];
const symbolIds = new Set(symbols.map(([, id]) => id));

for (const extension of extensions) {
  test(`${extension} ships exact, self-contained copies of the shared canvas assets`, async () => {
    for (const asset of ["theme.css", "icons.svg"]) {
      const source = await readFile(new URL(`assets/canvas/${asset}`, repoRoot));
      const copy = await readFile(new URL(`extensions/${extension}/ui/canvas-${asset}`, repoRoot));
      assert.deepEqual(copy, source, `${extension}: run npm run canvas:sync after editing ${asset}`);
    }
  });

  test(`${extension} loads the shared foundation and only references published icons`, async () => {
    const root = new URL(`extensions/${extension}/`, repoRoot);
    const [html, app, styles, provider] = await Promise.all([
      readFile(new URL("ui/index.html", root), "utf8"),
      readFile(new URL("ui/app.js", root), "utf8"),
      readFile(new URL("ui/styles.css", root), "utf8"),
      readFile(new URL("extension.mjs", root), "utf8")
    ]);
    assert.ok(html.includes('href="/canvas-theme.css"'));
    assert.ok(html.indexOf('href="/canvas-theme.css"') < html.indexOf('href="/styles.css"'));
    assert.match(provider, /"\/canvas-theme\.css"/);
    assert.match(provider, /"\/canvas-icons\.svg"/);
    assert.match(provider, /"\.svg": "image\/svg\+xml"/);
    assert.doesNotMatch(styles, /--fgColor-|prefers-color-scheme|--font-sans|--font-mono/);
    assert.doesNotMatch(styles, /--(?:surface|text|muted|accent|healthy|warning|failure|focus)\s*:/);
    assert.doesNotMatch(styles, /(?:^|\n)body\s*\{[^}]*\bbackground(?:-color)?\s*:/,
      "page backgrounds belong to the shared foundation");
    assert.doesNotMatch(styles, /var\(--canvas-wash\)/);
    if (extension === "aspire-apphosts") {
      assert.match(styles, /\.canvas-surface\s*\{[^}]*background: var\(--surface\);/);
    }
    assert.doesNotMatch(styles, /font-size:\s*\d+\.\d+px/);
    assert.doesNotMatch(html, /<path\b/);
    assert.doesNotMatch(app, /setAttribute\("d", ICONS/);
    assert.match(html, /class="[^"]*canvas-toolbar"/);
    assert.match(html, /class="[^"]*canvas-heading"/);
    assert.match(html, /class="[^"]*canvas-subtitle"/);
    assert.match(html, /class="[^"]*canvas-brand"/);
    assert.match(html, /href="\/canvas-icons\.svg#aspire"/);
    for (const [, attributes, contents] of html.matchAll(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/g)) {
      assert.match(attributes, /aria-hidden="true"/);
      assert.match(attributes, /focusable="false"/);
      const id = contents.match(/<use href="\/canvas-icons\.svg#([^"]+)"/)?.[1];
      assert.ok(symbolIds.has(id), `${extension} references unknown icon ${id}`);
    }
  });
}

test("the canvas asset check does not require a build or external dependencies", () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("scripts/sync-canvas-assets.mjs", repoRoot)), "--check"
  ], { cwd: fileURLToPath(repoRoot), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("asset synchronization detects drift without writing and repairs all standalone copies", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aspire-canvas-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "scripts"));
  await mkdir(join(directory, "assets", "canvas"), { recursive: true });
  await Promise.all(extensions.map(extension =>
    mkdir(join(directory, "extensions", extension, "ui"), { recursive: true })
  ));
  await copyFile(
    new URL("scripts/sync-canvas-assets.mjs", repoRoot),
    join(directory, "scripts", "sync-canvas-assets.mjs")
  );
  for (const name of ["theme.css", "icons.svg"]) {
    await copyFile(new URL(`assets/canvas/${name}`, repoRoot), join(directory, "assets", "canvas", name));
  }
  const run = (...args) => spawnSync(process.execPath, [
    join(directory, "scripts", "sync-canvas-assets.mjs"), ...args
  ], { cwd: directory, encoding: "utf8" });
  assert.equal(run("--check").status, 1, "missing copies must fail the check");
  assert.equal(run().status, 0);
  const stale = join(directory, "extensions", "aspireify", "ui", "canvas-theme.css");
  await writeFile(stale, "stale fixture");
  assert.equal(run("--check").status, 1);
  assert.equal(await readFile(stale, "utf8"), "stale fixture", "check mode must not rewrite drift");
  assert.equal(run().status, 0);
  assert.equal(await readFile(stale, "utf8"), theme);
  assert.equal(run("--check").status, 0);
  assert.notEqual(run("--unknown").status, 0);
});

test("shared theme tokens consume host values without overwriting them", () => {
  assert.match(theme, /--surface: var\(--background-color-default,/);
  assert.match(theme, /--text: var\(--text-color-default,/);
  assert.match(theme, /--muted: var\(--text-color-muted,/);
  assert.match(theme, /--focus: var\(--color-focus-outline,/);
  assert.match(theme, /--font-body: var\(--font-sans,/);
  assert.match(theme, /--font-code: var\(--font-mono,/);
  assert.match(theme, /:root,\s*body\s*\{/);
  assert.match(theme, /:root\[data-color-mode="light"\]/);
  assert.match(theme, /:root:not\(\[data-color-mode\]\):has\(body\[data-color-mode="light"\]\)/);
  assert.match(theme, /:root\[data-color-mode="dark"\]/);
  assert.match(theme, /:root:not\(\[data-color-mode\]\):has\(body\[data-color-mode="dark"\]\)/);
  assert.doesNotMatch(theme, /--(?:background-color-default|text-color-default|text-color-muted|true-color-\w+|font-sans|font-mono|color-focus-outline)\s*:/);
  assert.doesNotMatch(theme, /--fgColor-/);
  assert.match(theme, /(?:^|\n)body\s*\{[^}]*background: var\(--surface\);/);
  assert.doesNotMatch(theme, /--canvas-wash\s*:/);
  assert.match(theme, /a\[href\].*\[tabindex\]\):focus-visible/);
  assert.match(theme, /outline: 2px solid var\(--focus\)/);
  assert.match(theme, /@media \(prefers-reduced-motion: reduce\)/);
});

test("fallback text, status, and filled-action colors meet WCAG AA in both themes", () => {
  const surfaces = fallbackColors("surface");
  for (const name of ["text", "muted", "accent", "brand", "healthy", "warning", "failure"]) {
    const colors = fallbackColors(name);
    for (const mode of [0, 1]) {
      assert.ok(
        contrast(colors[mode], surfaces[mode]) >= 4.5,
        `${name} must have 4.5:1 text contrast in ${mode === 0 ? "light" : "dark"} mode`
      );
    }
  }
  for (const [background, foreground] of [
    ["accent", "accent-fg"], ["failure", "danger-fg"], ["brand", "brand-fg"]
  ]) {
    for (const mode of [0, 1]) {
      assert.ok(
        contrast(fallbackColors(background)[mode], fallbackColors(foreground)[mode]) >= 4.5,
        `${background} actions must have 4.5:1 label contrast in theme ${mode}`
      );
    }
  }
});

test("small labels on tinted status, selected-tab, and relationship surfaces meet WCAG AA", async () => {
  const [apphosts, aspireify] = await Promise.all([
    readFile(new URL("extensions/aspire-apphosts/ui/styles.css", repoRoot), "utf8"),
    readFile(new URL("extensions/aspireify/ui/styles.css", repoRoot), "utf8")
  ]);
  assert.match(apphosts, /\.summary-chip\.tone-warning,[^{]+\{\s*color: color-mix\(in srgb, var\(--warning\), var\(--text\) 25%\)/);
  assert.match(apphosts, /\.app-model-tab\.is-active \.app-model-tab-count \{\s*background: var\(--brand-soft\);\s*color: var\(--brand-strong\)/);
  assert.match(theme, /--brand-strong: color-mix\(in srgb, var\(--brand\), var\(--text\) 18%\)/);
  assert.match(aspireify, /\.connection-chip-affordance \{[^}]*color: color-mix\(in srgb, var\(--relationship-color\), var\(--text\) 25%\)/);
  for (const mode of [0, 1]) {
    const surface = fallbackColors("surface")[mode];
    const text = fallbackColors("text")[mode];
    const warning = mix(fallbackColors("warning")[mode], text, 0.75);
    assert.ok(contrast(warning, mix(warning, surface, 0.08)) >= 4.5, `warning label in theme ${mode}`);
    const brand = fallbackColors("brand")[mode];
    assert.ok(
      contrast(mix(brand, text, 0.82), mix(brand, surface, 0.12)) >= 4.5,
      `selected resource count in theme ${mode}`
    );
    for (const relationship of ["accent", "warning", "brand"]) {
      const color = fallbackColors(relationship)[mode];
      for (const tint of [0.11, 0.18]) {
        assert.ok(
          contrast(mix(color, text, 0.75), mix(color, surface, tint)) >= 4.5,
          `${relationship} relationship label with ${tint} tint in theme ${mode}`
        );
      }
    }
  }
});

test("the shared sprite has unique, local-only symbols and preserves the official Aspire mark", () => {
  assert.equal(symbolIds.size, symbols.length);
  for (const [, id, viewBox] of symbols) {
    assert.equal(viewBox, id === "aspire" ? "0 0 32 32" : "0 0 16 16");
  }
  for (const id of ["aspire", "pass", "warning", "error", "restart", "terminal", "add", "close"]) {
    assert.ok(symbolIds.has(id), `${id} must be a shared icon`);
  }
  assert.doesNotMatch(icons, /<(?:script|image|foreignObject)\b|\bon\w+=|(?:href|src)=/i);
  const brand = icons.match(/<symbol id="aspire"[^>]*>([\s\S]*?)<\/symbol>/)?.[1];
  assert.equal((brand?.match(/<path\b/g) ?? []).length, 6);
  assert.match(brand, /fill="#512BD4"/);
});

function fallbackColors(name) {
  const declaration = theme.match(new RegExp(`--${name}: [^\\n]*light-dark\\((#[\\da-f]{6}), (#[\\da-f]{6})\\)`, "i"));
  assert.ok(declaration, `${name} must define light and dark fallback colors`);
  return declaration.slice(1);
}

function mix(first, second, fraction) {
  const channels = hex => hex.slice(1).match(/../g).map(channel => parseInt(channel, 16));
  const background = channels(second);
  return "#" + channels(first).map((channel, index) =>
    Math.round(channel * fraction + background[index] * (1 - fraction)).toString(16).padStart(2, "0")
  ).join("");
}

function contrast(first, second) {
  const luminance = hex => {
    const channels = hex.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
