const AUTH_HEADER = "x-aspire-app-model-token";
const apiToken = new URLSearchParams(window.location.search).get("token") || "";

const els = {
    body: document.body,
    subtitle: document.getElementById("app-subtitle"),
    connectionDot: document.getElementById("connection-dot"),
    connectionStatus: document.getElementById("connection-status"),
    workspaceMode: document.getElementById("workspace-mode"),
    globalMode: document.getElementById("global-mode"),
    refreshButton: document.getElementById("refresh-button"),
    searchInput: document.getElementById("search-input"),
    hiddenCheckbox: document.getElementById("hidden-checkbox"),
    freshness: document.getElementById("freshness"),
    statusBanner: document.getElementById("status-banner"),
    statusTitle: document.getElementById("status-title"),
    statusMessage: document.getElementById("status-message"),
    statusAction: document.getElementById("status-action"),
    loadingTree: document.getElementById("loading-tree"),
    emptyState: document.getElementById("empty-state"),
    emptyTitle: document.getElementById("empty-title"),
    emptyMessage: document.getElementById("empty-message"),
    emptyAction: document.getElementById("empty-action"),
    tree: document.getElementById("apphost-tree"),
    actionMenu: document.getElementById("action-menu"),
    toastRegion: document.getElementById("toast-region"),
    pipelineDialog: document.getElementById("pipeline-dialog"),
    pipelineStepInput: document.getElementById("pipeline-step-input"),
    pipelineStepOptions: document.getElementById("pipeline-step-options"),
    pipelineError: document.getElementById("pipeline-error"),
};

