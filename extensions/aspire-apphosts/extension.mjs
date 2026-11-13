// Extension: aspire-apphosts
//
// Canvas-native Aspire AppHost workbench for GitHub Copilot.

import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { openSystemBrowser } from "./lib/browser.mjs";
import {
    AppHostOperationCoordinator,
    CommandInputMetadataStore,
    KeyedTaskQueue,
    SnapshotGeneration,
    appHostIdentityHint,
    appHostOperationKey,
    assertLocalAppHostPath,
    buildDashboardViewUrl,
    createDetachedRunLogTail,
    buildGlobalTree,
    buildCommandArgumentTokens,
    buildResourceCommandArgs,
    buildTerminalAttachCommand,
    buildWorkspaceTree,
    combineWorkspaceAppHosts,
    createAspireCliRunner,
    createStoppedAppHost,
    defaultCwdForAppHost,
    discoverConfiguredAppHosts,
    extractJsonPayload,
    isPathWithin,
    mapWithConcurrency,
    normalizeLsPayload,
    normalizePsPayload,
    optionalFlagIsUnsupported,
    parseLegacyPipelineSteps,
    projectDescribePayload,
    redactAbsolutePaths,
    redactKnownPaths,
    redactText,
    relativizeWorkspacePaths,
    resolveRequestedAppHostPath,
    runWithOptionalFlagFallback,
    sanitizeCommandArgumentInputs,
    stableId,
    validateCommandArguments,
} from "./lib/app-model.mjs";

const CANVAS_ID = "aspire-apphosts";
const DEFAULT_INSTANCE = "aspire-apphosts-main";
const UI_DIR = new URL("./ui/", import.meta.url);
const UI_ROOT = fileURLToPath(UI_DIR);
// Discovery polls are cheap safety nets; running AppHosts push changes through describe streams.
const POLL_INTERVAL_MS = 30_000;
const VIEWER_IDLE_GRACE_MS = 10_000;
const STREAM_PUBLISH_DEBOUNCE_MS = 200;
const STREAM_RESTART_DELAY_MS = 1_000;
const STREAM_MAX_RESTART_DELAY_MS = 60_000;
const STREAM_MAX_FAILURES = 3;
const BACKGROUND_LOG_DIR = join(tmpdir(), "aspire-apphosts-logs");
const MAX_KEPT_BACKGROUND_LOGS = 10;
const FAILED_BACKGROUND_LOG_PREFIX = "failed-";
const CLI_TIMEOUT_MS = 30_000;
const OPERATION_TIMEOUT_MS = 30 * 60_000;
const GLOBAL_DESCRIBE_CONCURRENCY = 4;
const TOKEN_BYTES = 32;
const AUTH_HEADER = "x-aspire-apphosts-token";
const MAX_BODY_BYTES = 128 * 1024;

const CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
};

const instances = new Map();
const pendingOpens = new Map();
const cli = createAspireCliRunner();
const appHostOperations = new AppHostOperationCoordinator();
const activeStreams = new Set();
let backgroundLogFileSupported = true;
let sessionRef;
let sessionWorkingDirectory;

function log(message, level = "info") {
    try {
        sessionRef?.log?.(message, { level, ephemeral: true });
    } catch {
        // Logging must never disrupt the provider.
    }
}

function clampText(value, max = 1000) {
    const text = String(value ?? "").trim();
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

function createToken() {
    return randomBytes(TOKEN_BYTES).toString("base64url");
}

function tokensMatch(actual, expected) {
    const actualBuffer = Buffer.from(String(actual ?? ""), "utf8");
    const expectedBuffer = Buffer.from(String(expected ?? ""), "utf8");
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function securityHeaders(contentType) {
    return {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "Content-Security-Policy":
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
            "font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
    };
}

function sendJson(res, status, payload) {
    res.writeHead(status, securityHeaders("application/json; charset=utf-8"));
    res.end(JSON.stringify(payload));
}

function sendText(res, status, value) {
    res.writeHead(status, securityHeaders("text/plain; charset=utf-8"));
    res.end(value);
}

async function serveAsset(res, name) {
    const fileUrl = new URL(name, UI_DIR);
    const resolved = fileURLToPath(fileUrl);
    if (!resolved.startsWith(UI_ROOT)) {
        return sendText(res, 403, "Forbidden");
    }
    try {
        const sharedAsset = name === "canvas-theme.css" ? "theme.css"
            : name === "canvas-icons.svg" ? "icons.svg" : null;
        const source = sharedAsset ? new URL(`../../assets/canvas/${sharedAsset}`, import.meta.url) : fileUrl;
        const body = await readFile(source).catch((error) => {
            if (sharedAsset && (error.code === "ENOENT" || error.code === "ENOTDIR")) return readFile(fileUrl);
            throw error;
        });
        res.writeHead(200, securityHeaders(CONTENT_TYPES[extname(name)] ?? "application/octet-stream"));
        res.end(body);
    } catch {
        sendText(res, 404, "Not found");
    }
}

function requestToken(req, url) {
    const headerValue = req.headers[AUTH_HEADER];
    return Array.isArray(headerValue) ? headerValue[0] ?? "" : headerValue || url.searchParams.get("token") || "";
}

function authorizeRequest(entry, req, url) {
    if (String(req.headers.host ?? "").toLowerCase() !== entry.host) {
        return "Unexpected request host.";
    }
    const origin = req.headers.origin;
    if (origin && String(origin).toLowerCase() !== entry.origin) {
        return "Unexpected request origin.";
    }
    if ((url.pathname === "/events" || url.pathname.startsWith("/api/"))
        && !tokensMatch(requestToken(req, url), entry.token)) {
        return "Missing or invalid canvas token.";
    }
    return undefined;
}

function readJsonBody(req) {
    return new Promise((resolveBody, reject) => {
        let size = 0;
        let settled = false;
        const chunks = [];
        const fail = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            reject(error);
        };
        req.on("data", (chunk) => {
            if (settled) {
                return;
            }
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                chunks.length = 0;
                const error = new Error("Request body is too large.");
                error.status = 413;
                error.closeRequest = true;
                fail(error);
                req.pause();
                return;
            }
            chunks.push(chunk);
        });
        req.once("end", () => {
            if (settled) {
                return;
            }
            try {
                const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
                settled = true;
                resolveBody(body);
            } catch {
                fail(new Error("Request body is not valid JSON."));
            }
        });
        req.once("error", (error) => {
            if (!settled) {
                fail(error);
            }
        });
    });
}

