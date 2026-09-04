"use strict";

import {
    classifyAspireResourceKind,
    classifyServiceKind,
    isCompatibleAspireResourceKind,
    isCompatibleAspireResourceType,
    isDotNetType,
} from "./resource-types.js";

const apiToken = new URLSearchParams(window.location.search).get("token") || "";

const EDGE_LABELS = {
    reference: { outgoing: "references", incoming: "referenced by", tone: "reference" },
    waitFor: { outgoing: "waits for", incoming: "unblocks", tone: "wait" },
    parent: { outgoing: "child of", incoming: "parent of", tone: "parent" },
};

const RESOURCE_GROUPS = [
    {
        id: "applications",
        title: "Applications",
        description: "Runnable services managed by the AppHost.",
        addTitle: "Add application",
        addDescription: "Add another runnable service to the AppHost plan.",
        kinds: new Set(["project", "frontend"]),
    },
    {
        id: "data",
        title: "Data & messaging",
        description: "Stateful services, caches, and message brokers.",
        addTitle: "Add data or messaging resource",
        addDescription: "Add a database, cache, or message broker.",
        kinds: new Set(["database", "cache", "broker"]),
    },
    {
        id: "infrastructure",
        title: "Infrastructure",
        description: "Containers and supporting runtime resources.",
        addTitle: "Add infrastructure",
        addDescription: "Add a container or supporting runtime resource.",
        kinds: new Set(["container"]),
    },
    {
        id: "external",
        title: "External dependencies",
        description: "Resources represented in the plan but hosted elsewhere.",
        addTitle: "Add external dependency",
        addDescription: "Add a service represented in the plan but hosted elsewhere.",
        kinds: new Set(["external"]),
    },
];

const elements = {
    body: document.body,
    statusLine: document.getElementById("status-line"),
    apphostControl: document.getElementById("apphost-control"),
    apphostPath: document.getElementById("apphost-path"),
    apphostValue: document.getElementById("apphost-value"),
    skeleton: document.getElementById("skeleton"),
    snapshot: document.getElementById("snapshot"),
    planContent: document.getElementById("plan-content"),
    resourcePlanPanel: document.getElementById("resource-plan-panel"),
    compactResources: document.getElementById("compact-resources"),
    compactAddResource: document.getElementById("compact-add-resource"),
    relationshipWorkspace: document.getElementById("relationship-workspace"),
    planOverview: document.getElementById("plan-overview"),
    planInspector: document.getElementById("plan-inspector"),
    relationshipListDisclosure: document.getElementById("relationship-list-disclosure"),
    relationshipListSummary: document.getElementById("relationship-list-summary"),
    relationshipList: document.getElementById("relationship-list"),
    proposalStateCopy: document.getElementById("proposal-state-copy"),
    proposalGeneratedAt: document.getElementById("proposal-generated-at"),
    proposalGeneration: document.getElementById("proposal-generation"),
    proposalHash: document.getElementById("proposal-hash"),
    actionFooter: document.getElementById("action-footer"),
    undo: document.getElementById("undo"),
    redo: document.getElementById("redo"),
    confirmSummary: document.getElementById("confirm-summary"),
    footerNote: document.getElementById("footer-note"),
    historyAnnouncement: document.getElementById("history-announcement"),
    confirm: document.getElementById("confirm"),
    error: document.getElementById("error"),
    errorMessage: document.getElementById("error-message"),
    retry: document.getElementById("retry"),
    addResourceDialog: document.getElementById("add-resource-dialog"),
    addResourceDialogError: document.getElementById("add-resource-dialog-error"),
    addResourceForm: document.getElementById("add-resource-form"),
    addResourceDialogTitle: document.getElementById("add-resource-dialog-title"),
    addResourceDialogDetail: document.getElementById("add-resource-dialog-detail"),
    addResourceGroup: document.getElementById("add-resource-group"),
    addResourceName: document.getElementById("add-resource-name"),
    addResourceType: document.getElementById("add-resource-type"),
    addResourceDetail: document.getElementById("add-resource-detail"),
    addDefaultsField: document.getElementById("add-defaults-field"),
    addResourceDefaults: document.getElementById("add-resource-defaults"),
    addResourceConnections: document.getElementById("add-resource-connections"),
    addResourceConnectionRow: document.getElementById("add-resource-connection-row"),
    connectionDialog: document.getElementById("connection-dialog"),
    connectionDialogError: document.getElementById("connection-dialog-error"),
    connectionForm: document.getElementById("connection-form"),
    connectionDialogTitle: document.getElementById("connection-dialog-title"),
    connectionId: document.getElementById("connection-id"),
    connectionFrom: document.getElementById("connection-from"),
    connectionKind: document.getElementById("connection-kind"),
    connectionTo: document.getElementById("connection-to"),
    resetConnection: document.getElementById("reset-connection"),
    deleteConnection: document.getElementById("delete-connection"),
    removeDialog: document.getElementById("remove-dialog"),
    removeForm: document.getElementById("remove-form"),
    removeDialogTitle: document.getElementById("remove-dialog-title"),
    removeDialogDetail: document.getElementById("remove-dialog-detail"),
    removeDialogError: document.getElementById("remove-dialog-error"),
    confirmRemove: document.getElementById("confirm-remove"),
};

let snapshot;
let firstRender = true;
let pendingMutations = 0;
let mutationError = "";
let connectionRowSequence = 0;
let pendingRemoval;
let eventsConnected = false;
let activeViewTransition;
let selectedResourceId = "";
const fieldDrafts = new Map();
const detailTextareaWidths = new WeakMap();
const detailResizeObserver =
    typeof ResizeObserver === "function"
        ? new ResizeObserver((entries) => {
              for (const entry of entries) {
                  if (detailTextareaWidths.get(entry.target) === entry.contentRect.width) {
                      continue;
                  }
                  detailTextareaWidths.set(entry.target, entry.contentRect.width);
                  syncDetailTextareaHeight(entry.target);
              }
          })
        : null;
document.addEventListener("DOMContentLoaded", () => {
    elements.retry.addEventListener("click", () => void retryProposalOrSnapshot());
    elements.confirm.addEventListener("click", () => void confirmSnapshot());
    elements.undo.addEventListener("click", () => void applyHistoryChange("undo", elements.undo));
    elements.redo.addEventListener("click", () => void applyHistoryChange("redo", elements.redo));
    elements.compactAddResource.addEventListener("click", () => openAddResourceDialog("all"));
    elements.addResourceForm.addEventListener("submit", addResource);
    elements.addResourceType.addEventListener("change", () => {
        elements.addResourceType.setCustomValidity("");
        if (elements.addResourceDialogError.textContent === "Choose a resource type.") {
            clearDialogError(elements.addResourceDialogError);
        }
        syncDefaultsField(
            elements.addResourceType,
            elements.addDefaultsField,
            elements.addResourceDefaults,
        );
    });
    elements.addResourceName.addEventListener("input", () =>
        validateResourceNameField(
            elements.addResourceName,
            "",
            elements.addResourceDialogError,
        ),
    );
    elements.addResourceConnectionRow.addEventListener("click", () =>
        addResourceConnectionRow(),
    );
    elements.connectionForm.addEventListener("submit", saveConnection);
    elements.connectionFrom.addEventListener("change", () => syncConnectionTargets());
    elements.resetConnection.addEventListener("click", () => void resetConnection());
    elements.deleteConnection.addEventListener("click", requestDeleteConnection);
    elements.removeForm.addEventListener("submit", executeRemoval);
    elements.removeDialog.addEventListener("close", () => {
        pendingRemoval = undefined;
    });
    for (const button of document.querySelectorAll("[data-close-dialog]")) {
        button.addEventListener("click", () => button.closest("dialog")?.close());
    }
    window.addEventListener("resize", () => resizeVisibleDetailTextareas());
    window.addEventListener("keydown", handleHistoryShortcut);
    void loadSnapshot();
    connectEvents();
});

function updateAppHostValue() {
    const fullPath = String(snapshot?.appHostPath ?? "").trim();
    elements.apphostPath.textContent = appHostPathForDisplay(fullPath);
    elements.apphostPath.title = fullPath;
    elements.apphostValue.textContent =
        {
            "csharp-sdk": "C# SDK",
            "csharp-file": "File-based C#",
            typescript: "TypeScript",
        }[snapshot?.apphostStyle] ?? "Unknown";
}