const ICONS = {
    chevron: "M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z",
    "apphost-running": "M1.75 2h12.5C15.216 2 16 2.784 16 3.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25v-8.5C0 2.784.784 2 1.75 2Zm0 1.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM4 5.5h8v1.5H4Zm0 3h8V10H4Z",
    "apphost-idle": "M2.75 1h7.5C11.216 1 12 1.784 12 2.75V4h1.25C14.216 4 15 4.784 15 5.75v7.5A1.75 1.75 0 0 1 13.25 15h-7.5A1.75 1.75 0 0 1 4 13.25V12H2.75A1.75 1.75 0 0 1 1 10.25v-7.5C1 1.784 1.784 1 2.75 1Zm0 1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25H4V5.75C4 4.784 4.784 4 5.75 4h4.75V2.75a.25.25 0 0 0-.25-.25Zm3 3a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z",
    folder: "M1.75 2h4.158c.464 0 .91.184 1.238.513L8.634 4h5.616c.966 0 1.75.784 1.75 1.75v6.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25v-8.5C0 2.784.784 2 1.75 2Zm0 1.5a.25.25 0 0 0-.25.25V5h13v-.25a.25.25 0 0 0-.25-.25H8.634a1.75 1.75 0 0 1-1.238-.513L5.908 2.5Zm12.75 3h-13v5.75c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25Z",
    "folder-running": "M1.75 2h4.158c.464 0 .91.184 1.238.513L8.634 4h5.616c.966 0 1.75.784 1.75 1.75v6.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25v-8.5C0 2.784.784 2 1.75 2Zm4.5 4.4v4.2L10 8.5Z",
    layers: "M8.37.086a.75.75 0 0 0-.74 0l-6.5 3.75a.75.75 0 0 0 0 1.299l6.5 3.75a.75.75 0 0 0 .74 0l6.5-3.75a.75.75 0 0 0 0-1.3ZM8 1.602l4.995 2.883L8 7.368 3.005 4.485Zm-6.87 7.37 6.5 3.75a.75.75 0 0 0 .74 0l6.5-3.75a.75.75 0 0 0-.75-1.299L8 11.206 1.88 7.673a.75.75 0 1 0-.75 1.299Zm0 3.136 6.5 3.75a.75.75 0 0 0 .74 0l6.5-3.75a.75.75 0 0 0-.75-1.299L8 14.342l-6.12-3.533a.75.75 0 1 0-.75 1.299Z",
    resource: "M1.75 1h4.5C7.216 1 8 1.784 8 2.75v4.5A1.75 1.75 0 0 1 6.25 9h-4.5A1.75 1.75 0 0 1 0 7.25v-4.5C0 1.784.784 1 1.75 1Zm8 0h4.5C15.216 1 16 1.784 16 2.75v4.5A1.75 1.75 0 0 1 14.25 9h-4.5A1.75 1.75 0 0 1 8 7.25v-4.5C8 1.784 8.784 1 9.75 1Zm-8 9h4.5C7.216 10 8 10.784 8 11.75v2.5A1.75 1.75 0 0 1 6.25 16h-4.5A1.75 1.75 0 0 1 0 14.25v-2.5C0 10.784.784 10 1.75 10Zm8 0h4.5c.966 0 1.75.784 1.75 1.75v2.5A1.75 1.75 0 0 1 14.25 16h-4.5A1.75 1.75 0 0 1 8 14.25v-2.5C8 10.784 8.784 10 9.75 10Z",
    endpoint: "M1.75 3.5h12.5a.25.25 0 0 1 .25.25v8.5a.25.25 0 0 1-.25.25H1.75a.25.25 0 0 1-.25-.25v-8.5a.25.25 0 0 1 .25-.25ZM1.75 2A1.75 1.75 0 0 0 0 3.75v8.5C0 13.216.784 14 1.75 14h12.5A1.75 1.75 0 0 0 16 12.25v-8.5A1.75 1.75 0 0 0 14.25 2Zm2.72 3.47a.75.75 0 0 1 1.06 0l2 2a.75.75 0 0 1 0 1.06l-2 2a.75.75 0 0 1-1.06-1.06L5.94 8 4.47 6.53a.75.75 0 0 1 0-1.06ZM8.75 9.5h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1 0-1.5Z",
    link: "M7.775 3.275a.75.75 0 0 0 1.06 1.06l.25-.25a2 2 0 1 1 2.83 2.83l-2.5 2.5a2 2 0 0 1-2.83 0 .75.75 0 0 0-1.06 1.06 3.5 3.5 0 0 0 4.95 0l2.5-2.5a3.5 3.5 0 0 0-4.95-4.95l-.25.25Zm-4.75 4.75a3.5 3.5 0 0 1 4.95 0 .75.75 0 0 1-1.06 1.06 2 2 0 0 0-2.83 0l-2.5 2.5a2 2 0 1 0 2.83 2.83l.25-.25a.75.75 0 1 1 1.06 1.06l-.25.25a3.5 3.5 0 0 0-4.95-4.95l2.5-2.5Zm2.47 2.47a.75.75 0 0 1 1.06 0l2.95-2.95a.75.75 0 1 1 1.06 1.06l-2.95 2.95a.75.75 0 0 1-1.06-1.06Z",
    dashboard: "M1.75 2h12.5C15.216 2 16 2.784 16 3.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25v-8.5C0 2.784.784 2 1.75 2Zm.75 1.5v9h11v-9Zm2 6.25a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1-.75-.75Zm4-2a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1-.75-.75Z",
    heart: "M7.655 14.916v-.001l-.003-.002-.01-.006-.033-.02a22 22 0 0 1-1.468-.946 22 22 0 0 1-3.24-2.536C1.254 9.832 0 7.92 0 5.58 0 2.898 1.906 1 4.25 1 5.566 1 6.87 1.61 8 2.692 9.13 1.61 10.434 1 11.75 1 14.094 1 16 2.898 16 5.58c0 2.34-1.254 4.252-2.901 5.825a22 22 0 0 1-3.24 2.536 22 22 0 0 1-1.468.946l-.033.02-.01.006-.003.002-.001.001a.75.75 0 0 1-.689 0Z",
    pass: "M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z",
    warning: "M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.383c.62 1.161-.223 2.57-1.543 2.57H1.918c-1.32 0-2.163-1.409-1.543-2.57Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.137a.25.25 0 0 0 .22.363h12.164a.25.25 0 0 0 .22-.363Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z",
    error: "M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.75.75 0 0 0-1.042.018.75.75 0 0 0-.018 1.042L6.94 8 4.97 9.97a.75.75 0 1 0 1.06 1.06L8 9.06l1.97 1.97a.75.75 0 0 0 1.06-1.06L9.06 8l1.97-1.97a.75.75 0 0 0-1.06-1.06L8 6.94Z",
    record: "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Z",
    loading: "M8 0a8 8 0 0 1 8 8h-1.5A6.5 6.5 0 0 0 8 1.5Z",
    terminal: "M1.75 2h12.5C15.216 2 16 2.784 16 3.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25v-8.5C0 2.784.784 2 1.75 2Zm.75 1.5v9h11v-9ZM4.47 5.47a.75.75 0 0 1 1.06 0l2 2a.75.75 0 0 1 0 1.06l-2 2a.75.75 0 0 1-1.06-1.06L5.94 8 4.47 6.53a.75.75 0 0 1 0-1.06ZM8.75 9.5h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1 0-1.5Z",
    play: "M4.25 2.5a.75.75 0 0 1 1.142-.638l8.5 5.25a.75.75 0 0 1 0 1.276l-8.5 5.25A.75.75 0 0 1 4.25 13Z",
    stop: "M3.75 2h8.5C13.216 2 14 2.784 14 3.75v8.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Z",
    restart: "M8 2.5a5.5 5.5 0 1 0 5.478 6.03.75.75 0 0 1 1.492.148A7 7 0 1 1 8 1c1.79 0 3.42.67 4.66 1.77V1.75a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-.75.75h-3.5a.75.75 0 0 1 0-1.5h1.72A5.48 5.48 0 0 0 8 2.5Z",
    tools: "M4.25 1a.75.75 0 0 1 .75.75v1.043l2.146 2.146a3.5 3.5 0 0 1 3.915 3.915L14.78 12.57a1.562 1.562 0 0 1-2.21 2.21l-3.716-3.719a3.5 3.5 0 0 1-3.915-3.915L2.793 5H1.75a.75.75 0 0 1 0-1.5H3.5V1.75A.75.75 0 0 1 4.25 1Z",
    run: "M1.75 2h12.5C15.216 2 16 2.784 16 3.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25v-8.5C0 2.784.784 2 1.75 2Zm4.5 3.4v5.2L11 8Z",
    source: "M3.75 1h5.5c.199 0 .39.079.53.22l3 3c.141.14.22.331.22.53v9.5A1.75 1.75 0 0 1 11.25 16h-7.5A1.75 1.75 0 0 1 2 14.25V2.75C2 1.784 2.784 1 3.75 1Zm0 1.5a.25.25 0 0 0-.25.25v11.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25V6H9.25A1.25 1.25 0 0 1 8 4.75V2.5Z",
    deploy: "M8 0a5 5 0 0 0-4.9 4H3a3 3 0 0 0 0 6h3V8.56L4.53 10.03a.75.75 0 0 1-1.06-1.06l2.75-2.75a.75.75 0 0 1 1.06 0l2.75 2.75a.75.75 0 1 1-1.06 1.06L7.5 8.56V16H9v-6h4a3 3 0 0 0 .9-5.862A5 5 0 0 0 8 0Z",
    package: "M7.73.073a.75.75 0 0 1 .54 0l6.5 2.5a.75.75 0 0 1 .48.7v9.454a.75.75 0 0 1-.48.7l-6.5 2.5a.75.75 0 0 1-.54 0l-6.5-2.5a.75.75 0 0 1-.48-.7V3.273a.75.75 0 0 1 .48-.7ZM2.25 4.365v7.847l5 1.923V6.288Zm6.5 9.77 5-1.923V4.365l-5 1.923Zm-.75-9.16 4.408-1.696L8 1.584 3.592 3.279Z",
    steps: "M2.75 1.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5ZM2.75 6.75A1.25 1.25 0 1 0 2.75 9.25 1.25 1.25 0 0 0 2.75 6.75ZM1.5 13.25a1.25 1.25 0 1 1 2.5 0 1.25 1.25 0 0 1-2.5 0ZM6 2.75A.75.75 0 0 1 6.75 2h7.5a.75.75 0 0 1 0 1.5h-7.5A.75.75 0 0 1 6 2.75ZM6 8a.75.75 0 0 1 .75-.75h7.5a.75.75 0 0 1 0 1.5h-7.5A.75.75 0 0 1 6 8Zm0 5.25a.75.75 0 0 1 .75-.75h7.5a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1-.75-.75Z",
    ask: "M8 0a8 8 0 0 0-6.74 12.32L.22 15.03a.75.75 0 0 0 .97.97l2.71-1.04A8 8 0 1 0 8 0Zm-2.25 7.25a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1-.75-.75Zm0-2.5A.75.75 0 0 1 6.5 4h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1-.75-.75Zm0 5a.75.75 0 0 1 .75-.75h1.25a.75.75 0 0 1 0 1.5H6.5a.75.75 0 0 1-.75-.75Z",
    more: "M3 8a1.25 1.25 0 1 1-2.5 0A1.25 1.25 0 0 1 3 8Zm6.25 0a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm6.25 0A1.25 1.25 0 1 1 13 8a1.25 1.25 0 0 1 2.5 0Z",
};

const ACTIONS = {
    source: { label: "Open AppHost source", shortLabel: "Source", icon: "source" },
    dashboard: { label: "Open dashboard", shortLabel: "Dashboard", icon: "dashboard" },
    run: { label: "Run AppHost", shortLabel: "Run", icon: "play" },
    stop: { label: "Stop AppHost", shortLabel: "Stop", icon: "stop" },
    deploy: { label: "Deploy AppHost", shortLabel: "Deploy", icon: "deploy" },
    publish: { label: "Publish AppHost", shortLabel: "Publish", icon: "package" },
    "pipeline-step": { label: "Run pipeline step", shortLabel: "Pipeline step", icon: "steps" },
    ask: { label: "Ask Copilot about this item", shortLabel: "Ask Copilot", icon: "ask" },
};

const APPHOST_ACTION_ORDER = {
    "apphost-running": ["dashboard", "stop", "deploy", "publish", "pipeline-step", "source"],
    "apphost-idle": ["run", "deploy", "publish", "pipeline-step", "source"],
};