function addSseClient(entry, req, res) {
    res.writeHead(200, {
        ...securityHeaders("text/event-stream"),
        Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    for (const item of entry.commandLog) {
        flushCommandLogOutput(entry, item);
    }
    entry.clients.add(res);
    res.write(`data: ${JSON.stringify({ type: "state", state: publicState(entry) })}\n\n`);
    res.write(`data: ${JSON.stringify(commandLogSnapshot(entry))}\n\n`);
    resumeBackgroundWork(entry);
    req.once("close", () => {
        entry.clients.delete(res);
        scheduleIdlePause(entry);
    });
}

// Background polling and describe streams only run while a canvas view is connected.
function startPolling(entry) {
    if (entry.timer || entry.closed) return;
    entry.timer = setInterval(() => void requestRefresh(entry), POLL_INTERVAL_MS);
    entry.timer.unref?.();
}

function scheduleIdlePause(entry) {
    if (entry.closed || entry.paused || entry.pauseTimer || entry.clients.size > 0) return;
    entry.pauseTimer = setTimeout(() => {
        entry.pauseTimer = null;
        if (entry.closed || entry.clients.size > 0) return;
        entry.paused = true;
        if (entry.timer) {
            clearInterval(entry.timer);
            entry.timer = null;
        }
        stopDescribeStreams(entry);
        log(`Aspire AppHosts canvas paused background work (instance '${entry.instanceId}').`);
    }, VIEWER_IDLE_GRACE_MS);
    entry.pauseTimer.unref?.();
}

function resumeBackgroundWork(entry) {
    if (entry.pauseTimer) {
        clearTimeout(entry.pauseTimer);
        entry.pauseTimer = null;
    }
    if (!entry.paused || entry.closed) return;
    entry.paused = false;
    startPolling(entry);
    void requestRefresh(entry);
}

function broadcast(entry, payload) {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const response of entry.clients) {
        try {
            response.write(frame);
        } catch {
            entry.clients.delete(response);
        }
    }
}

const COMMAND_LOG_LIMITS = { user: 40, background: 20 };
const COMMAND_OUTPUT_TAIL = { user: 64 * 1024, background: 16 * 1024 };
const COMMAND_OUTPUT_FLUSH_MS = 120;
const COMMAND_LINE_HOLD_MAX = 8 * 1024;

function commandLogKind(item) {
    return item.source === "background" ? "background" : "user";
}

function publicCommandLogItem(item, includeOutput) {
    return {
        id: item.id,
        source: item.source,
        label: item.label,
        appHostId: item.appHostId,
        appHostName: item.appHostName,
        commandLine: item.commandLine,
        status: item.status,
        exitCode: item.exitCode,
        error: item.error,
        startedAt: item.startedAt,
        endedAt: item.endedAt,
        truncated: item.truncated,
        sanitizedOutput: item.sanitizedOutput,
        ...(includeOutput ? { output: item.output } : {}),
    };
}

function commandLogSnapshot(entry) {
    return {
        type: "command-log-snapshot",
        commands: entry.commandLog.map((item) => publicCommandLogItem(item, true)),
    };
}

function trimCommandLog(entry, kind) {
    const matching = entry.commandLog.filter((item) => commandLogKind(item) === kind);
    let excess = matching.length - COMMAND_LOG_LIMITS[kind];
    for (const item of matching) {
        if (excess <= 0) break;
        if (item.status === "running") continue;
        entry.commandLog.splice(entry.commandLog.indexOf(item), 1);
        excess--;
    }
}

function beginCommandLog(entry, args, meta, sensitiveValues = []) {
    const record = meta.record;
    const item = {
        id: `cmd-${++entry.commandSequence}`,
        source: meta.source ?? "user",
        label: meta.label,
        appHostId: record?.id ?? null,
        appHostName: record?.displayName ?? null,
        commandLine: publicCommandText(entry, record, `aspire ${args.join(" ")}`, 2000, sensitiveValues),
        status: "running",
        exitCode: null,
        error: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
        truncated: false,
        sanitizedOutput: meta.sanitizedOutput === true,
        output: "",
        record,
        sensitiveValues,
        heldLine: "",
        discardingLine: false,
        unsent: "",
        flushTimer: null,
    };
    entry.commandLog.push(item);
    trimCommandLog(entry, commandLogKind(item));
    broadcast(entry, { type: "command-log", command: publicCommandLogItem(item, false) });
    return item;
}

function appendCommandLogText(entry, item, text) {
    if (!text) return;
    const tail = COMMAND_OUTPUT_TAIL[commandLogKind(item)];
    item.output += text;
    if (item.output.length > tail) {
        item.output = item.output.slice(item.output.length - tail);
        item.truncated = true;
    }
    item.unsent += text;
    if (!item.flushTimer) {
        item.flushTimer = setTimeout(() => flushCommandLogOutput(entry, item), COMMAND_OUTPUT_FLUSH_MS);
        item.flushTimer.unref?.();
    }
}

function flushCommandLogOutput(entry, item) {
    if (item.flushTimer) {
        clearTimeout(item.flushTimer);
        item.flushTimer = null;
    }
    if (!item.unsent) return;
    const text = item.unsent;
    item.unsent = "";
    broadcast(entry, { type: "command-output", id: item.id, text });
}

function receiveCommandOutput(entry, item, text) {
    // Path redaction is line-oriented, so only complete lines are published while a
    // command runs. A path split across process chunks is therefore never exposed.
    let combined = item.heldLine + text;
    let ready = "";
    item.heldLine = "";
    if (item.discardingLine) {
        const nextBreak = combined.indexOf("\n");
        if (nextBreak < 0) return;
        item.discardingLine = false;
        combined = combined.slice(nextBreak + 1);
    }
    let nextBreak;
    while ((nextBreak = combined.indexOf("\n")) >= 0) {
        const line = combined.slice(0, nextBreak + 1);
        combined = combined.slice(nextBreak + 1);
        if (line.length <= COMMAND_LINE_HOLD_MAX) {
            ready += line;
        }
    }
    if (combined.length > COMMAND_LINE_HOLD_MAX) {
        item.discardingLine = true;
    } else {
        item.heldLine = combined;
    }
    if (ready) {
        appendCommandLogText(entry, item, publicCommandText(entry, item.record, ready, Infinity, item.sensitiveValues));
    }
}

function finishCommandLog(entry, item, result) {
    if (!item.discardingLine && item.heldLine) {
        appendCommandLogText(entry, item, publicCommandText(entry, item.record, item.heldLine, Infinity, item.sensitiveValues));
        item.heldLine = "";
    }
    item.discardingLine = false;
    flushCommandLogOutput(entry, item);
    item.status = result?.ok ? "succeeded" : "failed";
    item.exitCode = Number.isInteger(result?.code) ? result.code : null;
    item.error = result?.ok ? null : publicCommandText(
        entry,
        item.record,
        String(result?.error ?? "The Aspire CLI command failed.").split(/\r?\n/).find((line) => line.trim()) ?? "",
        400,
        item.sensitiveValues,
    );
    item.endedAt = new Date().toISOString();
    item.record = undefined;
    item.sensitiveValues = undefined;
    broadcast(entry, { type: "command-log", command: publicCommandLogItem(item, false) });
    trimCommandLog(entry, commandLogKind(item));
}

function clearCommandLog(entry) {
    entry.commandLog = entry.commandLog.filter((item) => item.status === "running");
    broadcast(entry, commandLogSnapshot(entry));
    return { ok: true, status: 200 };
}

function initialState(viewMode, includeHidden) {
    return {
        revision: 0,
        viewMode,
        status: "loading",
        refreshing: true,
        stale: false,
        error: null,
        includeHidden,
        generatedAt: new Date().toISOString(),
        lastSuccessfulAt: null,
        roots: [],
        summary: {
            appHosts: 0,
            running: 0,
            idle: 0,
            resources: 0,
            failedAppHosts: 0,
        },
    };
}

function stateSignature(state) {
    return JSON.stringify(state, (key, value) =>
        ["revision", "generatedAt", "lastSuccessfulAt"].includes(key) ? undefined : value);
}

function publishState(entry, nextState) {
    const candidate = {
        ...entry.state,
        ...nextState,
        generatedAt: new Date().toISOString(),
    };
    const signature = stateSignature(candidate);
    candidate.revision = entry.state.revision + (signature === entry.stateSignature ? 0 : 1);
    entry.state = candidate;
    if (signature === entry.stateSignature) {
        if ((candidate.status === "ready" || candidate.status === "empty") && candidate.lastSuccessfulAt) {
            broadcast(entry, {
                type: "freshness",
                revision: candidate.revision,
                lastSuccessfulAt: candidate.lastSuccessfulAt,
            });
        }
        return;
    }
    entry.stateSignature = signature;
    broadcast(entry, { type: "state", state: candidate });
}

function publicState(entry) {
    return entry.state;
}

function isNoLogoUnsupported(result) {
    const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    return /unrecognized command or argument ['"]?--nologo|--nologo.+(?:unknown|unrecognized)/i.test(output);
}

function isLsUnsupported(result) {
    const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    return /unrecognized command or argument ['"]?ls|command ['"]?ls['"]?.+(?:unknown|unrecognized)/i.test(output);
}

// Background polls and streams write CLI diagnostics to a temp file instead of ~/.aspire/logs.
// Successful runs delete it; failures keep the newest few for troubleshooting.
async function createBackgroundLogFile() {
    if (!backgroundLogFileSupported) return null;
    try {
        await mkdir(BACKGROUND_LOG_DIR, { recursive: true });
        return join(BACKGROUND_LOG_DIR, `${randomUUID()}.log`);
    } catch {
        return null;
    }
}

function withLogFile(args, logFile) {
    return logFile ? [...args, "--log-file", logFile] : args;
}

async function discardBackgroundLogFile(logFile) {
    if (!logFile) return;
    await rm(logFile, { force: true }).catch(() => {});
}

async function keepBackgroundLogFile(logFile) {
    if (!logFile) return;
    try {
        // Only renamed failure logs are pruned, so active logs from other runs stay intact.
        await rename(logFile, join(BACKGROUND_LOG_DIR, `${FAILED_BACKGROUND_LOG_PREFIX}${basename(logFile)}`));
        const names = (await readdir(BACKGROUND_LOG_DIR))
            .filter((name) => name.startsWith(FAILED_BACKGROUND_LOG_PREFIX) && name.endsWith(".log"));
        if (names.length <= MAX_KEPT_BACKGROUND_LOGS) return;
        const files = await Promise.all(names.map(async (name) => {
            const path = join(BACKGROUND_LOG_DIR, name);
            const info = await stat(path).catch(() => null);
            return { path, mtime: info?.mtimeMs ?? 0 };
        }));
        files.sort((a, b) => b.mtime - a.mtime);
        await Promise.all(files.slice(MAX_KEPT_BACKGROUND_LOGS).map((file) => rm(file.path, { force: true }).catch(() => {})));
    } catch {
        // Pruning is best effort.
    }
}

async function runBackgroundCli(args, runOptions) {
    const logFile = await createBackgroundLogFile();
    let result = await cli.run(withLogFile(args, logFile), runOptions);
    if (logFile && !result.ok && optionalFlagIsUnsupported(result, "--log-file")) {
        backgroundLogFileSupported = false;
        await discardBackgroundLogFile(logFile);
        return cli.run(args, runOptions);
    }
    if (result.ok) {
        await discardBackgroundLogFile(logFile);
    } else {
        await keepBackgroundLogFile(logFile);
    }
    return result;
}

async function runPreparedWithCompatibility(args, options = {}) {
    const { commandLog, ...runOptions } = options;
    const run = commandLog?.source === "background"
        ? (runArgs) => runBackgroundCli(runArgs, runOptions)
        : (runArgs) => cli.run(runArgs, runOptions);
    const item = commandLog?.entry && !commandLog.entry.closed
        ? beginCommandLog(commandLog.entry, args, commandLog, runOptions.sensitiveValues)
        : undefined;
    if (item) {
        runOptions.onOutput = (stream, text) => {
            if (stream !== "stdout" || commandLog.publishStdout !== false) {
                receiveCommandOutput(commandLog.entry, item, text);
            }
        };
    }
    const tail = item && commandLog.tailAppHostPath
        ? createDetachedRunLogTail({
            appHostPath: commandLog.tailAppHostPath,
            onText: (text) => receiveCommandOutput(commandLog.entry, item, text),
        })
        : undefined;
    let result;
    try {
        result = await run(args);
        if (!result.ok && args.includes("--nologo") && isNoLogoUnsupported(result)) {
            result = await run(args.filter((argument) => argument !== "--nologo"));
        }
    } catch (error) {
        await tail?.stop();
        if (item) finishCommandLog(commandLog.entry, item, { ok: false, error: error?.message || error });
        throw error;
    }
    await tail?.stop();
    if (item) {
        const projectedOutput = result.ok && commandLog.projectStdout
            ? commandLog.projectStdout(result.stdout)
            : "";
        if (projectedOutput) {
            receiveCommandOutput(commandLog.entry, item, `${projectedOutput}\n`);
        }
        const loggedResult = commandLog.publishStdout === false && !result.ok && result.stdout
            ? {
                ...result,
                error: result.stderr || "The Aspire CLI command failed.",
            }
            : result;
        finishCommandLog(commandLog.entry, item, loggedResult);
    }
    return result;
}

async function runJsonWithCompatibility(args, options = {}) {
    const prepared = [...args, "--non-interactive", "--nologo"];
    const result = await runPreparedWithCompatibility(prepared, {
        ...options,
        commandLog: options.commandLog
            ? {
                ...options.commandLog,
                publishStdout: false,
                sanitizedOutput: Boolean(options.commandLog.projectStdout),
            }
            : undefined,
    });
    return {
        ...result,
        error: !result.ok && result.stdout
            ? result.stderr || "The Aspire CLI command failed."
            : result.error,
        data: result.ok ? extractJsonPayload(result.stdout) : undefined,
    };
}

function privateError(entry, value, records = []) {
    let message = redactText(value, 4000);
    const privatePaths = [
        entry.workingDirectory,
        entry.requestedAppHostPath,
        ...[...entry.hostRecords.values()].map((record) => record.appHostPath),
        ...records.map((record) => record.appHostPath),
    ].filter(Boolean);
    message = redactAbsolutePaths(redactKnownPaths(message, privatePaths))
        .split(/\r?\n/)
        .filter((line) => !/See (?:AppHost )?logs at|A new version of Aspire is available|To update, run:/i.test(line))
        .join("\n")
        .trim();
    return message || "The Aspire CLI operation failed.";
}

function relativeWorkspacePath(entry, appHostPath) {
    if (!isPathWithin(appHostPath, entry.workingDirectory)) {
        return undefined;
    }
    const value = relative(entry.workingDirectory, appHostPath);
    return value.split(sep).join("/");
}

function candidateFromPath(entry, appHostPath, {
    language,
    discoveryStatus = "configured",
    buildable = true,
} = {}) {
    return {
        ...createStoppedAppHost(appHostPath),
        language,
        discoveryStatus,
        buildable,
        relativePath: relativeWorkspacePath(entry, appHostPath),
    };
}

function localTargetRecords(payload, pathProperty) {
    let rejected = 0;
    const records = payload.filter((record) => {
        try {
            assertLocalAppHostPath(record?.[pathProperty]);
            return true;
        } catch (error) {
            if (error.code !== "network_apphost_target") {
                throw error;
            }
            rejected += 1;
            return false;
        }
    });
    return {
        records,
        warning: rejected
            ? `${rejected} AppHost target${rejected === 1 ? " was" : "s were"} rejected: UNC and explicit network paths are not supported.`
            : null,
    };
}

function projectWorkspaceCandidates(entry, payload) {
    const localTargets = localTargetRecords(Array.isArray(payload) ? payload : [], "path");
    return {
        appHosts: normalizeLsPayload(localTargets.records).map((record) => ({
            displayName: record.displayName,
            language: record.language,
            discoveryStatus: record.discoveryStatus,
            buildable: record.buildable,
            workspaceLocation: relativeWorkspacePath(entry, record.appHostPath),
        })),
    };
}

async function discoverWorkspaceCandidates(entry) {
    if (entry.requestedAppHostPath) {
        return {
            candidates: [candidateFromPath(entry, entry.requestedAppHostPath)],
            warning: null,
        };
    }

    const result = await runJsonWithCompatibility(
        ["ls", "--format", "Json"],
        {
            cwd: entry.workingDirectory,
            timeoutMs: CLI_TIMEOUT_MS,
            commandLog: {
                entry,
                source: "background",
                label: "Find AppHosts",
                projectStdout: sanitizedJsonOutput((payload) => projectWorkspaceCandidates(entry, payload)),
            },
        },
    );
    if (result.ok && Array.isArray(result.data)) {
        const localTargets = localTargetRecords(result.data, "path");
        return {
            candidates: normalizeLsPayload(localTargets.records).map((record) => ({
                ...record,
                relativePath: relativeWorkspacePath(entry, record.appHostPath),
            })),
            warning: localTargets.warning,
        };
    }

    let fallbackPaths;
    try {
        fallbackPaths = await discoverConfiguredAppHosts(entry.workingDirectory);
    } catch (error) {
        if (error.code !== "network_apphost_target") {
            throw error;
        }
        return { candidates: [], warning: error.message };
    }
    const candidates = fallbackPaths.map((appHostPath) => candidateFromPath(entry, appHostPath));
    return {
        candidates,
        warning: candidates.length > 0 || result.ok || isLsUnsupported(result)
            ? null
            : privateError(entry, result.error || "Workspace AppHost discovery failed."),
    };
}

function pathKey(value) {
    const normalized = normalize(resolve(value));
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameAppHostDirectory(left, right) {
    return pathKey(defaultCwdForAppHost(left)) === pathKey(defaultCwdForAppHost(right));
}

function workspaceRunningHosts(entry, candidates, runningHosts) {
    if (entry.requestedAppHostPath) {
        return runningHosts.filter((running) =>
            candidates.some((candidate) =>
                candidate.id === running.id || sameAppHostDirectory(candidate.appHostPath, running.appHostPath)));
    }
    return runningHosts.filter((running) =>
        isPathWithin(running.appHostPath, entry.workingDirectory)
        || candidates.some((candidate) =>
            candidate.id === running.id || sameAppHostDirectory(candidate.appHostPath, running.appHostPath)));
}

function sanitizedJsonOutput(project) {
    return (stdout) => {
        const payload = extractJsonPayload(stdout);
        return payload === undefined ? "" : JSON.stringify(project(payload), null, 2);
    };
}

async function describeAppHost(entry, record, previousModel) {
    const baseArgs = [
        "describe",
        "--apphost",
        record.appHostPath,
        "--format",
        "Json",
        "--include-disabled-commands",
    ];
    if (entry.includeHidden) {
        baseArgs.push("--include-hidden");
    }

    const options = {
        cwd: defaultCwdForAppHost(record.appHostPath, entry.workingDirectory),
        timeoutMs: CLI_TIMEOUT_MS,
        commandLog: {
            entry,
            record,
            source: "background",
            label: `Describe ${record.displayName}`,
            projectStdout: sanitizedJsonOutput(projectDescribePayload),
        },
    };
    const result = await runWithOptionalFlagFallback(
        (args) => runJsonWithCompatibility(args, options),
        baseArgs,
        "--include-disabled-commands",
    );

    if (!result.ok || !result.data) {
        const error = privateError(
            entry,
            result.error || "The running AppHost did not return a resource model.",
            [record],
        );
        if (previousModel?.resources?.length) {
            return {
                ...previousModel,
                stale: true,
                error,
            };
        }
        return {
            resources: [],
            summary: { total: 0, healthy: 0, warning: 0, error: 0, inactive: 0 },
            stale: false,
            error,
            lastSuccessfulAt: null,
        };
    }

    const projected = projectDescribePayload(result.data);
    return {
        ...projected,
        stale: false,
        error: null,
        compatibilityWarning: result.optionalFlagFallbackUsed
            ? "This Aspire CLI version does not expose disabled resource commands."
            : null,
        lastSuccessfulAt: new Date().toISOString(),
    };
}

let streamCleanupRegistered = false;

function ensureStreamCleanup() {
    if (streamCleanupRegistered) return;
    streamCleanupRegistered = true;
    process.once("exit", () => {
        for (const handle of activeStreams) handle.kill();
    });
}

function describeStreamArgs(entry, record) {
    const args = ["describe", "--follow", "--apphost", record.appHostPath, "--format", "Json", "--include-disabled-commands"];
    if (entry.includeHidden) {
        args.push("--include-hidden");
    }
    return [...args, "--non-interactive", "--nologo"];
}

// `describe --follow` emits one JSON resource per line: a full burst first, then each change.
function mergeStreamLine(state, line) {
    let payload;
    try {
        payload = JSON.parse(line);
    } catch {
        return false;
    }
    const snapshot = Array.isArray(payload?.resources);
    const items = snapshot ? payload.resources : [payload];
    let changed = false;
    if (snapshot) {
        changed = state.resources.size > 0 || state.initialPending.size > 0;
        state.resources.clear();
        state.raw.clear();
        state.initialPending.clear();
    }
    for (const item of items) {
        if (!item || typeof item !== "object" || typeof item.name !== "string") continue;
        state.initialPending.delete(item.name);
        const serialized = JSON.stringify(item);
        if (state.raw.get(item.name) === serialized) continue;
        state.raw.set(item.name, serialized);
        state.resources.set(item.name, item);
        changed = true;
    }
    return changed;
}

function scheduleStreamPublish(entry) {
    if (entry.streamPublishTimer || entry.closed) return;
    entry.streamPublishTimer = setTimeout(() => {
        entry.streamPublishTimer = null;
        if (entry.closed || entry.discoveryStale || entry.refreshPromise) return;
        const { candidates, runningHosts } = entry.snapshot;
        publishModels(entry, {
            candidates,
            runningHosts,
            models: overlayStreamModels(entry, runningHosts, entry.hostModels),
        });
    }, STREAM_PUBLISH_DEBOUNCE_MS);
    entry.streamPublishTimer.unref?.();
}

function overlayStreamModels(entry, runningHosts, models) {
    const next = new Map(models);
    for (const record of runningHosts) {
        const model = entry.describeStreams.get(record.id)?.model;
        if (model) next.set(record.id, model);
    }
    return next;
}

function publishStreamModel(entry, state) {
    if (state.initialSyncTimer) {
        clearTimeout(state.initialSyncTimer);
        state.initialSyncTimer = null;
    }
    state.model = {
        ...projectDescribePayload({ resources: [...state.resources.values()] }),
        stale: false,
        error: null,
        compatibilityWarning: null,
        lastSuccessfulAt: new Date().toISOString(),
    };
    scheduleStreamPublish(entry);
}

function requestStreamRefresh(entry) {
    if (entry.refreshPromise) {
        entry.refreshQueued = true;
        return;
    }
    void requestRefresh(entry);
}

function scheduleInitialStreamReconciliation(entry, state) {
    if (state.initialSyncTimer || entry.closed) return;
    state.initialSyncTimer = setTimeout(() => {
        state.initialSyncTimer = null;
        if (entry.closed || entry.paused || entry.describeStreams.get(state.record.id) !== state) return;
        requestStreamRefresh(entry);
    }, STREAM_PUBLISH_DEBOUNCE_MS);
    state.initialSyncTimer.unref?.();
}

async function startDescribeStream(entry, state) {
    state.starting = true;
    const logFile = await createBackgroundLogFile();
    state.starting = false;
    if (entry.closed || entry.describeStreams.get(state.record.id) !== state) {
        await discardBackgroundLogFile(logFile);
        return;
    }

    const run = {};
    const startedAt = Date.now();
    state.run = run;
    state.resources = new Map();
    state.raw = new Map();
    state.initialPending = new Set(
        entry.hostModels.get(state.record.id)?.resources?.map((resource) => resource.name) ?? [],
    );
    if (state.initialSyncTimer) {
        clearTimeout(state.initialSyncTimer);
        state.initialSyncTimer = null;
    }
    let gotData = false;
    const isCurrent = () => entry.describeStreams.get(state.record.id) === state && state.run === run;
    const handle = cli.stream(withLogFile(describeStreamArgs(entry, state.record), logFile), {
        cwd: defaultCwdForAppHost(state.record.appHostPath, entry.workingDirectory),
        onLine(line) {
            if (!isCurrent() || !mergeStreamLine(state, line)) return;
            gotData = true;
            state.streamed = true;
            if (state.initialPending.size > 0) {
                scheduleInitialStreamReconciliation(entry, state);
                return;
            }
            publishStreamModel(entry, state);
        },
        onExit({ code, error, stderrTail }) {
            activeStreams.delete(handle);
            if (!isCurrent()) {
                void discardBackgroundLogFile(logFile);
                return;
            }
            state.handle = null;
            state.run = null;
            if (state.initialSyncTimer) {
                clearTimeout(state.initialSyncTimer);
                state.initialSyncTimer = null;
            }
            // An exited stream no longer owns resource state; refreshes fall back to one-shot describe.
            state.model = null;
            if (logFile && !gotData && optionalFlagIsUnsupported({ error, stderr: stderrTail }, "--log-file")) {
                backgroundLogFileSupported = false;
                void discardBackgroundLogFile(logFile);
                if (!entry.paused) requestStreamRefresh(entry);
                return;
            }
            const healthy = code === 0 && !error && gotData && Date.now() - startedAt >= 5_000;
            if (healthy) {
                state.failures = 0;
                void discardBackgroundLogFile(logFile);
            } else {
                state.failures += 1;
                void keepBackgroundLogFile(logFile);
            }
            if (!state.streamed && state.failures >= STREAM_MAX_FAILURES) {
                // Older CLIs without --follow fall back to the polled one-shot describe.
                state.disabled = true;
                return;
            }
            const delay = healthy
                ? STREAM_RESTART_DELAY_MS
                : Math.min(STREAM_MAX_RESTART_DELAY_MS, 5_000 * 2 ** (state.failures - 1));
            // The refresh confirms whether the AppHost is still running before the stream restarts.
            state.restartTimer = setTimeout(() => {
                state.restartTimer = null;
                if (!entry.paused && entry.describeStreams.get(state.record.id) === state) {
                    requestStreamRefresh(entry);
                }
            }, delay);
            state.restartTimer.unref?.();
            // Replace the exited stream's resources now; the pending restart timer keeps the backoff.
            if (gotData && !healthy && !entry.paused) requestStreamRefresh(entry);
        },
    });
    if (state.run === run) {
        state.handle = handle;
        activeStreams.add(handle);
        ensureStreamCleanup();
    } else {
        handle.kill();
    }
}

function stopDescribeStream(entry, id) {
    const state = entry.describeStreams.get(id);
    if (!state) return;
    entry.describeStreams.delete(id);
    if (state.restartTimer) clearTimeout(state.restartTimer);
    if (state.initialSyncTimer) clearTimeout(state.initialSyncTimer);
    if (state.handle) {
        activeStreams.delete(state.handle);
        state.handle.kill();
    }
}

function stopDescribeStreams(entry) {
    for (const id of [...entry.describeStreams.keys()]) {
        stopDescribeStream(entry, id);
    }
    if (entry.streamPublishTimer) {
        clearTimeout(entry.streamPublishTimer);
        entry.streamPublishTimer = null;
    }
}

function syncDescribeStreams(entry, runningHosts) {
    if (typeof cli.stream !== "function" || entry.closed || entry.paused) return;
    const runningIds = new Set(runningHosts.map((record) => record.id));
    for (const id of [...entry.describeStreams.keys()]) {
        if (!runningIds.has(id)) stopDescribeStream(entry, id);
    }
    for (const record of runningHosts) {
        let state = entry.describeStreams.get(record.id);
        if (!state) {
            state = { record, handle: null, run: null, starting: false, resources: new Map(), raw: new Map(), model: null, streamed: false, restartTimer: null, initialSyncTimer: null, failures: 0, disabled: false };
            entry.describeStreams.set(record.id, state);
        }
        state.record = record;
        if (state.initialPending?.size) {
            const currentNames = new Set(
                entry.hostModels.get(record.id)?.resources?.map((resource) => resource.name) ?? [],
            );
            for (const name of state.initialPending) {
                if (!currentNames.has(name)) state.initialPending.delete(name);
            }
            if (state.initialPending.size === 0 && state.resources.size > 0) {
                if (state.initialSyncTimer) {
                    clearTimeout(state.initialSyncTimer);
                    state.initialSyncTimer = null;
                }
                publishStreamModel(entry, state);
            }
        }
        if (!state.handle && !state.starting && !state.restartTimer && !state.disabled) {
            void startDescribeStream(entry, state);
        }
    }
}

function operationMap(entry, records) {
    const operations = new Map();
    for (const record of records) {
        const operation = entry.operationCoordinator.operation(appHostOperationKey(record.appHostPath));
        if (operation) {
            operations.set(record.id, operation);
        }
    }
    return operations;
}

function indexTree(entry, roots) {
    entry.nodeIndex = new Map();
    const visit = (node) => {
        entry.nodeIndex.set(node.id, node);
        for (const child of node.children ?? []) {
            visit(child);
        }
    };
    roots.forEach(visit);
    if (entry.selectionId && !entry.nodeIndex.has(entry.selectionId)) {
        entry.selectionId = null;
    }
}

// A mode switch must not broadcast the previous mode's AppHosts while the new mode loads.
function clearedTree(entry) {
    indexTree(entry, []);
    entry.snapshot = { candidates: [], runningHosts: [] };
    entry.hostRecords = new Map();
    entry.commandInputMetadata.prune(() => false);
    const { roots, summary } = initialState(entry.viewMode, entry.includeHidden);
    return { roots, summary, lastSuccessfulAt: null };
}

function countResources(models) {
    let total = 0;
    for (const model of models.values()) {
        total += model.resources?.length ?? 0;
    }
    return total;
}

function buildRoots(entry, candidates, runningHosts, models) {
    const combined = entry.viewMode === "workspace"
        ? combineWorkspaceAppHosts(candidates, runningHosts)
        : undefined;
    const records = combined ? [...combined.running, ...combined.idle] : runningHosts;
    const operations = operationMap(entry, records);
    return entry.viewMode === "workspace"
        ? buildWorkspaceTree({ candidates, runningHosts, models, operations })
        : buildGlobalTree({ runningHosts, models, operations });
}

function setHostRecords(entry, candidates, runningHosts) {
    const records = entry.viewMode === "workspace"
        ? combineWorkspaceAppHosts(candidates, runningHosts)
        : { running: runningHosts, idle: [] };
    entry.hostRecords = new Map();
    for (const record of [...records.running, ...records.idle]) {
        entry.hostRecords.set(record.id, record);
    }
}

function reconcileCommandInputMetadata(entry) {
    entry.commandInputMetadata.prune(({ appHostId, resourceName, commandName, baseSignature }) => {
        const { record, resource } = getResource(entry, appHostId, resourceName);
        const command = resource?.commands.find((candidate) => candidate.name === commandName);
        return Boolean(record && command && JSON.stringify(command.argumentInputs) === baseSignature);
    });
}

async function performRefresh(entry, generation, showProgress) {
    const viewMode = entry.viewMode;
    if (showProgress) {
        publishState(entry, {
            refreshing: true,
            error: null,
        });
    }

    const psPromise = runJsonWithCompatibility(
        ["ps", "--format", "Json"],
        {
            cwd: entry.workingDirectory,
            timeoutMs: CLI_TIMEOUT_MS,
            commandLog: {
                entry,
                source: "background",
                label: "List running AppHosts",
                projectStdout: sanitizedJsonOutput((payload) => ({
                    appHosts: normalizePsPayload(payload).map(({ displayName, status, sdkVersion }) => ({
                        displayName,
                        status,
                        sdkVersion,
                    })),
                })),
            },
        },
    );
    const candidatePromise = viewMode === "workspace"
        ? discoverWorkspaceCandidates(entry)
        : Promise.resolve({ candidates: [], warning: null });
    const [psResult, candidateResult] = await Promise.all([psPromise, candidatePromise]);

    if (!entry.generation.isCurrent(generation) || entry.closed || entry.viewMode !== viewMode) {
        return;
    }

    if (!psResult.ok || !Array.isArray(psResult.data)) {
        entry.discoveryStale = true;
        const error = privateError(entry, psResult.error || "Unable to list running AppHosts.");
        publishState(entry, {
            status: entry.state.roots.length > 0 ? "stale" : "error",
            refreshing: false,
            stale: entry.state.roots.length > 0,
            error,
        });
        return;
    }

    const localRunning = localTargetRecords(psResult.data, "appHostPath");
    const allRunning = normalizePsPayload(localRunning.records)
        .filter((record) => record.status === "running");
    const candidates = candidateResult.candidates;
    const runningHosts = viewMode === "workspace"
        ? workspaceRunningHosts(entry, candidates, allRunning)
        : allRunning;

    // Live streams own resource state for their AppHosts; one-shot describe covers the rest.
    const modelEntries = await mapWithConcurrency(
        runningHosts,
        GLOBAL_DESCRIBE_CONCURRENCY,
        async (record) => [
            record.id,
            entry.describeStreams.get(record.id)?.model
                ?? await describeAppHost(entry, record, entry.hostModels.get(record.id)),
        ],
    );
    if (!entry.generation.isCurrent(generation) || entry.closed || entry.viewMode !== viewMode) {
        return;
    }

    entry.discoveryStale = false;
    entry.discoveryWarning = candidateResult.warning || localRunning.warning || null;
    publishModels(entry, {
        candidates,
        runningHosts,
        models: overlayStreamModels(entry, runningHosts, new Map(modelEntries)),
    });
    syncDescribeStreams(entry, runningHosts);
}

function publishModels(entry, { candidates, runningHosts, models }) {
    const viewMode = entry.viewMode;
    entry.hostModels = models;
    entry.snapshot = { candidates, runningHosts };
    setHostRecords(entry, candidates, runningHosts);
    reconcileCommandInputMetadata(entry);
    const roots = buildRoots(entry, candidates, runningHosts, models);
    indexTree(entry, roots);

    const failedAppHosts = [...models.values()].filter((model) => model.error).length;
    const stale = [...models.values()].some((model) => model.stale);
    const lastSuccessfulValues = [...models.values()]
        .map((model) => model.lastSuccessfulAt)
        .filter(Boolean)
        .sort();
    const error = entry.discoveryWarning
        || (failedAppHosts > 0 ? `${failedAppHosts} AppHost${failedAppHosts === 1 ? "" : "s"} could not be refreshed.` : null);
    publishState(entry, {
        viewMode,
        status: roots.length > 0 ? (stale ? "stale" : "ready") : "empty",
        refreshing: false,
        stale,
        error,
        includeHidden: entry.includeHidden,
        roots,
        lastSuccessfulAt: lastSuccessfulValues.at(-1) ?? entry.state.lastSuccessfulAt,
        summary: {
            appHosts: entry.hostRecords.size,
            running: runningHosts.length,
            idle: entry.hostRecords.size - runningHosts.length,
            resources: countResources(models),
            failedAppHosts,
        },
    });
}

async function requestRefresh(entry, { force = false } = {}) {
    if (entry.closed) {
        return publicState(entry);
    }
    if (entry.refreshPromise) {
        entry.refreshQueued ||= force;
        await entry.refreshPromise;
        if (force) {
            return requestRefresh(entry);
        }
        return publicState(entry);
    }

    const generation = entry.generation.next();
    const showProgress = force || entry.state.status === "loading";
    const refreshPromise = performRefresh(entry, generation, showProgress);
    entry.refreshPromise = refreshPromise;
    try {
        await refreshPromise;
    } finally {
        if (entry.refreshPromise === refreshPromise) {
            entry.refreshPromise = null;
        }
    }
    if (entry.refreshQueued && !entry.closed) {
        entry.refreshQueued = false;
        return requestRefresh(entry);
    }
    return publicState(entry);
}

function rebuildTreeForOperations(entry) {
    const { candidates = [], runningHosts = [] } = entry.snapshot ?? {};
    const roots = buildRoots(entry, candidates, runningHosts, entry.hostModels);
    indexTree(entry, roots);
    publishState(entry, { roots });
}

function getHostRecord(entry, appHostId) {
    return entry.hostRecords.get(String(appHostId ?? ""));
}

function modelForRecord(entry, record) {
    return entry.hostModels.get(record.runtimeId ?? record.id) ?? entry.hostModels.get(record.id);
}

function getResource(entry, appHostId, resourceName) {
    const record = getHostRecord(entry, appHostId);
    const model = record ? modelForRecord(entry, record) : undefined;
    return {
        record,
        resource: model?.resources?.find((candidate) => candidate.name === resourceName),
    };
}

function commandInputsFor(entry, record, resource, command) {
    return entry.commandInputMetadata.inputsFor({
        appHostId: record.id,
        resourceName: resource.name,
        commandName: command.name,
        baseInputs: command.argumentInputs,
    }) ?? command.argumentInputs;
}

function commandMetadataOptions(record, resource, command) {
    return {
        appHostId: record.id,
        resourceName: resource.name,
        commandName: command.name,
        baseInputs: command.argumentInputs,
    };
}

function submittedSecretValues(command, values) {
    return [...new Set(command.argumentInputs
        .filter((input) => input.inputType.toLowerCase().includes("secret"))
        .map((input) => values?.[input.name])
        .filter((value) => value !== undefined && value !== null && String(value) !== ""))];
}

function publicCommandText(entry, record, value, max, sensitiveValues) {
    const text = relativizeWorkspacePaths(redactText(value, Infinity, sensitiveValues), entry.workingDirectory);
    return redactText(redactAbsolutePaths(redactKnownPaths(text, [entry.workingDirectory, record?.appHostPath])), max);
}

function nodeContext(entry, node) {
    const record = getHostRecord(entry, node.appHostId);
    const model = record ? modelForRecord(entry, record) : undefined;
    const resource = node.resourceName
        ? model?.resources?.find((candidate) => candidate.name === node.resourceName) : undefined;
    const context = {
        nodeId: node.id,
        kind: node.kind,
        label: node.label,
        description: node.description,
        ...(record ? {
            appHost: {
                id: record.id,
                displayName: record.displayName,
                identityHint: appHostIdentityHint(record),
                status: record.status,
                stale: Boolean(model?.stale || entry.discoveryStale),
                lastSuccessfulAt: model?.lastSuccessfulAt ?? null,
            },
        } : {}),
        ...(resource ? {
            resourceIdentity: {
                id: `apphost:${record.id}:resource:${resource.name}`,
                name: resource.name,
                displayName: resource.displayName,
            },
        } : {}),
    };
    if (node.resource) {
        context.resource = node.resource;
    }
    if (node.href) {
        context.endpoint = { label: node.label, url: node.href };
    }
    if (node.command) {
        context.command = node.command;
    }
    if (node.healthCheckName) {
        context.healthCheck = node.healthCheckName;
    }
    return JSON.parse(JSON.stringify(context, (key, value) => typeof value === "string"
        ? publicCommandText(entry, record, value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ""), 1000)
        : value));
}

async function attachCopilotContext(entry, nodeId) {
    const node = entry.nodeIndex.get(String(nodeId ?? ""));
    if (!node) {
        return { ok: false, error: "The selected canvas item is no longer available." };
    }
    if (typeof sessionRef?.rpc?.extensions?.sendAttachmentsToMessage !== "function") {
        return { ok: false, error: "The Copilot composer is not available." };
    }
    const context = nodeContext(entry, node);
    try {
        await sessionRef.rpc.extensions.sendAttachmentsToMessage({
            instanceId: entry.instanceId,
            attachments: [{
                type: "extension_context",
                title: `Aspire: ${context.label}`,
                payload: context,
            }],
        });
    } catch (error) {
        return { ok: false, error: `Could not add to chat: ${clampText(error?.message || error, 500)}` };
    }
    return { ok: true, title: context.label };
}

async function runResourceCommand(entry, request) {
    const { record, resource } = getResource(entry, request?.appHostId, String(request?.resourceName ?? ""));
    if (!record || record.status !== "running") {
        return { ok: false, status: 409, error: "The AppHost is not running." };
    }
    if (!resource) {
        return { ok: false, status: 404, error: "The resource is no longer available." };
    }
    const command = resource.commands.find((candidate) => candidate.name === String(request?.commandName ?? ""));
    if (!command || command.state.toLowerCase() !== "enabled") {
        return { ok: false, status: 409, error: "The resource command is not currently enabled." };
    }

    const metadataOptions = commandMetadataOptions(record, resource, command);
    const currentCommand = { ...command, argumentInputs: commandInputsFor(entry, record, resource, command) };
    const validation = validateCommandArguments(currentCommand, request?.arguments ?? {});
    const currentInputs = entry.commandInputMetadata.executionInputsFor(metadataOptions, validation.values ?? {});
    if (!currentInputs) {
        return {
            ok: false, status: 409, errorCode: "command_inputs_changed",
            error: "Reload command inputs for the current argument values before running.",
        };
    }
    if (!validation.ok) {
        return {
            ok: false,
            status: 400,
            error: "Command arguments are invalid.",
            validationErrors: validation.errors,
        };
    }
    const sensitiveValues = submittedSecretValues({
        argumentInputs: [...command.argumentInputs, ...currentInputs],
    }, validation.values);

    let result;
    let operationStarted = false;
    try {
        result = await entry.operationCoordinator.run(
            appHostOperationKey(record.appHostPath),
            { name: "resource-command", label: `Running ${command.displayName}...` },
            async () => {
                if (entry.commandInputMetadata.executionInputsFor(metadataOptions, validation.values) !== currentInputs) {
                    const error = new Error("Command inputs changed. Reload inputs before running.");
                    error.code = "command_inputs_changed";
                    throw error;
                }
                operationStarted = true;
                rebuildTreeForOperations(entry);
                broadcast(entry, {
                    type: "command",
                    phase: "started",
                    appHostId: record.id,
                    resourceName: resource.name,
                    commandName: command.name,
                });
                return await runPreparedWithCompatibility(
                    buildResourceCommandArgs({
                        appHostPath: record.appHostPath,
                        resourceName: resource.name,
                        commandName: command.name,
                        arguments: validation.values,
                    }),
                    {
                        cwd: defaultCwdForAppHost(record.appHostPath, entry.workingDirectory),
                        timeoutMs: OPERATION_TIMEOUT_MS,
                        maxOutputBytes: 512 * 1024,
                        sensitiveValues,
                        commandLog: {
                            entry,
                            record,
                            source: "user",
                            label: `${command.displayName} ${resource.displayName ?? resource.name}`,
                        },
                    },
                );
            },
        );
    } catch (error) {
        return {
            ok: false,
            status: ["apphost_busy", "command_inputs_changed"].includes(error?.code) ? 409 : 500,
            ...(error?.code === "command_inputs_changed" ? { errorCode: error.code } : {}),
            error: publicCommandText(entry, record, error?.message || error, 1000, sensitiveValues),
        };
    } finally {
        if (operationStarted) {
            rebuildTreeForOperations(entry);
        }
    }
    const response = {
        ok: result.ok,
        status: result.ok ? 200 : 500,
        appHostId: record.id,
        resourceName: resource.name,
        commandName: command.name,
        output: publicCommandText(entry, record, result.stdout, 128 * 1024, sensitiveValues),
        message: publicCommandText(entry, record, result.stderr, 16 * 1024, sensitiveValues),
        error: result.ok
            ? undefined
            : privateError(
                entry,
                redactText(result.error || "The resource command failed.", 8000, sensitiveValues),
                [record],
            ),
    };
    broadcast(entry, { type: "command", phase: "completed", result: response });
    await requestRefresh(entry, { force: true });
    return response;
}

function declaredArgumentValues(argumentInputs, values) {
    const declared = new Set(argumentInputs.map((input) => input.name));
    return Object.fromEntries(Object.entries(values ?? {}).filter(([name]) => declared.has(name)));
}

function commandInputLoadKey(request) {
    return JSON.stringify([
        String(request?.appHostId ?? ""),
        String(request?.resourceName ?? ""),
        String(request?.commandName ?? ""),
    ]);
}

async function loadCommandInputs(entry, request) {
    const { record, resource } = getResource(entry, request?.appHostId, String(request?.resourceName ?? ""));
    const command = resource?.commands.find((candidate) => candidate.name === String(request?.commandName ?? ""));
    if (!record || !command) {
        return { ok: false, status: 404, error: "The resource command is no longer available." };
    }
    const options = commandMetadataOptions(record, resource, command);
    // Invalidate immediately, including while this request waits behind an older load.
    const ticket = entry.commandInputMetadata.beginLoad(options);
    return entry.commandInputLoads.run(
        commandInputLoadKey(request),
        async () => {
            if (!entry.commandInputMetadata.isCurrentLoad(options, ticket)) {
                return { ok: false, status: 409, error: "This command input load was superseded. Reload inputs." };
            }
            try {
                return await loadCommandInputsNow(entry, request, options, ticket);
            } finally {
                entry.commandInputMetadata.failLoad(options, ticket);
            }
        },
    );
}

async function loadCommandInputsNow(entry, request, options, ticket) {
    const { record, resource } = getResource(entry, request?.appHostId, String(request?.resourceName ?? ""));
    if (!record || !resource) {
        return { ok: false, status: 404, error: "The resource is no longer available." };
    }
    const command = resource.commands.find((candidate) => candidate.name === String(request?.commandName ?? ""));
    if (!command) {
        return { ok: false, status: 404, error: "The resource command is no longer available." };
    }
    const currentInputs = commandInputsFor(entry, record, resource, command);
    // Loads accept incomplete forms, but their dependency values must use the
    // same typed normalization and omission rules as command execution.
    const loadValues = validateCommandArguments(
        { argumentInputs: currentInputs },
        declaredArgumentValues(currentInputs, request?.arguments),
    ).values;
    const sensitiveValues = submittedSecretValues(
        { argumentInputs: [...command.argumentInputs, ...currentInputs] },
        loadValues,
    );
    const args = [
        "resource",
        resource.name,
        command.name,
        "--apphost",
        record.appHostPath,
        "--load-arguments",
        ...buildCommandArgumentTokens(loadValues),
    ];
    let result;
    try {
        result = await runJsonWithCompatibility(args, {
            cwd: defaultCwdForAppHost(record.appHostPath, entry.workingDirectory),
            timeoutMs: CLI_TIMEOUT_MS,
            sensitiveValues,
            commandLog: { entry, record, source: "user", label: `Load inputs for ${command.displayName}` },
        });
    } catch (error) {
        result = { ok: false, error: error?.message || String(error) };
    }
    const payload = result.data;
    if (!result.ok || !Array.isArray(payload)) {
        return {
            ok: false,
            status: 500,
            error: privateError(
                entry,
                redactText(result.error || "Dynamic command inputs could not be loaded.", 8000, sensitiveValues),
                [record],
            ),
        };
    }
    const inputs = sanitizeCommandArgumentInputs(payload);
    const latest = getResource(entry, record.id, resource.name).resource?.commands
        .find((candidate) => candidate.name === command.name);
    if (!latest || JSON.stringify(latest.argumentInputs) !== JSON.stringify(options.baseInputs)) {
        return { ok: false, status: 409, error: "Command inputs changed while loading. Reload inputs." };
    }
    if (!entry.commandInputMetadata.set({
        ...options,
        inputs,
        values: loadValues,
        ticket,
    })) {
        return { ok: false, status: 409, error: "Command inputs changed while loading. Reload inputs." };
    }
    return { ok: true, status: 200, inputs };
}

async function isLinkedGitWorktree(appHostPath) {
    let current = defaultCwdForAppHost(appHostPath, process.cwd());
    for (let depth = 0; depth < 12; depth++) {
        const gitPath = resolve(current, ".git");
        try {
            const info = await stat(gitPath);
            return info.isFile();
        } catch {
            const parent = dirname(current);
            if (parent === current) {
                return false;
            }
            current = parent;
        }
    }
    return false;
}

const APPHOST_OPERATIONS = {
    run: { label: "Starting...", title: "Start", command: "start" },
    stop: { label: "Stopping...", title: "Stop", command: "stop" },
    deploy: { label: "Deploying...", title: "Deploy", command: "deploy" },
    publish: { label: "Publishing...", title: "Publish", command: "publish" },
    "pipeline-step": { label: "Running pipeline step...", title: "Run step", command: "do" },
};

async function runAppHostOperation(entry, request) {
    const record = getHostRecord(entry, request?.appHostId);
    const operationName = String(request?.operation ?? "");
    const definition = APPHOST_OPERATIONS[operationName];
    if (!record || !definition) {
        return { ok: false, status: 404, error: "The AppHost action is no longer available." };
    }
    if (operationName === "run" && record.status === "running") {
        return { ok: false, status: 409, error: "The AppHost is already running." };
    }
    if (operationName === "stop" && record.status !== "running") {
        return { ok: false, status: 409, error: "The AppHost is not running." };
    }
    if (record.status !== "running" && record.buildable === false) {
        return { ok: false, status: 409, error: "Aspire could not confirm that this AppHost is buildable." };
    }
    const step = clampText(request?.step, 240);
    if (operationName === "pipeline-step" && !step) {
        return { ok: false, status: 400, error: "Choose or enter a pipeline step." };
    }

    try {
        const result = await entry.operationCoordinator.run(appHostOperationKey(record.appHostPath), {
            name: operationName,
            label: definition.label,
        }, async () => {
            rebuildTreeForOperations(entry);
            const args = [definition.command];
            if (operationName === "pipeline-step") {
                args.push(step);
            }
            args.push("--apphost", record.appHostPath);
            if (operationName === "run") {
                args.push("--format", "Json");
                if (await isLinkedGitWorktree(record.appHostPath)) {
                    args.push("--isolated");
                }
            }
            args.push("--non-interactive", "--nologo");
            return await runPreparedWithCompatibility(args, {
                cwd: defaultCwdForAppHost(record.appHostPath, entry.workingDirectory),
                timeoutMs: OPERATION_TIMEOUT_MS,
                maxOutputBytes: 2 * 1024 * 1024,
                commandLog: {
                    entry,
                    record,
                    source: "operation",
                    label: operationName === "pipeline-step"
                        ? `${definition.title} ${step} on ${record.displayName}`
                        : `${definition.title} ${record.displayName}`,
                    tailAppHostPath: operationName === "run" ? record.appHostPath : undefined,
                },
            });
        });
        if (!result.ok) {
            return {
                ok: false,
                status: 500,
                error: privateError(entry, result.error || `${definition.command} failed.`, [record]),
            };
        }
        return { ok: true, status: 200, operation: operationName };
    } catch (error) {
        return {
            ok: false,
            status: error?.code === "apphost_busy" ? 409 : 500,
            error: clampText(error?.message || error, 1000),
        };
    } finally {
        rebuildTreeForOperations(entry);
        await requestRefresh(entry, { force: true });
    }
}

async function listPipelineSteps(entry, appHostId) {
    const record = getHostRecord(entry, appHostId);
    if (!record) {
        return { ok: false, status: 404, error: "The AppHost is no longer available." };
    }
    const result = await runJsonWithCompatibility(
        ["do", "--list-steps", "--format", "Json", "--apphost", record.appHostPath],
        {
            cwd: defaultCwdForAppHost(record.appHostPath, entry.workingDirectory),
            timeoutMs: OPERATION_TIMEOUT_MS,
            commandLog: { entry, record, source: "user", label: `List pipeline steps for ${record.displayName}` },
        },
    );
    if (!result.ok) {
        const legacySteps = parseLegacyPipelineSteps(`${result.stderr ?? ""}\n${result.stdout ?? ""}`);
        if (legacySteps.length > 0) {
            return {
                ok: true,
                status: 200,
                steps: legacySteps.map((name) => ({ name, dependsOn: [], tags: [] })),
            };
        }
    }
    if (!result.ok || !Array.isArray(result.data)) {
        return {
            ok: false,
            status: 500,
            error: privateError(entry, result.error || "Pipeline steps could not be loaded.", [record]),
        };
    }
    const steps = result.data
        .filter((value) => value && typeof value === "object" && typeof value.name === "string")
        .map((value) => ({
            name: clampText(value.name, 240),
            description: clampText(value.description, 1000) || undefined,
            resourceName: clampText(value.resourceName, 240) || undefined,
            dependsOn: Array.isArray(value.dependsOn)
                ? value.dependsOn.map((item) => clampText(item, 240)).filter(Boolean)
                : [],
            tags: Array.isArray(value.tags)
                ? value.tags.map((item) => clampText(item, 120)).filter(Boolean)
                : [],
        }));
    return { ok: true, status: 200, steps };
}

async function openAppHostSource(entry, appHostId) {
    const record = getHostRecord(entry, appHostId);
    if (!record?.appHostPath || !isPathWithin(record.appHostPath, entry.workingDirectory)) {
        return { ok: false, error: "This AppHost source is outside the current workspace." };
    }
    let sourcePath = record.appHostPath;
    if (sourcePath.toLowerCase().endsWith(".csproj")) {
        for (const fileName of ["AppHost.cs", "apphost.cs", "Program.cs"]) {
            const candidate = resolve(dirname(sourcePath), fileName);
            try {
                const info = await stat(candidate);
                if (info.isFile()) {
                    sourcePath = candidate;
                    break;
                }
            } catch {
                // Try the next conventional AppHost source file.
            }
        }
    }
    const sourceRelativePath = relative(entry.workingDirectory, sourcePath).split(sep).join("/");
    if (typeof sessionRef?.rpc?.canvas?.open !== "function") {
        return { ok: false, error: "The editor canvas is unavailable." };
    }
    await sessionRef.rpc.canvas.open({
        canvasId: "editor",
        instanceId: `aspire-apphost-${record.id}`,
        input: {
            scope: "repo",
            path: sourceRelativePath,
            title: record.displayName,
            placement: { surface: "side", focus: true },
        },
    });
    return { ok: true };
}

function privateDashboardUrl(entry, record) {
    const model = modelForRecord(entry, record);
    const candidate = record.dashboardUrl
        || model?.resources?.find((resource) => resource.dashboardUrl)?.dashboardUrl;
    return buildDashboardViewUrl(candidate);
}

function browserErrorMessage(error) {
    const message = redactText(error?.message || error).replace(/https?:\/\/\S+/gi, "[url withheld]");
    return clampText(message, 1000);
}

async function openBrowserUrl(entry, { instanceId, url, title }) {
    const canvas = sessionRef?.rpc?.canvas;
    if (typeof canvas?.list === "function" && typeof canvas?.open === "function") {
        const { canvases } = await canvas.list();
        if (canvases.some((candidate) => candidate.canvasId === "browser")) {
            await canvas.open({
                canvasId: "browser",
                instanceId,
                input: {
                    url,
                    title,
                    placement: { surface: "side", focus: true },
                },
            });
            return { ok: true };
        }
    }
    await openSystemBrowser(url, {
        onError(error) {
            const message = browserErrorMessage(error);
            log(message, "error");
            broadcast(entry, { type: "browser-error", error: message });
        },
    });
    return { ok: true };
}

async function openAppHostDashboard(entry, appHostId) {
    const record = getHostRecord(entry, appHostId);
    const dashboardUrl = record ? privateDashboardUrl(entry, record) : undefined;
    if (!record || !dashboardUrl) {
        return { ok: false, error: "The dashboard URL is not available." };
    }
    return await openBrowserUrl(entry, {
        instanceId: `aspire-dashboard-${record.id}`,
        url: dashboardUrl,
        title: `${record.displayName} dashboard`,
    });
}

function currentResource(entry, nodeId) {
    const node = entry.nodeIndex.get(String(nodeId ?? ""));
    if (node?.kind !== "resource") {
        return {};
    }
    const { record, resource } = getResource(entry, node.appHostId, node.resourceName);
    return { node, record, resource };
}

const DASHBOARD_VIEW_TITLES = {
    details: "details",
    "console-logs": "console logs",
    "structured-logs": "structured logs",
    traces: "traces",
    metrics: "metrics",
};

async function openResourceDashboardView(entry, nodeId, view) {
    const { node, record, resource } = currentResource(entry, nodeId);
    if (!node || !record || !resource) {
        return { ok: false, error: "The resource is no longer available." };
    }
    const dashboardUrl = privateDashboardUrl(entry, record);
    const viewLabel = DASHBOARD_VIEW_TITLES[view];
    const resourceIdentifier = view === "details" ? resource.name : resource.displayName ?? resource.name;
    const url = dashboardUrl
        ? buildDashboardViewUrl(dashboardUrl, view, resourceIdentifier)
        : undefined;
    if (!viewLabel || !url) {
        return { ok: false, error: "This Dashboard view is not available." };
    }
    return await openBrowserUrl(entry, {
        instanceId: `aspire-dashboard-${record.id}`,
        url,
        title: `${record.displayName} ${viewLabel} (${node.label})`,
    });
}

async function openResourceEndpoint(entry, nodeId) {
    const node = entry.nodeIndex.get(String(nodeId ?? ""));
    const record = node?.appHostId ? getHostRecord(entry, node.appHostId) : undefined;
    if (node?.kind !== "endpoint" || !node.href || !record) {
        return { ok: false, error: "The endpoint is no longer available." };
    }
    let url;
    try {
        url = new URL(node.href);
    } catch {
        return { ok: false, error: "The endpoint URL is invalid." };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { ok: false, error: "Only HTTP and HTTPS endpoints can open in a browser." };
    }
    return await openBrowserUrl(entry, {
        instanceId: `aspire-endpoint-${stableId(node.id)}`,
        url: url.toString(),
        title: `${record.displayName}: ${node.label}`,
    });
}

async function openResourceTerminal(entry, nodeId) {
    const { node, record, resource } = currentResource(entry, nodeId);
    if (!node || !record || !resource) {
        return { ok: false, error: "The resource is no longer available." };
    }
    if (!node.terminalEnabled) {
        return { ok: false, error: "This resource does not expose an interactive terminal." };
    }
    const command = buildTerminalAttachCommand({
        resourceName: resource.name,
        appHostPath: record.appHostPath,
        replicaIndex: node.terminalReplicaIndex,
    });
    if (!command) {
        return { ok: false, error: "The terminal command could not be created." };
    }
    if (typeof sessionRef?.rpc?.canvas?.open !== "function") {
        return { ok: false, error: "The terminal canvas is unavailable." };
    }
    await sessionRef.rpc.canvas.open({
        canvasId: "terminal",
        instanceId: `aspire-terminal-${stableId(`${record.id}:${resource.name}`)}`,
        input: {
            command,
            title: `${node.label} terminal`,
            placement: { surface: "side", focus: true },
        },
    });
    return { ok: true };
}

async function handleRequest(entry, req, res) {
    const url = new URL(req.url, entry.origin);
    const authorizationError = authorizeRequest(entry, req, url);
    if (authorizationError) {
        return sendJson(res, 403, { ok: false, error: authorizationError });
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return serveAsset(res, "index.html");
    }
    if (req.method === "GET" && ["/styles.css", "/canvas-theme.css", "/canvas-icons.svg"].includes(url.pathname)) {
        return serveAsset(res, url.pathname.slice(1));
    }
    if (req.method === "GET" && url.pathname === "/app.js") {
        return serveAsset(res, "app.js");
    }
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
        return;
    }
    if (req.method === "GET" && url.pathname === "/events") {
        return addSseClient(entry, req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
        await requestRefresh(entry);
        return sendJson(res, 200, { ok: true, state: publicState(entry) });
    }
    if (req.method === "GET" && url.pathname === "/api/pipeline-steps") {
        const result = await listPipelineSteps(entry, url.searchParams.get("appHostId"));
        return sendJson(res, result.status, result);
    }

    if (req.method !== "POST") {
        return sendText(res, 404, "Not found");
    }

    let body;
    try {
        body = await readJsonBody(req);
    } catch (error) {
        const status = error?.status === 413 ? 413 : 400;
        if (error?.closeRequest) {
            res.setHeader("Connection", "close");
            res.once("finish", () => {
                req.socket.end();
                const destroyTimer = setTimeout(() => req.destroy(), 100);
                destroyTimer.unref?.();
            });
        }
        return sendJson(res, status, { ok: false, error: error.message });
    }

    if (url.pathname === "/api/refresh") {
        const state = await requestRefresh(entry, { force: true });
        return sendJson(res, 200, { ok: true, state });
    }
    if (url.pathname === "/api/mode") {
        if (body?.viewMode !== "workspace" && body?.viewMode !== "global") {
            return sendJson(res, 400, { ok: false, error: "viewMode must be 'workspace' or 'global'." });
        }
        if (entry.viewMode !== body.viewMode) {
            entry.viewMode = body.viewMode;
            entry.generation.invalidate();
            entry.selectionId = null;
            stopDescribeStreams(entry);
            publishState(entry, {
                viewMode: entry.viewMode,
                status: "loading",
                refreshing: true,
                error: null,
                ...clearedTree(entry),
            });
        }
        const state = await requestRefresh(entry, { force: true });
        return sendJson(res, 200, { ok: true, state });
    }
    if (url.pathname === "/api/preferences") {
        if (typeof body?.includeHidden !== "boolean") {
            return sendJson(res, 400, { ok: false, error: "includeHidden must be a boolean." });
        }
        entry.includeHidden = body.includeHidden;
        entry.generation.invalidate();
        stopDescribeStreams(entry);
        const state = await requestRefresh(entry, { force: true });
        return sendJson(res, 200, { ok: true, state });
    }
    if (url.pathname === "/api/selection") {
        const nodeId = String(body?.nodeId ?? "");
        if (!entry.nodeIndex.has(nodeId)) {
            return sendJson(res, 404, { ok: false, error: "The selected canvas item is no longer available." });
        }
        entry.selectionId = nodeId;
        return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === "/api/copilot-context") {
        const result = await attachCopilotContext(entry, body?.nodeId);
        return sendJson(res, result.ok ? 202 : 400, result);
    }
    if (url.pathname === "/api/open-source") {
        try {
            const result = await openAppHostSource(entry, body?.appHostId);
            return sendJson(res, result.ok ? 200 : 400, result);
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: clampText(error?.message || error, 1000) });
        }
    }
    if (url.pathname === "/api/open-dashboard") {
        try {
            const result = await openAppHostDashboard(entry, body?.appHostId);
            return sendJson(res, result.ok ? 200 : 400, result);
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: browserErrorMessage(error) });
        }
    }
    if (url.pathname === "/api/open-dashboard-view") {
        try {
            const result = await openResourceDashboardView(entry, body?.nodeId, body?.view);
            return sendJson(res, result.ok ? 200 : 400, result);
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: browserErrorMessage(error) });
        }
    }
    if (url.pathname === "/api/open-endpoint") {
        try {
            const result = await openResourceEndpoint(entry, body?.nodeId);
            return sendJson(res, result.ok ? 200 : 400, result);
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: browserErrorMessage(error) });
        }
    }
    if (url.pathname === "/api/open-terminal") {
        try {
            const result = await openResourceTerminal(entry, body?.nodeId);
            return sendJson(res, result.ok ? 200 : 400, result);
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: clampText(error?.message || error, 1000) });
        }
    }
    if (url.pathname === "/api/apphost-operation") {
        const result = await runAppHostOperation(entry, body);
        return sendJson(res, result.status, result);
    }
    if (url.pathname === "/api/command-inputs") {
        const result = await loadCommandInputs(entry, body);
        return sendJson(res, result.status, result);
    }
    if (url.pathname === "/api/command") {
        const result = await runResourceCommand(entry, body);
        return sendJson(res, result.status, result);
    }
    if (url.pathname === "/api/command-log/clear") {
        const result = clearCommandLog(entry);
        return sendJson(res, result.status, result);
    }

    sendText(res, 404, "Not found");
}

