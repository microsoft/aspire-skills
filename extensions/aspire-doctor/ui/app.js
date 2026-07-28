// Aspire Doctor — canvas renderer
//
// Renders `aspire doctor` results from the extension's loopback API.

const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? { matches: false };

const STATUS_CLASS = { pass: "ok", warning: "warn", fail: "req" };
const STATUS_LABEL = { pass: "Passed", warning: "Warning", fail: "Failed" };
const STATUS_PRIORITY = { fail: 0, warning: 1, pass: 2 };

const CATEGORY_ORDER = ["aspire", "sdk", "environment", "container"];
const CATEGORY_LABEL = {
    aspire: "Aspire CLI",
    sdk: ".NET SDK",
    environment: "Environment",
    container: "Container runtime",
};

/* ---------------- Octicon paths (16x16) ---------------- */
const ICONS = {
    ok: "M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z",
    warn: "M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.383c.62 1.161-.223 2.57-1.543 2.57H1.918c-1.32 0-2.163-1.409-1.543-2.57Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.137a.25.25 0 0 0 .22.363h12.164a.25.25 0 0 0 .22-.363Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z",
    req: "M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94Z",
    info: "M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z",
    chevron: "M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z",
    check: "M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z",
    dot: "M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z",
    send: "M.989 8 .064 2.68a1.342 1.342 0 0 1 1.85-1.462l13.402 5.744a1.13 1.13 0 0 1 0 2.076L1.913 14.782a1.343 1.343 0 0 1-1.85-1.462L.99 8Zm.603-5.288L2.68 8 1.59 13.288 14.5 8 1.592 2.712Z",
    spinner: "M8 0a8 8 0 0 1 8 8h-1.5A6.5 6.5 0 0 0 8 1.5V0Z",
    link: "M7.775 3.275a.75.75 0 0 0 1.06 1.06l.25-.25a2 2 0 1 1 2.83 2.83l-2.5 2.5a2 2 0 0 1-2.83 0 .75.75 0 0 0-1.06 1.06 3.5 3.5 0 0 0 4.95 0l2.5-2.5a3.5 3.5 0 0 0-4.95-4.95l-.25.25Zm-4.75 4.75a3.5 3.5 0 0 1 4.95 0 .75.75 0 0 1-1.06 1.06 2 2 0 0 0-2.83 0l-2.5 2.5a2 2 0 1 0 2.83 2.83l.25-.25a.75.75 0 1 1 1.06 1.06l-.25.25a3.5 3.5 0 0 1-4.95-4.95l2.5-2.5Zm2.47 2.47a.75.75 0 0 1 1.06 0l2.95-2.95a.75.75 0 1 1 1.06 1.06l-2.95 2.95a.75.75 0 0 1-1.06-1.06Z",
    terminal: "M0 2.75C0 1.784.784 1 1.75 1h12.5C15.216 1 16 1.784 16 2.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25Zm1.75-.25a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25Zm2.22 3.22a.75.75 0 0 1 1.06 0l2 2a.75.75 0 0 1 0 1.06l-2 2a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L5.44 8 3.97 6.53a.75.75 0 0 1 0-1.06ZM8.75 10h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1 0-1.5Z",
};

/* ---------------- DOM helpers ---------------- */

function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value == null) {
            continue;
        }
        if (key === "class") {
            node.className = value;
        } else if (key === "text") {
            node.textContent = value;
        } else if (key === "html") {
            node.innerHTML = value;
        } else if (key === "dataset") {
            Object.assign(node.dataset, value);
        } else {
            node.setAttribute(key, value);
        }
    }
    for (const child of [].concat(children)) {
        if (child == null) {
            continue;
        }
        node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
}

function icon(pathKey, { size = 16, cls } = {}) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    if (cls) {
        svg.setAttribute("class", cls);
    }
    const path = document.createElementNS(ns, "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("d", ICONS[pathKey]);
    svg.appendChild(path);
    return svg;
}

function withTransition(mutate) {
    if (document.startViewTransition && !reduceMotion.matches) {
        document.startViewTransition(() => mutate());
    } else {
        mutate();
    }
}

/* ---------------- element refs ---------------- */