const CONFIRMATIONS = {
    stop: {
        title: (label) => `Stop ${label}?`,
        detail: "This will stop the AppHost and its resources.",
        confirmLabel: "Stop AppHost",
    },
    deploy: {
        title: (label) => `Deploy ${label}?`,
        detail: "This may update the AppHost's target environment.",
        confirmLabel: "Deploy",
    },
    publish: {
        title: (label) => `Publish ${label}?`,
        detail: "This will generate deployment artifacts.",
        confirmLabel: "Publish",
    },
};

let modelState = null;
let filterText = "";
let selectedNodeId = null;
let activeCommandId = null;
let requestCount = 0;
let commandRunning = false;
let actionMenuNodeId = null;
let pipelineAppHostId = null;
let secretWarningAccepted = false;
let pendingConfirmation = null;
let confirmationNeedsFocus = false;
let renderedViewMode = null;
const expandedIds = new Set();
const initializedIds = new Set();
const commandDrafts = new Map();
const commandInputs = new Map();
const commandResults = new Map();
const commandValidationErrors = new Map();
const dynamicLoadTimers = new Map();
const dynamicLoadGenerations = new Map();
const dynamicLoadingIds = new Set();
let renderedRowIndex = 0;
let renderedSelectionVisible = false;

function element(tag, properties = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(properties)) {
        if (value === undefined || value === null) {
            continue;
        }
        if (key === "class") {
            node.className = value;
        } else if (key === "text") {
            node.textContent = value;
        } else if (key === "dataset") {
            Object.assign(node.dataset, value);
        } else if (key === "on") {
            for (const [eventName, handler] of Object.entries(value)) {
                node.addEventListener(eventName, handler);
            }
        } else if (key in node && !key.startsWith("aria-")) {
            node[key] = value;
        } else {
            node.setAttribute(key, String(value));
        }
    }
    for (const child of [].concat(children)) {
        if (child === undefined || child === null) {
            continue;
        }
        node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
}

function svgIcon(name, size = 16) {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("d", ICONS[name] || ICONS.resource);
    svg.appendChild(path);
    return svg;
}

async function api(path, { method = "GET", body } = {}) {
    requestCount++;
    updateBusy();
    try {
        const response = await fetch(path, {
            method,
            headers: {
                [AUTH_HEADER]: apiToken,
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        let payload;
        try {
            payload = await response.json();
        } catch {
            payload = { ok: false, error: `Canvas service returned HTTP ${response.status}.` };
        }
        if (!response.ok && !payload.validationErrors) {
            throw new Error(payload.error || `Canvas service returned HTTP ${response.status}.`);
        }
        return payload;
    } finally {
        requestCount--;
        updateBusy();
    }
}

function updateBusy() {
    const busy = requestCount > 0 || commandRunning || modelState?.refreshing === true;
    els.body.classList.toggle("is-busy", busy);
    els.refreshButton.disabled = requestCount > 0;
}

function formatAge(value) {
    if (!value) {
        return "";
    }
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) {
        return "";
    }
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 5) {
        return "Updated now";
    }
    if (seconds < 60) {
        return `Updated ${seconds}s ago`;
    }
    return `Updated ${Math.floor(seconds / 60)}m ago`;
}

function showToast(message, error = false) {
    const toast = element("div", { class: `toast${error ? " is-error" : ""}`, text: message });
    els.toastRegion.appendChild(toast);
    setTimeout(() => toast.remove(), 4_500);
}

function setModeButtons() {
    const workspace = modelState?.viewMode !== "global";
    els.workspaceMode.classList.toggle("is-active", workspace);
    els.workspaceMode.setAttribute("aria-pressed", String(workspace));
    els.globalMode.classList.toggle("is-active", !workspace);
    els.globalMode.setAttribute("aria-pressed", String(!workspace));
}

function nodeMatchesFilter(node, query) {
    return [node.label, node.description, node.statusLabel]
        .some((value) => String(value ?? "").toLowerCase().includes(query));
}

function filterMatchCount(nodes, query) {
    let count = 0;
    for (const node of nodes) {
        if (nodeMatchesFilter(node, query)) {
            count++;
        }
        count += filterMatchCount(node.children ?? [], query);
    }
    return count;
}

function updateHeader() {
    const summary = modelState?.summary;
    const mode = modelState?.viewMode === "global" ? "Global" : "Workspace";
    const parts = [mode];
    const query = filterText.trim().toLowerCase();
    if (query) {
        const count = filterMatchCount(modelState?.roots ?? [], query);
        parts.push(`${count} match${count === 1 ? "" : "es"}`);
    } else {
        if (summary?.running) {
            parts.push(`${summary.running} running`);
        }
        if (summary?.idle) {
            parts.push(`${summary.idle} idle`);
        }
        if (summary?.resources) {
            parts.push(`${summary.resources} resources`);
        }
    }
    els.subtitle.textContent = parts.join(" · ");
    els.freshness.textContent = formatAge(modelState?.lastSuccessfulAt);
    els.hiddenCheckbox.checked = modelState?.includeHidden === true;
    setModeButtons();

    els.connectionDot.className = "connection-dot";
    if (modelState?.status === "ready") {
        els.connectionDot.classList.add("is-live");
        els.connectionStatus.textContent = "AppHost data is live";
    } else if (modelState?.stale) {
        els.connectionDot.classList.add("is-stale");
        els.connectionStatus.textContent = "AppHost data may be stale";
    } else if (modelState?.status === "error") {
        els.connectionDot.classList.add("is-error");
        els.connectionStatus.textContent = "AppHost data is unavailable";
    } else {
        els.connectionStatus.textContent = "Connecting to AppHost data";
    }
}

function updateStatus() {
    els.statusBanner.hidden = true;
    els.statusBanner.classList.remove("is-error");
    if (!modelState?.error) {
        return;
    }
    els.statusBanner.hidden = false;
    const fatal = modelState.status === "error";
    els.statusBanner.classList.toggle("is-error", fatal);
    els.statusTitle.textContent = fatal
        ? "AppHost data unavailable"
        : modelState.stale
            ? "Showing stale AppHost data"
            : "Some AppHosts could not be refreshed";
    els.statusMessage.textContent = modelState.error;
}

function updateEmptyAndLoading() {
    const roots = modelState?.roots ?? [];
    const loading = (!modelState || modelState.status === "loading") && roots.length === 0;
    els.loadingTree.hidden = !loading;
    els.tree.hidden = loading || roots.length === 0;
    els.emptyState.hidden = loading || roots.length > 0;
    if (loading || roots.length > 0) {
        return;
    }
    if (modelState?.status === "error") {
        els.emptyTitle.textContent = "Couldn't load AppHosts";
        els.emptyMessage.textContent = modelState.error || "Check the Aspire CLI and refresh.";
    } else if (modelState?.viewMode === "global") {
        els.emptyTitle.textContent = "No running AppHosts";
        els.emptyMessage.textContent = "Global mode shows Aspire AppHosts currently running on this machine.";
    } else {
        els.emptyTitle.textContent = "No workspace AppHosts";
        els.emptyMessage.textContent = "Add or configure an Aspire AppHost in this workspace, then refresh.";
    }
}

function filteredTree(nodes, query) {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
        return nodes;
    }
    return nodes
        .map((node) => {
            const children = filteredTree(node.children ?? [], normalized);
            const matches = nodeMatchesFilter(node, normalized);
            return matches || children.length > 0
                ? { ...node, filterExpanded: children.length > 0, children }
                : null;
        })
        .filter(Boolean);
}

