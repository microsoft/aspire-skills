import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, linkSync, lstatSync, mkdirSync, openSync, readFileSync, closeSync, writeFileSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAspireCliCommand, pathKey, psRecordStatus } from "./app-model.mjs";

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_REPLAY_BYTES = 16 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 5_000;
const owners = new Map();

function privateDirectory(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()
        || (process.platform !== "win32" && (info.uid !== process.getuid() || (info.mode & 0o077)))) {
        throw new Error("The shared Aspire stream directory is not private.");
    }
}

function sharedSecret(directory) {
    privateDirectory(directory);
    const path = join(directory, "secret");
    const temporary = join(directory, `secret-${randomBytes(12).toString("hex")}.tmp`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
        writeFileSync(fd, randomBytes(32).toString("hex"));
    } finally {
        closeSync(fd);
    }
    try {
        // Publish a complete key without replacing a key won by another provider.
        try {
            linkSync(temporary, path);
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
        }
    } finally {
        unlinkSync(temporary);
    }
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()
        || (process.platform !== "win32" && (info.uid !== process.getuid() || (info.mode & 0o077)))) {
        throw new Error("The shared Aspire stream secret is not private.");
    }
    const secret = readFileSync(path, "utf8");
    if (!/^[a-f0-9]{64}$/.test(secret)) {
        throw new Error("The shared Aspire stream secret is invalid.");
    }
    return secret;
}

function proof(secret, value) {
    return createHmac("sha256", secret).update(value).digest("hex");
}

function matches(actual, expected) {
    if (typeof actual !== "string") return false;
    const left = Buffer.from(actual);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
}

function sendText(socket, text) {
    if (socket.destroyed) return;
    if (socket.writableLength > MAX_REPLAY_BYTES) {
        socket.destroy(new Error("Shared Aspire stream consumer is too slow."));
        return;
    }
    socket.write(`${text}\n`);
}

function send(socket, frame) {
    sendText(socket, JSON.stringify(frame));
}

function receive(socket, onFrame) {
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
        pending += chunk;
        let index;
        while ((index = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, index);
            pending = pending.slice(index + 1);
            if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
                socket.destroy(new Error("Shared Aspire stream frame is too large."));
                return;
            }
            try {
                onFrame(JSON.parse(line));
            } catch (error) {
                socket.destroy(error);
                return;
            }
        }
        if (Buffer.byteLength(pending) > MAX_FRAME_BYTES) {
            socket.destroy(new Error("Shared Aspire stream frame is too large."));
        }
    });
}

// Cache entries record the broker sequence that last changed them so authoritative
// reconciliation can keep updates that arrived after the subscriber's snapshot began.
function cacheSet(cache, key, text, seq, bytes) {
    bytes -= Buffer.byteLength(cache.get(key)?.text ?? "");
    if (text === null) cache.delete(key);
    else {
        cache.set(key, { text, seq });
        bytes += Buffer.byteLength(text);
    }
    return bytes;
}

function cacheLine(cache, line, kind, bytes, seq) {
    let value;
    try { value = JSON.parse(line); } catch { return bytes; }
    const set = (key, text) => { bytes = cacheSet(cache, key, text, seq, bytes); };
    if (kind === "ps") {
        const status = psRecordStatus(value);
        if (!status) return bytes;
        const key = pathKey(value.appHostPath);
        const stopped = status === "stopped";
        if (stopped && cache.has(key)
            && JSON.parse(cache.get(key).text).appHostPid !== value.appHostPid) return bytes;
        set(key, stopped ? null : line);
    } else {
        const resources = Array.isArray(value) ? value : value?.resources;
        if (Array.isArray(resources)) {
            cache.clear();
            bytes = 0;
        }
        for (const resource of Array.isArray(resources) ? resources : [value]) {
            if (typeof resource?.name === "string") {
                set(resource.name, JSON.stringify(resource));
            }
        }
    }
    return bytes;
}

