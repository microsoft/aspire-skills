"use strict";

import { isDotNetType } from "./resource-types.js";

const apiToken = new URLSearchParams(window.location.search).get("token") || "";

const EDGE_LABELS = {
    reference: { outgoing: "references", incoming: "referenced by" },
    waitFor: { outgoing: "waits for", incoming: "unblocks" },
    parent: { outgoing: "child of", incoming: "parent of" },
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
    apphostValue: document.getElementById("apphost-value"),
    proposalSummary: document.getElementById("proposal-summary"),
    pillResources: document.getElementById("pill-resources"),
    countResources: document.getElementById("count-resources"),
    labelResources: document.getElementById("label-resources"),
    pillWarnings: document.getElementById("pill-warnings"),
    countWarnings: document.getElementById("count-warnings"),
    labelWarnings: document.getElementById("label-warnings"),
    pillDecisions: document.getElementById("pill-decisions"),
    countDecisions: document.getElementById("count-decisions"),
    labelDecisions: document.getElementById("label-decisions"),
    skeleton: document.getElementById("skeleton"),
    snapshot: document.getElementById("snapshot"),
    planContent: document.getElementById("plan-content"),
    resourcePlanPanel: document.getElementById("resource-plan-panel"),
    compactResources: document.getElementById("compact-resources"),
    compactAddResource: document.getElementById("compact-add-resource"),
    resourceGroups: document.getElementById("resource-groups"),
    proposalStateCopy: document.getElementById("proposal-state-copy"),
    proposalGeneratedAt: document.getElementById("proposal-generated-at"),
    proposalGeneration: document.getElementById("proposal-generation"),
    proposalHash: document.getElementById("proposal-hash"),
    externalServicesSection: document.getElementById("external-services-section"),
    externalServices: document.getElementById("external-services"),
    assumptionsSection: document.getElementById("assumptions-section"),
    assumptionsRisks: document.getElementById("assumptions-risks"),
    decisionsSection: document.getElementById("decisions-section"),
    decisions: document.getElementById("decisions"),
    actionFooter: document.getElementById("action-footer"),
    scopeSummary: document.getElementById("scope-summary"),
    footerNote: document.getElementById("footer-note"),
    confirm: document.getElementById("confirm"),
    error: document.getElementById("error"),
    errorMessage: document.getElementById("error-message"),
    retry: document.getElementById("retry"),
    resourceDialog: document.getElementById("resource-dialog"),
    resourceDialogError: document.getElementById("resource-dialog-error"),
    resourceForm: document.getElementById("resource-form"),
    resourceId: document.getElementById("resource-id"),
    resourceName: document.getElementById("resource-name"),
    resourceType: document.getElementById("resource-type"),
    resourceDialogDetail: document.getElementById("resource-dialog-detail"),
    defaultsField: document.getElementById("defaults-field"),
    resourceDefaults: document.getElementById("resource-defaults"),
    resourceConnections: document.getElementById("resource-connections"),
    addResourceConnection: document.getElementById("add-resource-connection"),
    deleteResource: document.getElementById("delete-resource"),
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
    deleteConnection: document.getElementById("delete-connection"),
};

let snapshot;
let firstRender = true;
let proposalRequestPending = false;
const collapsedGroups = new Set();
const collapsedCards = new Set();
const initializedGroups = new Set();
document.addEventListener("DOMContentLoaded", () => {
    elements.retry.addEventListener("click", () => void retryProposalOrSnapshot());
    elements.confirm.addEventListener("click", () => void confirmSnapshot());
    elements.resourceForm.addEventListener("submit", saveResource);
    elements.resourceType.addEventListener("change", () =>
        syncDefaultsField(
            elements.resourceType,
            elements.defaultsField,
            elements.resourceDefaults,
        ),
    );
    elements.resourceName.addEventListener("input", () =>
        validateResourceNameField(
            elements.resourceName,
            elements.resourceId.value,
            elements.resourceDialogError,
        ),
    );
    elements.addResourceConnection.addEventListener("click", openResourceConnectionDialog);
    elements.deleteResource.addEventListener("click", () => void deleteResource());
    elements.compactAddResource.addEventListener("click", () => openAddResourceDialog("all"));
    elements.addResourceForm.addEventListener("submit", addResource);
    elements.addResourceType.addEventListener("change", () =>
        syncDefaultsField(
            elements.addResourceType,
            elements.addDefaultsField,
            elements.addResourceDefaults,
        ),
    );
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
    elements.deleteConnection.addEventListener("click", () => void deleteConnection());
    for (const button of document.querySelectorAll("[data-close-dialog]")) {
        button.addEventListener("click", () => button.closest("dialog")?.close());
    }
    void loadSnapshot();
    connectEvents();
});

