import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the provider serves every local module imported by the canvas entry point", async () => {
    const [appSource, extensionSource] = await Promise.all([
        readFile(new URL("../../extensions/aspireify/ui/app.js", import.meta.url), "utf8"),
        readFile(new URL("../../extensions/aspireify/extension.mjs", import.meta.url), "utf8"),
    ]);
    const importedAssets = [...appSource.matchAll(/from\s+["']\.\/([^"']+)["']/g)].map(
        (match) => match[1],
    );

    assert.ok(importedAssets.length > 0);
    for (const asset of importedAssets) {
        assert.match(
            extensionSource,
            new RegExp(`["']/${escapeRegExp(asset)}["']`),
            `${asset} must be present in the provider's static asset allowlist`,
        );
    }
});

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