function ownStream(endpoint, secret, kind, start) {
    if (owners.has(endpoint)) return Promise.resolve();
    return new Promise((resolveListen, rejectListen) => {
        const clients = new Set();
        const sockets = new Set();
        const cache = new Map();
        let handle;
        let stopped = false;
        let startupTimer;
        let cacheBytes = 0;
        let seq = 0;
        let reconciledSince = -1;
        const close = () => {
            stopped = true;
            clearTimeout(startupTimer);
            server.close();
            if (owners.get(endpoint) === stop) owners.delete(endpoint);
        };
        const stop = () => {
            if (stopped) return;
            stopped = true;
            handle?.kill();
            for (const socket of sockets) socket.destroy();
            close();
        };
        const finish = (result) => {
            if (stopped) return;
            for (const socket of clients) {
                send(socket, { exit: result });
                socket.end();
            }
            for (const socket of sockets) {
                if (!clients.has(socket)) socket.destroy();
            }
            // Let the exit frame drain before destroying subscriptions.
            close();
        };
        const overLimit = () => {
            if (cacheBytes <= MAX_REPLAY_BYTES) return false;
            replayOverflow();
            return true;
        };
        const replayOverflow = () => {
            finish({ code: null, error: "Shared Aspire stream replay exceeded its memory limit." });
            handle?.kill();
        };
        // An authoritative describe replaces cached resources for every subscriber. Entries
        // changed after `since` are newer than that snapshot and survive; snapshot entries
        // take `since` so a later-started snapshot can still remove them.
        const resetClient = (client) => {
            send(client, { reset: true });
            for (const entry of cache.values()) send(client, { line: entry.text, seq: entry.seq });
            send(client, { resetEnd: true, seq });
        };
        const reconcile = (since, entries, source) => {
            // A snapshot started before one already applied is older and could restore removed
            // resources. Drop it and resync only the sender, which already applied it locally.
            if (since < reconciledSince) {
                resetClient(source);
                return;
            }
            reconciledSince = since;
            const newer = [...cache].filter(([, entry]) => entry.seq > since);
            cache.clear();
            cacheBytes = 0;
            for (const [name, text] of entries) cacheBytes = cacheSet(cache, name, text, since, cacheBytes);
            for (const [name, entry] of newer) cacheBytes = cacheSet(cache, name, entry.text, entry.seq, cacheBytes);
            if (overLimit()) return;
            for (const client of clients) resetClient(client);
        };
        const server = createServer((socket) => {
            sockets.add(socket);
            socket.on("error", () => {});
            const nonce = randomBytes(32).toString("hex");
            let authenticated = false;
            // An authoritative snapshot arrives as begin, chunks, end so it is never limited
            // by a single frame; buffering stays within the replay bound.
            let pending = null;
            socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy());
            send(socket, { nonce, proof: proof(secret, `server:${nonce}`) });
            receive(socket, (frame) => {
                if (authenticated) {
                    if (kind !== "describe" || stopped || !clients.has(socket)) return;
                    const request = frame.reconcile;
                    if (request?.begin === true || request?.overflow === true) {
                        if (pending || !Number.isSafeInteger(request.since) || request.since < 0 || request.since > seq) {
                            throw new Error("Invalid shared Aspire stream reconciliation.");
                        }
                        // A snapshot that cannot be replayed must not leave stale replay behind.
                        if (request.overflow) return replayOverflow();
                        pending = { since: request.since, entries: [], bytes: 0 };
                    } else if (pending && Array.isArray(request?.chunk)) {
                        for (const resource of request.chunk) {
                            if (typeof resource?.name !== "string") continue;
                            const text = JSON.stringify(resource);
                            pending.bytes += Buffer.byteLength(text);
                            if (pending.bytes > MAX_REPLAY_BYTES) {
                                pending = null;
                                return replayOverflow();
                            }
                            pending.entries.push([resource.name, text]);
                        }
                    } else if (pending && request?.end === true) {
                        const { since, entries } = pending;
                        pending = null;
                        reconcile(since, entries, socket);
                    } else {
                        throw new Error("Invalid shared Aspire stream reconciliation.");
                    }
                    return;
                }
                if (!matches(frame.proof, proof(secret, `client:${nonce}`))) {
                    throw new Error("Shared Aspire stream authentication failed.");
                }
                authenticated = true;
                socket.setTimeout(0);
                if (stopped) return socket.end();
                clearTimeout(startupTimer);
                clients.add(socket);
                for (const entry of cache.values()) send(socket, { line: entry.text, seq: entry.seq });
                if (!handle) {
                    handle = start({
                        onLine(line) {
                            if (stopped) return;
                            seq += 1;
                            cacheBytes = cacheLine(cache, line, kind, cacheBytes, seq);
                            if (overLimit()) return;
                            for (const client of clients) send(client, { line, seq });
                        },
                        onExit: finish,
                    });
                    if (stopped) handle.kill();
                }
                send(socket, { ready: true, seq });
            });
            socket.once("close", () => {
                sockets.delete(socket);
                clients.delete(socket);
                if (!stopped && clients.size === 0 && (handle || sockets.size === 0)) stop();
            });
        });
        server.once("error", rejectListen);
        server.listen(endpoint, () => {
            server.off("error", rejectListen);
            server.on("error", (error) => {
                finish({ code: null, error: `Shared Aspire stream listener failed: ${error.code ?? "unknown error"}.` });
                handle?.kill();
            });
            owners.set(endpoint, stop);
            startupTimer = setTimeout(stop, CONNECT_TIMEOUT_MS);
            startupTimer.unref?.();
            resolveListen();
        });
    });
}

