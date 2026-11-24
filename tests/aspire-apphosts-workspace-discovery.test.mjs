import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { watch } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
    createWorkspaceDiscoveryCache,
    isAppHostDiscoveryInput,
} from "../extensions/aspire-apphosts/lib/workspace-discovery.mjs";

// Real-watch tests change only workspace-root entries, so they also cover platforms where the
// cache watches just the root. They skip on runtimes without recursive fs.watch.
const recursiveWatchSkip = (() => {
    try {
        watch(tmpdir(), { recursive: true, persistent: false }).close();
        return false;
    } catch {
        return "recursive fs.watch is unavailable";
    }
})();

function fakeWatch() {
    const watchers = [];
    const watch = (directory, options, listener) => {
        const watcher = Object.assign(new EventEmitter(), {
            directory,
            options,
            listener,
            closed: false,
            close() { this.closed = true; },
        });
        watchers.push(watcher);
        return watcher;
    };
    return { watch, watchers };
}

const missing = async () => { throw Object.assign(new Error("not found"), { code: "ENOENT" }); };

function counter(value = { candidates: [] }, cacheable = true) {
    const load = async () => {
        load.calls += 1;
        return { value, cacheable };
    };
    load.calls = 0;
    return load;
}

test("only AppHost discovery inputs invalidate cached ls results", () => {
    for (const name of ["src/Api/Api.csproj", "AppHost.fsproj", "apphost.ts", "nested\\AppHost.java", "aspire.config.json", ".aspire/settings.json", null]) {
        assert.equal(isAppHostDiscoveryInput(name), true, String(name));
    }
    for (const name of ["obj/project.assets.json", "obj/Debug/AppHost.csproj", "bin", "src/index.ts", "settings.json", "node_modules/pkg/apphost.js", ".git/index"]) {
        assert.equal(isAppHostDiscoveryInput(name), false, name);
    }
});

test("panels on one workspace share a cached ls result until an AppHost file changes", async () => {
    const { watch, watchers } = fakeWatch();
    const cache = createWorkspaceDiscoveryCache({ recursiveWatch: true, watch, debounceMs: 5 });
    const changes = [];
    cache.acquire("a", "/repo", () => changes.push("a"));
    cache.acquire("b", "/repo", () => changes.push("b"));
    const load = counter();

    await Promise.all([cache.get("a", load), cache.get("b", load)]);
    await cache.get("a", load);
    assert.equal(load.calls, 1);
    assert.equal(watchers.filter((watcher) => watcher.options.recursive).length, 1);

    watchers[0].listener("change", "src/readme.md");
    await cache.get("b", load);
    assert.equal(load.calls, 1);

    watchers[0].listener("change", "src/AppHost/AppHost.csproj");
    await cache.get("b", load);
    assert.equal(load.calls, 2);
    await delay(20);
    assert.deepEqual(changes.sort(), ["a", "b"]);
});

test("forced refreshes and uncacheable failures rerun ls", async () => {
    const { watch } = fakeWatch();
    const cache = createWorkspaceDiscoveryCache({ recursiveWatch: true, watch });
    cache.acquire("a", "/repo", () => {});
    const load = counter();
    await cache.get("a", load);
    await cache.get("a", load, { force: true });
    assert.equal(load.calls, 2);

    const failing = counter({ candidates: [] }, false);
    await cache.get("a", failing, { force: true });
    await cache.get("a", failing);
    assert.equal(failing.calls, 2);
});

test("a change during an in-flight ls discards that result", async () => {
    const { watch, watchers } = fakeWatch();
    const cache = createWorkspaceDiscoveryCache({ recursiveWatch: true, watch });
    cache.acquire("a", "/repo", () => {});
    let release;
    let calls = 0;
    const load = () => {
        calls += 1;
        if (calls === 1) return new Promise((resolveLoad) => { release = () => resolveLoad({ value: "old", cacheable: true }); });
        return Promise.resolve({ value: "new", cacheable: true });
    };
    const pending = cache.get("a", load);
    watchers[0].listener("rename", "apphost.ts");
    release();
    assert.equal(await pending, "old");
    assert.equal(await cache.get("a", load), "new");
    assert.equal(calls, 2);
});