function initializeExpansion(node) {
    if (initializedIds.has(node.id)) {
        return;
    }
    initializedIds.add(node.id);
    if (node.defaultExpanded) {
        expandedIds.add(node.id);
    }
}

function findNode(nodeId, nodes = modelState?.roots ?? []) {
    for (const node of nodes) {
        if (node.id === nodeId) {
            return node;
        }
        const found = findNode(nodeId, node.children ?? []);
        if (found) {
            return found;
        }
    }
    return null;
}

function setSelected(node) {
    if (pendingConfirmation?.nodeId !== node.id) {
        pendingConfirmation = null;
    }
    selectedNodeId = node.id;
    void api("/api/selection", { method: "POST", body: { nodeId: node.id } }).catch(() => {});
    renderTree();
    requestAnimationFrame(() => focusTreeRow(
        els.tree.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`),
    ));
}

function toggleExpanded(node) {
    if (!node.children?.length) {
        return;
    }
    if (expandedIds.has(node.id)) {
        expandedIds.delete(node.id);
    } else {
        expandedIds.add(node.id);
    }
    renderTree();
}

function actionButton(label, iconName, handler) {
    return element("button", {
        class: "row-action",
        type: "button",
        title: label,
        "aria-label": label,
        on: {
            click: (event) => {
                event.stopPropagation();
                handler(event);
            },
        },
    }, [svgIcon(iconName, 14)]);
}

function isAppHostNode(node) {
    return node.kind === "apphost-running" || node.kind === "apphost-idle";
}

function rowActions(node, level, selected) {
    const actions = [];
    if (node.kind === "endpoint" && node.href) {
        actions.push(actionButton("Open endpoint", "link", () => {
            window.open(node.href, "_blank", "noopener,noreferrer");
        }));
    }
    if (isAppHostNode(node)) {
        const trayVisible = selected || (level === 1 && (modelState?.roots?.length ?? 0) === 1);
        if (!node.operation && (modelState?.roots?.length ?? 0) > 1) {
            actions.push(element("button", {
                class: "row-action row-action-label",
                type: "button",
                text: "Actions",
                title: `${trayVisible ? "Showing" : "Show"} actions for ${node.label}`,
                "aria-label": `${trayVisible ? "Showing" : "Show"} actions for ${node.label}`,
                "aria-expanded": trayVisible,
                on: {
                    click: (event) => {
                        event.stopPropagation();
                        setSelected(node);
                    },
                },
            }));
        }
        return element("span", { class: "row-actions" }, actions);
    }
    const hasMenu = ["resource", "health-check", "command"].includes(node.kind);
    if (hasMenu) {
        actions.push(actionButton("More actions", "more", (event) => openActionMenu(node, event.currentTarget)));
    }
    return element("span", { class: "row-actions" }, actions);
}

function requestNodeAction(action, node) {
    if (CONFIRMATIONS[action]) {
        pendingConfirmation = { nodeId: node.id, action };
        confirmationNeedsFocus = true;
        renderTree();
        return;
    }
    void executeNodeAction(action, node);
}

function trayAction(action, node) {
    const definition = ACTIONS[action];
    const enabled = action === "ask" || node.actions?.includes(action);
    const unavailableReason = node.unavailableActionReason || "This action is not available in the current context.";
    const accessibleLabel = enabled
        ? `${definition.label} for ${node.label}`
        : `${definition.label} for ${node.label}. Unavailable: ${unavailableReason}`;
    const primary = action === "run" || action === "dashboard";
    const danger = action === "stop";
    const copilot = action === "ask";
    return element("button", {
        class:
            `tray-action${primary ? " is-primary" : ""}${danger ? " is-danger" : ""}${copilot ? " is-copilot" : ""}`,
        type: "button",
        title: accessibleLabel,
        "aria-label": accessibleLabel,
        disabled: !enabled,
        on: { click: () => requestNodeAction(action, node) },
    }, [
        svgIcon(definition.icon, 14),
        element("span", { text: definition.shortLabel }),
    ]);
}

function actionGroup(label, actions, node) {
    if (actions.length === 0) {
        return null;
    }
    return element("span", {
        class: "tray-action-group",
        role: "group",
        "aria-label": label,
    }, actions.map((action) => trayAction(action, node)));
}

function cancelConfirmation(node) {
    pendingConfirmation = null;
    renderTree();
    requestAnimationFrame(() => focusTreeRow(
        els.tree.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`),
    ));
}

function renderAppHostConfirmation(node, action) {
    const confirmation = CONFIRMATIONS[action];
    const danger = action === "stop";
    return element("div", {
        class: `apphost-confirmation${danger ? " is-danger" : ""}`,
        role: "group",
        "aria-label": confirmation.title(node.label),
    }, [
        element("span", { class: "confirmation-icon" }, [svgIcon(danger ? "warning" : ACTIONS[action].icon, 15)]),
        element("span", { class: "confirmation-copy" }, [
            element("strong", { text: confirmation.title(node.label) }),
            element("span", { text: confirmation.detail }),
        ]),
        element("span", { class: "confirmation-actions" }, [
            element("button", {
                class: "button button-secondary button-small",
                type: "button",
                text: "Cancel",
                on: { click: () => cancelConfirmation(node) },
            }),
            element("button", {
                class: `button button-small${danger ? " button-danger" : " button-primary"}`,
                type: "button",
                text: confirmation.confirmLabel,
                dataset: { confirmAction: action },
                on: {
                    click: () => {
                        pendingConfirmation = null;
                        void executeNodeAction(action, node);
                    },
                },
            }),
        ]),
    ]);
}

function renderAppHostActionTray(node, level, selected) {
    if (!isAppHostNode(node)) {
        return null;
    }
    const visible = selected || (level === 1 && (modelState?.roots?.length ?? 0) === 1);
    if (!visible && !node.operation) {
        return null;
    }
    if (node.operation) {
        return element("div", { class: "apphost-action-tray is-busy" }, [
            element("span", { class: "tray-busy-icon" }, [svgIcon("loading", 14)]),
            element("span", { text: node.operation.label }),
        ]);
    }
    if (pendingConfirmation?.nodeId === node.id) {
        return element("div", { class: "apphost-action-tray is-confirming" }, [
            renderAppHostConfirmation(node, pendingConfirmation.action),
        ]);
    }
    const ordered = (APPHOST_ACTION_ORDER[node.kind] ?? [])
        .filter((action) => action !== "source" || node.actions?.includes("source"));
    const primaryActions = ordered.filter((action) => ["run", "dashboard", "source"].includes(action));
    const operationalActions = ordered.filter((action) => !primaryActions.includes(action));
    return element("div", {
        class: "apphost-action-tray",
        "aria-label": `${node.label} actions`,
    }, [
        ...(node.unavailableActionReason ? [element("p", {
            class: "tray-notice",
            text: node.unavailableActionReason,
        })] : []),
        actionGroup("Open and run", primaryActions, node),
        actionGroup("Lifecycle and deployment", operationalActions, node),
        actionGroup("Copilot", ["ask"], node),
    ]);
}

