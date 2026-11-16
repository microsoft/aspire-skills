import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stableProposalHash, unproposedServices } from "../../extensions/aspireify/proposal-model.mjs";

const stubUrl = new URL("../fixtures/aspireify-sdk-stub.mjs", import.meta.url).href;
registerHooks({
    resolve(specifier, context, next) {
        return specifier === "@github/copilot-sdk/extension"
            ? { url: stubUrl, shortCircuit: true }
            : next(specifier, context);
    },
});

const workspacePath = await mkdtemp(join(tmpdir(), "aspireify-treatments-"));
const session = (globalThis.__aspireifyTestSession = {
    workspacePath, messages: [], confirm: async () => true,
});
await import("../../extensions/aspireify/extension.mjs");

test.after(() => rm(workspacePath, { recursive: true, force: true }));

function action(name, input, instanceId) {
    return session.canvas.actions
        .find((candidate) => candidate.name === name)
        .handler({ instanceId, input });
}

function discoveredService(id, path) {
    return { id, name: id, type: "Node.js", framework: "Express", exposesHttp: true, path };
}

async function loadServices(appHostPath, instanceId, ids) {
    return action(
        "load_discovery",
        {
            appHostPath,
            apphostStyle: "typescript",
            services: ids.map((id) => discoveredService(id, `src/${id}`)),
        },
        instanceId,
    );
}

const apiResource = { id: "api", name: "api", type: "Node.js", serviceId: "api" };

test("skill-supplied not-modeled and deferred treatments reach the canvas, confirmation, and chat handoff", async (t) => {
    const appHostPath = join(workspacePath, "repo", "AppHost");
    const instanceId = "treatments";
    const input = { appHostPath };
    const discovery = await loadServices(appHostPath, instanceId, ["api", "worker", "legacy", "tools"]);
    const result = await action(
        "set_proposal",
        {
            ...input,
            proposalGeneration: discovery.proposalGeneration,
            resources: [apiResource],
            edges: [],
            serviceTreatments: [
                {
                    serviceId: "worker",
                    treatment: "not-modeled",
                    reason: "Runs only as a one-off migration job outside local development.",
                },
                {
                    serviceId: "legacy",
                    treatment: "deferred",
                    reason: "Needs a Windows-only runtime the team will containerize later.",
                    unresolved: "Container image and port for the legacy service.",
                },
            ],
        },
        instanceId,
    );
    assert.equal(result.ok, true);

    const opened = await session.canvas.open({ instanceId, input });
    t.after(() => session.canvas.onClose({ instanceId }));
    const url = new URL(opened.url);
    const headers = {
        "content-type": "application/json",
        "x-aspireify-token": url.searchParams.get("token"),
    };

    const review = await (await fetch(new URL("/api/snapshot", url), { headers })).json();
    const expected = [
        {
            id: "worker",
            name: "worker",
            type: "Node.js",
            path: "src/worker",
            treatment: "not-modeled",
            reason: "Runs only as a one-off migration job outside local development.",
        },
        {
            id: "legacy",
            name: "legacy",
            type: "Node.js",
            path: "src/legacy",
            treatment: "deferred",
            reason: "Needs a Windows-only runtime the team will containerize later.",
            unresolved: "Container image and port for the legacy service.",
        },
        { id: "tools", name: "tools", type: "Node.js", path: "src/tools", treatment: "not-assessed" },
    ];
    assert.deepEqual(review.notProposed, expected);

    const confirmed = await fetch(new URL("/api/confirm", url), {
        method: "POST",
        headers,
        body: JSON.stringify({
            expectedAppHostPath: review.appHostPath,
            expectedRevision: review.revision,
            expectedProposalGeneration: review.proposalGeneration,
            expectedProposalHash: review.proposalHash,
        }),
    });
    assert.equal(confirmed.status, 200);

    const confirmation = await action("get_confirmation", input, instanceId);
    assert.deepEqual(confirmation.notProposed, expected);

    const handoff = session.messages.find((message) => message.includes("findings confirmed"));
    assert.ok(handoff, "confirmation must be handed off to chat");
    const payload = JSON.parse(handoff.split("\n")[3]);
    assert.deepEqual(payload.notProposed, [
        {
            name: "worker",
            path: "src/worker",
            treatment: "not-modeled",
            reason: "Runs only as a one-off migration job outside local development.",
        },
        {
            name: "legacy",
            path: "src/legacy",
            treatment: "deferred",
            reason: "Needs a Windows-only runtime the team will containerize later.",
            unresolved: "Container image and port for the legacy service.",
        },
        { name: "tools", path: "src/tools", treatment: "not-assessed" },
    ]);
});

test("treatments are rejected for unknown or mapped services and incomplete decisions", async () => {
    const appHostPath = join(workspacePath, "invalid", "AppHost");
    const instanceId = "invalid-treatments";
    const discovery = await loadServices(appHostPath, instanceId, ["api", "worker"]);
    const propose = (serviceTreatments) =>
        action(
            "set_proposal",
            {
                appHostPath,
                proposalGeneration: discovery.proposalGeneration,
                resources: [apiResource],
                edges: [],
                serviceTreatments,
            },
            instanceId,
        );
    await assert.rejects(
        propose([{ serviceId: "ghost", treatment: "not-modeled", reason: "x" }]),
        /not a discovered service/,
    );
    await assert.rejects(
        propose([{ serviceId: "api", treatment: "not-modeled", reason: "x" }]),
        /already maps it/,
    );
    await assert.rejects(
        propose([{ serviceId: "worker", treatment: "not-modeled", reason: " " }]),
        /reason is required/,
    );
    await assert.rejects(
        propose([{ serviceId: "worker", treatment: "deferred", reason: "Later." }]),
        /unresolved is required/,
    );
    await assert.rejects(
        propose([{ serviceId: "worker", treatment: "not-assessed", reason: "x" }]),
        /treatment must be one of/,
    );
    await assert.rejects(
        propose([
            { serviceId: "worker", treatment: "not-modeled", reason: "x" },
            { serviceId: "worker", treatment: "not-modeled", reason: "y" },
        ]),
        /repeats the treatment/,
    );
});

test("a treatment is ignored once a resource maps the service, and empty treatments keep existing hashes", () => {
    const services = ["api", "worker"].map((id) => discoveredService(id, `src/${id}`));
    assert.deepEqual(
        unproposedServices({
            services,
            resources: [{ id: "worker", serviceId: "worker", include: true }],
            serviceTreatments: [{ serviceId: "worker", treatment: "not-modeled", reason: "x" }],
        }),
        [{ id: "api", name: "api", type: "Node.js", path: "src/api", treatment: "not-assessed" }],
    );
    const proposal = { resources: [apiResource], edges: [], generatedAt: "2025-01-01T00:00:00.000Z" };
    assert.equal(
        stableProposalHash({ proposalGeneration: 1, proposal, serviceTreatments: [] }),
        stableProposalHash({ proposalGeneration: 1, proposal }),
    );
    assert.notEqual(
        stableProposalHash({
            proposalGeneration: 1,
            proposal,
            serviceTreatments: [{ serviceId: "worker", treatment: "not-modeled", reason: "x" }],
        }),
        stableProposalHash({ proposalGeneration: 1, proposal }),
    );
});