const bodyEl = document.body;
const els = {
    tbSub: document.getElementById("tb-sub"),
    pills: document.getElementById("summary-pills"),
    countOk: document.getElementById("count-ok"),
    countWarn: document.getElementById("count-warn"),
    countReq: document.getElementById("count-req"),
    pillOk: document.getElementById("pill-ok"),
    pillWarn: document.getElementById("pill-warn"),
    pillReq: document.getElementById("pill-req"),
    lblWarn: document.getElementById("lbl-warn"),
    rerun: document.getElementById("rerun"),
    skeleton: document.getElementById("skeleton"),
    diagnostics: document.getElementById("diagnostics"),
    error: document.getElementById("error"),
    errorMsg: document.getElementById("error-msg"),
    errorRaw: document.getElementById("error-raw"),
};

function setBodyState(state) {
    bodyEl.classList.remove("is-loading", "is-busy", "has-data", "has-error");
    bodyEl.classList.add(state);
}

/* ---------------- rendering ---------------- */

function severityRank(status) {
    return STATUS_PRIORITY[status] ?? 3;
}

function categoryRank(category) {
    const index = CATEGORY_ORDER.indexOf(category);
    return index === -1 ? CATEGORY_ORDER.length : index;
}

function orderedCategories(checks) {
    const byCategory = new Map();
    for (const check of checks) {
        const cat = check.category || "other";
        const existing = byCategory.get(cat);
        if (existing) {
            existing.worst = Math.min(existing.worst, severityRank(check.status));
        } else {
            byCategory.set(cat, {
                category: cat,
                firstIndex: check.__index ?? 0,
                worst: severityRank(check.status),
            });
        }
    }
    return [...byCategory.values()]
        .sort((a, b) => a.worst - b.worst || categoryRank(a.category) - categoryRank(b.category) || a.firstIndex - b.firstIndex)
        .map((entry) => entry.category);
}

function sortChecksBySeverity(checks) {
    return [...checks].sort((a, b) => severityRank(a.status) - severityRank(b.status) || (a.__index ?? 0) - (b.__index ?? 0));
}

function normalizeStatus(status) {
    const text = String(status ?? "").toLowerCase();
    return text === "passed" || text === "ok" || text === "success" ? "pass"
        : text === "warn" ? "warning"
        : text === "failed" || text === "error" ? "fail"
        : text;
}

function deriveSummary(checks) {
    const summary = { passed: 0, warnings: 0, failed: 0 };
    for (const check of checks) {
        if (check.status === "pass") {
            summary.passed++;
        } else if (check.status === "warning") {
            summary.warnings++;
        } else if (check.status === "fail") {
            summary.failed++;
        }
    }
    return summary;
}

function normalizeSummary(summary, checks) {
    const derived = deriveSummary(checks);
    return {
        passed: Number.isFinite(Number(summary?.passed)) ? Number(summary.passed) : derived.passed,
        warnings: Number.isFinite(Number(summary?.warnings)) ? Number(summary.warnings) : derived.warnings,
        failed: Number.isFinite(Number(summary?.failed)) ? Number(summary.failed) : derived.failed,
    };
}

function normalizeDoctorData(raw) {
    const rawChecks = Array.isArray(raw?.checks) ? raw.checks : [];
    const checks = rawChecks
        .filter((check) => check && typeof check === "object")
        .map((check, index) => ({
            ...check,
            __index: index,
            category: String(check.category ?? "other").trim() || "other",
            name: String(check.name ?? "check"),
            status: normalizeStatus(check.status),
            message: check.message == null ? "" : String(check.message),
            fix: check.fix == null ? "" : String(check.fix),
            metadata: check.metadata && typeof check.metadata === "object" ? check.metadata : null,
        }));

    return {
        ...raw,
        checks,
        summary: normalizeSummary(raw?.summary, checks),
        installations: Array.isArray(raw?.installations) ? raw.installations : [],
        formatNotice: Array.isArray(raw?.checks)
            ? null
            : "Aspire Doctor returned JSON without a checks array. The canvas is showing the parts it can still understand.",
    };
}

function renderMetadata(metadata) {
    const list = el("div", { class: "diag-meta-list" });
    for (const [key, value] of Object.entries(metadata)) {
        list.appendChild(el("div", { class: "diag-meta-row" }, [
            el("div", { class: "diag-meta-key", text: key }),
            el("div", { class: "diag-meta-value" }, [renderMetadataValue(key, value)]),
        ]));
    }
    return list;
}

