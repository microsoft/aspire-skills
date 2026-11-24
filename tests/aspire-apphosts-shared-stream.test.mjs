import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createSharedCliRunner, shareCliStream } from "../extensions/aspire-apphosts/lib/shared-stream.mjs";
import { streamProcess } from "../extensions/aspire-apphosts/lib/app-model.mjs";

const moduleUrl = new URL("../extensions/aspire-apphosts/lib/shared-stream.mjs", import.meta.url).href;
const waitUntil = async (predicate, timeout = 5_000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, "timed out waiting for shared stream");
        await delay(10);
    }
};

async function worker(t, directory, identity = "same-stream") {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
        import { shareCliStream } from ${JSON.stringify(moduleUrl)};
        let observers;
        let handle;
        const subscribe = () => {
            handle = shareCliStream({
                directory: ${JSON.stringify(directory)}, identity: ${JSON.stringify(identity)}, kind: "describe",
                start(options) {
                    observers = options;
                    process.send({ type: "started" });
                    options.onLine(JSON.stringify({ name: "api", state: "Running" }));
                    return { kill() { process.send({ type: "stopped" }); } };
                },
                onLine: (line) => process.send({ type: "line", data: JSON.parse(line) }),
                onExit: (result) => process.send({ type: "exit", result }),
            });
        };
        process.on("message", (message) => {
            if (message === "unsubscribe") handle.kill();
            if (message === "subscribe") subscribe();
            if (message?.emit) observers.onLine(JSON.stringify(message.emit));
        });
        subscribe();
    `], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
    const messages = [];
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("message", (message) => messages.push(message));
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise((done) => child.once("exit", done));
            child.kill();
            await exited;
        }
        assert.doesNotMatch(stderr, /Unhandled|SyntaxError/);
    });
    return { child, messages };
}

test("separate processes share one stream, replay latest state, and release only the final subscriber", { timeout: 15_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "acs-"));
    // Register cleanup before workers so their processes exit before removing the directory.
    const workers = [];
    t.after(async () => {
        for (const { child } of workers) {
            if (child.exitCode === null && child.signalCode === null) {
                const exited = new Promise((done) => child.once("exit", done));
                child.kill();
                await exited;
            }
        }
        await rm(directory, { recursive: true, force: true });
    });
    const first = await worker(t, directory);
    workers.push(first);
    await waitUntil(() => first.messages.some((item) => item.type === "line"));
    first.child.send({ emit: { name: "api", state: "Starting" } });
    await waitUntil(() => first.messages.some((item) => item.data?.state === "Starting"));
    const second = await worker(t, directory);
    workers.push(second);
    await waitUntil(() => second.messages.some((item) => item.data?.state === "Starting"));
    assert.equal(second.messages.some((item) => item.type === "started"), false);
    assert.equal(first.messages.filter((item) => item.type === "started").length, 1);
    assert.equal(second.messages.some((item) => item.data?.state === "Running"), false, "only latest state replays");

    first.child.send("unsubscribe");
    await delay(80);
    assert.equal(first.messages.some((item) => item.type === "stopped"), false, "another session still uses the stream");
    first.child.send({ emit: { name: "api", state: "Stopped" } });
    await waitUntil(() => second.messages.some((item) => item.data?.state === "Stopped"));
    second.child.send("unsubscribe");
    await waitUntil(() => first.messages.some((item) => item.type === "stopped"));
});

test("a surviving session can acquire the stream after its owner process exits", { timeout: 15_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "acs-"));
    const first = await worker(t, directory);
    await waitUntil(() => first.messages.some((item) => item.type === "line"));
    const second = await worker(t, directory);
    await waitUntil(() => second.messages.some((item) => item.type === "line"));
    const exited = new Promise((done) => first.child.once("exit", done));
    first.child.kill();
    await exited;
    await waitUntil(() => second.messages.some((item) => item.type === "exit"));
    assert.match(second.messages.find((item) => item.type === "exit").result.error, /owner disconnected/);
    second.child.send("subscribe");
    await waitUntil(() => second.messages.some((item) => item.type === "started"));
    second.child.send("unsubscribe");
    await waitUntil(() => second.messages.some((item) => item.type === "stopped"));
    t.after(() => rm(directory, { recursive: true, force: true }));
});

test("simultaneous provider startup elects just one stream owner", { timeout: 15_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "acs-"));
    const workers = await Promise.all(Array.from({ length: 4 }, () => worker(t, directory, "race")));
    for (const item of workers) await waitUntil(() => item.messages.some((message) => message.type === "line"));
    assert.equal(workers.flatMap((item) => item.messages).filter((message) => message.type === "started").length, 1);
    for (const item of workers) item.child.send("unsubscribe");
    await waitUntil(() => workers.flatMap((item) => item.messages).some((message) => message.type === "stopped"));
    t.after(() => rm(directory, { recursive: true, force: true }));
});

test("a socket file left by a crashed owner is reclaimed by the next subscriber", { timeout: 15_000, skip: process.platform === "win32" && "named pipes leave no socket file" }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "acs-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const sockets = async () => (await readdir(directory)).filter((name) => name.endsWith(".sock"));
    const crashed = await worker(t, directory, "stale");
    await waitUntil(() => crashed.messages.some((item) => item.type === "started"));
    const exited = new Promise((done) => crashed.child.once("exit", done));
    crashed.child.kill("SIGKILL");
    await exited;
    assert.equal((await sockets()).length, 1, "SIGKILL leaves the socket file behind");

    const next = await worker(t, directory, "stale");
    await waitUntil(() => next.messages.some((item) => item.type === "started"));
    assert.equal((await sockets()).length, 1);
    next.child.send("unsubscribe");
    await waitUntil(() => next.messages.some((item) => item.type === "stopped"));
});

test("the final subscriber terminates the real CLI child rather than just dropping its handle", { timeout: 10_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "acs-"));
    const lines = [];
    let starts = 0;
    let stopped = false;
    const subscribe = () => shareCliStream({
        directory, identity: "real-child", kind: "describe",
        start(options) {
            starts++;
            return streamProcess(process.execPath, ["-e", `
                process.stdout.write(JSON.stringify({name:"api",pid:process.pid})+"\\n");
                setInterval(()=>{},1000);
            `], { ...options, onExit(result) { stopped = true; options.onExit(result); } });
        },
        onLine: (line) => lines.push(JSON.parse(line)),
    });
    const handles = [subscribe()];
    t.after(async () => {
        for (const handle of handles) handle.kill();
        await waitUntil(() => stopped);
        await rm(directory, { recursive: true, force: true });
    });
    await waitUntil(() => lines.length === 1);
    const pid = lines[0].pid;
    handles.push(subscribe());
    await waitUntil(() => lines.length === 2);
    assert.equal(starts, 1);
    assert.equal(lines[1].pid, pid);
    handles[0].kill();
    assert.doesNotThrow(() => process.kill(pid, 0), "the second subscriber still owns the child");
    handles[1].kill();
    await waitUntil(() => stopped);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("provider exit cleans up a CLI stream even if its subscription was not closed", { timeout: 10_000 }, async (t) => {
    const url = new URL("../extensions/aspire-apphosts/lib/app-model.mjs", import.meta.url).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
        import { streamProcess } from ${JSON.stringify(url)};
        streamProcess(process.execPath, ["-e", "console.log(process.pid);setInterval(()=>{},1000)"], {
            onLine: (line) => process.send(Number(line)),
        });
        process.on("message", () => process.exit(0));
    `], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
    let pid;
    child.on("message", (value) => { pid = value; });
    t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    await waitUntil(() => pid);
    const exited = new Promise((done) => child.once("exit", done));
    child.send("exit");
    await exited;
    await waitUntil(() => {
        try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
    });
});

