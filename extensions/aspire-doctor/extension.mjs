// Extension: aspire-doctor
//
// Interactive Copilot canvas for `aspire doctor`.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import {
    listenOnLoopback,
    readJsonBody,
    requestErrorStatus,
    runLatestDiagnostics,
} from "./provider-helpers.mjs";
import { normalizeDoctorData } from "./ui/model.mjs";

const CANVAS_ID = "aspire-doctor";
const DEFAULT_INSTANCE = "doctor-main";

const ASPIRE_DOCTOR_TOOL_NAME = "aspire-doctor";

const UI_DIR = new URL("./ui/", import.meta.url);
const UI_ROOT = fileURLToPath(UI_DIR);

const CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
};

const DOCTOR_TIMEOUT_MS = 60_000;
const TOKEN_BYTES = 32;
const AUTH_HEADER = "x-aspire-doctor-token";

const EDITOR_FILE_EXTENSIONS = new Set([
    ".cs",
    ".csproj",
    ".fs",
    ".fsproj",
    ".props",
    ".targets",
    ".json",
    ".jsonc",
    ".md",
    ".txt",
    ".yml",
    ".yaml",
    ".xml",
]);

const instances = new Map();

let sessionRef;

function log(message, level = "info") {
    try {
        sessionRef?.log?.(message, { level, ephemeral: true });
    } catch {
        /* logging is best-effort */
    }
}

/* ---------------- static assets ---------------- */

async function serveAsset(res, name) {
    const fileUrl = new URL(name, UI_DIR);
    // Guard against path traversal: the resolved file must stay under ui/.
    const resolved = fileURLToPath(fileUrl);
    if (!resolved.startsWith(UI_ROOT)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
    }

    try {
        const body = await readFile(fileUrl);
        res.writeHead(200, {
            "Content-Type": CONTENT_TYPES[extname(name)] ?? "application/octet-stream",
            "Cache-Control": "no-store",
        });
        res.end(body);
    } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
    }
}

function sendJson(res, status, payload) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(payload));
}

function sendForbidden(res, message = "Forbidden") {
    sendJson(res, 403, { ok: false, error: message });
}

function createToken() {
    return randomBytes(TOKEN_BYTES).toString("base64url");
}

function tokensMatch(actual, expected) {
    const actualBuffer = Buffer.from(String(actual ?? ""), "utf8");
    const expectedBuffer = Buffer.from(String(expected ?? ""), "utf8");
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function getRequestToken(req, url) {
    const headerValue = req.headers[AUTH_HEADER];
    if (Array.isArray(headerValue)) {
        return headerValue[0] ?? "";
    }
    return headerValue || url.searchParams.get("token") || "";
}

function isProtectedPath(path) {
    return path === "/events" || path.startsWith("/api/");
}

function isAllowedHost(req, entry) {
    return String(req.headers.host ?? "").toLowerCase() === entry.host;
}

function isAllowedOrigin(req, entry) {
    const origin = req.headers.origin;
    if (!origin) {
        return true;
    }
    return String(origin).toLowerCase() === entry.origin;
}

function authorizeRequest(entry, req, url, path) {
    if (!isAllowedHost(req, entry)) {
        return "Unexpected request host.";
    }
    if (!isAllowedOrigin(req, entry)) {
        return "Unexpected request origin.";
    }
    if (isProtectedPath(path) && !tokensMatch(getRequestToken(req, url), entry.token)) {
        return "Missing or invalid Aspire Doctor token.";
    }
    return null;
}

/* ---------------- server-sent events ---------------- */

function addSseClient(entry, req, res) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    entry.clients.add(res);
    req.on("close", () => entry.clients.delete(res));
}

function broadcast(entry, payload) {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of entry.clients) {
        try {
            client.write(frame);
        } catch {
            entry.clients.delete(client);
        }
    }
}

/* ---------------- aspire doctor subprocess ---------------- */

