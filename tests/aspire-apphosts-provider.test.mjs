import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
    CommandInputMetadataStore,
    appHostIdentityHint,
    buildAppHostTreeNode,
    createStoppedAppHost,
    publicAppHost,
    runProcess,
    sanitizeCommandArgumentInputs,
    validateCommandArguments,
} from "../extensions/aspire-apphosts/lib/app-model.mjs";

const baseInputs = sanitizeCommandArgumentInputs([
    { name: "environment", inputType: "Choice", options: ["prod", "dev"], required: true },
    { name: "key", inputType: "SecretText", dynamicLoading: { dependsOnInputs: ["environment"] } },
]);
const identity = { appHostId: "one", resourceName: "api", commandName: "deploy", baseInputs };

test("AppHost identity hints are recognizable, bounded, sanitized, and stable across root/public projections", () => {
    const one = createStoppedAppHost(resolve("tests", "fixtures", "checkout-one", "Demo.AppHost", "Demo.AppHost.csproj"));
    const two = createStoppedAppHost(resolve("tests", "fixtures", "checkout-two", "Demo.AppHost", "Demo.AppHost.csproj"));
    assert.match(appHostIdentityHint(one), /checkout-one/);
    assert.match(appHostIdentityHint(two), /checkout-two/);
    assert.notEqual(appHostIdentityHint(one), appHostIdentityHint(two));
    assert.equal(buildAppHostTreeNode(one).identityHint, publicAppHost(one).identityHint);
    const sameBasename = createStoppedAppHost(resolve("tests", "fixtures", "another", "checkout-one", "Demo.AppHost", "Demo.AppHost.csproj"));
    assert.notEqual(appHostIdentityHint(one), appHostIdentityHint(sameBasename), "stable IDs distinguish identical directory hints");
    const unsafe = createStoppedAppHost(resolve("tests", "fixtures", `token=dummy\u0001-private-${"x".repeat(200)}`, "Demo.AppHost", "Demo.AppHost.csproj"));
    const hint = appHostIdentityHint(unsafe);
    assert.ok(hint.length <= 100);
    assert.doesNotMatch(hint, /dummy|private|[\u0000-\u001f\\\/]/);
});

test("metadata authority is bound to dependencies, successful loads, and the current schema", () => {
    const store = new CommandInputMetadataStore();
    const prod = { environment: "prod" };
    const dev = { environment: "dev" };
    const required = baseInputs.map((input) => input.name === "key" ? { ...input, required: true } : input);
    const disabled = baseInputs.map((input) => input.name === "key" ? { ...input, disabled: true } : input);
    assert.equal(store.executionInputsFor(identity, prod), undefined);
    store.set({ ...identity, inputs: required, values: prod });
    assert.equal(validateCommandArguments({ argumentInputs: store.executionInputsFor(identity, prod) }, prod).ok, false);
    assert.equal(store.executionInputsFor(identity, dev), undefined);
    store.set({ ...identity, inputs: disabled, values: dev });
    assert.equal(store.executionInputsFor(identity, prod), undefined);
    const failed = store.beginLoad(identity);
    assert.equal(store.executionInputsFor(identity, dev), undefined);
    store.failLoad(identity, failed);
    assert.equal(store.executionInputsFor(identity, dev), undefined);
    assert.equal(store.inputsFor(identity), disabled, "display retains metadata without granting execution authority");
    store.set({ ...identity, inputs: required, values: prod });
    assert.equal(store.executionInputsFor({ ...identity, baseInputs: [...baseInputs, { name: "extra" }] }, prod), undefined);
});

test("newer loads supersede queued/in-flight loads without losing the latest schema", () => {
    const store = new CommandInputMetadataStore();
    const older = store.beginLoad(identity);
    const newerIdentity = { ...identity, baseInputs: [...baseInputs, { name: "new", inputType: "Text" }] };
    const newer = store.beginLoad(newerIdentity);
    assert.equal(store.isCurrentLoad(identity, older), false);
    store.failLoad(identity, older);
    assert.equal(store.isCurrentLoad(newerIdentity, newer), true);
    assert.equal(store.set({ ...identity, ticket: older, inputs: [], values: {} }), false);
    assert.equal(store.set({ ...newerIdentity, ticket: newer, inputs: baseInputs, values: { environment: "prod" } }), true);
    store.failLoad(newerIdentity, newer);
    assert.equal(store.executionInputsFor(newerIdentity, { environment: "prod" }), baseInputs);
});

