import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stableProposalHash } from "../../extensions/aspireify/proposal-model.mjs";
import { appHostIdentity, DurableSnapshotStore } from "../../extensions/aspireify/provider-state.mjs";

const stubUrl = new URL("../fixtures/aspireify-sdk-stub.mjs", import.meta.url).href;
registerHooks({
    resolve(specifier, context, next) {
        return specifier === "@github/copilot-sdk/extension"
            ? { url: stubUrl, shortCircuit: true }
            : next(specifier, context);
    },
});

let providerSequence = 0;
const externalDependencies = [
    {
        id: "billing",
        name: "Billing API",
        type: "HTTPS API",
        purpose: "Read invoices.",
        configurationKeys: ["BILLING_ENDPOINT"],
        source: "src/api/billing.ts",
        lifecycleOwner: "Provider-hosted; the application owns authentication.",
        endpointSelection: "Explicit configuration",
    },
    {
        id: "identity",
        name: "Identity SDK",
        type: "SDK-selected endpoint",
        configurationKeys: ["IDENTITY_REGION"],
        endpointSelection: "SDK-selected at runtime",
    },
    { id: "events", name: "Event stream", type: "WebSocket" },
    { id: "catalog", name: "Catalog API", type: "HTTPS API" },
];
const externalDependencyTreatments = [
    {
        externalDependencyId: "identity",
        treatment: "not-modeled",
        reason: "Retain the SDK's endpoint discovery and authentication.",
    },
    {
        externalDependencyId: "events",
        treatment: "deferred",
        reason: "The stream's local-development scope is not agreed.",
        unresolved: "Confirm the supported test stream with the service owner.",
    },
];
const api = { id: "api", name: "api", type: "Node.js", serviceId: "api" };
const billing = {
    id: "billing-resource",
    name: "billing",
    type: "External service",
    externalDependencyId: "billing",
};
const services = [
    {
        id: "api",
        name: "API",
        type: "Node.js",
        framework: "Express",
        exposesHttp: true,
        path: "src/api",
    },
];

async function provider(t, existingWorkspace) {
    const workspacePath = existingWorkspace ?? await mkdtemp(join(tmpdir(), "aspireify-external-"));
    const session = (globalThis.__aspireifyTestSession = { workspacePath, messages: [] });
    await import(`../../extensions/aspireify/extension.mjs?external=${++providerSequence}`);
    const canvas = session.canvas;
    const appHostPath = join(workspacePath, "repo", "apphost.mts");
    const instances = new Set();
    t.after(async () => {
        for (const instanceId of instances) {
            await canvas.onClose({ instanceId });
        }
        if (!existingWorkspace) {
            await rm(workspacePath, { recursive: true, force: true });
        }
    });
    const action = (name, input = {}, instanceId = "review") =>
        canvas.actions.find((candidate) => candidate.name === name).handler({
            instanceId,
            input: { appHostPath, ...input },
        });
    const load = (input = {}) => action("load_discovery", {
        apphostStyle: "typescript",
        services,
        externalDependencies,
        ...input,
    });
    const propose = (generation, input = {}) => action("set_proposal", {
        proposalGeneration: generation,
        resources: [api, billing],
        edges: [{ from: "api", to: "billing-resource", kind: "reference" }],
        externalDependencyTreatments,
        ...input,
    });
    const open = async (instanceId = "review") => {
        const opened = await canvas.open({ instanceId, input: { appHostPath } });
        instances.add(instanceId);
        const url = new URL(opened.url);
        const headers = {
            "content-type": "application/json",
            "x-aspireify-token": url.searchParams.get("token"),
        };
        const snapshot = async () => (await fetch(new URL("/api/snapshot", url), { headers })).json();
        const post = async (path, body = {}, review) => {
            const current = review ?? await snapshot();
            return fetch(new URL(path, url), {
                method: "POST",
                headers,
                body: JSON.stringify({
                    expectedAppHostPath: current.appHostPath,
                    expectedRevision: current.revision,
                    expectedProposalGeneration: current.proposalGeneration,
                    expectedProposalHash: current.proposalHash,
                    ...body,
                }),
            });
        };
        return { url, headers, snapshot, post };
    };
    return { canvas, session, workspacePath, appHostPath, action, load, propose, open };
}

