import { defineConfig } from "astro/config";
import expressiveCode from "astro-expressive-code";
import icon from "astro-icon";

const isGitHubActions = process.env.GITHUB_ACTIONS === "true";
const defaultSite = isGitHubActions ? "https://solid-barnacle-o328nr3.pages.github.io" : "https://microsoft.github.io";
const defaultBase = isGitHubActions ? "/" : "/aspire-skills";
const site = process.env.ASTRO_SITE || defaultSite;
const base = process.env.ASTRO_BASE === undefined ? defaultBase : process.env.ASTRO_BASE || "/";

export default defineConfig({
  site,
  base,
  output: "static",
  trailingSlash: "always",
  integrations: [
    icon(),
    expressiveCode({
      themes: ["catppuccin-latte", "catppuccin-mocha"],
      defaultProps: {
        wrap: true
      },
      styleOverrides: {
        borderRadius: "0.875rem",
        codeFontSize: "0.875rem",
        frames: {
          frameBoxShadowCssValue: "none"
        }
      }
    })
  ]
});
