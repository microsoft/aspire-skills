import { watch as fsWatch } from "node:fs";
import { stat as fsStat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathKey } from "./app-model.mjs";

const ANCESTOR_CONFIG_DEPTH = 9;

const APPHOST_FILE_NAMES = new Set([
    "apphost.cs",
    "apphost.ts",
    "apphost.mts",
    "apphost.cts",
    "apphost.js",
    "apphost.mjs",
    "apphost.cjs",
    "apphost.rs",
    "apphost.go",
    "apphost.java",
    "aspire.config.json",
]);
const PROJECT_EXTENSIONS = [".csproj", ".fsproj", ".vbproj"];
const IGNORED_SEGMENTS = new Set([".git", "node_modules", "bin", "obj"]);

function pathSegments(filename) {
    return String(filename).toLowerCase().split(/[\\/]+/).filter(Boolean);
}

function ignoredPath(filename) {
    return pathSegments(filename).some((segment) => IGNORED_SEGMENTS.has(segment));
}

export function isAppHostDiscoveryInput(filename) {
    // Some platforms omit the file name; treat that as a possible change.
    if (!filename) return true;
    const segments = pathSegments(filename);
    if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return false;
    const name = segments.at(-1) ?? "";
    if (APPHOST_FILE_NAMES.has(name) || PROJECT_EXTENSIONS.some((extension) => name.endsWith(extension))) {
        return true;
    }
    return name === "settings.json" && segments.at(-2) === ".aspire";
}

function ancestorDirectories(directory) {
    const ancestors = [];
    let current = resolve(directory);
    for (let depth = 0; depth < ANCESTOR_CONFIG_DEPTH; depth++) {
        const parent = dirname(current);
        if (parent === current) break;
        ancestors.push(parent);
        current = parent;
    }
    return ancestors;
}

// Node watches recursively with native APIs only on Windows and macOS. Elsewhere it walks the
// whole tree synchronously and opens one watcher per entry, so only the workspace root is watched.
const NATIVE_RECURSIVE_WATCH = process.platform === "win32" || process.platform === "darwin";

/**
 * Caches workspace AppHost discovery per directory, shared by every owner of that directory.
 * Cached results stay valid until a watched AppHost input changes, a caller forces a reload,
 * or `maxAgeMs` passes. When the workspace cannot be watched recursively, cached results
 * expire after `fallbackTtlMs` instead.
 */