test("loaded dependency graphs and secret dependencies participate in metadata authority", () => {
    const store = new CommandInputMetadataStore();
    const inputs = sanitizeCommandArgumentInputs([
        ...baseInputs,
        { name: "region", inputType: "Text", dynamicLoading: { dependsOnInputs: ["key"] } },
    ]);
    const values = { environment: "prod", key: "dummy-private-key", region: "east" };
    store.set({ ...identity, inputs, values });
    assert.equal(store.executionInputsFor(identity, values), inputs);
    assert.equal(store.executionInputsFor(identity, { ...values, key: "another-key" }), undefined);
    assert.equal(store.executionInputsFor(identity, { ...values, region: "west" }), inputs, "non-dependencies do not invalidate authority");
    assert.doesNotMatch(JSON.stringify(store), /dummy-private-key/);
});

test("native executable invocation preserves JSON, quotes, empty tokens, and shell metacharacters", async () => {
    const args = ['--json={"message":"say \\"hello\\""}', '--label=he said "hello"', "", ";&$()'%!"];
    const result = await runProcess(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...args], {
        timeoutMs: 10_000,
    });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(JSON.parse(result.stdout), args);
});

test("process stdout preserves machine JSON while redacting only submitted secret values", async () => {
    const secret = "dummy-\"quoted\"\n😀-secret";
    const result = await runProcess(process.execPath, [
        "-e", "process.stdout.write(JSON.stringify({url:'https://localhost/login?t=private-runtime-token',value:process.argv[1]}));",
        secret,
    ], { sensitiveValues: [secret] });
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(result.stdout), {
        url: "https://localhost/login?t=private-runtime-token", value: "[redacted]",
    }, "provider-side discovery URLs must remain valid JSON and preserve their private authentication");
});

for (const size of [32, 9_000]) {
    test(`process errors redact ${size}-character submitted secrets before truncation`, async () => {
        const secret = `DUMMY-${"abcdef0123456789".repeat(size)}`.slice(0, size);
        const result = await runProcess(process.execPath, [
            "-e", "process.stderr.write('Useful failure: '+process.argv[1]+'\\n'+'detail '.repeat(2000));process.exitCode=1;",
            secret,
        ], { sensitiveValues: [secret], timeoutMs: 10_000 });
        assert.equal(result.ok, false);
        assert.match(result.error, /Useful failure: \[redacted\]/);
        assert.doesNotMatch(JSON.stringify(result), new RegExp(secret.slice(0, 24)));
        assert.match(result.error, /\[output truncated\]/);
    });
}

test("output limits and timeouts redact partial secret streams as well as complete values", async () => {
    const secret = `DUMMY-${"abcdef0123456789".repeat(600)}`;
    const result = await runProcess(process.execPath, [
        "-e", "process.stdout.write('before '+process.argv[1].slice(0,200));setTimeout(()=>process.stdout.write(process.argv[1].slice(200)),80);",
        secret,
    ], { sensitiveValues: [secret], maxOutputBytes: 512, timeoutMs: 10_000 });
    assert.equal(result.ok, false);
    assert.match(result.error, /output exceeded/);
    assert.match(result.stdout, /before \[redacted\]/);
    assert.doesNotMatch(result.stdout, /DUMMY-/);

    const timeout = await runProcess(process.execPath, [
        "-e", "process.stderr.write('before '+process.argv[1].slice(0,200));setTimeout(()=>{},10000);", secret,
    ], { sensitiveValues: [secret], timeoutMs: 1_500 });
    assert.equal(timeout.ok, false);
    assert.match(timeout.error, /timed out/);
    assert.match(timeout.stderr, /before \[redacted\]/);
    assert.doesNotMatch(timeout.stderr, /DUMMY-/);
});

test("interrupted output redacts a complete self-overlapping secret before considering partial tails", async () => {
    const secret = "DUMMY-abcDUMMY-abc";
    const result = await runProcess(process.execPath, [
        "-e", "process.stdout.write('before '+process.argv[1]);setTimeout(()=>{},10000);", secret,
    ], { sensitiveValues: [secret], timeoutMs: 1_500 });
    assert.equal(result.ok, false);
    assert.equal(result.stdout, "before [redacted]");
});

test("launch failures redact submitted values without hiding useful diagnostics", async () => {
    const result = await runProcess("missing-DUMMY-PRIVATE-executable", [], { sensitiveValues: ["DUMMY-PRIVATE"] });
    assert.equal(result.ok, false);
    assert.match(result.error, /Failed to run Aspire CLI/);
    assert.doesNotMatch(result.error, /DUMMY-PRIVATE/);
});

test("provider HTTP, SDK callbacks, and platform boundaries", { timeout: 60_000 }, () => {
    const fixture = fileURLToPath(new URL("./fixtures/aspire-apphosts-provider-boundary.mjs", import.meta.url));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--experimental-vm-modules", "--test", "--test-reporter=tap", fixture], {
        env,
        encoding: "utf8",
        timeout: 50_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /# fail 0/);
});