function rowIcon(node) {
    const icon = node.operation ? "restart" : node.icon || "resource";
    return element("span", {
        class: `tree-icon icon-${node.icon || "resource"}${node.tone ? ` tone-${node.tone}` : ""}${node.operation || node.icon === "loading" ? " is-spinning" : ""}`,
    }, [svgIcon(icon, 15)]);
}

function renderNode(node, level) {
    initializeExpansion(node);
    const hasChildren = (node.children?.length ?? 0) > 0;
    const expanded = hasChildren && (node.filterExpanded || expandedIds.has(node.id));
    const selected = node.id === selectedNodeId;
    const childGroupId = `tree-children-${node.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
    const tabbable = selected || (!renderedSelectionVisible && renderedRowIndex === 0);
    renderedRowIndex++;
    const row = element("div", {
        class: `tree-row${selected ? " is-selected" : ""}${node.operation ? " is-busy" : ""}`,
        role: "treeitem",
        tabIndex: tabbable ? 0 : -1,
        "aria-level": level,
        "aria-selected": selected,
        ...(hasChildren ? { "aria-expanded": expanded } : {}),
        ...(expanded ? { "aria-owns": childGroupId } : {}),
        dataset: { nodeId: node.id },
        on: {
            click: (event) => {
                if (event.target.closest("button, a, input, select")) {
                    return;
                }
                setSelected(node);
            },
            keydown: (event) => handleTreeKey(event, node),
        },
    }, [
        hasChildren
            ? element("button", {
                class: "disclosure",
                type: "button",
                tabIndex: -1,
                "aria-label": expanded ? `Collapse ${node.label}` : `Expand ${node.label}`,
                on: {
                    click: (event) => {
                        event.stopPropagation();
                        toggleExpanded(node);
                        requestAnimationFrame(() => focusTreeRow(
                            els.tree.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`),
                        ));
                    },
                },
            }, [svgIcon("chevron", 12)])
            : element("span", { class: "disclosure-placeholder" }),
        element("button", {
            class: "tree-row-main is-clickable",
            type: "button",
            tabIndex: -1,
            on: {
                click: (event) => {
                    event.stopPropagation();
                    setSelected(node);
                    if (node.kind === "command" && !node.disabled) {
                        toggleCommandPanel(node);
                    } else if (node.kind === "endpoint" && node.href) {
                        window.open(node.href, "_blank", "noopener,noreferrer");
                    }
                },
            },
        }, [
            rowIcon(node),
            element("span", { class: "tree-label", text: node.label, title: node.label }),
            ...(node.description ? [element("span", {
                class: "tree-description",
                text: node.description,
                title: node.description,
            })] : []),
            ...(node.statusLabel ? [element("span", {
                class: `tree-status${node.tone ? ` tone-${node.tone}` : ""}`,
                text: node.statusLabel,
                title: node.statusLabel,
            })] : []),
        ]),
        rowActions(node, level, selected),
    ]);
    const children = expanded
        ? element("ul", { class: "tree-group", role: "group", id: childGroupId },
            node.children.map((child) => renderNode(child, level + 1)))
        : null;
    const inline = node.kind === "command" && activeCommandId === node.id
        ? renderCommandPanel(node)
        : null;
    const appHostActions = renderAppHostActionTray(node, level, selected);
    return element("li", {
        class: `tree-item${expanded ? " is-expanded" : ""}`,
        role: "none",
        dataset: { kind: node.kind },
    }, [row, appHostActions, inline, children]);
}

function renderTree() {
    const source = filteredTree(modelState?.roots ?? [], filterText);
    if (activeCommandId && !treeContains(source, activeCommandId)) {
        clearActiveCommand();
    }
    if (source.length === 0 && filterText) {
        els.tree.setAttribute("role", "status");
        els.tree.removeAttribute("aria-label");
        els.tree.replaceChildren(element("div", { class: "filter-empty" }, [
            element("p", {
                text: "No AppHosts, resources, endpoints, health checks, or commands match this filter.",
            }),
            element("button", {
                class: "button button-secondary button-small",
                type: "button",
                text: "Clear filter",
                on: {
                    click: () => {
                        filterText = "";
                        els.searchInput.value = "";
                        updateHeader();
                        renderTree();
                        els.searchInput.focus();
                    },
                },
            }),
        ]));
        return;
    }
    els.tree.setAttribute("role", "tree");
    els.tree.setAttribute("aria-label", "Aspire AppHosts");
    const focusState = captureCommandFocus();
    renderedRowIndex = 0;
    renderedSelectionVisible = treeContains(source, selectedNodeId);
    els.tree.replaceChildren(element("ul", { class: "tree-group tree-root", role: "group" },
        source.map((node) => renderNode(node, 1))));
    if (activeCommandId && !els.tree.querySelector(`[data-node-id="${CSS.escape(activeCommandId)}"]`)) {
        clearActiveCommand();
        renderTree();
        return;
    }
    if (!els.tree.querySelector('.tree-row[role="treeitem"][tabindex="0"]')) {
        const firstRow = els.tree.querySelector('.tree-row[role="treeitem"]');
        if (firstRow) {
            firstRow.tabIndex = 0;
        }
    }
    restoreCommandFocus(focusState);
    if (confirmationNeedsFocus) {
        confirmationNeedsFocus = false;
        requestAnimationFrame(() => els.tree.querySelector("[data-confirm-action]")?.focus());
    }
}

function treeContains(nodes, nodeId) {
    if (!nodeId) {
        return false;
    }
    return nodes.some((node) => node.id === nodeId || treeContains(node.children ?? [], nodeId));
}

function captureCommandFocus() {
    const active = document.activeElement;
    if (!active?.closest?.(".command-form") || !active.name) {
        return null;
    }
    return {
        name: active.name,
        selectionStart: typeof active.selectionStart === "number" ? active.selectionStart : null,
        selectionEnd: typeof active.selectionEnd === "number" ? active.selectionEnd : null,
    };
}

function restoreCommandFocus(focusState) {
    if (!focusState || !activeCommandId) {
        return;
    }
    const row = els.tree.querySelector(`[data-node-id="${CSS.escape(activeCommandId)}"]`);
    const control = row?.closest(".tree-item")?.querySelector(`[name="${CSS.escape(focusState.name)}"]`);
    if (!control) {
        return;
    }
    control.focus();
    if (focusState.selectionStart !== null && typeof control.setSelectionRange === "function") {
        control.setSelectionRange(focusState.selectionStart, focusState.selectionEnd);
    }
}

