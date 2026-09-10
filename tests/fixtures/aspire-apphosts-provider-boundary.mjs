import assert from "node:assert/strict";
import * as http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { SourceTextModule, SyntheticModule, createContext } from "node:vm";
import { test } from "node:test";
import * as model from "../../extensions/aspire-apphosts/lib/app-model.mjs";

const providerUrl = new URL("../../extensions/aspire-apphosts/extension.mjs", import.meta.url);
const source = await readFile(providerUrl, "utf8");
const paths = [
    resolve("tests", "fixtures", "checkouts-one", "Demo.AppHost", "Demo.AppHost.csproj"),
    resolve("tests", "fixtures", "checkouts-two", "Demo.AppHost", "Demo.AppHost.csproj"),
];
const baseInputs = [
    { name: "environment", inputType: "Choice", required: true, options: ["prod", "dev"] },
    { name: "key", inputType: "SecretText", dynamicLoading: { dependsOnInputs: ["environment"] } },
];
const deferred = () => {
    let resolvePromise;
    const promise = new Promise((resolveValue) => { resolvePromise = resolveValue; });
    return { promise, resolve: resolvePromise };
};
const ok = (data) => ({ ok: true, code: 0, stdout: JSON.stringify(data), stderr: "" });
const fail = (error = "Synthetic CLI failure") => ({ ok: false, code: 1, stdout: "", stderr: error, error });
const clone = (value) => JSON.parse(JSON.stringify(value));

function describe(inputs = baseInputs, state = "Running") {
    return { resources: [
        {
            name: "api", displayName: "api", resourceType: "Project", state,
            environment: { password: "not-for-composer" }, source: paths[0],
            dashboardUrl: "https://localhost:18888/login?t=dummy-dashboard-token",
            urls: [{ name: "https", url: "https://localhost:7001/?token=private-endpoint-token" }],
            healthReports: { ready: { status: "Healthy" } },
            commands: { deploy: { displayName: "Deploy", state: "Enabled", argumentInputs: inputs } },
            relationships: [{ type: "Reference", resourceName: "db" }, { type: "WaitFor", resourceName: "db" }],
        },
        { name: "db", displayName: "db", resourceType: "Container", state: "Running" },
    ] };
}

