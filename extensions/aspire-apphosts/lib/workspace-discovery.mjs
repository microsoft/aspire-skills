import { watch as fsWatch } from "node:fs";
import { stat as fsStat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
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

function isSameOrWithinKey(childKey, parentKey) {
    return childKey === parentKey || childKey.startsWith(parentKey.endsWith(sep) ? parentKey : parentKey + sep);
}

// Results that do not report their paths are treated as depending on every path.
function dependsOnRemoved(paths, removedKey) {
    return !Array.isArray(paths) || paths.some((path) => isSameOrWithinKey(pathKey(path), removedKey));
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
 * Cached results stay valid until a watched AppHost input changes, a path they depend on is
 * removed, a caller forces a reload, or `maxAgeMs` passes. When the workspace cannot be fully
 * watched, cached results expire after `fallbackTtlMs` instead. Changes inside
 * `ignoredDirectories` are never reported.
 */
export function createWorkspaceDiscoveryCache({
    watch = fsWatch,
    stat = fsStat,
    recursiveWatch = NATIVE_RECURSIVE_WATCH,
    debounceMs = 750,
    fallbackTtlMs = 5 * 60_000,
    maxAgeMs = 15 * 60_000,
    ignoredDirectories = [],
    now = Date.now,
    log = () => {},
} = {}) {
    const workspaces = new Map();
    const owners = new Map();
    const ignoredKeys = ignoredDirectories.filter(Boolean).map(pathKey);

    function isIgnoredDirectoryPath(path) {
        if (!ignoredKeys.length) return false;
        const key = pathKey(path);
        return ignoredKeys.some((ignored) => isSameOrWithinKey(key, ignored));
    }

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
        const active = () => workspaces.get(workspace.key) === workspace;
        const changed = () => {
            if (!active()) return;
            invalidate(workspace);
            notifyOwners(workspace);
        };
        const removed = (path) => {
            if (!active()) return;
            const removedKey = pathKey(path);
            if (workspace.loading) workspace.loading.removed.push(removedKey);
            if (workspace.cached && dependsOnRemoved(workspace.cached.paths, removedKey)) changed();
        };
        const onError = (error) => {
            if (!active()) return;
            stopWatcher(workspace, error);
            // Changes may have been missed before the error, so the cached result is no longer trusted.
            invalidate(workspace);
        };
        try {
            const watcher = watch(workspace.directory, { recursive: recursiveWatch, persistent: false }, (event, filename) => {
                if (!active() || (filename && ignoredPath(filename))) return;
                const path = filename ? join(workspace.directory, String(filename)) : null;
                if (path && isIgnoredDirectoryPath(path)) return;
                if (isAppHostDiscoveryInput(filename)) {
                    changed();
                } else if (event === "rename") {
                    void stat(path).then(
                        // A new directory may have been moved in with AppHosts inside it.
                        (info) => { if (info.isDirectory()) changed(); },
                        (error) => {
                            if (error.code === "ENOENT" || error.code === "ENOTDIR") {
                                removed(path);
                                return;
                            }
                            if (!workspace.statWarned) {
                                workspace.statWarned = true;
                                log(`Unable to inspect an AppHost workspace change (${error.message ?? error}); refreshing discovery.`, "warning");
                            }
                            changed();
                        },
                    );
                }
            });
            watcher.on?.("error", onError);
            workspace.watcher = watcher;
            workspace.watchComplete = recursiveWatch;
        } catch (error) {
            stopWatcher(workspace, error);
            return;
        }
        let ancestorError = null;
        for (const directory of ancestorDirectories(workspace.directory)) {
            try {
                const ancestor = watch(directory, { persistent: false }, (_event, filename) => {
                    if (!filename || basename(String(filename)).toLowerCase() === "aspire.config.json") changed();
                });
                ancestor.on?.("error", onError);
                workspace.ancestorWatchers.push(ancestor);
            } catch (error) {
                ancestorError ??= error;
            }
        }
        if (ancestorError) {
            workspace.watchComplete = false;
            log(`Parent aspire.config.json files cannot be watched (${ancestorError.message ?? ancestorError}); rechecking periodically.`, "warning");
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
                loading: null,
                watcher: null,
                ancestorWatchers: [],
                watchComplete: false,
                statWarned: false,
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
     * Returns the cached discovery value for the owner's workspace, or calls `load` with the
     * workspace directory (or with no argument when the owner has no workspace). `load` resolves
     * to `{ value, cacheable, paths }`; only cacheable results are reused. `paths` lists the
     * files the value depends on: removing one of them, or a directory that contains one,
     * invalidates the value. Without `paths`, any removal does.
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
        const entry = { version: workspace.version, started: false, promise: null, removed: [] };
        const promise = (async () => {
            if (current) await current.promise.catch(() => {});
            entry.started = true;
            const version = entry.version = workspace.version;
            workspace.loading = entry;
            let result;
            try {
                result = await load(workspace.directory);
            } finally {
                if (workspace.loading === entry) workspace.loading = null;
            }
            const stillCurrent = workspaces.get(workspace.key) === workspace && workspace.version === version;
            if (entry.removed.some((removedKey) => dependsOnRemoved(result.paths, removedKey))) {
                // The load may have read a path that was removed while it ran.
                if (stillCurrent) {
                    invalidate(workspace);
                    notifyOwners(workspace);
                }
            } else if (result.cacheable && stillCurrent) {
                workspace.cached = { value: result.value, paths: result.paths, loadedAt: now() };
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