function visibleTreeRows() {
    return [...els.tree.querySelectorAll('.tree-row[role="treeitem"]')];
}

function focusTreeRow(row) {
    if (!row) {
        return;
    }
    for (const candidate of visibleTreeRows()) {
        candidate.tabIndex = candidate === row ? 0 : -1;
    }
    row.focus();
}

function handleTreeKey(event, node) {
    const rows = visibleTreeRows();
    const currentIndex = rows.indexOf(event.currentTarget);
    if (event.key === "ArrowDown") {
        event.preventDefault();
        focusTreeRow(rows[currentIndex + 1] ?? rows[0]);
        return;
    }
    if (event.key === "ArrowUp") {
        event.preventDefault();
        focusTreeRow(rows[currentIndex - 1] ?? rows.at(-1));
        return;
    }
    if (event.key === "ArrowRight") {
        if (node.children?.length && !expandedIds.has(node.id)) {
            event.preventDefault();
            expandedIds.add(node.id);
            renderTree();
            requestAnimationFrame(() => focusTreeRow(
                els.tree.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`),
            ));
        }
        return;
    }
    if (event.key === "ArrowLeft") {
        if (expandedIds.has(node.id)) {
            event.preventDefault();
            expandedIds.delete(node.id);
            renderTree();
            requestAnimationFrame(() => focusTreeRow(
                els.tree.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`),
            ));
            return;
        }
        const parentItem = event.currentTarget.closest(".tree-group")?.closest(".tree-item");
        const parentRow = parentItem?.querySelector(":scope > .tree-row");
        if (parentRow) {
            event.preventDefault();
            focusTreeRow(parentRow);
        }
        return;
    }
    if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setSelected(node);
        if (node.kind === "command" && !node.disabled) {
            toggleCommandPanel(node);
        } else if (node.children?.length) {
            toggleExpanded(node);
        }
    }
}

function hideActionMenu() {
    actionMenuNodeId = null;
    els.actionMenu.hidden = true;
    els.actionMenu.replaceChildren();
}

function menuAction(action, node) {
    const definition = ACTIONS[action];
    return element("button", {
        class: "menu-action",
        type: "button",
        role: "menuitem",
        on: {
            click: () => {
                hideActionMenu();
                void executeNodeAction(action, node);
            },
        },
    }, [svgIcon(definition.icon, 14), definition.label]);
}

function openActionMenu(node, anchor) {
    if (actionMenuNodeId === node.id && !els.actionMenu.hidden) {
        hideActionMenu();
        return;
    }
    actionMenuNodeId = node.id;
    const actionNames = [...(node.actions ?? []), "ask"];
    els.actionMenu.replaceChildren(...actionNames.map((action) => menuAction(action, node)));
    els.actionMenu.hidden = false;
    const bounds = anchor.getBoundingClientRect();
    const menuWidth = 210;
    const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, bounds.right - menuWidth));
    els.actionMenu.style.left = `${left}px`;
    els.actionMenu.style.top = `${Math.min(window.innerHeight - els.actionMenu.offsetHeight - 8, bounds.bottom + 3)}px`;
    els.actionMenu.querySelector("button")?.focus();
}

async function executeNodeAction(action, node) {
    pendingConfirmation = null;
    if (action === "ask") {
        try {
            const result = await api("/api/ask-copilot", { method: "POST", body: { nodeId: node.id } });
            showToast(result.ok ? "Sent the selected tree item to Copilot." : result.error, !result.ok);
        } catch (error) {
            showToast(error.message, true);
        }
        return;
    }
    if (action === "source") {
        try {
            const result = await api("/api/open-source", { method: "POST", body: { appHostId: node.appHostId } });
            showToast(result.ok ? "Opened the AppHost source." : result.error, !result.ok);
        } catch (error) {
            showToast(error.message, true);
        }
        return;
    }
    if (action === "dashboard") {
        const dashboard = node.children?.find((child) => child.kind === "endpoint" && child.label === "Dashboard");
        if (dashboard?.href) {
            window.open(dashboard.href, "_blank", "noopener,noreferrer");
        } else {
            showToast("The dashboard URL is not available.", true);
        }
        return;
    }
    if (action === "pipeline-step") {
        await choosePipelineStep(node.appHostId);
        return;
    }
    await runAppHostOperation(node.appHostId, action);
}

async function choosePipelineStep(appHostId) {
    pipelineAppHostId = appHostId;
    els.pipelineStepInput.value = "";
    els.pipelineStepOptions.replaceChildren();
    els.pipelineError.hidden = true;
    els.pipelineDialog.showModal();
    try {
        const result = await api(`/api/pipeline-steps?appHostId=${encodeURIComponent(appHostId)}`);
        els.pipelineStepOptions.replaceChildren(...(result.steps ?? []).map((step) =>
            element("option", { value: step.name, label: step.description || step.resourceName || step.name })));
    } catch (error) {
        els.pipelineError.hidden = false;
        els.pipelineError.textContent = `${error.message} You can still enter a step name.`;
    }
}

async function runAppHostOperation(appHostId, operation, step) {
    try {
        const result = await api("/api/apphost-operation", {
            method: "POST",
            body: { appHostId, operation, ...(step ? { step } : {}) },
        });
        showToast(result.ok ? `${ACTIONS[operation].label} completed.` : result.error, !result.ok);
    } catch (error) {
        showToast(error.message, true);
    }
}

function commandDraft(node) {
    let draft = commandDrafts.get(node.id);
    if (!draft) {
        draft = {};
        commandDrafts.set(node.id, draft);
    }
    return draft;
}

function commandInputList(node) {
    const baseInputs = node.command.argumentInputs ?? [];
    const baseSignature = JSON.stringify(baseInputs);
    const cached = commandInputs.get(node.id);
    if (cached?.baseSignature === baseSignature) {
        return cached.inputs;
    }
    if (cached) {
        commandInputs.delete(node.id);
        pruneCommandDraft(node.id, baseInputs);
    }
    return baseInputs;
}

function pruneCommandDraft(nodeId, inputs) {
    const draft = commandDrafts.get(nodeId);
    if (!draft) {
        return;
    }
    const declared = new Set(inputs.filter((input) => !input.disabled).map((input) => input.name));
    for (const name of Object.keys(draft)) {
        if (!declared.has(name)) {
            delete draft[name];
        }
    }
    const remainingErrors = (commandValidationErrors.get(nodeId) ?? [])
        .filter((error) => declared.has(error.argumentName));
    if (remainingErrors.length > 0) {
        commandValidationErrors.set(nodeId, remainingErrors);
    } else {
        commandValidationErrors.delete(nodeId);
    }
}

function toggleCommandPanel(node) {
    if (activeCommandId === node.id) {
        closeCommandPanel(node);
        return;
    } else {
        if (activeCommandId) {
            clearActiveCommand();
        }
        activeCommandId = node.id;
        const inputs = commandInputList(node);
        if (inputs.some((input) => input.dynamicLoading)) {
            void reloadDynamicInputs(node);
        }
    }
    renderTree();
}