function canvasOpenInput(ctx) {
    return ctx.input && typeof ctx.input === "object" && !Array.isArray(ctx.input) ? ctx.input : {};
}

async function applyEntryInput(entry, input, workingDirectory) {
    assertLocalAppHostPath(workingDirectory || entry.workingDirectory);
    const nextWorkingDirectory = normalize(workingDirectory || entry.workingDirectory);
    const nextRequestedAppHostPath = Object.hasOwn(input, "appHostPath")
        ? await resolveRequestedAppHostPath(input.appHostPath, nextWorkingDirectory)
        : entry.requestedAppHostPath;
    let changed = nextWorkingDirectory !== entry.workingDirectory
        || nextRequestedAppHostPath !== entry.requestedAppHostPath;
    entry.workingDirectory = nextWorkingDirectory;
    entry.requestedAppHostPath = nextRequestedAppHostPath;
    let viewModeChanged = false;
    if (input.viewMode === "workspace" || input.viewMode === "global") {
        viewModeChanged = input.viewMode !== entry.viewMode;
        changed ||= viewModeChanged;
        entry.viewMode = input.viewMode;
    }
    if (typeof input.includeHidden === "boolean") {
        changed ||= input.includeHidden !== entry.includeHidden;
        entry.includeHidden = input.includeHidden;
    }

    if (!changed && !entry.discoveryStale) {
        return;
    }
    entry.generation.invalidate();
    entry.selectionId = null;
    stopDescribeStreams(entry);
    publishState(entry, {
        viewMode: entry.viewMode,
        includeHidden: entry.includeHidden,
        status: "loading",
        refreshing: true,
        error: null,
        ...(viewModeChanged ? clearedTree(entry) : {}),
    });
    const state = await requestRefresh(entry, { force: true });
    if (entry.discoveryStale) {
        throw new Error(state.error || "Unable to refresh AppHosts.");
    }
}