// Each provider can own a broker. Other sessions subscribe over authenticated local IPC;
// no daemon, command execution endpoint, or renderer-visible discovery data is needed.
export function shareCliStream({
    identity,
    kind,
    start,
    onLine,
    onExit,
    onReady,
    directory = process.platform === "win32"
        ? join(homedir(), ".aspire", "canvas-streams")
        : join(tmpdir(), `ac-${process.getuid()}`),
}) {
    let socket;
    let killed = false;
    let finished = false;
    let retryTimer;
    let ready = false;
    let lastSeq = 0;
    let resetResources = null;
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    const finish = (result) => {
        if (finished) return;
        finished = true;
        clearTimeout(retryTimer);
        socket?.destroy();
        onExit?.(result);
    };
    const retry = () => {
        if (killed || finished) return;
        if (Date.now() >= deadline) {
            finish({ code: null, error: "Timed out connecting to the shared Aspire stream." });
            return;
        }
        retryTimer = setTimeout(connect, 25);
        retryTimer.unref?.();
    };
    const connect = () => {
        if (killed || finished) return;
        let secret;
        let endpoint;
        let socketInfo;
        try {
            secret = sharedSecret(directory);
            const key = createHash("sha256").update(`v1\0${secret}\0${identity}`).digest("hex").slice(0, 32);
            endpoint = process.platform === "win32"
                ? `\\\\.\\pipe\\aspire-canvas-${key}`
                : join(directory, `${key}.sock`);
            if (process.platform !== "win32") {
                try { socketInfo = lstatSync(endpoint); } catch (error) {
                    if (error.code !== "ENOENT") throw error;
                }
            }
        } catch (error) {
            if (error.code === "EAGAIN") return retry();
            finish({ code: null, error: `Unable to prepare shared Aspire streams: ${error.message}` });
            return;
        }
        let authenticated = false;
        let receivedExit = false;
        const current = createConnection(endpoint);
        socket = current;
        current.setTimeout(CONNECT_TIMEOUT_MS, () => {
            finish({ code: null, error: "Timed out authenticating the shared Aspire stream." });
        });
        receive(current, (frame) => {
            if (finished || killed) return;
            if (!authenticated) {
                if (typeof frame.nonce !== "string" || !matches(frame.proof, proof(secret, `server:${frame.nonce}`))) {
                    throw new Error("Shared Aspire stream server authentication failed.");
                }
                authenticated = true;
                send(current, { proof: proof(secret, `client:${frame.nonce}`) });
            } else if (typeof frame.line === "string") {
                if (Number.isSafeInteger(frame.seq)) lastSeq = Math.max(lastSeq, frame.seq);
                if (resetResources) {
                    try { resetResources.push(JSON.parse(frame.line)); } catch { /* ignored like stream noise */ }
                } else {
                    onLine?.(frame.line);
                }
            } else if (frame.reset) {
                resetResources = [];
            } else if (frame.resetEnd && resetResources) {
                // Deliver the reconciled cache as one snapshot so consumers never observe it half-applied.
                const resources = resetResources;
                resetResources = null;
                if (Number.isSafeInteger(frame.seq)) lastSeq = Math.max(lastSeq, frame.seq);
                onLine?.(JSON.stringify({ resources }));
            } else if (frame.exit) {
                receivedExit = true;
                finish(frame.exit);
            } else if (frame.ready) {
                current.setTimeout(0);
                if (Number.isSafeInteger(frame.seq)) lastSeq = Math.max(lastSeq, frame.seq);
                ready = true;
                onReady?.();
            }
        });
        current.once("error", async (error) => {
            if (killed || finished) return;
            // The broker can stop between authentication and `ready`; take over instead of failing.
            if (!ready && (error.code === "ECONNRESET" || error.code === "EPIPE")) return retry();
            if (error.code !== "ENOENT" && error.code !== "ECONNREFUSED") {
                finish({ code: null, error: `Shared Aspire stream connection failed: ${error.code ?? error.message}.` });
                return;
            }
            try {
                // Unix retains socket files after a crash. Reclaim only refused sockets
                // whose identity still matches the failed connection attempt.
                if (error.code === "ECONNREFUSED" && socketInfo?.isSocket()) {
                    const now = lstatSync(endpoint);
                    if (now.ino === socketInfo.ino && now.mtimeMs === socketInfo.mtimeMs) unlinkSync(endpoint);
                }
                await ownStream(endpoint, secret, kind, start);
            } catch (listenError) {
                if (!["EADDRINUSE", "ENOENT"].includes(listenError.code)) {
                    finish({ code: null, error: `Unable to start shared Aspire streams: ${listenError.message}` });
                    return;
                }
            }
            retry();
        });
        current.once("close", (hadError) => {
            if (killed || finished || receivedExit || hadError) return;
            // Until `ready`, the broker has not admitted this subscriber and may have stopped.
            if (!ready) return retry();
            finish({ code: null, error: "The shared Aspire stream owner disconnected." });
        });
    };
    queueMicrotask(connect);
    return {
        kill() {
            if (killed) return;
            killed = true;
            finish({ code: null, cancelled: true });
        },
        // Returns the broker position before an authoritative snapshot is requested.
        mark() {
            return ready && !finished && !killed ? lastSeq : null;
        },
        // Publishes an authoritative snapshot taken after `mark()` to the broker and its subscribers.
        reconcile(since, resources) {
            if (!ready || finished || killed || !Number.isSafeInteger(since) || !Array.isArray(resources)) return false;
            const prefix = '{"reconcile":{"chunk":[';
            const suffix = "]}}";
            const frames = [];
            let batch = [];
            let batchBytes = 0;
            let total = socket.writableLength;
            let overflow = false;
            const flush = () => {
                if (!batch.length) return;
                const text = `${prefix}${batch.join(",")}${suffix}`;
                frames.push(text);
                total += batchBytes;
                batch = [];
            };
            for (const resource of resources) {
                if (typeof resource?.name !== "string") continue;
                const text = JSON.stringify(resource);
                const bytes = Buffer.byteLength(text) + 1;
                // A resource that cannot fit in one frame could not be replayed either.
                if (bytes + prefix.length + suffix.length > MAX_FRAME_BYTES) {
                    overflow = true;
                    break;
                }
                if (batch.length && batchBytes + bytes + prefix.length + suffix.length > MAX_FRAME_BYTES) flush();
                if (!batch.length) batchBytes = prefix.length + suffix.length;
                batch.push(text);
                batchBytes += bytes;
                if (total + batchBytes > MAX_REPLAY_BYTES) {
                    overflow = true;
                    break;
                }
            }
            if (overflow) {
                send(socket, { reconcile: { since, overflow: true } });
                return true;
            }
            flush();
            send(socket, { reconcile: { since, begin: true } });
            for (const text of frames) sendText(socket, text);
            send(socket, { reconcile: { end: true } });
            return true;
        },
    };
}