test("changes during an in-flight ls queue one replacement instead of a concurrent ls", async () => {
    const { watch, watchers } = fakeWatch();
    const cache = createWorkspaceDiscoveryCache({ recursiveWatch: true, watch });
    cache.acquire("a", "/repo", () => {});
    cache.acquire("b", "/repo", () => {});
    const releases = [];
    let running = 0;
    let maxRunning = 0;
    const load = () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        return new Promise((resolveLoad) => {
            releases.push(() => {
                running -= 1;
                resolveLoad({ value: `v${releases.length}`, cacheable: true });
            });
        });
    };
    const first = cache.get("a", load);
    watchers[0].listener("change", "apphost.ts");
    const queued = [cache.get("a", load), cache.get("b", load)];
    watchers[0].listener("change", "AppHost.csproj");
    queued.push(cache.get("b", load), cache.get("a", load, { force: true }));
    await delay(5);
    assert.equal(releases.length, 1);

    releases[0]();
    assert.equal(await first, "v1");
    await delay(5);
    assert.equal(releases.length, 2);
    releases[1]();
    assert.deepEqual(await Promise.all(queued), ["v2", "v2", "v2", "v2"]);
    assert.equal(await cache.get("b", load), "v2");
    assert.equal(maxRunning, 1);
});

test("a queued ls loads the cached workspace even after the owner that queued it moves", async () => {
    const { watch, watchers } = fakeWatch();
    const cache = createWorkspaceDiscoveryCache({ recursiveWatch: true, watch, debounceMs: 0 });
    const changes = [];
    cache.acquire("a", "/one", () => changes.push("a"));
    cache.acquire("b", "/one", () => changes.push("b"));
    const one = watchers.find((watcher) => watcher.directory === "/one");
    const releases = [];
    const directories = [];
    const load = (directory) => {
        directories.push(directory);
        return new Promise((resolveLoad) => {
            releases.push(() => resolveLoad({ value: directory, cacheable: true, paths: [] }));
        });
    };

    const first = cache.get("b", load);
    one.listener("change", "apphost.ts");
    const queued = cache.get("a", load);
    cache.acquire("a", "/two", () => changes.push("a"));
    const two = watchers.find((watcher) => watcher.directory === "/two");
    assert.ok(two, "the moved owner watches its new workspace");
    assert.equal(one.closed, false, "the remaining owner keeps the old workspace watched");

    releases[0]();
    assert.equal(await first, "/one");
    await delay(5);
    releases[1]();
    assert.equal(await queued, "/one");
    assert.deepEqual(directories, ["/one", "/one"]);
    assert.equal(await cache.get("b", load), "/one", "the queued result is cached for its own workspace");
    const moved = cache.get("a", load);
    releases[2]();
    assert.equal(await moved, "/two");

    await delay(5);
    changes.length = 0;
    one.listener("change", "apphost.ts");
    await delay(5);
    assert.deepEqual(changes, ["b"], "only owners still on the workspace are notified");
    cache.release("b");
    assert.equal(one.closed, true);
    assert.equal(two.closed, false);
    cache.release("a");
    assert.equal(cache.size, 0);
});