function appHostPathForDisplay(path) {
    const normalized = String(path ?? "").trim().replace(/\\/g, "/");
    if (!normalized) {
        return "Path unavailable";
    }
    if (/^(?:[A-Za-z]:\/|\/)/.test(normalized)) {
        return normalized.split("/").filter(Boolean).slice(-3).join("/");
    }
    return normalized.replace(/^\.\//, "");
}

function setStatusLine(message) {
    elements.statusLine.textContent = message;
    elements.statusLine.title = message;
}

async function loadSnapshot() {
    showLoading();
    try {
        await refreshSnapshot(true);
    } catch (error) {
        showError(error);
    }
}

async function refreshSnapshot(throwOnError = false) {
    try {
        const response = await fetch("/api/snapshot", {
            headers: { "X-Aspireify-Token": apiToken },
        });
        if (!response.ok) {
            throw new Error(`Snapshot request failed (${response.status}).`);
        }
        render(await response.json());
    } catch (error) {
        if (throwOnError) {
            throw error;
        }
    }
}

function connectEvents() {
    let events;
    let fallbackPolling;
    try {
        events = new EventSource(`/events?token=${encodeURIComponent(apiToken)}`);
    } catch {
        void refreshSnapshot();
        fallbackPolling = setInterval(() => void refreshSnapshot(), 2000);
        return;
    }
    events.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            if (message.type === "snapshot") {
                render(message.snapshot);
            }
        } catch {
            return;
        }
    };
    events.onopen = () => {
        eventsConnected = true;
        clearInterval(fallbackPolling);
        fallbackPolling = undefined;
    };
    events.onerror = () => {
        eventsConnected = false;
        void refreshSnapshot();
        fallbackPolling ??= setInterval(() => void refreshSnapshot(), 2000);
    };
}

async function post(path, body) {
    const previousRevision = snapshot?.revision ?? -1;
    const response = await fetch(path, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Aspireify-Token": apiToken,
        },
        body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload.error ?? "The canvas action failed.");
    }
    if (
        !eventsConnected ||
        !(await waitForRevisionAfter(previousRevision, 250))
    ) {
        await refreshSnapshot();
    }
    return payload;
}

async function waitForRevisionAfter(revision, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if ((snapshot?.revision ?? -1) > revision) {
            return true;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 16));
    }
    return (snapshot?.revision ?? -1) > revision;
}

async function runBusy(control, action, onError) {
    const blocksConfirmation = control !== elements.confirm;
    if (blocksConfirmation) {
        pendingMutations += 1;
        if (snapshot?.proposal) {
            renderConfirmation();
        }
    }
    elements.body.classList.add("is-busy");
    if (control) {
        control.disabled = true;
    }
    let succeeded = false;
    try {
        await action();
        succeeded = true;
        mutationError = "";
    } catch (error) {
        onError?.(error);
        showInlineError(error);
    } finally {
        elements.body.classList.remove("is-busy");
        if (control) {
            if (control === elements.confirm) {
                control.disabled =
                    !snapshot?.proposalLoaded ||
                    snapshot?.proposalStale ||
                    confirmationIssues().length > 0 ||
                    snapshot?.confirmed ||
                    pendingMutations > 0;
            } else {
                control.disabled = false;
            }
        }
        if (blocksConfirmation) {
            pendingMutations -= 1;
            if (snapshot?.proposal) {
                renderConfirmation();
            }
        }
    }
    return succeeded;
}

function historyChangeBlocked() {
    return (
        !snapshot?.proposalLoaded ||
        snapshot.proposalStale ||
        snapshot.confirmed ||
        pendingMutations > 0 ||
        fieldDrafts.size > 0
    );
}

async function applyHistoryChange(direction, control) {
    if (historyChangeBlocked() || !snapshot?.history?.[`can${direction === "undo" ? "Undo" : "Redo"}`]) {
        return;
    }
    let label = "";
    const changed = await runBusy(control, async () => {
        const result = await post(`/api/history/${direction}`, {});
        label = result.label ?? "";
    });
    if (changed) {
        elements.historyAnnouncement.textContent = `${
            direction === "undo" ? "Undid" : "Redid"
        } ${label || "proposal change"}.`;
    }
}

function handleHistoryShortcut(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) {
        return;
    }
    const active = document.activeElement;
    if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement ||
        active?.isContentEditable
    ) {
        return;
    }
    const key = event.key.toLowerCase();
    const redo = key === "y" || (key === "z" && event.shiftKey);
    if (key !== "z" && key !== "y") {
        return;
    }
    event.preventDefault();
    void applyHistoryChange(redo ? "redo" : "undo", redo ? elements.redo : elements.undo);
}

async function confirmSnapshot() {
    if (pendingMutations > 0) {
        return;
    }
    const originalLabel = elements.confirm.textContent;
    await runBusy(elements.confirm, async () => {
        elements.confirm.textContent = "Confirming…";
        try {
            const result = await post("/api/confirm", {});
            if (result.confirmed) {
                snapshot = { ...snapshot, confirmed: true };
                renderStatus();
                renderConfirmation();
            }
        } catch (error) {
            elements.confirm.textContent = originalLabel;
            throw error;
        }
    });
}

async function retryProposalOrSnapshot() {
    if (snapshot?.proposalError && snapshot.discoveryLoaded) {
        elements.retry.disabled = true;
        try {
            await post("/api/proposal/request", {});
        } catch (error) {
            showProposalError(error?.message ?? error);
        } finally {
            elements.retry.disabled = false;
        }
        return;
    }
    await loadSnapshot();
}

function snapshotRevisionIsStale(nextSnapshot) {
    return (
        !firstRender &&
        Number.isInteger(nextSnapshot?.revision) &&
        Number.isInteger(snapshot?.revision) &&
        nextSnapshot.revision <= snapshot.revision
    );
}

function render(nextSnapshot) {
    if (snapshotRevisionIsStale(nextSnapshot)) {
        return;
    }
    const focusToken = captureFocusToken();
    const draw = () => {
        if (snapshotRevisionIsStale(nextSnapshot)) {
            return;
        }
        unobserveDetailTextareas();
        mutationError = "";
        snapshot = nextSnapshot;
        reconcileFieldDrafts();
        if (snapshot.proposalError) {
            showProposalError(snapshot.proposalError);
            firstRender = false;
            return;
        }
        if (!snapshot.proposalLoaded || snapshot.proposalStale) {
            showProposalPending();
            firstRender = false;
            return;
        }

        elements.body.classList.remove("is-loading", "is-busy");
        elements.body.classList.add("has-data");
        elements.skeleton.hidden = true;
        elements.error.hidden = true;
        elements.snapshot.hidden = false;
        elements.actionFooter.hidden = snapshot.confirmed;
        elements.apphostControl.hidden = !snapshot.apphostStyle;
        elements.body.classList.toggle("is-confirmed", snapshot.confirmed);
        updateAppHostValue();
        elements.planContent.hidden = false;
        renderProposalIdentity();
        renderResourcePlan();
        renderStatus();
        renderConfirmation();
        restoreFocusToken(focusToken);
        firstRender = false;
    };

    const prefersReducedMotion = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
    ).matches;
    if (
        !firstRender &&
        !prefersReducedMotion &&
        typeof document.startViewTransition === "function" &&
        !activeViewTransition
    ) {
        activeViewTransition = document.startViewTransition(draw);
        void activeViewTransition.finished
            .catch(() => {})
            .finally(() => {
                activeViewTransition = undefined;
            });
    } else {
        draw();
    }
}

function renderResourcePlan() {
    const proposal = snapshot.proposal;
    const resources = proposal.resources.filter((resource) => resource.include);
    const names = new Set(resources.map((resource) => resource.name));
    const edges = proposal.edges.filter((edge) => names.has(edge.from) && names.has(edge.to));
    const resourceIssues = proposalValidation().resourceIssues;
    elements.resourcePlanPanel.hidden = false;
    elements.compactResources.replaceChildren();
    elements.planOverview.replaceChildren();
    elements.planInspector.replaceChildren();
    elements.relationshipList.replaceChildren();
    elements.relationshipWorkspace.classList.toggle("is-confirmed", snapshot.confirmed);
    const compact = (snapshot.presentationMode ?? (resources.length <= 2 ? "compact" : "relationship")) ===
        "compact";
    elements.compactResources.hidden = !compact || snapshot.confirmed;
    elements.relationshipWorkspace.hidden = compact && !snapshot.confirmed;
    elements.relationshipListDisclosure.hidden = compact && !snapshot.confirmed;
    elements.compactAddResource.hidden = snapshot.confirmed;
    if (snapshot.confirmed) {
        selectedResourceId = "";
        renderOverview(resources, edges, resourceIssues, true);
        elements.planInspector.hidden = true;
        renderRelationshipList(edges, true);
        elements.relationshipListDisclosure.open = true;
        return;
    }
    if (compact) {
        elements.relationshipWorkspace.hidden = true;
        elements.relationshipListDisclosure.hidden = true;
        if (resources.length === 0) {
            const empty = createElement("div", {
                className: "empty-proposal",
                attrs: { role: "status" },
            });
            empty.append(
                createElement("strong", { text: "No resources are included" }),
                createElement("span", {
                    className: "muted",
                    text: "Add a resource to make this proposal confirmable.",
                }),
            );
            elements.compactResources.append(empty);
        }
        for (const resource of resources) {
            elements.compactResources.append(
                renderCompactResource(resource, edges, resourceIssues[resource.id] ?? []),
            );
        }
        return;
    }

    elements.relationshipWorkspace.hidden = false;
    elements.planInspector.hidden = false;
    elements.relationshipListDisclosure.hidden = false;
    const orderedResources = resourcesInOverviewOrder(resources);
    if (!orderedResources.some((resource) => resource.id === selectedResourceId)) {
        selectedResourceId = orderedResources[0]?.id ?? "";
    }
    renderOverview(resources, edges, resourceIssues, false);
    renderInspector(
        orderedResources.find((resource) => resource.id === selectedResourceId),
        edges,
        resourceIssues,
    );
    renderRelationshipList(edges, false);
}