async function harness(t, { listenGate, failListen = false, cliOverride } = {}) {
    const servers = [];
    const intervals = new Set();
    const attachments = [];
    const logs = [];
    const calls = [];
    const controls = { failedHost: null, failPs: false, inputs: baseInputs, state: "Running", loader: null, executor: null };
    let declaration;
    let failNextListen = failListen;
    const run = async (args, options) => {
        calls.push({ args: [...args], options });
        if (cliOverride) {
            const result = await cliOverride(args, options);
            if (result) return result;
        }
        if (args[0] === "ps") {
            return controls.failPs ? fail("ps unavailable") : ok(paths.map((appHostPath) => ({
                appHostPath, status: "running", dashboardUrl: "https://localhost:18888/login?t=private-host-token",
            })));
        }
        if (args[0] === "describe") {
            return args[args.indexOf("--apphost") + 1] === controls.failedHost
                ? fail("describe unavailable") : ok(describe(controls.inputs, controls.state));
        }
        if (args[0] === "resource" && args.includes("--load-arguments")) {
            return controls.loader ? await controls.loader(args, options) : ok(baseInputs);
        }
        if (args[0] === "resource") {
            return controls.executor ? await controls.executor(args, options) : ok({ executed: true });
        }
        throw new Error(`Unexpected fake CLI command ${args[0]}`);
    };
    const createServer = (handler) => {
        const server = http.createServer((request, response) => {
            handler(request, response);
            request.once("end", () => controls.requestEnded?.(request.url));
        });
        server.initialListeningListeners = server.listenerCount("listening");
        const listen = server.listen.bind(server);
        server.listen = (...args) => {
            if (failNextListen) {
                failNextListen = false;
                queueMicrotask(() => server.emit("error", Object.assign(new Error("synthetic listen failure"), { code: "EADDRINUSE" })));
            } else if (listenGate) {
                listenGate.promise.then(() => listen(...args));
            } else {
                listen(...args);
            }
            return server;
        };
        servers.push(server);
        return server;
    };
    const context = createContext({
        URL, Buffer, process, console, setTimeout, clearTimeout,
        setInterval(callback) {
            const timer = { callback, unref() {} };
            intervals.add(timer);
            return timer;
        },
        clearInterval(timer) { intervals.delete(timer); },
    });
    const sdk = {
        createCanvas: (options) => options,
        CanvasError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
        joinSession: async (options) => {
            declaration = options.canvases[0];
            return {
                log: (message) => logs.push(message),
                rpc: { extensions: { sendAttachmentsToMessage: async (payload) => attachments.push(clone(payload)) } },
            };
        },
    };
    const module = new SourceTextModule(source, {
        context, identifier: providerUrl.href,
        initializeImportMeta(meta) { meta.url = providerUrl.href; },
    });
    await module.link(async (specifier) => {
        const exports = specifier === "@github/copilot-sdk/extension" ? sdk
            : specifier === "./lib/app-model.mjs" ? { ...model, createAspireCliRunner: () => ({ run }) }
                : specifier === "node:http" ? { ...http, createServer } : await import(specifier);
        return new SyntheticModule(Object.keys(exports), function () {
            for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        }, { context });
    });
    await module.evaluate();
    const opened = new Set();
    const h = {
        controls, calls, servers, intervals, attachments, logs,
        async open(instanceId = "test") {
            opened.add(instanceId);
            return declaration.open({ instanceId, input: { viewMode: "global" } });
        },
        close: (instanceId = "test") => declaration.onClose({ instanceId }),
        action: (name, input = {}, instanceId = "test") =>
            declaration.actions.find((action) => action.name === name).handler({ instanceId, input }),
        async request(open, route, body) {
            const url = new URL(open.url);
            const response = await fetch(new URL(route, url), {
                method: body === undefined ? "GET" : "POST",
                headers: { "x-aspire-apphosts-token": url.searchParams.get("token"), "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return { status: response.status, ...await response.json() };
        },
        commandCalls: () => calls.filter(({ args }) => args[0] === "resource" && !args.includes("--load-arguments")),
    };
    t.after(async () => {
        listenGate?.resolve();
        for (const server of servers) server.closeAllConnections();
        await Promise.all([...opened].map((id) => h.close(id)));
        for (const server of servers) {
            server.closeAllConnections();
            if (server.listening) await new Promise((done) => server.close(done));
        }
        assert.equal(intervals.size, 0, "provider timers must be disposed");
        assert.ok(servers.every((server) => !server.listening), "provider listeners must be disposed");
    });
    return h;
}

function allNodes(roots) {
    return roots.flatMap((node) => [node, ...allNodes(node.children ?? [])]);
}

async function requestFor(h, open) {
    const { state } = await h.request(open, "/api/state");
    return { appHostId: state.roots[0].appHostId, resourceName: "api", commandName: "deploy" };
}

async function sse(h, open) {
    const url = new URL(open.url);
    url.pathname = "/events";
    const request = http.get(url);
    const events = [];
    const response = await new Promise((resolveResponse, reject) => {
        request.once("response", resolveResponse);
        request.once("error", reject);
    });
    let buffer = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)));
        }
    });
    return {
        events,
        waitFor(predicate) {
            const existing = events.find(predicate);
            if (existing) return Promise.resolve(existing);
            return new Promise((resolveEvent, reject) => {
                const timer = setTimeout(() => {
                    response.off("data", check);
                    reject(new Error("Expected SSE event was not received."));
                }, 2_000);
                const check = () => {
                    const event = events.find(predicate);
                    if (event) {
                        clearTimeout(timer);
                        response.off("data", check);
                        resolveEvent(event);
                    }
                };
                response.on("data", check);
            });
        },
        close() { response.destroy(); request.destroy(); },
    };
}