function renderMetadataValue(key, value) {
    if (key === "certificates" && Array.isArray(value)) {
        return renderCertificateList(value);
    }

    return renderStructuredMetadataValue(value);
}

function renderStructuredMetadataValue(value) {
    if (value === null) {
        return document.createTextNode("null");
    }

    if (Array.isArray(value)) {
        return renderMetadataArray(value);
    }

    if (typeof value === "object") {
        return renderMetadataObject(value);
    }

    return renderPathValue(String(value), "metadata");
}

function renderMetadataArray(values) {
    if (values.length === 0) {
        return document.createTextNode("[]");
    }

    if (values.every((value) => value === null || typeof value !== "object")) {
        return el("div", { class: "meta-chip-list" }, values.map((value) => el("span", { class: "meta-chip" }, [
            renderStructuredMetadataValue(value),
        ])));
    }

    return el("div", { class: "meta-stack" }, values.map((value, index) => el("div", { class: "meta-card" }, [
        el("div", { class: "meta-card-title", text: `Item ${index + 1}` }),
        renderStructuredMetadataValue(value),
    ])));
}

function renderMetadataObject(value) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
        return document.createTextNode("{}");
    }

    const dl = el("dl", { class: "meta-object" });
    for (const [key, nestedValue] of entries) {
        dl.append(el("dt", { text: key }), el("dd", {}, [renderStructuredMetadataValue(nestedValue)]));
    }
    return dl;
}

function renderCertificateList(certificates) {
    if (certificates.length === 0) {
        return document.createTextNode("None");
    }

    return el("div", { class: "cert-list" }, certificates.map((certificate, index) => renderCertificate(certificate, index)));
}

function renderCertificate(certificate, index) {
    if (!certificate || typeof certificate !== "object") {
        return el("div", { class: "cert-card" }, [
            el("div", { class: "cert-title", text: `Certificate ${index + 1}` }),
            el("div", { class: "cert-value", text: String(certificate) }),
        ]);
    }

    const fields = [
        ["thumbprint", "Thumbprint"],
        ["version", "Version"],
        ["trustLevel", "Trust level"],
        ["notBefore", "Valid from"],
        ["notAfter", "Valid until"],
    ];
    const rows = fields
        .filter(([field]) => certificate[field] !== undefined && certificate[field] !== null && String(certificate[field]).trim())
        .map(([field, label]) => el("div", { class: "cert-row" }, [
            el("span", { class: "cert-key", text: label }),
            el("span", {
                class: field === "thumbprint" ? "cert-value is-thumbprint" : "cert-value",
                text: formatCertificateValue(field, certificate[field]),
            }),
        ]));

    return el("div", { class: "cert-card" }, [
        el("div", { class: "cert-title", text: `Certificate ${index + 1}` }),
        ...rows,
    ]);
}

function formatCertificateValue(field, value) {
    if (field === "trustLevel") {
        return String(value)
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .toLowerCase();
    }

    if (field === "notBefore" || field === "notAfter") {
        return formatCertificateDate(value);
    }

    return String(value);
}

function formatCertificateDate(value) {
    const text = String(value);
    // Doctor emits .NET "O" timestamps such as:
    //   2026-02-24T09:09:18.0000000-08:00
    // JavaScript Date accepts millisecond precision, so trim extra fractional
    // digits before formatting for display.
    const jsDateText = text.replace(/\.(\d{3})\d+(?=[+-]\d{2}:\d{2}|Z$)/, ".$1");
    const date = new Date(jsDateText);
    if (Number.isNaN(date.getTime())) {
        return text;
    }

    return date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
    });
}

function isPathLike(value) {
    const knownFile = /\.(cs|csproj|fs|fsproj|props|targets|jsonc?|md|txt|ya?ml|xml)$/i.test(value);
    return /^[A-Za-z]:[\\/]/.test(value) ||
        value.startsWith("/") ||
        value.startsWith("\\\\") ||
        value.startsWith("file://") ||
        (knownFile && !/\s/.test(value));
}