async function applyReopenInput(entry, ctx) {
    await applyEntryInput(
        entry,
        canvasOpenInput(ctx),
        ctx.session?.workingDirectory || sessionWorkingDirectory || entry.workingDirectory,
    );
}

async function startServer(ctx) {
    const input = canvasOpenInput(ctx);
    assertLocalAppHostPath(ctx.session?.workingDirectory || sessionWorkingDirectory || process.cwd());
    const workingDirectory = normalize(ctx.session?.workingDirectory || sessionWorkingDirectory || process.cwd());
    const viewMode = input.viewMode === "global" ? "global" : "workspace";
    const entry = {
        instanceId: ctx.instanceId,
        workingDirectory,
        requestedAppHostPath: await resolveRequestedAppHostPath(input.appHostPath, workingDirectory),
        viewMode,
        includeHidden: input.includeHidden === true,
        state: initialState(viewMode, input.includeHidden === true),
        stateSignature: stateSignature(initialState(viewMode, input.includeHidden === true)),
        hostRecords: new Map(),
        hostModels: new Map(),
        commandInputMetadata: new CommandInputMetadataStore(),
        commandInputLoads: new KeyedTaskQueue(),
        nodeIndex: new Map(),
        selectionId: null,
        snapshot: { candidates: [], runningHosts: [] },
        generation: new SnapshotGeneration(),
        operationCoordinator: appHostOperations,
        refreshPromise: null,
        refreshQueued: false,
        commandLog: [],
        commandSequence: 0,
        clients: new Set(),
        token: createToken(),
        server: null,
        origin: "",
        host: "",
        url: "",
        timer: null,
        pauseTimer: null,
        paused: false,
        describeStreams: new Map(),
        streamPublishTimer: null,
        discoveryWarning: null,
        closed: false,
    };

    const server = createServer((req, res) => {
        Promise.resolve(handleRequest(entry, req, res)).catch((error) => {
            log(`Aspire AppHosts request failed: ${error?.message ?? error}`, "error");
            if (!res.headersSent) {
                sendJson(res, 500, { ok: false, error: "Internal canvas error." });
            } else {
                res.end();
            }
        });
    });
    try {
        await new Promise((resolveListen, rejectListen) => {
            const cleanup = () => {
                server.off("error", onError);
                server.off("listening", onListening);
            };
            const onError = (error) => { cleanup(); rejectListen(error); };
            const onListening = () => { cleanup(); resolveListen(); };
            server.once("error", onError);
            server.once("listening", onListening);
            try {
                server.listen(0, "127.0.0.1");
            } catch (error) {
                onError(error);
            }
        });
    } catch (error) {
        server.close(() => {});
        throw error;
    }
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    entry.server = server;
    entry.origin = `http://127.0.0.1:${port}`;
    entry.host = `127.0.0.1:${port}`;
    entry.url = `${entry.origin}/?token=${encodeURIComponent(entry.token)}`;
    startPolling(entry);
    scheduleIdlePause(entry);
    void requestRefresh(entry);
    return entry;
}

