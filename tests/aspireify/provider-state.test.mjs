import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    appHostIdentity,
    assertLocalAppHostPath,
    assignNonConflictingGeneratedEdgeIds,
    confirmedSnapshotForReadback,
    DurableSnapshotStore,
    persistSnapshotBeforeCommit,
    resolveAppHostIdentity,
    scanTimeoutDelay,
} from "../../extensions/aspireify/provider-state.mjs";
import { assertLocalAppHostPath as assertAppHostsPath } from "../../extensions/aspire-apphosts/lib/app-model.mjs";

const networkPaths = [
    "\\\\server\\share\\AppHost.cs",
    "//server/share/AppHost.cs",
    "\\\\\\server\\\\share\\AppHost.cs",
    "\\\\?\\UNC\\server\\share\\AppHost.cs",
    "//?/uNc/server/share/AppHost.cs",
    "\\\\.\\UNC\\server\\share\\AppHost.cs",
    "\\??\\UNC\\server\\share\\AppHost.cs",
    "\\\\?\\GLOBALROOT\\Device\\Mup\\server\\share\\AppHost.cs",
    "\\Device\\LanmanRedirector\\server\\share\\AppHost.cs",
    "\\\\?\\GLOBALROOT\\Device\\WebDavRedirector\\server\\share\\AppHost.cs",
    "\\\\?\\GLOBALROOT\\GLOBAL??\\UNC\\server\\share\\AppHost.cs",
    "\\\\?\\GLOBALROOT\\??\\UNC\\server\\share\\AppHost.cs",
    "\\GLOBAL??\\UNC\\server\\share\\AppHost.cs",
    "\\DosDevices\\UNC\\server\\share\\AppHost.cs",
    "smb://server/share/AppHost.cs",
    "cifs://server/share/AppHost.cs",
    "nfs://server/share/AppHost.cs",
    "file://server/share/AppHost.cs",
];

test("standalone canvas providers reject the same explicit network path forms", () => {
    for (const guard of [assertLocalAppHostPath, assertAppHostsPath]) {
        for (const path of networkPaths) {
            assert.throws(() => guard(path), { code: "network_apphost_target" }, path);
        }
        for (const path of [
            "C:\\repo\\AppHost.cs",
            "\\\\?\\C:\\repo\\AppHost.cs",
            "\\\\?\\Volume{local-volume}\\repo\\AppHost.cs",
            "/repo/team\\tools/AppHost.cs",
            "/outside-workspace/AppHost.cs",
            "../another-repo/AppHost.cs",
        ]) {
            assert.doesNotThrow(() => guard(path), path);
        }
    }
});

test("network target rejection precedes realpath, including a network working directory", async () => {
    let filesystemCalls = 0;
    const options = {
        platform: "win32",
        cwd: "C:\\repo",
        realpathImpl: async (path) => { filesystemCalls += 1; return path; },
    };
    for (const path of networkPaths) {
        await assert.rejects(resolveAppHostIdentity(path, options), { code: "network_apphost_target" });
    }
    await assert.rejects(
        resolveAppHostIdentity("AppHost.cs", { ...options, cwd: "\\\\server\\share" }),
        { code: "network_apphost_target" },
    );
    assert.equal(filesystemCalls, 0);
});

test("resolved network identities are rejected without treating local aliases as a sandbox", async () => {
    let filesystemCalls = 0;
    await assert.rejects(
        resolveAppHostIdentity("C:\\repo\\AppHost.cs", {
            platform: "win32",
            cwd: "C:\\repo",
            realpathImpl: async () => {
                filesystemCalls += 1;
                return "\\\\server\\share\\AppHost.cs";
            },
        }),
        { code: "network_apphost_target" },
    );
    assert.equal(filesystemCalls, 1, "local alias resolution is outside the pre-access syntax guarantee");
});

test("equivalent Windows AppHost paths use one domain", () => {
    const options = { platform: "win32", cwd: "C:\\work\\repo" };
    const first = appHostIdentity(".\\src\\AppHost\\", options);
    const second = appHostIdentity("c:/WORK/repo/src/AppHost", options);

    assert.equal(first.domainId, second.domainId);
    assert.equal(first.domainId, "c:\\work\\repo\\src\\apphost");
});

test("Windows local device paths retain their canonical identity", () => {
    const options = { platform: "win32", cwd: "C:\\work" };

    assert.deepEqual(
        appHostIdentity("\\\\?\\C:\\repo\\AppHost.cs", options),
        {
            appHostPath: "\\\\?\\C:\\repo\\AppHost.cs",
            domainId: "\\\\?\\c:\\repo\\apphost.cs",
        },
    );
});

test("POSIX AppHost identities preserve literal backslashes", () => {
    const options = { platform: "linux", cwd: "/repo" };
    const literal = appHostIdentity("team\\tools/AppHost.cs", options);
    const nested = appHostIdentity("team/tools/AppHost.cs", options);

    assert.equal(literal.appHostPath, "/repo/team\\tools/AppHost.cs");
    assert.equal(literal.domainId, literal.appHostPath);
    assert.notEqual(literal.domainId, nested.domainId);
    assert.deepEqual(appHostIdentity("./team//tools/../tools/AppHost.cs", options), nested);
});

