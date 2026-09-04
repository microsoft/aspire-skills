// Extension: aspire-app-model
//
// Canvas-native Aspire AppHost workbench for GitHub Copilot.

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import {
    AppHostOperationCoordinator,
    CommandInputMetadataStore,
    KeyedTaskQueue,
    SnapshotGeneration,
    appHostOperationKey,
    buildDashboardViewUrl,
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
    parseLegacyPipelineSteps,
    projectDescribePayload,
    redactAbsolutePaths,
    redactKnownPaths,
    redactText,
    resolveRequestedAppHostPath,
    runWithOptionalFlagFallback,
    sanitizeCommandArgumentInputs,
    stableId,
    validateCommandArguments,
} from "./lib/app-model.mjs";

const CANVAS_ID = "aspire-app-model";
const DEFAULT_INSTANCE = "aspire-app-model-main";
const UI_DIR = new URL("./ui/", import.meta.url);
const UI_ROOT = fileURLToPath(UI_DIR);
const POLL_INTERVAL_MS = 3_000;
const CLI_TIMEOUT_MS = 30_000;
const OPERATION_TIMEOUT_MS = 30 * 60_000;
const GLOBAL_DESCRIBE_CONCURRENCY = 4;
const TOKEN_BYTES = 32;
const AUTH_HEADER = "x-aspire-app-model-token";
const MAX_BODY_BYTES = 128 * 1024;

const CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
};

const instances = new Map();
const cli = createAspireCliRunner();
const appHostOperations = new AppHostOperationCoordinator();
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
        const body = await readFile(fileUrl);
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
        let tooLarge = false;
        const chunks = [];
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                tooLarge = true;
                chunks.length = 0;
                return;
            }
            if (!tooLarge) {
                chunks.push(chunk);
            }
        });
        req.once("end", () => {
            if (tooLarge) {
                const error = new Error("Request body is too large.");
                error.status = 413;
                reject(error);
                return;
            }
            try {
                resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
            } catch {
                reject(new Error("Request body is not valid JSON."));
            }
        });
        req.once("error", reject);
    });
}

