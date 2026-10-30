import assert from "node:assert/strict";
import test from "node:test";
import { resourceNameFrom } from "../../extensions/aspireify/proposal-model.mjs";

const VALID_RESOURCE_NAME = /^[a-z](?:[a-z0-9]|-(?!-))*(?<!-)$/;

test("services without ASCII letters or digits get distinct valid default resource names", () => {
    const names = ["注文サービス", "在庫サービス", "🚀", "___"].map(resourceNameFrom);

    assert.deepEqual(names, ["service-1", "service-2", "service-3", "service-4"]);
    for (const name of names) {
        assert.match(name, VALID_RESOURCE_NAME);
    }
});

test("ASCII service names keep their existing default resource names", () => {
    assert.equal(resourceNameFrom("OrderApi", 0), "order-api");
    assert.equal(resourceNameFrom("Contoso.Web", 1), "contoso-web");
    assert.equal(resourceNameFrom("123", 2), "service-123");
    assert.equal(resourceNameFrom("Café", 3), "caf");
    assert.equal(resourceNameFrom(`a${"-b".repeat(40)}`, 4).length <= 64, true);
    assert.match(resourceNameFrom(`a${"-b".repeat(40)}`, 4), VALID_RESOURCE_NAME);
});