function updateAppHostValue() {
    elements.apphostValue.textContent =
        {
            "csharp-sdk": "C# SDK",
            "csharp-file": "File-based C#",
            typescript: "TypeScript",
        }[snapshot?.apphostStyle] ?? "Unknown";
}

function renderSummaryPills() {
    const resourceCount = snapshot.proposal.resources.filter((resource) => resource.include).length;
    const warningCount = (snapshot.proposal.assumptionsRisks ?? []).filter(
        (fact) => fact.severity === "warning" || fact.severity === "blocking",
    ).length;
    const decisionCount = (snapshot.proposal.decisions ?? []).filter(
        (decision) => decision.status === "needs-chat-decision",
    ).length;
    setSummaryPill(
        elements.pillResources,
        elements.countResources,
        elements.labelResources,
        resourceCount,
        "resource",
    );
    setSummaryPill(
        elements.pillWarnings,
        elements.countWarnings,
        elements.labelWarnings,
        warningCount,
        "warning",
    );
    setSummaryPill(
        elements.pillDecisions,
        elements.countDecisions,
        elements.labelDecisions,
        decisionCount,
        "chat decision",
    );
}

function setSummaryPill(pill, countElement, labelElement, count, label) {
    countElement.textContent = String(count);
    labelElement.textContent = `${label}${count === 1 ? "" : "s"}`;
    pill.dataset.zero = String(count === 0);
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
                proposalRequestPending = false;
                render(message.snapshot);
            }
        } catch {
            return;
        }
    };
    events.onopen = () => {
        clearInterval(fallbackPolling);
        fallbackPolling = undefined;
    };
    events.onerror = () => {
        void refreshSnapshot();
        fallbackPolling ??= setInterval(() => void refreshSnapshot(), 2000);
    };
}

async function post(path, body) {
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
    await refreshSnapshot();
    return payload;
}

async function runBusy(control, action) {
    elements.body.classList.add("is-busy");
    if (control) {
        control.disabled = true;
    }
    try {
        await action();
    } catch (error) {
        showInlineError(error);
    } finally {
        elements.body.classList.remove("is-busy");
        if (control) {
            if (control === elements.confirm) {
                control.disabled =
                    !snapshot?.proposalLoaded ||
                    snapshot?.proposalStale ||
                    confirmationIssues().length > 0 ||
                    snapshot?.confirmed;
            } else {
                control.disabled = false;
            }
        }
    }
}

async function requestProposal() {
    if (proposalRequestPending || !snapshot?.discoveryLoaded) {
        return;
    }
    proposalRequestPending = true;
    try {
        await post("/api/proposal/request", {});
    } catch (error) {
        showInlineError(error);
    } finally {
        proposalRequestPending = false;
    }
}