test("removing a path invalidates discovery only when the cached result depends on it", async () => {
    const { watch, watchers } = fakeWatch();
    const cache = createWorkspaceDiscoveryCache({ recursiveWatch: true, watch, stat: missing });
    cache.acquire("a", "/repo", () => {});
    let calls = 0;
    const load = async () => {
        calls += 1;
        return { value: calls, cacheable: true, paths: [join("/repo", "src", "AppHost", "AppHost.csproj")] };
    };
    await cache.get("a", load);
    for (const name of ["docs", join("src", "App"), join("src", "AppHost", "obsolete")]) {
        watchers[0].listener("rename", name);
        await delay(0);
        await cache.get("a", load);
        assert.equal(calls, 1, `removing ${name} must not rerun ls`);
    }
    watchers[0].listener("rename", "src");
    await delay(0);
    await cache.get("a", load);
    assert.equal(calls, 2, "removing a directory that contains a discovered AppHost reruns ls");
    cache.release("a");
});

test("removing a path while ls runs discards a result that depends on it", async () => {
    const { watch, watchers } = fakeWatch();
    const cache = createWorkspaceDiscoveryCache({ recursiveWatch: true, watch, stat: missing, debounceMs: 0 });
    let changes = 0;
    cache.acquire("a", "/repo", () => { changes++; });
    const releases = [];
    const load = () => new Promise((resolveLoad) => {
        const value = releases.length + 1;
        releases.push(() => resolveLoad({ value, cacheable: true, paths: [join("/repo", "src", "AppHost.cs")] }));
    });

    const first = cache.get("a", load);
    watchers[0].listener("rename", "docs");
    await delay(0);
    releases[0]();
    assert.equal(await first, 1);
    assert.equal(await cache.get("a", load), 1, "an unrelated removal keeps the result cacheable");

    const second = cache.get("a", load, { force: true });
    watchers[0].listener("rename", "src");
    await delay(0);
    releases[1]();
    assert.equal(await second, 2);
    await delay(5);
    assert.equal(changes, 1, "owners refresh after a dependent removal");
    const third = cache.get("a", load);
    assert.equal(releases.length, 3, "the discarded result is not reused");
    releases[2]();
    assert.equal(await third, 3);
    cache.release("a");
});

test("changes inside ignored directories never invalidate discovery", async () => {
    const { watch, watchers } = fakeWatch();
    let stats = 0;
    const cache = createWorkspaceDiscoveryCache({
        recursiveWatch: true,
        watch,
        ignoredDirectories: [join("/repo", "logs")],
        stat: async (path) => { stats++; return missing(path); },
    });
    cache.acquire("a", "/repo", () => {});
    const load = counter();
    await cache.get("a", load);
    watchers[0].listener("rename", "logs");
    watchers[0].listener("rename", join("logs", "run.log"));
    watchers[0].listener("change", join("logs", "nested", "apphost.ts"));
    await delay(0);
    await cache.get("a", load);
    assert.equal(load.calls, 1);
    assert.equal(stats, 0);
    watchers[0].listener("rename", "logs-old");
    await delay(0);
    await cache.get("a", load);
    assert.equal(load.calls, 2, "a sibling of an ignored directory is still watched");
    cache.release("a");
});

test("unexpected stat failures refresh discovery and warn once per workspace", async () => {
    const { watch, watchers } = fakeWatch();
    const logs = [];
    const cache = createWorkspaceDiscoveryCache({
        recursiveWatch: true,
        watch,
        log: (message) => logs.push(message),
        stat: async () => { throw Object.assign(new Error("access denied"), { code: "EACCES" }); },
    });
    cache.acquire("a", "/repo", () => {});
    const load = counter();
    for (let i = 0; i < 2; i++) {
        await cache.get("a", load);
        watchers[0].listener("rename", `entry-${i}`);
        await delay(0);
    }
    await cache.get("a", load);
    assert.equal(load.calls, 3);
    assert.equal(logs.filter((message) => /Unable to inspect/.test(message)).length, 1);
    cache.release("a");
});