export function createWorkspaceDiscoveryCache({
    watch = fsWatch,
    stat = fsStat,
    recursiveWatch = NATIVE_RECURSIVE_WATCH,
    debounceMs = 750,
    fallbackTtlMs = 5 * 60_000,
    maxAgeMs = 15 * 60_000,
    now = Date.now,
    log = () => {},
} = {}) {
    const workspaces = new Map();
    const owners = new Map();

    function invalidate(workspace) {
        workspace.version += 1;
        workspace.cached = null;
    }

    function stopWatcher(workspace, error) {
        for (const watcher of [workspace.watcher, ...workspace.ancestorWatchers]) {
            try {
                watcher?.close();
            } catch {
                // The watcher may already be closed.
            }
        }
        workspace.watcher = null;
        workspace.ancestorWatchers = [];
        if (error) {
            workspace.watchComplete = false;
            log(`AppHost file watching is unavailable (${error.message ?? error}); rechecking periodically.`, "warning");
        }
    }

    function notifyOwners(workspace) {
        if (workspace.timer) clearTimeout(workspace.timer);
        workspace.timer = setTimeout(() => {
            workspace.timer = null;
            for (const onChange of workspace.owners.values()) {
                try {
                    onChange();
                } catch {
                    // One owner's failure must not stop notifications for the others.
                }
            }
        }, debounceMs);
        workspace.timer.unref?.();
    }

    function startWatcher(workspace) {
        const changed = () => {
            if (workspaces.get(workspace.key) !== workspace) return;
            invalidate(workspace);
            notifyOwners(workspace);
        };
        const onError = (error) => {
            if (workspaces.get(workspace.key) === workspace) stopWatcher(workspace, error);
        };
        try {
            const watcher = watch(workspace.directory, { recursive: recursiveWatch, persistent: false }, (event, filename) => {
                if (workspaces.get(workspace.key) !== workspace || (filename && ignoredPath(filename))) return;
                if (isAppHostDiscoveryInput(filename)) {
                    changed();
                } else if (event === "rename") {
                    void stat(join(workspace.directory, String(filename))).then(
                        (info) => { if (info.isDirectory()) changed(); },
                        (error) => {
                            if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
                                log(`Unable to inspect an AppHost workspace change (${error.message ?? error}); refreshing discovery.`, "warning");
                            }
                            // A removed directory cannot be distinguished from a removed file.
                            changed();
                        },
                    );
                }
            });
            watcher.on?.("error", onError);
            workspace.watcher = watcher;
            workspace.watchComplete = recursiveWatch;
            for (const directory of ancestorDirectories(workspace.directory)) {
                const ancestor = watch(directory, { persistent: false }, (_event, filename) => {
                    if (!filename || basename(String(filename)).toLowerCase() === "aspire.config.json") changed();
                });
                ancestor.on?.("error", onError);
                workspace.ancestorWatchers.push(ancestor);
            }
        } catch (error) {
            stopWatcher(workspace, error);
        }
    }

    function acquire(owner, directory, onChange) {
        const key = pathKey(directory);
        const current = owners.get(owner);
        if (current?.key === key) {
            current.owners.set(owner, onChange);
            return;
        }
        if (current) release(owner);
        let workspace = workspaces.get(key);
        if (!workspace) {
            workspace = {
                key,
                directory,
                owners: new Map(),
                version: 0,
                cached: null,
                inflight: null,
                watcher: null,
                ancestorWatchers: [],
                watchComplete: false,
                timer: null,
            };
            workspaces.set(key, workspace);
            startWatcher(workspace);
        }
        workspace.owners.set(owner, onChange);
        owners.set(owner, workspace);
    }

    function release(owner) {
        const workspace = owners.get(owner);
        if (!workspace) return;
        owners.delete(owner);
        workspace.owners.delete(owner);
        if (workspace.owners.size) return;
        workspaces.delete(workspace.key);
        if (workspace.timer) clearTimeout(workspace.timer);
        workspace.timer = null;
        stopWatcher(workspace);
        invalidate(workspace);
    }

    function isFresh(workspace) {
        // A watcher can start and never report changes (for example, on network shares), so
        // watched results also expire.
        return Boolean(workspace.cached)
            && now() - workspace.cached.loadedAt < (workspace.watchComplete ? maxAgeMs : fallbackTtlMs);
    }

    /**
     * Returns the cached discovery value for the owner's workspace, or calls `load`.
     * `load` resolves to `{ value, cacheable }`; only cacheable results are reused.
     */
    async function get(owner, load, { force = false } = {}) {
        const workspace = owners.get(owner);
        if (!workspace) return (await load()).value;
        if (force) invalidate(workspace);
        if (isFresh(workspace)) return workspace.cached.value;
        const current = workspace.inflight;
        // A queued load has not read the workspace yet, so it still reflects the latest change.
        if (current && (!current.started || current.version === workspace.version)) return current.promise;

        // Let a stale load finish for its callers rather than running a second `aspire ls`
        // beside it; the replacement starts once it settles.
        const entry = { version: workspace.version, started: false, promise: null };
        const promise = (async () => {
            if (current) await current.promise.catch(() => {});
            entry.started = true;
            const version = entry.version = workspace.version;
            const result = await load();
            if (result.cacheable && workspace.version === version && workspaces.get(workspace.key) === workspace) {
                workspace.cached = { value: result.value, loadedAt: now() };
            }
            return result.value;
        })();
        entry.promise = promise;
        workspace.inflight = entry;
        try {
            return await promise;
        } finally {
            if (workspace.inflight?.promise === promise) workspace.inflight = null;
        }
    }

    return {
        acquire,
        release,
        get,
        get size() {
            return workspaces.size;
        },
    };
}
