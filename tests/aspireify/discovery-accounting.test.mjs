import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { unproposedServices } from "../../extensions/aspireify/proposal-model.mjs";

const stubUrl = new URL("../fixtures/aspireify-sdk-stub.mjs", import.meta.url).href;
registerHooks({
    resolve(specifier, context, next) {
        return specifier === "@github/copilot-sdk/extension"
            ? { url: stubUrl, shortCircuit: true }
            : next(specifier, context);
    },
});

const workspacePath = await mkdtemp(join(tmpdir(), "aspireify-accounting-"));
const session = (globalThis.__aspireifyTestSession = { workspacePath, messages: [] });
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

test("discovered services without a proposal mapping stay visible and are confirmed as not assessed", async (t) => {
    const appHostPath = join(workspacePath, "repo", "AppHost");
    const instanceId = "accounting";
    const input = { appHostPath };
    const discovery = await action(
        "load_discovery",
        {
            ...input,
            apphostStyle: "typescript",
            services: [discoveredService("api", "src/api"), discoveredService("worker", "src/worker")],
        },
        instanceId,
    );
    await action(
        "set_proposal",
        {
            ...input,
            proposalGeneration: discovery.proposalGeneration,
            resources: [{ id: "api", name: "api", type: "Node.js", serviceId: "api" }],
            edges: [],
        },
        instanceId,
    );
    const opened = await session.canvas.open({ instanceId, input });
    t.after(() => session.canvas.onClose({ instanceId }));
    const url = new URL(opened.url);
    const headers = {
        "content-type": "application/json",
        "x-aspireify-token": url.searchParams.get("token"),
    };

    const review = await (await fetch(new URL("/api/snapshot", url), { headers })).json();
    assert.deepEqual(review.notProposed, [
        { id: "worker", name: "worker", type: "Node.js", path: "src/worker", treatment: "not-assessed" },
    ]);

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
    assert.deepEqual(confirmation.included.map((service) => service.id), ["api"]);
    assert.deepEqual(confirmation.excluded, []);
    assert.deepEqual(confirmation.notProposed, review.notProposed);

    const handoff = session.messages.find((message) => message.includes("findings confirmed"));
    assert.ok(handoff, "confirmation must be handed off to chat");
    const payload = JSON.parse(handoff.split("\n")[3]);
    assert.deepEqual(payload.notProposed, [
        { name: "worker", path: "src/worker", treatment: "not-assessed" },
    ]);
});

test("services represented by kept, excluded, or removed generated resources are not reported as unassessed", () => {
    const services = ["api", "cache", "legacy", "worker"].map((id) =>
        discoveredService(id, `src/${id}`),
    );
    assert.deepEqual(
        unproposedServices({
            services,
            resources: [
                { id: "api", serviceId: "api", include: true },
                { id: "cache", serviceId: "cache", include: false },
                { id: "postgres", include: true },
            ],
            removedGeneratedResources: [{ id: "legacy", serviceId: "legacy" }],
        }),
        [{ id: "worker", name: "worker", type: "Node.js", path: "src/worker", treatment: "not-assessed" }],
    );
});