test("distinct POSIX AppHosts keep separate durable snapshots when a directory contains a backslash", {
    skip: process.platform === "win32",
}, async (context) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "aspireify-path-state-")));
    context.after(() => rm(root, { recursive: true, force: true }));
    const literalPath = join(root, "team\\tools", "AppHost.cs");
    const nestedPath = join(root, "team", "tools", "AppHost.cs");
    await mkdir(join(root, "team\\tools"));
    await mkdir(join(root, "team", "tools"), { recursive: true });
    await writeFile(literalPath, "// Literal backslash directory");
    await writeFile(nestedPath, "// Nested directories");

    const literal = await resolveAppHostIdentity(literalPath);
    const nested = await resolveAppHostIdentity(nestedPath);
    const workspace = join(root, "session");
    const store = new DurableSnapshotStore(workspace);
    const literalSnapshot = { appHostPath: literalPath, proposal: { resources: [{ id: "literal" }] } };
    const nestedSnapshot = { appHostPath: nestedPath, proposal: { resources: [{ id: "nested" }] } };
    await store.save(literal.domainId, literalSnapshot);
    await store.save(nested.domainId, nestedSnapshot);

    const reloaded = new DurableSnapshotStore(workspace);
    assert.deepEqual(await reloaded.load(literal.domainId), literalSnapshot);
    assert.deepEqual(await reloaded.load(nested.domainId), nestedSnapshot);
    assert.equal(literal.appHostPath, literalPath);
    assert.equal(nested.appHostPath, nestedPath);
});

test("real paths collapse symlink aliases before selecting a domain", async () => {
    const identity = await resolveAppHostIdentity("/repo/link/AppHost.cs", {
        platform: "linux",
        cwd: "/repo",
        realpathImpl: async () => "/repo/src/AppHost.cs",
    });

    assert.deepEqual(identity, {
        appHostPath: "/repo/src/AppHost.cs",
        domainId: "/repo/src/AppHost.cs",
    });
});

test("generated edge IDs never displace preserved user edges", () => {
    const generated = [
        { id: "edge-api-cache", from: "api", to: "cache" },
        { id: "edge-worker-cache", from: "worker", to: "cache" },
    ];
    const preserved = [{ id: "edge-api-cache", userAdded: true, from: "web", to: "api" }];

    const result = assignNonConflictingGeneratedEdgeIds(generated, preserved);

    assert.equal(result[0].id, "edge-api-cache-generated");
    assert.equal(result[1].id, "edge-worker-cache");
    assert.equal(preserved[0].id, "edge-api-cache");
});

test("confirmed snapshots survive a new store instance", async (context) => {
    const workspace = await mkdtemp(join(tmpdir(), "aspireify-state-"));
    context.after(() => rm(workspace, { recursive: true, force: true }));
    const domainId = "c:\\repo\\apphost.cs";
    const snapshot = {
        appHostPath: "C:\\repo\\AppHost.cs",
        confirmed: true,
        confirmation: {
            confirmed: true,
            proposalHash: "abc123",
            proposal: { resources: [{ id: "api" }], edges: [] },
        },
        services: [],
        proposal: { resources: [], edges: [], generatedAt: "" },
    };

    const writer = new DurableSnapshotStore(workspace);
    await writer.save(domainId, snapshot);
    const reader = new DurableSnapshotStore(workspace);

    assert.deepEqual(await reader.load(domainId), snapshot);
});

test("queued snapshot writes preserve the latest state", async (context) => {
    const workspace = await mkdtemp(join(tmpdir(), "aspireify-state-"));
    context.after(() => rm(workspace, { recursive: true, force: true }));
    const store = new DurableSnapshotStore(workspace);
    const domainId = "/repo/AppHost.cs";

    const firstWrite = store.save(domainId, { revision: 1 });
    const secondWrite = store.save(domainId, { revision: 2 });
    await Promise.all([firstWrite, secondWrite]);

    assert.deepEqual(await store.load(domainId), { revision: 2 });
});

test("readback withholds unconfirmed plans and clones confirmed snapshots", () => {
    const proposal = { resources: [{ id: "api" }], edges: [] };
    assert.equal(confirmedSnapshotForReadback({ proposal, confirmation: null }), null);

    const snapshot = { confirmation: { confirmed: true, proposal } };
    const result = confirmedSnapshotForReadback(snapshot);
    result.proposal.resources[0].id = "changed";

    assert.equal(snapshot.confirmation.proposal.resources[0].id, "api");
});

test("rehydrated scans resume their remaining timeout", () => {
    assert.equal(
        scanTimeoutDelay(
            { scanStatus: "scanning", updatedAt: 1_000 },
            120_000,
            31_000,
        ),
        90_000,
    );
    assert.equal(
        scanTimeoutDelay(
            { scanStatus: "complete", updatedAt: 1_000 },
            120_000,
            31_000,
        ),
        null,
    );
});

test("failed durable writes never publish snapshot changes in memory", async () => {
    let committed = false;
    const store = {
        available: true,
        save: async () => {
            throw new Error("disk full");
        },
    };

    await assert.rejects(
        persistSnapshotBeforeCommit(store, "apphost", { confirmed: true }, () => {
            committed = true;
        }),
        /disk full/,
    );
    assert.equal(committed, false);
});
