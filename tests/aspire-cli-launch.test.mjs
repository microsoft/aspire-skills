import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("AppHosts and Doctor executable-selection boundaries", { timeout: 30_000 }, () => {
    const fixture = fileURLToPath(new URL("./fixtures/aspire-cli-launch-boundary.mjs", import.meta.url));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--experimental-vm-modules", "--test", fixture], {
        env,
        encoding: "utf8",
        timeout: 25_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
