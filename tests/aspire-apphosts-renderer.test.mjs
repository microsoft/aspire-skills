import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { sanitizeCommandArgumentInputs, validateCommandArguments } from "../extensions/aspire-apphosts/lib/app-model.mjs";

const rendererSource = await readFile(new URL("../extensions/aspire-apphosts/ui/app.js", import.meta.url), "utf8");
const markup = await readFile(new URL("../extensions/aspire-apphosts/ui/index.html", import.meta.url), "utf8");
const styles = await readFile(new URL("../extensions/aspire-apphosts/ui/styles.css", import.meta.url), "utf8");
const sharedStyles = await readFile(new URL("../assets/canvas/theme.css", import.meta.url), "utf8");
const settle = () => new Promise((resolve) => setImmediate(resolve));

// A bounded DOM/event adapter for executing the shipped renderer without a browser dependency.
// Layout and native-browser behavior are covered by the separate browser smoke test.
class TestElement {
    constructor(tag, document) {
        this.tagName = tag.toUpperCase();
        this.ownerDocument = document;
        this.children = [];
        this.parentElement = null;
        this.attributes = new Map();
        this.listeners = new Map();
        this.dataset = {};
        this.style = { setProperty(name, value) { this[name] = value; } };
        Object.assign(this, {
            id: "", className: "", name: "", value: "", type: "", title: "", htmlFor: "",
            hidden: false, disabled: false, checked: false, required: false, inert: false,
            open: false, returnValue: "", formNoValidate: false, method: "", selected: false,
            tabIndex: 0, scrollTop: 0, scrollLeft: 0,
        });
        if (this.tagName === "SELECT") {
            const options = () => this.children.filter((child) => child.tagName === "OPTION");
            Object.defineProperty(this, "value", {
                get: () => (options().find((option) => option.selected) ?? options()[0])?.value ?? "",
                set: (value) => { for (const option of options()) option.selected = option.value === String(value); },
            });
        }
        this.classList = {
            contains: (name) => this.className.split(/\s+/).includes(name),
            add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
            remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); },
            toggle: (name, force) => {
                const add = force ?? !this.classList.contains(name);
                this.classList[add ? "add" : "remove"](name);
                return add;
            },
        };
    }

    get textContent() {
        return this._text ?? this.children.map((child) => child.textContent).join("");
    }

    set textContent(value) {
        this.replaceChildren();
        this._text = String(value);
    }

    get isConnected() {
        return this === this.ownerDocument.documentElement || Boolean(this.parentElement?.isConnected);
    }

    get offsetHeight() { return 180; }

    getBoundingClientRect() {
        return { left: 0, top: 0, right: 320, bottom: 60, width: 320, height: 60 };
    }

    appendChild(child) {
        child.remove();
        this._text = undefined;
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    replaceChildren(...children) {
        for (const child of this.children) child.parentElement = null;
        this.children = [];
        this._text = undefined;
        for (const child of children) this.appendChild(child);
    }

    remove() {
        if (this.parentElement) {
            this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
            this.parentElement = null;
        }
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        const property = { class: "className", for: "htmlFor", tabindex: "tabIndex", formnovalidate: "formNoValidate" }[name] ?? name;
        if (name.startsWith("data-")) {
            this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
        } else if (["hidden", "disabled", "checked", "required", "open", "formnovalidate"].includes(name)) {
            this[property] = true;
        } else if (property in this && !name.startsWith("aria-")) {
            this[property] = String(value);
        }
    }

    getAttribute(name) {
        if (name.startsWith("data-")) {
            return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] ?? null;
        }
        const property = { class: "className", for: "htmlFor", tabindex: "tabIndex", formnovalidate: "formNoValidate" }[name] ?? name;
        if (["hidden", "disabled", "checked", "required", "open", "formnovalidate"].includes(name)) {
            return this[property] ? "" : null;
        }
        if (property in this && typeof this[property] !== "object" && !name.startsWith("aria-")) {
            return String(this[property]);
        }
        return this.attributes.get(name) ?? null;
    }

    removeAttribute(name) {
        this.attributes.delete(name);
        if (["hidden", "disabled", "required", "open"].includes(name)) this[name] = false;
    }

    matches(selector) {
        if (selector.includes(",")) return selector.split(",").some((part) => this.matches(part.trim()));
        const nots = [...selector.matchAll(/:not\(([^)]+)\)/g)];
        if (nots.some(([, excluded]) => this.matches(excluded))) return false;
        selector = selector.replace(/:not\([^)]+\)/g, "");
        const tag = selector.match(/^[a-z][a-z0-9-]*/i)?.[0];
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        const id = selector.match(/#([^\s.[\]]+)/)?.[1];
        if (id && this.id !== id) return false;
        for (const [, name] of selector.matchAll(/\.([a-z0-9_-]+)/gi)) {
            if (!this.classList.contains(name)) return false;
        }
        for (const [, name, value] of selector.matchAll(/\[([a-z0-9_-]+)(?:="([^"]*)")?\]/gi)) {
            const actual = this.getAttribute(name);
            if (value === undefined ? actual === null : actual !== value) return false;
        }
        return true;
    }

    closest(selector) {
        if (this.matches(selector)) return this;
        return this.parentElement?.closest(selector) ?? null;
    }

    querySelectorAll(selector) {
        const alternatives = selector.split(",").map((part) => part.trim().split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/));
        const found = [];
        const visit = (node) => {
            for (const child of node.children) {
                if (alternatives.some((parts) => {
                    if (!child.matches(parts.at(-1))) return false;
                    let ancestor = child.parentElement;
                    for (let index = parts.length - 2; index >= 0; index--) {
                        while (ancestor && !ancestor.matches(parts[index])) ancestor = ancestor.parentElement;
                        if (!ancestor) return false;
                        ancestor = ancestor.parentElement;
                    }
                    return true;
                })) found.push(child);
                visit(child);
            }
        };
        visit(this);
        return found;
    }

    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

    addEventListener(name, listener) {
        if (!this.listeners.has(name)) this.listeners.set(name, []);
        this.listeners.get(name).push(listener);
    }

    dispatch(name, properties = {}) {
        const event = {
            target: this, currentTarget: this, defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() {},
            ...properties,
        };
        for (const listener of this.listeners.get(name) ?? []) listener(event);
        return event;
    }

    focus() { this.ownerDocument.activeElement = this; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    showModal() { this.open = true; this.querySelector("input")?.focus(); }
    close(value = this.returnValue) { this.open = false; this.returnValue = value; this.dispatch("close"); }

    click() {
        if (this.disabled) return;
        this.focus();
        const event = this.dispatch("click");
        if (!event.defaultPrevented && this.tagName === "BUTTON" && (!this.type || this.type === "submit")) {
            this.closest("form")?.requestSubmit(this);
        }
    }

    requestSubmit(submitter = this.querySelectorAll("button").find((button) => !button.type || button.type === "submit")) {
        if (!submitter || submitter.disabled) return;
        if (!submitter.formNoValidate && this.querySelectorAll("[required]").some((input) => !input.value)) return;
        const event = this.dispatch("submit", { submitter });
        if (!event.defaultPrevented && this.method === "dialog") this.closest("dialog").close(submitter.value);
    }
}

function createDocument() {
    const document = {
        createElement(tag) { return new TestElement(tag, document); },
        createElementNS(_namespace, tag) { return document.createElement(tag); },
        createTextNode(value) { const node = document.createElement("#text"); node.textContent = value; return node; },
    };
    const container = document.createElement("document");
    const stack = [container];
    const voidTags = new Set(["meta", "link", "input", "path", "br"]);
    for (const match of markup.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<\/?([a-z][a-z0-9-]*)([^>]*)>|([^<]+)/gi)) {
        if (match[3]) {
            const text = match[3].trim();
            if (text) stack.at(-1).appendChild(document.createTextNode(text));
        } else if (match[0].startsWith("</")) {
            if (stack.at(-1).tagName === match[1].toUpperCase()) stack.pop();
        } else {
            const node = document.createElement(match[1]);
            for (const [, name, value] of match[2].matchAll(/([a-z][a-z0-9-]*)(?:="([^"]*)")?/gi)) {
                node.setAttribute(name, value ?? "");
            }
            stack.at(-1).appendChild(node);
            if (!voidTags.has(match[1]) && !match[0].endsWith("/>")) stack.push(node);
        }
    }
    document.documentElement = container.querySelector("html");
    document.body = container.querySelector("body");
    document.activeElement = document.body;
    document.querySelector = container.querySelector.bind(container);
    document.querySelectorAll = container.querySelectorAll.bind(container);
    document.getElementById = (id) => [container, ...container.querySelectorAll("*")].find((node) => node.id === id) ?? null;
    document.addEventListener = container.addEventListener.bind(container);
    document.dispatch = container.dispatch.bind(container);
    return document;
}

