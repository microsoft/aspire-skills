import assert from "node:assert/strict";
import { lstat, readFile, readlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createCanvasTestDom } from "../fixtures/canvas-test-dom.mjs";

test("proposal view markup preserves tree semantics, help associations and panel nesting", async () => {
    const html = await readFile(new URL("../../extensions/aspireify/ui/index.html", import.meta.url), "utf8");
    const { document } = createCanvasTestDom(html);
    const node = (id) => document.getElementById(id);
    assert.equal(node("connections-tree").getAttribute("role"), "tree");
    assert.equal(node("connections-tree").getAttribute("aria-describedby"), "connection-legend connections-tree-help");
    assert.equal(node("connection-legend").parentElement, node("resource-plan-panel"));
    assert.equal(node("relationship-guide"), null);
    assert.equal(node("relationship-list-disclosure"), null);
    assert.equal(node("connections-unplaced").hidden, true);
    assert.equal(node("connections-unplaced-list").getAttribute("aria-labelledby"), "connections-unplaced-summary");
    assert.equal(node("connections-tree-help").parentElement, node("connections-tree-panel"));
    assert.equal(node("connections-tree").parentElement, node("connections-tree-panel"));
    assert.equal(node("connections-tree-panel").parentElement, node("resource-plan-panel"));
    assert.equal(node("resource-details-view").parentElement, node("resource-plan-panel"));
    for (const id of ["compact-resources", "relationship-workspace"]) {
        assert.equal(node(id).parentElement, node("resource-details-view"));
    }
    assert.equal(node("resources-view").getAttribute("aria-controls"), "resource-details-view");
    assert.equal(node("connections-tree-view").getAttribute("aria-controls"), "connections-tree-panel");
    assert.equal(node("resources-view").parentElement.getAttribute("role"), "group");
    assert.equal(node("resources-view").getAttribute("aria-pressed"), "true");
    assert.equal(node("connections-tree-view").getAttribute("aria-pressed"), "false");
    assert.equal(node("connections-tree-panel").hidden, true);
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
