import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SourceTextModule, SyntheticModule, createContext } from "node:vm";

const extensionUrl = (path) => new URL(`../../extensions/${path}`, import.meta.url);
const appHosts = extensionUrl("aspire-apphosts/lib/app-model.mjs");
const doctorHelpers = extensionUrl("aspire-doctor/provider-helpers.mjs");
const doctor = extensionUrl("aspire-doctor/extension.mjs");

const installDirectory = "C:\\Program Files\\Aspire";
const installedExecutable = `${installDirectory}\\aspire.exe`;
const workspace = "C:\\Repos\\app";
const appHostDirectory = `${workspace}\\Demo.AppHost`;
const file = (...paths) => paths.map((path) => [path, "file"]);
const withLocalCopies = file(installedExecutable, `${workspace}\\aspire.exe`, `${appHostDirectory}\\aspire.exe`);

// A drive or UNC share root followed by a separator; any other path depends on the working directory.
const isFullyQualified = (path) => /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/.test(path);

// Loads an extension module on a simulated platform with process launching and file lookup replaced.
async function load(url, {
    platform = "win32",
    env = { Path: installDirectory },
    files = file(installedExecutable),
    lookup,
    closeOnSpawn = true,
    clock,
} = {}) {
    const entries = new Map(files.map(([path, kind]) => [path.toLowerCase(), kind]));
    const spawns = [];
    let registration;
    const context = createContext({
        Buffer, URL,
        setTimeout: clock?.setTimeout ?? setTimeout,
        clearTimeout: clock?.clearTimeout ?? clearTimeout,
        process: { platform, env, cwd: () => workspace },
    });
    const replacements = {
        "node:child_process": {
            ...childProcess,
            spawn(command, _args, options) {
                const child = new EventEmitter();
                spawns.push({ command, options, child });
                child.stdout = new PassThrough();
                child.stderr = new PassThrough();
                child.killed = false;
                child.kill = () => { child.killed = true; };
                child.unref = () => {};
                if (closeOnSpawn) {
                    queueMicrotask(() => {
                        child.emit("spawn");
                        child.stdout.end(JSON.stringify({ checks: [] }));
                        child.emit("close", 0);
                    });
                }
                return child;
            },
        },
        "node:fs/promises": {
            ...fs,
            async stat(path) {
                if (lookup) await lookup(path);
                // A relative lookup resolves against the working directory, so it always finds a binary.
                const entry = isFullyQualified(path) ? entries.get(path.toLowerCase()) : "file";
                if (entry instanceof Error) throw entry;
                if (!entry) throw Object.assign(new Error(`File not found: ${path}`), { code: "ENOENT" });
                return { isFile: () => entry === "file" };
            },
        },
        "@github/copilot-sdk/extension": {
            createCanvas: (declaration) => declaration,
            CanvasError: class extends Error {},
            joinSession: async (registered) => {
                registration = registered;
                return { log() {} };
            },
        },
    };
    if (clock) {
        replacements["node:perf_hooks"] = { performance: { now: clock.now } };
    }
    const create = async (identifier) => {
        const exports = replacements[identifier] ?? (identifier.startsWith("node:") ? await import(identifier) : undefined);
        return exports
            ? new SyntheticModule(Object.keys(exports), function () {
                for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
            }, { context, identifier })
            : new SourceTextModule(await fs.readFile(new URL(identifier), "utf8"), {
                context, identifier, initializeImportMeta: (meta) => { meta.url = identifier; },
            });
    };
    const modules = new Map();
    const get = (identifier) => {
        if (!modules.has(identifier)) modules.set(identifier, create(identifier));
        return modules.get(identifier);
    };
    const root = await get(url.href);
    await root.link((specifier, referrer) => get(specifier.startsWith(".") ? new URL(specifier, referrer.identifier).href : specifier));
    await root.evaluate();
    return { module: root.namespace, spawns, registration };
}