async function closeEntry(entry) {
    entry.closed = true;
    entry.generation.invalidate();
    if (entry.timer) {
        clearInterval(entry.timer);
        entry.timer = null;
    }
    if (entry.pauseTimer) {
        clearTimeout(entry.pauseTimer);
        entry.pauseTimer = null;
    }
    stopDescribeStreams(entry);
    for (const item of entry.commandLog) {
        if (item.flushTimer) clearTimeout(item.flushTimer);
    }
    for (const client of entry.clients) {
        try {
            client.end();
        } catch {
            // The client may already be disconnected.
        }
    }
    entry.clients.clear();
    await new Promise((resolveClose) => entry.server.close(() => resolveClose()));
}

const appHostsCanvas = createCanvas({
    id: CANVAS_ID,
    displayName: "Aspire AppHosts",
    description:
        "Shows Aspire AppHosts in a canvas-native Workspace or Global resource board with endpoints, health, and commands.",
    inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
            appHostPath: {
                type: "string",
                description: "Optional AppHost path. Relative paths resolve from the active session working directory.",
            },
            includeHidden: {
                type: "boolean",
                description: "Include resources hidden by the AppHost.",
            },
            viewMode: {
                type: "string",
                enum: ["workspace", "global"],
                description: "Open in Workspace or Global mode.",
            },
        },
    },
    actions: [
        {
            name: "refresh_model",
            description: "Refresh AppHost discovery and the visible resource workspace.",
            inputSchema: { type: "object", additionalProperties: false, properties: {} },
            handler: async (ctx) => {
                const entry = instances.get(ctx.instanceId);
                if (!entry) {
                    throw new CanvasError("canvas_not_open", "The Aspire AppHosts canvas is not open.");
                }
                const state = await requestRefresh(entry, { force: true });
                return { viewMode: state.viewMode, status: state.status, summary: state.summary, stale: state.stale };
            },
        },
        {
            name: "set_view_mode",
            description: "Switch the canvas between Workspace and Global AppHost ownership modes.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["viewMode"],
                properties: {
                    viewMode: { type: "string", enum: ["workspace", "global"] },
                },
            },
            handler: async (ctx) => {
                const entry = instances.get(ctx.instanceId);
                if (!entry) {
                    throw new CanvasError("canvas_not_open", "The Aspire AppHosts canvas is not open.");
                }
                const viewMode = ctx.input?.viewMode;
                if (viewMode !== "workspace" && viewMode !== "global") {
                    throw new CanvasError("view_mode_required", "The set_view_mode action requires 'workspace' or 'global'.");
                }
                if (viewMode !== entry.viewMode) {
                    entry.viewMode = viewMode;
                    entry.generation.invalidate();
                    entry.selectionId = null;
                    stopDescribeStreams(entry);
                    publishState(entry, {
                        viewMode,
                        status: "loading",
                        refreshing: true,
                        error: null,
                        ...clearedTree(entry),
                    });
                }
                const state = await requestRefresh(entry, { force: true });
                return { viewMode: state.viewMode, status: state.status, summary: state.summary };
            },
        },
        {
            name: "get_selected_context",
            description: "Return sanitized context for the selected AppHost or resource item.",
            inputSchema: { type: "object", additionalProperties: false, properties: {} },
            handler: (ctx) => {
                const entry = instances.get(ctx.instanceId);
                if (!entry) {
                    throw new CanvasError("canvas_not_open", "The Aspire AppHosts canvas is not open.");
                }
                const node = entry.nodeIndex.get(entry.selectionId);
                if (!node) {
                    throw new CanvasError("selection_missing", "No current canvas selection is available.");
                }
                return nodeContext(entry, node);
            },
        },
    ],
    open: async (ctx) => {
        let entry = instances.get(ctx.instanceId);
        if (!entry) {
            let pending = pendingOpens.get(ctx.instanceId);
            if (!pending) {
                pending = { closed: false };
                pendingOpens.set(ctx.instanceId, pending);
                pending.promise = startServer(ctx).then(async (created) => {
                    if (pending.closed) {
                        await closeEntry(created);
                        throw new CanvasError("canvas_closed", "The canvas was closed while opening.");
                    }
                    instances.set(ctx.instanceId, created);
                    return created;
                }).finally(() => {
                    if (pendingOpens.get(ctx.instanceId) === pending) {
                        pendingOpens.delete(ctx.instanceId);
                    }
                });
            }
            entry = await pending.promise;
            if (pending.closed || entry.closed) {
                throw new CanvasError("canvas_closed", "The canvas was closed while opening.");
            }
            log(`Aspire AppHosts canvas opened (instance '${ctx.instanceId}').`);
        } else {
            try {
                await applyReopenInput(entry, ctx);
            } catch (error) {
                const hasRoots = entry.state.roots.length > 0;
                publishState(entry, {
                    status: hasRoots ? "stale" : "error",
                    refreshing: false,
                    stale: hasRoots,
                    error: clampText(error?.message || error, 500),
                });
                throw error;
            }
        }
        if (entry.closed) {
            throw new CanvasError("canvas_closed", "The canvas was closed while opening.");
        }
        return { title: "Aspire AppHosts", status: "AppHost workbench", url: entry.url };
    },
    onClose: async (ctx) => {
        const pending = pendingOpens.get(ctx.instanceId);
        if (pending) {
            pending.closed = true;
            const created = await pending.promise.catch(() => undefined);
            if (created) {
                if (instances.get(ctx.instanceId) === created) {
                    instances.delete(ctx.instanceId);
                }
                await closeEntry(created);
            }
            return;
        }
        const entry = instances.get(ctx.instanceId);
        if (!entry) {
            return;
        }
        instances.delete(ctx.instanceId);
        await closeEntry(entry);
    },
});