test("an unwatchable parent directory keeps the workspace watcher but expires results", async () => {
    const watchers = [];
    const logs = [];
    let time = 0;
    const cache = createWorkspaceDiscoveryCache({
        recursiveWatch: true,
        fallbackTtlMs: 100,
        maxAgeMs: 1_000,
        now: () => time,
        log: (message) => logs.push(message),
        watch: (directory, options, listener) => {
            if (!options.recursive) throw new Error("denied");
            const watcher = Object.assign(new EventEmitter(), { directory, options, listener, closed: false, close() { this.closed = true; } });
            watchers.push(watcher);
            return watcher;
        },
    });
    cache.acquire("a", join(tmpdir(), "outer", "repo"), () => {});
    assert.equal(watchers.length, 1);
    assert.equal(logs.filter((message) => /Parent aspire\.config\.json/.test(message)).length, 1);
    const load = counter();
    await cache.get("a", load);
    watchers[0].listener("change", "apphost.ts");
    await cache.get("a", load);
    assert.equal(load.calls, 2, "the workspace watcher still reports changes");
    time = 150;
    await cache.get("a", load);
    assert.equal(load.calls, 3, "results expire on the fallback ttl");
    cache.release("a");
    assert.equal(watchers[0].closed, true);
});

test("directory renames invalidate discovery without treating existing unrelated files as directories", async () => {
    const { watch, watchers } = fakeWatch();
    const cache = createWorkspaceDiscoveryCache({
        recursiveWatch: true,
        watch,
        stat: async (path) => {
            if (path.endsWith("deleted")) throw Object.assign(new Error("not found"), { code: "ENOENT" });
            return { isDirectory: () => path.endsWith("incoming") };
        },
    });
    cache.acquire("a", "/repo", () => {});
    const load = counter();
    await cache.get("a", load);
    watchers[0].listener("rename", "notes.txt");
    await delay(0);
    await cache.get("a", load);
    assert.equal(load.calls, 1);
    watchers[0].listener("rename", "incoming");
    await delay(0);
    await cache.get("a", load);
    assert.equal(load.calls, 2);
    watchers[0].listener("rename", "deleted");
    await delay(0);
    await cache.get("a", load);
    assert.equal(load.calls, 3);
    cache.release("a");
});

test("ancestor aspire.config.json changes invalidate discovery and ancestor watchers close on release", async () => {
    const { watch, watchers } = fakeWatch();
    const cache = createWorkspaceDiscoveryCache({ recursiveWatch: true, watch, debounceMs: 5 });
    const workspace = join(tmpdir(), "outer", "inner", "repo");
    let changes = 0;
    cache.acquire("a", workspace, () => { changes++; });
    const ancestors = watchers.filter((watcher) => !watcher.options.recursive);
    assert.ok(ancestors.some((watcher) => watcher.directory === join(tmpdir(), "outer", "inner")));
    assert.ok(ancestors.length <= 9);
    const load = counter();
    await cache.get("a", load);

    ancestors[0].listener("change", "README.md");
    await cache.get("a", load);
    assert.equal(load.calls, 1);

    ancestors[0].listener("change", "Aspire.Config.json");
    await cache.get("a", load);
    assert.equal(load.calls, 2);
    await delay(20);
    assert.equal(changes, 1);

    ancestors[1].emit("error", new Error("gone"));
    assert.ok(watchers.every((watcher) => watcher.closed));
    await cache.get("a", load);
    assert.equal(load.calls, 3, "a watcher error discards the cached result");
    cache.release("a");
    assert.equal(cache.size, 0);
});

test("the last owner stops watching, and watch failures fall back to a ttl", async () => {
    const { watch, watchers } = fakeWatch();
    const cache = createWorkspaceDiscoveryCache({ recursiveWatch: true, watch });
    cache.acquire("a", "/repo", () => {});
    cache.acquire("b", "/repo", () => {});
    cache.release("a");
    assert.equal(watchers[0].closed, false);
    cache.release("b");
    assert.ok(watchers.every((watcher) => watcher.closed));
    assert.equal(cache.size, 0);

    let time = 0;
    const failing = createWorkspaceDiscoveryCache({
        watch: () => { throw new Error("unsupported"); },
        fallbackTtlMs: 100,
        now: () => time,
    });
    failing.acquire("a", "/repo", () => {});
    const load = counter();
    await failing.get("a", load);
    time = 50;
    await failing.get("a", load);
    assert.equal(load.calls, 1);
    time = 150;
    await failing.get("a", load);
    assert.equal(load.calls, 2);
});

