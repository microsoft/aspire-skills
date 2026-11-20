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

async function createRenderer(initialSnapshot, { renderPlan = false } = {}) {
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
    if (!renderPlan) {
        // Restart-only tests do not need the resource graph DOM.
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
        switchView(view) {
            node(view === "tree" ? "connections-tree-view" : "resources-view").listeners.get("click")();
        },
        treeItems() { return node("connections-tree").querySelectorAll("[role='treeitem']"); },
        press(key, target = dom.document.activeElement, { prevented: expected = true, ...modifiers } = {}) {
            let prevented = false;
            node("connections-tree").listeners.get("keydown")({
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

test("the view switch preserves the existing overview, inspector, relationship list, and snapshot", async () => {
    const renderer = await createRenderer(graphReview(), { renderPlan: true });
    const before = renderer.evaluate("JSON.stringify(snapshot)");
    const confirmation = renderer.node("confirm").disabled;
    assert.equal(renderer.node("plan-overview").querySelectorAll(".overview-node").length, 4);
    assert.match(renderer.node("plan-inspector").textContent, /api/);
    assert.equal(renderer.node("relationship-list").children.length, 2);

    renderer.switchView("tree");
    assert.equal(renderer.node("resource-details-view").hidden, true);
    assert.equal(renderer.node("connections-tree-panel").hidden, false);
    assert.equal(renderer.node("connections-tree-view").getAttribute("aria-pressed"), "true");
    assert.deepEqual(renderer.treeItems().map((item) => item.dataset.resourceId), ["api", "worker", "isolated"]);
    assert.match(renderer.treeItems()[2].textContent, /No connections/);
    assert.match(renderer.treeItems()[0].textContent, /apiContainer/);
    renderer.switchView("resources");

    assert.equal(renderer.node("connections-tree-panel").hidden, true);
    assert.equal(renderer.node("resource-details-view").hidden, false);
    assert.equal(renderer.node("resources-view").getAttribute("aria-pressed"), "true");
    assert.equal(renderer.node("plan-overview").querySelectorAll(".overview-node").length, 4);
    assert.equal(renderer.node("relationship-list").children.length, 2);
    assert.equal(renderer.node("confirm").disabled, confirmation);
    assert.equal(renderer.evaluate("JSON.stringify(snapshot)"), before);
    assert.equal(renderer.requests.length, 0);
});

test("tree keyboard navigation expands, collapses, follows shared references, and maintains one tab stop", async () => {
    const renderer = await createRenderer(graphReview(), { renderPlan: true });
    renderer.switchView("tree");
    const first = renderer.treeItems()[0];
    first.focus();
    assert.equal(first.getAttribute("aria-expanded"), "false");
    renderer.press("ArrowRight");
    assert.equal(renderer.treeItems()[0].getAttribute("aria-expanded"), "true");
    assert.equal(renderer.treeItems().length, 4);
    const child = renderer.treeItems()[1];
    assert.equal(child.parentElement.getAttribute("role"), "group");
    assert.equal(child.parentElement.closest("[role='treeitem']"), renderer.treeItems()[0]);
    assert.equal(renderer.treeItems()[0].parentElement, renderer.node("connections-tree"));
    renderer.press("ArrowRight");
    assert.equal(renderer.document.activeElement.dataset.resourceId, "db");
    assert.match(renderer.document.activeElement.getAttribute("aria-label"), /api → references db/);
    assert.equal(renderer.document.activeElement.getAttribute("aria-expanded"), null);
    renderer.press("ArrowLeft");
    assert.equal(renderer.document.activeElement.dataset.resourceId, "api");
    renderer.press("ArrowLeft");
    assert.equal(renderer.treeItems().length, 3);
    renderer.press(" ");
    renderer.press("ArrowDown");
    assert.equal(renderer.document.activeElement.dataset.resourceId, "db");
    renderer.press("ArrowUp");
    assert.equal(renderer.document.activeElement.dataset.resourceId, "api");
    renderer.press("End");
    assert.equal(renderer.document.activeElement.dataset.resourceId, "isolated");
    renderer.press("ArrowDown");
    assert.equal(renderer.document.activeElement.dataset.resourceId, "isolated");
    renderer.press("Home");
    renderer.press("ArrowUp");
    assert.equal(renderer.document.activeElement.dataset.resourceId, "api");
    renderer.press("ArrowLeft");
    renderer.press("w");
    assert.equal(renderer.document.activeElement.dataset.resourceId, "worker");
    renderer.press("Enter");
    renderer.press("ArrowRight");
    assert.match(renderer.document.activeElement.getAttribute("aria-label"), /worker → waits for db.*Shared reference/);
    assert.equal(renderer.document.activeElement.getAttribute("aria-expanded"), null);
    renderer.press("Enter");
    assert.match(renderer.document.activeElement.getAttribute("aria-label"), /api → references db/);
    assert.equal(renderer.treeItems()[0].getAttribute("aria-expanded"), "true");
    assert.equal(renderer.treeItems().filter((item) => item.tabIndex === 0).length, 1);
    assert.equal(renderer.requests.length, 0);
});

test("cycle references are terminal and pointer activation uses the same expand and follow behavior", async () => {
    const renderer = await createRenderer(graphReview(["api", "db"], [
        { id: "api-db", from: "api", to: "db", kind: "reference" },
        { id: "db-api", from: "db", to: "api", kind: "parent" },
    ]), { renderPlan: true });
    assert.equal(renderer.node("compact-resources").children.length, 2);
    renderer.switchView("tree");
    const clickRow = (item) => item.querySelector(".connection-tree-row").listeners.get("click")();
    clickRow(renderer.treeItems()[0]);
    clickRow(renderer.treeItems()[1]);
    const cycle = renderer.treeItems()[2];
    assert.match(cycle.getAttribute("aria-label"), /db → child of api.*Cycle reference/);
    assert.equal(cycle.getAttribute("aria-expanded"), null);
    assert.equal(cycle.querySelectorAll("[role='group']").length, 0);
    cycle.focus();
    renderer.press("ArrowRight");
    assert.equal(renderer.treeItems().length, 3);
    clickRow(cycle);
    assert.equal(renderer.document.activeElement, renderer.treeItems()[0]);
    assert.equal(renderer.requests.length, 0);
});

test("view, expansion, and stable resource focus survive snapshot rerenders and resource renames", async () => {
    const initial = graphReview();
    const renderer = await createRenderer(initial, { renderPlan: true });
    renderer.switchView("tree");
    renderer.treeItems()[0].focus();
    renderer.press("ArrowRight");
    renderer.press("ArrowRight");
    const next = structuredClone(initial);
    next.revision++;
    next.proposal.resources.find((resource) => resource.id === "db").name = "storage";
    next.proposal.edges.forEach((edge) => { edge.to = "storage"; });
    renderer.pushSnapshot(next);
    assert.equal(renderer.node("connections-tree-panel").hidden, false);
    assert.equal(renderer.treeItems()[0].getAttribute("aria-expanded"), "true");
    assert.equal(renderer.document.activeElement.dataset.resourceId, "db");
    assert.match(renderer.document.activeElement.getAttribute("aria-label"), /storage/);
    renderer.switchView("resources");
    renderer.switchView("tree");
    assert.equal(renderer.treeItems()[0].getAttribute("aria-expanded"), "true");
    renderer.pushSnapshot({ ...next, appHostPath: targetB, revision: 1 });
    assert.equal(renderer.node("resource-details-view").hidden, false);
    renderer.switchView("tree");
    assert.equal(renderer.treeItems()[0].getAttribute("aria-expanded"), "false");
    assert.equal(renderer.requests.length, 0);
});

test("switching views alone keeps field drafts and confirmation eligibility unchanged", async () => {
    const renderer = await createRenderer(graphReview(["api"], []), { renderPlan: true });
    const nameInput = renderer.document.querySelectorAll("input")
        .find((input) => input.getAttribute("aria-label") === "Resource name for api");
    nameInput.value = "invalid name";
    nameInput.listeners.get("input")();
    assert.equal(renderer.node("confirm").disabled, true);
    const note = renderer.node("footer-note").textContent;
    renderer.switchView("tree");
    assert.equal(renderer.node("confirm").disabled, true);
    assert.equal(renderer.node("footer-note").textContent, note);
    renderer.switchView("resources");
    assert.equal(renderer.document.querySelectorAll("input")
        .find((input) => input.getAttribute("aria-label") === "Resource name for api").value, "invalid name");
    assert.equal(renderer.evaluate("snapshot.proposal.resources[0].name"), "api");
    assert.equal(renderer.requests.length, 0);
});

test("tree focus and Resources selection stay synchronized in both directions", async () => {
    const renderer = await createRenderer(graphReview(), { renderPlan: true });
    renderer.switchView("tree");
    renderer.treeItems()[0].focus();
    renderer.press("ArrowRight");
    renderer.press("ArrowRight");
    renderer.switchView("resources");
    assert.equal(renderer.evaluate("selectedResourceId"), "db");
    assert.match(renderer.node("plan-inspector").textContent, /db/);
    renderer.evaluate('selectResource("worker", "navigate")');
    renderer.switchView("tree");
    assert.equal(renderer.treeItems().find((item) => item.tabIndex === 0).dataset.resourceId, "worker");
    renderer.switchView("resources");
    renderer.evaluate('selectResource("db", "navigate")');
    renderer.evaluate("expandedTreeKeys.clear()");
    renderer.switchView("tree");
    assert.equal(renderer.treeItems()[0].getAttribute("aria-expanded"), "true");
    assert.equal(renderer.treeItems().find((item) => item.tabIndex === 0).dataset.resourceId, "db");
    assert.equal(renderer.requests.length, 0);
});

test("removing the focused resource restores focus to the first tree item with one tab stop", async () => {
    const initial = graphReview();
    const renderer = await createRenderer(initial, { renderPlan: true });
    renderer.switchView("tree");
    renderer.treeItems()[0].focus();
    renderer.press("ArrowRight");
    renderer.press("ArrowRight");
    const next = structuredClone(initial);
    next.revision++;
    next.proposal.resources = next.proposal.resources.filter((resource) => resource.id !== "db");
    next.proposal.edges = [];
    renderer.pushSnapshot(next);
    assert.equal(renderer.document.activeElement, renderer.treeItems()[0]);
    assert.equal(renderer.treeItems().filter((item) => item.tabIndex === 0).length, 1);
    assert.equal(renderer.evaluate("selectedResourceId"), "api");
});

test("Tab and modified keys pass through the tree without preventing browser shortcuts", async () => {
    const renderer = await createRenderer(graphReview(), { renderPlan: true });
    renderer.switchView("tree");
    renderer.treeItems()[0].focus();
    const first = renderer.document.activeElement;
    renderer.press("Tab", first, { prevented: false });
    renderer.press("Tab", first, { prevented: false, shiftKey: true });
    for (const modifier of ["ctrlKey", "altKey", "metaKey"]) {
        renderer.press("ArrowDown", first, { prevented: false, [modifier]: true });
        renderer.press("w", first, { prevented: false, [modifier]: true });
    }
    assert.equal(renderer.document.activeElement, first);
    assert.equal(renderer.treeItems()[0].getAttribute("aria-expanded"), "false");
});

test("resource connections and tree targets use endpoint IDs when names collide", async () => {
    const initial = graphReview(["api", "cache-a", "cache-b"], [
        { id: "api-cache", from: "api", to: "cache", fromId: "api", toId: "cache-a", kind: "reference" },
    ]);
    initial.proposal.resources.slice(1).forEach((resource) => { resource.name = "cache"; });
    const renderer = await createRenderer(initial, { renderPlan: true });
    renderer.evaluate('selectResource("cache-b", "navigate")');
    assert.equal(renderer.node("plan-inspector").querySelectorAll(".connection-chip").length, 0);
    renderer.evaluate('selectResource("cache-a", "navigate")');
    assert.equal(renderer.node("plan-inspector").querySelectorAll(".connection-chip").length, 1);
    renderer.switchView("tree");
    assert.equal(renderer.treeItems()[1].dataset.resourceId, "cache-a");
    assert.match(renderer.treeItems()[2].textContent, /No connections/);
});

test("switching during a pending resource save does not unblock confirmation or submit another mutation", async () => {
    const initial = graphReview(["api"], []);
    const renderer = await createRenderer(initial, { renderPlan: true });
    const nameInput = renderer.document.querySelectorAll("input")
        .find((input) => input.getAttribute("aria-label") === "Resource name for api");
    nameInput.value = "renamed-api";
    nameInput.listeners.get("input")();
    nameInput.listeners.get("change")();
    assert.equal(renderer.requests.length, 1);
    renderer.switchView("tree");
    assert.equal(renderer.node("confirm").disabled, true);
    assert.equal(renderer.requests.length, 1);
    assert.equal(renderer.evaluate("snapshot.proposal.resources[0].name"), "api");
    const next = structuredClone(initial);
    next.revision++;
    next.proposal.resources[0].name = "renamed-api";
    renderer.pushSnapshot(next);
    renderer.respond(renderer.requests[0], { ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(renderer.node("confirm").disabled, false);
    assert.match(renderer.treeItems()[0].getAttribute("aria-label"), /renamed-api/);
});

test("a failed confirmation remains retryable with the same error after switching views", async () => {
    const renderer = await createRenderer(graphReview(), { renderPlan: true });
    renderer.node("confirm").listeners.get("click")();
    renderer.respond(renderer.requests[0], { error: "Host approval was declined." }, 403);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(renderer.node("footer-note").textContent, "Host approval was declined.");
    assert.equal(renderer.node("confirm").disabled, false);
    renderer.switchView("tree");
    assert.equal(renderer.node("footer-note").textContent, "Host approval was declined.");
    assert.equal(renderer.node("confirm").disabled, false);
    assert.equal(renderer.evaluate("snapshot.confirmed"), false);
    assert.equal(renderer.requests.length, 1);
});

for (const view of ["resources", "tree"]) {
    test(`confirmation from ${view} sends the unchanged snapshot identity and stays immutable`, async () => {
        const initial = graphReview();
        const renderer = await createRenderer(initial, { renderPlan: true });
        renderer.switchView(view);
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
        renderer.switchView("tree");
        renderer.treeItems()[0].focus();
        renderer.press("ArrowRight");
        renderer.switchView("resources");
        assert.equal(renderer.node("plan-inspector").hidden, true);
        assert.equal(renderer.node("compact-add-resource").hidden, true);
        assert.ok(renderer.node("plan-overview").querySelectorAll(".overview-node")
            .every((node) => node.tagName === "div"));
        assert.equal(renderer.node("confirm").disabled, true);
        assert.equal(renderer.node("action-footer").hidden, true);
        assert.equal(renderer.evaluate("JSON.stringify(snapshot.proposal)"), proposal);
        assert.equal(renderer.requests.length, 1);
    });
}

test("an already-confirmed snapshot can be explored in the tree and retry the same chat handoff", async () => {
    const initial = graphReview(["api"], [], { confirmed: true, confirmedGeneration: 1 });
    const renderer = await createRenderer(initial, { renderPlan: true });
    renderer.switchView("tree");
    const before = renderer.evaluate("JSON.stringify(snapshot)");
    renderer.treeItems()[0].focus();
    renderer.press("Enter");
    assert.equal(renderer.node("confirm").textContent, "Notify chat");
    assert.equal(renderer.node("confirm").disabled, false);
    assert.equal(renderer.evaluate("JSON.stringify(snapshot)"), before);
    renderer.node("confirm").listeners.get("click")();
    assert.equal(renderer.requests[0].path, "/api/confirm");
    assert.equal(renderer.requests[0].body.expectedProposalHash, initial.proposalHash);
    renderer.pushSnapshot({ ...initial, revision: 5, confirmationDelivered: true });
    renderer.respond(renderer.requests[0], { confirmed: true, delivered: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(renderer.node("connections-tree-panel").hidden, false);
    assert.equal(renderer.node("confirm").disabled, true);
});

test("a delivered immutable confirmation stays delivered when opened and explored in either view", async () => {
    const renderer = await createRenderer(graphReview(undefined, undefined, {
        confirmed: true, confirmedGeneration: 1, confirmationDelivered: true,
    }), { renderPlan: true });
    const before = renderer.evaluate("JSON.stringify(snapshot)");
    renderer.switchView("tree");
    renderer.treeItems()[0].focus();
    renderer.press("Enter");
    renderer.press("ArrowRight");
    renderer.switchView("resources");
    renderer.switchView("tree");
    assert.equal(renderer.node("confirm").disabled, true);
    assert.equal(renderer.node("action-footer").hidden, true);
    assert.equal(renderer.evaluate("JSON.stringify(snapshot)"), before);
    assert.equal(renderer.requests.length, 0);
});

test("empty and no-connection trees are clear and excluded resources or dangling edges are not inferred", async () => {
    const empty = await createRenderer(graphReview([], [], {
        validation: { issues: ["Include at least one resource."], resourceIssues: {} },
    }), { renderPlan: true });
    empty.switchView("tree");
    assert.equal(empty.treeItems().length, 0);
    assert.match(empty.node("connections-tree-state").textContent, /No resources/);
    assert.equal(empty.node("connections-tree").hidden, true);
    assert.equal(empty.node("confirm").disabled, true);

    const initial = graphReview(["api"], [{ id: "unknown", from: "api", to: "missing", kind: "reference" }]);
    initial.proposal.resources.push({ id: "missing", name: "missing", type: "Container", include: false });
    const disconnected = await createRenderer(initial, { renderPlan: true });
    disconnected.switchView("tree");
    assert.equal(disconnected.treeItems().length, 1);
    assert.match(disconnected.node("connections-tree-state").textContent, /No connections/);
    assert.match(disconnected.treeItems()[0].textContent, /No connections/);
    assert.equal(disconnected.requests.length, 0);
});