function addSseClient(entry, req, res) {
    res.writeHead(200, {
        ...securityHeaders("text/event-stream"),
        Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    entry.clients.add(res);
    req.once("close", () => entry.clients.delete(res));
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

function initialState(viewMode, includeHidden) {
    return {
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

function publishState(entry, nextState) {
    const candidate = {
        ...entry.state,
        ...nextState,
        generatedAt: new Date().toISOString(),
    };
    const signature = JSON.stringify({
        ...candidate,
        generatedAt: undefined,
        lastSuccessfulAt: undefined,
    });
    entry.state = candidate;
    if (signature === entry.stateSignature) {
        if ((candidate.status === "ready" || candidate.status === "empty") && candidate.lastSuccessfulAt) {
            broadcast(entry, { type: "freshness", lastSuccessfulAt: candidate.lastSuccessfulAt });
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

async function runPreparedWithCompatibility(args, options = {}) {
    let result = await cli.run(args, options);
    if (!result.ok && args.includes("--nologo") && isNoLogoUnsupported(result)) {
        result = await cli.run(args.filter((argument) => argument !== "--nologo"), options);
    }
    return result;
}

async function runJsonWithCompatibility(args, options = {}) {
    const prepared = [...args, "--non-interactive", "--nologo"];
    const result = await runPreparedWithCompatibility(prepared, options);
    return {
        ...result,
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

async function discoverWorkspaceCandidates(entry) {
    if (entry.requestedAppHostPath) {
        return {
            candidates: [candidateFromPath(entry, entry.requestedAppHostPath)],
            warning: null,
        };
    }

    const result = await runJsonWithCompatibility(
        ["ls", "--format", "Json"],
        { cwd: entry.workingDirectory, timeoutMs: CLI_TIMEOUT_MS },
    );
    if (result.ok && Array.isArray(result.data)) {
        return {
            candidates: normalizeLsPayload(result.data).map((record) => ({
                ...record,
                relativePath: relativeWorkspacePath(entry, record.appHostPath),
            })),
            warning: null,
        };
    }

    const fallbackPaths = await discoverConfiguredAppHosts(entry.workingDirectory);
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

function countResources(models) {
    let total = 0;
    for (const model of models.values()) {
        total += model.resources?.length ?? 0;
    }
    return total;
}

function buildRoots(entry, candidates, runningHosts, models) {
    const records = entry.viewMode === "workspace"
        ? [...combineWorkspaceAppHosts(candidates, runningHosts).running, ...combineWorkspaceAppHosts(candidates, runningHosts).idle]
        : runningHosts;
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
    entry.commandInputMetadata.prune(({ appHostId, resourceName, commandName }) => {
        const { record, resource } = getResource(entry, appHostId, resourceName);
        return Boolean(record && resource?.commands.some((command) => command.name === commandName));
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
        { cwd: entry.workingDirectory, timeoutMs: CLI_TIMEOUT_MS },
    );
    const candidatePromise = viewMode === "workspace"
        ? discoverWorkspaceCandidates(entry)
        : Promise.resolve({ candidates: [], warning: null });
    const [psResult, candidateResult] = await Promise.all([psPromise, candidatePromise]);

    if (!entry.generation.isCurrent(generation) || entry.closed || entry.viewMode !== viewMode) {
        return;
    }

    if (!psResult.ok || !Array.isArray(psResult.data)) {
        const error = privateError(entry, psResult.error || "Unable to list running AppHosts.");
        publishState(entry, {
            status: entry.state.roots.length > 0 ? "stale" : "error",
            refreshing: false,
            stale: entry.state.roots.length > 0,
            error,
        });
        return;
    }

    const allRunning = normalizePsPayload(psResult.data)
        .filter((record) => record.status === "running");
    const candidates = candidateResult.candidates;
    const runningHosts = viewMode === "workspace"
        ? workspaceRunningHosts(entry, candidates, allRunning)
        : allRunning;

    const modelEntries = await mapWithConcurrency(
        runningHosts,
        GLOBAL_DESCRIBE_CONCURRENCY,
        async (record) => [
            record.id,
            await describeAppHost(entry, record, entry.hostModels.get(record.id)),
        ],
    );
    if (!entry.generation.isCurrent(generation) || entry.closed || entry.viewMode !== viewMode) {
        return;
    }

    const models = new Map(modelEntries);
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
    const error = candidateResult.warning
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

function commandWithCurrentInputs(entry, record, resource, command) {
    return {
        ...command,
        argumentInputs: commandInputsFor(entry, record, resource, command),
    };
}

function submittedSecretValues(command, values) {
    return command.argumentInputs
        .filter((input) => input.inputType.toLowerCase().includes("secret"))
        .map((input) => values?.[input.name])
        .filter((value) => value !== undefined && value !== null && String(value) !== "");
}

function publicCommandText(entry, record, value, max, sensitiveValues) {
    const text = redactText(value, max, sensitiveValues);
    return redactAbsolutePaths(redactKnownPaths(text, [entry.workingDirectory, record.appHostPath]));
}

function nodeContext(node) {
    const context = {
        kind: node.kind,
        label: node.label,
        description: node.description,
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
    return context;
}

async function attachCopilotContext(entry, nodeId) {
    const node = entry.nodeIndex.get(String(nodeId ?? ""));
    if (!node) {
        return { ok: false, error: "The selected canvas item is no longer available." };
    }
    if (typeof sessionRef?.rpc?.extensions?.sendAttachmentsToMessage !== "function") {
        return { ok: false, error: "The Copilot composer is not available." };
    }
    await sessionRef.rpc.extensions.sendAttachmentsToMessage({
        instanceId: entry.instanceId,
        attachments: [{
            type: "extension_context",
            title: `Aspire: ${node.label}`,
            payload: nodeContext(node),
        }],
    });
    return { ok: true, title: node.label };
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

    const currentCommand = commandWithCurrentInputs(entry, record, resource, command);
    const validation = validateCommandArguments(currentCommand, request?.arguments ?? {});
    if (!validation.ok) {
        return {
            ok: false,
            status: 400,
            error: "Command arguments are invalid.",
            validationErrors: validation.errors,
        };
    }
    const sensitiveValues = submittedSecretValues(currentCommand, validation.values);

    let result;
    let operationStarted = false;
    try {
        result = await entry.operationCoordinator.run(
            appHostOperationKey(record.appHostPath),
            { name: "resource-command", label: `Running ${command.displayName}...` },
            async () => {
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
                    },
                );
            },
        );
    } catch (error) {
        return {
            ok: false,
            status: error?.code === "apphost_busy" ? 409 : 500,
            error: clampText(error?.message || error, 1000),
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

function dynamicArgumentTokens(argumentInputs, values) {
    const declared = new Set(argumentInputs.map((input) => input.name));
    return buildCommandArgumentTokens(
        Object.fromEntries(Object.entries(values ?? {}).filter(([name]) => declared.has(name))),
    );
}

function commandInputLoadKey(request) {
    return JSON.stringify([
        String(request?.appHostId ?? ""),
        String(request?.resourceName ?? ""),
        String(request?.commandName ?? ""),
    ]);
}

async function loadCommandInputs(entry, request) {
    return entry.commandInputLoads.run(
        commandInputLoadKey(request),
        () => loadCommandInputsNow(entry, request),
    );
}

async function loadCommandInputsNow(entry, request) {
    const { record, resource } = getResource(entry, request?.appHostId, String(request?.resourceName ?? ""));
    if (!record || !resource) {
        return { ok: false, status: 404, error: "The resource is no longer available." };
    }
    const command = resource.commands.find((candidate) => candidate.name === String(request?.commandName ?? ""));
    if (!command) {
        return { ok: false, status: 404, error: "The resource command is no longer available." };
    }
    const currentInputs = commandInputsFor(entry, record, resource, command);
    const sensitiveValues = submittedSecretValues(
        { ...command, argumentInputs: currentInputs },
        request?.arguments ?? {},
    );
    const args = [
        "resource",
        resource.name,
        command.name,
        "--apphost",
        record.appHostPath,
        "--load-arguments",
        "--non-interactive",
        "--nologo",
        ...dynamicArgumentTokens(currentInputs, request?.arguments),
    ];
    const result = await runPreparedWithCompatibility(args, {
        cwd: defaultCwdForAppHost(record.appHostPath, entry.workingDirectory),
        timeoutMs: CLI_TIMEOUT_MS,
    });
    const payload = result.ok ? extractJsonPayload(result.stdout) : undefined;
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
    entry.commandInputMetadata.set({
        appHostId: record.id,
        resourceName: resource.name,
        commandName: command.name,
        baseInputs: command.argumentInputs,
        inputs,
    });
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
    run: { label: "Starting...", command: "start" },
    stop: { label: "Stopping...", command: "stop" },
    deploy: { label: "Deploying...", command: "deploy" },
    publish: { label: "Publishing...", command: "publish" },
    "pipeline-step": { label: "Running pipeline step...", command: "do" },
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

async function openBrowserCanvas({ instanceId, url, title }) {
    if (typeof sessionRef?.rpc?.canvas?.open !== "function") {
        return { ok: false, error: "The integrated browser canvas is unavailable." };
    }
    await sessionRef.rpc.canvas.open({
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

async function openAppHostDashboard(entry, appHostId) {
    const record = getHostRecord(entry, appHostId);
    const dashboardUrl = record ? privateDashboardUrl(entry, record) : undefined;
    if (!record || !dashboardUrl) {
        return { ok: false, error: "The dashboard URL is not available." };
    }
    return await openBrowserCanvas({
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
    const url = dashboardUrl
        ? buildDashboardViewUrl(dashboardUrl, view, resource.displayName ?? resource.name)
        : undefined;
    if (!viewLabel || !url) {
        return { ok: false, error: "This Dashboard view is not available." };
    }
    return await openBrowserCanvas({
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
        return { ok: false, error: "Only HTTP and HTTPS endpoints can open in the integrated browser." };
    }
    return await openBrowserCanvas({
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
    if (req.method === "GET" && url.pathname === "/styles.css") {
        return serveAsset(res, "styles.css");
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
        return sendJson(res, error?.status === 413 ? 413 : 400, { ok: false, error: error.message });
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
            publishState(entry, { viewMode: entry.viewMode, status: "loading", refreshing: true, error: null });
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
            return sendJson(res, 500, { ok: false, error: clampText(error?.message || error, 1000) });
        }
    }
    if (url.pathname === "/api/open-dashboard-view") {
        try {
            const result = await openResourceDashboardView(entry, body?.nodeId, body?.view);
            return sendJson(res, result.ok ? 200 : 400, result);
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: clampText(error?.message || error, 1000) });
        }
    }
    if (url.pathname === "/api/open-endpoint") {
        try {
            const result = await openResourceEndpoint(entry, body?.nodeId);
            return sendJson(res, result.ok ? 200 : 400, result);
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: clampText(error?.message || error, 1000) });
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

    sendText(res, 404, "Not found");
}

function canvasOpenInput(ctx) {
    return ctx.input && typeof ctx.input === "object" && !Array.isArray(ctx.input) ? ctx.input : {};
}

async function applyEntryInput(entry, input, workingDirectory) {
    const nextWorkingDirectory = normalize(workingDirectory || entry.workingDirectory);
    const nextRequestedAppHostPath = Object.hasOwn(input, "appHostPath")
        ? await resolveRequestedAppHostPath(input.appHostPath, nextWorkingDirectory)
        : entry.requestedAppHostPath;
    let changed = nextWorkingDirectory !== entry.workingDirectory
        || nextRequestedAppHostPath !== entry.requestedAppHostPath;
    entry.workingDirectory = nextWorkingDirectory;
    entry.requestedAppHostPath = nextRequestedAppHostPath;
    if (input.viewMode === "workspace" || input.viewMode === "global") {
        changed ||= input.viewMode !== entry.viewMode;
        entry.viewMode = input.viewMode;
    }
    if (typeof input.includeHidden === "boolean") {
        changed ||= input.includeHidden !== entry.includeHidden;
        entry.includeHidden = input.includeHidden;
    }

    if (!changed) {
        return;
    }
    entry.generation.invalidate();
    entry.selectionId = null;
    publishState(entry, {
        viewMode: entry.viewMode,
        includeHidden: entry.includeHidden,
        status: "loading",
        refreshing: true,
        error: null,
    });
    await requestRefresh(entry, { force: true });
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
    const workingDirectory = normalize(ctx.session?.workingDirectory || sessionWorkingDirectory || process.cwd());
    const viewMode = input.viewMode === "global" ? "global" : "workspace";
    const entry = {
        instanceId: ctx.instanceId,
        workingDirectory,
        requestedAppHostPath: await resolveRequestedAppHostPath(input.appHostPath, workingDirectory),
        viewMode,
        includeHidden: input.includeHidden === true,
        state: initialState(viewMode, input.includeHidden === true),
        stateSignature: null,
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
        clients: new Set(),
        token: createToken(),
        server: null,
        origin: "",
        host: "",
        url: "",
        timer: null,
        closed: false,
    };

    const server = createServer((req, res) => {
        Promise.resolve(handleRequest(entry, req, res)).catch((error) => {
            log(`Aspire App Model request failed: ${error?.message ?? error}`, "error");
            if (!res.headersSent) {
                sendJson(res, 500, { ok: false, error: "Internal canvas error." });
            } else {
                res.end();
            }
        });
    });
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    entry.server = server;
    entry.origin = `http://127.0.0.1:${port}`;
    entry.host = `127.0.0.1:${port}`;
    entry.url = `${entry.origin}/?token=${encodeURIComponent(entry.token)}`;
    entry.timer = setInterval(() => void requestRefresh(entry), POLL_INTERVAL_MS);
    entry.timer.unref?.();
    instances.set(ctx.instanceId, entry);
    void requestRefresh(entry);
    return entry;
}

async function closeEntry(entry) {
    entry.closed = true;
    entry.generation.invalidate();
    if (entry.timer) {
        clearInterval(entry.timer);
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

const appModelCanvas = createCanvas({
    id: CANVAS_ID,
    displayName: "Aspire App Model",
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
                    throw new CanvasError("canvas_not_open", "The Aspire App Model canvas is not open.");
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
                    throw new CanvasError("canvas_not_open", "The Aspire App Model canvas is not open.");
                }
                const viewMode = ctx.input?.viewMode;
                if (viewMode !== "workspace" && viewMode !== "global") {
                    throw new CanvasError("view_mode_required", "The set_view_mode action requires 'workspace' or 'global'.");
                }
                entry.viewMode = viewMode;
                entry.generation.invalidate();
                entry.selectionId = null;
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
                    throw new CanvasError("canvas_not_open", "The Aspire App Model canvas is not open.");
                }
                const node = entry.nodeIndex.get(entry.selectionId);
                if (!node) {
                    throw new CanvasError("selection_missing", "No current canvas selection is available.");
                }
                return nodeContext(node);
            },
        },
    ],
    open: async (ctx) => {
        let entry = instances.get(ctx.instanceId);
        if (!entry) {
            entry = await startServer(ctx);
            log(`Aspire App Model canvas opened (instance '${ctx.instanceId}').`);
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
            }
        }
        return { title: "Aspire App Model", status: "AppHost workbench", url: entry.url };
    },
    onClose: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) {
            return;
        }
        instances.delete(ctx.instanceId);
        await closeEntry(entry);
    },
});

const openTool = {
    name: "open_aspire_app_model",
    description:
        "Open or focus the Aspire App Model workbench, optionally targeting an AppHost or Global mode.",
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
                textResultForLlm: "Failed to open the Aspire App Model canvas: the canvas host is unavailable.",
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
            return `Opened the Aspire App Model canvas (instance '${instanceId}').`;
        } catch (error) {
            return {
                textResultForLlm: `Failed to open the Aspire App Model canvas: ${error?.message ?? error}`,
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
            "An 'Aspire App Model' canvas is available through 'open_aspire_app_model'. Open it when " +
            "the user wants to inspect or operate Aspire AppHosts and resources. It preserves Workspace/Global " +
            "operational behavior in a canvas-native workbench, keeps private AppHost data provider-side, and never starts an AppHost implicitly.",
    };
}

sessionRef = await joinSession({
    canvases: [appModelCanvas],
    tools: [openTool],
    hooks: { onSessionStart },
});