function resolveCli() {
    const override = process.env.ASPIRE_CLI?.trim();
    if (override) {
        const useShell = process.platform === "win32" && [".cmd", ".bat"].includes(extname(override).toLowerCase());
        return { command: useShell ? `"${override}"` : override, useShell };
    }
    // Bare "aspire" relies on PATH. On Windows the CLI is `aspire.cmd`/`aspire.exe`,
    // which execFile-style spawning won't resolve via PATHEXT — so route through
    // the shell there. Args are static and trusted, so shell use is safe.
    return { command: "aspire", useShell: process.platform === "win32" };
}

// `aspire doctor --format Json` prints a human preamble before the JSON object.
function extractJson(text) {
    const start = text.indexOf("{");
    if (start === -1) {
        return null;
    }

    const candidate = text.slice(start);
    try {
        return JSON.parse(candidate);
    } catch {
        /* try trimming trailing noise */
    }

    const end = candidate.lastIndexOf("}");
    if (end !== -1) {
        try {
            return JSON.parse(candidate.slice(0, end + 1));
        } catch {
            /* give up */
        }
    }
    return null;
}

async function runDoctor() {
    const { command, useShell } = resolveCli();
    const args = ["doctor", "--format", "Json", "--non-interactive", "--nologo"];

    return await new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        let child;

        const finish = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };

        const timer = setTimeout(() => {
            try {
                child?.kill();
            } catch {
                /* ignore */
            }
            finish({ ok: false, error: `'aspire doctor' timed out after ${DOCTOR_TIMEOUT_MS / 1000}s.` });
        }, DOCTOR_TIMEOUT_MS);

        try {
            child = spawn(command, args, { shell: useShell, windowsHide: true });
        } catch (err) {
            finish({ ok: false, error: `Failed to launch '${command}': ${err.message}` });
            return;
        }

        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", (err) => {
            finish({
                ok: false,
                error: `Failed to run '${command}': ${err.message}. Set the ASPIRE_CLI environment variable to the aspire executable if it is not on PATH.`,
            });
        });
        child.on("close", (code) => {
            // Warn/fail checks can produce a non-zero exit code; parse the report anyway.
            const parsed = extractJson(stdout);
            if (!parsed) {
                finish({
                    ok: false,
                    error: `Could not parse 'aspire doctor' output${code ? ` (exit code ${code})` : ""}.`,
                    raw: (stderr || stdout).slice(0, 4000),
                });
                return;
            }
            finish({
                ok: true,
                data: { ...parsed, generatedAt: new Date().toISOString(), exitCode: code },
            });
        });
    });
}

async function runDiagnosticsForEntry(entry, { broadcastResult = false } = {}) {
    const publishCurrent = broadcastResult
        ? (result) => broadcast(entry, { type: "diagnostics", result })
        : undefined;
    return await runLatestDiagnostics(entry, runDoctor, publishCurrent);
}

/* ---------------- Ask Copilot dispatch ---------------- */