async function confirmSnapshot() {
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

function render(nextSnapshot) {
    const draw = () => {
        snapshot = nextSnapshot;
        if (snapshot.proposalError) {
            showProposalError(snapshot.proposalError);
            firstRender = false;
            return;
        }
        if (!snapshot.proposalLoaded || snapshot.proposalStale) {
            showProposalPending();
            if (
                snapshot.proposalRequestNeeded &&
                snapshot.discoveryLoaded &&
                !snapshot.proposalError
            ) {
                queueMicrotask(() => void requestProposal());
            }
            firstRender = false;
            return;
        }

        elements.body.classList.remove("is-loading", "is-busy");
        elements.body.classList.add("has-data");
        elements.skeleton.hidden = true;
        elements.error.hidden = true;
        elements.snapshot.hidden = false;
        elements.actionFooter.hidden = false;
        elements.apphostControl.hidden = !snapshot.apphostStyle;
        elements.proposalSummary.hidden = false;
        elements.body.classList.toggle("is-confirmed", snapshot.confirmed);
        updateAppHostValue();
        elements.planContent.hidden = false;
        renderProposalIdentity();
        renderSummaryPills();
        renderResourcePlan();
        renderExternalServices();
        renderAssumptionsAndRisks();
        renderDecisions();
        renderStatus();
        renderConfirmation();
        firstRender = false;
    };

    const prefersReducedMotion = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
    ).matches;
    if (
        !firstRender &&
        !prefersReducedMotion &&
        typeof document.startViewTransition === "function"
    ) {
        document.startViewTransition(draw);
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
    elements.resourceGroups.replaceChildren();
    const compact = (snapshot.presentationMode ?? (resources.length <= 2 ? "compact" : "relationship")) ===
        "compact";
    elements.compactResources.hidden = !compact;
    elements.resourceGroups.hidden = compact;
    elements.compactAddResource.hidden = !compact || snapshot.confirmed;
    if (compact) {
        for (const resource of resources) {
            elements.compactResources.append(
                renderCompactResource(resource, edges, resourceIssues[resource.id] ?? []),
            );
        }
        return;
    }

    for (const definition of RESOURCE_GROUPS) {
        const groupedResources = resources.filter((resource) =>
            definition.kinds.has(resourceKind(resource)),
        );
        if (!initializedGroups.has(definition.id)) {
            initializedGroups.add(definition.id);
            if (groupedResources.length === 0) {
                collapsedGroups.add(definition.id);
            }
        }
        const titleId = `resource-group-${definition.id}-title`;
        const group = createElement("section", {
            className: `resource-group resource-group-${definition.id}`,
            attrs: { "aria-labelledby": titleId },
        });
        const heading = createElement("div", { className: "resource-group-heading" });
        const bodyId = `resource-group-${definition.id}-body`;
        const body = createElement("div", {
            className: "resource-group-body",
            attrs: { id: bodyId },
        });
        body.hidden = collapsedGroups.has(definition.id);
        const toggle = createElement("button", {
            className: "resource-group-toggle",
            attrs: {
                type: "button",
                "aria-expanded": String(!body.hidden),
                "aria-controls": bodyId,
            },
        });
        toggle.append(
            createElement("span", {
                className: "resource-group-chevron",
                attrs: { "aria-hidden": "true" },
            }),
            createElement("span", { text: definition.title }),
        );
        const headingCopy = createElement("div", { className: "resource-group-copy" });
        const title = createElement("h2", {
            className: "resource-group-title",
            attrs: { id: titleId },
        });
        title.append(toggle);
        headingCopy.append(
            title,
            createElement("span", {
                className: "resource-group-description muted",
                text: definition.description,
            }),
        );
        toggle.addEventListener("click", () => {
            body.hidden = !body.hidden;
            toggle.setAttribute("aria-expanded", String(!body.hidden));
            if (body.hidden) {
                collapsedGroups.add(definition.id);
            } else {
                collapsedGroups.delete(definition.id);
            }
        });
        const headingActions = createElement("div", { className: "resource-group-heading-actions" });
        const add = createElement("button", {
            className: "btn btn-outline btn-icon resource-group-add",
            text: "+",
            title: definition.addTitle,
            attrs: {
                type: "button",
                "aria-label": `${definition.addTitle} in ${definition.title}`,
            },
        });
        add.hidden = snapshot.confirmed;
        add.addEventListener("click", () => openAddResourceDialog(definition.id));
        headingActions.append(
            createElement("span", {
                className: "resource-count",
                text: String(groupedResources.length),
                title: `${groupedResources.length} resource${
                    groupedResources.length === 1 ? "" : "s"
                }`,
            }),
            add,
        );
        heading.append(headingCopy, headingActions);
        const cards = createElement("div", { className: "resource-card-grid" });
        if (groupedResources.length === 0) {
            cards.append(
                createElement("div", {
                    className: "empty-resource-group muted",
                    text: "No resources in this section.",
                }),
            );
        } else {
            for (const resource of groupedResources) {
                cards.append(
                    renderResourceCard(resource, edges, resourceIssues[resource.id] ?? []),
                );
            }
        }
        body.append(cards);
        group.append(heading, body);
        elements.resourceGroups.append(group);
    }
}

function renderCompactResource(resource, edges, issues = []) {
    const service = serviceForResource(resource);
    const item = createElement("article", { className: "compact-resource review-item" });
    const header = createElement("div", { className: "compact-resource-header" });
    const identity = createElement("div", { className: "compact-resource-identity" });
    identity.append(
        createElement("h3", { text: `${resource.name} (${resource.type})` }),
        renderSourceMapping(resource, service),
    );
    const edit = createElement("button", {
        className: "btn btn-quiet btn-sm resource-edit",
        text: "Edit",
        title: `Edit ${resource.name}`,
        attrs: { type: "button", "aria-label": `Edit resource ${resource.name}` },
    });
    edit.hidden = snapshot.confirmed;
    edit.addEventListener("click", () => openResourceDialog(resource.id));
    const remove = createElement("button", {
        className: "btn btn-quiet btn-danger btn-sm resource-remove",
        text: "Remove",
        title: `Remove ${resource.name} from the proposal`,
        attrs: { type: "button", "aria-label": `Remove resource ${resource.name}` },
    });
    remove.hidden = snapshot.confirmed;
    remove.addEventListener("click", () => {
        if (window.confirm(`Remove ${resource.name} from this AppHost proposal?`)) {
            void deleteResourceById(resource.id, remove);
        }
    });
    const actions = createElement("div", { className: "compact-resource-actions" });
    actions.append(edit, remove);
    header.append(identity, actions);
    item.append(header);

    if (issues.length > 0) {
        item.append(renderResourceValidation(issues));
    }
    item.append(renderResourceFacts(resource, service));
    item.append(renderCompactConnections(resource, edges));
    return item;
}

function renderSourceMapping(resource, service) {
    const mapping = createElement("p", { className: "resource-mapping muted" });
    mapping.append(
        createElement("code", {
            text: service?.name || resource.sourceName || "Proposal addition",
        }),
        createElement("span", { className: "mapping-arrow", text: "→" }),
        createElement("code", { text: resource.name }),
        createElement("span", { text: `(${resource.type})` }),
    );
    return mapping;
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
    const sourceIdentity = service
        ? `${service.name}${service.id ? ` (${service.id})` : ""}`
        : resource.sourceName || "Added in proposal";
    appendFact(facts, "Source service", sourceIdentity);
    appendFact(facts, "Aspire resource", resource.name, true);
    appendFact(facts, "Aspire type", resource.type);

    const path = servicePathForDisplay(resource.path || service?.path);
    if (path) {
        appendFact(facts, "Path", path, true);
    }
    const command = resource.command || service?.command;
    if (command) {
        appendFact(facts, "Run command", command, true);
    }
    const ports = resource.ports?.length ? resource.ports : (service?.ports ?? []);
    if (ports.length) {
        appendFact(facts, "Ports", ports.map(formatPort).join(", "));
    }
    if (resource.packages?.length) {
        appendFact(facts, "Packages", resource.packages.map(formatPackage).join(", "), true);
    }

    const dotnet = isDotNetType(service?.type || resource.type);
    appendFact(
        facts,
        "Service Defaults",
        dotnet ? (resource.serviceDefaults ? "Enabled" : "Disabled") : "Not applicable",
    );
    appendFact(facts, "Service-code impact", formatServiceCodeImpact(resource, service));
    appendFact(facts, "Ownership", formatOwnership(resource, service));
    return facts;
}

function appendFact(list, label, value, code = false) {
    const row = createElement("div", { className: "resource-fact" });
    const valueElement = createElement("dd", { title: value || "" });
    valueElement.append(
        createElement(code ? "code" : "span", {
            className: "resource-fact-value",
            text: value || "Not supplied",
        }),
    );
    row.append(createElement("dt", { text: label }), valueElement);
    list.append(row);
}

function formatPort(port) {
    if (typeof port !== "object" || port === null) {
        return String(port);
    }
    const endpoint = [port.port, port.targetPort ? `→${port.targetPort}` : ""]
        .filter(Boolean)
        .join("");
    return [port.name, endpoint, port.protocol, port.purpose].filter(Boolean).join(" · ");
}

function formatPackage(package_) {
    return `${package_.name}${package_.version ? `@${package_.version}` : ""}`;
}

function formatServiceCodeImpact(resource, service) {
    const impact = resource.serviceCodeImpact?.summary || resource.serviceCodeImpact?.files?.length
        ? resource.serviceCodeImpact
        : service?.serviceCodeImpact;
    if (!impact || (!impact.summary && !impact.files?.length && impact.state === "unknown")) {
        return "Not supplied";
    }
    return [
        impact.state && impact.state !== "unknown" ? displayStatus(impact.state) : "",
        impact.summary,
        impact.files?.length ? impact.files.join(", ") : "",
    ]
        .filter(Boolean)
        .join(" · ");
}

function formatOwnership(resource, service) {
    const ownership = resource.ownership?.label || resource.ownership?.owner
        ? resource.ownership
        : service?.ownership;
    if (!ownership || (!ownership.label && !ownership.owner && ownership.kind === "unknown")) {
        return "Not supplied";
    }
    return [
        ownership.label,
        ownership.owner,
        ownership.kind !== "unknown" ? displayStatus(ownership.kind) : "",
    ]
        .filter(Boolean)
        .join(" · ");
}

function renderCompactConnections(resource, edges) {
    const section = createElement("div", { className: "compact-connections" });
    const relationships = relationshipsFor(resource, edges);
    section.append(createElement("strong", { text: "Connections" }));
    if (!relationships.length) {
        section.append(createElement("span", { className: "muted", text: "No direct connections" }));
        return section;
    }
    const chips = createElement("div", { className: "connection-chips" });
    for (const relationship of relationships) {
        const chip = createElement("button", {
            className: "connection-chip",
            text: relationshipText(relationship),
            attrs: { type: "button" },
        });
        chip.disabled = snapshot.confirmed;
        chip.addEventListener("click", () => openConnectionDialog(relationship.edge.id));
        chips.append(chip);
    }
    section.append(chips);
    return section;
}

function renderResourceCard(resource, edges, issues = []) {
    const service = serviceForResource(resource);
    const collapsed = collapsedCards.has(resource.id);
    const card = createElement("article", {
        className: `resource-card resource-${resourceKind(resource)}`,
    });
    const header = createElement("div", { className: "resource-card-header" });
    const bodyId = `resource-card-${String(resource.id).replace(/[^A-Za-z0-9_-]/g, "-")}-body`;
    const body = createElement("div", {
        className: "resource-card-body",
        attrs: { id: bodyId },
    });
    body.hidden = collapsed;
    const toggle = createElement("button", {
        className: "resource-card-toggle",
        attrs: {
            type: "button",
            "aria-expanded": String(!collapsed),
            "aria-controls": bodyId,
        },
    });
    toggle.append(
        createElement("span", {
            className: "resource-card-chevron",
            attrs: { "aria-hidden": "true" },
        }),
        createElement("span", { text: resource.name }),
    );
    const identity = createElement("div", { className: "resource-identity" });
    const title = createElement("h3");
    title.append(toggle);
    identity.append(
        title,
        renderSourceMapping(resource, service),
    );
    toggle.addEventListener("click", () => {
        body.hidden = !body.hidden;
        toggle.setAttribute("aria-expanded", String(!body.hidden));
        card.classList.toggle("is-collapsed", body.hidden);
        if (body.hidden) {
            collapsedCards.add(resource.id);
        } else {
            collapsedCards.delete(resource.id);
        }
    });
    const edit = createElement("button", {
        className: "btn btn-quiet btn-sm resource-edit",
        text: "Edit",
        title: `Edit ${resource.name}`,
        attrs: { type: "button", "aria-label": `Edit resource ${resource.name}` },
    });
    edit.hidden = snapshot.confirmed;
    edit.addEventListener("click", () => openResourceDialog(resource.id));
    header.append(identity, edit);
    card.classList.toggle("is-collapsed", collapsed);
    card.append(header);
    if (issues.length > 0) {
        const validationId = `${bodyId}-validation`;
        const validation = createElement("div", {
            className: "resource-validation",
            attrs: {
                id: validationId,
            },
        });
        validation.append(
            createElement("span", {
                className: "resource-validation-icon",
                text: "!",
                attrs: { "aria-hidden": "true" },
            }),
            createElement("span", {
                text: issues.join(" "),
            }),
        );
        toggle.setAttribute("aria-describedby", validationId);
        card.append(validation);
    }
    card.append(body);

    body.append(renderResourceFacts(resource, service));

    const relationships = relationshipsFor(resource, edges);
    const connectionSection = createElement("div", { className: "resource-connections" });
    connectionSection.append(
        createElement("div", { className: "connection-label", text: "Connections" }),
    );
    if (relationships.length === 0) {
        connectionSection.append(
            createElement("span", {
                className: "resource-independent muted",
                text: "No direct connections",
            }),
        );
    } else {
        const chips = createElement("div", { className: "connection-chips" });
        for (const relationship of relationships) {
            const chip = createElement("button", {
                className: "connection-chip",
                text: relationshipText(relationship),
                title: `Edit connection from ${relationship.edge.from} to ${relationship.edge.to}`,
                attrs: {
                    type: "button",
                    "aria-label": `Edit connection from ${relationship.edge.from} to ${relationship.edge.to}`,
                },
            });
            chip.disabled = snapshot.confirmed;
            chip.addEventListener("click", () => openConnectionDialog(relationship.edge.id));
            chips.append(chip);
        }
        connectionSection.append(chips);
    }
    body.append(connectionSection);
    return card;
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

function renderProposalIdentity() {
    const generatedAt = new Date(snapshot.proposal.generatedAt);
    const generatedLabel = Number.isNaN(generatedAt.getTime())
        ? "Generation time not supplied"
        : `Generated ${generatedAt.toLocaleString([], {
              dateStyle: "medium",
              timeStyle: "short",
          })}`;
    elements.proposalStateCopy.textContent = snapshot.confirmed
        ? "AppHost proposal confirmed — Implementation continues in chat."
        : "AppHost proposal awaiting confirmation";
    elements.proposalGeneratedAt.textContent = snapshot.confirmed
        ? `${generatedLabel} · Confirmed snapshot is read-only.`
        : `${generatedLabel} · No files have changed.`;
    elements.proposalGeneration.textContent = String(
        snapshot.confirmedGeneration ?? snapshot.proposalGeneration,
    );
    elements.proposalHash.textContent = shortHash(snapshot.proposalHash);
    elements.proposalHash.title = snapshot.proposalHash || "";
}

function renderExternalServices() {
    const mappedServiceIds = new Set(
        snapshot.proposal.resources
            .filter((resource) => resource.include)
            .map((resource) => resource.serviceId)
            .filter(Boolean),
    );
    const services = snapshot.services.filter(
        (service) =>
            service.ownership?.kind === "external-infrastructure" &&
            !mappedServiceIds.has(service.id),
    );
    elements.externalServicesSection.hidden = services.length === 0;
    elements.externalServices.replaceChildren();
    for (const service of services) {
        const item = createElement("article", { className: "review-item external-service" });
        item.append(
            createElement("strong", { text: service.name }),
            createElement("span", {
                className: "status-chip external",
                text: service.ownership.label || "External infrastructure",
            }),
        );
        const details = createElement("dl", { className: "resource-facts" });
        appendFact(details, "Source identity", `${service.name} (${service.id})`);
        appendFact(details, "Type", service.type);
        const path = servicePathForDisplay(service.path);
        if (path) {
            appendFact(details, "Path", path, true);
        }
        if (service.command) {
            appendFact(details, "Run command", service.command, true);
        }
        if (service.ports?.length) {
            appendFact(details, "Ports", service.ports.map(formatPort).join(", "));
        }
        appendFact(details, "Ownership", formatOwnership({}, service));
        item.append(details);
        elements.externalServices.append(item);
    }
}

function renderAssumptionsAndRisks() {
    const facts = snapshot.proposal.assumptionsRisks ?? [];
    elements.assumptionsSection.hidden = facts.length === 0;
    elements.assumptionsRisks.replaceChildren();
    for (const fact of facts) {
        const item = createElement("article", {
            className: `review-item proposal-fact severity-${fact.severity}`,
        });
        const heading = createElement("div", { className: "review-item-heading" });
        heading.append(
            createElement("strong", { text: fact.title || "Proposal fact" }),
            createElement("span", {
                className: `status-chip ${fact.severity}`,
                text: displayStatus(fact.severity),
            }),
            createElement("span", {
                className: `status-chip ${fact.verification}`,
                text: displayStatus(fact.verification),
            }),
        );
        item.append(heading);
        if (fact.detail) {
            item.append(createElement("p", { className: "muted", text: fact.detail }));
        }
        elements.assumptionsRisks.append(item);
    }
}

function renderDecisions() {
    const decisions = snapshot.proposal.decisions ?? [];
    elements.decisionsSection.hidden = decisions.length === 0;
    elements.decisions.replaceChildren();
    for (const decision of decisions) {
        const item = createElement("article", {
            className: `review-item proposal-decision ${decision.status}`,
        });
        const heading = createElement("div", { className: "review-item-heading" });
        heading.append(
            createElement("strong", { text: decision.title || "Implementation decision" }),
            createElement("span", {
                className: `status-chip ${decision.status}`,
                text: displayStatus(decision.status),
            }),
        );
        item.append(heading);
        if (decision.summary) {
            item.append(createElement("p", { className: "muted", text: decision.summary }));
        }
        elements.decisions.append(item);
    }
}

function displayStatus(value) {
    return String(value ?? "")
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
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
        elements.statusLine.textContent = snapshot.proposalError;
    } else if (snapshot.confirmed) {
        elements.statusLine.textContent = `Proposal generation ${
            snapshot.confirmedGeneration ?? snapshot.proposalGeneration
        } confirmed · ${shortHash(snapshot.proposalHash)} · Implementation continues in chat`;
    } else {
        const generatedAt = new Date(snapshot.proposal.generatedAt);
        const time = Number.isNaN(generatedAt.getTime())
            ? "time not supplied"
            : generatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        elements.statusLine.textContent = `AppHost proposal generated at ${time} — awaiting confirmation · ${
            includedResources.length
        } resource${includedResources.length === 1 ? "" : "s"} · ${activeEdges} connection${
            activeEdges === 1 ? "" : "s"
        }`;
    }
}

function renderConfirmation() {
    const issues = confirmationIssues();
    const resourceIssueCount = Object.keys(proposalValidation().resourceIssues).length;
    const nonResourceIssues = issues.filter((issue) => !issue.startsWith('Resource "'));
    elements.confirm.disabled =
        !snapshot.proposalLoaded || snapshot.proposalStale || issues.length > 0 || snapshot.confirmed;
    elements.confirm.textContent = snapshot.confirmed
        ? "Proposal confirmed"
        : "Confirm this AppHost proposal";
    elements.scopeSummary.textContent = confirmationScopeSummary();
    elements.footerNote.hidden = issues.length === 0 && !snapshot.confirmed;
    elements.footerNote.textContent = snapshot.confirmed
        ? "Implementation continues in chat."
        : resourceIssueCount
          ? `${resourceIssueCount} resource${resourceIssueCount === 1 ? "" : "s"} need attention before confirmation.${
                nonResourceIssues.length ? ` ${nonResourceIssues.join(" ")}` : ""
            }`
          : (issues[0] ?? "");
}

function confirmationScopeSummary() {
    const scope = snapshot.proposal.scope ?? {};
    const files = scope.appHostFiles ?? [];
    const packages = scope.integrationPackages ?? [];
    const impacts = scope.serviceCodeImpacts ?? [];
    const fileText = files.length ? files.join(", ") : "no AppHost files supplied";
    const packageText = packages.length
        ? packages.map(formatPackage).join(", ")
        : "no integration packages supplied";
    const impactText = impacts.length
        ? impacts
              .map((impact) =>
                  [
                      impact.serviceName || impact.serviceId || "service",
                      impact.state,
                      impact.summary,
                      impact.files?.length ? impact.files.join(", ") : "",
                  ]
                      .filter(Boolean)
                      .join(" · "),
              )
              .join("; ")
        : "no service-code impacts supplied";
    return `AppHost: ${fileText}. Packages: ${packageText}. Service code: ${impactText}.`;
}

function confirmationIssues() {
    if (!snapshot.proposalLoaded || snapshot.proposalStale) {
        return [];
    }
    return [...new Set(proposalValidation().issues)];
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
            resource.include &&
            resource.name.trim().toLowerCase() === name.toLowerCase(),
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
        input.reportValidity();
    }
    return issues.length === 0;
}

