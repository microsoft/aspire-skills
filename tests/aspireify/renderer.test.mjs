import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import * as interactionModel from "../../extensions/aspireify/ui/interaction-model.js";
import * as resourceTypes from "../../extensions/aspireify/ui/resource-types.js";
import * as connectionsTreeModel from "../../extensions/aspireify/ui/connections-tree.js";
import { createCanvasTestDom } from "../fixtures/canvas-test-dom.mjs";

const rendererSource = (await readFile(
    new URL("../../extensions/aspireify/ui/app.js", import.meta.url),
    "utf8",
)).replace(/^import \{[\s\S]*?\} from "\.\/[^"]+";\r?\n/gm, "");
const indexSource = await readFile(new URL("../../extensions/aspireify/ui/index.html", import.meta.url), "utf8");
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
        services: [],
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

async function createRenderer(initialSnapshot, { renderPlan = false, narrow = false } = {}) {
    const dom = createCanvasTestDom(indexSource);
    const documentListeners = dom.listeners;
    const requests = [];
    let currentSnapshot = initialSnapshot;
    let events;
    const node = (id) => id === "body" ? dom.document.body : dom.document.getElementById(id);
    const context = createContext({
        ...interactionModel,
        ...resourceTypes,
        ...connectionsTreeModel,
        URLSearchParams,
        structuredClone,
        setTimeout,
        clearInterval,
        HTMLElement: dom.HTMLElement,
        HTMLInputElement: dom.HTMLInputElement,
        HTMLTextAreaElement: dom.HTMLTextAreaElement,
        requestAnimationFrame: (callback) => callback(),
        document: dom.document,
        window: {
            location: { search: "?token=renderer-test" },
            addEventListener() {},
            matchMedia: (query) => ({ matches: query.includes("max-width") ? narrow : true }),
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
    if (!renderPlan) {
        runInContext("renderResourcePlan = () => {}; renderNotProposedItems = () => {};", context);
    }
    documentListeners.get("DOMContentLoaded")();
    await new Promise((resolve) => setImmediate(resolve));
    events.onopen();
    assert.equal(node("error").hidden, true);
    assert.equal(node("restart-review").hidden, !initialSnapshot.confirmed);

    return {
        node,
        requests,
        document: dom.document,
        evaluate: (source) => runInContext(source, context),
        nodes() { return node("topology-nodes").querySelectorAll(".topology-node"); },
        paths() { return node("topology-lines").querySelectorAll(".topology-edge"); },
        select(id) {
            const button = this.nodes().find((candidate) => candidate.dataset.resourceId === id);
            assert.ok(button, `Resource ${id} is present on the map`);
            button.listeners.get("click")();
        },
        press(key, target = dom.document.activeElement, { prevented: expected = true, ...modifiers } = {}) {
            let prevented = false;
            node("topology-nodes").listeners.get("keydown")({
                key, target, ...modifiers, preventDefault() { prevented = true; },
            });
            assert.equal(prevented, expected);
        },
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

function graphReview(names = ["api", "worker", "db", "isolated"], edges = [
    { id: "api-db", from: "api", to: "db", kind: "reference" },
    { id: "worker-db", from: "worker", to: "db", kind: "waitFor" },
], overrides = {}) {
    return review(targetA, 4, {
        confirmed: false,
        confirmationDelivered: false,
        confirmedGeneration: null,
        proposal: {
            generatedAt: "2026-01-01T00:00:00.000Z",
            resources: names.map((name) => ({ id: name, name, type: "Container", include: true })),
            edges,
        },
        ...overrides,
    });
}

test("one topology contains each resource once, nests children, and shows shared connections beside the inspector", async () => {
    const renderer = await createRenderer(graphReview(
        ["web", "worker", "api", "postgres", "catalog", "queue"],
        [
            { id: "web-api", from: "web", to: "api", kind: "reference" },
            { id: "api-catalog", from: "api", to: "catalog", kind: "reference" },
            { id: "worker-catalog", from: "worker", to: "catalog", kind: "waitFor" },
            { id: "worker-queue", from: "worker", to: "queue", kind: "reference" },
            { id: "catalog-postgres", from: "catalog", to: "postgres", kind: "parent" },
        ],
    ), { renderPlan: true });
    const before = renderer.evaluate("JSON.stringify(snapshot)");
    const nodes = renderer.nodes();
    assert.equal(nodes.length, 6);
    assert.equal(new Set(nodes.map((node) => node.dataset.resourceId)).size, 6);
    const child = nodes.find((node) => node.dataset.resourceId === "catalog");
    const group = child.parentElement.parentElement;
    assert.equal(group.tagName, "ul");
    assert.equal(group.getAttribute("aria-label"), "Children of postgres");
    assert.equal(group.parentElement.children[0].dataset.resourceId, "postgres");
    assert.equal(renderer.paths().length, 4);
    assert.equal(renderer.paths().filter((path) => path.matches(".topology-edge-reference")).length, 3);
    assert.equal(renderer.paths().filter((path) => path.matches(".topology-edge-wait")).length, 1);
    assert.equal(renderer.node("topology-lines").getAttribute("aria-hidden"), "true");
    assert.match(renderer.node("plan-inspector").textContent, /web/);
    assert.equal(renderer.node("plan-inspector").hidden, false);
    assert.equal(renderer.node("relationship-workspace").contains(renderer.node("plan-overview")), true);
    assert.equal(renderer.node("relationship-workspace").contains(renderer.node("plan-inspector")), true);
    assert.equal(renderer.evaluate("JSON.stringify(snapshot)"), before);
    assert.equal(renderer.requests.length, 0);
});

test("selecting a resource highlights its exact connections and the inspector edits them", async () => {
    const renderer = await createRenderer(graphReview(), { renderPlan: true });
    renderer.select("worker");
    const nodes = renderer.nodes();
    assert.equal(nodes.find((node) => node.dataset.resourceId === "worker").getAttribute("aria-pressed"), "true");
    assert.equal(nodes.find((node) => node.dataset.resourceId === "db").matches(".is-connected"), true);
    assert.equal(nodes.find((node) => node.dataset.resourceId === "api").matches(".is-connected"), false);
    assert.equal(renderer.paths().find((path) => path.dataset.edgeId === "worker-db").matches(".is-highlighted"), true);
    assert.equal(renderer.paths().find((path) => path.dataset.edgeId === "api-db").matches(".is-muted"), true);
    assert.match(renderer.node("plan-inspector").textContent, /worker.*waits for db/);
    const chip = renderer.node("plan-inspector").querySelector(".connection-chip");
    assert.equal(chip.getAttribute("aria-label"), "Edit wait-for connection from worker to db");
    chip.listeners.get("click")();
    assert.equal(renderer.node("connection-dialog").open, true);
    assert.equal(renderer.node("connection-id").value, "worker-db");
    assert.equal(renderer.requests.length, 0);
});

test("keyboard selection follows nested resources, has one tab stop, and leaves browser shortcuts alone", async () => {
    const renderer = await createRenderer(graphReview(["api", "postgres", "catalog"], [
        { id: "api-catalog", from: "api", to: "catalog", kind: "reference" },
        { id: "catalog-postgres", from: "catalog", to: "postgres", kind: "parent" },
    ]), { renderPlan: true });
    renderer.select("postgres");
    assert.equal(renderer.document.activeElement.dataset.resourceId, "postgres");
    renderer.press("ArrowRight");
    assert.equal(renderer.document.activeElement.dataset.resourceId, "catalog");
    assert.match(renderer.node("plan-inspector").textContent, /catalog/);
    renderer.press("ArrowLeft");
    assert.equal(renderer.document.activeElement.dataset.resourceId, "postgres");
    renderer.press("Home");
    assert.equal(renderer.document.activeElement.dataset.resourceId, "api");
    renderer.press("End");
    assert.equal(renderer.document.activeElement.dataset.resourceId, "catalog");
    renderer.press("a");
    assert.equal(renderer.document.activeElement.dataset.resourceId, "api");
    assert.equal(renderer.nodes().filter((node) => node.tabIndex === 0).length, 1);
    const current = renderer.document.activeElement;
    renderer.press("Tab", current, { prevented: false });
    renderer.press("Tab", current, { prevented: false, shiftKey: true });
    for (const modifier of ["ctrlKey", "altKey", "metaKey", "shiftKey"]) {
        renderer.press("ArrowDown", current, { prevented: false, [modifier]: true });
    }
    assert.equal(renderer.document.activeElement, current);
    renderer.press("F2", current);
    assert.equal(renderer.document.activeElement.matches(".connection-chip"), true);
});

test("selection and focus survive renames, fall back after removal, and reset for a different AppHost", async () => {
    const initial = graphReview();
    const renderer = await createRenderer(initial, { renderPlan: true });
    renderer.select("db");
    const renamed = structuredClone(initial);
    renamed.revision++;
    renamed.proposal.resources.find((resource) => resource.id === "db").name = "storage";
    renamed.proposal.edges.forEach((edge) => { edge.to = "storage"; });
    renderer.pushSnapshot(renamed);
    assert.equal(renderer.document.activeElement.dataset.resourceId, "db");
    assert.match(renderer.node("plan-inspector").textContent, /storage/);
    const removed = structuredClone(renamed);
    removed.revision++;
    removed.proposal.resources = removed.proposal.resources.filter((resource) => resource.id !== "db");
    removed.proposal.edges = [];
    renderer.pushSnapshot(removed);
    assert.equal(renderer.document.activeElement.dataset.resourceId, "api");
    assert.equal(renderer.nodes().filter((node) => node.tabIndex === 0).length, 1);
    renderer.select("worker");
    renderer.pushSnapshot({ ...removed, appHostPath: targetB, revision: 1 });
    assert.equal(renderer.evaluate("selectedResourceId"), "api");
    assert.equal(renderer.requests.length, 0);
});

test("removing the final focused resource moves focus to Add resource", async () => {
    const initial = graphReview(["api"], []);
    const renderer = await createRenderer(initial, { renderPlan: true });
    renderer.select("api");
    renderer.pushSnapshot({
        ...initial,
        revision: 5,
        proposal: { ...initial.proposal, resources: [] },
    });
    assert.equal(renderer.document.activeElement, renderer.node("compact-add-resource"));
    assert.equal(renderer.node("topology-surface").hidden, true);
});

test("narrow-screen activation focuses the inspector and Back returns to the selected node", async () => {
    const renderer = await createRenderer(graphReview(), { renderPlan: true, narrow: true });
    renderer.select("worker");
    const back = renderer.node("plan-inspector").querySelector(".inspector-back");
    assert.equal(renderer.document.activeElement, back);
    back.listeners.get("click")();
    assert.equal(renderer.document.activeElement.dataset.resourceId, "worker");
    renderer.press("ArrowUp");
    assert.equal(renderer.document.activeElement.dataset.resourceId, "api");
});

test("changing selection preserves invalid field drafts and blocks confirmation", async () => {
    const renderer = await createRenderer(graphReview(["api", "worker"], []), { renderPlan: true });
    const input = renderer.document.querySelectorAll("input")
        .find((candidate) => candidate.getAttribute("aria-label") === "Resource name for api");
    input.value = "invalid name";
    input.listeners.get("input")();
    assert.equal(renderer.node("confirm").disabled, true);
    const note = renderer.node("footer-note").textContent;
    renderer.select("worker");
    assert.equal(renderer.node("confirm").disabled, true);
    assert.equal(renderer.node("footer-note").textContent, note);
    renderer.select("api");
    assert.equal(renderer.document.querySelectorAll("input")
        .find((candidate) => candidate.getAttribute("aria-label") === "Resource name for api").value, "invalid name");
    assert.equal(renderer.evaluate("snapshot.proposal.resources[0].name"), "api");
    assert.equal(renderer.requests.length, 0);
});

test("selecting another node during a pending save keeps confirmation blocked without a second mutation", async () => {
    const initial = graphReview(["api", "worker"], []);
    const renderer = await createRenderer(initial, { renderPlan: true });
    const input = renderer.document.querySelectorAll("input")
        .find((candidate) => candidate.getAttribute("aria-label") === "Resource name for api");
    input.value = "renamed-api";
    input.listeners.get("input")();
    input.listeners.get("change")();
    assert.equal(renderer.requests.length, 1);
    renderer.select("worker");
    assert.equal(renderer.node("confirm").disabled, true);
    assert.equal(renderer.requests.length, 1);
    const next = structuredClone(initial);
    next.revision++;
    next.proposal.resources[0].name = "renamed-api";
    renderer.pushSnapshot(next);
    renderer.respond(renderer.requests[0], { ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(renderer.node("confirm").disabled, false);
    assert.match(renderer.nodes().find((node) => node.dataset.resourceId === "api").textContent, /renamed-api/);
});

test("confirmation preserves snapshot identity and leaves the topology and inspector read-only", async () => {
    const initial = graphReview();
    const renderer = await createRenderer(initial, { renderPlan: true });
    renderer.select("worker");
    const proposal = renderer.evaluate("JSON.stringify(snapshot.proposal)");
    renderer.node("confirm").listeners.get("click")();
    assert.deepEqual(renderer.requests[0].body, {
        expectedAppHostPath: targetA,
        expectedRevision: initial.revision,
        expectedProposalGeneration: initial.proposalGeneration,
        expectedProposalHash: initial.proposalHash,
    });
    assert.equal(renderer.requests[0].path, "/api/confirm");
    renderer.pushSnapshot({
        ...initial, revision: 5, confirmed: true, confirmationDelivered: true, confirmedGeneration: 1,
    });
    renderer.respond(renderer.requests[0], { confirmed: true, delivered: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(renderer.node("compact-add-resource").hidden, true);
    assert.equal(renderer.node("action-footer").hidden, true);
    assert.equal(renderer.node("plan-inspector").hidden, false);
    assert.equal(renderer.node("plan-inspector").querySelector(".connection-chip").tagName, "span");
    assert.equal(renderer.node("plan-inspector").querySelector(".resource-remove"), null);
    assert.ok(renderer.node("plan-inspector").querySelectorAll("input").every((input) => input.disabled));
    renderer.select("api");
    renderer.press("F2", renderer.document.activeElement, { prevented: false });
    assert.equal(renderer.node("connection-dialog").open, false);
    assert.equal(renderer.evaluate("JSON.stringify(snapshot.proposal)"), proposal);
    assert.equal(renderer.requests.length, 1);
});

test("a successful confirmation response makes the inspector read-only without waiting for a snapshot event", async () => {
    const renderer = await createRenderer(graphReview(), { renderPlan: true });
    renderer.select("worker");
    const confirming = renderer.evaluate("confirmSnapshot()");
    renderer.respond(renderer.requests[0], { confirmed: true, delivered: true });
    await confirming;
    assert.equal(renderer.node("action-footer").hidden, true);
    assert.equal(renderer.node("plan-inspector").querySelector(".connection-chip").tagName, "span");
    assert.ok(renderer.node("plan-inspector").querySelectorAll("input").every((input) => input.disabled));
    assert.equal(renderer.node("plan-inspector").querySelector(".resource-remove"), null);
});

for (const status of [200, 403]) {
    test(`a ${status} confirmation response for a previous AppHost does not affect the new target`, async () => {
        const renderer = await createRenderer(graphReview(), { renderPlan: true });
        const confirming = renderer.evaluate("confirmSnapshot()");
        renderer.pushSnapshot({ ...graphReview(), appHostPath: targetB, revision: 5 });
        renderer.respond(renderer.requests[0], status === 200
            ? { confirmed: true, delivered: true }
            : { error: "Previous target was declined." }, status);
        await confirming;
        assert.equal(renderer.evaluate("snapshot.appHostPath"), targetB);
        assert.equal(renderer.evaluate("snapshot.confirmed"), false);
        assert.equal(renderer.node("confirm").disabled, false);
        assert.equal(renderer.node("action-footer").hidden, false);
        assert.doesNotMatch(renderer.node("footer-note").textContent, /Previous target/);
    });
}

test("failed confirmation remains retryable after selecting another node", async () => {
    const renderer = await createRenderer(graphReview(), { renderPlan: true });
    renderer.node("confirm").listeners.get("click")();
    renderer.respond(renderer.requests[0], { error: "Host approval was declined." }, 403);
    await new Promise((resolve) => setImmediate(resolve));
    renderer.select("worker");
    assert.equal(renderer.node("footer-note").textContent, "Host approval was declined.");
    assert.equal(renderer.node("confirm").disabled, false);
    assert.equal(renderer.requests.length, 1);
});

test("an already-confirmed proposal remains explorable and can retry the same chat handoff", async () => {
    const initial = graphReview(["api", "db"], [
        { id: "api-db", from: "api", to: "db", kind: "reference" },
    ], { confirmed: true, confirmedGeneration: 1 });
    const renderer = await createRenderer(initial, { renderPlan: true });
    const before = renderer.evaluate("JSON.stringify(snapshot)");
    renderer.select("db");
    assert.equal(renderer.node("confirm").textContent, "Notify chat");
    assert.equal(renderer.node("confirm").disabled, false);
    assert.equal(renderer.evaluate("JSON.stringify(snapshot)"), before);
    renderer.node("confirm").listeners.get("click")();
    assert.equal(renderer.requests[0].path, "/api/confirm");
    assert.equal(renderer.requests[0].body.expectedProposalHash, initial.proposalHash);
    renderer.pushSnapshot({ ...initial, revision: 5, confirmationDelivered: true });
    renderer.respond(renderer.requests[0], { confirmed: true, delivered: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(renderer.node("confirm").disabled, true);
    assert.equal(renderer.node("action-footer").hidden, true);
});

test("exploring a delivered confirmation does not change it or send another request", async () => {
    const initial = graphReview(["api", "db"], [
        { id: "api-db", from: "api", to: "db", kind: "reference" },
    ], { confirmed: true, confirmationDelivered: true, confirmedGeneration: 1 });
    const renderer = await createRenderer(initial, { renderPlan: true });
    const before = renderer.evaluate("JSON.stringify(snapshot)");
    renderer.select("db");
    assert.equal(renderer.node("action-footer").hidden, true);
    assert.equal(renderer.node("plan-inspector").querySelector(".connection-chip").tagName, "span");
    assert.equal(renderer.evaluate("JSON.stringify(snapshot)"), before);
    assert.equal(renderer.requests.length, 0);
});

test("ambiguous and stale endpoints stay visible without attaching to the wrong resource", async () => {
    const edges = [
        { id: "valid", from: "api", to: "cache", fromId: "api", toId: "cache-a", kind: "reference" },
        { id: "ambiguous", from: "api", to: "cache", kind: "waitFor" },
        { id: "stale", from: "api", to: "cache", fromId: "api", toId: "gone", kind: "reference" },
    ];
    const initial = graphReview(["api", "cache-a", "cache-b"], edges);
    initial.proposal.resources.slice(1).forEach((resource) => { resource.name = "cache"; });
    const renderer = await createRenderer(initial, { renderPlan: true });
    assert.equal(renderer.paths().length, 1);
    assert.equal(renderer.paths()[0].dataset.toId, "cache-a");
    assert.equal(renderer.node("connections-unplaced").hidden, false);
    assert.match(renderer.node("connections-unplaced-summary").textContent, /Not placed on the map \(2\)/);
    const rows = renderer.node("connections-unplaced-list").querySelectorAll("li");
    assert.match(rows[0].textContent, /waits for cache.*Ambiguous endpoint/);
    assert.match(rows[1].textContent, /references cache \(not found\).*Endpoint resource not found/);
    renderer.select("cache-b");
    assert.equal(renderer.node("plan-inspector").querySelectorAll(".connection-chip").length, 0);
    renderer.select("cache-a");
    assert.equal(renderer.node("plan-inspector").querySelectorAll(".connection-chip").length, 1);
    const edit = rows[0].querySelector("button");
    assert.equal(edit.getAttribute("aria-label"), "Edit connection: api → waits for cache");
    edit.listeners.get("click")();
    assert.equal(renderer.node("connection-dialog").open, true);
    assert.equal(renderer.node("connection-id").value, "ambiguous");
    assert.equal(renderer.node("connection-from").value, "");
    assert.equal(renderer.node("connection-to").value, "");
    assert.equal(renderer.node("save-connection").disabled, true);
    assert.match(renderer.node("connection-placement-help").textContent, /unique names/);
    assert.equal(renderer.node("delete-connection").hidden, false);
    assert.equal(renderer.requests.length, 0);

    const confirmed = structuredClone(initial);
    confirmed.confirmed = true;
    const readOnly = await createRenderer(confirmed, { renderPlan: true });
    assert.equal(readOnly.node("connections-unplaced-list").querySelectorAll("li").length, 2);
    assert.equal(readOnly.node("connections-unplaced-list").querySelector("button"), null);
});

test("ID-resolved connections use current resource names in the inspector and editor", async () => {
    const renderer = await createRenderer(graphReview(["api", "db"], [
        { id: "resolved", from: "old-api", to: "old-db", fromId: "api", toId: "db", kind: "reference" },
    ]), { renderPlan: true });
    const chip = renderer.node("plan-inspector").querySelector(".connection-chip");
    assert.equal(chip.getAttribute("aria-label"), "Edit reference connection from api to db");
    assert.match(chip.textContent, /references db/);
    chip.listeners.get("click")();
    assert.equal(renderer.node("connection-from").value, "api");
    assert.equal(renderer.node("connection-to").value, "db");
    assert.equal(renderer.requests.length, 0);
});

test("ambiguous ownership and parent cycles are listed rather than shown as invented nesting", async () => {
    const renderer = await createRenderer(graphReview(["a", "b", "c"], [
        { id: "a-b", from: "a", to: "b", kind: "parent" },
        { id: "a-c", from: "a", to: "c", kind: "parent" },
        { id: "b-c", from: "b", to: "c", kind: "parent" },
        { id: "c-b", from: "c", to: "b", kind: "parent" },
    ]), { renderPlan: true });
    assert.equal(renderer.nodes().length, 3);
    assert.equal(renderer.node("topology-nodes").querySelectorAll(".topology-children").length, 0);
    assert.equal(renderer.paths().length, 0);
    const rows = renderer.node("connections-unplaced-list").querySelectorAll("li");
    assert.equal(rows.length, 4);
    assert.match(rows[0].textContent, /multiple parents/);
    assert.match(rows[2].textContent, /form a cycle/);
    assert.equal(rows[2].querySelector("button").getAttribute("aria-label"), "Edit connection: b → child of c");
});

test("missing and excluded endpoints remain visible and require explicit repair", async () => {
    const initial = graphReview(["api", "queue"], [
        { id: "missing", from: "api", to: "gone", kind: "reference" },
        { id: "excluded", from: "api", to: "excluded", kind: "waitFor" },
    ]);
    initial.proposal.resources.push({ id: "excluded", name: "excluded", type: "Container", include: false });
    const renderer = await createRenderer(initial, { renderPlan: true });
    assert.equal(renderer.nodes().length, 2);
    assert.equal(renderer.paths().length, 0);
    const rows = renderer.node("connections-unplaced-list").querySelectorAll("li");
    assert.equal(rows.length, 2);
    assert.match(rows[1].textContent, /excluded/);
    rows[0].querySelector("button").listeners.get("click")();
    assert.equal(renderer.node("connection-dialog").open, true);
    assert.equal(renderer.node("connection-from").value, "");
    assert.equal(renderer.node("connection-to").value, "");
    const submit = () => renderer.node("connection-form").listeners.get("submit")({
        preventDefault() {}, submitter: renderer.node("save-connection"),
    });
    await submit();
    assert.match(renderer.node("connection-dialog-error").textContent, /Choose both/);
    assert.equal(renderer.requests.length, 0);
    renderer.node("connection-from").value = "api";
    renderer.node("connection-from").listeners.get("change")();
    assert.equal(renderer.node("connection-to").value, "");
    renderer.node("connection-to").value = "queue";
    const saving = submit();
    assert.equal(renderer.requests[0].path, "/api/proposal/edge");
    assert.equal(renderer.requests[0].body.id, "missing");
    assert.equal(renderer.requests[0].body.from, "api");
    assert.equal(renderer.requests[0].body.to, "queue");
    renderer.respond(renderer.requests[0], { ok: true });
    await saving;
    assert.equal(renderer.node("connection-dialog").open, false);

    const confirmed = await createRenderer({ ...initial, confirmed: true }, { renderPlan: true });
    assert.equal(confirmed.node("connections-unplaced-list").querySelectorAll("li").length, 2);
    assert.equal(confirmed.node("connections-unplaced-list").querySelector("button"), null);
    assert.match(confirmed.node("connections-unplaced-list").textContent, /not included in the confirmed proposal/);
});

test("confirmation counts exclude stale endpoint IDs even when their old names still exist", async () => {
    const renderer = await createRenderer(graphReview(["api", "cache"], [
        { id: "stale", from: "api", to: "cache", fromId: "api", toId: "gone", kind: "reference" },
    ]), { renderPlan: true });
    assert.match(renderer.node("status-line").textContent, /0 connections/);
    assert.match(renderer.evaluate("confirmationSummaryText()"), /0 connections/);
    assert.match(renderer.node("connections-unplaced-list").textContent, /omitted on confirmation unless repaired/);
});

test("an unplaced connection can be removed even when too few resources are included to repair it", async () => {
    const renderer = await createRenderer(graphReview(["api"], [
        { id: "missing", from: "api", to: "gone", kind: "reference" },
    ]), { renderPlan: true });
    renderer.node("connections-unplaced-list").querySelector("button").listeners.get("click")();
    assert.equal(renderer.node("connection-dialog").open, true);
    assert.equal(renderer.node("save-connection").disabled, true);
    renderer.node("delete-connection").listeners.get("click")();
    assert.equal(renderer.node("remove-dialog").open, true);
    const removing = renderer.node("remove-form").listeners.get("submit")({ preventDefault() {} });
    assert.equal(renderer.requests[0].path, "/api/proposal/edge/delete");
    assert.equal(renderer.requests[0].body.id, "missing");
    renderer.respond(renderer.requests[0], { ok: true });
    await removing;
    assert.equal(renderer.node("connection-dialog").open, false);
    assert.equal(renderer.node("remove-dialog").open, false);
});

test("empty, disconnected, and excluded resources do not invent nodes or connections", async () => {
    const empty = await createRenderer(graphReview([], [], {
        validation: { issues: ["Include at least one resource."], resourceIssues: {} },
    }), { renderPlan: true });
    assert.equal(empty.nodes().length, 0);
    assert.match(empty.node("topology-state").textContent, /No resources/);
    assert.equal(empty.node("topology-surface").hidden, true);
    assert.equal(empty.node("confirm").disabled, true);
    assert.equal(empty.node("compact-add-resource").hidden, false);

    const initial = graphReview(["api"], [{ id: "unknown", from: "api", to: "missing", kind: "reference" }]);
    initial.proposal.resources.push({ id: "missing", name: "missing", type: "Container", include: false });
    const disconnected = await createRenderer(initial, { renderPlan: true });
    assert.equal(disconnected.nodes().length, 1);
    assert.match(disconnected.nodes()[0].textContent, /Unplaced connection/);
    assert.match(disconnected.node("connections-unplaced-list").textContent, /not found or excluded/);
    assert.equal(disconnected.paths().length, 0);
    assert.equal(disconnected.requests.length, 0);
});

test("connection paths preserve direction and separate parallel links", async () => {
    const renderer = await createRenderer(graphReview(), { renderPlan: true });
    const horizontal = renderer.evaluate(`topologyConnectionPath(
        {left:0, top:0, right:100, bottom:50, width:100, height:50},
        {left:200, top:0, right:300, bottom:50, width:100, height:50},
        {left:0, top:0}, 0)`);
    assert.equal(horizontal, "M 100 25 C 150 25, 150 25, 200 25");
    const parallel = renderer.evaluate(`topologyConnectionPath(
        {left:0, top:0, right:100, bottom:50, width:100, height:50},
        {left:200, top:0, right:300, bottom:50, width:100, height:50},
        {left:0, top:0}, 5)`);
    assert.notEqual(parallel, horizontal);
    const reverse = renderer.evaluate(`topologyConnectionPath(
        {left:200, top:0, right:300, bottom:50, width:100, height:50},
        {left:0, top:0, right:100, bottom:50, width:100, height:50},
        {left:0, top:0}, 0)`);
    assert.equal(reverse, "M 200 25 C 150 25, 150 25, 100 25");
    const self = renderer.evaluate(`topologyConnectionPath(
        {left:0, top:0, right:100, bottom:50, width:100, height:50},
        {left:0, top:0, right:100, bottom:50, width:100, height:50},
        {left:0, top:0}, 0, true)`);
    assert.match(self, /^M 100 20 C 152 /);
});

test("connections sharing an endpoint use distinct attachment positions", async () => {
    const renderer = await createRenderer(graphReview(["api", "worker", "db"], [
        { id: "api-db", from: "api", to: "db", kind: "reference" },
        { id: "worker-db", from: "worker", to: "db", kind: "waitFor" },
    ]), { renderPlan: true });
    renderer.node("topology-surface").bounds = { left: 0, top: 0, width: 400, height: 300 };
    const bounds = {
        api: { left: 0, right: 100, top: 0, bottom: 50, width: 100, height: 50 },
        worker: { left: 0, right: 100, top: 100, bottom: 150, width: 100, height: 50 },
        db: { left: 200, right: 300, top: 50, bottom: 100, width: 100, height: 50 },
    };
    for (const node of renderer.nodes()) node.bounds = bounds[node.dataset.resourceId];
    renderer.evaluate("drawTopologyConnections()");
    const endpoints = renderer.paths().map((path) => path.getAttribute("d").match(/, (\d+) (\d+)$/)[2]);
    assert.equal(new Set(endpoints).size, 2);
});