function clamp(value, max = 600) {
    const text = String(value ?? "").trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

function buildAskCopilotPrompt(check) {
    const name = clamp(check?.name, 120) || "an Aspire environment check";
    const category = clamp(check?.category, 60);
    const status = clamp(check?.status, 20);
    const message = clamp(check?.message);
    const fix = clamp(check?.fix, 800);

    const lines = [
        `The Aspire Doctor canvas flagged an environment check that needs attention.`,
        ``,
        `- Check: ${name}${category ? ` (${category})` : ""}${status ? ` — ${status}` : ""}`,
    ];
    if (message) {
        lines.push(`- Problem: ${message}`);
    }
    if (fix) {
        lines.push(`- Suggested fix: ${fix}`);
    }
    lines.push(
        ``,
        `Please help resolve this check — run the required command(s) or make the necessary ` +
            `changes, explaining what you're doing. If it isn't safe to do automatically ` +
            `(for example it needs elevation or would change global state), tell me the ` +
            `exact steps instead. The Aspire Doctor canvas will refresh diagnostics after ` +
            `this turn completes.`,
    );
    return lines.join("\n");
}

async function openTerminalForCheck(check) {
    if (typeof sessionRef?.rpc?.canvas?.open !== "function") {
        return { ok: false, error: "The canvas host is not available to open a terminal." };
    }

    const key = `${check?.category ?? "unknown"}:${check?.name ?? "check"}`;

    await sessionRef.rpc.canvas.open({
        canvasId: "terminal",
        instanceId: `doctor-terminal-${stableId(key)}`,
        input: {
            title: "Aspire Doctor terminal",
            placement: { surface: "side", focus: true },
        },
    });

    return { ok: true };
}

async function dispatchFixAndRefresh(entry, check) {
    const send = sessionRef?.sendAndWait ?? sessionRef?.send;
    if (typeof send !== "function") {
        return { ok: false, error: "The agent session is not available to receive the fix request." };
    }

    const prompt = buildAskCopilotPrompt(check);
    // Queue the Copilot turn immediately, then refresh Doctor in the background.
    void (async () => {
        try {
            await send.call(sessionRef, { prompt });
            await runDiagnosticsForEntry(entry, { broadcastResult: true });
        } catch (err) {
            log(`Failed to refresh Aspire Doctor after Ask Copilot: ${err?.message ?? err}`, "warn");
        }
    })();

    return { ok: true, refreshQueued: true };
}

/* ---------------- path actions ---------------- */

function stableId(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

function resolveUserPath(value) {
    const text = String(value ?? "").trim();
    if (!text) {
        return null;
    }

    if (text.startsWith("file://")) {
        try {
            return fileURLToPath(text);
        } catch {
            return null;
        }
    }

    if (isAbsolute(text)) {
        return normalize(text);
    }

    const workspacePath = sessionRef?.workspacePath;
    return workspacePath ? resolve(workspacePath, text) : null;
}

function getRepoRelativePath(absolutePath) {
    const workspacePath = sessionRef?.workspacePath;
    if (!workspacePath) {
        return null;
    }

    const relativePath = relative(workspacePath, absolutePath);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
        return null;
    }

    return relativePath.split(sep).join("/");
}

function shouldOpenInEditor(absolutePath, stats) {
    return stats.isFile() && EDITOR_FILE_EXTENSIONS.has(extname(absolutePath).toLowerCase());
}

async function revealInFileManager(absolutePath, stats) {
    let command;
    let args;

    if (process.platform === "win32") {
        command = "explorer.exe";
        args = stats.isFile() ? [`/select,${absolutePath}`] : [absolutePath];
    } else if (process.platform === "darwin") {
        command = "open";
        args = stats.isFile() ? ["-R", absolutePath] : [absolutePath];
    } else {
        command = "xdg-open";
        args = [stats.isDirectory() ? absolutePath : dirname(absolutePath)];
    }

    await new Promise((resolve, reject) => {
        const child = spawn(command, args, { detached: true, stdio: "ignore" });
        child.once("error", reject);
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });
}

async function openPath(value) {
    const absolutePath = resolveUserPath(value);
    if (!absolutePath) {
        return { ok: false, error: "No path was provided." };
    }

    let stats;
    try {
        stats = await stat(absolutePath);
    } catch {
        return { ok: false, error: `Path not found: ${absolutePath}` };
    }

    const repoRelativePath = getRepoRelativePath(absolutePath);
    if (repoRelativePath && shouldOpenInEditor(absolutePath, stats) && typeof sessionRef?.rpc?.canvas?.open === "function") {
        await sessionRef.rpc.canvas.open({
            canvasId: "editor",
            instanceId: `doctor-path-${stableId(repoRelativePath)}`,
            input: {
                scope: "repo",
                path: repoRelativePath,
                title: basename(absolutePath),
                placement: { surface: "side", focus: true },
            },
        });

        return { ok: true, mode: "editor", path: repoRelativePath };
    }

    await revealInFileManager(absolutePath, stats);
    return { ok: true, mode: "file-manager", path: absolutePath };
}

/* ---------------- request routing ---------------- */

async function handleRequest(entry, req, res) {
    const url = new URL(req.url, entry.origin);
    const path = url.pathname;
    const authorizationError = authorizeRequest(entry, req, url, path);
    if (authorizationError) {
        return sendForbidden(res, authorizationError);
    }

    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        return serveAsset(res, "index.html");
    }
    if (req.method === "GET" && path === "/styles.css") {
        return serveAsset(res, "styles.css");
    }
    if (req.method === "GET" && path === "/app.js") {
        return serveAsset(res, "app.js");
    }
    if (req.method === "GET" && path === "/model.mjs") {
        return serveAsset(res, "model.mjs");
    }
    if (req.method === "GET" && path === "/events") {
        return addSseClient(entry, req, res);
    }
    if (req.method === "GET" && path === "/api/diagnostics") {
        const { result } = await runDiagnosticsForEntry(entry, { broadcastResult: true });
        return sendJson(res, 200, result);
    }
    if (req.method === "POST" && path === "/api/ask-copilot") {
        let body;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            return sendJson(res, requestErrorStatus(err), { ok: false, error: `Invalid request: ${err.message}` });
        }
        const check = body?.check ?? body;
        const hasCheckDetails = check && [check.name, check.status, check.category, check.message, check.fix]
            .some(value => String(value ?? "").trim().length > 0);
        if (!hasCheckDetails) {
            return sendJson(res, 400, { ok: false, error: "No check details provided." });
        }
        try {
            const result = await dispatchFixAndRefresh(entry, check);
            log(`Sent Ask Copilot request for check '${check.name ?? "(unnamed)"}'.`);
            return sendJson(res, result.ok ? 200 : 500, result);
        } catch (err) {
            return sendJson(res, 500, { ok: false, error: `Failed to ask Copilot: ${err?.message ?? err}` });
        }
    }
    if (req.method === "POST" && path === "/api/open-terminal") {
        let body;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            return sendJson(res, requestErrorStatus(err), { ok: false, error: `Invalid request: ${err.message}` });
        }
        try {
            return sendJson(res, 200, await openTerminalForCheck(body?.check));
        } catch (err) {
            return sendJson(res, 500, { ok: false, error: `Failed to open terminal: ${err?.message ?? err}` });
        }
    }
    if (req.method === "POST" && path === "/api/open-path") {
        let body;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            return sendJson(res, requestErrorStatus(err), { ok: false, error: `Invalid request: ${err.message}` });
        }
        try {
            return sendJson(res, 200, await openPath(body?.path));
        } catch (err) {
            return sendJson(res, 500, { ok: false, error: `Failed to open path: ${err?.message ?? err}` });
        }
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
}