function openResourceDialog(resourceId) {
    if (snapshot.confirmed) {
        return;
    }
    const resource = snapshot.proposal.resources.find((candidate) => candidate.id === resourceId);
    if (!resource) {
        return;
    }
    const service = serviceForResource(resource);
    const group = resourceGroupDefinition(resource);
    clearDialogError(elements.resourceDialogError);
    elements.resourceType.disabled = Boolean(service);
    elements.resourceId.value = resource.id;
    elements.resourceName.value = resource.name;
    filterResourceTypeOptions(elements.resourceType, group.id);
    setSelectValue(elements.resourceType, resource.type);
    elements.resourceDialogDetail.textContent =
        [service?.name, service?.framework, service?.path].filter(Boolean).join(" · ") ||
        resource.detail ||
        group.resourceDescription;
    elements.resourceDefaults.checked = Boolean(resource.serviceDefaults);
    syncDefaultsField(
        elements.resourceType,
        elements.defaultsField,
        elements.resourceDefaults,
        false,
    );
    renderResourceDialogConnections(resource);
    validateResourceNameField(
        elements.resourceName,
        resource.id,
        elements.resourceDialogError,
    );
    elements.resourceDialog.showModal();
}

function renderResourceDialogConnections(resource) {
    elements.resourceConnections.replaceChildren();
    const resources = snapshot.proposal.resources.filter((candidate) => candidate.include);
    const resourceNames = new Set(resources.map((candidate) => candidate.name));
    const relationships = relationshipsFor(
        resource,
        snapshot.proposal.edges.filter(
            (edge) => resourceNames.has(edge.from) && resourceNames.has(edge.to),
        ),
    );
    elements.addResourceConnection.disabled = resources.length < 2;
    if (relationships.length === 0) {
        elements.resourceConnections.append(
            createElement("span", {
                className: "dialog-connection-empty muted",
                text: "No direct connections",
            }),
        );
        return;
    }
    for (const relationship of relationships) {
        const button = createElement("button", {
            className: "dialog-connection",
            attrs: { type: "button" },
        });
        button.append(
            createElement("span", { text: relationshipText(relationship) }),
            createElement("span", {
                className: "dialog-connection-edit muted",
                text: "Edit",
                attrs: { "aria-hidden": "true" },
            }),
        );
        button.addEventListener("click", () => {
            elements.resourceDialog.close();
            openConnectionDialog(relationship.edge.id);
        });
        elements.resourceConnections.append(button);
    }
}