function resourcesInOverviewOrder(resources) {
    return RESOURCE_GROUPS.flatMap((definition) =>
        resources.filter((resource) => resourceRole(resource) === definition.id),
    );
}

function resourceRole(resource) {
    const service = serviceForResource(resource);
    if (service) {
        const serviceKind = classifyServiceKind(`${service.type} ${service.framework}`);
        if (["dotnet", "node", "python"].includes(serviceKind) || service.exposesHttp) {
            return "applications";
        }
        if (serviceKind === "cache") {
            return "data";
        }
    }
    const kind = resourceKind(resource);
    if (["database", "cache", "broker"].includes(kind)) {
        return "data";
    }
    if (["project", "frontend"].includes(kind)) {
        return "applications";
    }
    if (kind === "container") {
        return "infrastructure";
    }
    return "external";
}

function renderOverview(resources, edges, resourceIssues, confirmed) {
    elements.planOverview.classList.toggle("is-confirmed", confirmed);
    for (const definition of RESOURCE_GROUPS) {
        const groupedResources = resources.filter(
            (resource) => resourceRole(resource) === definition.id,
        );
        if (groupedResources.length === 0) {
            continue;
        }
        const section = createElement("section", {
            className: `overview-role overview-role-${definition.id}`,
        });
        const heading = createElement("div", { className: "overview-role-heading" });
        const headingCopy = createElement("div");
        headingCopy.append(
            createElement("h2", { text: definition.title }),
            createElement("p", {
                className: "muted",
                text: definition.description,
            }),
        );
        heading.append(
            headingCopy,
            createElement("span", {
                className: "overview-role-count",
                text: String(groupedResources.length),
                title: `${groupedResources.length} resource${
                    groupedResources.length === 1 ? "" : "s"
                }`,
            }),
        );
        const list = createElement("div", {
            className: "overview-node-list",
        });
        for (const resource of groupedResources) {
            list.append(
                renderOverviewNode(
                    resource,
                    edges,
                    resourceIssues[resource.id] ?? [],
                    confirmed,
                ),
            );
        }
        section.append(heading, list);
        elements.planOverview.append(section);
    }
}

function renderOverviewNode(resource, edges, issues, confirmed) {
    const service = serviceForResource(resource);
    const selected = resource.id === selectedResourceId;
    const drafts = [...fieldDrafts.values()].filter(
        (draft) => draft.resourceId === resource.id,
    );
    const invalidDraft = drafts.some(
        (draft) => draft.status === "invalid" || draft.status === "error",
    );
    const tag = confirmed ? "div" : "button";
    const node = createElement(tag, {
        className: `overview-node resource-${resourceKind(resource)}${
            selected ? " is-selected" : ""
        }${issues.length || invalidDraft ? " has-issues" : ""}`,
        attrs: {
            id: overviewNodeId(resource.id),
            "data-resource-id": resource.id,
            ...(confirmed
                ? {}
                : {
                      type: "button",
                      "aria-pressed": String(selected),
                      tabindex: selected ? "0" : "-1",
                  }),
        },
    });
    const marker = createElement("span", {
        className: "overview-kind-marker",
        attrs: { "aria-hidden": "true" },
    });
    const copy = createElement("span", { className: "overview-node-copy" });
    copy.append(createResourceTitleLine(resource));
    if (service) {
        copy.append(
            createElement("span", {
                className: "overview-source muted",
                text: `${service.name} → ${resource.name}`,
            }),
        );
    }
    const relationships = relationshipsFor(resource, edges);
    const meta = createElement("span", { className: "overview-node-meta" });
    meta.append(renderConnectionCounts(relationships));
    if (drafts.length) {
        meta.append(
            createElement("span", {
                className: invalidDraft ? "overview-invalid" : "overview-edited",
                text: invalidDraft ? "Needs attention" : "Unsaved",
            }),
        );
    } else if (resource.edited) {
        meta.append(createElement("span", { className: "overview-edited", text: "Edited" }));
    }
    if (issues.length && !invalidDraft) {
        meta.append(createElement("span", { className: "overview-invalid", text: "Needs attention" }));
    }
    node.append(marker, copy, meta);
    if (!confirmed) {
        node.addEventListener("click", () => selectResource(resource.id, true));
        node.addEventListener("keydown", handleOverviewKeydown);
    }
    return node;
}

