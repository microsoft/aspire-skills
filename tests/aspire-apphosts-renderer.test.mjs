import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const rendererSource = await readFile(new URL("../extensions/aspire-apphosts/ui/app.js", import.meta.url), "utf8");
const markup = await readFile(new URL("../extensions/aspire-apphosts/ui/index.html", import.meta.url), "utf8");
const styles = await readFile(new URL("../extensions/aspire-apphosts/ui/styles.css", import.meta.url), "utf8");
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
            open: false, returnValue: "", formNoValidate: false, method: "",
            tabIndex: 0, scrollTop: 0, scrollLeft: 0,
        });
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
        evaluate: (source) => vm.runInContext(source, context),
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
        { id: "host-a:resource:database", kind: "resource", label: "Database", resourceName: "database", appHostId: "host-a", tone: "healthy", children: [] },
        { id: "host-a:resource:api", kind: "resource", label: "Public API", resourceName: "api", description: "Project",
            appHostId: "host-a", tone: "healthy", children: [
                { id: "commands", kind: "commands-group", children: [command] },
            ] },
    ];
    const edge = {
        id: "database-api", from: "database", to: "api", types: ["Reference", "WaitFor"],
        context: { id: "host-a:relationship:database-api", kind: "relationship", label: "Public API uses Database",
            appHostId: "host-a", relationship: { from: "database", to: "api", types: ["Reference", "WaitFor"] } },
    };
    return {
        revision, status: "ready", viewMode: "workspace", refreshing: false, includeHidden: false,
        lastSuccessfulAt: "2026-09-10T11:00:00Z", generatedAt: "2026-09-10T11:00:00Z",
        roots: [{
            id: "host-a", appHostId: "host-a", kind: "apphost-running", label: "Shop.AppHost", identityHint: "shop-main · a1b2c3",
            actions: ["dashboard", "stop", "deploy", "publish", "pipeline-step", "source"],
            children: [{ id: "resources", kind: "resources-group", children: resources }],
            graph: { nodes: resources.map((resource, layer) => ({ ...resource, layer })), edges: [edge] },
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

async function openCommand(renderer) {
    renderer.document.querySelector(`[data-node-id="${commandId}"]`).click();
    await renderer.respond(renderer.request("/api/command-inputs"), { ok: true, inputs: inputs() });
}

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
    renderer.document.getElementById("refresh-button").click();
    await renderer.respond(renderer.request("/api/refresh"), {
        state: snapshot(1, { generatedAt: "2026-09-10T10:00:00Z" }),
    });
    assert.equal(renderer.state().lastSuccessfulAt, newer);
    assert.equal(renderer.state().generatedAt, snapshot().generatedAt);
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
    renderer.document.querySelector(`[data-node-id="${commandId}"]`).click();
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

test("secret-gated forms load effective non-secret defaults before Continue", async () => {
    const renderer = await boot();
    const fields = [...inputs(), { name: "token", label: "Token", inputType: "SecretText", value: "never-use-default" }];
    await renderer.push({ type: "state", state: commandSnapshot(2, fields) });
    renderer.document.querySelector(`[data-node-id="${commandId}"]`).click();
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
    renderer.document.querySelector(`[data-node-id="${commandId}"]`).click();
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
    renderer.document.querySelector(`[data-node-id="${commandId}"]`).click();
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
    renderer.document.querySelector(`[data-node-id="${commandId}"]`).click();
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
    renderer.document.querySelector(`[data-node-id="${commandId}"]`).click();
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
    renderer.document.querySelector(`[data-node-id="${commandId}"]`).click();
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
    renderer.document.querySelector(`[data-node-id="${commandId}"]`).click();
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
    renderer.document.querySelector(`[data-node-id="${commandId}"]`).click();
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
        ...structuredClone(state.roots[0]), id: "host-b", appHostId: "host-b", identityHint: "shop-feature · d4e5f6", children: [],
    };
    state.roots.push(other);
    await renderer.push({ type: "state", state });
    assert.match(renderer.document.querySelector(".apphost-heading h2").textContent, /Shop\.AppHost \(shop-main · a1b2c3\)/);
    const before = renderer.context.duplicateHostLabel(state.roots[0], state.roots);
    assert.equal(before, renderer.context.duplicateHostLabel(state.roots[0], [...state.roots].reverse()));
    assert.match(renderer.context.duplicateHostLabel({ ...other, identityHint: undefined }, state.roots), /\(host-b\)/);
    button(renderer.document.body, "Stop").click();
    assert.equal(renderer.document.querySelector(".confirmation-copy strong").textContent, `Stop ${before}?`);
    assert.equal(renderer.requests.some((request) => request.path === "/api/apphost-operation"), false);
    button(renderer.document.body, "Cancel").click();
    const search = renderer.document.getElementById("search-input");
    search.value = "Public API";
    search.dispatch("input");
    assert.equal(renderer.document.querySelector(".apphost-heading h2").textContent, before);
});

test("resource details and copying are separate native buttons and copying uses the canonical name", async () => {
    const renderer = await boot();
    const card = renderer.document.querySelector('[data-resource-id="host-a:resource:api"]');
    const details = card.querySelector("button.resource-name");
    assert.equal(details.getAttribute("aria-label"), "View details for Public API");
    details.click();
    assert.deepEqual(renderer.request("/api/open-dashboard-view").body, { nodeId: "host-a:resource:api", view: "details" });
    const copy = card.querySelector(".resource-name-copy");
    assert.equal(copy.getAttribute("aria-label"), "Copy resource name api");
    copy.click();
    await settle();
    assert.deepEqual(renderer.copied, ["api"]);
    assert.ok(card.querySelector(`[data-node-id="${commandId}"]`), "Resource commands are preserved");
    const offline = renderer.context.renderResourceCard({
        resource: { id: "offline", label: "Display only", children: [] }, dashboardAvailable: false,
    });
    assert.equal(offline.querySelector("button.resource-name"), null);
    offline.querySelector(".resource-name-copy").click();
    await settle();
    assert.deepEqual(renderer.copied, ["api", "Display only"]);
});

test("filtered graph counts are honest and one combined relationship can be selected and added to Copilot", async () => {
    const renderer = await boot();
    renderer.document.getElementById("graph-view-tab").click();
    const list = renderer.document.querySelector(".graph-relationships");
    assert.match(list.querySelector("summary").textContent, /Relationships \(1\)/);
    assert.equal(list.querySelectorAll("li").length, 1);
    const relationship = list.querySelector(".relationship-select");
    assert.match(relationship.textContent, /Public API references Database\. Public API waits for Database\./);
    relationship.click();
    assert.equal(renderer.evaluate("selectedNodeId"), "host-a:relationship:database-api");
    assert.equal(renderer.context.findNode("host-a:relationship:database-api").kind, "relationship");
    assert.equal(renderer.document.querySelector(".relationship-select").getAttribute("aria-pressed"), "true");
    button(renderer.document.body, "Add relationship to Copilot").click();
    assert.deepEqual(renderer.request("/api/copilot-context").body, { nodeId: "host-a:relationship:database-api" });
    const search = renderer.document.getElementById("search-input");
    search.value = "Public API";
    search.dispatch("input");
    const panel = renderer.document.getElementById("graph-view-panel");
    assert.match(panel.textContent, /1 of 2 resources and 0 of 1 relationships visible/);
    assert.doesNotMatch(panel.textContent, /no declared resource relationships/);
    button(panel, "Clear filter").click();
    assert.equal(search.value, "");
    assert.equal(renderer.document.querySelectorAll(".relationship-select").length, 1);
    renderer.evaluate('filterText = "commands"');
    const emptyGraph = renderer.context.visibleResourceGraph(snapshot().roots[0], []);
    const emptyPanel = renderer.context.renderResourceGraphPanel(emptyGraph, true);
    assert.match(emptyPanel.textContent, /0 of 2 resources and 0 of 1 relationships visible/);
    assert.ok(button(emptyPanel, "Clear filter"));
});

test("narrow More reuses confirmations and exposes disabled operations without executing them", async () => {
    const renderer = await boot();
    const more = renderer.document.querySelector(".host-more-actions");
    more.click();
    assert.equal(more.getAttribute("aria-expanded"), "true");
    const menu = renderer.document.getElementById("action-menu");
    assert.equal(renderer.document.activeElement.textContent, "Deploy AppHost");
    menu.dispatch("keydown", { key: "End" });
    assert.equal(renderer.document.activeElement.textContent, "Open AppHost source");
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

test("pipeline cancellation bypasses required validation, Enter runs once, and Escape never runs", async () => {
    const renderer = await boot();
    const trigger = button(renderer.document.body, "Pipeline step");
    trigger.click();
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
    trigger.click();
    input.value = "build";
    dialog.querySelector("form").requestSubmit();
    assert.equal(renderer.request("/api/apphost-operation").body.step, "build");
    dialog.dispatch("close");
    assert.equal(renderer.requests.filter((request) => request.path === "/api/apphost-operation").length, 1);
    trigger.click();
    assert.equal(dialog.returnValue, "");
    dialog.dispatch("cancel");
    dialog.close();
    assert.equal(renderer.requests.filter((request) => request.path === "/api/apphost-operation").length, 1);
    await renderer.fail(renderer.request("/api/pipeline-steps?appHostId=host-a"), "An old pipeline request failed");
    assert.equal(renderer.document.getElementById("pipeline-error").hidden, true);
});

test("pipeline focus returns to a live control after the board rerenders, and old loads cannot change a new dialog", async () => {
    const renderer = await boot();
    button(renderer.document.body, "Pipeline step").click();
    const oldLoad = renderer.request("/api/pipeline-steps?appHostId=host-a");
    await renderer.push({ type: "state", state: snapshot(2) });
    renderer.document.getElementById("pipeline-cancel").click();
    assert.equal(renderer.document.activeElement.isConnected, true);
    assert.equal(renderer.document.activeElement.getAttribute("data-apphost-primary"), "true");
    button(renderer.document.body, "Pipeline step").click();
    await renderer.respond(oldLoad, { steps: [{ name: "stale-step" }] });
    assert.equal(renderer.document.getElementById("pipeline-step-options").children.length, 0);
    await renderer.respond(renderer.request("/api/pipeline-steps?appHostId=host-a"), { steps: [{ name: "current-step" }] });
    assert.equal(renderer.document.getElementById("pipeline-step-options").children[0].value, "current-step");
});

test("responsive and theme selectors preserve host priority, the official mark, and long parent identity", async () => {
    assert.match(styles, /@media \(prefers-color-scheme: dark\)[\s\S]*?:root:not\(\[data-color-mode\]\):not\(:has\(body\[data-color-mode\]\)\)/);
    assert.match(styles, /--surface: var\(--background-color-default, #151b23\)/);
    assert.match(styles, /--text: var\(--text-color-default, #f0f6fc\)/);
    assert.match(styles, /\.resource-parent\s*\{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
    assert.match(styles, /\.apphost-heading\s*\{[^}]*max-width: 100%;/);
    assert.match(styles, /\.apphost-heading h2\s*\{[^}]*overflow-wrap: anywhere;[^}]*white-space: normal;/);
    assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?\.host-action-bar \.is-secondary-operation\s*\{\s*display: none;/);
    assert.match(styles, /\.host-more-actions\s*\{\s*display: none;/);
    assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?\.host-more-actions\s*\{\s*display: inline-flex;/);
    assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?\.title-row\s*\{[^}]*grid-template-columns: 40px minmax\(0, 1fr\) auto;/);
    assert.match(markup, /class="brand-mark"[\s\S]*?width="22"\s+height="22"/);
    const renderer = await boot();
    const longParent = "LongParent".repeat(80);
    const card = renderer.context.renderResourceCard({
        resource: { id: "child", label: "Child", children: [] }, parentLabel: longParent, dashboardAvailable: false,
    });
    assert.equal(card.querySelector(".resource-parent").textContent, `Part of ${longParent}`);
    assert.equal(card.querySelector(".resource-parent").title, `Part of ${longParent}`);
});