test("without native recursive watching, only the workspace root is watched and results expire", async () => {
    const { watch, watchers } = fakeWatch();
    let time = 0;
    const cache = createWorkspaceDiscoveryCache({ recursiveWatch: false, watch, fallbackTtlMs: 100, now: () => time });
    cache.acquire("a", "/repo", () => {});
    assert.ok(watchers.every((watcher) => !watcher.options.recursive));
    assert.equal(watchers[0].directory, "/repo");
    const load = counter();
    await cache.get("a", load);
    watchers[0].listener("rename", "apphost.ts");
    await cache.get("a", load);
    assert.equal(load.calls, 2);
    time = 50;
    await cache.get("a", load);
    assert.equal(load.calls, 2);
    time = 150;
    await cache.get("a", load);
    assert.equal(load.calls, 3);
    cache.release("a");
});

test("recursively watched results still expire after the maximum age", async () => {
    const { watch } = fakeWatch();
    let time = 0;
    const cache = createWorkspaceDiscoveryCache({ recursiveWatch: true, watch, fallbackTtlMs: 10, maxAgeMs: 100, now: () => time });
    cache.acquire("a", "/repo", () => {});
    const load = counter();
    await cache.get("a", load);
    time = 50;
    await cache.get("a", load);
    assert.equal(load.calls, 1);
    time = 150;
    await cache.get("a", load);
    assert.equal(load.calls, 2);
    cache.release("a");
});

test("real file watching invalidates when an AppHost is added", { skip: recursiveWatchSkip }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "apphost-discovery-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const cache = createWorkspaceDiscoveryCache({ debounceMs: 10 });
    let changed = false;
    cache.acquire("a", directory, () => { changed = true; });
    t.after(() => cache.release("a"));
    const load = counter();
    await cache.get("a", load);
    await delay(100);
    await writeFile(join(directory, "apphost.ts"), "// AppHost\n");
    const deadline = Date.now() + 5_000;
    while (!changed) {
        assert.ok(Date.now() < deadline, "timed out waiting for the watcher");
        await delay(20);
    }
    await cache.get("a", load);
    assert.equal(load.calls, 2);
});

test("real file watching invalidates when a directory containing an AppHost is moved", { skip: recursiveWatchSkip }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "apphost-discovery-move-"));
    const workspace = join(root, "workspace");
    const incoming = join(root, "incoming");
    await mkdir(workspace);
    await mkdir(incoming);
    await writeFile(join(incoming, "AppHost.cs"), "// AppHost\n");
    const cache = createWorkspaceDiscoveryCache({ debounceMs: 10 });
    let changes = 0;
    cache.acquire("a", workspace, () => { changes++; });
    t.after(async () => { cache.release("a"); await rm(root, { recursive: true, force: true }); });
    let loads = 0;
    const load = async () => {
        loads += 1;
        return { value: loads, cacheable: true, paths: [join(workspace, "incoming", "AppHost.cs")] };
    };
    await cache.get("a", load);
    await rename(incoming, join(workspace, "incoming"));
    const deadline = Date.now() + 5_000;
    while (!changes) {
        assert.ok(Date.now() < deadline, "timed out waiting for the directory rename");
        await delay(20);
    }
    await cache.get("a", load);
    assert.equal(loads, 2);
    await rename(join(workspace, "incoming"), join(root, "outgoing"));
    while (changes < 2) {
        assert.ok(Date.now() < deadline, "timed out waiting for the directory removal");
        await delay(20);
    }
    await cache.get("a", load);
    assert.equal(loads, 3);
});
