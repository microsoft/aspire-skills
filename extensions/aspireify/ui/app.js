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
    actionFooter: document.getElementById("action-footer"),
    footerNote: document.getElementById("footer-note"),
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
    deleteConnection: document.getElementById("delete-connection"),
};

let snapshot;
let firstRender = true;
let pendingMutations = 0;
let mutationError = "";
const collapsedGroups = new Set();
const collapsedCards = new Set();
const initializedGroups = new Set();
document.addEventListener("DOMContentLoaded", () => {
    elements.retry.addEventListener("click", () => void retryProposalOrSnapshot());
    elements.confirm.addEventListener("click", () => void confirmSnapshot());
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
        elements.body.classList.toggle("is-confirmed", snapshot.confirmed);
        updateAppHostValue();
        elements.planContent.hidden = false;
        renderProposalIdentity();
        renderResourcePlan();
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
        const toggleCopy = createElement("span", { className: "resource-group-toggle-copy" });
        toggleCopy.append(
            createElement("span", {
                className: "resource-group-title",
                text: definition.title,
                attrs: { id: titleId },
            }),
            createElement("span", {
                className: "resource-group-description muted",
                text: definition.description,
            }),
        );
        toggle.append(
            createElement("span", {
                className: "resource-group-chevron",
                attrs: { "aria-hidden": "true" },
            }),
            toggleCopy,
        );
        const headingCopy = createElement("div", { className: "resource-group-copy" });
        headingCopy.append(toggle);
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
            title: `${definition.addTitle} to ${definition.title}`,
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
    identity.append(createElement("h3", { text: `${resource.name} (${resource.type})` }));
    const mapping = renderSourceMapping(resource, service);
    if (mapping) {
        identity.append(mapping);
    }
    const actions = createElement("div", { className: "compact-resource-actions" });
    actions.append(createRemoveResourceButton(resource));
    header.append(identity, actions);
    item.append(header);

    if (issues.length > 0) {
        item.append(renderResourceValidation(issues));
    }
    item.append(renderResourceFacts(resource, service));
    item.append(renderCompactConnections(resource, edges));
    return item;
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
        if (window.confirm(`Remove ${resource.name} from this AppHost proposal?`)) {
            void deleteResourceById(resource.id, remove);
        }
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
    if (service) {
        appendFact(
            facts,
            "Source service",
            `${service.name}${service.id ? ` (${service.id})` : ""}`,
        );
    }
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
        appendFact(facts, "Path", path, true);
    }
    appendEditableTextFact(facts, "Proposal detail", resource, "detail", resource.detail, {
        allowEmpty: true,
    });

    const dotnet = isDotNetType(resource.type);
    if (dotnet) {
        appendEditableDefaultsFact(facts, resource);
    }
    return facts;
}

function appendEditableTextFact(list, label, resource, field, value, options = {}) {
    const input = createElement("input", {
        className: "inline-resource-input",
        attrs: {
            value,
            type: "text",
            "aria-label": `${label} for ${resource.name}`,
            spellcheck: "false",
        },
    });
    input.disabled = snapshot.confirmed;
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            input.blur();
        }
    });
    input.addEventListener("change", () => {
        const nextValue = input.value.trim();
        const issues =
            options.validate?.(nextValue) ??
            (nextValue || options.allowEmpty ? [] : [`Enter ${label.toLowerCase()}.`]);
        input.setCustomValidity(issues.join(" "));
        if (issues.length) {
            input.reportValidity();
            return;
        }
        void saveInlineResourceField(resource, field, nextValue, input);
    });
    appendControlFact(list, label, input);
}

function appendEditableTypeFact(list, resource) {
    const select = createElement("select", {
        className: "inline-resource-input",
        attrs: { "aria-label": `Aspire type for ${resource.name}` },
    });
    const values = [
        resource.type,
        ...[...elements.addResourceType.options].map((option) => option.value),
    ].filter((value, index, all) => value && all.indexOf(value) === index);
    for (const value of values) {
        select.append(createElement("option", { text: value, attrs: { value } }));
    }
    select.value = resource.type;
    select.disabled = snapshot.confirmed;
    select.addEventListener("change", () => {
        void saveInlineResourceField(resource, "type", select.value, select);
    });
    appendControlFact(list, "Aspire type", select);
}