function renderPathValue(value, variant = "default") {
    if (!isPathLike(value)) {
        return document.createTextNode(value);
    }

    const btn = el("button", {
        class: `path-link ${variant === "install" ? "install-path" : ""}`,
        type: "button",
        title: "Open this path",
    }, [el("span", { text: value }), icon("link", { size: 12 })]);
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPath(value, btn);
    });
    return btn;
}

async function openPath(path, btn) {
    await runButtonAction(btn, {
        stateClasses: ["is-error", "is-opened"],
        resetDelay: 1800,
        action: () => postJson("/api/open-path", { path }),
        onSuccess: () => {
            btn.classList.add("is-opened");
        },
        onFailure: (data) => {
            btn.classList.add("is-error");
            btn.title = data.error || "Couldn't open this path";
        },
    });
}

function renderFixBlock(check) {
    const terminalBtn = el("button", {
        class: "fix-send",
        type: "button",
        title: "Open a terminal canvas for this check",
        dataset: { restingLabel: "Open terminal" },
    }, [
        icon("terminal", { size: 13 }),
        el("span", { class: "fix-send-label", text: "Open terminal" }),
    ]);
    terminalBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openTerminalForCheck(check, terminalBtn);
    });

    const askBtn = el("button", {
        class: "fix-send",
        type: "button",
        title: "Ask Copilot about this check in the current session",
        dataset: { restingLabel: "Ask Copilot" },
    }, [
        icon("send", { size: 13 }),
        el("span", { class: "fix-send-label", text: "Ask Copilot" }),
    ]);
    askBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        sendFixToAgent(check, askBtn);
    });

    const bodyChildren = [el("div", { class: "diag-block-h", text: check.fix ? "Suggested fix" : "Actions" })];
    bodyChildren.push(el("div", {
        class: "diag-note",
        text: check.fix || "Choose how you want to investigate or resolve this check.",
    }));

    return el("div", { class: "diag-fix" }, [
        el("div", { class: "diag-fix-body" }, bodyChildren),
        el("div", { class: "diag-fix-actions" }, [askBtn, terminalBtn]),
    ]);
}

async function openTerminalForCheck(check, btn) {
    await runButtonAction(btn, {
        stateClasses: ["is-error", "is-sent"],
        busyLabel: "Opening…",
        resetLabel: "Open terminal",
        action: () => postJson("/api/open-terminal", {
            check: {
                category: check.category,
                name: check.name,
                status: check.status,
            },
        }),
        onSuccess: () => {
            btn.classList.add("is-sent");
            setSendLabel(btn, "Opened terminal");
        },
        onFailure: () => {
            btn.classList.add("is-error");
            setSendLabel(btn, "Couldn't open");
        },
    });
}

async function postJson(path, body) {
    const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ...data, ok: res.ok && data.ok };
}

async function runButtonAction(btn, options) {
    if (btn.dataset.busy === "true") {
        return;
    }
    btn.dataset.busy = "true";
    btn.disabled = true;
    btn.classList.remove(...options.stateClasses);
    if (options.busyLabel) {
        setSendLabel(btn, options.busyLabel);
    }

    try {
        const data = await options.action();
        if (data.ok) {
            options.onSuccess?.(data);
        } else {
            options.onFailure?.(data);
        }
    } catch (err) {
        options.onFailure?.({ error: err?.message ?? String(err) });
    } finally {
        btn.dataset.busy = "false";
        btn.disabled = false;
        setTimeout(() => {
            btn.classList.remove(...options.stateClasses);
            if (options.resetLabel || btn.dataset.restingLabel) {
                setSendLabel(btn, options.resetLabel || btn.dataset.restingLabel);
            }
        }, options.resetDelay ?? 3200);
    }
}

function setSendLabel(btn, text) {
    const label = btn.querySelector(".fix-send-label");
    if (label) {
        label.textContent = text;
    }
}

async function sendFixToAgent(check, btn) {
    await runButtonAction(btn, {
        stateClasses: ["is-error", "is-sent"],
        busyLabel: "Asking…",
        resetLabel: "Ask Copilot",
        action: () => postJson("/api/ask-copilot", {
            name: check.name,
            status: check.status,
            category: check.category,
            message: check.message,
            fix: check.fix,
        }),
        onSuccess: () => {
            btn.classList.add("is-sent");
            setSendLabel(btn, "Queued for Copilot");
        },
        onFailure: () => {
            btn.classList.add("is-error");
            setSendLabel(btn, "Couldn't send");
        },
    });
}