async function startServer(instanceId) {
    const entry = {
        instanceId,
        server: null,
        url: "",
        origin: "",
        host: "",
        token: createToken(),
        clients: new Set(),
        nextRevision: 0,
        latestRequestedRevision: 0,
    };

    const server = createServer((req, res) => {
        Promise.resolve(handleRequest(entry, req, res)).catch((err) => {
            log(`request error: ${err?.message ?? err}`, "error");
            try {
                if (!res.headersSent) {
                    res.writeHead(500, { "Content-Type": "text/plain" });
                }
                res.end("Internal error");
            } catch {
                /* ignore */
            }
        });
    });

    // Port 0 = OS-assigned ephemeral port; loopback-only so the host will embed it.
    await listenOnLoopback(server);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    if (!port) {
        await new Promise((resolve) => server.close(() => resolve()));
        throw new Error("The loopback server did not receive a port.");
    }

    entry.server = server;
    entry.origin = `http://127.0.0.1:${port}`;
    entry.host = `127.0.0.1:${port}`;
    entry.url = `${entry.origin}/?token=${encodeURIComponent(entry.token)}`;
    instances.set(instanceId, entry);
    return entry;
}

/* ---------------- canvas + tool declarations ---------------- */

const doctorCanvas = createCanvas({
    id: CANVAS_ID,
    displayName: "Aspire Doctor",
    description:
        "Runs 'aspire doctor' and renders environment checks (pass/warning/fail) with actionable fixes and detected CLI installations.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    actions: [
        {
            name: "run_diagnostics",
            description: "Re-run 'aspire doctor' and push fresh results to the open canvas.",
            inputSchema: { type: "object", additionalProperties: false, properties: {} },
            handler: async (ctx) => {
                const entry = instances.get(ctx.instanceId);
                if (!entry) {
                    throw new CanvasError("canvas_not_open", "The Aspire Doctor canvas is not open.");
                }
                const { result, isCurrent } = await runDiagnosticsForEntry(entry, { broadcastResult: true });
                if (!result.ok) {
                    return {
                        ok: false,
                        error: result.error,
                        revision: result.revision,
                        superseded: !isCurrent,
                    };
                }
                return {
                    ok: true,
                    summary: normalizeDoctorData(result.data ?? {}).summary,
                    revision: result.revision,
                    superseded: !isCurrent,
                };
            },
        },
    ],
    open: async (ctx) => {
        let entry = instances.get(ctx.instanceId);
        if (!entry) {
            try {
                entry = await startServer(ctx.instanceId);
            } catch (error) {
                throw new CanvasError(
                    "server_unavailable",
                    `Could not start the Aspire Doctor canvas server: ${error?.message ?? error}`,
                );
            }
            log(`Aspire Doctor canvas opened (instance '${ctx.instanceId}').`);
        }
        return { title: "Aspire Doctor", url: entry.url };
    },
    onClose: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) {
            return;
        }
        instances.delete(ctx.instanceId);
        for (const client of entry.clients) {
            try {
                client.end();
            } catch {
                /* ignore */
            }
        }
        entry.clients.clear();
        await new Promise((resolve) => entry.server.close(() => resolve()));
    },
});