function overviewNodeId(resourceId) {
    return `overview-node-${String(resourceId).replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function renderConnectionCounts(relationships) {
    const wrap = createElement("span", { className: "connection-counts" });
    const outgoing = relationships.filter((relationship) => relationship.direction === "outgoing").length;
    const incoming = relationships.filter((relationship) => relationship.direction === "incoming").length;
    if (!outgoing && !incoming) {
        wrap.append(createElement("span", { text: "No connections" }));
        return wrap;
    }
    if (outgoing) {
        wrap.append(
            createElement("span", {
                className: "connection-count connection-count-out",
                text: `${outgoing} \u2192`,
                title: `${outgoing} outgoing connection${outgoing === 1 ? "" : "s"}`,
                attrs: {
                    "aria-label": `${outgoing} outgoing connection${outgoing === 1 ? "" : "s"}`,
                },
            }),
        );
    }
    if (incoming) {
        wrap.append(
            createElement("span", {
                className: "connection-count connection-count-in",
                text: `${incoming} \u2190`,
                title: `${incoming} incoming connection${incoming === 1 ? "" : "s"}`,
                attrs: {
                    "aria-label": `${incoming} incoming connection${incoming === 1 ? "" : "s"}`,
                },
            }),
        );
    }
    return wrap;
}

function handleOverviewKeydown(event) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        return;
    }
    event.preventDefault();
    const nodes = [...elements.planOverview.querySelectorAll(".overview-node[type='button']")];
    const currentIndex = nodes.indexOf(event.currentTarget);
    const nextIndex =
        event.key === "Home"
            ? 0
            : event.key === "End"
              ? nodes.length - 1
              : event.key === "ArrowDown"
                ? (currentIndex + 1) % nodes.length
                : (currentIndex - 1 + nodes.length) % nodes.length;
    const resourceId = nodes[nextIndex]?.dataset.resourceId;
    if (resourceId) {
        selectResource(resourceId, true);
    }
}

function selectResource(resourceId, restoreNodeFocus = false) {
    selectedResourceId = resourceId;
    renderResourcePlan();
    if (restoreNodeFocus) {
        requestAnimationFrame(() => {
            document.getElementById(overviewNodeId(resourceId))?.focus();
            if (window.matchMedia("(max-width: 719px)").matches) {
                elements.planInspector.scrollIntoView({
                    block: "start",
                    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                        ? "auto"
                        : "smooth",
                });
            }
        });
    }
}

function renderInspector(resource, edges, resourceIssues) {
    if (!resource) {
        elements.planInspector.append(
            createElement("div", {
                className: "empty-proposal",
                text: "Select a resource to review its details.",
            }),
        );
        return;
    }
    const service = serviceForResource(resource);
    const inspector = createElement("article", {
        className: `resource-inspector resource-${resourceKind(resource)}`,
    });
    const header = createElement("div", { className: "inspector-header" });
    const identity = createElement("div", { className: "inspector-identity" });
    const title = createElement("h2");
    title.append(createResourceTitleLine(resource));
    identity.append(title);
    const mapping = renderSourceMapping(resource, service);
    if (mapping) {
        identity.append(mapping);
    }
    header.append(identity, createResourceActions(resource));
    inspector.append(header);
    const issues = resourceIssues[resource.id] ?? [];
    if (issues.length) {
        inspector.append(renderResourceValidation(issues));
    }
    inspector.append(renderResourceFacts(resource, service));
    const relationships = relationshipsFor(resource, edges);
    const connectionSection = createElement("div", { className: "resource-connections" });
    connectionSection.append(createConnectionHeading(resource, true));
    if (!relationships.length) {
        connectionSection.append(
            createElement("span", {
                className: "resource-independent muted",
                text: "No direct connections",
            }),
        );
    } else {
        const chips = createElement("div", { className: "connection-chips" });
        for (const relationship of relationships) {
            chips.append(createConnectionChip(relationship));
        }
        connectionSection.append(chips);
    }
    inspector.append(connectionSection);
    elements.planInspector.append(inspector);
}

function renderRelationshipList(edges, confirmed) {
    elements.relationshipListSummary.textContent = `All relationships (${edges.length})`;
    if (!edges.length) {
        elements.relationshipList.append(
            createElement("p", { className: "muted", text: "No relationships in this proposal." }),
        );
        return;
    }
    for (const edge of edges) {
        const row = createElement(confirmed ? "div" : "button", {
            className: `relationship-row connection-${EDGE_LABELS[edge.kind]?.tone ?? "reference"}`,
            attrs: confirmed ? {} : { type: "button" },
        });
        row.append(
            createElement("strong", { text: edge.from }),
            createElement("span", {
                className: "relationship-kind",
                text: EDGE_LABELS[edge.kind]?.outgoing ?? edge.kind,
            }),
            createElement("strong", { text: edge.to }),
        );
        if (!confirmed) {
            row.addEventListener("click", () => openConnectionDialog(edge.id));
        }
        elements.relationshipList.append(row);
    }
}

function captureFocusToken() {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !active.id) {
        return null;
    }
    return {
        id: active.id,
        start:
            active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
                ? active.selectionStart
                : null,
        end:
            active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
                ? active.selectionEnd
                : null,
    };
}

function restoreFocusToken(token) {
    if (!token) {
        return;
    }
    requestAnimationFrame(() => {
        const target = document.getElementById(token.id);
        if (!(target instanceof HTMLElement)) {
            return;
        }
        target.focus({ preventScroll: true });
        if (
            (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
            token.start != null &&
            token.end != null
        ) {
            target.setSelectionRange(token.start, token.end);
        }
    });
}

function renderCompactResource(resource, edges, issues = []) {
    const service = serviceForResource(resource);
    const item = createElement("article", {
        className: `compact-resource review-item resource-${resourceKind(resource)}`,
    });
    const header = createElement("div", { className: "compact-resource-header" });
    const identity = createElement("div", { className: "compact-resource-identity" });
    const title = createElement("h2");
    title.append(createResourceTitleLine(resource));
    identity.append(title);
    const mapping = renderSourceMapping(resource, service);
    if (mapping) {
        identity.append(mapping);
    }
    const actions = createElement("div", { className: "compact-resource-actions" });
    actions.append(...createResourceActionButtons(resource));
    header.append(identity, actions);
    item.append(header);

    if (issues.length > 0) {
        item.append(renderResourceValidation(issues));
    }
    item.append(renderResourceFacts(resource, service));
    item.append(renderCompactConnections(resource, edges));
    return item;
}

function createResourceActions(resource) {
    const actions = createElement("div", { className: "compact-resource-actions" });
    actions.append(...createResourceActionButtons(resource));
    return actions;
}

function createResourceActionButtons(resource) {
    const buttons = [];
    const hasDrafts = [...fieldDrafts.values()].some(
        (draft) => draft.resourceId === resource.id,
    );
    if (resource.generated && (resource.edited || hasDrafts)) {
        const reset = createElement("button", {
            className: "btn btn-quiet btn-sm",
            text: "Reset fields",
            title: `Reset ${resource.name} fields to generated values`,
            attrs: { type: "button" },
        });
        reset.addEventListener("click", () => void resetEntireResource(resource, reset));
        buttons.push(reset);
    }
    buttons.push(createRemoveResourceButton(resource));
    return buttons;
}

async function resetEntireResource(resource, control) {
    const reset = await runBusy(control, async () => {
        await post("/api/proposal/resource/reset", { id: resource.id });
    });
    if (reset) {
        for (const key of [...fieldDrafts.keys()]) {
            if (key.startsWith(`${resource.id}:`)) {
                fieldDrafts.delete(key);
            }
        }
        renderResourcePlan();
        renderConfirmation();
    }
}

function createRemoveResourceButton(resource) {
    const remove = createElement("button", {
        className: "btn btn-quiet btn-danger btn-sm resource-remove",
        text: "Remove",
        title: `Remove ${resource.name} from the proposal`,
        attrs: { type: "button", "aria-label": `Remove resource ${resource.name}` },
    });
    remove.hidden = snapshot.confirmed;
    remove.addEventListener("click", () => {
        openRemoveDialog({
            title: "Remove resource",
            detail: `Remove ${resource.name} from this AppHost proposal? Its connections will also be removed.`,
            action: (control) => deleteResourceById(resource.id, control),
        });
    });
    return remove;
}

function renderSourceMapping(resource, service) {
    if (!service) {
        return null;
    }
    const mapping = createElement("p", { className: "resource-mapping muted" });
    mapping.append(
        createElement("span", { className: "resource-mapping-value", text: service.name }),
        createElement("span", { className: "mapping-arrow", text: "→" }),
        createElement("span", { className: "resource-mapping-value", text: resource.name }),
    );
    return mapping;
}

function createResourceTitleLine(resource) {
    const line = createElement("span", {
        className: "resource-title-line",
        attrs: { "aria-label": `${resource.name}, ${resource.type}` },
    });
    line.append(
        createElement("span", { className: "resource-title-name", text: resource.name }),
        createElement("span", {
            className: "resource-type-badge",
            text: resource.type,
            title: `Aspire resource type: ${resource.type}`,
        }),
    );
    return line;
}

function renderResourceValidation(issues) {
    const validation = createElement("div", { className: "resource-validation" });
    validation.append(
        createElement("span", {
            className: "resource-validation-icon",
            text: "!",
            attrs: { "aria-hidden": "true" },
        }),
        createElement("span", { text: issues.join(" ") }),
    );
    return validation;
}

function renderResourceFacts(resource, service) {
    const facts = createElement("dl", { className: "resource-facts" });
    appendEditableTextFact(facts, "Resource name", resource, "name", resource.name, {
        validate: (value) => resourceNameFieldIssues(value, resource.id),
    });
    appendEditableTypeFact(facts, resource);
    if (service?.framework) {
        appendFact(facts, "Framework", service.framework);
    }
    if (service) {
        appendFact(facts, "Exposes HTTP", service.exposesHttp ? "Yes" : "No");
    }
    const path = servicePathForDisplay(service?.path);
    if (path) {
        appendPathFact(facts, resource, path);
    }
    appendEditableDetailFact(facts, resource);

    const dotnet = isDotNetType(resource.type);
    if (dotnet) {
        appendEditableDefaultsFact(facts, resource);
    }
    return facts;
}

function appendEditableTextFact(list, label, resource, field, value, options = {}) {
    const controlId = resourceControlId(resource, field);
    const draft = fieldDraft(resource, field);
    const input = createElement("input", {
        className: "inline-resource-input",
        attrs: {
            id: controlId,
            name: controlId,
            value,
            type: "text",
            "aria-label": `${label} for ${resource.name}`,
            spellcheck: "false",
        },
    });
    input.value = String(draft?.value ?? value);
    input.setCustomValidity(draft?.status === "invalid" ? draft.message : "");
    input.setAttribute("aria-invalid", String(draft?.status === "invalid"));
    input.disabled = snapshot.confirmed;
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            input.blur();
        }
    });
    const editor = createFieldEditor(resource, field, input);
    input.addEventListener("input", () => {
        const nextValue = input.value.trim();
        const issues =
            options.validate?.(nextValue) ??
            (nextValue || options.allowEmpty ? [] : [`Enter ${label.toLowerCase()}.`]);
        input.setCustomValidity(issues.join(" "));
        input.setAttribute("aria-invalid", String(issues.length > 0));
        setFieldDraft(resource, field, nextValue, issues.length ? "invalid" : "dirty", issues.join(" "));
        updateFieldEditor(resource, field, editor);
        renderConfirmation();
    });
    input.addEventListener("change", () => {
        const nextValue = input.value.trim();
        const issues =
            options.validate?.(nextValue) ??
            (nextValue || options.allowEmpty ? [] : [`Enter ${label.toLowerCase()}.`]);
        if (issues.length) {
            input.focus();
            return;
        }
        void saveFieldDraft(resource, field, nextValue, input, editor);
    });
    appendControlFact(list, label, editor.element, "", controlId);
}

function appendEditableDetailFact(list, resource) {
    const detailId = resourceControlId(resource, "detail");
    const draft = fieldDraft(resource, "detail");
    const textarea = createElement("textarea", {
        className: "inline-resource-input proposal-detail-input",
        attrs: {
            id: detailId,
            name: detailId,
            rows: "2",
            "aria-label": `Proposal detail for ${resource.name}`,
            spellcheck: "true",
        },
    });
    textarea.value = String(draft?.value ?? resource.detail ?? "");
    textarea.disabled = snapshot.confirmed;
    const editor = createFieldEditor(resource, "detail", textarea);
    textarea.addEventListener("input", () => {
        syncDetailTextareaHeight(textarea);
        setFieldDraft(resource, "detail", textarea.value, "dirty");
        updateFieldEditor(resource, "detail", editor);
        renderConfirmation();
    });
    textarea.addEventListener("change", () => {
        void saveFieldDraft(
            resource,
            "detail",
            textarea.value.trim(),
            textarea,
            editor,
        );
    });

    appendControlFact(list, "Proposal detail", editor.element, "is-detail", detailId);
    requestAnimationFrame(() => {
        if (textarea.isConnected) {
            syncDetailTextareaHeight(textarea);
            detailResizeObserver?.observe(textarea);
        }
    });
}

function syncDetailTextareaHeight(textarea) {
    textarea.style.height = "auto";
    const borderHeight = textarea.offsetHeight - textarea.clientHeight;
    textarea.style.height = `${Math.max(44, textarea.scrollHeight + borderHeight)}px`;
}

function resizeVisibleDetailTextareas(root = document) {
    requestAnimationFrame(() => {
        for (const textarea of root.querySelectorAll(".proposal-detail-input")) {
            if (textarea.offsetParent) {
                syncDetailTextareaHeight(textarea);
            }
        }
    });
}

function unobserveDetailTextareas() {
    if (!detailResizeObserver) {
        return;
    }
    for (const textarea of document.querySelectorAll(".proposal-detail-input")) {
        detailResizeObserver.unobserve(textarea);
    }
}

function appendEditableTypeFact(list, resource) {
    const controlId = resourceControlId(resource, "type");
    const draft = fieldDraft(resource, "type");
    const select = createElement("select", {
        className: "inline-resource-input",
        attrs: {
            id: controlId,
            name: controlId,
            "aria-label": `Aspire type for ${resource.name}`,
        },
    });
    const service = serviceForResource(resource);
    const values = [
        resource.type,
        resource.generated?.type,
        draft?.value,
        ...[...elements.addResourceType.options].map((option) => option.value),
    ].filter(
        (value, index, all) =>
            value &&
            all.indexOf(value) === index &&
            (value === resource.type ||
                (service
                    ? isCompatibleAspireResourceType(
                          service.type,
                          value,
                          service.framework,
                          resource.generated?.type,
                      )
                    : isCompatibleAspireResourceKind(resource.type, value))),
    );
    for (const value of values) {
        select.append(createElement("option", { text: value, attrs: { value } }));
    }
    select.value = String(draft?.value ?? resource.type);
    select.disabled = snapshot.confirmed;
    const editor = createFieldEditor(resource, "type", select);
    select.addEventListener("change", () => {
        setFieldDraft(resource, "type", select.value, "dirty");
        updateFieldEditor(resource, "type", editor);
        renderConfirmation();
        void saveFieldDraft(resource, "type", select.value, select, editor);
    });
    const wrapper = createElement("span", { className: "inline-select-wrap" });
    wrapper.append(
        select,
        createElement("span", {
            className: "inline-select-chevron",
            attrs: { "aria-hidden": "true" },
        }),
    );
    editor.control.replaceChildren(wrapper);
    appendControlFact(list, "Aspire type", editor.element, "", controlId);
}

function appendEditableDefaultsFact(list, resource) {
    const controlId = resourceControlId(resource, "service-defaults");
    const draft = fieldDraft(resource, "serviceDefaults");
    const control = createElement("label", { className: "inline-defaults-control" });
    const checkbox = createElement("input", {
        attrs: {
            id: controlId,
            name: controlId,
            type: "checkbox",
            "aria-label": `Service Defaults for ${resource.name}`,
        },
    });
    checkbox.checked = Boolean(draft?.value ?? resource.serviceDefaults);
    checkbox.disabled = snapshot.confirmed;
    control.append(
        checkbox,
        createElement("span", { text: checkbox.checked ? "Enabled" : "Disabled" }),
    );
    const editor = createFieldEditor(resource, "serviceDefaults", control);
    checkbox.addEventListener("change", () => {
        control.querySelector("span").textContent = checkbox.checked ? "Enabled" : "Disabled";
        setFieldDraft(resource, "serviceDefaults", checkbox.checked, "dirty");
        updateFieldEditor(resource, "serviceDefaults", editor);
        renderConfirmation();
        void saveFieldDraft(
            resource,
            "serviceDefaults",
            checkbox.checked,
            checkbox,
            editor,
        );
    });
    appendControlFact(list, "Service Defaults", editor.element, "", controlId);
}

function fieldDraftKey(resourceId, field) {
    return `${resourceId}:${field}`;
}

function fieldDraft(resource, field) {
    return fieldDrafts.get(fieldDraftKey(resource.id, field));
}

function valuesEqual(left, right) {
    return typeof left === "boolean" || typeof right === "boolean"
        ? Boolean(left) === Boolean(right)
        : String(left ?? "") === String(right ?? "");
}

function setFieldDraft(resource, field, value, status, message = "") {
    const key = fieldDraftKey(resource.id, field);
    if (valuesEqual(resource[field], value) && status !== "saving" && status !== "error") {
        fieldDrafts.delete(key);
        return;
    }
    fieldDrafts.set(key, {
        resourceId: resource.id,
        resourceName: resource.name,
        field,
        value,
        status,
        message,
    });
}

function clearFieldDraft(resource, field) {
    fieldDrafts.delete(fieldDraftKey(resource.id, field));
}

function reconcileFieldDrafts() {
    for (const [key, draft] of fieldDrafts) {
        const resource = snapshot?.proposal?.resources?.find(
            (candidate) => candidate.id === draft.resourceId,
        );
        if (!resource || (draft.status === "saving" && valuesEqual(resource[draft.field], draft.value))) {
            fieldDrafts.delete(key);
        }
    }
}

function fieldHasGeneratedOverride(resource, field) {
    return Boolean(resource.generated) &&
        !valuesEqual(resource[field], resource.generated[field]);
}

function createFieldEditor(resource, field, control) {
    const element = createElement("div", {
        className: "resource-field-editor",
        attrs: { "data-field": field },
    });
    const controlContainer = createElement("div", { className: "resource-field-control" });
    const meta = createElement("div", { className: "resource-field-meta" });
    const status = createElement("span", {
        className: "resource-field-status muted",
        attrs: { "aria-live": "polite" },
    });
    const reset = createElement("button", {
        className: "resource-field-reset",
        text: "Reset",
        attrs: {
            type: "button",
            "aria-label": `Reset ${field} for ${resource.name} to the generated value`,
        },
    });
    reset.addEventListener("click", () => {
        void resetResourceField(resource, field, control, { element, control: controlContainer, meta, status, reset });
    });
    controlContainer.append(control);
    meta.append(status, reset);
    element.append(controlContainer, meta);
    const editor = { element, control: controlContainer, meta, status, reset };
    updateFieldEditor(resource, field, editor);
    return editor;
}

function updateFieldEditor(resource, field, editor) {
    const draft = fieldDraft(resource, field);
    const labels = {
        dirty: "Unsaved",
        saving: "Saving…",
        invalid: draft?.message ? `Invalid · ${draft.message}` : "Invalid",
        error: draft?.message ? `Not saved · ${draft.message}` : "Not saved",
    };
    editor.status.textContent = draft ? labels[draft.status] ?? "" : "";
    editor.status.className = `resource-field-status${draft?.status ? ` is-${draft.status}` : " muted"}`;
    editor.reset.hidden =
        snapshot.confirmed ||
        (!draft && !fieldHasGeneratedOverride(resource, field));
    editor.meta.hidden = !editor.status.textContent && editor.reset.hidden;
}

async function saveFieldDraft(resource, field, value, control, editor) {
    if (valuesEqual(resource[field], value)) {
        clearFieldDraft(resource, field);
        updateFieldEditor(resource, field, editor);
        renderConfirmation();
        return true;
    }
    setFieldDraft(resource, field, value, "saving");
    updateFieldEditor(resource, field, editor);
    renderConfirmation();
    let failure;
    const saved = await runBusy(
        control,
        async () => {
            await post("/api/proposal/resource", {
                id: resource.id,
                [field]: value,
            });
        },
        (error) => {
            failure = error;
        },
    );
    if (saved) {
        clearFieldDraft(resource, field);
    } else {
        setFieldDraft(
            resource,
            field,
            value,
            "error",
            failure?.message ?? String(failure ?? "The change could not be saved."),
        );
    }
    updateFieldEditor(resource, field, editor);
    renderConfirmation();
    return saved;
}

async function resetResourceField(resource, field, control, editor) {
    if (!resource.generated) {
        return;
    }
    const generatedValue = resource.generated[field];
    clearFieldDraft(resource, field);
    if (control instanceof HTMLInputElement && control.type === "checkbox") {
        control.checked = Boolean(generatedValue);
        control.closest("label")?.querySelector("span")?.replaceChildren(
            control.checked ? "Enabled" : "Disabled",
        );
    } else {
        control.value = String(generatedValue ?? "");
    }
    if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
        control.setCustomValidity("");
        control.setAttribute("aria-invalid", "false");
    }
    updateFieldEditor(resource, field, editor);
    renderConfirmation();
    if (!valuesEqual(resource[field], generatedValue)) {
        await saveFieldDraft(resource, field, generatedValue, control, editor);
    }
}

function appendControlFact(list, label, control, className = "", controlId = "") {
    const row = createElement("div", {
        className: `resource-fact is-editable${className ? ` ${className}` : ""}`,
    });
    const term = createElement("dt");
    term.append(
        createElement(controlId ? "label" : "span", {
            text: label,
            attrs: controlId ? { for: controlId } : {},
        }),
    );
    const valueElement = createElement("dd");
    valueElement.append(control);
    row.append(term, valueElement);
    list.append(row);
}

function resourceControlId(resource, field) {
    const resourceId = String(resource.id).replace(/[^A-Za-z0-9_-]/g, "-");
    return `resource-${resourceId}-${field}`;
}

function appendFact(list, label, value, code = false) {
    const row = createElement("div", {
        className: `resource-fact${code ? " is-code" : ""}`,
    });
    const valueElement = createElement("dd", { title: value || "" });
    valueElement.append(
        createElement(code ? "code" : "span", {
            className: "resource-fact-value",
            text: value,
        }),
    );
    row.append(createElement("dt", { text: label }), valueElement);
    list.append(row);
}

function appendPathFact(list, resource, path) {
    const row = createElement("div", { className: "resource-fact is-code resource-fact-path" });
    const valueElement = createElement("dd", { title: path });
    valueElement.append(
        createElement("code", { className: "resource-fact-value", text: path }),
        createCopyPathButton(resource, path),
    );
    row.append(createElement("dt", { text: "Path" }), valueElement);
    list.append(row);
}

function createCopyPathButton(resource, path) {
    const defaultLabel = "Copy path";
    const button = createElement("button", {
        className: "btn btn-quiet btn-sm copy-path-button",
        text: defaultLabel,
        title: `Copy the file path for ${resource.name} so you can open it in your editor`,
        attrs: { type: "button" },
    });
    let resetTimer;
    button.addEventListener("click", async () => {
        window.clearTimeout(resetTimer);
        try {
            await navigator.clipboard.writeText(path);
            button.textContent = "Copied";
            button.classList.remove("is-copy-failed");
            button.classList.add("is-copy-confirmed");
        } catch {
            button.textContent = "Copy failed";
            button.classList.remove("is-copy-confirmed");
            button.classList.add("is-copy-failed");
        }
        resetTimer = window.setTimeout(() => {
            button.textContent = defaultLabel;
            button.classList.remove("is-copy-confirmed", "is-copy-failed");
        }, 1600);
    });
    return button;
}

function renderCompactConnections(resource, edges) {
    const section = createElement("div", { className: "compact-connections" });
    const relationships = relationshipsFor(resource, edges);
    section.append(createConnectionHeading(resource));
    if (!relationships.length) {
        section.append(createElement("span", { className: "muted", text: "No direct connections" }));
        return section;
    }
    const chips = createElement("div", { className: "connection-chips" });
    for (const relationship of relationships) {
        chips.append(createConnectionChip(relationship));
    }
    section.append(chips);
    return section;
}

function createConnectionHeading(resource, labeled = false) {
    const heading = createElement("div", { className: "connection-heading" });
    const add = createElement("button", {
        className: labeled
            ? "btn btn-outline btn-sm connection-add connection-add-labeled"
            : "btn btn-outline btn-icon add-icon-button connection-add",
        text: labeled ? "Add connection" : "",
        title: `Add connection for ${resource.name}`,
        attrs: {
            type: "button",
            "aria-label": `Add connection for ${resource.name}`,
        },
    });
    add.hidden = snapshot.confirmed;
    add.disabled =
        snapshot.proposal.resources.filter((candidate) => candidate.include).length < 2;
    add.addEventListener("click", () => openConnectionDialog("", resource.name));
    heading.append(
        createElement("strong", { className: "connection-label", text: "Connections" }),
        add,
    );
    return heading;
}

function servicePathForDisplay(path) {
    const displayPath = String(path ?? "").trim();
    const normalizedSegments = displayPath
        .replace(/\\/g, "/")
        .split("/")
        .filter(Boolean);
    if (
        !/^[\\/]/.test(displayPath) &&
        normalizedSegments.length > 0 &&
        normalizedSegments.every((segment) => segment === ".")
    ) {
        return "";
    }
    return displayPath;
}

function relationshipsFor(resource, edges = snapshot.proposal.edges) {
    return edges.flatMap((edge) => {
        if (edge.from === resource.name) {
            return [{ edge, direction: "outgoing", peer: edge.to }];
        }
        if (edge.to === resource.name) {
            return [{ edge, direction: "incoming", peer: edge.from }];
        }
        return [];
    });
}

function relationshipText(relationship) {
    const labels = EDGE_LABELS[relationship.edge.kind] ?? {
        outgoing: relationship.edge.kind,
        incoming: relationship.edge.kind,
    };
    return `${labels[relationship.direction]} ${relationship.peer}`;
}

function relationshipClassName(relationship) {
    const tone = EDGE_LABELS[relationship.edge.kind]?.tone ?? "reference";
    return `connection-chip connection-${tone}`;
}

function connectionKindName(kind) {
    return (
        {
            reference: "reference",
            waitFor: "wait-for",
            parent: "parent",
        }[kind] ?? kind
    );
}

function createConnectionChip(relationship) {
    const accessibleLabel = `Edit ${connectionKindName(
        relationship.edge.kind,
    )} connection from ${relationship.edge.from} to ${relationship.edge.to}`;
    const chip = createElement("button", {
        className: relationshipClassName(relationship),
        title: accessibleLabel,
        attrs: {
            type: "button",
            "aria-label": accessibleLabel,
        },
    });
    chip.append(
        createElement("span", { text: relationshipText(relationship) }),
        createElement("span", {
            className: "connection-chip-affordance",
            text: "Edit",
            attrs: { "aria-hidden": "true" },
        }),
    );
    chip.disabled = snapshot.confirmed;
    chip.addEventListener("click", () => openConnectionDialog(relationship.edge.id));
    return chip;
}

function renderProposalIdentity() {
    const generatedAt = new Date(snapshot.proposal.generatedAt);
    const generatedLabel = Number.isNaN(generatedAt.getTime())
        ? "Generation time not supplied"
        : `Generated ${generatedAt.toLocaleString([], {
              dateStyle: "medium",
              timeStyle: "short",
          })}`;
    elements.proposalStateCopy.textContent = snapshot.confirmed
        ? "AppHost proposal confirmed"
        : "AppHost proposal awaiting confirmation";
    elements.proposalGeneratedAt.textContent = snapshot.confirmed
        ? `${generatedLabel} · Immutable snapshot. Implementation continues in chat.`
        : `${generatedLabel} · AppHost wiring has not started.`;
    elements.proposalGeneration.textContent = String(
        snapshot.confirmedGeneration ?? snapshot.proposalGeneration,
    );
    elements.proposalHash.textContent = shortHash(snapshot.proposalHash);
    elements.proposalHash.title = snapshot.proposalHash || "";
}

function shortHash(hash) {
    return hash ? hash.slice(0, 12) : "not available";
}

function renderStatus() {
    const resources = snapshot.proposal.resources ?? [];
    const includedResources = resources.filter((resource) => resource.include);
    const includedNames = new Set(includedResources.map((resource) => resource.name));
    const activeEdges = snapshot.proposal.edges.filter(
        (edge) => includedNames.has(edge.from) && includedNames.has(edge.to),
    ).length;
    if (snapshot.proposalError) {
        setStatusLine(snapshot.proposalError);
    } else if (snapshot.confirmed) {
        setStatusLine("Proposal confirmed");
    } else {
        setStatusLine(`${
            includedResources.length
        } resource${includedResources.length === 1 ? "" : "s"} · ${activeEdges} connection${
            activeEdges === 1 ? "" : "s"
        } · Awaiting confirmation`);
    }
}

function renderConfirmation() {
    const issues = confirmationIssues();
    const resourceIssueCount = Object.keys(proposalValidation().resourceIssues).length;
    const unresolvedDrafts = [...fieldDrafts.values()];
    const nonResourceIssues = issues.filter((issue) => !issue.startsWith('Resource "'));
    elements.confirm.disabled =
        !snapshot.proposalLoaded ||
        snapshot.proposalStale ||
        issues.length > 0 ||
        snapshot.confirmed ||
        pendingMutations > 0;
    elements.confirm.textContent = snapshot.confirmed ? "Confirmed" : "Confirm";
    const hasBlockingMessage = Boolean(mutationError || issues.length);
    elements.confirmSummary.hidden = hasBlockingMessage || snapshot.confirmed;
    elements.confirmSummary.textContent = hasBlockingMessage
        ? ""
        : confirmationSummaryText();
    elements.footerNote.hidden = !hasBlockingMessage || snapshot.confirmed;
    elements.footerNote.textContent = mutationError
        ? mutationError
        : snapshot.confirmed
          ? ""
          : unresolvedDrafts.length
            ? `${unresolvedDrafts.length} edit${unresolvedDrafts.length === 1 ? "" : "s"} must be saved or reset before confirmation.`
          : resourceIssueCount
            ? `${resourceIssueCount} resource${resourceIssueCount === 1 ? "" : "s"} need attention before confirmation.${
                  nonResourceIssues.length ? ` ${nonResourceIssues.join(" ")}` : ""
              }`
            : (issues[0] ?? "");
    renderHistoryControls();
}

function confirmationSummaryText() {
    const resources = snapshot.proposal.resources.filter((resource) => resource.include);
    const names = new Set(resources.map((resource) => resource.name));
    const connections = snapshot.proposal.edges.filter(
        (edge) => names.has(edge.from) && names.has(edge.to),
    );
    return `Confirm ${resources.length} resource${
        resources.length === 1 ? "" : "s"
    } and ${connections.length} connection${
        connections.length === 1 ? "" : "s"
    } for ${appHostPathForDisplay(snapshot.appHostPath)}. Wiring continues in chat; nothing starts here.`;
}

function renderHistoryControls() {
    const blocked = historyChangeBlocked();
    const history = snapshot?.history ?? {};
    elements.undo.disabled = blocked || !history.canUndo;
    elements.redo.disabled = blocked || !history.canRedo;
    elements.undo.title = history.canUndo
        ? `Undo ${history.undoLabel || "proposal change"}`
        : "Nothing to undo";
    elements.redo.title = history.canRedo
        ? `Redo ${history.redoLabel || "proposal change"}`
        : "Nothing to redo";
}

function confirmationIssues() {
    if (!snapshot.proposalLoaded || snapshot.proposalStale) {
        return [];
    }
    const draftIssues = [...fieldDrafts.values()].map((draft) =>
        draft.status === "invalid"
            ? `${draft.resourceName} has an invalid ${draft.field} edit.`
            : `${draft.resourceName} has an unsaved ${draft.field} edit.`,
    );
    return [...new Set([...proposalValidation().issues, ...draftIssues])];
}

function proposalValidation() {
    if (
        snapshot.validation &&
        Array.isArray(snapshot.validation.issues) &&
        snapshot.validation.resourceIssues
    ) {
        return snapshot.validation;
    }

    return {
        issues: ["Proposal validation is unavailable. Refresh the snapshot before confirmation."],
        resourceIssues: {},
    };
}

function resourceNameIssues(value) {
    const name = String(value ?? "").trim();
    const issues = [];
    if (!name) {
        return ["Enter a resource name."];
    }
    if (name.length > 64) {
        issues.push(`Use at most 64 characters; this name has ${name.length}.`);
    }
    if (!/^[A-Za-z]/.test(name)) {
        issues.push("Start with a letter.");
    }
    if (/[^A-Za-z0-9-]/.test(name)) {
        issues.push("Use only letters, digits, and hyphens.");
    }
    if (name.endsWith("-")) {
        issues.push("Do not end with a hyphen.");
    }
    if (name.includes("--")) {
        issues.push("Do not use consecutive hyphens.");
    }
    return issues;
}

function resourceNameFieldIssues(value, resourceId) {
    const name = String(value ?? "").trim();
    const issues = resourceNameIssues(name);
    const duplicate = snapshot?.proposal?.resources?.find(
        (resource) =>
            resource.id !== resourceId &&
            String(fieldDraft(resource, "name")?.value ?? resource.name)
                .trim()
                .toLowerCase() === name.toLowerCase(),
    );
    if (name && duplicate) {
        issues.push(`The name "${name}" is already used by another resource.`);
    }
    return issues;
}

function validateResourceNameField(input, resourceId, errorElement, report = false) {
    const issues = resourceNameFieldIssues(input.value, resourceId);
    const message = issues.join(" ");
    input.setCustomValidity(message);
    input.setAttribute("aria-invalid", String(issues.length > 0));
    errorElement.textContent = message;
    errorElement.hidden = issues.length === 0;
    if (report && issues.length > 0) {
        input.focus();
    }
    return issues.length === 0;
}

async function deleteResourceById(id, control, onDeleted) {
    return await runBusy(control, async () => {
        await post("/api/proposal/resource/delete", { id });
        onDeleted?.();
    });
}

function openRemoveDialog({ title, detail, action }) {
    clearDialogError(elements.removeDialogError);
    elements.removeDialogTitle.textContent = title;
    elements.removeDialogDetail.textContent = detail;
    pendingRemoval = action;
    elements.removeDialog.showModal();
    elements.removeDialog.querySelector(".dialog-actions [data-close-dialog]")?.focus();
}

async function executeRemoval(event) {
    event.preventDefault();
    if (!pendingRemoval) {
        return;
    }
    const removed = await pendingRemoval(elements.confirmRemove);
    if (removed) {
        pendingRemoval = undefined;
        elements.removeDialog.close();
    }
}

function openAddResourceDialog(groupId) {
    if (snapshot.confirmed) {
        return;
    }
    const definition =
        groupId === "all"
            ? {
                  id: "all",
                  addTitle: "Add resource",
                  addDescription: "Add another resource to this AppHost proposal.",
              }
            : RESOURCE_GROUPS.find((candidate) => candidate.id === groupId);
    if (!definition) {
        return;
    }
    elements.addResourceForm.reset();
    clearDialogError(elements.addResourceDialogError);
    elements.addResourceName.setCustomValidity("");
    elements.addResourceType.setCustomValidity("");
    elements.addResourceName.setAttribute("aria-invalid", "false");
    elements.addResourceGroup.value = groupId;
    elements.addResourceDialogTitle.textContent = definition.addTitle;
    elements.addResourceDialogDetail.textContent = definition.addDescription;
    filterResourceTypeOptions(elements.addResourceType, groupId);
    const firstOption = [...elements.addResourceType.options].find((option) => !option.disabled);
    elements.addResourceType.value =
        suggestedResourceType(elements.addResourceGroup.value) ?? firstOption?.value ?? "";
    elements.addResourceDefaults.checked =
        elements.addResourceType.value === ".NET project";
    syncDefaultsField(
        elements.addResourceType,
        elements.addDefaultsField,
        elements.addResourceDefaults,
        false,
    );
    resetAddResourceConnections();
    elements.addResourceDialog.showModal();
    elements.addResourceName.focus();
}

async function addResource(event) {
    event.preventDefault();
    if (!elements.addResourceType.value) {
        elements.addResourceType.setCustomValidity("Choose a resource type.");
        elements.addResourceDialogError.textContent = "Choose a resource type.";
        elements.addResourceDialogError.hidden = false;
        elements.addResourceType.focus();
        return;
    }
    if (
        !validateResourceNameField(
            elements.addResourceName,
            "",
            elements.addResourceDialogError,
            true,
        )
    ) {
        return;
    }
    await runBusy(event.submitter, async () => {
        await post("/api/proposal/resource/add", {
            name: elements.addResourceName.value,
            type: elements.addResourceType.value,
            detail: elements.addResourceDetail.value,
            serviceDefaults: elements.addResourceDefaults.checked,
            connections: [...elements.addResourceConnections.querySelectorAll(".add-connection-row")].map(
                (row) => ({
                    direction: row.querySelector("[data-add-connection-direction]").value,
                    kind: row.querySelector("[data-add-connection-kind]").value,
                    target: row.querySelector("[data-add-connection-target]").value,
                }),
            ),
        });
        elements.addResourceDialog.close();
    });
}

function resetAddResourceConnections() {
    elements.addResourceConnections.replaceChildren();
    const resources = snapshot.proposal.resources.filter((resource) => resource.include);
    elements.addResourceConnectionRow.disabled = resources.length === 0;
    elements.addResourceConnections.append(
        createElement("span", {
            className: "dialog-connection-empty muted",
            text:
                resources.length === 0
                    ? "Add another resource before creating a connection."
                    : "No connections yet.",
        }),
    );
}

function addResourceConnectionRow() {
    const resources = snapshot.proposal.resources.filter((resource) => resource.include);
    if (resources.length === 0) {
        return;
    }
    elements.addResourceConnections.querySelector(".dialog-connection-empty")?.remove();
    const rowId = `add-resource-connection-${++connectionRowSequence}`;
    const row = createElement("div", { className: "add-connection-row" });
    const direction = createElement("select", {
        attrs: {
            id: `${rowId}-direction`,
            name: `${rowId}-direction`,
            "aria-label": "Connection direction",
            "data-add-connection-direction": "",
        },
    });
    direction.append(
        createElement("option", {
            text: "From new resource",
            attrs: { value: "outgoing" },
        }),
        createElement("option", {
            text: "To new resource",
            attrs: { value: "incoming" },
        }),
    );
    const kind = createElement("select", {
        attrs: {
            id: `${rowId}-kind`,
            name: `${rowId}-kind`,
            "aria-label": "Connection relationship",
            "data-add-connection-kind": "",
        },
    });
    kind.append(
        createElement("option", { text: "references", attrs: { value: "reference" } }),
        createElement("option", { text: "waits for", attrs: { value: "waitFor" } }),
        createElement("option", { text: "child of", attrs: { value: "parent" } }),
    );
    const target = createElement("select", {
        attrs: {
            id: `${rowId}-target`,
            name: `${rowId}-target`,
            "aria-label": "Connected resource",
            "data-add-connection-target": "",
        },
    });
    fillResourceSelect(target, resources);
    const remove = createElement("button", {
        className: "btn btn-quiet btn-icon add-connection-remove",
        text: "×",
        title: "Remove connection",
        attrs: { type: "button", "aria-label": "Remove connection" },
    });
    remove.addEventListener("click", () => {
        row.remove();
        if (!elements.addResourceConnections.children.length) {
            resetAddResourceConnections();
        }
    });
    row.append(direction, kind, target, remove);
    elements.addResourceConnections.append(row);
}

function openConnectionDialog(edgeId = "", initialFrom = "") {
    if (snapshot.confirmed) {
        return;
    }
    const edge = snapshot.proposal.edges.find((candidate) => candidate.id === edgeId);
    const resources = snapshot.proposal.resources.filter((resource) => resource.include);
    if (resources.length < 2) {
        showInlineError(new Error("Include at least two resources before adding a connection."));
        return;
    }
    const resourceNames = new Set(resources.map((resource) => resource.name));
    if (edge && (!resourceNames.has(edge.from) || !resourceNames.has(edge.to))) {
        showInlineError(new Error("Include both resources before editing this connection."));
        return;
    }
    clearDialogError(elements.connectionDialogError);
    fillResourceSelect(elements.connectionFrom, resources);
    elements.connectionId.value = edge?.id ?? "";
    elements.connectionDialogTitle.textContent = edge ? "Edit connection" : "Add connection";
    elements.connectionFrom.value =
        edge?.from ??
        (resources.some((resource) => resource.name === initialFrom)
            ? initialFrom
            : resources[0].name);
    syncConnectionTargets(edge?.to ?? resources[1].name);
    elements.connectionKind.value = edge?.kind ?? "reference";
    elements.resetConnection.hidden = !edge?.generated || !edge.edited;
    elements.deleteConnection.hidden = !edge;
    elements.connectionDialog.showModal();
    elements.connectionFrom.focus();
}

async function resetConnection() {
    const id = elements.connectionId.value;
    if (!id) {
        return;
    }
    const reset = await runBusy(elements.resetConnection, async () => {
        await post("/api/proposal/edge/reset", { id });
    });
    if (reset) {
        elements.connectionDialog.close();
    }
}

async function saveConnection(event) {
    event.preventDefault();
    if (elements.connectionFrom.value === elements.connectionTo.value) {
        elements.connectionTo.setCustomValidity("Choose a different target resource.");
        elements.connectionTo.reportValidity();
        return;
    }
    elements.connectionTo.setCustomValidity("");
    const id = elements.connectionId.value;
    const path = id ? "/api/proposal/edge" : "/api/proposal/edge/add";
    await runBusy(event.submitter, async () => {
        await post(path, {
            id,
            from: elements.connectionFrom.value,
            kind: elements.connectionKind.value,
            to: elements.connectionTo.value,
        });
        elements.connectionDialog.close();
    });
}

function syncConnectionTargets(preferredTarget = elements.connectionTo.value) {
    const targets = snapshot.proposal.resources.filter(
        (resource) =>
            resource.include &&
            resource.name !== elements.connectionFrom.value,
    );
    fillResourceSelect(elements.connectionTo, targets);
    elements.connectionTo.value = targets.some((resource) => resource.name === preferredTarget)
        ? preferredTarget
        : (targets[0]?.name ?? "");
    elements.connectionTo.setCustomValidity("");
}

function requestDeleteConnection() {
    const edge = snapshot.proposal.edges.find(
        (candidate) => candidate.id === elements.connectionId.value,
    );
    if (!edge) {
        return;
    }
    openRemoveDialog({
        title: "Remove connection",
        detail: `Remove the connection from ${edge.from} to ${edge.to}?`,
        action: async (control) => {
            const removed = await runBusy(control, async () => {
                await post("/api/proposal/edge/delete", { id: edge.id });
            });
            if (removed) {
                elements.connectionDialog.close();
            }
            return removed;
        },
    });
}

function fillResourceSelect(select, resources) {
    select.replaceChildren();
    for (const resource of resources) {
        select.append(
            createElement("option", { text: resource.name, attrs: { value: resource.name } }),
        );
    }
}

function serviceForResource(resource) {
    return snapshot.services.find((service) => service.id === resource.serviceId);
}

function resourceKind(resource) {
    return classifyAspireResourceKind(resource.type);
}

function resourceGroupDefinition(resource) {
    const kind = resourceKind(resource);
    const group = RESOURCE_GROUPS.find((candidate) => candidate.kinds.has(kind));
    if (!group) {
        return {
            id: "external",
            resourceDescription: "External dependency",
        };
    }
    return {
        ...group,
        resourceDescription:
            {
                applications: "Application resource",
                data: "Data or messaging resource",
                infrastructure: "Infrastructure resource",
                external: "External dependency",
            }[group.id] ?? "Resource",
    };
}

function filterResourceTypeOptions(select, groupId) {
    for (const option of select.options) {
        const matches =
            !option.value ||
            groupId === "all" ||
            option.dataset.group === groupId ||
            option.dataset.detected === "true";
        option.hidden = !matches;
        option.disabled = !option.value || !matches;
    }
    for (const optgroup of select.querySelectorAll("optgroup")) {
        optgroup.hidden = [...optgroup.querySelectorAll("option")].every(
            (option) => option.hidden,
        );
    }
}

function suggestedResourceType(groupId) {
    const candidates = snapshot.proposal.resources.filter((resource) => {
        if (!resource.include) {
            return false;
        }
        if (groupId === "all") {
            return true;
        }
        return resourceGroupDefinition(resource).id === groupId;
    });
    const available = new Set(
        [...elements.addResourceType.options]
            .filter((option) => option.value && !option.disabled)
            .map((option) => option.value),
    );
    const counts = new Map();
    for (const resource of candidates) {
        if (available.has(resource.type)) {
            counts.set(resource.type, (counts.get(resource.type) ?? 0) + 1);
        }
    }
    const ranked = [...counts].sort(
        ([leftType, leftCount], [rightType, rightCount]) =>
            rightCount - leftCount || leftType.localeCompare(rightType),
    );
    if (ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) {
        return ranked[0][0];
    }
    if (
        groupId === "applications" &&
        snapshot.apphostStyle !== "typescript" &&
        available.has(".NET project")
    ) {
        return ".NET project";
    }
    return "";
}

function syncDefaultsField(select, field, checkbox, defaultWhenShown = true) {
    const wasHidden = field.hidden;
    const isDotNet = isDotNetType(select.value);
    field.hidden = !isDotNet;
    if (isDotNet && wasHidden && defaultWhenShown) {
        checkbox.checked = true;
    }
}

function showLoading() {
    showProposalPending();
}

function showProposalPending() {
    elements.body.classList.add("is-loading");
    elements.body.classList.remove("is-busy", "has-data", "is-confirmed");
    elements.skeleton.hidden = false;
    elements.snapshot.hidden = true;
    elements.actionFooter.hidden = true;
    elements.error.hidden = true;
    elements.apphostControl.hidden = !snapshot?.apphostStyle;
    setStatusLine("Receiving AppHost proposal snapshot…");
}

function showError(error) {
    elements.body.classList.remove("is-loading", "is-busy", "has-data");
    elements.skeleton.hidden = true;
    elements.snapshot.hidden = true;
    elements.actionFooter.hidden = true;
    elements.error.hidden = false;
    elements.apphostControl.hidden = true;
    setStatusLine("Proposal unavailable");
    elements.retry.textContent = "Try again";
    elements.errorMessage.textContent = error?.message ?? String(error);
}

function showProposalError(error) {
    showError(new Error(String(error ?? "Proposal generation failed.")));
    setStatusLine("Proposal generation failed");
    elements.retry.textContent = "Retry proposal";
}

function showInlineError(error) {
    const dialogError = [
        [elements.removeDialog, elements.removeDialogError],
        [elements.addResourceDialog, elements.addResourceDialogError],
        [elements.connectionDialog, elements.connectionDialogError],
    ].find(([dialog]) => dialog.open)?.[1];
    if (dialogError) {
        dialogError.textContent = error?.message ?? String(error);
        dialogError.hidden = false;
        dialogError.focus();
        return;
    }
    mutationError = error?.message ?? String(error);
    elements.footerNote.hidden = false;
    elements.footerNote.textContent = mutationError;
}

function clearDialogError(element) {
    element.textContent = "";
    element.hidden = true;
}

function createElement(tag, options = {}) {
    const element = document.createElement(tag);
    if (options.className) element.className = options.className;
    if (typeof options.text !== "undefined") element.textContent = options.text;
    if (options.title) element.title = options.title;
    for (const [name, value] of Object.entries(options.attrs ?? {})) {
        element.setAttribute(name, value);
    }
    return element;
}