function renderCheck(check) {
    const cls = STATUS_CLASS[check.status] ?? "info";
    const itemClass = cls === "warn" || cls === "req" ? `diag-item is-${cls}` : "diag-item";
    const hasFix = typeof check.fix === "string" && check.fix.trim().length > 0;
    const needsAttention = check.status === "warning" || check.status === "fail";
    const hasMeta = check.metadata && Object.keys(check.metadata).length > 0;
    const expandable = hasFix || needsAttention || hasMeta;

    const iconEl = el("span", { class: `diag-ico ${cls}` }, [icon(cls === "info" ? "info" : cls)]);
    const head = el("div", { class: "diag-head" }, [
        el("span", { class: "diag-id", text: check.name || "check" }),
        el("span", { class: `diag-level ${cls}`, text: STATUS_LABEL[check.status] ?? check.status ?? "" }),
    ]);
    const text = el("div", { class: "diag-text" }, [
        head,
        check.message ? el("div", { class: "diag-note", text: check.message }) : null,
    ]);

    if (!expandable) {
        return el("div", { class: itemClass }, [el("div", { class: "diag-row static" }, [iconEl, text])]);
    }

    const summary = el("summary", { class: "diag-row" }, [
        iconEl,
        text,
        el("span", { class: "diag-chevron" }, [icon("chevron", { size: 14 })]),
    ]);

    const detail = el("div", { class: "diag-detail" });
    if (hasFix || needsAttention) {
        detail.appendChild(renderFixBlock(check));
    }
    if (hasMeta) {
        detail.appendChild(
            el("div", { class: "diag-block" }, [
                el("div", { class: "diag-block-h", text: "Details" }),
                renderMetadata(check.metadata),
            ]),
        );
    }

    const open = check.status === "fail" || check.status === "warning";
    return el("details", { class: itemClass, ...(open ? { open: "" } : {}) }, [summary, detail]);
}

function renderDiagnostics(data) {
    const checks = Array.isArray(data.checks) ? data.checks.map((check, index) => ({ ...check, __index: index })) : [];
    const frag = document.createDocumentFragment();

    if (data.formatNotice) {
        frag.appendChild(
            el("section", { class: "state-card format-notice" }, [
                el("div", { class: "state-title", text: "Doctor output format changed" }),
                el("div", { class: "state-msg muted", text: data.formatNotice }),
            ]),
        );
    }

    if (checks.length === 0) {
        frag.appendChild(
            el("section", { class: "state-card" }, [
                el("div", { class: "state-title", text: "No checks reported" }),
                el("div", { class: "state-msg muted", text: "The diagnostics command completed, but no environment checks were returned." }),
            ]),
        );
    }

    for (const category of orderedCategories(checks)) {
        const items = sortChecksBySeverity(checks.filter((c) => (c.category || "other") === category));
        if (items.length === 0) {
            continue;
        }

        const head = el("div", { class: "diag-sec-head" }, [
            el("span", { class: "diag-sec-title", text: CATEGORY_LABEL[category] ?? category }),
        ]);
        const list = el("div", { class: "diag-list" }, items.map(renderCheck));
        frag.appendChild(el("div", { class: "diag-section" }, [head, list]));
    }

    const installs = Array.isArray(data.installations) ? data.installations : [];
    if (installs.length > 0) {
        const head = el("div", { class: "diag-sec-head" }, [
            el("span", { class: "diag-sec-title", text: `Detected installations (${installs.length})` }),
        ]);
        const list = el(
            "div",
            { class: "diag-list" },
            installs.map((inst) => el("div", { class: "diag-item install-card" }, [renderInstallation(inst)])),
        );
        frag.appendChild(el("div", { class: "diag-section" }, [head, list]));
    }

    els.diagnostics.replaceChildren(frag);
}