const providers = [
    {
        name: "AppHosts",
        timeoutMs: 20,
        async withRunner(options, use) {
            const { module, spawns } = await load(appHosts, options);
            return use({
                spawns,
                run: () => module.createAspireCliRunner().run(["ps"], { cwd: workspace, timeoutMs: this.timeoutMs }),
            });
        },
        async resolve({ command, cwd, platform, env, files }) {
            const { module, spawns } = await load(appHosts, { platform, env, files });
            const result = await module.createAspireCliRunner({ command }).run(["ps"], { cwd });
            return { executable: spawns[0]?.command, error: result.ok ? undefined : result.error };
        },
    },
    {
        name: "Doctor",
        timeoutMs: 60_000,
        async withRunner(options, use) {
            return withDoctorCanvas(options, ({ canvas, instance, spawns }) => use({
                spawns,
                run: () => canvas.actions.find(({ name }) => name === "run_diagnostics").handler(instance),
            }));
        },
        async resolve({ command, platform, env, files }) {
            const { module } = await load(doctorHelpers, { platform, env, files });
            try {
                return { executable: await module.resolveCliExecutable(command, env) };
            } catch (error) {
                return { error: error.message };
            }
        },
    },
];

const denied =  Object.assign(new Error("Permission denied inspecting the Aspire CLI"), { code: "EACCES" });

const cases = [
    { name: "a repository root copy is ignored in favor of the PATH installation", cwd: workspace, files: withLocalCopies, executable: installedExecutable },
    { name: "an AppHost directory copy is ignored in favor of the PATH installation", cwd: appHostDirectory, files: withLocalCopies, executable: installedExecutable },
    {
        name: "relative and empty PATH entries are skipped while quoted entries are honored",
        env: { Path: `;.;..;tools;C:tools;\\tools;/tools;\\\\server;        %USERPROFILE%\\bin;"${installDirectory}"` },
                executable: installedExecutable,
    },
    {
        name: "PATH order is preserved, and directories and lookup misses are not executables",
        env: { Path: "C:\\Missing;C:\\NotADirectory;C:\\Directory;C:\\First;C:\\Second" },
        files: [
            ["C:\\NotADirectory\\aspire.exe", Object.assign(new Error("Not a directory"), { code: "ENOTDIR" })],
            ["C:\\Directory\\aspire.exe", "directory"],
            ...file("C:\\First\\aspire.exe", "C:\\Second\\aspire.exe"),
        ],
        executable: "C:\\First\\aspire.exe",
    },
    {
        name: "the PATH variable is found case-insensitively using Node's key ordering",
        env: { Path: "C:\\Ignored",         PATH: installDirectory, path: "C:\\IgnoredToo" },
                executable: installedExecutable,
    },
    { name: "an unset PATH is rejected", env: {}, files: withLocalCopies },
    { name: "a PATH without the CLI is rejected", files: withLocalCopies.slice(1) },
    { name: "a PATH of only relative entries is rejected", env: { Path: ";.;tools;C:tools;\\tools" }, files: withLocalCopies },
    {
        name: "a filesystem error stops the search instead of trying another installation",
        env: { Path: `C:\\Denied;${installDirectory}` },
        files: [["C:\\Denied\\aspire.exe", denied], ...file(installedExecutable)],
    },
    ...["aspire", "custom-aspire.exe", "aspire-13.6"].map((command) => {
        const executableName = command.endsWith(".exe") ? command : `${command}.exe`;
        const executable = `${installDirectory}\\${executableName}`;
        return {
            name: `bare ASPIRE_CLI=${command} is resolved only through PATH`,
            command, files: file(executable, `${workspace}\\${executableName}`), executable,
        };
    }),
    {
        name: "a dotted bare ASPIRE_CLI prefers the literal executable over .exe completion",
        command: "aspire-13.6",
        files: file(`${installDirectory}\\aspire-13.6`, `${installDirectory}\\aspire-13.6.exe`),
        executable: `${installDirectory}\\aspire-13.6`,
    },
    {
        name: "dotted bare ASPIRE_CLI completion preserves PATH directory order",
        command: "aspire-13.6",
        env: { Path: "C:\\First;C:\\Second" },
        files: file("C:\\First\\aspire-13.6.exe", "C:\\Second\\aspire-13.6"),
        executable: "C:\\First\\aspire-13.6.exe",
    },
    ...["C:\\Custom Tools\\Aspire.EXE", "\\\\cli-server\\tools\\aspire.exe"].map((command) => ({
        name: `fully qualified ASPIRE_CLI=${command} is used as written`, command, files: [], executable: command,
    })),
    ...[".\\aspire.exe", "C:aspire.exe", "\\aspire.exe", "/aspire.exe"].map((command) => ({
        name: `relative ASPIRE_CLI=${command} is rejected`, command, files: withLocalCopies,
    })),
    ...["aspire.cmd", "C:\\Custom Tools\\ASPIRE.BAT"].map((command) => ({
        name: `batch ASPIRE_CLI=${command} is rejected`, command, files: file(`${installDirectory}\\aspire.cmd`),
    })),
    ...["aspire", "./custom-aspire"].map((command) => ({
        name: `Linux keeps ASPIRE_CLI=${command} as written`, platform: "linux", command, env: {}, files: [], executable: command,
    })),
];