test("IPC refuses unauthenticated consumers and does not expose cached resources", { timeout: 10_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "acs-"));
    const messages = [];
    let starts = 0;
    let stops = 0;
    const handle = shareCliStream({
        directory, identity: "auth", kind: "describe",
        start({ onLine }) {
            starts++;
            onLine('{"name":"private-resource","state":"Running"}');
            return { kill() { stops++; } };
        },
        onLine: (line) => messages.push(line),
    });
    t.after(async () => {
        handle.kill();
        await waitUntil(() => stops === 1);
        await rm(directory, { recursive: true, force: true });
    });
    await waitUntil(() => messages.length === 1);
    const secret = await readFile(join(directory, "secret"), "utf8");
    const key = createHash("sha256").update(`v1\0${secret}\0auth`).digest("hex").slice(0, 32);
    const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\aspire-canvas-${key}` : join(directory, `${key}.sock`);
    const attacker = createConnection(endpoint);
    attacker.setEncoding("utf8");
    let output = "";
    const closed = new Promise((done) => attacker.once("close", done));
    attacker.on("data", (chunk) => {
        output += chunk;
        attacker.write('{"proof":"incorrect"}\n');
    });
    attacker.on("error", () => {});
    await closed;
    assert.equal(starts, 1);
    assert.doesNotMatch(output, /private-resource|Running/);
});

test("ps replay keeps only the latest run and never resurrects stopped AppHosts", { timeout: 10_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "acs-"));
    let publish;
    let stops = 0;
    let ready = 0;
    const lines = [[], [], []];
    const handles = [];
    const subscribe = (index) => handles.push(shareCliStream({
        directory, identity: "ps-replay", kind: "ps",
        start({ onLine }) {
            publish = (record) => onLine(JSON.stringify({ appHostPath: join(directory, "AppHost.cs"), ...record }));
            publish({ appHostPid: 1, status: "running" });
            return { kill() { stops++; } };
        },
        onLine: (line) => lines[index].push(JSON.parse(line)),
        onReady: () => { ready++; },
    }));
    t.after(async () => {
        for (const handle of handles) handle.kill();
        await waitUntil(() => stops === 1);
        await rm(directory, { recursive: true, force: true });
    });
    subscribe(0);
    await waitUntil(() => ready === 1);
    publish({ appHostPid: 2, status: "running" });
    publish({ appHostPid: 1, status: "stopped" });
    subscribe(1);
    await waitUntil(() => ready === 2);
    assert.deepEqual(lines[1].map(({ appHostPid, status }) => ({ appHostPid, status })), [
        { appHostPid: 2, status: "running" },
    ]);
    publish({ appHostPid: 2, status: "stopped" });
    subscribe(2);
    await waitUntil(() => ready === 3);
    assert.deepEqual(lines[2], [], "the broker must not replay removed hosts to a late subscriber");
});

test("describe replay sends every resource from a snapshot to late subscribers", { timeout: 10_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "acs-"));
    let publish;
    let stops = 0;
    let ready = 0;
    const lines = [[], []];
    const handles = [];
    const subscribe = (index) => handles.push(shareCliStream({
        directory, identity: "describe-snapshot", kind: "describe",
        start({ onLine }) {
            publish = (value) => onLine(JSON.stringify(value));
            publish({ resources: [{ name: "api", state: "Running" }, { name: "cache", state: "Running" }, { name: "db", state: "Starting" }] });
            return { kill() { stops++; } };
        },
        onLine: (line) => lines[index].push(JSON.parse(line)),
        onReady: () => { ready++; },
    }));
    t.after(async () => {
        for (const handle of handles) handle.kill();
        await waitUntil(() => stops === 1);
        await rm(directory, { recursive: true, force: true });
    });
    subscribe(0);
    await waitUntil(() => ready === 1);
    publish({ name: "db", state: "Running" });
    publish([{ name: "api", state: "Running" }, { name: "worker", state: "Running" }, { name: "db", state: "Running" }]);
    subscribe(1);
    await waitUntil(() => ready === 2);
    assert.deepEqual(lines[1].map(({ name, state }) => ({ name, state })), [
        { name: "api", state: "Running" },
        { name: "worker", state: "Running" },
        { name: "db", state: "Running" },
    ]);
});

test("authoritative describe reconciliation removes stale replay for every subscriber but keeps newer updates", { timeout: 10_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "acs-"));
    let publish;
    let stops = 0;
    let ready = 0;
    const lines = [[], [], []];
    const handles = [];
    const subscribe = (index) => handles.push(shareCliStream({
        directory, identity: "describe-reconcile", kind: "describe",
        start({ onLine }) {
            publish = (value) => onLine(JSON.stringify(value));
            for (const name of ["api", "cache", "db"]) publish({ name, state: "Running" });
            return { kill() { stops++; } };
        },
        onLine: (line) => lines[index].push(JSON.parse(line)),
        onReady: () => { ready++; },
    }));
    t.after(async () => {
        for (const handle of handles) handle.kill();
        await waitUntil(() => stops === 1);
        await rm(directory, { recursive: true, force: true });
    });
    subscribe(0);
    subscribe(1);
    await waitUntil(() => ready === 2);
    const since = handles[0].mark();
    assert.equal(since, 3);
    publish({ name: "db", state: "Finished" });
    await waitUntil(() => lines[0].some((line) => line.state === "Finished"));
    assert.equal(handles[0].reconcile(since, [{ name: "api", state: "Running" }, { name: "db", state: "Running" }]), true);
    await waitUntil(() => lines[1].some((line) => Array.isArray(line.resources)));
    assert.deepEqual(lines[1].at(-1).resources.map(({ name, state }) => ({ name, state })), [
        { name: "api", state: "Running" },
        { name: "db", state: "Finished" },
    ]);
    subscribe(2);
    await waitUntil(() => ready === 3);
    assert.deepEqual(lines[2].map(({ name, state }) => ({ name, state })), [
        { name: "api", state: "Running" },
        { name: "db", state: "Finished" },
    ], "late subscribers must not replay resources removed by an authoritative snapshot");
});

test("authoritative describe reconciliation above one frame is chunked and still removes stale replay", { timeout: 20_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "acs-"));
    let publish;
    let stops = 0;
    let ready = 0;
    const lines = [[], [], []];
    const handles = [];
    const subscribe = (index) => handles.push(shareCliStream({
        directory, identity: "describe-reconcile-large", kind: "describe",
        start({ onLine }) {
            publish = (value) => onLine(JSON.stringify(value));
            for (const name of ["api", "cache", "db"]) publish({ name, state: "Running" });
            return { kill() { stops++; } };
        },
        onLine: (line) => lines[index].push(JSON.parse(line)),
        onReady: () => { ready++; },
    }));
    t.after(async () => {
        for (const handle of handles) handle.kill();
        await waitUntil(() => stops === 1);
        await rm(directory, { recursive: true, force: true });
    });
    subscribe(0);
    subscribe(1);
    await waitUntil(() => ready === 2);
    const since = handles[0].mark();
    const payload = "x".repeat(1_500_000);
    const snapshot = ["api", "db", "web"].map((name) => ({ name, state: "Running", payload }));
    assert.ok(Buffer.byteLength(JSON.stringify({ reconcile: { since, resources: snapshot } })) > 4 * 1024 * 1024);
    assert.equal(handles[0].reconcile(since, snapshot), true);
    await waitUntil(() => lines[1].some((line) => Array.isArray(line.resources)), 15_000);
    assert.deepEqual(lines[1].at(-1).resources.map(({ name }) => name), ["api", "db", "web"]);
    subscribe(2);
    await waitUntil(() => ready === 3, 15_000);
    assert.deepEqual(lines[2].map(({ name }) => name), ["api", "db", "web"],
        "oversized authoritative snapshots must not leave removed resources in replay");
    assert.equal(stops, 0, "a chunked reconciliation must not restart the shared stream");
});

test("authoritative describe reconciliation beyond the replay bound invalidates the shared stream", { timeout: 30_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "acs-"));
    let publish;
    let starts = 0;
    let stops = 0;
    let ready = 0;
    const exits = [];
    const lines = [[], [], []];
    const handles = [];
    const subscribe = (index) => handles.push(shareCliStream({
        directory, identity: "describe-reconcile-overflow", kind: "describe",
        start({ onLine }) {
            starts++;
            publish = (value) => onLine(JSON.stringify(value));
            if (starts === 1) for (const name of ["api", "cache"]) publish({ name, state: "Running" });
            else publish({ name: "api", state: "Running" });
            return { kill() { stops++; } };
        },
        onLine: (line) => lines[index].push(JSON.parse(line)),
        onReady: () => { ready++; },
        onExit: (result) => exits.push(result),
    }));
    t.after(async () => {
        for (const handle of handles) handle.kill();
        await waitUntil(() => stops === starts);
        await rm(directory, { recursive: true, force: true });
    });
    subscribe(0);
    subscribe(1);
    await waitUntil(() => ready === 2);
    const since = handles[0].mark();
    const payload = "x".repeat(3_500_000);
    const snapshot = ["api", "a", "b", "c", "d"].map((name) => ({ name, payload }));
    assert.equal(handles[0].reconcile(since, snapshot), true);
    await waitUntil(() => exits.length === 2, 25_000);
    assert.ok(exits.every((result) => /replay exceeded/.test(result.error)), JSON.stringify(exits));
    assert.equal(stops, 1);
    subscribe(2);
    await waitUntil(() => ready === 3, 25_000);
    assert.equal(starts, 2);
    assert.deepEqual(lines[2].map(({ name }) => name), ["api"],
        "an unreplayable snapshot must not leave the stale cache for later subscribers");
});

test("ps replay treats status case-insensitively and a missing status as running", { timeout: 10_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "acs-"));
    let publish;
    let stops = 0;
    let ready = 0;
    const lines = [[], []];
    const handles = [];
    const subscribe = (index) => handles.push(shareCliStream({
        directory, identity: "ps-status-case", kind: "ps",
        start({ onLine }) {
            publish = (name, record) => onLine(JSON.stringify({ appHostPath: join(directory, name), ...record }));
            publish("A.cs", { appHostPid: 1, status: "Running" });
            publish("B.cs", { appHostPid: 2 });
            publish("C.cs", { appHostPid: 3, status: "running" });
            publish("C.cs", { appHostPid: 3, status: "STOPPED" });
            return { kill() { stops++; } };
        },
        onLine: (line) => lines[index].push(JSON.parse(line)),
        onReady: () => { ready++; },
    }));
    t.after(async () => {
        for (const handle of handles) handle.kill();
        await waitUntil(() => stops === 1);
        await rm(directory, { recursive: true, force: true });
    });
    subscribe(0);
    await waitUntil(() => ready === 1);
    subscribe(1);
    await waitUntil(() => ready === 2);
    assert.deepEqual(lines[1].map(({ appHostPid }) => appHostPid).sort(), [1, 2]);
});

test("the runner shares equivalent streams but isolates executables, hidden resources, and mutations", { timeout: 10_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "acs-"));
    const starts = [];
    let stops = 0;
    const runner = (command) => createSharedCliRunner({
        run: async (args) => { starts.push({ mutation: args }); return { ok: true }; },
        stream(args, options) {
            starts.push({ command, args });
            options.onLine('{"name":"api","state":"Running"}');
            return { kill() { stops++; } };
        },
    }, { command, directory, resolveExecutable: async (value) => join(directory, value) });
    const first = runner("one");
    const second = runner("one");
    const received = [];
    const handles = [];
    const args = ["describe", "--follow", "--apphost", join(directory, "AppHost.cs"), "--format", "Json"];
    const subscribe = (cli, extra = []) => handles.push(cli.stream([...args, ...extra], {
        cwd: directory, onLine: (line) => received.push(line),
    }));
    t.after(async () => {
        for (const handle of handles) handle.kill();
        await waitUntil(() => stops === starts.filter((item) => !item.mutation).length);
        await rm(directory, { recursive: true, force: true });
    });
    subscribe(first, ["--log-file", join(directory, "first.log")]);
    await waitUntil(() => received.length === 1);
    subscribe(second, ["--log-file", join(directory, "second.log")]);
    await waitUntil(() => received.length === 2);
    assert.equal(starts.length, 1, "log-file names do not partition subscriptions");
    subscribe(second, ["--include-hidden"]);
    subscribe(runner("two"));
    await waitUntil(() => received.length === 4);
    assert.equal(starts.length, 3);
    await first.run(["resource", "api", "restart"]);
    await second.run(["resource", "api", "restart"]);
    assert.equal(starts.filter((item) => item.mutation).length, 2, "explicit operations must never coalesce");
});

test("ps streams share the resolved executable across working directories and isolate different installations", { timeout: 10_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "acs-"));
    const starts = [];
    const resolutions = [];
    const handles = [];
    let stops = 0;
    let ready = 0;
    const runner = createSharedCliRunner({
        stream(_args, options) {
            starts.push(options.executable);
            return { kill() { stops++; } };
        },
    }, {
        command: "aspire",
        directory,
        resolveExecutable: async (_command, env, options) => {
            resolutions.push({ env, ...options });
            return join(directory, env.PATH === "first" ? "first" : "second", "aspire");
        },
    });
    t.after(async () => {
        for (const handle of handles) handle.kill();
        await waitUntil(() => stops === starts.length);
        await rm(directory, { recursive: true, force: true });
    });
    const subscribe = (cwd, path) => handles.push(runner.stream(["ps", "--follow"], {
        cwd, env: { PATH: path }, onReady: () => { ready++; },
    }));
    subscribe(join(directory, "workspace-one"), "first");
    subscribe(join(directory, "workspace-two"), "first");
    subscribe(join(directory, "workspace-one"), "second");
    await waitUntil(() => ready === 3);
    assert.deepEqual(starts.sort(), [join(directory, "first", "aspire"), join(directory, "second", "aspire")].sort());
    assert.ok(resolutions.every(({ forSharing }) => forSharing));
    assert.deepEqual(resolutions.map(({ cwd }) => cwd), [
        join(directory, "workspace-one"), join(directory, "workspace-two"), join(directory, "workspace-one"),
    ]);
});

test("stream setup refuses shared directories and secrets other users can read or redirect", { timeout: 10_000, skip: process.platform === "win32" && "POSIX permissions only" }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "acs-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const attempt = async (directory) => {
        let started = false;
        const exit = await new Promise((done) => shareCliStream({
            directory, identity: "private", kind: "describe",
            start() { started = true; return { kill() {} }; },
            onExit: done,
        }));
        assert.equal(started, false, "no CLI may start without a private broker");
        return exit.error;
    };
    const shared = join(root, "shared");
    await mkdir(shared, { mode: 0o700 });
    await chmod(shared, 0o755);
    assert.match(await attempt(shared), /directory is not private/);
    const readable = join(root, "readable");
    await mkdir(readable, { mode: 0o700 });
    await writeFile(join(readable, "secret"), "a".repeat(64), { mode: 0o644 });
    await chmod(join(readable, "secret"), 0o644);
    assert.match(await attempt(readable), /secret is not private/);
    const target = join(root, "target");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, join(root, "redirected"), "dir");
    assert.match(await attempt(join(root, "redirected")), /directory is not private/);
});

test("an authoritative snapshot started before one already applied cannot restore removed resources", { timeout: 10_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "acs-"));
    let publish;
    let stops = 0;
    let ready = 0;
    const lines = [[], [], []];
    const handles = [];
    const subscribe = (index) => handles.push(shareCliStream({
        directory, identity: "describe-stale-reconcile", kind: "describe",
        start({ onLine }) {
            publish = (value) => onLine(JSON.stringify(value));
            for (const name of ["api", "cache", "db"]) publish({ name, state: "Running" });
            return { kill() { stops++; } };
        },
        onLine: (line) => lines[index].push(JSON.parse(line)),
        onReady: () => { ready++; },
    }));
    t.after(async () => {
        for (const handle of handles) handle.kill();
        await waitUntil(() => stops === 1);
        await rm(directory, { recursive: true, force: true });
    });
    const snapshots = (index) => lines[index].filter((line) => Array.isArray(line.resources));
    subscribe(0);
    subscribe(1);
    await waitUntil(() => ready === 2);
    const older = handles[0].mark();
    publish({ name: "api", state: "Running" });
    await waitUntil(() => lines[0].length === 4 && lines[1].length === 4);
    const newer = handles[1].mark();
    assert.ok(newer > older);
    assert.equal(handles[1].reconcile(newer, [{ name: "api", state: "Running" }]), true);
    await waitUntil(() => snapshots(0).length === 1);
    assert.equal(handles[0].reconcile(older, ["api", "cache", "db"].map((name) => ({ name, state: "Running" }))), true);
    await waitUntil(() => snapshots(0).length === 2);
    assert.deepEqual(snapshots(0).at(-1).resources.map(({ name }) => name), ["api"],
        "the sender is resynced to the broker instead of keeping its stale snapshot");
    subscribe(2);
    await waitUntil(() => ready === 3);
    assert.deepEqual(lines[2].map(({ name }) => name), ["api"]);
    assert.equal(snapshots(1).length, 1, "a dropped snapshot is not broadcast");
});

test("the runner reports executable resolution failures without starting a stream", { timeout: 10_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "acs-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let streams = 0;
    const runner = createSharedCliRunner({ stream() { streams++; return { kill() {} }; } }, {
        command: "aspire", directory, resolveExecutable: async () => { throw new Error("not on PATH"); },
    });
    const exit = await new Promise((done) => runner.stream(["ps", "--follow"], { onExit: done }));
    assert.match(exit.error, /Unable to resolve shared Aspire CLI: not on PATH/);
    assert.equal(streams, 0);
});

test("a released owner reports a broker stop as cancelled and a later process failure as after release", { timeout: 10_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "acs-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let processExit;
    const runner = createSharedCliRunner({
        stream(_args, options) {
            processExit = options.onExit;
            return { kill() { options.onExit({ code: null, cancelled: true }); } };
        },
    }, { command: "aspire", directory, resolveExecutable: async () => join(directory, "aspire") });
    const subscribe = (onExit) => {
        let ready = false;
        const handle = runner.stream(["ps", "--follow"], { onReady: () => { ready = true; }, onExit });
        return { handle, ready: () => ready };
    };

    const exits = [];
    const sole = subscribe((result) => exits.push(result));
    await waitUntil(sole.ready);
    sole.handle.kill();
    await waitUntil(() => exits.length === 1);
    assert.deepEqual(exits, [{ code: null, cancelled: true }]);

    const ownerExits = [];
    const otherExits = [];
    const owner = subscribe((result) => ownerExits.push(result));
    await waitUntil(owner.ready);
    const other = subscribe((result) => otherExits.push(result));
    await waitUntil(other.ready);
    owner.handle.kill();
    await delay(50);
    assert.deepEqual(ownerExits, [], "the owner's log is kept until its process exits");
    processExit({ code: 1, error: "boom" });
    await waitUntil(() => ownerExits.length === 1 && otherExits.length === 1);
    assert.deepEqual(ownerExits, [{ code: 1, error: "boom", afterRelease: true }]);
    assert.equal(otherExits[0].error, "boom");
});