function openResourceConnectionDialog() {
    const resource = snapshot.proposal.resources.find(
        (candidate) => candidate.id === elements.resourceId.value,
    );
    if (!resource) {
        return;
    }
    elements.resourceDialog.close();
    openConnectionDialog("", resource.name);
}

function setSelectValue(select, value) {
    const normalized = String(value ?? "").trim();
    for (const option of [...select.options]) {
        if (option.dataset.detected === "true") {
            option.remove();
        }
    }
    const existing = [...select.options].find((option) => option.value === normalized);
    if (!existing && normalized) {
        const option = new Option(`${normalized} (detected)`, normalized);
        option.dataset.detected = "true";
        select.prepend(option);
    }
    select.value = normalized;
}

async function saveResource(event) {
    event.preventDefault();
    const id = elements.resourceId.value;
    const resource = snapshot.proposal.resources.find((candidate) => candidate.id === id);
    if (!resource) {
        return;
    }
    if (
        !validateResourceNameField(
            elements.resourceName,
            id,
            elements.resourceDialogError,
            true,
        )
    ) {
        return;
    }
    await runBusy(event.submitter, async () => {
        await post("/api/proposal/resource", {
            id,
            name: elements.resourceName.value,
            type: elements.resourceType.value,
            serviceDefaults: elements.resourceDefaults.checked,
        });
        elements.resourceDialog.close();
    });
}

