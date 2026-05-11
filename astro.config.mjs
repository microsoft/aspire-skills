import { defineConfig } from "astro/config";
import expressiveCode from "astro-expressive-code";
import icon from "astro-icon";

export default defineConfig({
  site: "https://microsoft.github.io",
  base: "/aspire-skills",
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