function discardSensitiveCommandDraft(node, nodeId = node?.id) {
    if (!nodeId) {
        return;
    }
    const cachedInputs = commandInputs.get(nodeId)?.inputs ?? [];
    const baseInputs = node?.command?.argumentInputs ?? [];
    const inputs = [...cachedInputs, ...baseInputs];
    if (!node || inputs?.some((input) => input.inputType.toLowerCase().includes("secret"))) {
        commandDrafts.delete(nodeId);
    }
    commandValidationErrors.delete(nodeId);
}

function clearActiveCommand() {
    if (!activeCommandId) {
        return;
    }
    const nodeId = activeCommandId;
    discardSensitiveCommandDraft(findNode(nodeId), nodeId);
    clearTimeout(dynamicLoadTimers.get(nodeId));
    dynamicLoadTimers.delete(nodeId);
    dynamicLoadGenerations.set(nodeId, (dynamicLoadGenerations.get(nodeId) ?? 0) + 1);
    dynamicLoadingIds.delete(nodeId);
    activeCommandId = null;
}

function closeCommandPanel(node) {
    if (activeCommandId === node.id) {
        clearActiveCommand();
    } else {
        discardSensitiveCommandDraft(node);
    }
    renderTree();
}

function commandField(node, input) {
    const draft = commandDraft(node);
    const kind = input.inputType.toLowerCase();
    if (draft[input.name] === undefined) {
        if (kind === "boolean" || kind === "checkbox") {
            const defaultValue = String(input.value ?? "").trim().toLowerCase();
            if (defaultValue === "true" || defaultValue === "false") {
                draft[input.name] = defaultValue === "true";
            } else if (input.required) {
                draft[input.name] = false;
            }
        } else if (input.value !== undefined) {
            draft[input.name] = input.value;
        }
    }
    const validationMessage = (commandValidationErrors.get(node.id) ?? [])
        .find((error) => error.argumentName === input.name)?.errorMessage;
    let control;
    if (kind === "boolean" || kind === "checkbox") {
        control = element("input", {
            type: "checkbox",
            name: input.name,
            checked: draft[input.name] === true || draft[input.name] === "true",
            disabled: input.disabled,
            on: { change: (event) => updateCommandDraft(node, input, event.target.checked) },
        });
        return element("label", { class: "command-field checkbox-field" }, [
            control,
            element("span", { text: input.label }),
        ]);
    }
    if (input.options?.length > 0 && !input.allowCustomChoice) {
        control = element("select", {
            name: input.name,
            required: input.required,
            disabled: input.disabled,
            on: { change: (event) => updateCommandDraft(node, input, event.target.value) },
        }, [
            ...(!input.required ? [element("option", { value: "", text: "Select..." })] : []),
            ...input.options.map((option) => element("option", { value: option.value, text: option.label })),
        ]);
        control.value = draft[input.name] ?? "";
    } else {
        control = element("input", {
            type: kind.includes("secret") ? "password" : kind.includes("number") ? "number" : "text",
            name: input.name,
            value: draft[input.name] ?? "",
            required: input.required,
            disabled: input.disabled,
            placeholder: input.placeholder ?? "",
            ...(input.maxLength ? { maxLength: input.maxLength } : {}),
            autocomplete: kind.includes("secret") ? "off" : "on",
            on: { input: (event) => updateCommandDraft(node, input, event.target.value) },
        });
    }
    return element("label", { class: "command-field" }, [
        element("span", { text: `${input.label}${input.required ? " *" : ""}` }),
        control,
        ...(input.description ? [element("small", { text: input.description })] : []),
        element("span", {
            class: "field-error",
            dataset: { errorFor: input.name },
            text: validationMessage ?? "",
        }),
    ]);
}

function updateCommandDraft(node, input, value) {
    commandDraft(node)[input.name] = value;
    const remainingErrors = (commandValidationErrors.get(node.id) ?? [])
        .filter((error) => error.argumentName !== input.name);
    if (remainingErrors.length > 0) {
        commandValidationErrors.set(node.id, remainingErrors);
    } else {
        commandValidationErrors.delete(node.id);
    }
    const inputs = commandInputList(node);
    if (inputs.some((candidate) =>
        candidate.dynamicLoading?.dependsOnInputs?.includes(input.name))) {
        clearTimeout(dynamicLoadTimers.get(node.id));
        dynamicLoadTimers.set(node.id, setTimeout(() => void reloadDynamicInputs(node), 250));
    }
}

async function reloadDynamicInputs(node) {
    const generation = (dynamicLoadGenerations.get(node.id) ?? 0) + 1;
    dynamicLoadGenerations.set(node.id, generation);
    dynamicLoadingIds.add(node.id);
    if (activeCommandId === node.id) {
        renderTree();
    }
    try {
        const result = await api("/api/command-inputs", {
            method: "POST",
            body: {
                appHostId: node.appHostId,
                resourceName: node.resourceName,
                commandName: node.commandName,
                arguments: { ...commandDraft(node) },
            },
        });
        if (dynamicLoadGenerations.get(node.id) !== generation) {
            return;
        }
        const inputs = result.inputs ?? [];
        commandInputs.set(node.id, {
            baseSignature: JSON.stringify(node.command.argumentInputs ?? []),
            inputs,
        });
        pruneCommandDraft(node.id, inputs);
        commandResults.delete(node.id);
    } catch (error) {
        if (dynamicLoadGenerations.get(node.id) !== generation) {
            return;
        }
        commandResults.set(node.id, { ok: false, error: error.message });
    } finally {
        if (dynamicLoadGenerations.get(node.id) === generation) {
            dynamicLoadingIds.delete(node.id);
            if (activeCommandId === node.id) {
                renderTree();
            }
        }
    }
}

function renderCommandPanel(node) {
    const inputs = commandInputList(node);
    const loadingInputs = dynamicLoadingIds.has(node.id);
    const hasSecret = inputs.some((input) =>
        !input.disabled && input.inputType.toLowerCase().includes("secret"));
    if (hasSecret && !secretWarningAccepted) {
        return element("div", { class: "inline-panel" }, [
            element("p", {
                class: "secret-warning",
                text: "Secret values are sent to the AppHost command through the Aspire CLI. The canvas redacts them from results and does not log or persist them.",
            }),
            element("div", { class: "panel-actions" }, [
                element("button", {
                    class: "button button-secondary button-small",
                    type: "button",
                    text: "Cancel",
                    on: { click: () => closeCommandPanel(node) },
                }),
                element("button", {
                    class: "button button-primary button-small",
                    type: "button",
                    text: "Continue",
                    on: { click: () => { secretWarningAccepted = true; renderTree(); } },
                }),
            ]),
        ]);
    }

    const result = commandResults.get(node.id);
    const form = element("form", {
        class: "command-form",
        on: {
            submit: (event) => {
                event.preventDefault();
                void submitResourceCommand(node, event.currentTarget);
            },
        },
    }, [
        element("p", { class: "inline-panel-title", text: node.label }),
        ...inputs.filter((input) => !input.disabled).map((input) => commandField(node, input)),
        element("div", { class: "panel-actions" }, [
            element("button", {
                class: "button button-secondary button-small",
                type: "button",
                text: "Cancel",
                on: { click: () => closeCommandPanel(node) },
            }),
            element("button", {
                class: "button button-primary button-small",
                type: "submit",
                text: commandRunning ? "Running..." : loadingInputs ? "Loading inputs..." : "Run command",
                disabled: commandRunning || loadingInputs,
            }),
        ]),
        ...(result ? [element("pre", {
            class: `command-result${result.ok ? "" : " is-error"}`,
            text: result.output || result.message || result.error || "Command completed.",
        })] : []),
    ]);
    return element("div", { class: "inline-panel" }, [form]);
}

