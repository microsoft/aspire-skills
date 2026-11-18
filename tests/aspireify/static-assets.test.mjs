import assert from "node:assert/strict";
import { lstat, readFile, readlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("the provider serves and publishes every local module imported by the canvas entry point", async () => {
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
        const publishedPath = fileURLToPath(new URL(
            `../../.github/plugins/aspire-skills/extensions/aspireify/ui/${asset}`,
            import.meta.url,
        ));
        const target = (await lstat(publishedPath)).isSymbolicLink()
            ? await readlink(publishedPath)
            : await readFile(publishedPath, "utf8");
        assert.equal(
            resolve(dirname(publishedPath), target),
            fileURLToPath(new URL(`../../extensions/aspireify/ui/${asset}`, import.meta.url)),
            `${asset} must be published as a mirror of the source module`,
        );
    }
});

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
