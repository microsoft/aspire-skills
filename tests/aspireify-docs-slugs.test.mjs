import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const wiringPath = new URL("../skills/aspireify/references/apphost-wiring.md", import.meta.url);

// Slugs that `aspire docs get` reports as "Documentation page ... not found" on Aspire 13.6.4.
const retiredSlugs = ["postgresql-hosting-integration", "sql-server-integration"];

test("Aspireify wiring guidance does not use retired aspire docs slugs", async () => {
    const markdown = await readFile(wiringPath, "utf8");
    for (const slug of retiredSlugs) {
        assert.ok(
            !markdown.includes(`aspire docs get "${slug}"`),
            `apphost-wiring.md still runs aspire docs get "${slug}", which no longer exists`,
        );
    }
});

test("Aspireify auto-managed value checks point at the Connection properties pages", async () => {
    const markdown = await readFile(wiringPath, "utf8");
    assert.match(markdown, /aspire docs get "connect-to-postgresql" --section "Connection properties"/);
    assert.match(markdown, /aspire docs get "connect-to-sql-server" --section "Connection properties"/);
});