const openTool = {
    name: "open_aspire_apphosts",
    description:
        "Open or focus the Aspire AppHosts workbench, optionally targeting an AppHost or Global mode.",
    parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
            appHostPath: { type: "string", description: "Optional AppHost project path or directory." },
            includeHidden: { type: "boolean", description: "Include resources hidden by the AppHost." },
            viewMode: { type: "string", enum: ["workspace", "global"], description: "Workspace or Global mode." },
            instanceId: { type: "string", description: "Optional stable canvas panel identifier." },
        },
    },
    handler: async (args) => {
        const instanceId = String(args?.instanceId ?? "").trim() || DEFAULT_INSTANCE;
        if (typeof sessionRef?.rpc?.canvas?.open !== "function") {
            return {
                textResultForLlm: "Failed to open the Aspire AppHosts canvas: the canvas host is unavailable.",
                resultType: "failure",
            };
        }
        try {
            const input = {
                ...(args?.appHostPath ? { appHostPath: args.appHostPath } : {}),
                ...(typeof args?.includeHidden === "boolean" ? { includeHidden: args.includeHidden } : {}),
                ...(args?.viewMode ? { viewMode: args.viewMode } : {}),
            };
            const existing = instances.get(instanceId);
            if (existing) {
                await applyEntryInput(existing, input, sessionWorkingDirectory || existing.workingDirectory);
            }
            await sessionRef.rpc.canvas.open({
                canvasId: CANVAS_ID,
                instanceId,
                input,
            });
            return `Opened the Aspire AppHosts canvas (instance '${instanceId}').`;
        } catch (error) {
            return {
                textResultForLlm: `Failed to open the Aspire AppHosts canvas: ${error?.message ?? error}`,
                resultType: "failure",
            };
        }
    },
};

function onSessionStart(input) {
    if (input?.workingDirectory) {
        sessionWorkingDirectory = normalize(input.workingDirectory);
    }
    return {
        additionalContext:
            "An 'Aspire AppHosts' canvas is available through 'open_aspire_apphosts'. Open it when " +
            "the user wants to inspect or operate Aspire AppHosts and resources. It preserves Workspace/Global " +
            "operational behavior in a canvas-native workbench, keeps private AppHost data provider-side, and never starts an AppHost implicitly.",
    };
}

sessionRef = await joinSession({
    canvases: [appHostsCanvas],
    tools: [openTool],
    hooks: { onSessionStart },
});