function appendEditableDefaultsFact(list, resource) {
    const control = createElement("label", { className: "inline-defaults-control" });
    const checkbox = createElement("input", {
        attrs: {
            type: "checkbox",
            "aria-label": `Service Defaults for ${resource.name}`,
        },
    });
    checkbox.checked = Boolean(resource.serviceDefaults);
    checkbox.disabled = snapshot.confirmed;
    control.append(
        checkbox,
        createElement("span", { text: checkbox.checked ? "Enabled" : "Disabled" }),
    );
    checkbox.addEventListener("change", () => {
        control.querySelector("span").textContent = checkbox.checked ? "Enabled" : "Disabled";
        void saveInlineResourceField(
            resource,
            "serviceDefaults",
            checkbox.checked,
            checkbox,
        );
    });
    appendControlFact(list, "Service Defaults", control);
}

function appendControlFact(list, label, control) {
    const row = createElement("div", { className: "resource-fact is-editable" });
    const valueElement = createElement("dd");
    valueElement.append(control);
    row.append(createElement("dt", { text: label }), valueElement);
    list.append(row);
}

async function saveInlineResourceField(resource, field, value, control) {
    const saved = await runBusy(control, async () => {
        await post("/api/proposal/resource", {
            id: resource.id,
            [field]: value,
        });
    });
    if (!saved) {
        if (control instanceof HTMLInputElement && control.type === "checkbox") {
            control.checked = Boolean(resource[field]);
            control.closest("label")?.querySelector("span")?.replaceChildren(
                control.checked ? "Enabled" : "Disabled",
            );
        } else {
            control.value = resource[field] ?? "";
        }
    }
}

function appendFact(list, label, value, code = false) {
    const row = createElement("div", { className: "resource-fact" });
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

function createConnectionHeading(resource) {
    const heading = createElement("div", { className: "connection-heading" });
    const add = createElement("button", {
        className: "btn btn-outline btn-icon connection-add",
        text: "+",
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
    const toggleCopy = createElement("span", { className: "resource-card-toggle-copy" });
    toggleCopy.append(createElement("span", { text: resource.name }));
    const mapping = renderSourceMapping(resource, service);
    if (mapping) {
        toggleCopy.append(mapping);
    }
    toggle.append(
        createElement("span", {
            className: "resource-card-chevron",
            attrs: { "aria-hidden": "true" },
        }),
        toggleCopy,
    );
    const identity = createElement("div", { className: "resource-identity" });
    const title = createElement("h3");
    title.append(toggle);
    identity.append(title);
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
    header.append(identity, createRemoveResourceButton(resource));
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
    connectionSection.append(createConnectionHeading(resource));
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
        !snapshot.proposalLoaded ||
        snapshot.proposalStale ||
        issues.length > 0 ||
        snapshot.confirmed ||
        pendingMutations > 0 ||
        Boolean(mutationError);
    elements.confirm.textContent = snapshot.confirmed ? "Confirmed" : "Confirm";
    elements.footerNote.hidden =
        !mutationError && issues.length === 0 && !snapshot.confirmed;
    elements.footerNote.textContent = mutationError
        ? mutationError
        : snapshot.confirmed
          ? "Implementation continues in chat."
          : resourceIssueCount
            ? `${resourceIssueCount} resource${resourceIssueCount === 1 ? "" : "s"} need attention before confirmation.${
                  nonResourceIssues.length ? ` ${nonResourceIssues.join(" ")}` : ""
              }`
            : (issues[0] ?? "");
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
    const edge = snapshot.proposal.edges.find(
        (candidate) => candidate.id === elements.connectionId.value,
    );
    if (
        !edge ||
        !window.confirm(`Remove the connection from ${edge.from} to ${edge.to}?`)
    ) {
        return;
    }
    await runBusy(elements.deleteConnection, async () => {
        await post("/api/proposal/edge/delete", { id: edge.id });
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
    elements.statusLine.textContent = "Receiving AppHost proposal snapshot…";
}

function showError(error) {
    elements.body.classList.remove("is-loading", "is-busy", "has-data");
    elements.skeleton.hidden = true;
    elements.snapshot.hidden = true;
    elements.actionFooter.hidden = true;
    elements.error.hidden = false;
    elements.apphostControl.hidden = true;
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
