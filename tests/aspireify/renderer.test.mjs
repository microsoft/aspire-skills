import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import * as interactionModel from "../../extensions/aspireify/ui/interaction-model.js";
import * as resourceTypes from "../../extensions/aspireify/ui/resource-types.js";

const rendererSource = (await readFile(
    new URL("../../extensions/aspireify/ui/app.js", import.meta.url),
    "utf8",
)).replace(/^import \{[\s\S]*?\} from "\.\/[^"]+";\r?\n/gm, "");
const targetA = "C:\\reviews\\A.AppHost.csproj";
const targetB = "C:\\reviews\\B.AppHost.csproj";

function review(appHostPath, revision, overrides = {}) {
    return {
        appHostPath,
        apphostStyle: "csharp-sdk",
        revision,
        proposalLoaded: true,
        confirmed: true,
        confirmationDelivered: true,
        proposalGeneration: 1,
        confirmedGeneration: 1,
        proposalHash: "a".repeat(64),
        proposal: {
            generatedAt: "2026-01-01T00:00:00.000Z",
            resources: [],
            edges: [],
        },
        validation: { issues: [], resourceIssues: {} },
        ...overrides,
    };
}

async function createRenderer(initialSnapshot) {
    const nodes = new Map();
    const documentListeners = new Map();
    const requests = [];
    let currentSnapshot = initialSnapshot;
    let events;
    const node = (id) => {
        if (!nodes.has(id)) {
            nodes.set(id, {
                listeners: new Map(),
                open: false,
                disabled: false,
                textContent: "",
                classList: { add() {}, remove() {}, toggle() {} },
                addEventListener(type, listener) { this.listeners.set(type, listener); },
                showModal() { this.open = true; },
                close() { this.open = false; },
            });
        }
        return nodes.get(id);
    };
    const context = createContext({
        ...interactionModel,
        ...resourceTypes,
        URLSearchParams,
        structuredClone,
        setTimeout,
        clearInterval,
        HTMLElement: class {},
        document: {
            body: node("body"),
            getElementById: node,
            querySelectorAll: () => [],
            addEventListener: (type, listener) => documentListeners.set(type, listener),
        },
        window: {
            location: { search: "?token=renderer-test" },
            addEventListener() {},
            matchMedia: () => ({ matches: true }),
        },
        EventSource: class {
            constructor() { events = this; }
        },
        fetch: async (path, options) => {
            if (path === "/api/snapshot") {
                return { ok: true, json: async () => structuredClone(currentSnapshot) };
            }
            const response = Promise.withResolvers();
            requests.push({ path, body: JSON.parse(options.body), resolve: response.resolve });
            return response.promise;
        },
    });
    runInContext(rendererSource, context, { filename: "aspireify/ui/app.js" });
    // Keep the dialog, snapshot, and transport paths real without constructing the resource graph DOM.
    runInContext("renderResourcePlan = () => {}; renderNotProposedItems = () => {};", context);
    documentListeners.get("DOMContentLoaded")();
    await new Promise((resolve) => setImmediate(resolve));
    events.onopen();
    assert.equal(node("error").hidden, true);
    assert.equal(node("restart-review").hidden, false);

    return {
        node,
        requests,
        openRestart() {
            assert.equal(node("restart-review").disabled, false);
            node("restart-review").listeners.get("click")();
        },
        submitRestart() {
            assert.equal(node("restart-review-dialog").open, true);
            assert.equal(node("approve-restart").disabled, false);
            return node("restart-review-form").listeners.get("submit")({ preventDefault() {} });
        },
        pushSnapshot(nextSnapshot) {
            currentSnapshot = nextSnapshot;
            events.onmessage({ data: JSON.stringify({ type: "snapshot", snapshot: nextSnapshot }) });
            assert.equal(runInContext("snapshot.appHostPath", context), nextSnapshot.appHostPath);
        },
        respond(request, payload, status = 200) {
            request.resolve({ ok: status < 400, status, json: async () => payload });
        },
    };
}

for (const retargetBeforeResponse of [true, false]) {
    test(`retargeting ${retargetBeforeResponse ? "during" : "after"} a failed restart handoff closes its dialog`, async () => {
        const renderer = await createRenderer(review(targetA, 4));
        renderer.openRestart();
        assert.match(renderer.node("restart-review-target").textContent, /A\.AppHost\.csproj/);
        const submitted = renderer.submitRestart();
        assert.equal(renderer.requests[0].body.expectedAppHostPath, targetA);

        renderer.pushSnapshot(retargetBeforeResponse
            ? review(targetB, 9)
            : review(targetA, 5, { restartApproved: true, restartNotificationPending: true }));
        renderer.respond(renderer.requests[0], { delivered: false, error: "Chat unavailable." }, 202);
        await submitted;
        if (!retargetBeforeResponse) {
            assert.equal(renderer.node("restart-review-dialog").open, true);
            renderer.pushSnapshot(review(targetB, 9));
        }

        assert.equal(renderer.node("restart-review-dialog").open, false);
        assert.equal(renderer.requests.length, 1);
        renderer.openRestart();
        assert.match(renderer.node("restart-review-target").textContent, /B\.AppHost\.csproj/);
        const restarted = renderer.submitRestart();
        assert.equal(renderer.requests[1].body.expectedAppHostPath, targetB);
        assert.equal(renderer.requests[1].body.expectedRevision, 9);
        renderer.pushSnapshot(review(targetB, 10, { restartApproved: true }));
        renderer.respond(renderer.requests[1], { delivered: true });
        await restarted;
        assert.equal(renderer.node("restart-review-dialog").open, false);
    });
}

test("a same-target restart notification failure keeps the dialog available for retry", async () => {
    const renderer = await createRenderer(review(targetA, 4));
    renderer.openRestart();
    const submitted = renderer.submitRestart();
    renderer.pushSnapshot(review(targetA, 5, { restartApproved: true, restartNotificationPending: true }));
    renderer.respond(renderer.requests[0], { delivered: false, error: "Chat unavailable." }, 202);
    await submitted;

    assert.equal(renderer.node("restart-review-dialog").open, true);
    assert.equal(renderer.node("restart-review-error").textContent, "Chat unavailable.");
    assert.equal(renderer.node("approve-restart").disabled, false);
    const retried = renderer.submitRestart();
    assert.equal(renderer.requests[1].body.expectedAppHostPath, targetA);
    assert.equal(renderer.requests[1].body.expectedRevision, 5);
    renderer.pushSnapshot(review(targetA, 6, { restartApproved: true }));
    renderer.respond(renderer.requests[1], { delivered: true });
    await retried;
    assert.equal(renderer.node("restart-review-dialog").open, false);
});