function renderSummary(summary) {
    const passed = summary?.passed ?? 0;
    const warnings = summary?.warnings ?? 0;
    const failed = summary?.failed ?? 0;

    els.countOk.textContent = String(passed);
    els.countWarn.textContent = String(warnings);
    els.countReq.textContent = String(failed);
    els.lblWarn.textContent = warnings === 1 ? "warning" : "warnings";
    els.pillOk.dataset.zero = passed === 0 ? "true" : "false";
    els.pillWarn.dataset.zero = warnings === 0 ? "true" : "false";
    els.pillReq.dataset.zero = failed === 0 ? "true" : "false";
    els.pills.hidden = false;

    if (failed > 0) {
        els.tbSub.textContent = `${failed} failed · ${warnings} warning${warnings === 1 ? "" : "s"}`;
    } else if (warnings > 0) {
        els.tbSub.textContent = `All required checks passed · ${warnings} warning${warnings === 1 ? "" : "s"}`;
    } else {
        els.tbSub.textContent = "Everything looks good";
    }
}

function renderInstallation(inst) {
    const active = inst.pathStatus === "active";
    const displayPath = inst.path || inst.canonicalPath || "(unknown path)";
    const body = el("div", { class: "install-body" }, [
        el("div", {}, [renderPathValue(displayPath, "install")]),
    ]);

    const tags = el("div", { class: "install-tags" });
    tags.appendChild(el("span", { class: `tag ${active ? "active" : "shadowed"}`, text: inst.pathStatus || "unknown" }));
    if (inst.version) {
        tags.appendChild(el("span", { class: "tag", text: `v${String(inst.version).split("+")[0]}` }));
    }
    if (inst.channel) {
        tags.appendChild(el("span", { class: "tag", text: inst.channel }));
    }
    if (inst.route) {
        tags.appendChild(el("span", { class: "tag", text: inst.route }));
    }
    body.appendChild(tags);

    if (inst.statusReason) {
        body.appendChild(el("div", { class: "install-reason", text: inst.statusReason }));
    }

    return el("div", { class: "install" }, [
        el("span", { class: `install-ico ${active ? "active" : ""}` }, [icon(active ? "ok" : "dot", { size: 14 })]),
        body,
    ]);
}

/* ---------------- state application ---------------- */

function applyResult(result) {
    if (!result || !result.ok) {
        showError(result?.error ?? "Unknown error.", result?.raw);
        return;
    }
    const data = normalizeDoctorData(result.data ?? {});
    withTransition(() => {
        renderDiagnostics(data);
        renderSummary(data.summary);
        els.error.hidden = true;
        els.skeleton.hidden = true;
        els.diagnostics.hidden = false;
        setBodyState("has-data");
    });
}

function showError(message, raw) {
    withTransition(() => {
        els.errorMsg.textContent = message;
        if (raw) {
            els.errorRaw.textContent = raw;
            els.errorRaw.hidden = false;
        } else {
            els.errorRaw.hidden = true;
        }
        els.skeleton.hidden = true;
        els.diagnostics.hidden = true;
        els.error.hidden = false;
        els.pills.hidden = true;
        els.tbSub.textContent = "Check failed to run";
        setBodyState("has-error");
    });
}

/* ---------------- data fetching ---------------- */

let busy = false;

async function loadDiagnostics({ initial = false } = {}) {
    if (busy) {
        return;
    }
    busy = true;
    els.rerun.disabled = true;
    bodyEl.classList.add("is-busy");
    if (initial) {
        els.tbSub.textContent = "Checking your environment…";
    }

    try {
        const res = await fetch("/api/diagnostics", { headers: { Accept: "application/json" } });
        const result = await res.json();
        applyResult(result);
    } catch (err) {
        showError(`Could not reach the diagnostics service: ${err?.message ?? err}`);
    } finally {
        busy = false;
        els.rerun.disabled = false;
        bodyEl.classList.remove("is-busy");
    }
}

/* ---------------- server-sent events ---------------- */

function connectEvents() {
    let es;
    try {
        es = new EventSource("/events");
    } catch {
        return; // SSE is an enhancement; the initial fetch already populated the UI.
    }
    es.addEventListener("message", (e) => {
        let msg;
        try {
            msg = JSON.parse(e.data);
        } catch {
            return;
        }
        if (msg?.type === "diagnostics") {
            applyResult(msg.result);
        }
    });
}

/* ---------------- wiring ---------------- */

els.rerun.addEventListener("click", () => loadDiagnostics());

async function initialize() {
    connectEvents();
    await loadDiagnostics({ initial: true });
}

initialize();
