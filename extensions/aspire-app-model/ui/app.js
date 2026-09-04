const AUTH_HEADER = "x-aspire-app-model-token";
const apiToken = new URLSearchParams(window.location.search).get("token") || "";
const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? { matches: false };

const els = {
    body: document.body,
    surface: document.querySelector(".canvas-surface"),
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
    tree: document.getElementById("model-view"),
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
    copy: "M0 6.75C0 5.784.784 5 1.75 5h6.5C9.216 5 10 5.784 10 6.75v7.5A1.75 1.75 0 0 1 8.25 16h-6.5A1.75 1.75 0 0 1 0 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h6.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25ZM6 1.75C6 .784 6.784 0 7.75 0h6.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11H12.5V9.5h1.75a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-6.5a.25.25 0 0 0-.25.25V3.5H6Z",
    info: "M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z",
    pulse: "M6 2a.75.75 0 0 1 .696.471l3.804 9.51 1.804-4.51A.75.75 0 0 1 13 7h2.25a.75.75 0 0 1 0 1.5h-1.742l-2.312 5.779a.75.75 0 0 1-1.392 0L6 4.77 4.196 9.279A.75.75 0 0 1 3.5 9.75H.75a.75.75 0 0 1 0-1.5h2.242l2.312-5.779A.75.75 0 0 1 6 2Z",
};

const ACTIONS = {
    source: { label: "Open AppHost source", shortLabel: "Source", icon: "source" },
    dashboard: { label: "View dashboard", shortLabel: "View dashboard", icon: "dashboard" },
    run: { label: "Run AppHost", shortLabel: "Run", icon: "play" },
    stop: { label: "Stop AppHost", shortLabel: "Stop", icon: "stop" },
    deploy: { label: "Deploy AppHost", shortLabel: "Deploy", icon: "deploy" },
    publish: { label: "Publish AppHost", shortLabel: "Publish", icon: "package" },
    "pipeline-step": { label: "Run pipeline step", shortLabel: "Pipeline step", icon: "steps" },
    details: { label: "View details", shortLabel: "Details", icon: "info" },
    "console-logs": { label: "Console logs", shortLabel: "Console logs", icon: "terminal" },
    "structured-logs": { label: "Structured logs", shortLabel: "Structured logs", icon: "source" },
    traces: { label: "Traces", shortLabel: "Traces", icon: "steps" },
    metrics: { label: "Metrics", shortLabel: "Metrics", icon: "pulse" },
    terminal: { label: "Open terminal", shortLabel: "Terminal", icon: "terminal" },
    ask: { label: "Add to Copilot chat", shortLabel: "Add to chat", icon: "ask" },
};

const DASHBOARD_VIEW_ACTIONS = {
    details: "details",
    "console-logs": "console-logs",
    "structured-logs": "structured-logs",
    traces: "traces",
    metrics: "metrics",
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
let actionMenuTrigger = null;
let pipelineAppHostId = null;
let secretWarningAccepted = false;
let pendingConfirmation = null;
let confirmationNeedsFocus = false;
let renderedViewMode = null;
let activeAppHostId = null;
let pendingViewMode = null;
let activeModeTransition = null;
let appModelView = "resources";
let activeGraphModel = null;
let graphDrawFrame = null;
let renderedAppHostId = null;
const commandDrafts = new Map();
const commandInputs = new Map();
const commandResults = new Map();
const commandValidationErrors = new Map();
const dynamicLoadTimers = new Map();
const dynamicLoadGenerations = new Map();
const dynamicLoadingIds = new Set();
const appModelViewStateByAppHost = new Map();
const graphResizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => scheduleResourceGraphDraw())
    : null;

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

