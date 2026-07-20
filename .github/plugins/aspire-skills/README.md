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
├── skills/                  → ../../skills/
├── extensions/              → ../../extensions/
└── README.md                (this file)
```

Runtime skill and reference entries under `skills/` are symlinked to the root skill
content. Runtime canvas extension entries under `extensions/` are symlinked to the
root extension content.

See the [root README](../../../README.md) for installation and usage.