export function createSharedCliRunner(runner, {
    command = runner.command ?? defaultAspireCliCommand(),
    resolveExecutable,
    directory,
} = {}) {
    return {
        ...runner,
        stream(args, options = {}) {
            if (!["ps", "describe"].includes(args[0]) || !args.includes("--follow")) {
                return runner.stream(args, options);
            }
            let subscription;
            let killed = false;
            let exited = false;
            let ownsProcess = false;
            let processExited = false;
            const onExit = (result) => {
                if (exited) return;
                // The owner's diagnostic file belongs to the physical process, not
                // its original subscription. Keep it until the final client leaves.
                if (result.cancelled && ownsProcess && !processExited) return;
                exited = true;
                options.onExit?.(result);
            };
            const timer = setTimeout(() => {
                killed = true;
                onExit({ code: null, error: "Timed out resolving the shared Aspire CLI executable." });
            }, CONNECT_TIMEOUT_MS);
            timer.unref?.();
            resolveExecutable(command, options.env ?? process.env, {
                cwd: options.cwd,
                forSharing: true,
            }).then((executable) => {
                clearTimeout(timer);
                if (killed) return;
                const sharedArgs = args.filter((arg, index) => arg !== "--log-file" && args[index - 1] !== "--log-file");
                const appHostIndex = sharedArgs.indexOf("--apphost");
                if (appHostIndex >= 0) sharedArgs[appHostIndex + 1] = pathKey(sharedArgs[appHostIndex + 1]);
                const environment = options.env ?? Object.fromEntries(Object.entries(process.env)
                    .filter(([name]) => /^(ASPIRE_|DOTNET_ROOT|HOME$|USERPROFILE$|PATH$)/i.test(name)));
                const identity = JSON.stringify({
                    executable: pathKey(executable),
                    args: sharedArgs,
                    cwd: args[0] === "ps" ? null : pathKey(options.cwd ?? process.cwd()),
                    environment: Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)),
                });
                subscription = shareCliStream({
                    identity,
                    kind: args[0],
                    directory,
                    start: (observers) => {
                        ownsProcess = true;
                        let stopping = false;
                        const handle = runner.stream(args, {
                            ...options,
                            ...observers,
                            executable,
                            onExit(result) {
                                processExited = true;
                                observers.onExit(result);
                                if (!killed) return;
                                // This subscription already left. Report only a process failure, which
                                // owns the diagnostic log; a broker stop is a normal cancellation.
                                onExit(stopping ? { code: null, cancelled: true } : { ...result, afterRelease: true });
                            },
                        });
                        return {
                            ...handle,
                            kill() {
                                stopping = true;
                                handle.kill();
                            },
                        };
                    },
                    onLine: options.onLine,
                    onExit,
                    onReady: options.onReady,
                });
            }, (error) => {
                clearTimeout(timer);
                if (!killed) onExit({ code: null, error: `Unable to resolve shared Aspire CLI: ${error.message}` });
            });
            return {
                kill() {
                    killed = true;
                    clearTimeout(timer);
                    subscription?.kill();
                    onExit({ code: null, cancelled: true });
                },
                mark() {
                    return killed ? null : subscription?.mark() ?? null;
                },
                reconcile(since, resources) {
                    return killed ? false : subscription?.reconcile(since, resources) ?? false;
                },
            };
        },
    };
}
