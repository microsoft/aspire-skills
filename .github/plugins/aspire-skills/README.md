# Published Plugin Mirror

This directory mirrors the root plugin structure for marketplace publishing.
All files are **symlinks** to the root — single source of truth.

## Structure

```
aspire-skills/
├── .plugin/plugin.json      → ../../.plugin/plugin.json
├── .claude-plugin/          → ../../.claude-plugin/
├── .cursor-plugin/          → ../../.cursor-plugin/
├── .mcp.json                → ../../.mcp.json
├── gemini-extension.json    → ../../gemini-extension.json
├── copilot-hooks.json       → ../../copilot-hooks.json
├── hooks/                   → ../../hooks/
├── skills/                  → ../../skills/ runtime skill/reference symlinks
└── README.md                (this file)
```

See the [root README](../../../README.md) for installation and usage.