function createRenderer({ transitions = false } = {}) {
    const document = createDocument();
    const requests = [];
    const timers = new Map();
    const frames = new Map();
    const streams = [];
    const queuedTransitions = [];
    const copied = [];
    let nextTimer = 0;
    let now = 0;
    const context = vm.createContext({
        document, URLSearchParams,
        window: {
            location: { search: "?token=test-renderer" }, innerWidth: 480, innerHeight: 720,
            matchMedia: () => ({ matches: false }),
            addEventListener() {},
        },
        CSS: { escape: (value) => value },
        navigator: { clipboard: { writeText: async (value) => { copied.push(value); } } },
        fetch: (path, options) => {
            const request = { path, options, body: options.body ? JSON.parse(options.body) : undefined };
            requests.push(request);
            if (path === "/api/selection") return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
            return new Promise((resolve, reject) => { Object.assign(request, { resolve, reject }); });
        },
        EventSource: class {
            constructor() { this.handlers = new Map(); streams.push(this); }
            addEventListener(name, handler) { this.handlers.set(name, handler); }
        },
        setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        setInterval() {},
        requestAnimationFrame(callback) { const id = ++nextTimer; frames.set(id, callback); return id; },
        cancelAnimationFrame(id) { frames.delete(id); },
    });
    if (transitions) {
        document.startViewTransition = (draw) => {
            let finish;
            const finished = new Promise((resolve) => { finish = resolve; });
            queuedTransitions.push(() => { draw(); finish(); });
            return { finished };
        };
    }
    vm.runInContext(rendererSource, context, { filename: "aspire-apphosts/ui/app.js" });
    return {
        context, document, copied, requests, timers, frames, queuedTransitions,
        streamEvent: (name) => streams[0].handlers.get(name)(),
        evaluate: (source, options) => vm.runInContext(source, context, options),
        state: () => vm.runInContext("modelState", context),
        request: (path) => {
            const request = requests.find((request) => request.path === path && request.resolve && !request.done);
            assert.ok(request, `Expected a pending request to ${path}`);
            return request;
        },
        async respond(request, payload, status = 200) {
            request.done = true;
            request.resolve({ ok: status < 400, status, json: async () => payload });
            await settle();
        },
        async fail(request, message = "Network unavailable") {
            request.done = true;
            request.reject(new Error(message));
            await settle();
        },
        async push(message) {
            streams[0].handlers.get("message")({ data: JSON.stringify(message) });
            await settle();
        },
        async advance(milliseconds) {
            now += milliseconds;
            for (const [id, timer] of [...timers]) {
                if (timer.at <= now) { timers.delete(id); timer.callback(); }
            }
            await settle();
        },
        flushFrames() {
            for (const [id, callback] of [...frames]) { frames.delete(id); callback(); }
        },
    };
}

const commandId = "host-a:resource:api:command:inspect";
function inputs(targetValue = "east") {
    return [
        { name: "environment", label: "Environment", inputType: "Text", value: "dev", description: "Choose an environment." },
        { name: "target", label: "Target", inputType: "Choice", value: targetValue,
            options: [{ value: "east", label: "East" }, { value: "west", label: "West" }],
            dynamicLoading: { dependsOnInputs: ["environment"] } },
    ];
}

function snapshot(revision = 1, overrides = {}) {
    const command = {
        id: commandId, kind: "command", label: "Inspect", appHostId: "host-a", resourceName: "api", commandName: "inspect",
        command: { argumentInputs: inputs() },
    };
    const resources = [
        { id: "host-a:resource:database", kind: "resource", label: "Database", resourceName: "database", appHostId: "host-a", tone: "healthy",
            lifecycleTone: "healthy", statusLabel: "Running", usedBy: [{ resourceName: "api", types: ["Reference", "WaitFor"] }], children: [] },
        { id: "host-a:resource:api", kind: "resource", label: "Public API", resourceName: "api", description: "Project",
            appHostId: "host-a", tone: "healthy", dependsOn: [{ resourceName: "database", types: ["Reference", "WaitFor"] }], children: [
                { id: "commands", kind: "commands-group", children: [command] },
            ] },
    ];
    return {
        revision, status: "ready", viewMode: "workspace", refreshing: false, includeHidden: false,
        lastSuccessfulAt: "2026-09-10T11:00:00Z", generatedAt: "2026-09-10T11:00:00Z",
        roots: [{
            id: "host-a", appHostId: "host-a", kind: "apphost-running", label: "Shop.AppHost", identityHint: "shop-main · a1b2c3",
            actions: ["dashboard", "stop", "deploy", "publish", "pipeline-step", "source"],
            children: [{ id: "resources", kind: "resources-group", children: resources }],
        }],
        summary: { appHosts: 1, running: 1, resources: 2 },
        ...overrides,
    };
}

function commandSnapshot(revision, argumentInputs) {
    const state = snapshot(revision);
    const command = state.roots[0].children[0].children[1].children[0].children[0];
    command.command.argumentInputs = argumentInputs;
    return state;
}

async function boot(options) {
    const renderer = createRenderer(options);
    await renderer.respond(renderer.request("/api/state"), { state: snapshot() });
    return renderer;
}

function button(container, text) {
    const control = container.querySelectorAll("button").find((node) => node.textContent === text);
    assert.ok(control, `Expected button "${text}"`);
    return control;
}

function enterField(renderer, name, value, event = "input") {
    const control = renderer.document.querySelector(`.command-form [name="${name}"]`);
    assert.ok(control, `Expected field ${name}`);
    control.focus();
    if (control.type === "checkbox") control.checked = value;
    else control.value = value;
    control.dispatch(event);
}

function selectApi(renderer) {
    const row = renderer.document.querySelector('[data-resource-id="host-a:resource:api"] .resource-row-main');
    assert.ok(row, "Expected the Public API roster row");
    row.click();
}

function clickCommand(renderer) {
    if (!renderer.document.querySelector(`[data-node-id="${commandId}"]`)) selectApi(renderer);
    renderer.document.querySelector(`[data-node-id="${commandId}"]`).click();
}

async function openCommand(renderer) {
    clickCommand(renderer);
    await renderer.respond(renderer.request("/api/command-inputs"), { ok: true, inputs: inputs() });
}

test("commands without inputs run directly from the chip without opening the command panel", async () => {
    const renderer = createRenderer();
    await renderer.respond(renderer.request("/api/state"), { state: commandSnapshot(1, []) });
    clickCommand(renderer);
    await settle();
    assert.equal(renderer.document.querySelector("[data-command-panel]"), null);
    assert.equal(renderer.requests.filter((request) => request.path === "/api/command-inputs").length, 0);
    const run = renderer.request("/api/command");
    assert.deepEqual([run.body.resourceName, run.body.commandName, run.body.arguments], ["api", "inspect", {}]);
    const chip = renderer.document.querySelector(`[data-node-id="${commandId}"]`);
    assert.ok(chip.classList.contains("is-running"));
    assert.equal(chip.getAttribute("aria-busy"), "true");
    await renderer.respond(run, { ok: true });
    const settled = renderer.document.querySelector(`[data-node-id="${commandId}"]`);
    assert.equal(settled.classList.contains("is-running"), false);
});