async function copyEndpointUrl(endpoint) {
    const url = String(endpoint.href || endpoint.description || "").trim();
    if (!url) {
        showToast("This endpoint does not expose a copyable URL.", true);
        return;
    }
    if (typeof navigator.clipboard?.writeText !== "function") {
        showToast("Clipboard access is unavailable in this canvas.", true);
        return;
    }
    try {
        await navigator.clipboard.writeText(url);
        showToast(`Copied ${endpoint.label} URL.`);
    } catch {
        showToast(`Couldn't copy ${endpoint.label} URL.`, true);
    }
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

function svgElement(tag, attributes = {}) {
    const namespace = "http://www.w3.org/2000/svg";
    const node = document.createElementNS(namespace, tag);
    for (const [name, value] of Object.entries(attributes)) {
        node.setAttribute(name, String(value));
    }
    return node;
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

async function copyResourceName(resource) {
    const name = String(resource.label || resource.resourceName || "").trim();
    if (!name) {
        showToast("This resource does not expose a copyable name.", true);
        return;
    }
    if (typeof navigator.clipboard?.writeText !== "function") {
        showToast("Clipboard access is unavailable in this canvas.", true);
        return;
    }
    try {
        await navigator.clipboard.writeText(name);
        showToast(`Copied resource name “${name}”.`);
    } catch {
        showToast(`Couldn't copy resource name “${name}”.`, true);
    }
}

function setModeButtons() {
    const viewMode = pendingViewMode ?? modelState?.viewMode ?? "workspace";
    const workspace = viewMode !== "global";
    const switching = pendingViewMode !== null;
    els.workspaceMode.classList.toggle("is-active", workspace);
    els.workspaceMode.setAttribute("aria-pressed", String(workspace));
    els.workspaceMode.disabled = switching;
    els.globalMode.classList.toggle("is-active", !workspace);
    els.globalMode.setAttribute("aria-pressed", String(!workspace));
    els.globalMode.disabled = switching;
}

function beginModeSwitch(viewMode) {
    pendingViewMode = viewMode;
    els.body.classList.add("is-mode-switching");
    els.surface.setAttribute("aria-busy", "true");
    els.surface.inert = true;
    document.documentElement.dataset.modeDirection = viewMode === "global" ? "forward" : "back";
    setModeButtons();
}

function finishModeSwitch() {
    pendingViewMode = null;
    els.body.classList.remove("is-mode-switching");
    els.surface.removeAttribute("aria-busy");
    els.surface.inert = false;
    setModeButtons();
}

function withModeTransition(viewMode, mutate) {
    document.documentElement.dataset.modeDirection = viewMode === "global" ? "forward" : "back";
    if (
        reduceMotion.matches
        || typeof document.startViewTransition !== "function"
        || activeModeTransition
    ) {
        mutate();
        delete document.documentElement.dataset.modeDirection;
        return;
    }
    activeModeTransition = document.startViewTransition(mutate);
    void activeModeTransition.finished
        .catch(() => {})
        .finally(() => {
            activeModeTransition = null;
            delete document.documentElement.dataset.modeDirection;
        });
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
    const mode = (pendingViewMode ?? modelState?.viewMode) === "global" ? "Global" : "Workspace";
    const parts = [mode];
    const query = filterText.trim().toLowerCase();
    if (pendingViewMode) {
        parts.push("Updating…");
    } else if (query) {
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
    if (modelState?.status === "ready" || modelState?.status === "empty") {
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
            if (matches) {
                return { ...node, filterMatch: true };
            }
            return children.length > 0 ? { ...node, children } : null;
        })
        .filter(Boolean);
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

function recordSelection(node) {
    if (pendingConfirmation?.nodeId !== node.id) {
        pendingConfirmation = null;
    }
    if (isAppHostNode(node)) {
        activeAppHostId = node.id;
    }
    selectedNodeId = node.id;
    void api("/api/selection", { method: "POST", body: { nodeId: node.id } }).catch(() => {});
}

function focusNodeControl(nodeId) {
    const control = els.tree.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
    control?.focus();
}

function setSelected(node) {
    recordSelection(node);
    renderTree();
    requestAnimationFrame(() => focusNodeControl(node.id));
}

function actionButton(label, iconName, handler) {
    return element("button", {
        class: "resource-menu-trigger",
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
    const targetLabel = node.presentationLabel || node.label;
    const enabled = action === "ask" || node.actions?.includes(action);
    const unavailableReason = node.unavailableActionReason || "This action is not available in the current context.";
    const accessibleLabel = enabled
        ? `${definition.label} for ${targetLabel}`
        : `${definition.label} for ${targetLabel}. Unavailable: ${unavailableReason}`;
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
        ...(primary ? { dataset: { apphostPrimary: "true" } } : {}),
        on: { click: () => requestNodeAction(action, node) },
    }, [
        svgIcon(definition.icon, 14),
        element("span", { text: definition.shortLabel }),
    ]);
}

function endpointChip(endpoint) {
    if (!endpoint.href) {
        return detailChip(endpoint);
    }
    return element("span", { class: "endpoint-actions" }, [
        detailChip(endpoint, { open: true }),
        element("button", {
            class: "endpoint-copy",
            type: "button",
            title: `Copy ${endpoint.label} URL`,
            "aria-label": `Copy ${endpoint.label} URL`,
            on: { click: () => void copyEndpointUrl(endpoint) },
        }, [svgIcon("copy", 12)]),
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
    requestAnimationFrame(() => {
        const target = els.tree.querySelector("[data-apphost-primary]:not([disabled])")
            || els.tree.querySelector(".host-action-bar .tray-action:not([disabled])")
            || els.tree.querySelector('[role="tab"][aria-selected="true"]');
        target?.focus();
    });
}

function renderAppHostConfirmation(node, action) {
    const confirmation = CONFIRMATIONS[action];
    const danger = action === "stop";
    const targetLabel = node.presentationLabel || node.label;
    return element("div", {
        class: `apphost-confirmation${danger ? " is-danger" : ""}`,
        role: "group",
        "aria-label": confirmation.title(targetLabel),
    }, [
        element("span", { class: "confirmation-icon" }, [svgIcon(danger ? "warning" : ACTIONS[action].icon, 15)]),
        element("span", { class: "confirmation-copy" }, [
            element("strong", { text: confirmation.title(targetLabel) }),
            element("span", { text: confirmation.detail }),
        ]),
        element("span", { class: "confirmation-actions" }, [
            element("button", {
                class: "button button-secondary button-small",
                type: "button",
                text: "Cancel",
                dataset: { confirmationCancel: action },
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

function renderAppHostActionTray(node) {
    if (node.operation) {
        return element("div", { class: "host-action-bar is-busy" }, [
            element("span", { class: "tray-busy-icon" }, [svgIcon("loading", 14)]),
            element("span", { text: node.operation.label }),
        ]);
    }
    if (pendingConfirmation?.nodeId === node.id) {
        return element("div", { class: "host-action-bar is-confirming" }, [
            renderAppHostConfirmation(node, pendingConfirmation.action),
        ]);
    }
    const ordered = (APPHOST_ACTION_ORDER[node.kind] ?? [])
        .filter((action) => action !== "source" || node.actions?.includes("source"));
    const primaryActions = ordered.filter((action) => ["run", "dashboard", "source"].includes(action));
    const operationalActions = ordered.filter((action) => !primaryActions.includes(action));
    return element("div", {
        class: "host-action-bar",
        "aria-label": `${node.label} actions`,
    }, [
        ...(node.unavailableActionReason ? [element("p", {
            class: "tray-notice",
            text: node.unavailableActionReason,
        })] : []),
        actionGroup("Open and run", primaryActions, node),
        actionGroup("Lifecycle and deployment", operationalActions, node),
    ]);
}

function rowIcon(node) {
    const icon = node.operation ? "restart" : node.icon || "resource";
    return element("span", {
        class: `state-icon icon-${node.icon || "resource"}${node.tone ? ` tone-${node.tone}` : ""}${node.operation || node.icon === "loading" ? " is-spinning" : ""}`,
    }, [svgIcon(icon, 15)]);
}

function appHostResources(appHost) {
    const group = appHost.children?.find((child) => child.kind === "resources-group");
    return (group?.children ?? appHost.children ?? []).filter((child) => child.kind === "resource");
}

function flattenResources(resources, parentLabel = null, depth = 0, result = []) {
    for (const resource of resources) {
        result.push({ resource, parentLabel, depth });
        flattenResources(
            (resource.children ?? []).filter((child) => child.kind === "resource"),
            resource.label,
            depth + 1,
            result,
        );
    }
    return result;
}

function childrenOfKind(node, kind) {
    return (node.children ?? []).filter((child) => child.kind === kind);
}

function firstChildOfKind(node, kind) {
    return (node.children ?? []).find((child) => child.kind === kind);
}

function detailChip(node, { open = false, command = false } = {}) {
    const unavailable = command && node.disabled;
    const interactive = open || (command && !unavailable);
    const selected = command && selectedNodeId === node.id;
    const label = node.statusLabel
        ? `${node.label}: ${node.statusLabel}`
        : node.description
            ? `${node.label}: ${node.description}`
            : node.label;
    const properties = {
        class:
            `detail-chip${interactive && selected ? " is-selected" : ""}${unavailable ? " is-unavailable" : ""}`
            + `${node.tone ? ` tone-${node.tone}` : ""}${open ? " is-link" : ""}${command ? " is-command" : ""}`,
        title: label,
        "aria-label": label,
        ...(unavailable ? { "aria-disabled": "true" } : {}),
        ...(interactive ? {
            type: "button",
            ...(command ? { "aria-pressed": selected } : {}),
            dataset: { nodeId: node.id },
            on: {
                click: () => {
                    if (open) {
                        void executeNodeAction("endpoint", node);
                        return;
                    }
                    recordSelection(node);
                    if (command) {
                        toggleCommandPanel(node, { focusPanel: true });
                        return;
                    }
                    renderTree();
                    requestAnimationFrame(() => focusNodeControl(node.id));
                },
            },
        } : {}),
    };
    return element(interactive ? "button" : "span", properties, [
        svgIcon(command ? node.icon || "run" : open ? "link" : node.icon || "record", 13),
        element("span", { text: node.label }),
        ...(node.statusLabel ? [element("span", { class: "chip-status", text: node.statusLabel })] : []),
    ]);
}

function renderDetailGroup(label, iconName, items) {
    if (items.length === 0) {
        return null;
    }
    return element("section", { class: "resource-detail-group" }, [
        element("h4", {}, [svgIcon(iconName, 13), label]),
        element("div", { class: "detail-chip-list" }, items),
    ]);
}

function aggregateHealthChip(resource) {
    return element("span", {
        class: `detail-chip${resource.healthTone ? ` tone-${resource.healthTone}` : ""}`,
        title: `Health: ${resource.healthLabel}`,
        "aria-label": `Health for ${resource.label}: ${resource.healthLabel}`,
    }, [
        svgIcon("heart", 13),
        element("span", { text: resource.healthLabel }),
    ]);
}

function resourceMenuActions(resource, dashboardAvailable) {
    const actions = dashboardAvailable
        ? ["details", "console-logs", "structured-logs", "traces", "metrics"]
        : [];
    if (resource.terminalEnabled) {
        actions.push("terminal");
    }
    if (actions.length > 0) {
        actions.push("separator");
    }
    actions.push("ask");
    return actions;
}

function renderResourceCard({ resource, parentLabel, dashboardAvailable }) {
    const endpoints = childrenOfKind(resource, "endpoint");
    const healthGroup = firstChildOfKind(resource, "health-group");
    const healthItems = healthGroup?.children?.length
        ? healthGroup.children.map((health) => detailChip(health))
        : resource.healthLabel
            ? [aggregateHealthChip(resource)]
            : [];
    const commandsGroup = firstChildOfKind(resource, "commands-group");
    const commands = commandsGroup?.children ?? [];
    const activeCommand = commands.find((command) => command.id === activeCommandId);
    return element("article", {
        class:
            `resource-card${activeCommand ? " has-command-panel" : ""}`
            + `${resource.tone ? ` tone-${resource.tone}` : ""}`,
        role: "listitem",
        dataset: { resourceId: resource.id },
    }, [
        element("header", { class: "resource-card-header" }, [
            element("div", {
                class: "resource-card-identity",
            }, [
                rowIcon(resource),
                element("span", { class: "resource-identity" }, [
                    element("button", {
                        class: "resource-name-copy",
                        type: "button",
                        title: `Copy resource name: ${resource.label || resource.resourceName}`,
                        "aria-label": `Copy resource name ${resource.label || resource.resourceName}`,
                        on: { click: () => void copyResourceName(resource) },
                    }, [
                        element("strong", { text: resource.label }),
                        svgIcon("copy", 12),
                    ]),
                    element("span", { text: resource.description, title: resource.description }),
                ]),
                ...(resource.statusLabel ? [element("span", {
                    class: `resource-status${resource.lifecycleTone ? ` tone-${resource.lifecycleTone}` : ""}`,
                    text: resource.statusLabel,
                })] : []),
            ]),
            actionButton(`More actions for ${resource.label}`, "more", (event) =>
                openActionMenu(resource, event.currentTarget, resourceMenuActions(resource, dashboardAvailable))),
        ]),
        ...(parentLabel ? [element("p", {
            class: "resource-parent",
            text: `Part of ${parentLabel}`,
        })] : []),
        element("div", { class: "resource-card-details" }, [
            renderDetailGroup(
                "Endpoints",
                "link",
                endpoints.map(endpointChip),
            ),
            renderDetailGroup(
                "Health",
                "heart",
                healthItems,
            ),
            renderDetailGroup(
                "Commands",
                "terminal",
                commands.map((command) => detailChip(command, { command: true })),
            ),
        ]),
        ...(activeCommand ? [renderCommandPanel(activeCommand)] : []),
    ]);
}

function visibleResourceGraph(appHost, resources) {
    const visibleNames = new Set(resources.map(({ resource }) => resource.resourceName));
    const source = appHost.graph ?? { nodes: [], edges: [] };
    const nodes = source.nodes.filter((node) => visibleNames.has(node.resourceName));
    const nodeNames = new Set(nodes.map((node) => node.resourceName));
    const edges = source.edges.filter((edge) => nodeNames.has(edge.from) && nodeNames.has(edge.to));
    const sourceLayers = [...new Set(nodes.map((node) => node.layer))].sort((left, right) => left - right);
    const normalizedLayers = new Map(sourceLayers.map((layer, index) => [layer, index]));
    return {
        nodes: nodes.map((node) => ({ ...node, layer: normalizedLayers.get(node.layer) ?? 0 })),
        edges,
    };
}

function setAppModelView(view) {
    if (view !== "resources" && view !== "graph" || appModelView === view) {
        return;
    }
    appModelView = view;
    hideActionMenu();
    renderTree();
    requestAnimationFrame(() => {
        els.tree.querySelector(`#${view}-view-tab`)?.focus();
    });
}

function handleAppModelTabKey(event, view) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        return;
    }
    event.preventDefault();
    const nextView = event.key === "ArrowLeft" || event.key === "Home"
        ? "resources"
        : event.key === "ArrowRight" || event.key === "End"
            ? "graph"
            : view;
    setAppModelView(nextView);
}

function renderAppModelTabs(resourceCount, relationshipCount) {
    const definitions = [
        { id: "resources", label: "Resources", icon: "layers", count: resourceCount },
        { id: "graph", label: "Graph", icon: "steps", count: relationshipCount },
    ];
    return element("div", {
        class: "app-model-tabs",
        role: "tablist",
        "aria-label": "App model view",
    }, definitions.map((definition) => {
        const active = appModelView === definition.id;
        return element("button", {
            class: `app-model-tab${active ? " is-active" : ""}`,
            id: `${definition.id}-view-tab`,
            type: "button",
            role: "tab",
            tabIndex: active ? 0 : -1,
            "aria-selected": active,
            "aria-controls": `${definition.id}-view-panel`,
            "aria-label": `${definition.label}, ${definition.count}`,
            on: {
                click: () => setAppModelView(definition.id),
                keydown: (event) => handleAppModelTabKey(event, definition.id),
            },
        }, [
            svgIcon(definition.icon, 14),
            element("span", { text: definition.label }),
            element("span", {
                class: "app-model-tab-count",
                text: String(definition.count),
                "aria-hidden": "true",
            }),
        ]);
    }));
}

const GRAPH_RELATIONSHIPS = {
    Parent: { label: "Ownership", className: "is-parent" },
    Reference: { label: "Reference", className: "is-reference" },
    WaitFor: { label: "WaitFor", className: "is-wait-for" },
};

function graphEdgePresentation(edge) {
    if (edge.types.length === 1) {
        const type = edge.types[0];
        return {
            id: type.toLowerCase(),
            ...GRAPH_RELATIONSHIPS[type],
        };
    }
    const typeKey = edge.types.map((type) => type.toLowerCase()).join("-");
    return {
        id: `combined-${typeKey}`,
        label: edge.types.map((type) => GRAPH_RELATIONSHIPS[type].label).join(" + "),
        className: `is-combined is-combined-${typeKey}`,
    };
}

function renderGraphLegend(graph) {
    const presentations = new Map();
    for (const edge of graph.edges) {
        const presentation = graphEdgePresentation(edge);
        presentations.set(presentation.id, presentation);
    }
    if (presentations.size === 0) {
        return null;
    }
    return element("div", { class: "graph-legend", "aria-label": "Relationship legend" },
        [...presentations.values()].map((presentation) =>
            element("span", { class: "graph-legend-item" }, [
                element("span", {
                    class: `graph-legend-line ${presentation.className}`,
                    "aria-hidden": "true",
                }),
                element("span", { text: presentation.label }),
            ])));
}

function renderGraphNode(node) {
    return element("article", {
        class: `graph-node${node.tone ? ` tone-${node.tone}` : ""}`,
        role: "listitem",
        dataset: { graphNodeId: node.resourceName },
    }, [
        element("header", { class: "graph-node-header" }, [
            rowIcon(node),
            element("span", { class: "graph-node-identity" }, [
                element("strong", { text: node.label, title: node.label }),
                element("span", { text: node.resourceType, title: node.resourceType }),
            ]),
            ...(node.statusLabel ? [element("span", {
                class: `resource-status${node.lifecycleTone ? ` tone-${node.lifecycleTone}` : ""}`,
                text: node.statusLabel,
            })] : []),
        ]),
        ...(node.healthLabel ? [element("div", {
            class: `graph-node-health${node.healthTone ? ` tone-${node.healthTone}` : ""}`,
        }, [
            svgIcon("heart", 12),
            element("span", { text: node.healthLabel }),
        ])] : []),
    ]);
}

function graphRelationshipSentence(edge, type, nodeByName) {
    const from = nodeByName.get(edge.from)?.label ?? edge.from;
    const to = nodeByName.get(edge.to)?.label ?? edge.to;
    if (type === "Parent") {
        return `${to} is part of ${from}.`;
    }
    if (type === "WaitFor") {
        return `${to} waits for ${from}.`;
    }
    return `${to} references ${from}.`;
}

function renderResourceGraphPanel(graph, active) {
    if (active) {
        activeGraphModel = graph;
    }
    const nodeByName = new Map(graph.nodes.map((node) => [node.resourceName, node]));
    if (graph.nodes.length === 0) {
        return element("div", {
            class: "app-model-panel",
            id: "graph-view-panel",
            role: "tabpanel",
            "aria-labelledby": "graph-view-tab",
            hidden: !active,
        }, [
            element("div", { class: "resource-board-empty" }, [
                svgIcon("steps", 18),
                element("strong", { text: "No resource graph yet" }),
                element("span", { text: "Start this AppHost to load its evaluated relationships." }),
            ]),
        ]);
    }

    const maxLayer = Math.max(...graph.nodes.map((node) => node.layer), 0);
    const columns = Array.from({ length: maxLayer + 1 }, (_, layer) =>
        graph.nodes.filter((node) => node.layer === layer));
    const edgeLayer = svgElement("svg", {
        class: "graph-edge-layer",
        "aria-hidden": "true",
    });
    const canvas = element("div", { class: "resource-graph-canvas" }, [
        edgeLayer,
        element("div", {
            class: "graph-columns",
            role: "list",
            "aria-label": "Resources by dependency layer",
        }, columns.map((nodes, layer) =>
            element("div", {
                class: "graph-column",
                dataset: { graphLayer: String(layer) },
            }, nodes.map(renderGraphNode)))),
    ]);
    canvas.style.setProperty("--graph-columns", String(columns.length));
    canvas.style.setProperty(
        "--graph-min-width",
        `${columns.length * 220 + Math.max(0, columns.length - 1) * 56 + 40}px`,
    );

    const relationshipItems = graph.edges.flatMap((edge) =>
        edge.types.map((type) =>
            element("li", { text: graphRelationshipSentence(edge, type, nodeByName) })));
    return element("div", {
        class: "app-model-panel",
        id: "graph-view-panel",
        role: "tabpanel",
        "aria-labelledby": "graph-view-tab",
        hidden: !active,
    }, [
        element("header", { class: "graph-heading" }, [
            element("p", {
                text: graph.edges.length
                    ? "Arrows flow from dependencies and parents toward the resources that use them."
                    : "This AppHost has no declared resource relationships.",
            }),
            renderGraphLegend(graph),
        ]),
        element("div", {
            class: "resource-graph-viewport",
            role: "region",
            tabIndex: 0,
            "aria-label": "Scrollable AppHost resource graph",
        }, [canvas]),
        element("ul", {
            class: "sr-only",
            "aria-label": "Resource relationships",
        }, relationshipItems),
    ]);
}

function renderResourceBoardPanel(appHost, resources, dashboardAvailable, active) {
    return element("div", {
        class: "app-model-panel",
        id: "resources-view-panel",
        role: "tabpanel",
        "aria-labelledby": "resources-view-tab",
        hidden: !active,
    }, [
        element("p", {
            class: "app-model-view-description",
            text: resources.length
                ? "Endpoints, health, and commands stay with the resource that owns them."
                : "Start this AppHost to load its evaluated resource model.",
        }),
        resources.length
            ? element("div", {
                class: `resource-board${activeCommandId ? " has-open-command" : ""}`,
                role: "list",
            },
                resources.map((resource) => renderResourceCard({ ...resource, dashboardAvailable })))
            : element("div", { class: "resource-board-empty" }, [
                rowIcon(appHost),
                element("strong", { text: "No live resources yet" }),
                element("span", {
                    text: appHost.unavailableActionReason
                        || "Use the AppHost actions above when you're ready to run it.",
                }),
            ]),
    ]);
}

function graphMarker(presentation) {
    const marker = svgElement("marker", {
        id: `graph-arrow-${presentation.id}`,
        viewBox: "0 0 8 8",
        refX: "7",
        refY: "4",
        markerWidth: "6",
        markerHeight: "6",
        orient: "auto",
    });
    marker.appendChild(svgElement("path", {
        class: `graph-arrow ${presentation.className}`,
        d: "M0 0 L8 4 L0 8 Z",
    }));
    return marker;
}

function graphEdgePath(from, to, canvas, selfEdge, fromLayer, toLayer, reciprocalSide) {
    const fromCenterX = from.left + from.width / 2 - canvas.left;
    const fromCenterY = from.top + from.height / 2 - canvas.top;
    const toCenterX = to.left + to.width / 2 - canvas.left;
    const toCenterY = to.top + to.height / 2 - canvas.top;

    if (selfEdge) {
        const startX = from.right - canvas.left;
        const startY = fromCenterY;
        const endX = fromCenterX;
        const endY = from.top - canvas.top;
        const outerX = startX + 30;
        const outerY = Math.max(8, endY - 24);
        return `M ${startX} ${startY} C ${outerX} ${startY}, ${outerX} ${outerY}, ${endX} ${outerY} S ${endX} ${outerY}, ${endX} ${endY}`;
    }

    if (to.left > from.right + 8) {
        const startX = from.right - canvas.left;
        const startY = fromCenterY;
        const endX = to.left - canvas.left;
        const endY = toCenterY;
        if (toLayer - fromLayer > 1) {
            const firstGutterX = startX + 28;
            const lastGutterX = endX - 28;
            const corridorY = 8;
            return `M ${startX} ${startY} C ${firstGutterX} ${startY}, ${firstGutterX} ${corridorY}, ${firstGutterX} ${corridorY} L ${lastGutterX} ${corridorY} C ${lastGutterX} ${corridorY}, ${lastGutterX} ${endY}, ${endX} ${endY}`;
        }
        const bend = Math.max(28, (endX - startX) * 0.44);
        return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
    }

    if (fromLayer === toLayer) {
        const useRightGutter = reciprocalSide === "right";
        const startX = (useRightGutter ? from.right : from.left) - canvas.left;
        const startY = fromCenterY;
        const endX = (useRightGutter ? to.right : to.left) - canvas.left;
        const endY = toCenterY;
        const gutterX = useRightGutter
            ? Math.min(canvas.width - 6, Math.max(startX, endX) + 16)
            : Math.max(6, Math.min(startX, endX) - 16);
        return `M ${startX} ${startY} C ${gutterX} ${startY}, ${gutterX} ${endY}, ${endX} ${endY}`;
    }

    if (from.left > to.right + 8) {
        const startX = from.left - canvas.left;
        const startY = fromCenterY;
        const endX = to.right - canvas.left;
        const endY = toCenterY;
        const outerY = Math.max(8, Math.min(from.top, to.top) - canvas.top - 24);
        return `M ${startX} ${startY} C ${startX - 32} ${outerY}, ${endX + 32} ${outerY}, ${endX} ${endY}`;
    }

    const downward = toCenterY >= fromCenterY;
    const startX = fromCenterX;
    const endX = toCenterX;
    const startY = (downward ? from.bottom : from.top) - canvas.top;
    const endY = (downward ? to.top : to.bottom) - canvas.top;
    const middleY = (startY + endY) / 2;
    return `M ${startX} ${startY} C ${startX} ${middleY}, ${endX} ${middleY}, ${endX} ${endY}`;
}

function drawResourceGraphEdges() {
    graphDrawFrame = null;
    const canvas = els.tree.querySelector(".resource-graph-canvas");
    const svg = canvas?.querySelector(".graph-edge-layer");
    if (!canvas || !svg || !activeGraphModel) {
        return;
    }

    const canvasBounds = canvas.getBoundingClientRect();
    const nodeElements = new Map([...canvas.querySelectorAll("[data-graph-node-id]")]
        .map((node) => [node.dataset.graphNodeId, node]));
    svg.setAttribute("viewBox", `0 0 ${canvasBounds.width} ${canvasBounds.height}`);
    svg.setAttribute("width", String(canvasBounds.width));
    svg.setAttribute("height", String(canvasBounds.height));

    const definitions = svgElement("defs");
    const presentations = new Map();
    for (const edge of activeGraphModel.edges) {
        const presentation = graphEdgePresentation(edge);
        presentations.set(presentation.id, presentation);
    }
    for (const presentation of presentations.values()) {
        definitions.appendChild(graphMarker(presentation));
    }
    const paths = [];
    const nodeByName = new Map(activeGraphModel.nodes.map((node) => [node.resourceName, node]));
    const edgeKeys = new Set(activeGraphModel.edges.map((edge) => `${edge.from}\u0000${edge.to}`));
    for (const edge of activeGraphModel.edges) {
        const fromElement = nodeElements.get(edge.from);
        const toElement = nodeElements.get(edge.to);
        if (!fromElement || !toElement) {
            continue;
        }
        const fromBounds = fromElement.getBoundingClientRect();
        const toBounds = toElement.getBoundingClientRect();
        const presentation = graphEdgePresentation(edge);
        const fromNode = nodeByName.get(edge.from);
        const toNode = nodeByName.get(edge.to);
        const reciprocalSide = edge.from !== edge.to
            && edgeKeys.has(`${edge.to}\u0000${edge.from}`)
            ? edge.from.localeCompare(edge.to) < 0 ? "left" : "right"
            : undefined;
        const path = svgElement("path", {
            class: `graph-edge ${presentation.className}`,
            d: graphEdgePath(
                fromBounds,
                toBounds,
                canvasBounds,
                edge.from === edge.to,
                fromNode?.layer ?? 0,
                toNode?.layer ?? 0,
                reciprocalSide,
            ),
            "marker-end": `url(#graph-arrow-${presentation.id})`,
        });
        const title = svgElement("title");
        title.textContent = edge.types
            .map((type) => graphRelationshipSentence(edge, type, nodeByName))
            .join(" ");
        path.appendChild(title);
        paths.push(path);
    }
    svg.replaceChildren(definitions, ...paths);
}

function scheduleResourceGraphDraw() {
    if (graphDrawFrame !== null) {
        cancelAnimationFrame(graphDrawFrame);
    }
    graphDrawFrame = requestAnimationFrame(drawResourceGraphEdges);
}

function clearResourceGraphDrawing() {
    activeGraphModel = null;
    graphResizeObserver?.disconnect();
    if (graphDrawFrame !== null) {
        cancelAnimationFrame(graphDrawFrame);
        graphDrawFrame = null;
    }
}

function mountResourceGraph() {
    const canvas = els.tree.querySelector(".resource-graph-canvas");
    if (!canvas || !activeGraphModel) {
        return;
    }
    graphResizeObserver?.observe(canvas);
    scheduleResourceGraphDraw();
}

function rememberAppModelViewState() {
    if (!renderedAppHostId) {
        return;
    }
    const viewport = els.tree.querySelector(".resource-graph-viewport");
    const graphPanel = els.tree.querySelector("#graph-view-panel");
    const graphVisible = Boolean(viewport && graphPanel && !graphPanel.hidden);
    const existing = appModelViewStateByAppHost.get(renderedAppHostId);
    const active = document.activeElement;
    const focusId = active?.id === "resources-view-tab" || active?.id === "graph-view-tab"
        ? active.id
        : null;
    appModelViewStateByAppHost.set(renderedAppHostId, {
        scrollLeft: graphVisible ? viewport.scrollLeft : existing?.scrollLeft ?? 0,
        scrollTop: graphVisible ? viewport.scrollTop : existing?.scrollTop ?? 0,
        focusId,
        viewportFocused: graphVisible && active === viewport,
    });
}

function restoreAppModelViewState(hostId) {
    const state = appModelViewStateByAppHost.get(hostId);
    if (!state) {
        return;
    }
    const viewport = els.tree.querySelector(".resource-graph-viewport");
    if (viewport) {
        viewport.scrollLeft = state.scrollLeft;
        viewport.scrollTop = state.scrollTop;
    }
    if (state.focusId) {
        els.tree.querySelector(`#${state.focusId}`)?.focus();
    } else if (state.viewportFocused && appModelView === "graph") {
        viewport?.focus();
    }
}

function hostStatus(appHost) {
    if (appHost.kind === "apphost-running") {
        return { label: "Running", tone: appHost.tone || "healthy" };
    }
    if (appHost.unavailableActionReason) {
        return { label: "Needs attention", tone: "warning" };
    }
    return { label: "Ready to run", tone: "inactive" };
}

function duplicateHostLabel(appHost, hosts) {
    const matches = hosts.filter((host) => host.label === appHost.label);
    if (matches.length < 2) {
        return appHost.label;
    }
    return `${appHost.label} ${matches.indexOf(appHost) + 1}`;
}

function appHostTabId(appHost) {
    return `apphost-tab-${appHost.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function selectAppHost(appHost) {
    clearActiveCommand();
    activeAppHostId = appHost.id;
    setSelected(appHost);
}

function handleAppHostTabKey(event, hosts, index) {
    let nextIndex;
    if (event.key === "ArrowRight") {
        nextIndex = (index + 1) % hosts.length;
    } else if (event.key === "ArrowLeft") {
        nextIndex = (index - 1 + hosts.length) % hosts.length;
    } else if (event.key === "Home") {
        nextIndex = 0;
    } else if (event.key === "End") {
        nextIndex = hosts.length - 1;
    } else {
        return;
    }
    event.preventDefault();
    selectAppHost(hosts[nextIndex]);
}

function renderAppHostSwitcher(hosts, activeHost) {
    if (hosts.length < 2) {
        return null;
    }
    return element("nav", { class: "apphost-switcher", "aria-label": "Choose an AppHost" }, [
        element("div", { class: "apphost-tabs", role: "tablist", "aria-label": "AppHosts" },
            hosts.map((host, index) => {
                const active = host.id === activeHost.id;
                const status = hostStatus(host);
                return element("button", {
                    class: `apphost-tab${active ? " is-active" : ""}`,
                    type: "button",
                    role: "tab",
                    id: appHostTabId(host),
                    tabIndex: active ? 0 : -1,
                    "aria-selected": active,
                    "aria-controls": "active-apphost",
                    "aria-label":
                        `${duplicateHostLabel(host, hosts)}, ${status.label}, ${index + 1} of ${hosts.length}`,
                    dataset: { nodeId: host.id },
                    on: {
                        click: () => selectAppHost(host),
                        keydown: (event) => handleAppHostTabKey(event, hosts, index),
                    },
                }, [
                    rowIcon(host),
                    element("span", { class: "apphost-tab-copy" }, [
                        element("strong", { text: duplicateHostLabel(host, hosts) }),
                        element("span", { text: status.label }),
                    ]),
                ]);
            })),
    ]);
}

function renderHostNotice(node) {
    return element("div", {
        class: `host-notice${node.tone ? ` tone-${node.tone}` : ""}`,
        role: node.tone === "error" ? "alert" : "status",
    }, [
        rowIcon(node),
        element("span", {}, [
            element("strong", { text: node.label }),
            element("span", { text: node.description }),
        ]),
    ]);
}

function renderHostStage(appHost, hosts) {
    const presentationHost = {
        ...appHost,
        presentationLabel: duplicateHostLabel(appHost, hosts),
    };
    const resources = flattenResources(appHostResources(appHost));
    const status = hostStatus(appHost);
    const notices = (appHost.children ?? [])
        .filter((child) => child.kind === "error" || child.kind === "warning");
    const healthy = resources.filter(({ resource }) => resource.tone === "healthy").length;
    const attention = resources.filter(({ resource }) =>
        resource.tone === "error" || resource.tone === "warning").length;
    const dashboardAvailable = appHost.actions?.includes("dashboard") === true;
    const graph = visibleResourceGraph(appHost, resources);
    return element("article", {
        class: "active-apphost",
        id: "active-apphost",
        role: hosts.length > 1 ? "tabpanel" : undefined,
        "aria-labelledby": hosts.length > 1 ? appHostTabId(appHost) : undefined,
    }, [
        element("header", { class: "apphost-overview" }, [
            element("div", { class: "apphost-heading" }, [
                element("span", { class: "apphost-mark" }, [svgIcon(appHost.icon || "apphost-running", 20)]),
                element("span", { class: "apphost-heading-copy" }, [
                    element("span", { class: "apphost-title-line" }, [
                        element("h2", { text: presentationHost.presentationLabel, title: appHost.label }),
                        actionButton(`More actions for ${presentationHost.presentationLabel}`, "more", (event) =>
                            openActionMenu(presentationHost, event.currentTarget, ["ask"])),
                    ]),
                    element("p", { text: appHost.description }),
                ]),
            ]),
            element("div", { class: "apphost-facts", "aria-label": "AppHost summary" }, [
                element("span", { class: `summary-chip tone-${status.tone}`, text: status.label }),
                element("span", { class: "summary-chip", text: `${resources.length} resource${resources.length === 1 ? "" : "s"}` }),
                ...(healthy ? [element("span", { class: "summary-chip tone-healthy", text: `${healthy} healthy` })] : []),
                ...(attention ? [element("span", { class: "summary-chip tone-warning", text: `${attention} need attention` })] : []),
            ]),
        ]),
        renderAppHostActionTray(presentationHost),
        ...notices.map(renderHostNotice),
        element("section", { class: "resource-workspace", "aria-label": "App model" }, [
            renderAppModelTabs(resources.length, graph.edges.length),
            renderResourceBoardPanel(
                appHost,
                resources,
                dashboardAvailable,
                appModelView === "resources",
            ),
            renderResourceGraphPanel(graph, appModelView === "graph"),
        ]),
    ]);
}

function renderTree() {
    rememberAppModelViewState();
    clearResourceGraphDrawing();
    const source = filteredTree(modelState?.roots ?? [], filterText);
    const hosts = source.filter(isAppHostNode);
    if (activeCommandId && !treeContains(source, activeCommandId)) {
        clearActiveCommand();
    }
    if (hosts.length === 0 && filterText) {
        renderedAppHostId = null;
        els.tree.setAttribute("role", "status");
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
    els.tree.setAttribute("role", "region");
    const selectedHost = hosts.find((host) => host.id === activeAppHostId)
        || hosts.find((host) => host.appHostId === findNode(selectedNodeId)?.appHostId)
        || hosts[0];
    if (!selectedHost) {
        renderedAppHostId = null;
        els.tree.replaceChildren();
        return;
    }
    activeAppHostId = selectedHost.id;
    const currentSelection = findNode(selectedNodeId);
    if (!currentSelection || currentSelection.appHostId !== selectedHost.appHostId) {
        recordSelection(selectedHost);
    }
    const focusState = captureCommandFocus();
    els.tree.replaceChildren(...[
        renderAppHostSwitcher(hosts, selectedHost),
        renderHostStage(selectedHost, hosts),
    ].filter(Boolean));
    renderedAppHostId = selectedHost.id;
    mountResourceGraph();
    restoreAppModelViewState(selectedHost.id);
    restoreCommandFocus(focusState);
    if (confirmationNeedsFocus) {
        confirmationNeedsFocus = false;
        requestAnimationFrame(() => els.tree.querySelector("[data-confirmation-cancel]")?.focus());
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
    const control = els.tree.querySelector(`.command-form [name="${CSS.escape(focusState.name)}"]`);
    if (!control) {
        return;
    }
    control.focus();
    if (focusState.selectionStart !== null && typeof control.setSelectionRange === "function") {
        control.setSelectionRange(focusState.selectionStart, focusState.selectionEnd);
    }
}

function hideActionMenu({ restoreFocus = false } = {}) {
    const trigger = actionMenuTrigger;
    actionMenuNodeId = null;
    actionMenuTrigger = null;
    els.actionMenu.hidden = true;
    els.actionMenu.replaceChildren();
    if (restoreFocus && trigger?.isConnected) {
        trigger.focus();
    }
}

function menuAction(action, node) {
    const definition = ACTIONS[action];
    const label = action === "ask"
        ? `Add ${node.presentationLabel || node.label} to chat`
        : definition.label;
    return element("button", {
        class: "menu-action",
        type: "button",
        role: "menuitem",
        on: {
            click: () => {
                hideActionMenu({ restoreFocus: true });
                void executeNodeAction(action, node);
            },
        },
    }, [svgIcon(definition.icon, 14), label]);
}

function openActionMenu(node, anchor, actions) {
    if (actionMenuNodeId === node.id && !els.actionMenu.hidden) {
        hideActionMenu();
        return;
    }
    actionMenuNodeId = node.id;
    actionMenuTrigger = anchor;
    const actionNames = actions ?? [...(node.actions ?? []), "ask"];
    els.actionMenu.replaceChildren(...actionNames.map((action) =>
        action === "separator"
            ? element("div", { class: "menu-separator", role: "separator" })
            : menuAction(action, node)));
    els.actionMenu.hidden = false;
    const bounds = anchor.getBoundingClientRect();
    const menuWidth = 228;
    const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, bounds.right - menuWidth));
    els.actionMenu.style.left = `${left}px`;
    els.actionMenu.style.top = `${Math.max(
        8,
        Math.min(window.innerHeight - els.actionMenu.offsetHeight - 8, bounds.bottom + 3),
    )}px`;
    els.actionMenu.querySelector("button")?.focus();
}

async function executeNodeAction(action, node) {
    pendingConfirmation = null;
    if (action === "ask") {
        try {
            const result = await api("/api/copilot-context", { method: "POST", body: { nodeId: node.id } });
            showToast(
                result.ok ? `Added ${node.label} to chat. Finish your question in the composer.` : result.error,
                !result.ok,
            );
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
        try {
            const result = await api("/api/open-dashboard", {
                method: "POST",
                body: { appHostId: node.appHostId },
            });
            showToast(result.ok ? "Opened the dashboard in the integrated browser." : result.error, !result.ok);
        } catch (error) {
            showToast(error.message, true);
        }
        return;
    }
    if (DASHBOARD_VIEW_ACTIONS[action]) {
        try {
            const result = await api("/api/open-dashboard-view", {
                method: "POST",
                body: { nodeId: node.id, view: DASHBOARD_VIEW_ACTIONS[action] },
            });
            showToast(
                result.ok ? `Opened ${ACTIONS[action].label.toLowerCase()} in the Dashboard.` : result.error,
                !result.ok,
            );
        } catch (error) {
            showToast(error.message, true);
        }
        return;
    }
    if (action === "endpoint") {
        try {
            const result = await api("/api/open-endpoint", {
                method: "POST",
                body: { nodeId: node.id },
            });
            showToast(result.ok ? `Opened ${node.label} in the integrated browser.` : result.error, !result.ok);
        } catch (error) {
            showToast(error.message, true);
        }
        return;
    }
    if (action === "terminal") {
        try {
            const result = await api("/api/open-terminal", {
                method: "POST",
                body: { nodeId: node.id },
            });
            showToast(result.ok ? `Opened a terminal for ${node.label}.` : result.error, !result.ok);
        } catch (error) {
            showToast(error.message, true);
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

function focusCommandPanel(nodeId) {
    const panel = els.tree.querySelector(`[data-command-panel="${CSS.escape(nodeId)}"]`);
    panel?.querySelector("input:not([disabled]), select:not([disabled]), button:not([disabled])")?.focus();
}

function toggleCommandPanel(node, { focusPanel = false } = {}) {
    if (activeCommandId === node.id) {
        closeCommandPanel(node, { restoreFocus: true });
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
    if (focusPanel) {
        requestAnimationFrame(() => focusCommandPanel(node.id));
    }
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

function closeCommandPanel(node, { restoreFocus = true } = {}) {
    if (activeCommandId === node.id) {
        clearActiveCommand();
    } else {
        discardSensitiveCommandDraft(node);
    }
    renderTree();
    if (restoreFocus) {
        requestAnimationFrame(() => focusNodeControl(node.id));
    }
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
        return element("div", { class: "inline-panel", dataset: { commandPanel: node.id } }, [
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
                    on: {
                        click: () => {
                            secretWarningAccepted = true;
                            renderTree();
                            requestAnimationFrame(() => focusCommandPanel(node.id));
                        },
                    },
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
    return element("div", { class: "inline-panel", dataset: { commandPanel: node.id } }, [form]);
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
    const nextViewMode = modelState?.viewMode ?? null;
    const viewModeChanged = Boolean(renderedViewMode && nextViewMode !== renderedViewMode);
    if (viewModeChanged && modelState?.status === "loading" && modelState.refreshing) {
        if (pendingViewMode !== nextViewMode) {
            beginModeSwitch(nextViewMode);
        }
        updateHeader();
        updateStatus();
        updateBusy();
        return;
    }

    const draw = () => {
        if (viewModeChanged) {
            clearActiveCommand();
            selectedNodeId = null;
            activeAppHostId = null;
        }
        renderedViewMode = nextViewMode;
        if (selectedNodeId && !findNode(selectedNodeId)) {
            selectedNodeId = null;
        }
        if (pendingConfirmation && !findNode(pendingConfirmation.nodeId)) {
            pendingConfirmation = null;
        }
        if (activeCommandId && !findNode(activeCommandId)) {
            clearActiveCommand();
        }
        if (
            pendingViewMode
            && modelState?.viewMode === pendingViewMode
            && modelState?.status !== "loading"
        ) {
            finishModeSwitch();
        }
        updateHeader();
        updateStatus();
        updateEmptyAndLoading();
        renderTree();
        updateBusy();
    };

    if (viewModeChanged) {
        withModeTransition(nextViewMode, draw);
    } else {
        draw();
    }
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
    if (modelState?.viewMode === viewMode || pendingViewMode) {
        return;
    }
    hideActionMenu();
    selectedNodeId = null;
    activeAppHostId = null;
    clearActiveCommand();
    pendingConfirmation = null;
    beginModeSwitch(viewMode);
    updateHeader();
    try {
        const result = await api("/api/mode", { method: "POST", body: { viewMode } });
        modelState = result.state;
        render();
    } catch (error) {
        finishModeSwitch();
        updateHeader();
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
    if (!els.actionMenu.hidden && !event.target.closest("#action-menu, .resource-menu-trigger")) {
        hideActionMenu();
    }
});
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        if (!els.actionMenu.hidden) {
            event.preventDefault();
            hideActionMenu({ restoreFocus: true });
        } else if (activeCommandId) {
            const command = findNode(activeCommandId);
            if (command) {
                event.preventDefault();
                closeCommandPanel(command, { restoreFocus: true });
            }
        }
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
