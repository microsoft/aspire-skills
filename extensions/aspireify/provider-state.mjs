import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";

const STORE_VERSION = 1;

export function appHostIdentity(value, options = {}) {
    const platform = options.platform ?? process.platform;
    const pathApi = platform === "win32" ? win32 : posix;
    const rawPath = String(value ?? "").trim();
    if (!rawPath) {
        return { appHostPath: "", domainId: "default" };
    }

    const cwd = options.cwd ?? process.cwd();
    const normalizedInput = normalizePathSeparators(rawPath, platform);
    const appHostPath = trimTrailingSeparator(pathApi.resolve(cwd, normalizedInput), pathApi);
    return {
        appHostPath,
        domainId: platform === "win32" ? appHostPath.toLowerCase() : appHostPath,
    };
}

export async function resolveAppHostIdentity(value, options = {}) {
    const identity = appHostIdentity(value, options);
    if (identity.domainId === "default") {
        return identity;
    }

    const realpathImpl = options.realpathImpl ?? realpath;
    let resolvedPath;
    try {
        resolvedPath = await realpathImpl(identity.appHostPath);
    } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
            return identity;
        }
        throw error;
    }
    return appHostIdentity(resolvedPath, options);
}

export function assignNonConflictingGeneratedEdgeIds(generatedEdges, preservedEdges) {
    const reservedIds = new Set(
        preservedEdges.map((edge) => String(edge?.id ?? "").trim()).filter(Boolean),
    );
    const assignedIds = new Set();
    return generatedEdges.map((edge, index) => {
        const baseId = String(edge?.id ?? "").trim() || `edge-${index + 1}`;
        let id = baseId;
        let suffix = 1;
        while (reservedIds.has(id) || assignedIds.has(id)) {
            id = `${baseId}-generated${suffix === 1 ? "" : `-${suffix}`}`;
            suffix += 1;
        }
        assignedIds.add(id);
        return id === edge.id ? edge : { ...edge, id };
    });
}

export function confirmedSnapshotForReadback(snapshot) {
    return snapshot?.confirmation ? structuredClone(snapshot.confirmation) : null;
}

export function scanTimeoutDelay(snapshot, timeoutMs, now = Date.now()) {
    if (snapshot?.scanStatus !== "scanning") {
        return null;
    }
    const updatedAt = Number.isFinite(snapshot.updatedAt) ? snapshot.updatedAt : now;
    return Math.max(0, timeoutMs - Math.max(0, now - updatedAt));
}

export async function persistSnapshotBeforeCommit(store, domainId, snapshot, commit) {
    if (!store?.available) {
        throw new Error("Durable Copilot session storage is unavailable.");
    }
    await store.save(domainId, snapshot);
    commit(snapshot);
}

export class DurableSnapshotStore {
    constructor(workspacePath) {
        this.root = workspacePath ? join(workspacePath, "files", "aspireify") : "";
        this.pendingWrites = new Map();
    }

    get available() {
        return Boolean(this.root);
    }

    async load(domainId) {
        if (!this.available) {
            return null;
        }
        let serialized;
        try {
            serialized = await readFile(this.filePath(domainId), "utf8");
        } catch (error) {
            if (error?.code === "ENOENT") {
                return null;
            }
            throw error;
        }
        const record = JSON.parse(serialized);
        if (
            record?.version !== STORE_VERSION ||
            record?.domainId !== domainId ||
            !record.snapshot ||
            typeof record.snapshot !== "object" ||
            Array.isArray(record.snapshot)
        ) {
            throw new Error("The persisted Aspireify proposal state is invalid.");
        }
        return record.snapshot;
    }

    save(domainId, snapshot) {
        if (!this.available) {
            return Promise.resolve();
        }
        const record = JSON.stringify(
            {
                version: STORE_VERSION,
                domainId,
                snapshot: structuredClone(snapshot),
            },
            null,
            2,
        );
        const previous = this.pendingWrites.get(domainId) ?? Promise.resolve();
        const write = previous
            .catch(() => {})
            .then(() => this.writeRecord(domainId, `${record}\n`));
        this.pendingWrites.set(domainId, write);
        const release = () => {
            if (this.pendingWrites.get(domainId) === write) {
                this.pendingWrites.delete(domainId);
            }
        };
        void write.then(release, release);
        return write;
    }

    async flush(domainId) {
        await this.pendingWrites.get(domainId);
    }

    filePath(domainId) {
        const name = createHash("sha256").update(domainId).digest("hex");
        return join(this.root, `${name}.json`);
    }

    async writeRecord(domainId, serialized) {
        const destination = this.filePath(domainId);
        const temporary = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
        await mkdir(dirname(destination), { recursive: true });
        try {
            await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
            await rename(temporary, destination);
        } catch (error) {
            await rm(temporary, { force: true }).catch(() => {});
            throw error;
        }
    }
}

function trimTrailingSeparator(value, pathApi) {
    const root = pathApi.parse(value).root;
    let result = value;
    while (result.length > root.length && result.endsWith(pathApi.sep)) {
        result = result.slice(0, -1);
    }
    return result;
}

function normalizePathSeparators(value, platform) {
    if (platform !== "win32") {
        return value.replace(/[\\/]+/g, "/");
    }
    const windowsPath = value.replace(/\//g, "\\");
    return windowsPath.startsWith("\\\\")
        ? `\\\\${windowsPath.slice(2).replace(/\\+/g, "\\")}`
        : windowsPath.replace(/\\+/g, "\\");
}