function expectedAccounting() {
    return externalDependencies.map((dependency, index) => ({
        ...dependency,
        resourceMappings: index === 0
            ? [{ id: billing.id, name: billing.name, type: billing.type, include: true }]
            : [],
        ...(index === 0
            ? { treatment: "mapped" }
            : index < 3
              ? Object.fromEntries(Object.entries(externalDependencyTreatments[index - 1])
                    .filter(([key]) => key !== "externalDependencyId"))
              : { treatment: "not-assessed" }),
    }));
}

test("external discovery reaches review, immutable confirmation, and chat without fake services", async (t) => {
    const p = await provider(t);
    const discovery = await p.load();
    assert.equal(discovery.externalDependencyCount, 4);
    await p.propose(discovery.proposalGeneration);
    const view = await p.open();
    const review = await view.snapshot();
    const expected = expectedAccounting();
    assert.deepEqual(review.externalDependencies, expected);
    assert.deepEqual(review.services.map(({ id }) => id), ["api"]);
    assert.deepEqual(review.notProposed, []);
    assert.equal(review.proposal.resources[1].externalDependencyId, "billing");
    await assert.rejects(p.action("get_confirmation"), /not confirmed/);

    assert.equal((await view.post("/api/confirm")).status, 200);
    const confirmation = await p.action("get_confirmation");
    assert.deepEqual(confirmation.externalDependencies, expected);
    assert.equal(confirmation.proposalHash, review.proposalHash);
    assert.equal(confirmation.proposal.resources[1].externalDependencyId, "billing");
    const handoff = p.session.messages.find((message) => message.includes("findings confirmed"));
    assert.deepEqual(JSON.parse(handoff.split("\n")[3]).externalDependencies, expected);

    const serialized = JSON.stringify(confirmation);
    confirmation.externalDependencies[0].purpose = "Changed by a reader";
    assert.equal((await view.post("/api/proposal/resource", { id: billing.id, name: "other" })).status, 409);
    await assert.rejects(p.propose(discovery.proposalGeneration), /read-only/);
    await assert.rejects(p.load(), /read-only/);
    assert.equal((await view.post("/api/confirm")).status, 200);
    assert.equal(JSON.stringify(await p.action("get_confirmation")), serialized);
});

test("external inventory rejects missing, duplicate, malformed and runnable-only facts atomically", async (t) => {
    const p = await provider(t);
    const discovery = await p.load();
    await p.propose(discovery.proposalGeneration);
    const view = await p.open();
    const before = await view.snapshot();
    const invalid = [
        null,
        {},
        [{ name: "Missing ID", type: "HTTPS API" }],
        [{ id: "x", name: " ", type: "HTTPS API" }],
        [{ id: "x", name: "API" }],
        [{ id: " x ", name: "API", type: "HTTPS API" }],
        [{ id: 1, name: "API", type: "HTTPS API" }],
        [externalDependencies[0], externalDependencies[0]],
        [{ ...externalDependencies[0], configurationKeys: "BILLING_ENDPOINT" }],
        [{ ...externalDependencies[0], configurationKeys: [" "] }],
        [{ ...externalDependencies[0], path: "fake-project", exposesHttp: true }],
    ];
    for (const inventory of invalid) {
        await assert.rejects(p.load({ externalDependencies: inventory }), /external|dependency|configurationKeys/i);
        assert.deepEqual(await view.snapshot(), before, "invalid discovery must not change any state");
    }
});

test("external mappings reject unknown IDs and mixed runnable identities; one dependency may map several resources", async (t) => {
    const p = await provider(t);
    const { proposalGeneration } = await p.load();
    for (const resource of [
        { ...billing, externalDependencyId: "unknown" },
        { ...billing, serviceId: "api" },
        { ...billing, externalDependencyId: " " },
    ]) {
        await assert.rejects(
            p.propose(proposalGeneration, { resources: [api, resource], edges: [] }),
            /external|mapping/i,
        );
    }
    await p.propose(proposalGeneration, {
        resources: [api, billing, {
            id: "billing-endpoint",
            name: "billing-endpoint",
            type: "Parameter",
            externalDependencyId: "billing",
        }],
    });
    const view = await p.open();
    assert.deepEqual((await view.snapshot()).externalDependencies[0].resourceMappings.map(({ id }) => id),
        ["billing-resource", "billing-endpoint"]);
});

