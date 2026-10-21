import assert from "node:assert/strict";
import { lstat, readFile, readlink } from "node:fs/promises";
import { test } from "node:test";

const repoRoot = new URL("../", import.meta.url);
const extensions = ["aspire-apphosts", "aspire-doctor", "aspireify"];
const theme = await readFile(new URL("assets/canvas/theme.css", repoRoot), "utf8");
const icons = await readFile(new URL("assets/canvas/icons.svg", repoRoot), "utf8");
const symbols = [...icons.matchAll(/<symbol\b[^>]*\bid="([^"]+)"/g)];
const symbolIds = new Set(symbols.map(([, id]) => id));

for (const extension of extensions) {
  test(`${extension} links directly to the canonical shared canvas assets`, async () => {
    for (const asset of ["theme.css", "icons.svg"]) {
      const link = new URL(`extensions/${extension}/ui/canvas-${asset}`, repoRoot);
      assert.ok((await lstat(link)).isSymbolicLink(), "source checkouts must enable Git symlinks");
      assert.equal((await readlink(link)).replaceAll("\\", "/"), `../../../assets/canvas/${asset}`);
    }
  });

  test(`${extension} has no unknown static sprite references`, async () => {
    const html = await readFile(new URL(`extensions/${extension}/ui/index.html`, repoRoot), "utf8");
    for (const [, id] of html.matchAll(/\bhref=["']\/canvas-icons\.svg#([^"']+)["']/g)) {
      assert.ok(symbolIds.has(id), `${extension} references unknown icon ${id}`);
    }
  });
}

test("shared styles do not overwrite host-owned tokens", () => {
  assert.doesNotMatch(theme, /--(?:background-color-default|text-color-default|text-color-muted|true-color-\w+|font-sans|font-mono|color-focus-outline)\s*:/);
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

test("shared sprite identifiers are nonempty and unique", () => {
  assert.ok(symbolIds.size > 0);
  assert.equal(symbolIds.size, symbols.length);
});

function fallbackColors(name) {
  const declaration = theme.match(new RegExp(`--${name}: [^\\n]*light-dark\\((#[\\da-f]{6}), (#[\\da-f]{6})\\)`, "i"));
  assert.ok(declaration, `${name} must define light and dark fallback colors`);
  return declaration.slice(1);
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
