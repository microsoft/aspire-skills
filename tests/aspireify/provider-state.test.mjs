import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    appHostIdentity,
    assignNonConflictingGeneratedEdgeIds,
    confirmedSnapshotForReadback,
    DurableSnapshotStore,
    persistSnapshotBeforeCommit,
    resolveAppHostIdentity,
    scanTimeoutDelay,
} from "../../extensions/aspireify/provider-state.mjs";

test("equivalent Windows AppHost paths use one domain", () => {
    const options = { platform: "win32", cwd: "C:\\work\\repo" };
    const first = appHostIdentity(".\\src\\AppHost\\", options);
    const second = appHostIdentity("c:/WORK/repo/src/AppHost", options);

    assert.equal(first.domainId, second.domainId);
    assert.equal(first.domainId, "c:\\work\\repo\\src\\apphost");
});

test("Windows UNC and device prefixes survive canonicalization", () => {
    const options = { platform: "win32", cwd: "C:\\work" };

    assert.deepEqual(
        appHostIdentity("\\\\server\\share\\repo\\AppHost.cs", options),
        {
            appHostPath: "\\\\server\\share\\repo\\AppHost.cs",
            domainId: "\\\\server\\share\\repo\\apphost.cs",
        },
    );
    assert.deepEqual(
        appHostIdentity("\\\\?\\C:\\repo\\AppHost.cs", options),
        {
            appHostPath: "\\\\?\\C:\\repo\\AppHost.cs",
            domainId: "\\\\?\\c:\\repo\\apphost.cs",
        },
    );
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