test("external treatments reject unknown, repeated, mapped and incomplete decisions without losing the previous proposal", async (t) => {
    const p = await provider(t);
    const { proposalGeneration } = await p.load();
    await p.propose(proposalGeneration);
    const view = await p.open();
    const before = await view.snapshot();
    const decision = externalDependencyTreatments[0];
    for (const decisions of [
        {},
        [{ ...decision, externalDependencyId: "unknown" }],
        [decision, decision],
        [{ ...decision, externalDependencyId: "billing" }],
        [{ ...decision, treatment: "not-assessed" }],
        [{ ...decision, reason: " " }],
        [{ ...decision, treatment: "deferred" }],
    ]) {
        await assert.rejects(p.propose(proposalGeneration, { externalDependencyTreatments: decisions }),
            /externalDependencyTreatments/);
        assert.deepEqual(await view.snapshot(), before);
    }
});

test("omitted external inventory and decisions survive legacy refreshes; explicit empty arrays clear them", async (t) => {
    const p = await provider(t);
    let discovery = await p.load();
    await p.propose(discovery.proposalGeneration);
    discovery = await p.action("load_discovery", { apphostStyle: "typescript", services });
    await p.action("set_proposal", {
        proposalGeneration: discovery.proposalGeneration,
        resources: [api, billing],
        edges: [],
    });
    const view = await p.open();
    assert.deepEqual((await view.snapshot()).externalDependencies, expectedAccounting());
    await p.action("set_proposal", {
        proposalGeneration: discovery.proposalGeneration,
        externalDependencyTreatments: [],
    });
    assert.equal((await view.snapshot()).externalDependencies[1].treatment, "not-assessed");
    discovery = await p.load({ externalDependencies: [] });
    await assert.rejects(p.action("set_proposal", {
        proposalGeneration: discovery.proposalGeneration,
    }), /not a discovered external dependency/);
    await p.action("set_proposal", {
        proposalGeneration: discovery.proposalGeneration,
        resources: [api],
        edges: [],
    });
    assert.deepEqual((await view.snapshot()).externalDependencies, []);
    assert.equal((await view.post("/api/confirm")).status, 200);
    await p.action("load_discovery", { apphostStyle: "typescript", services, startNewRun: true });
    assert.deepEqual((await view.snapshot()).externalDependencies, []);
});

test("removing, excluding, undoing and regenerating mapped resources preserves external accounting", async (t) => {
    const p = await provider(t);
    const { proposalGeneration } = await p.load();
    await p.propose(proposalGeneration);
    const view = await p.open();
    const original = await view.snapshot();
    assert.equal((await view.post("/api/proposal/resource", { id: billing.id, include: false })).status, 200);
    const excluded = await view.snapshot();
    assert.equal(excluded.externalDependencies[0].resourceMappings[0].include, false);
    assert.notEqual(excluded.proposalHash, original.proposalHash);
    assert.equal((await view.post("/api/history/undo")).status, 200);
    assert.equal((await view.snapshot()).proposalHash, original.proposalHash);
    assert.equal((await view.post("/api/proposal/resource/delete", { id: billing.id })).status, 200);
    const removed = await view.snapshot();
    assert.deepEqual(removed.externalDependencies[0].resourceMappings, [{
        id: billing.id, name: billing.name, type: billing.type, include: false, removed: true,
    }]);
    assert.notEqual(removed.proposalHash, original.proposalHash);
    assert.equal((await view.post("/api/history/undo")).status, 200);
    assert.equal((await view.snapshot()).proposalHash, original.proposalHash);
    assert.equal((await view.post("/api/history/redo")).status, 200);
    await p.propose(proposalGeneration);
    assert.deepEqual((await view.snapshot()).externalDependencies[0], removed.externalDependencies[0]);
    assert.equal((await view.post("/api/confirm")).status, 200);
    assert.deepEqual((await p.action("get_confirmation")).externalDependencies[0], removed.externalDependencies[0]);
});

test("effective external decisions follow current mappings and return when a regenerated mapping disappears", async (t) => {
    const p = await provider(t);
    const { proposalGeneration } = await p.load();
    await p.propose(proposalGeneration);
    await p.action("set_proposal", {
        proposalGeneration,
        resources: [api, billing, {
            id: "identity-resource", name: "identity", type: "External service",
            externalDependencyId: "identity",
        }],
        edges: [],
    });
    const view = await p.open();
    assert.equal((await view.snapshot()).externalDependencies[1].treatment, "mapped");
    await p.action("set_proposal", {
        proposalGeneration,
        resources: [api, billing],
        edges: [],
    });
    assert.equal((await view.snapshot()).externalDependencies[1].reason, externalDependencyTreatments[0].reason);
});