const openTool = {
    name: "open_aspire_doctor",
    description:
        "Open (or focus) the Aspire Doctor canvas — a side panel that runs 'aspire doctor' and renders environment checks with actionable fixes.",
    parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
            instanceId: {
                type: "string",
                description: "Panel handle. Reuse to refocus the same panel; defaults to 'doctor-main'.",
            },
        },
    },
    handler: async (args) => {
        const instanceId = (args?.instanceId ?? "").trim() || DEFAULT_INSTANCE;
        try {
            if (typeof sessionRef?.rpc?.canvas?.open !== "function") {
                return {
                    textResultForLlm: "Failed to open the Aspire Doctor canvas: the canvas host is not available.",
                    resultType: "failure",
                };
            }
            await sessionRef.rpc.canvas.open({ canvasId: CANVAS_ID, instanceId, input: {} });
            return `Opened the Aspire Doctor canvas (instance '${instanceId}'). Use its Re-run button or the run_diagnostics action to refresh checks.`;
        } catch (err) {
            return {
                textResultForLlm: `Failed to open the Aspire Doctor canvas: ${err?.message ?? err}`,
                resultType: "failure",
            };
        }
    },
};

/* ---------------- hooks ---------------- */

function onSessionStart() {
    return {
        additionalContext:
            "An 'Aspire Doctor' canvas extension is available in this session. When you diagnose the " +
            "Aspire environment — for example after calling the 'doctor' MCP tool, or when helping the " +
            "user resolve setup/prerequisite problems — prefer surfacing the results visually by opening " +
            "the canvas with the 'open_aspire_doctor' tool. The canvas re-runs 'aspire doctor' itself and " +
            "renders a pass/warning/fail checklist with actionable fixes and detected CLI installations, so it " +
            "is a richer view than the tool's text output. Use your judgment: skip it for quick internal " +
            "checks, and open it when the user would benefit from seeing the full report.",
    };
}

function onPostToolUse(input) {
    if (!isAspireDoctorTool(input?.toolName)) {
        return;
    }
    return {
        additionalContext:
            "You just ran the Aspire environment diagnostics. If the user would benefit from a visual " +
            "report, open the Aspire Doctor canvas with the 'open_aspire_doctor' tool — it renders these " +
            "checks as a pass/warning/fail checklist with actionable fixes and detected CLI installations.",
    };
}

function isAspireDoctorTool(toolName) {
    const normalized = String(toolName ?? "").toLowerCase();
    const leafName = normalized.split(/[.:/]/).at(-1);
    return leafName === ASPIRE_DOCTOR_TOOL_NAME;
}

sessionRef = await joinSession({
    canvases: [doctorCanvas],
    tools: [openTool],
    hooks: { onSessionStart, onPostToolUse },
});
