import assert from "node:assert/strict";
import { lstat, readFile, readlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createCanvasTestDom } from "../fixtures/canvas-test-dom.mjs";

test("topology markup keeps the map and inspector together with accessible descriptions", async () => {
    const html = await readFile(new URL("../../extensions/aspireify/ui/index.html", import.meta.url), "utf8");
    const { document } = createCanvasTestDom(html);
    const node = (id) => document.getElementById(id);
    assert.equal(node("topology-nodes").tagName, "ul");
    assert.equal(node("topology-nodes").getAttribute("aria-describedby"), "connection-legend topology-help");
    assert.equal(node("topology-lines").getAttribute("aria-hidden"), "true");
    assert.equal(node("topology-lines").getAttribute("focusable"), "false");
    assert.equal(node("connection-legend").parentElement, node("resource-plan-panel"));
    assert.equal(node("relationship-guide"), null);
    assert.equal(node("relationship-list-disclosure"), null);
    assert.equal(node("connections-tree-panel"), null);
    assert.equal(node("resources-view"), null);
    assert.equal(node("connections-unplaced").hidden, true);
    assert.equal(node("connections-unplaced-list").getAttribute("aria-labelledby"), "connections-unplaced-summary");
    assert.equal(node("topology-help").parentElement, node("plan-overview"));
    assert.equal(node("topology-nodes").parentElement, node("topology-surface"));
    assert.equal(node("topology-lines").parentElement, node("topology-surface"));
    assert.equal(node("plan-overview").parentElement, node("relationship-workspace"));
    assert.equal(node("plan-inspector").parentElement, node("relationship-workspace"));
    assert.equal(node("relationship-workspace").parentElement, node("resource-plan-panel"));
});

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