test("external mappings follow preserved same-name resources and their removal instead of disappearing", async (t) => {
    const p = await provider(t);
    const { proposalGeneration } = await p.load();
    await p.propose(proposalGeneration, { resources: [api], edges: [] });
    const view = await p.open();
    assert.equal((await view.post("/api/proposal/resource/add", {
        name: "billing", type: "External service",
    })).status, 200);
    const added = (await view.snapshot()).proposal.resources.find(({ name }) => name === "billing");
    await p.propose(proposalGeneration);
    let review = await view.snapshot();
    assert.equal(review.externalDependencies[0].resourceMappings[0].id, added.id);
    assert.equal(review.proposal.resources.find(({ id }) => id === added.id).externalDependencyId, "billing");
    assert.equal((await view.post("/api/proposal/resource/delete", { id: added.id })).status, 200);
    review = await view.snapshot();
    assert.equal(review.externalDependencies[0].resourceMappings[0].removed, true);
    assert.equal(review.externalDependencies[0].resourceMappings[0].include, false);
});

test("conflicting preserved external mappings fail atomically rather than replacing another dependency", async (t) => {
    const p = await provider(t);
    const { proposalGeneration } = await p.load();
    await p.propose(proposalGeneration, { resources: [api], edges: [] });
    const view = await p.open();
    assert.equal((await view.post("/api/proposal/resource/add", {
        name: "billing", type: "External service",
    })).status, 200);
    await p.propose(proposalGeneration, {
        resources: [api, { ...billing, externalDependencyId: "identity" }],
        edges: [],
        externalDependencyTreatments: [],
    });
    const before = await view.snapshot();
    await assert.rejects(p.propose(proposalGeneration, {
        externalDependencyTreatments: [],
    }), /preserved resource already maps another discovered item/);
    assert.deepEqual(await view.snapshot(), before);
});

test("runnable services and external dependencies may share an ID without sharing mappings", async (t) => {
    const p = await provider(t);
    const { proposalGeneration } = await p.load({
        externalDependencies: [{ ...externalDependencies[0], id: "api" }],
    });
    await p.propose(proposalGeneration, {
        resources: [api, { ...billing, externalDependencyId: "api" }],
        externalDependencyTreatments: [],
    });
    const view = await p.open();
    const snapshot = await view.snapshot();
    assert.equal(snapshot.proposal.resources[0].serviceId, "api");
    assert.equal(snapshot.externalDependencies[0].resourceMappings[0].id, billing.id);
    assert.deepEqual(snapshot.notProposed, []);
});

test("every supplied external fact participates in the review hash", () => {
    const input = {
        proposalGeneration: 1,
        proposal: { resources: [api, billing], edges: [] },
        externalDependencies: expectedAccounting(),
    };
    const before = stableProposalHash(input);
    for (const [field, value] of [
        ["name", "Updated API"],
        ["type", "SDK-owned endpoint"],
        ["purpose", "Updated purpose"],
        ["configurationKeys", ["UPDATED_ENDPOINT"]],
        ["source", "src/api/updated.ts"],
        ["lifecycleOwner", "Updated lifecycle owner"],
        ["endpointSelection", "Updated selection"],
    ]) {
        const changed = structuredClone(input);
        changed.externalDependencies[0][field] = value;
        assert.notEqual(stableProposalHash(changed), before, `${field} must affect confirmation identity`);
    }
});

test("provider rehydration preserves external facts and the exact submitted result", async (t) => {
    const p = await provider(t);
    const { proposalGeneration } = await p.load();
    await p.propose(proposalGeneration);
    const first = await p.open();
    const before = await first.snapshot();
    const reloaded = await provider(t, p.workspacePath);
    const second = await reloaded.open("reloaded");
    assert.deepEqual((await second.snapshot()).externalDependencies, before.externalDependencies);
    assert.equal((await second.snapshot()).proposalHash, before.proposalHash);
    assert.equal((await second.post("/api/confirm")).status, 200);
    const serialized = JSON.stringify(await reloaded.action("get_confirmation", {}, "reloaded"));
    const finalProvider = await provider(t, p.workspacePath);
    const final = await finalProvider.open("final");
    assert.equal((await final.snapshot()).confirmed, true);
    assert.equal(JSON.stringify(await finalProvider.action("get_confirmation", {}, "final")), serialized);
});