async function deleteResource() {
    const id = elements.resourceId.value;
    await deleteResourceById(id, elements.deleteResource, () => {
        elements.resourceDialog.close();
    });
}

async function deleteResourceById(id, control, onDeleted) {
    await runBusy(control, async () => {
        await post("/api/proposal/resource/delete", { id });
        onDeleted?.();
    });
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
    elements.addResourceGroup.value = groupId;
    elements.addResourceDialogTitle.textContent = definition.addTitle;
    elements.addResourceDialogDetail.textContent = definition.addDescription;
    filterResourceTypeOptions(elements.addResourceType, groupId);
    const firstOption = [...elements.addResourceType.options].find((option) => !option.disabled);
    elements.addResourceType.value = firstOption?.value ?? "";
    elements.addResourceDefaults.checked = elements.addResourceType.value === ".NET project";
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
        collapsedGroups.delete(elements.addResourceGroup.value);
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
    const row = createElement("div", { className: "add-connection-row" });
    const direction = createElement("select", {
        attrs: {
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
    elements.deleteConnection.hidden = !edge;
    elements.connectionDialog.showModal();
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

async function deleteConnection() {
    await runBusy(elements.deleteConnection, async () => {
        await post("/api/proposal/edge/delete", { id: elements.connectionId.value });
        elements.connectionDialog.close();
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
    const type = String(resource.type ?? "").toLowerCase();
    if (/next|vite|frontend|web/.test(type)) return "frontend";
    if (/\.net project|node|python|executable/.test(type)) return "project";
    if (/postgres|sql|database|mongo|cosmos/.test(type)) return "database";
    if (/redis|cache/.test(type)) return "cache";
    if (/rabbit|broker|service bus|messag/.test(type)) return "broker";
    if (/container|docker/.test(type)) return "container";
    return resource.serviceId ? "project" : "external";
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
            groupId === "all" ||
            option.dataset.group === groupId ||
            option.dataset.detected === "true";
        option.hidden = !matches;
        option.disabled = !matches;
    }
    for (const optgroup of select.querySelectorAll("optgroup")) {
        optgroup.hidden = [...optgroup.querySelectorAll("option")].every(
            (option) => option.hidden,
        );
    }
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
    elements.proposalSummary.hidden = true;
    elements.statusLine.textContent = "Receiving AppHost proposal snapshot…";
}

function showError(error) {
    elements.body.classList.remove("is-loading", "is-busy", "has-data");
    elements.skeleton.hidden = true;
    elements.snapshot.hidden = true;
    elements.actionFooter.hidden = true;
    elements.error.hidden = false;
    elements.apphostControl.hidden = true;
    elements.proposalSummary.hidden = true;
    elements.statusLine.textContent = "Proposal unavailable";
    elements.retry.textContent = "Try again";
    elements.errorMessage.textContent = error?.message ?? String(error);
}

function showProposalError(error) {
    showError(new Error(String(error ?? "Proposal generation failed.")));
    elements.statusLine.textContent = "Proposal generation failed";
    elements.retry.textContent = "Retry proposal";
}

function showInlineError(error) {
    const dialogError = [
        [elements.resourceDialog, elements.resourceDialogError],
        [elements.addResourceDialog, elements.addResourceDialogError],
        [elements.connectionDialog, elements.connectionDialogError],
    ].find(([dialog]) => dialog.open)?.[1];
    if (dialogError) {
        dialogError.textContent = error?.message ?? String(error);
        dialogError.hidden = false;
        dialogError.focus();
        return;
    }
    elements.footerNote.hidden = false;
    elements.footerNote.textContent = error?.message ?? String(error);
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
