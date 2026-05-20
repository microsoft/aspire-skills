import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "astro/config";
import expressiveCode from "astro-expressive-code";
import icon from "astro-icon";

const publicSite = "https://microsoft.github.io";
const publicBase = "/aspire-skills";
const defaultBase = isPrivateGitHubRepositoryBuild() ? "/" : publicBase;
const site = process.env.ASTRO_SITE || publicSite;
const base = process.env.ASTRO_BASE === undefined ? defaultBase : process.env.ASTRO_BASE || "/";

function isPrivateGitHubRepositoryBuild() {
  if (process.env.GITHUB_ACTIONS !== "true") {
    return false;
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) {
    return false;
  }

  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const repository = event.repository;

  return repository?.private === true || repository?.visibility === "private" || repository?.visibility === "internal";
}

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