test("legacy persisted snapshots and empty external inputs preserve existing proposal hashes", async (t) => {
    const p = await provider(t);
    const { proposalGeneration } = await p.load({ externalDependencies: [] });
    await p.propose(proposalGeneration, { resources: [api], edges: [], externalDependencyTreatments: [] });
    const store = new DurableSnapshotStore(p.workspacePath);
    const domainId = appHostIdentity(p.appHostPath).domainId;
    const legacy = await store.load(domainId);
    delete legacy.externalDependencies;
    delete legacy.proposal.externalDependencyTreatments;
    await store.save(domainId, legacy);
    const reloaded = await provider(t, p.workspacePath);
    const view = await reloaded.open("legacy");
    assert.deepEqual((await view.snapshot()).externalDependencies, []);
    assert.equal((await view.snapshot()).proposalHash,
        stableProposalHash({ proposalGeneration, proposal: { ...legacy.proposal, resources: [legacy.proposal.resources[0]] } }));
    const proposal = { resources: [api], edges: [], generatedAt: "2025-01-01T00:00:00.000Z" };
    const oldHash = stableProposalHash({ proposalGeneration: 1, proposal });
    assert.equal(oldHash, "1ba66e3937d60873e0beaa8f0f48996ea6e67caa439a68a243a87747137997d6");
    assert.equal(stableProposalHash({ proposalGeneration: 1, proposal, externalDependencies: [] }), oldHash);
    assert.notEqual(stableProposalHash({ proposalGeneration: 1, proposal, externalDependencies: expectedAccounting() }), oldHash);
});

test("concurrent resource edits conflict explicitly and keep external mappings coherent", async (t) => {
    const p = await provider(t);
    const { proposalGeneration } = await p.load();
    await p.propose(proposalGeneration);
    const view = await p.open();
    const before = await view.snapshot();
    const edits = await Promise.all(["billing-one", "billing-two"].map((name) =>
        view.post("/api/proposal/resource", { id: billing.id, name }, before)));
    assert.deepEqual(edits.map(({ status }) => status).sort(), [200, 409]);
    const after = await view.snapshot();
    assert.equal(after.externalDependencies[0].resourceMappings[0].name, after.proposal.resources[1].name);
    assert.equal(after.revision, before.revision + 1);
    assert.notEqual(after.proposalHash, before.proposalHash);
});

test("failed persistence rolls external discovery back rather than publishing unsaved facts", async (t) => {
    const p = await provider(t);
    const view = await p.open();
    await writeFile(join(p.workspacePath, "files"), "Block the disposable persistence directory.");
    await assert.rejects(p.load(), /EEXIST|ENOTDIR/);
    const failed = await view.snapshot();
    assert.equal(failed.discoveryLoaded, false);
    assert.deepEqual(failed.externalDependencies, []);
    await rm(join(p.workspacePath, "files"));
    await p.load();
    assert.equal((await view.snapshot()).externalDependencies.length, 4);
});

test("action schemas distinguish external facts and mappings from runnable service fields", async (t) => {
    const p = await provider(t);
    const discovery = p.canvas.actions.find(({ name }) => name === "load_discovery").inputSchema;
    assert.ok(discovery.properties.externalDependencies);
    assert.equal(discovery.required.includes("externalDependencies"), false);
    const external = discovery.properties.externalDependencies.items;
    assert.deepEqual(external.required, ["id", "name", "type"]);
    assert.equal(external.additionalProperties, false);
    for (const key of ["framework", "exposesHttp", "path", "include", "serviceDefaults"]) {
        assert.equal(external.properties[key], undefined);
    }
    const proposal = p.canvas.actions.find(({ name }) => name === "set_proposal").inputSchema;
    assert.ok(proposal.properties.resources.items.properties.externalDependencyId);
    assert.ok(proposal.properties.externalDependencyTreatments);
    assert.ok(proposal.properties.serviceTreatments, "the existing service contract must remain available");
});