test("context is owner-specific, fresh/stale-aware, and relationship-selectable through HTTP and SDK", async (t) => {
    const h = await harness(t);
    const open = await h.open();
    const { state } = await h.request(open, "/api/state");
    assert.equal(state.roots.length, 2);
    assert.notEqual(state.roots[0].identityHint, state.roots[1].identityHint);
    assert.match(state.roots[0].identityHint, /checkouts-one/);
    assert.match(state.roots[1].identityHint, /checkouts-two/);
    const contexts = [];
    for (const root of state.roots) {
        const nodes = allNodes([root]);
        for (const kind of ["resource", "command", "health-check", "endpoint"]) {
            const node = nodes.find((candidate) => candidate.kind === kind && candidate.resourceName === "api");
            assert.ok(node, kind);
            assert.equal((await h.request(open, "/api/selection", { nodeId: node.id })).ok, true);
            const context = clone(await h.action("get_selected_context"));
            assert.equal(context.appHost.id, root.appHostId);
            assert.equal(context.appHost.identityHint, root.identityHint);
            assert.equal(context.appHost.stale, false);
            assert.equal(context.appHost.status, "running");
            assert.ok(context.appHost.lastSuccessfulAt);
            assert.equal(context.nodeId, node.id);
            assert.equal(context.resourceIdentity.name, "api");
            assert.equal(context.resourceIdentity.id, `apphost:${root.appHostId}:resource:api`);
            await h.request(open, "/api/copilot-context", { nodeId: node.id });
            assert.deepEqual(h.attachments.at(-1).attachments[0].payload, context);
            if (kind === "resource") contexts.push(context);
        }
        const edge = root.graph.edges[0];
        assert.deepEqual(edge.context.relationship, { from: edge.from, to: edge.to, types: edge.types });
        assert.equal(edge.context.id, `${root.id}:relationship:${edge.id}`);
        assert.ok(!nodes.some((node) => node.kind === "relationship"), "edges must not pollute resource tree children");
        assert.equal((await h.request(open, "/api/selection", { nodeId: edge.context.id })).ok, true);
        assert.deepEqual(clone(await h.action("get_selected_context")).relationship, edge.context.relationship);
        assert.equal((await h.request(open, "/api/copilot-context", { nodeId: edge.context.id })).ok, true);
    }
    assert.notDeepEqual(contexts[0], contexts[1], "identical APIs under distinct AppHosts retain owner identity");
    assert.doesNotMatch(JSON.stringify(h.attachments), /not-for-composer|dummy-dashboard-token|private-host-token|private-endpoint-token|appHostPath|"environment":\{/);
    for (const path of paths) assert.ok(!JSON.stringify(h.attachments).includes(path));

    h.controls.failedHost = paths[0];
    await h.request(open, "/api/state");
    const resourceId = contexts[0].nodeId;
    await h.request(open, "/api/selection", { nodeId: resourceId });
    const stale = clone(await h.action("get_selected_context"));
    assert.equal(stale.resource.state, "Running");
    assert.equal(stale.appHost.stale, true);
    assert.equal(stale.appHost.lastSuccessfulAt, contexts[0].appHost.lastSuccessfulAt);
    await h.request(open, "/api/selection", { nodeId: contexts[1].nodeId });
    assert.equal((await h.action("get_selected_context")).appHost.stale, false);
    h.controls.failPs = true;
    await h.request(open, "/api/state");
    assert.equal((await h.action("get_selected_context")).appHost.stale, true, "failed discovery marks retained data stale");
});

test("state revisions advance only for meaningful content and freshness carries the same revision", async (t) => {
    const h = await harness(t);
    const open = await h.open();
    const first = (await h.request(open, "/api/state")).state;
    assert.ok(Number.isInteger(first.revision));
    const stream = await sse(h, open);
    t.after(() => stream.close());
    const second = (await h.request(open, "/api/state")).state;
    assert.equal(second.revision, first.revision);
    await stream.waitFor((event) => event.type === "freshness" && event.revision === first.revision);
    h.controls.state = "Stopped";
    const changed = (await h.request(open, "/api/state")).state;
    assert.ok(changed.revision > second.revision);
    await stream.waitFor((event) => event.type === "state" && event.state.revision === changed.revision);
    const unchanged = (await h.request(open, "/api/state")).state;
    assert.equal(unchanged.revision, changed.revision);
    stream.close();
});

test("direct HTTP execution rejects missing, mismatched, failed and pending dynamic metadata", async (t) => {
    const h = await harness(t);
    const open = await h.open();
    const request = await requestFor(h, open);
    const command = (values) => h.request(open, "/api/command", { ...request, arguments: values });
    const load = (values) => h.request(open, "/api/command-inputs", { ...request, arguments: values });
    h.controls.loader = async (args) => ok(baseInputs.map((input) => input.name === "key"
        ? { ...input, required: true, disabled: args.includes("--environment=dev") } : input));
    const missing = await command({ environment: "prod" });
    assert.equal(missing.status, 409);
    assert.equal(missing.errorCode, "command_inputs_changed");
    assert.equal((await load({ environment: "prod" })).ok, true);
    assert.equal((await command({ environment: "prod" })).status, 400, "prod key is required");
    assert.equal((await command({ environment: "dev" })).status, 409, "debounce cannot use prod metadata");
    assert.equal((await load({ environment: "dev" })).ok, true);
    assert.equal((await command({ environment: "dev" })).ok, true);
    const count = h.commandCalls().length;
    assert.equal((await command({ environment: "prod" })).status, 409, "old disabled metadata cannot authorize prod");
    h.controls.loader = async () => fail();
    assert.equal((await load({ environment: "prod" })).status, 500);
    assert.equal((await command({ environment: "prod" })).status, 409);
    assert.equal((await command({ environment: "dev" })).status, 409, "a failed refresh revokes prior authority");
    const started = deferred();
    const release = deferred();
    h.controls.loader = async () => { started.resolve(); await release.promise; return ok(baseInputs); };
    const pending = load({ environment: "prod" });
    await started.promise;
    assert.equal((await command({ environment: "prod", key: "test" })).status, 409);
    release.resolve();
    await pending;
    assert.equal(h.commandCalls().length, count, "no invalid request reached the fake CLI");
});

test("queued loads cannot apply older metadata to newer dependency values", async (t) => {
    const h = await harness(t);
    const open = await h.open();
    const request = await requestFor(h, open);
    const started = deferred();
    const release = deferred();
    const environments = [];
    h.controls.loader = async (args) => {
        environments.push(args.find((arg) => arg.startsWith("--environment=")));
        if (environments.length === 1) { started.resolve(); await release.promise; }
        return ok(baseInputs.map((input) => input.name === "key"
            ? { ...input, required: true, disabled: args.includes("--environment=dev") } : input));
    };
    const first = h.request(open, "/api/command-inputs", { ...request, arguments: { environment: "dev" } });
    await started.promise;
    const queued = deferred();
    h.controls.requestEnded = (route) => { if (route === "/api/command-inputs") queued.resolve(); };
    const second = h.request(open, "/api/command-inputs", { ...request, arguments: { environment: "prod" } });
    await queued.promise;
    assert.equal((await h.request(open, "/api/command", { ...request, arguments: { environment: "dev" } })).status, 409);
    release.resolve();
    assert.equal((await first).status, 409);
    assert.equal((await second).status, 200);
    assert.deepEqual(environments, ["--environment=dev", "--environment=prod"]);
    assert.equal((await h.request(open, "/api/command", { ...request, arguments: { environment: "prod" } })).status, 400);
    assert.equal((await h.request(open, "/api/command", { ...request, arguments: { environment: "dev" } })).status, 409);
    assert.equal(h.commandCalls().length, 0);
});

test("loader and execution bind the same normalized number, boolean, and omitted dependencies", async (t) => {
    const h = await harness(t);
    const fields = [
        { name: "count", inputType: "Number" },
        { name: "flag", inputType: "Boolean" },
        { name: "optional", inputType: "Text" },
        { name: "target", inputType: "Text", dynamicLoading: { dependsOnInputs: ["count", "flag", "optional"] } },
    ];
    h.controls.inputs = fields;
    let loadedArgs;
    h.controls.loader = async (args) => { loadedArgs = args; return ok(fields); };
    const open = await h.open();
    const request = await requestFor(h, open);
    const body = { ...request, arguments: { count: "01", flag: " FALSE ", optional: " " } };
    assert.equal((await h.request(open, "/api/command-inputs", body)).ok, true);
    assert.ok(loadedArgs.includes("--count=1"));
    assert.ok(loadedArgs.includes("--flag=false"));
    assert.ok(!loadedArgs.some((arg) => arg.startsWith("--optional=")));
    assert.equal((await h.request(open, "/api/command", body)).ok, true);
    const executedArgs = h.commandCalls()[0].args;
    assert.deepEqual(executedArgs.slice(executedArgs.indexOf("--") + 1), ["--count=1", "--flag=false"]);
});

test("schema changes invalidate loaded metadata and reject in-flight old-schema results", async (t) => {
    const h = await harness(t);
    const open = await h.open();
    const request = await requestFor(h, open);
    const started = deferred();
    const release = deferred();
    h.controls.loader = async () => { started.resolve(); await release.promise; return ok(baseInputs); };
    const load = h.request(open, "/api/command-inputs", { ...request, arguments: { environment: "prod" } });
    await started.promise;
    h.controls.inputs = [...baseInputs, { name: "region", inputType: "Text", required: true }];
    await h.request(open, "/api/state");
    release.resolve();
    assert.equal((await load).status, 409);
    assert.equal((await h.request(open, "/api/command", { ...request, arguments: { environment: "prod", region: "east" } })).status, 409);
    assert.equal(h.commandCalls().length, 0);
});

test("newly loaded dependencies are bound to values actually sent to the loader, not ignored request properties", async (t) => {
    const h = await harness(t);
    const open = await h.open();
    const request = await requestFor(h, open);
    const inputs = [...baseInputs, { name: "region", inputType: "Text", dynamicLoading: { dependsOnInputs: ["region"] } }];
    const seen = [];
    h.controls.loader = async (args) => { seen.push(args); return ok(inputs); };
    const body = { ...request, arguments: { environment: "prod", region: "east" } };
    assert.equal((await h.request(open, "/api/command-inputs", body)).ok, true);
    assert.ok(!seen[0].includes("--region=east"), "first load has not declared region yet");
    assert.equal((await h.request(open, "/api/command", body)).status, 409);
    assert.equal((await h.request(open, "/api/command-inputs", body)).ok, true);
    assert.ok(seen[1].includes("--region=east"));
    assert.equal((await h.request(open, "/api/command", body)).ok, true);
});

test("thrown and malformed loader responses revoke authority until a successful retry", async (t) => {
    const h = await harness(t);
    const open = await h.open();
    const request = await requestFor(h, open);
    const body = { ...request, arguments: { environment: "prod", key: "dummy-secret-value" } };
    assert.equal((await h.request(open, "/api/command-inputs", body)).ok, true);
    h.controls.loader = async () => { throw new Error("Useful error: dummy-secret-value"); };
    const thrown = await h.request(open, "/api/command-inputs", body);
    assert.equal(thrown.status, 500);
    assert.match(thrown.error, /Useful error: \[redacted\]/);
    assert.equal((await h.request(open, "/api/command", body)).status, 409);
    h.controls.loader = async () => ok({ not: "an input array" });
    assert.equal((await h.request(open, "/api/command-inputs", body)).status, 500);
    assert.equal((await h.request(open, "/api/command", body)).status, 409);
    h.controls.loader = async () => ok(baseInputs);
    assert.equal((await h.request(open, "/api/command-inputs", body)).status, 200);
    assert.equal((await h.request(open, "/api/command", body)).status, 200);
});

test("command and loader failures redact real child-process secret output before public error truncation", async (t) => {
    const h = await harness(t);
    h.controls.inputs = [{ name: "key", inputType: "SecretText", required: true }];
    const open = await h.open();
    const request = await requestFor(h, open);
    const secret = `DUMMY-${"abcd1234".repeat(1200)}`;
    const childFailure = async (args, options) => {
        assert.deepEqual([...options.sensitiveValues], [secret]);
        return model.runProcess(process.execPath, [
            "-e", "process.stderr.write('Useful child failure: '+process.argv[1]);process.exitCode=1;", secret,
        ], { ...options, cwd: process.cwd() });
    };
    h.controls.executor = childFailure;
    h.controls.loader = childFailure;
    for (const route of ["/api/command", "/api/command-inputs"]) {
        const response = await h.request(open, route, { ...request, arguments: { key: secret } });
        assert.equal(response.status, 500);
        assert.match(response.error, /Useful child failure: \[redacted\]/);
        assert.doesNotMatch(JSON.stringify(response), /DUMMY-/);
    }
    assert.doesNotMatch(JSON.stringify(h.logs), /DUMMY-/);
});

test("concurrent opens share one listener and close disposes it", async (t) => {
    const gate = deferred();
    const h = await harness(t, { listenGate: gate });
    const first = h.open();
    const second = h.open();
    await nextTurn();
    assert.equal(h.servers.length, 1);
    gate.resolve();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(left.url, right.url);
    assert.equal((await h.request(left, "/api/state")).ok, true);
    assert.equal(h.intervals.size, 1);
    await h.close();
    assert.equal(h.servers[0].listening, false);
    assert.equal(h.intervals.size, 0);
});

test("close during open disposes the pending listener and allows a later reopen", async (t) => {
    const gate = deferred();
    const h = await harness(t, { listenGate: gate });
    const opening = h.open();
    const rejected = assert.rejects(opening, (error) => error.code === "canvas_closed");
    const closing = h.close();
    gate.resolve();
    await Promise.all([rejected, closing]);
    assert.equal(h.servers.length, 1);
    assert.equal(h.servers[0].listening, false);
    const reopened = await h.open();
    assert.equal((await h.request(reopened, "/api/state")).ok, true);
    assert.equal(h.servers.length, 2);
});

test("listen errors reject opens, clean error/listening handlers, and permit retry", async (t) => {
    const h = await harness(t, { failListen: true });
    await assert.rejects(h.open(), /synthetic listen failure/);
    assert.equal(h.servers[0].listening, false);
    assert.equal(h.servers[0].listenerCount("error"), 0);
    assert.equal(h.servers[0].listenerCount("listening"), h.servers[0].initialListeningListeners);
    assert.equal(h.intervals.size, 0);
    const retry = await h.open();
    assert.equal((await h.request(retry, "/api/state")).ok, true);
    assert.equal(h.servers.length, 2);
});

test("closing a panel does not cancel its already-started explicit operation", async (t) => {
    const h = await harness(t);
    h.controls.inputs = [];
    const open = await h.open();
    const request = await requestFor(h, open);
    const started = deferred();
    const release = deferred();
    h.controls.executor = async () => { started.resolve(); await release.promise; return ok({ completed: true }); };
    const operation = h.request(open, "/api/command", { ...request, arguments: {} });
    await started.promise;
    const closing = h.close();
    release.resolve();
    assert.equal((await operation).ok, true);
    await closing;
    assert.equal(h.commandCalls().length, 1);
});

test("Windows batch wrappers fail explicitly without a shell, while executable argv stays intact", async () => {
    const url = new URL("../../extensions/aspire-apphosts/lib/app-model.mjs", import.meta.url);
    const context = createContext({ Buffer, process: { platform: "win32", env: {} }, setTimeout, clearTimeout, URL });
    let spawns = 0;
    const module = new SourceTextModule(await readFile(url, "utf8"), { context });
    await module.link(async (specifier) => {
        const exports = specifier === "node:child_process"
            ? { spawn() { spawns++; throw new Error("native spawn reached"); } } : await import(specifier);
        return new SyntheticModule(Object.keys(exports), function () {
            for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, { context });
    });
    await module.evaluate();
    for (const command of ["aspire.cmd", "ASPIRE.BAT"]) {
        const result = await module.namespace.runProcess(command, ['--json={"text":"quoted"}']);
        assert.equal(result.ok, false);
        assert.match(result.error, /ASPIRE_CLI.*unsupported.*executable/);
    }
    assert.equal(spawns, 0);
    assert.match((await module.namespace.runProcess("aspire.exe", [])).error, /native spawn reached/);
    assert.equal(spawns, 1, "native executable was invoked directly, never through another CLI");
});