async function submitResourceCommand(node, form) {
    if (commandRunning || dynamicLoadingIds.has(node.id)) {
        return;
    }
    commandRunning = true;
    updateBusy();
    try {
        const result = await api("/api/command", {
            method: "POST",
            body: {
                appHostId: node.appHostId,
                resourceName: node.resourceName,
                commandName: node.commandName,
                arguments: Object.fromEntries(
                    Object.entries(commandDraft(node))
                        .filter(([name]) => commandInputList(node)
                            .some((input) => !input.disabled && input.name === name)),
                ),
            },
        });
        if (result.validationErrors) {
            commandValidationErrors.set(node.id, result.validationErrors);
        } else {
            commandValidationErrors.delete(node.id);
        }
        commandResults.set(node.id, result);
        if (result.ok) {
            const inputs = commandInputList(node);
            if (inputs.some((input) => input.inputType.toLowerCase().includes("secret"))) {
                commandDrafts.delete(node.id);
            }
        }
        showToast(result.ok ? `${node.label} completed.` : result.error, !result.ok);
    } catch (error) {
        commandResults.set(node.id, { ok: false, error: error.message });
        showToast(error.message, true);
    } finally {
        commandRunning = false;
        updateBusy();
        renderTree();
    }
}

function render() {
    if (renderedViewMode && modelState?.viewMode !== renderedViewMode) {
        clearActiveCommand();
    }
    renderedViewMode = modelState?.viewMode ?? null;
    if (selectedNodeId && !findNode(selectedNodeId)) {
        selectedNodeId = null;
    }
    if (pendingConfirmation && !findNode(pendingConfirmation.nodeId)) {
        pendingConfirmation = null;
    }
    if (activeCommandId && !findNode(activeCommandId)) {
        clearActiveCommand();
    }
    updateHeader();
    updateStatus();
    updateEmptyAndLoading();
    renderTree();
    updateBusy();
}

async function refresh() {
    try {
        const result = await api("/api/refresh", { method: "POST", body: {} });
        modelState = result.state;
        render();
    } catch (error) {
        showToast(error.message, true);
    }
}

async function setViewMode(viewMode) {
    if (modelState?.viewMode === viewMode) {
        return;
    }
    hideActionMenu();
    selectedNodeId = null;
    clearActiveCommand();
    pendingConfirmation = null;
    try {
        const result = await api("/api/mode", { method: "POST", body: { viewMode } });
        modelState = result.state;
        render();
    } catch (error) {
        showToast(error.message, true);
    }
}

function connectEvents() {
    const source = new EventSource(`/events?token=${encodeURIComponent(apiToken)}`);
    source.addEventListener("open", () => {
        if (modelState?.status === "ready") {
            els.connectionDot.classList.remove("is-stale", "is-error");
            els.connectionDot.classList.add("is-live");
            els.connectionStatus.textContent = "AppHost data is live";
        }
    });
    source.addEventListener("message", (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        if (message.type === "state" && message.state) {
            modelState = message.state;
            render();
            return;
        }
        if (message.type === "freshness" && modelState) {
            modelState.lastSuccessfulAt = message.lastSuccessfulAt;
            els.freshness.textContent = formatAge(message.lastSuccessfulAt);
            return;
        }
        if (message.type === "command") {
            commandRunning = message.phase === "started";
            if (message.phase === "completed" && message.result) {
                const commandNode = findCommandNode(
                    message.result.appHostId,
                    message.result.resourceName,
                    message.result.commandName,
                );
                if (commandNode) {
                    commandResults.set(commandNode.id, message.result);
                }
            }
            updateBusy();
            renderTree();
        }
    });
    source.addEventListener("error", () => {
        els.connectionDot.classList.remove("is-live");
        els.connectionDot.classList.add("is-stale");
        els.connectionStatus.textContent = "Connection lost; AppHost data may be stale";
    });
}

function findCommandNode(appHostId, resourceName, commandName, nodes = modelState?.roots ?? []) {
    for (const node of nodes) {
        if (
            node.kind === "command"
            && node.appHostId === appHostId
            && node.resourceName === resourceName
            && node.commandName === commandName
        ) {
            return node;
        }
        const child = findCommandNode(appHostId, resourceName, commandName, node.children ?? []);
        if (child) {
            return child;
        }
    }
    return null;
}

els.workspaceMode.addEventListener("click", () => void setViewMode("workspace"));
els.globalMode.addEventListener("click", () => void setViewMode("global"));
els.refreshButton.addEventListener("click", () => void refresh());
els.statusAction.addEventListener("click", () => void refresh());
els.emptyAction.addEventListener("click", () => void refresh());
els.searchInput.addEventListener("input", () => {
    filterText = els.searchInput.value;
    updateHeader();
    renderTree();
});
els.hiddenCheckbox.addEventListener("change", async () => {
    try {
        const result = await api("/api/preferences", {
            method: "POST",
            body: { includeHidden: els.hiddenCheckbox.checked },
        });
        modelState = result.state;
        render();
    } catch (error) {
        els.hiddenCheckbox.checked = modelState?.includeHidden === true;
        showToast(error.message, true);
    }
});

document.addEventListener("pointerdown", (event) => {
    if (!els.actionMenu.hidden && !event.target.closest("#action-menu, .row-action")) {
        hideActionMenu();
    }
});
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        hideActionMenu();
    }
});
document.addEventListener("scroll", hideActionMenu, true);

els.pipelineDialog.addEventListener("close", () => {
    if (els.pipelineDialog.returnValue !== "run" || !pipelineAppHostId) {
        pipelineAppHostId = null;
        return;
    }
    const step = els.pipelineStepInput.value.trim();
    if (!step) {
        pipelineAppHostId = null;
        return;
    }
    const appHostId = pipelineAppHostId;
    pipelineAppHostId = null;
    void runAppHostOperation(appHostId, "pipeline-step", step);
});

setInterval(() => {
    if (modelState?.lastSuccessfulAt) {
        els.freshness.textContent = formatAge(modelState.lastSuccessfulAt);
    }
}, 5_000);

connectEvents();
void api("/api/state")
    .then((result) => {
        modelState = result.state;
        render();
    })
    .catch((error) => {
        modelState = {
            viewMode: "workspace",
            status: "error",
            refreshing: false,
            stale: false,
            error: error.message,
            roots: [],
            summary: { appHosts: 0, running: 0, idle: 0, resources: 0, failedAppHosts: 0 },
        };
        render();
    });