test("a running AppHost without a dashboard URL explains why Open dashboard is unavailable", async () => {
    const renderer = createRenderer();
    const state = snapshot();
    state.roots[0].actions = state.roots[0].actions.filter((action) => action !== "dashboard");
    await renderer.respond(renderer.request("/api/state"), { state });
    const dashboard = button(renderer.document, "Open dashboard");
    assert.equal(dashboard.disabled, true);
    assert.match(dashboard.getAttribute("title"), /hasn't reported a dashboard URL/);
    selectApi(renderer);
    assert.match(renderer.document.querySelector(".inspector-note").textContent, /hasn't reported a dashboard URL/);
});

test("command input descriptions render Markdown links only when the input opts in", async () => {
    const renderer = createRenderer();
    const description = "Save to [user secrets](https://aka.ms/aspire/user-secrets) for **later**.";
    await renderer.respond(renderer.request("/api/state"), { state: commandSnapshot(1, [
        { name: "save", label: "Save", inputType: "Boolean", description, enableDescriptionMarkdown: true },
        { name: "note", label: "Note", inputType: "Text", description: "See [docs](https://aspire.dev)." },
    ]) });
    clickCommand(renderer);
    const hints = renderer.document.querySelectorAll(".command-field small");
    assert.equal(hints[0].textContent, "Save to user secrets for **later**.");
    const link = hints[0].querySelector("a");
    assert.equal(link.getAttribute("href") ?? link.href, "https://aka.ms/aspire/user-secrets");
    assert.equal(link.getAttribute("target") ?? link.target, "_blank");
    assert.equal(hints[1].textContent, "See [docs](https://aspire.dev).");
    assert.equal(hints[1].querySelector("a"), null);
});

test("output panel opens for user commands and streams cleaned output", async () => {
    const renderer = await boot();
    const panel = renderer.document.getElementById("output-panel");
    const text = renderer.document.getElementById("output-text");
    const base = { source: "resource", appHostId: "host-a", appHostName: "Host A", startedAt: 0 };
    await renderer.push({ type: "command-log-snapshot", commands: [
        { ...base, id: "bg-1", source: "background", label: "List AppHosts", commandLine: "aspire ps", status: "succeeded", output: "quiet" },
    ] });
    assert.equal(panel.hidden, true);

    await renderer.push({ type: "command-log", command: { ...base, id: "cmd-1", label: "Restart api", commandLine: "aspire resource api restart", status: "running" } });
    assert.equal(panel.hidden, false);
    assert.equal(renderer.document.getElementById("output-command-line").textContent, "aspire resource api restart");

    await renderer.push({ type: "command-output", id: "cmd-1", text: "\u001b[32mBuilding\u001b[0m\n10%\r50%\r\ndone\r\n" });
    assert.equal(text.textContent, "Building\n50%\ndone\n");
    assert.doesNotMatch(renderer.document.getElementById("output-list").textContent, /List AppHosts/);

    await renderer.push({ type: "command-log", command: { ...base, id: "cmd-1", label: "Restart api", commandLine: "aspire resource api restart", status: "failed", error: "Exit code 1" } });
    assert.match(text.textContent, /done\n[\s\S]*Exit code 1/);
});

test("output panel identifies sanitized command output", async () => {
    const renderer = await boot();
    const sanitized = renderer.document.getElementById("output-sanitized");
    await renderer.push({
        type: "command-log",
        command: {
            id: "cmd-1",
            source: "user",
            label: "Find AppHosts",
            commandLine: "aspire ls --format Json",
            status: "running",
            sanitizedOutput: true,
            startedAt: 0,
        },
    });
    assert.equal(sanitized.hidden, false);
    assert.equal(sanitized.textContent, "Sanitized output");
    assert.match(renderer.document.getElementById("output-list").textContent, /Sanitized output/);
});

test("live command output keeps only the configured tail", async () => {
    const renderer = await boot();
    const text = renderer.document.getElementById("output-text");
    const base = {
        id: "cmd-1",
        source: "resource",
        label: "Restart api",
        appHostId: "host-a",
        appHostName: "Host A",
        commandLine: "aspire resource api restart",
        status: "running",
        startedAt: 0,
    };
    await renderer.push({ type: "command-log", command: base });
    await renderer.push({
        type: "command-output",
        id: base.id,
        text: `first-marker\n${"x".repeat(64 * 1024)}\nlast-marker`,
    });

    assert.doesNotMatch(text.textContent, /first-marker/);
    assert.match(text.textContent, /^\[Earlier output was trimmed\]/);
    assert.match(text.textContent, /last-marker$/);
    assert.ok(text.textContent.length < 65 * 1024);
});

test("all state transports reject older snapshots after a newer SSE state", async () => {
    const renderer = createRenderer();
    await renderer.push({ type: "state", state: snapshot(3) });
    await renderer.respond(renderer.request("/api/state"), { state: snapshot(1, { roots: [] }) });
    assert.equal(renderer.state().revision, 3);
    assert.match(renderer.document.getElementById("model-view").textContent, /Public API/);

    renderer.document.getElementById("refresh-button").click();
    await renderer.push({ type: "state", state: snapshot(4) });
    await renderer.respond(renderer.request("/api/refresh"), { state: snapshot(2, { roots: [] }) });
    assert.equal(renderer.state().revision, 4);

    const hidden = renderer.document.getElementById("hidden-checkbox");
    hidden.checked = true;
    hidden.dispatch("change");
    await renderer.push({ type: "state", state: snapshot(5, { includeHidden: true }) });
    await renderer.respond(renderer.request("/api/preferences"), { state: snapshot(3, { includeHidden: false }) });
    assert.equal(renderer.state().revision, 5);
    assert.equal(hidden.checked, true);
});

test("freshness must match the current revision and timestamps never regress at the same revision", async () => {
    const renderer = await boot();
    const newer = "2026-09-10T12:00:00Z";
    await renderer.push({ type: "freshness", revision: 0, lastSuccessfulAt: newer });
    await renderer.push({ type: "freshness", lastSuccessfulAt: newer });
    assert.equal(renderer.state().lastSuccessfulAt, snapshot().lastSuccessfulAt);
    await renderer.push({ type: "freshness", revision: 1, lastSuccessfulAt: newer });
    assert.equal(renderer.state().lastSuccessfulAt, newer);
    await renderer.push({ type: "freshness", revision: 1, lastSuccessfulAt: "2026-09-10T09:00:00Z" });
    await renderer.push({ type: "freshness", revision: 1, lastSuccessfulAt: "not-a-date" });
    const refreshButton = renderer.document.getElementById("refresh-button");
    refreshButton.click();
    assert.equal(refreshButton.classList.contains("is-refreshing"), true);
    await renderer.respond(renderer.request("/api/refresh"), {
        state: snapshot(1, { generatedAt: "2026-09-10T10:00:00Z" }),
    });
    assert.equal(refreshButton.classList.contains("is-refreshing"), false);
    assert.equal(renderer.state().lastSuccessfulAt, newer);
    assert.equal(renderer.state().generatedAt, snapshot().generatedAt);
});

test("reconnect waits for a current full snapshot before reporting live data", async () => {
    const renderer = await boot();
    await renderer.push({ type: "state", state: snapshot(1) });
    renderer.streamEvent("error");
    assert.match(renderer.document.getElementById("connection-status").textContent, /Connection lost/);
    renderer.streamEvent("open");
    assert.match(renderer.document.getElementById("connection-status").textContent, /Synchronizing/);
    await renderer.push({ type: "freshness", revision: 3, lastSuccessfulAt: "2026-09-10T12:00:00Z" });
    assert.equal(renderer.state().revision, 1);
    assert.match(renderer.document.getElementById("connection-status").textContent, /Synchronizing/);
    const current = snapshot(3);
    current.roots[0].children[0].children[1].description = "Stopped";
    await renderer.push({ type: "state", state: current });
    assert.equal(renderer.state().revision, 3);
    assert.match(renderer.document.getElementById("model-view").textContent, /Stopped/);
    assert.equal(renderer.document.getElementById("connection-status").textContent, "AppHost data is live");
    await renderer.push({ type: "freshness", revision: 3, lastSuccessfulAt: "2026-09-10T12:00:00Z" });
    assert.equal(renderer.state().lastSuccessfulAt, "2026-09-10T12:00:00Z");
});

test("initial GET failure leaves a valid SSE board intact and surfaces its error", async () => {
    const renderer = createRenderer();
    await renderer.push({ type: "state", state: snapshot(2) });
    await renderer.fail(renderer.request("/api/state"), "Initial request failed");
    assert.equal(renderer.state().revision, 2);
    assert.match(renderer.document.getElementById("model-view").textContent, /Public API/);
    assert.match(renderer.document.getElementById("toast-region").textContent, /Initial request failed/);
});

test("mode HTTP replies and delayed view transitions cannot restore an older mode", async () => {
    const renderer = await boot({ transitions: true });
    renderer.document.getElementById("global-mode").click();
    await renderer.push({ type: "state", state: snapshot(2, { viewMode: "global" }) });
    assert.equal(renderer.queuedTransitions.length, 1);
    await renderer.push({ type: "state", state: snapshot(3, { viewMode: "workspace" }) });
    await renderer.respond(renderer.request("/api/mode"), { state: snapshot(2, { viewMode: "global" }) });
    renderer.queuedTransitions.shift()();
    await settle();
    assert.equal(renderer.state().viewMode, "workspace");
    assert.equal(renderer.evaluate("renderedViewMode"), "workspace");
    assert.equal(renderer.evaluate("pendingViewMode"), null);
    assert.equal(renderer.document.querySelector(".canvas-surface").inert, false);
    assert.equal(renderer.document.getElementById("workspace-mode").getAttribute("aria-pressed"), "true");
});

test("dependency edits block Run throughout debounce, failure, and an explicit successful retry", async () => {
    const renderer = await boot();
    await openCommand(renderer);
    enterField(renderer, "target", "west", "change");
    enterField(renderer, "environment", "production");
    assert.equal(button(renderer.document.body, "Loading inputs...").disabled, true);
    const form = renderer.document.querySelector(".command-form");
    form.dispatch("submit");
    assert.equal(renderer.requests.filter((request) => request.path === "/api/command").length, 0);
    await renderer.advance(249);
    assert.equal(renderer.requests.filter((request) => request.path === "/api/command-inputs").length, 1);
    await renderer.advance(1);
    const load = renderer.request("/api/command-inputs");
    assert.deepEqual(load.body.arguments, { environment: "production", target: "west" });
    await renderer.fail(load, "Targets could not be loaded");
    assert.equal(button(renderer.document.body, "Run command").disabled, true);
    assert.match(renderer.document.querySelector(".command-form").textContent, /Targets could not be loaded/);
    renderer.document.querySelector(".command-form").dispatch("submit");
    assert.equal(renderer.requests.filter((request) => request.path === "/api/command").length, 0);
    button(renderer.document.body, "Retry inputs").click();
    assert.equal(button(renderer.document.body, "Loading inputs...").disabled, true);
    await renderer.respond(renderer.request("/api/command-inputs"), { ok: true, inputs: inputs() });
    assert.equal(button(renderer.document.body, "Run command").disabled, false);
    assert.equal(renderer.document.querySelector('[name="environment"]').value, "production");
    assert.equal(renderer.document.querySelector('[name="target"]').value, "west");
    button(renderer.document.body, "Run command").click();
    assert.deepEqual(renderer.request("/api/command").body.arguments, { environment: "production", target: "west" });
});

test("dependency edits immediately invalidate a pending load before the next debounce fires", async () => {
    const renderer = await boot();
    clickCommand(renderer);
    const oldLoad = renderer.request("/api/command-inputs");
    enterField(renderer, "environment", "new-environment");
    await renderer.respond(oldLoad, { ok: true, inputs: [{ name: "stale", label: "Stale", inputType: "Text" }] });
    assert.equal(renderer.document.querySelector('[name="stale"]'), null);
    assert.equal(button(renderer.document.body, "Loading inputs...").disabled, true);
    await renderer.advance(250);
    await renderer.respond(renderer.request("/api/command-inputs"), { ok: true, inputs: inputs() });
    assert.equal(renderer.document.querySelector('[name="environment"]').value, "new-environment");
    assert.equal(button(renderer.document.body, "Run command").disabled, false);
});

test("committing normalized dependency text preserves pending and loaded metadata", async () => {
    const renderer = await boot();
    await openCommand(renderer);
    enterField(renderer, "environment", "  production  ");
    await renderer.advance(250);
    const load = renderer.request("/api/command-inputs");
    enterField(renderer, "environment", "  production  ", "change");
    await renderer.respond(load, { ok: true, inputs: inputs() });
    assert.equal(renderer.document.querySelector('[name="environment"]').value, "production");
    assert.equal(button(renderer.document.body, "Run command").disabled, false);

    enterField(renderer, "environment", "  production  ");
    assert.equal(button(renderer.document.body, "Run command").disabled, false);
    enterField(renderer, "environment", "  production  ", "change");
    await renderer.advance(250);
    assert.equal(renderer.requests.filter((request) => request.path === "/api/command-inputs").length, 2);
    button(renderer.document.body, "Run command").click();
    assert.deepEqual(renderer.request("/api/command").body.arguments, { environment: "production", target: "east" });
});

test("whitespace edits to secret dependencies still invalidate metadata", async () => {
    const renderer = await boot();
    const fields = inputs();
    fields[0] = { ...fields[0], inputType: "SecretText" };
    await renderer.push({ type: "state", state: commandSnapshot(2, fields) });
    clickCommand(renderer);
    await renderer.respond(renderer.request("/api/command-inputs"), { ok: true, inputs: fields });
    button(renderer.document.body, "Continue").click();
    enterField(renderer, "environment", "  token  ");
    await renderer.advance(250);
    await renderer.respond(renderer.request("/api/command-inputs"), { ok: true, inputs: fields });
    enterField(renderer, "environment", "token");
    assert.equal(button(renderer.document.body, "Loading inputs...").disabled, true);
    await renderer.advance(250);
    const load = renderer.request("/api/command-inputs");
    assert.equal(load.body.arguments.environment, "token");
    await renderer.respond(load, { ok: true, inputs: fields });
    assert.equal(button(renderer.document.body, "Run command").disabled, false);
});

test("secret-gated forms load effective non-secret defaults before Continue", async () => {
    const renderer = await boot();
    const fields = [...inputs(), { name: "token", label: "Token", inputType: "SecretText", value: "never-use-default" }];
    await renderer.push({ type: "state", state: commandSnapshot(2, fields) });
    clickCommand(renderer);
    assert.equal(renderer.document.querySelector(".command-form"), null);
    const load = renderer.request("/api/command-inputs");
    assert.deepEqual(load.body.arguments, { environment: "dev", target: "east" });
    await renderer.respond(load, { ok: true, inputs: fields });
    button(renderer.document.body, "Continue").click();
    assert.equal(renderer.document.querySelector('[name="environment"]').value, "dev");
    assert.equal(renderer.document.querySelector('[name="token"]').value, "");
    assert.equal(button(renderer.document.body, "Run command").disabled, false);
    button(renderer.document.body, "Run command").click();
    assert.deepEqual(renderer.request("/api/command").body.arguments, load.body.arguments);
});

test("text defaults match Hosting in command forms without shortening overlength values", async () => {
    const renderer = await boot();
    const fields = sanitizeCommandArgumentInputs([
        { name: "message", inputType: "Text", value: "  hello world  ", maxLength: 5 },
    ]);
    await renderer.push({ type: "state", state: commandSnapshot(2, fields) });
    clickCommand(renderer);
    assert.equal(renderer.document.querySelector('[name="message"]').value, "hello world");
    assert.equal(renderer.document.querySelector('[name="message"]').getAttribute("maxLength"), null);
    button(renderer.document.body, "Run command").click();
    assert.deepEqual(renderer.request("/api/command").body.arguments, { message: "hello world" });
});

test("number defaults remain visible and submit without browser-only normalization", async () => {
    const renderer = await boot();
    const value = "\uFEFF12\uFEFF";
    await renderer.push({ type: "state", state: commandSnapshot(2, [
        { name: "count", label: "Count", inputType: "Number", value },
    ]) });
    clickCommand(renderer);
    const control = renderer.document.querySelector('[name="count"]');
    assert.equal(control.type, "text");
    assert.equal(control.getAttribute("inputmode"), "decimal");
    assert.equal(control.value, value);
    button(renderer.document.body, "Run command").click();
    assert.deepEqual(renderer.request("/api/command").body.arguments, { count: value });
    const result = validateCommandArguments({ argumentInputs: [
        { name: "count", label: "Count", inputType: "Number" },
    ] }, renderer.request("/api/command").body.arguments);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.values, { count: 12 });
});

test("native browser displays exactly the number value submitted by an untouched form", {
    skip: !process.env.CHROME_BIN && "Set CHROME_BIN to a Chromium executable for native-browser regressions.",
}, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "apphosts-number-browser-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const setup = `
        window.commandRequests = [];
        window.fetch = (path, options) => {
            if (path === "/api/command") commandRequests.push(JSON.parse(options.body));
            return new Promise(() => {});
        };
        window.EventSource = class { addEventListener() {} };
    `;
    const regression = `
        try {
            for (const [index, value] of ["\\uFEFF12\\uFEFF", "12", "1.5", "-2", "1e2", "", "invalid"].entries()) {
                commandRunning = false;
                const node = {
                    id: "number-" + index, label: "Number regression",
                    appHostId: "host", resourceName: "api", commandName: "inspect",
                    command: { argumentInputs: [{ name: "count", label: "Count", inputType: "Number", value }] },
                };
                const panel = renderCommandPanel(node);
                document.body.append(panel);
                const control = panel.querySelector('[name="count"]');
                if (control.value !== value) {
                    throw new Error("Visible default differs: " + JSON.stringify({ value, visible: control.value }));
                }
                panel.querySelector('button[type="submit"]').click();
                if (commandRequests.at(-1)?.arguments.count !== control.value) {
                    throw new Error("Submitted value differs from visible default");
                }
                panel.remove();
            }
            document.body.dataset.numberRegression = "passed";
        } catch (error) {
            document.body.dataset.numberRegression = error.message;
        }
    `;
    const script = (source) => `<script>${source.replaceAll("</script", "<\\/script")}</script>`;
    const html = markup.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<link\b[^>]*>/gi, "")
        .replace("</body>", `${script(setup)}${script(rendererSource)}${script(regression)}</body>`);
    const file = join(directory, "number.html");
    await writeFile(file, html);
    const { stdout } = await promisify(execFile)(process.env.CHROME_BIN, [
        "--headless", "--disable-gpu",
        ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
        `--user-data-dir=${join(directory, "profile")}`,
        "--dump-dom", pathToFileURL(file).href,
    ], { timeout: 30_000, maxBuffer: 2_000_000 });
    assert.equal(stdout.match(/data-number-regression="([^"]*)"/)?.[1], "passed",
        "Native-browser number regression failed.");
});

test("committing a text edit normalizes it without trimming spaces while typing", async () => {
    const renderer = await boot();
    await renderer.push({ type: "state", state: commandSnapshot(2, [
        { name: "message", label: "Message", inputType: "Text" },
    ]) });
    clickCommand(renderer);
    enterField(renderer, "message", "  hello ");
    assert.equal(renderer.document.querySelector('[name="message"]').value, "  hello ");
    enterField(renderer, "message", "\u0085  hello world  \u0085", "change");
    assert.equal(renderer.document.querySelector('[name="message"]').value, "hello world");
    button(renderer.document.body, "Run command").click();
    assert.deepEqual(renderer.request("/api/command").body.arguments, { message: "hello world" });
});

test("long interior whitespace does not block command editing or submission", async () => {
    const renderer = await boot();
    await renderer.push({ type: "state", state: commandSnapshot(2, [
        { name: "message", label: "Message", inputType: "Text" },
    ]) });
    clickCommand(renderer);
    renderer.evaluate(`(() => {
        const control = document.querySelector('[name="message"]');
        control.value = "\\u0085a" + " ".repeat(64000) + "b\\u0085";
        control.dispatch("input");
        control.dispatch("change");
    })()`, { timeout: 1000 });
    const expected = `a${" ".repeat(64000)}b`;
    assert.equal(renderer.document.querySelector('[name="message"]').value, expected);
    button(renderer.document.body, "Run command").click();
    assert.deepEqual(renderer.request("/api/command").body.arguments, { message: expected });
});

test("submission normalizes uncommitted text and custom choices while preserving secrets", async () => {
    const renderer = await boot();
    await renderer.push({ type: "state", state: commandSnapshot(2, [
        { name: "message", label: "Message", inputType: "Text" },
        { name: "region", label: "Region", inputType: "Choice", allowCustomChoice: true, options: [{ value: "west", label: "West" }] },
        { name: "token", label: "Token", inputType: "SecretText" },
    ]) });
    clickCommand(renderer);
    button(renderer.document.body, "Continue").click();
    enterField(renderer, "message", "\u0085  edited message  \u0085");
    enterField(renderer, "region", "  \uFEFFcustom region\uFEFF  ");
    enterField(renderer, "token", "  test-token  ");
    renderer.document.querySelector(".command-form").dispatch("submit");
    assert.equal(renderer.document.querySelector('[name="message"]').value, "edited message");
    assert.equal(renderer.document.querySelector('[name="region"]').value, "\uFEFFcustom region\uFEFF");
    assert.equal(renderer.document.querySelector('[name="token"]').value, "  test-token  ");
    assert.deepEqual(renderer.request("/api/command").body.arguments, {
        message: "edited message",
        region: "\uFEFFcustom region\uFEFF",
        token: "  test-token  ",
    });
});

test("live base schema changes reload an open form and supersede pending old-schema inputs", async () => {
    const renderer = await boot();
    await openCommand(renderer);
    const prod = inputs();
    prod[0] = { ...prod[0], value: "prod", options: [{ value: "prod", label: "Production" }] };
    await renderer.push({ type: "state", state: commandSnapshot(2, prod) });
    const oldLoad = renderer.request("/api/command-inputs");
    assert.equal(oldLoad.body.arguments.environment, "prod");
    assert.equal(button(renderer.document.body, "Loading inputs...").disabled, true);
    const stage = inputs();
    stage[0] = { ...stage[0], value: "stage", options: [{ value: "stage", label: "Staging" }] };
    await renderer.push({ type: "state", state: commandSnapshot(3, stage) });
    await renderer.respond(oldLoad, { ok: true, inputs: prod });
    assert.equal(renderer.document.querySelector('[name="environment"]').value, "stage");
    assert.equal(button(renderer.document.body, "Loading inputs...").disabled, true);
    const latest = renderer.request("/api/command-inputs");
    assert.equal(latest.body.arguments.environment, "stage");
    await renderer.respond(latest, { ok: true, inputs: stage });
    assert.equal(button(renderer.document.body, "Run command").disabled, false);
});

test("live schemas that remove dynamic inputs cancel pending metadata without blocking ordinary commands", async () => {
    const renderer = await boot();
    clickCommand(renderer);
    const oldLoad = renderer.request("/api/command-inputs");
    const fields = [{ name: "label", label: "Label", inputType: "Text", value: "ordinary" }];
    await renderer.push({ type: "state", state: commandSnapshot(2, fields) });
    assert.equal(button(renderer.document.body, "Run command").disabled, false);
    await renderer.respond(oldLoad, { ok: true, inputs: inputs() });
    assert.equal(renderer.document.querySelector('[name="environment"]'), null);
    button(renderer.document.body, "Run command").click();
    assert.deepEqual(renderer.request("/api/command").body.arguments, { label: "ordinary" });
});

test("loaded dependency defaults reconcile once and bound unstable metadata behind explicit retry", async () => {
    const renderer = await boot();
    clickCommand(renderer);
    const prod = inputs();
    prod[0] = { ...prod[0], value: "prod", options: [{ value: "prod", label: "Production" }] };
    await renderer.respond(renderer.request("/api/command-inputs"), { ok: true, inputs: prod });
    const reconciled = renderer.request("/api/command-inputs");
    assert.equal(reconciled.body.arguments.environment, "prod");
    assert.equal(button(renderer.document.body, "Loading inputs...").disabled, true);
    const stage = inputs();
    stage[0] = { ...stage[0], value: "stage", options: [{ value: "stage", label: "Staging" }] };
    await renderer.respond(reconciled, { ok: true, inputs: stage });
    assert.equal(button(renderer.document.body, "Run command").disabled, true);
    assert.equal(renderer.requests.filter((request) => request.path === "/api/command-inputs").length, 2);
    button(renderer.document.body, "Retry inputs").click();
    const retry = renderer.request("/api/command-inputs");
    assert.equal(retry.body.arguments.environment, "stage");
    await renderer.respond(retry, { ok: true, inputs: stage });
    assert.equal(button(renderer.document.body, "Run command").disabled, false);
});

test("metadata-invalidating command conflicts expose Retry inputs without retrying execution", async () => {
    const renderer = await boot();
    await openCommand(renderer);
    button(renderer.document.body, "Run command").click();
    await renderer.respond(renderer.request("/api/command"), {
        ok: false, errorCode: "command_inputs_changed", error: "Reload command inputs before running.",
    }, 409);
    assert.equal(button(renderer.document.body, "Run command").disabled, true);
    button(renderer.document.body, "Retry inputs").click();
    await renderer.respond(renderer.request("/api/command-inputs"), { ok: true, inputs: inputs() });
    assert.equal(button(renderer.document.body, "Run command").disabled, false);
    assert.equal(renderer.requests.filter((request) => request.path === "/api/command").length, 1);
    button(renderer.document.body, "Run command").click();
    await renderer.respond(renderer.request("/api/command"), { ok: false, error: "AppHost is busy." }, 409);
    assert.equal(button(renderer.document.body, "Run command").disabled, false);
    assert.ok(!renderer.document.querySelectorAll("button").some((control) => control.textContent === "Retry inputs"));
});

test("base dependencies still trigger reload when loaded inputs omit their dynamic descriptor", async () => {
    const renderer = await boot();
    clickCommand(renderer);
    const fields = inputs().map(({ dynamicLoading, ...input }) => input);
    await renderer.respond(renderer.request("/api/command-inputs"), { ok: true, inputs: fields });
    enterField(renderer, "environment", "production");
    assert.equal(button(renderer.document.body, "Loading inputs...").disabled, true);
    await renderer.advance(250);
    const load = renderer.request("/api/command-inputs");
    assert.equal(load.body.arguments.environment, "production");
    await renderer.respond(load, { ok: true, inputs: fields });
    assert.equal(button(renderer.document.body, "Run command").disabled, false);
});

test("discarding secrets after success reloads metadata for the cleared dependencies", async () => {
    const renderer = await boot();
    const fields = [...inputs(), { name: "token", label: "Token", inputType: "SecretText" }];
    fields[1].dynamicLoading.dependsOnInputs = ["token"];
    await renderer.push({ type: "state", state: commandSnapshot(2, fields) });
    clickCommand(renderer);
    await renderer.respond(renderer.request("/api/command-inputs"), { ok: true, inputs: fields });
    button(renderer.document.body, "Continue").click();
    enterField(renderer, "token", "temporary-secret");
    await renderer.advance(250);
    await renderer.respond(renderer.request("/api/command-inputs"), { ok: true, inputs: fields });
    button(renderer.document.body, "Run command").click();
    await renderer.respond(renderer.request("/api/command"), { ok: true });
    assert.equal(button(renderer.document.body, "Loading inputs...").disabled, true);
    const load = renderer.request("/api/command-inputs");
    assert.deepEqual(load.body.arguments, { environment: "dev", target: "east" });
    await renderer.respond(load, { ok: true, inputs: fields });
    assert.equal(renderer.document.querySelector('[name="token"]').value, "");
    assert.equal(button(renderer.document.body, "Run command").disabled, false);
});

test("failed metadata payloads stay blocked; closing cleans up timers and ignores pending responses", async () => {
    const renderer = await boot();
    clickCommand(renderer);
    await renderer.respond(renderer.request("/api/command-inputs"), { ok: false, error: "Invalid metadata" });
    assert.equal(button(renderer.document.body, "Run command").disabled, true);
    button(renderer.document.body, "Retry inputs").click();
    const pending = renderer.request("/api/command-inputs");
    enterField(renderer, "environment", "new-environment");
    button(renderer.document.body, "Cancel").click();
    await renderer.advance(250);
    await renderer.respond(pending, { ok: true, inputs: inputs() });
    assert.equal(renderer.document.querySelector(".command-form"), null);
    assert.equal(renderer.evaluate("dynamicLoadTimers.size"), 0);
    assert.equal(renderer.evaluate("dynamicLoadingIds.size"), 0);
    assert.equal(renderer.evaluate("dynamicLoadFailedIds.size"), 0);
    assert.equal(renderer.evaluate("commandInputs.size"), 0);
    assert.equal(renderer.requests.filter((request) => request.path === "/api/command-inputs").length, 2);
});

test("reloaded choices preserve valid drafts and discard removed or no-longer-valid inputs", async () => {
    const renderer = await boot();
    await openCommand(renderer);
    enterField(renderer, "target", "west", "change");
    enterField(renderer, "environment", "production");
    await renderer.advance(250);
    const nextInputs = inputs("east");
    nextInputs[1].options = [{ value: "east", label: "East" }];
    await renderer.respond(renderer.request("/api/command-inputs"), { ok: true, inputs: nextInputs });
    assert.equal(renderer.document.querySelector('[name="environment"]').value, "production");
    assert.equal(renderer.document.querySelector('[name="target"]').value, "east");
    enterField(renderer, "environment", "another-environment");
    await renderer.advance(250);
    await renderer.respond(renderer.request("/api/command-inputs"), { ok: true, inputs: [nextInputs[0]] });
    assert.equal(renderer.document.querySelector('[name="target"]'), null);
    assert.equal(renderer.evaluate(`commandDrafts.get("${commandId}").target`), undefined);
});

test("text, select, and checkbox server errors have unique IDs and clear both live DOM and rerendered ARIA", async () => {
    const renderer = await boot();
    clickCommand(renderer);
    const fields = [
        ...inputs(),
        { name: "agree", label: "Agree", inputType: "Checkbox", description: "Confirm agreement." },
    ];
    await renderer.respond(renderer.request("/api/command-inputs"), { ok: true, inputs: fields });
    button(renderer.document.body, "Run command").click();
    await renderer.respond(renderer.request("/api/command"), {
        ok: false, error: "Check the inputs", validationErrors: fields.map((input) => ({
            argumentName: input.name, errorMessage: `${input.label} needs attention`,
        })),
    }, 400);
    const allIds = renderer.document.querySelectorAll(".command-field input, .command-field select, .command-field small, .field-error")
        .map((node) => node.id);
    assert.equal(new Set(allIds).size, allIds.length);
    for (const field of fields) {
        const control = renderer.document.querySelector(`[name="${field.name}"]`);
        assert.equal(control.getAttribute("aria-invalid"), "true");
        const described = control.getAttribute("aria-describedby").split(" ").map((id) => renderer.document.getElementById(id));
        assert.ok(described.every(Boolean));
        assert.ok(described.some((node) => node.textContent.includes("needs attention")));
    }
    enterField(renderer, "target", "west", "change");
    enterField(renderer, "agree", true, "change");
    for (const name of ["target", "agree"]) {
        const control = renderer.document.querySelector(`[name="${name}"]`);
        assert.equal(control.getAttribute("aria-invalid"), "false");
        assert.equal(renderer.document.querySelector(`[data-error-for="${name}"]`).hidden, true);
    }
    renderer.context.renderTree();
    assert.equal(renderer.document.querySelector('[name="agree"]').getAttribute("aria-invalid"), "false");
    assert.ok(renderer.document.getElementById(renderer.document.querySelector('[name="agree"]').getAttribute("aria-describedby")));
    assert.equal(renderer.document.querySelector('[name="environment"]').getAttribute("aria-invalid"), "true");
});

test("sensitive drafts are discarded on close without introducing a separate value store", async () => {
    const renderer = await boot();
    clickCommand(renderer);
    await renderer.respond(renderer.request("/api/command-inputs"), {
        ok: true, inputs: [...inputs(), { name: "token", label: "Token", inputType: "SecretText" }],
    });
    button(renderer.document.body, "Continue").click();
    enterField(renderer, "token", "private-test-value");
    button(renderer.document.body, "Cancel").click();
    assert.equal(renderer.evaluate("commandDrafts.size"), 0);
    assert.equal(renderer.evaluate("commandInputs.size"), 0);
});

test("duplicate host labels use stable public hints in tabs, heading, and confirmation even after filtering", async () => {
    const renderer = await boot();
    const state = snapshot(2);
    const other = {
        ...structuredClone(state.roots[0]),
        id: "host-b",
        appHostId: "host-b",
        identityHint: "shop-feature · d4e5f6",
        locationHint: "feature/Shop.AppHost",
        locationTitle: "~/src/feature/Shop.AppHost",
        children: [],
    };
    state.roots.push(other);
    await renderer.push({ type: "state", state });
    assert.equal(renderer.document.querySelector(".apphost-heading h2").textContent, "Shop.AppHost");
    assert.equal(renderer.document.querySelector(".apphost-heading .apphost-hint").textContent, "shop-main · a1b2c3");
    assert.equal(renderer.context.duplicateHostHint(other, state.roots), "feature/Shop.AppHost");
    assert.equal(renderer.context.duplicateHostTitle(other, "feature/Shop.AppHost"), "~/src/feature/Shop.AppHost");
    const before = renderer.context.duplicateHostLabel(state.roots[0], state.roots);
    assert.equal(renderer.document.querySelector(".apphost-heading").getAttribute("title"), before);
    assert.equal(before, renderer.context.duplicateHostLabel(state.roots[0], [...state.roots].reverse()));
    assert.match(renderer.context.duplicateHostLabel({ ...other, identityHint: undefined, locationHint: undefined }, state.roots), /\(host-b\)/);
    renderer.document.querySelector(".host-more-actions").click();
    button(renderer.document.getElementById("action-menu"), "Deploy AppHost").click();
    assert.equal(renderer.document.querySelector(".confirmation-copy strong").textContent, `Deploy ${before}?`);
    assert.equal(renderer.requests.some((request) => request.path === "/api/apphost-operation"), false);
    button(renderer.document.body, "Cancel").click();
    button(renderer.document.body, "Stop").click();
    assert.equal(renderer.document.querySelector(".apphost-confirmation"), null, "Stop runs without a confirmation");
    assert.equal(renderer.request("/api/apphost-operation").body.operation, "stop");
    const search = renderer.document.getElementById("search-input");
    search.value = "Public API";
    search.dispatch("input");
    assert.equal(renderer.document.querySelector(".apphost-heading").getAttribute("title"), before);
});

for (const failureFirst of [true, false]) {
    test(`browser failures remain visible ${failureFirst ? "before" : "after"} the navigation acknowledgement`, async () => {
        const renderer = await boot();
        const opening = renderer.context.executeNodeAction("dashboard", snapshot().roots[0]);
        const failure = { type: "browser-error", error: "Could not open the default browser (exit code 4)." };
        if (failureFirst) await renderer.push(failure);
        await renderer.respond(renderer.request("/api/open-dashboard"), { ok: true });
        await opening;
        if (!failureFirst) await renderer.push(failure);
        const toast = renderer.document.querySelector(".toast.is-error");
        assert.ok(toast);
        assert.equal(toast.textContent, failure.error);
    });
}

test("the inspector opens dashboard views and copies the canonical resource name", async () => {
    const renderer = await boot();
    assert.equal(renderer.document.querySelector(".inspector[data-inspector-resource]"), null, "Nothing is selected on load");
    selectApi(renderer);
    const inspector = renderer.document.querySelector('[data-inspector-resource="host-a:resource:api"]');
    const details = inspector.querySelector('[data-focus-key="inspector:details"]');
    assert.equal(details.getAttribute("aria-label"), "View details for Public API");
    assert.ok(inspector.querySelector('[data-focus-key="inspector:metrics"]'), "Dashboard views render as direct buttons");
    details.click();
    assert.deepEqual(renderer.request("/api/open-dashboard-view").body, { nodeId: "host-a:resource:api", view: "details" });
    const copy = renderer.document.querySelector('[data-focus-key="inspector:copy"]');
    assert.equal(copy.getAttribute("aria-label"), "Copy resource name api");
    copy.click();
    await settle();
    assert.deepEqual(renderer.copied, ["api"]);
    assert.ok(renderer.document.querySelector(`[data-node-id="${commandId}"]`), "Resource commands are preserved");
    const offline = renderer.context.renderInspector({ resource: { id: "offline", label: "Display only", children: [] } }, false);
    assert.equal(offline.querySelector('[data-focus-key="inspector:details"]'), null);
    assert.match(offline.querySelector(".inspector-note").textContent, /while this AppHost is running/);
    assert.match(offline.querySelector(".inspector-facts").textContent, /Not reported/);
    offline.querySelector('[data-focus-key="inspector:copy"]').click();
    await settle();
    assert.deepEqual(renderer.copied, ["api", "Display only"]);
    const waiting = renderer.context.renderInspector({ resource: { id: "cache", label: "cache", children: [
        { id: "health", kind: "health-group", children: [
            { id: "check", label: "cache_check", statusLabel: "Waiting", icon: "loading", tone: "inactive" },
        ] },
    ] } }, false);
    assert.ok(waiting.querySelector(".health-row .state-icon.is-spinning"), "Waiting health checks spin like the dashboard");
});

test("selection animates once, survives refreshes, and Back or Escape returns focus to the row", async () => {
    const renderer = await boot();
    assert.ok(renderer.document.querySelector(".host-summary"), "The host overview shows until a resource is selected");
    selectApi(renderer);
    renderer.flushFrames();
    const row = '[data-focus-key="row:host-a:resource:api"]';
    assert.equal(renderer.document.querySelector(row).getAttribute("aria-current"), "true");
    assert.ok(renderer.document.querySelector(".inspector.is-entering"));
    await renderer.push({ type: "state", state: snapshot(2) });
    assert.ok(renderer.document.querySelector('[data-inspector-resource="host-a:resource:api"]'));
    assert.equal(renderer.document.querySelector(".inspector.is-entering"), null, "Refreshes never replay motion");
    renderer.document.querySelector('.inspector-back[aria-label="Back to resources"]').click();
    renderer.flushFrames();
    assert.ok(renderer.document.querySelector(".host-summary"));
    assert.equal(renderer.document.activeElement, renderer.document.querySelector(row));
    selectApi(renderer);
    renderer.document.querySelector(".inspector-pane").dispatch("keydown", { key: "Escape", target: renderer.document.querySelector("#inspector-title") });
    renderer.flushFrames();
    assert.ok(renderer.document.querySelector(".host-summary"));
    assert.equal(renderer.document.activeElement, renderer.document.querySelector(row));
    selectApi(renderer);
    const removed = snapshot(3);
    removed.roots[0].children[0].children = removed.roots[0].children[0].children.filter((resource) => resource.id !== "host-a:resource:api");
    await renderer.push({ type: "state", state: removed });
    assert.equal(renderer.document.getElementById("inspector-title").textContent, "Resource no longer available");
});

test("roster filters combine attention, state, and health and Clear filters resets every filter", async () => {
    const renderer = await boot();
    const state = snapshot(2);
    const [database, api] = state.roots[0].children[0].children;
    Object.assign(database, { statusLabel: "Failed", lifecycleTone: "error", healthLabel: undefined, healthTone: undefined });
    Object.assign(api, { statusLabel: "Running", lifecycleTone: "healthy", healthLabel: "Healthy", healthTone: "healthy" });
    await renderer.push({ type: "state", state });
    const count = () => renderer.document.querySelector(".roster-count").textContent;
    const rows = () => renderer.document.querySelectorAll(".resource-row").map((row) => row.getAttribute("data-resource-id"));
    assert.equal(count(), "(2)");
    assert.equal(renderer.document.querySelector(".roster-attention-count").textContent, "1");
    renderer.document.querySelector(".roster-attention").click();
    assert.equal(renderer.document.querySelector(".roster-attention").getAttribute("aria-pressed"), "true");
    assert.deepEqual(rows(), [database.id]);
    assert.equal(count(), "(1 of 2)");
    const health = renderer.document.querySelector('[data-focus-key="health-filter"]');
    health.value = "healthy";
    health.dispatch("change");
    assert.equal(renderer.document.querySelectorAll(".resource-row").length, 0);
    assert.match(renderer.document.querySelector(".roster-empty").textContent, /No resources match these filters/);
    const search = renderer.document.getElementById("search-input");
    search.value = "Public";
    search.dispatch("input");
    button(renderer.document.querySelector(".roster-empty"), "Clear filters").click();
    assert.equal(search.value, "");
    assert.equal(renderer.evaluate("attentionOnly"), false);
    assert.equal(renderer.evaluate("healthFilter"), "all");
    assert.equal(renderer.evaluate("stateFilter"), "all");
    assert.equal(count(), "(2)");
    const notReported = renderer.document.querySelector('[data-focus-key="health-filter"]');
    notReported.value = "not-reported";
    notReported.dispatch("change");
    assert.deepEqual(rows(), [database.id]);
    const popoverClear = renderer.document.getElementById("filters-clear");
    assert.equal(popoverClear.disabled, false);
    renderer.document.querySelector('[data-focus-key="attention"]').click();
    popoverClear.click();
    assert.equal(renderer.evaluate("healthFilter"), "all");
    assert.equal(renderer.evaluate("attentionOnly"), true);
    assert.equal(popoverClear.disabled, true);
    assert.equal(renderer.document.querySelector(".roster-filters-count"), null);
});

test("the Filters panel Clear filters turns off hidden resources too", async () => {
    const renderer = createRenderer();
    await renderer.push({ type: "state", state: snapshot(1, { includeHidden: true }) });
    const clear = renderer.document.getElementById("filters-clear");
    assert.equal(clear.disabled, false);
    clear.click();
    assert.equal(renderer.document.getElementById("hidden-checkbox").checked, false);
    assert.deepEqual(renderer.request("/api/preferences").body, { includeHidden: false });
    await renderer.respond(renderer.request("/api/preferences"), { state: snapshot(2, { includeHidden: false }) });
    assert.equal(clear.disabled, true);
});

test("the Filters panel anchors under its trigger and stays inside the control row", async () => {
    const renderer = await boot();
    const panel = renderer.document.getElementById("filters-panel");
    const trigger = renderer.document.querySelector(".roster-filters-trigger");
    const row = { getBoundingClientRect: () => ({ left: 10, width: 600 }) };
    Object.defineProperties(panel, { offsetParent: { value: row }, offsetWidth: { value: 240 } });
    trigger.getBoundingClientRect = () => ({ left: 330 });
    trigger.click();
    assert.equal(panel.hidden, false);
    assert.equal(panel.style.left, "320px");
    trigger.click();
    trigger.getBoundingClientRect = () => ({ left: 500 });
    trigger.click();
    assert.equal(panel.style.left, "360px");
});

test("the inspector lists dependencies both ways and selecting a related name opens it", async () => {
    const renderer = await boot();
    selectApi(renderer);
    const sections = () => renderer.document.querySelectorAll(".inspector-section");
    const section = (title) => sections().find((node) => node.querySelector("h4").textContent === title);
    assert.equal(section("Used by"), undefined);
    const dependsOn = section("Depends on");
    assert.equal(sections().indexOf(dependsOn), 0, "relationships precede Endpoints and later sections");
    const row = dependsOn.querySelector(".relation-row");
    assert.equal(row.querySelector(".relation-kind").textContent, "Reference, waits for");
    assert.equal(row.querySelector(".health-status").textContent, "Running");
    assert.match(row.querySelector(".health-status").className, /tone-healthy/);
    button(row, "Database").click();
    assert.equal(renderer.document.getElementById("inspector-title").textContent, "Database");
    assert.equal(section("Depends on"), undefined);
    button(section("Used by"), "Public API").click();
    assert.equal(renderer.document.getElementById("inspector-title").textContent, "Public API");

    const state = snapshot(2);
    state.roots[0].children[0].children[1].dependsOn.push({ resourceName: "missing", types: ["Reference"] });
    await renderer.push({ type: "state", state });
    assert.equal(section("Depends on").querySelectorAll(".relation-row").length, 1, "unavailable resources are skipped");
});

test("waiting rows name the resources they are waiting for", async () => {
    const renderer = createRenderer();
    const state = snapshot();
    Object.assign(state.roots[0].children[0].children[1], { statusLabel: "Waiting", waitingForLabels: ["Database", "cache"] });
    await renderer.push({ type: "state", state });
    const text = (id) => renderer.document.querySelector(`[data-resource-id="${id}"] .resource-row-type`).textContent;
    assert.equal(text("host-a:resource:api"), "Waiting for Database, cache");
    state.roots[0].children[0].children[1].waitingForLabels = [];
    await renderer.push({ type: "state", state: { ...state, revision: 2 } });
    assert.equal(text("host-a:resource:api"), "Project");
});

test("parameters render in their own collapsible section after resources", async () => {
    const renderer = await boot();
    const headers = () => renderer.document.querySelectorAll(".roster-section-toggle");
    assert.deepEqual(headers().map((header) => header.querySelector("span").textContent), ["Resources"]);
    assert.equal(renderer.document.getElementById("footer-count").textContent, "2 resources");

    const state = snapshot(2);
    const parameter = {
        id: "host-a:resource:password", kind: "resource", label: "password", resourceName: "password",
        description: "Parameter · Value protected", appHostId: "host-a", isParameter: true,
        statusLabel: "Value missing", lifecycleTone: "warning", lifecycleTransitioning: false, children: [],
        usedBy: [{ resourceName: "api", types: ["Reference"] }],
    };
    state.roots[0].children[0].children.push(parameter);
    await renderer.push({ type: "state", state });
    assert.deepEqual(headers().map((header) => header.querySelector("span").textContent), ["Resources", "Parameters"]);
    assert.deepEqual(headers().map((header) => header.querySelector(".roster-count").textContent), ["(2)", "(1)"]);
    const lists = renderer.document.querySelectorAll(".resource-roster");
    assert.deepEqual(lists.map((list) => list.querySelectorAll(".resource-row").map((row) => row.getAttribute("data-resource-id"))),
        [["host-a:resource:database", "host-a:resource:api"], [parameter.id]]);
    assert.equal(renderer.document.querySelector(".roster-attention-count").textContent, "1", "missing values need attention");
    assert.equal(renderer.document.getElementById("footer-count").textContent, "2 resources · 1 parameter");

    const toggle = headers()[1];
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(toggle.getAttribute("aria-controls"), "roster-section-parameters");
    renderer.document.querySelector(`[data-resource-id="${parameter.id}"] .resource-row-main`).click();
    toggle.click();
    assert.equal(headers()[1].getAttribute("aria-expanded"), "false");
    assert.equal(renderer.document.getElementById("roster-section-parameters").hidden, true);
    assert.equal(renderer.document.getElementById("roster-section-resources").hidden, false);
    assert.equal(renderer.document.getElementById("inspector-title").textContent, "password", "a collapsed section keeps its selection");
    headers()[0].click();
    assert.equal(renderer.document.getElementById("roster-section-resources").hidden, true);
    headers()[1].click();
    assert.equal(renderer.document.getElementById("roster-section-parameters").hidden, false);

    button(renderer.document.querySelector(".relation-row"), "Public API").click();
    assert.equal(renderer.document.getElementById("inspector-title").textContent, "Public API");
    assert.equal(renderer.document.getElementById("roster-section-resources").hidden, false, "selecting a related resource reveals its section");
});

test("narrow More reuses confirmations and exposes disabled operations without executing them", async () => {
    const renderer = await boot();
    const more = renderer.document.querySelector(".host-more-actions");
    more.click();
    assert.equal(more.getAttribute("aria-expanded"), "true");
    const menu = renderer.document.getElementById("action-menu");
    assert.equal(renderer.document.activeElement.textContent, "Deploy AppHost");
    menu.dispatch("keydown", { key: "End" });
    assert.equal(renderer.document.activeElement.textContent, "Add Shop.AppHost to chat");
    menu.dispatch("keydown", { key: "Home" });
    assert.equal(renderer.document.activeElement.textContent, "Deploy AppHost");
    button(menu, "Deploy AppHost").click();
    assert.equal(menu.hidden, true);
    assert.match(renderer.document.querySelector(".confirmation-copy").textContent, /Deploy Shop.AppHost/);
    assert.equal(renderer.requests.some((request) => request.path === "/api/apphost-operation"), false);
    button(renderer.document.body, "Cancel").click();
    renderer.context.openActionMenu({ ...snapshot().roots[0], actions: [] }, more, ["deploy"]);
    assert.equal(button(menu, "Deploy AppHost").disabled, true);
    const busy = snapshot(2);
    busy.roots[0].operation = { label: "Deploying AppHost" };
    await renderer.push({ type: "state", state: busy });
    assert.equal(menu.hidden, true, "A live operation invalidates the previously open action menu");
    assert.equal(renderer.document.querySelector(".host-more-actions"), null);
    assert.match(renderer.document.querySelector(".host-action-bar").textContent, /Deploying AppHost/);
});

test("unavailable AppHost notice stays short and exposes the full reason on hover and focus", async () => {
    const renderer = await boot();
    const state = snapshot(2);
    state.roots[0].unavailableActionReason = "Aspire could not confirm that this AppHost is buildable. Check the project, then refresh.";
    state.roots[0].unavailableActionLabel = "Build not confirmed";
    await renderer.push({ type: "state", state });
    const notice = renderer.document.querySelector(".tray-notice");
    assert.equal(notice.textContent, "Build not confirmed");
    assert.equal(notice.getAttribute("title"), state.roots[0].unavailableActionReason);
    assert.equal(notice.getAttribute("aria-label"), state.roots[0].unavailableActionReason);
    assert.equal(notice.getAttribute("tabindex"), "0");
});

function openPipelineStep(renderer) {
    const trigger = renderer.document.querySelector(".host-more-actions");
    trigger.click();
    button(renderer.document.getElementById("action-menu"), "Run pipeline step").click();
    return trigger;
}

test("pipeline cancellation bypasses required validation, Enter runs once, and Escape never runs", async () => {
    const renderer = await boot();
    const trigger = openPipelineStep(renderer);
    const dialog = renderer.document.getElementById("pipeline-dialog");
    const input = renderer.document.getElementById("pipeline-step-input");
    const cancel = renderer.document.getElementById("pipeline-cancel");
    assert.equal(dialog.getAttribute("aria-labelledby"), "pipeline-dialog-title");
    assert.equal(cancel.type, "button");
    assert.equal(cancel.formNoValidate, true);
    assert.equal(input.value, "");
    cancel.click();
    assert.equal(dialog.open, false);
    assert.equal(renderer.document.activeElement, trigger);
    assert.equal(renderer.requests.some((request) => request.path === "/api/apphost-operation"), false);
    openPipelineStep(renderer);
    input.value = "build";
    dialog.querySelector("form").requestSubmit();
    assert.equal(renderer.request("/api/apphost-operation").body.step, "build");
    dialog.dispatch("close");
    assert.equal(renderer.requests.filter((request) => request.path === "/api/apphost-operation").length, 1);
    openPipelineStep(renderer);
    assert.equal(dialog.returnValue, "");
    dialog.dispatch("cancel");
    dialog.close();
    assert.equal(renderer.requests.filter((request) => request.path === "/api/apphost-operation").length, 1);
    await renderer.fail(renderer.request("/api/pipeline-steps?appHostId=host-a"), "An old pipeline request failed");
    assert.equal(renderer.document.getElementById("pipeline-error").hidden, true);
});

test("pipeline focus returns to a live control after the board rerenders, and old loads cannot change a new dialog", async () => {
    const renderer = await boot();
    openPipelineStep(renderer);
    const oldLoad = renderer.request("/api/pipeline-steps?appHostId=host-a");
    await renderer.push({ type: "state", state: snapshot(2) });
    renderer.document.getElementById("pipeline-cancel").click();
    assert.equal(renderer.document.activeElement.isConnected, true);
    assert.equal(renderer.document.activeElement.getAttribute("data-apphost-primary"), "true");
    openPipelineStep(renderer);
    await renderer.respond(oldLoad, { steps: [{ name: "stale-step" }] });
    assert.equal(renderer.document.getElementById("pipeline-step-options").children.length, 0);
    await renderer.respond(renderer.request("/api/pipeline-steps?appHostId=host-a"), { steps: [{ name: "current-step" }] });
    assert.equal(renderer.document.getElementById("pipeline-step-options").children[0].value, "current-step");
});

test("responsive and theme selectors preserve host priority, the official mark, and long parent identity", async () => {
    assert.match(sharedStyles, /:root:not\(\[data-color-mode\]\):has\(body\[data-color-mode="light"\]\)/);
    assert.match(sharedStyles, /--surface: var\(--background-color-default, light-dark\(#ffffff, #0d1117\)\)/);
    assert.match(sharedStyles, /--text: var\(--text-color-default, light-dark\(#1f2328, #f0f6fc\)\)/);
    assert.match(styles, /\.resource-parent\s*\{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
    assert.match(styles, /\.apphost-heading\s*\{[^}]*min-width: 0;/);
    assert.match(styles, /\.apphost-heading h2\s*\{[^}]*min-width: 6ch;[^}]*flex: 0 1 auto;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
    assert.match(styles, /\.apphost-heading \.apphost-hint\s*\{[^}]*min-width: 0;[^}]*flex: 0 1000 auto;[^}]*text-overflow: ellipsis;/);
    assert.doesNotMatch(styles, /\.apphost-switcher\s*\{[^}]*margin-left/);
    assert.match(styles, /\.apphost-switcher > \.apphost-heading\s*\{[^}]*padding: 0 8px;/);
    assert.doesNotMatch(styles, /\.apphost-trigger\.resource-menu-trigger\s*\{[^}]*margin-left/);
    assert.match(styles, /\.host-more-actions\s*\{\s*display: inline-flex;/);
    assert.match(styles, /@container \(min-width: 720px\)[\s\S]*?\.resource-board\s*\{[^}]*grid-template-columns:/);
    assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?#mode-label,\s*\.host-action-bar \.is-secondary-operation\s*\{\s*display: none;/);
    assert.match(markup, /class="brand-mark canvas-brand"[\s\S]*?width="22"\s+height="22"/);
    const renderer = await boot();
    const icon = renderer.context.svgIcon("warning");
    assert.equal(icon.getAttribute("aria-hidden"), "true");
    assert.equal(icon.getAttribute("focusable"), "false");
    assert.equal(icon.children[0].getAttribute("href"), "/canvas-icons.svg#warning");
    const longParent = "LongParent".repeat(80);
    const card = renderer.context.renderResourceRow({
        resource: { id: "child", label: "Child", children: [] }, parentLabel: longParent, depth: 1,
    }, false, new Set());
    assert.equal(card.querySelector(".resource-parent").textContent, `Part of ${longParent}`);
    assert.equal(card.querySelector(".resource-parent").title, `Part of ${longParent}`);
});

test("warning-styled settled resources need attention and connected children draw tree guides", async () => {
    const renderer = await boot();
    const { resourceNeedsAttention, resourceStateGroup, rowTreeGuides } = renderer.context;
    const valueMissing = { lifecycleTone: "warning", lifecycleTransitioning: false };
    const starting = { lifecycleTone: "warning", lifecycleTransitioning: true };
    assert.equal(resourceNeedsAttention(valueMissing), true);
    assert.equal(resourceStateGroup(valueMissing), "stopped");
    assert.equal(resourceNeedsAttention(starting), false);
    assert.equal(resourceStateGroup(starting), "transitioning");

    const visible = [
        { resource: { label: "postgres" }, depth: 0 },
        { resource: { label: "catalogdb" }, parentLabel: "postgres", depth: 1 },
        { resource: { label: "ordersdb" }, parentLabel: "postgres", depth: 1 },
        { resource: { label: "orphan" }, parentLabel: "hidden", depth: 1 },
    ];
    const labels = new Set(["postgres", "catalogdb", "ordersdb", "orphan"]);
    const classes = (index) => Array.from(rowTreeGuides(visible, index, labels), (guide) => guide.getAttribute("class"));
    assert.deepEqual(classes(0), ["tree-stem"]);
    assert.deepEqual(classes(1), ["tree-elbow", "tree-rail"]);
    assert.deepEqual(classes(2), ["tree-elbow"]);
    assert.deepEqual(classes(3), []);
});