// Cases without an executable must be rejected without launching anything.
for (const provider of providers) {
    for (const { name, executable, ...overrides } of cases) {
        test(`${provider.name}: ${name}`, async () => {
            const outcome = await provider.resolve({
                command: "aspire.exe", cwd: workspace, platform: "win32",                 env: { Path: installDirectory }, files: file(installedExecutable),
                ...overrides,
            });
            if (executable) {
                assert.equal(outcome.error, undefined);
                assert.equal(outcome.executable, executable);
            } else {
                assert.ok(outcome.error);
                assert.equal(outcome.executable, undefined);
            }
        });
    }
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function createClock() {
    let now = 0;
    const timers = new Set();
    return {
        timers,
        now: () => now,
        setTimeout(callback, delay) {
            const timer = { callback, at: now + delay, unref() {} };
            timers.add(timer);
            return timer;
        },
        clearTimeout(timer) {
            timers.delete(timer);
        },
        advance(ms, { fireTimers = true } = {}) {
            now += ms;
            if (fireTimers) {
                for (const timer of [...timers]) {
                    if (timer.at <= now) {
                        timers.delete(timer);
                        timer.callback();
                    }
                }
            }
        },
    };
}

for (const provider of providers) {
    for (const lateOutcome of ["success", "error"]) {
        test(`${provider.name}: stalled lookup times out and late ${lateOutcome} cannot launch a child`, async () => {
            const clock = createClock();
            const lookup = deferred();
            await provider.withRunner({ clock, lookup: () => lookup.promise }, async ({ run, spawns }) => {
                const pending = run();
                assert.equal(clock.timers.size, 1, "the timeout must be active while lookup is pending");
                clock.advance(provider.timeoutMs);
                const result = await pending;
                assert.equal(result.ok, false);
                assert.match(result.error, /timed out/);
                assert.equal(spawns.length, 0);

                if (lateOutcome === "success") lookup.resolve();
                else lookup.reject(denied);
                await nextTurn();
                assert.equal(spawns.length, 0);
                assert.equal(await pending, result);
                assert.equal(clock.timers.size, 0);
            });
        });
    }

    test(`${provider.name}: lookup and child execution share one timeout`, async () => {
        const clock = createClock();
        const lookup = deferred();
        await provider.withRunner({ clock, lookup: () => lookup.promise, closeOnSpawn: false }, async ({ run, spawns }) => {
            const pending = run();
            clock.advance(provider.timeoutMs / 2);
            lookup.resolve();
            await nextTurn();
            assert.equal(spawns.length, 1);
            const [{ child }] = spawns;
            assert.equal(child.killed, false);
            assert.equal(clock.timers.size, 1);
            assert.equal([...clock.timers][0].at, provider.timeoutMs, "lookup must not restart the timeout");

            clock.advance(provider.timeoutMs / 2);
            const result = await pending;
            assert.equal(result.ok, false);
            assert.match(result.error, /timed out/);
            assert.equal(child.killed, true);
            assert.equal(clock.timers.size, 0);
            child.stdout.end(JSON.stringify({ checks: [] }));
            child.emit("close", 0);
            assert.equal(await pending, result);
        });
    });

    for (const lateOutcome of ["success", "error"]) {
        test(`${provider.name}: expired lookup ${lateOutcome} reports a timeout before a delayed timer callback`, async () => {
            const clock = createClock();
            const lookup = deferred();
            await provider.withRunner({ clock, lookup: () => lookup.promise }, async ({ run, spawns }) => {
                const pending = run();
                clock.advance(provider.timeoutMs, { fireTimers: false });
                if (lateOutcome === "success") lookup.resolve();
                else lookup.reject(denied);
                await nextTurn();
                const result = await pending;
                assert.equal(result.ok, false);
                assert.match(result.error, /timed out/);
                assert.equal(spawns.length, 0);
                assert.equal(clock.timers.size, 0);
            });
        });
    }

    test(`${provider.name}: successful lookup and execution clear the timeout`, async () => {
        const clock = createClock();
        const lookup = deferred();
        await provider.withRunner({ clock, lookup: () => lookup.promise }, async ({ run, spawns }) => {
            const pending = run();
            clock.advance(provider.timeoutMs / 2);
            lookup.resolve();
            assert.equal((await pending).ok, true);
            assert.equal(spawns.length, 1);
            assert.equal(clock.timers.size, 0);
            clock.advance(provider.timeoutMs);
            assert.equal(spawns[0].child.killed, false);
        });
    });

    test(`${provider.name}: lookup failures clear the timeout without spawning`, async () => {
        const clock = createClock();
        await provider.withRunner({ clock, files: [[installedExecutable, denied]] }, async ({ run, spawns }) => {
            const result = await run();
            assert.equal(result.ok, false);
            assert.match(result.error, /Permission denied/);
            assert.equal(spawns.length, 0);
            assert.equal(clock.timers.size, 0);
        });
    });
}

test("AppHosts spawns the resolved executable with the caller's cwd and child environment, and no shell", async () => {
    const executable = "C:\\Child Tools\\aspire.exe";
    const env = { Path: "C:\\Child Tools" };
    const { module, spawns } = await load(appHosts, { files: file(installedExecutable, executable) });
    assert.equal((await module.createAspireCliRunner().run(["ps"], { cwd: appHostDirectory, env })).ok, true);
    assert.equal(spawns[0].command, executable);
    assert.equal(spawns[0].options.cwd, appHostDirectory);
    assert.deepEqual({ ...spawns[0].options.env }, env);
    assert.equal(spawns[0].options.shell, false);
});

test("AppHosts JSON runs report a missing CLI as a failed result instead of throwing", async () => {
    const { module, spawns } = await load(appHosts, { env: {} });
    const result = await module.createAspireCliRunner().runJson(["ps"], { cwd: workspace });
    assert.equal(result.ok, false);
    assert.equal(result.data, undefined);
    assert.ok(result.error);
    assert.equal(spawns.length, 0);
});

async function withDoctorCanvas(options, use) {
    const { registration, spawns } = await load(doctor, options);
    const [canvas] = registration.canvases;
    const instance = { instanceId: "launch-boundary" };
    const { url } = await canvas.open(instance);
    try {
        return { result: await use({ canvas, instance, url, spawns }), spawns };
    } finally {
        await canvas.onClose(instance);
    }
}

const runDiagnostics = (options) => withDoctorCanvas(options, ({ canvas, instance }) =>
    canvas.actions.find(({ name }) => name === "run_diagnostics").handler(instance));

const revealed = fileURLToPath(import.meta.url);

const revealPath = (options) => withDoctorCanvas(options, async ({ url }) => {
    const response = await fetch(new URL("/api/open-path", url), {
        method: "POST",
        headers: { "x-aspire-doctor-token": new URL(url).searchParams.get("token") },
        body: JSON.stringify({ path: revealed }),
    });
    return response.json();
});

test("Doctor's diagnostics action spawns the PATH-installed CLI without a shell", async () => {
    const { result, spawns } = await runDiagnostics({ files: withLocalCopies });
    assert.equal(result.ok, true);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].command, installedExecutable);
    assert.equal(spawns[0].options.shell, false);
});

test("Doctor's diagnostics action reports an error when PATH has no CLI", async () => {
    const { result, spawns } = await runDiagnostics({ env: {}, files: withLocalCopies });
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.equal(spawns.length, 0);
});

test("Doctor reveals paths with the Explorer in the Windows directory", async () => {
    const { result, spawns } = await revealPath({ env: { SystemRoot: "D:\\Windows" }, files: file(revealed) });
    assert.equal(result.ok, true);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].command, "D:\\Windows\\explorer.exe");
});

for (const SystemRoot of [undefined, "Windows"]) {
    test(`Doctor reports an error instead of searching for Explorer when SystemRoot is ${SystemRoot ?? "unset"}`, async () => {
        const { result, spawns } = await revealPath({ env: { SystemRoot }, files: file(revealed) });
        assert.equal(result.ok, false);
        assert.ok(result.error);
        assert.equal(spawns.length, 0);
    });
}
