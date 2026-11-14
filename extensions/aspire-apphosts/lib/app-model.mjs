import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep, win32 } from "node:path";
import { performance } from "node:perf_hooks";

const SINGLE_FILE_APPHOST_NAMES = ["apphost.cs", "apphost.ts", "apphost.mts", "apphost.go"];
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const ALLOWED_STATE_STYLES = new Set(["success", "warning", "error", "info"]);
const ALLOWED_RELATIONSHIP_TYPES = new Set(["Reference", "WaitFor", "Parent"]);
const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:"]);
const DASHBOARD_RESOURCE_VIEWS = new Set([
    "details",
    "console-logs",
    "structured-logs",
    "traces",
    "metrics",
]);
const DISPLAY_ONLY_URL_PROTOCOLS = new Set([
    "amqp:",
    "amqps:",
    "grpc:",
    "grpcs:",
    "mongodb:",
    "postgres:",
    "postgresql:",
    "redis:",
    "tcp:",
    "udp:",
]);

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clampText(value, max = 500) {
    if (value === null || value === undefined) {
        return "";
    }
    const text = String(value).trim();
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

function optionalText(value, max) {
    const text = clampText(value, max);
    return text || undefined;
}

// Aspireify keeps this policy locally too because the extensions install independently.
export function assertLocalAppHostPath(value) {
    const raw = String(value ?? "").trim();
    const separators = raw.replace(/\//g, "\\");
    const path = separators.startsWith("\\\\")
        ? `\\\\${separators.slice(2).replace(/\\+/g, "\\")}`
        : separators.replace(/\\+/g, "\\");
    const devicePrefix = ["\\\\?\\", "\\\\.\\", "\\??\\"].find((prefix) => path.startsWith(prefix));
    const deviceTarget = (devicePrefix ? path.slice(devicePrefix.length) : path.replace(/^\\/, ""))
        .replace(/^(?:(?:GLOBALROOT|GLOBAL\?\?|\?\?|DosDevices)\\)+/i, "");
    if (
        /^(?:smb|cifs|nfs):\/\//i.test(raw) ||
        /^file:\/\/[^/\\]/i.test(raw) ||
        (path.startsWith("\\\\") && !devicePrefix) ||
        ((devicePrefix || /^\\(?:Device|GLOBALROOT|GLOBAL\?\?|DosDevices)\\/i.test(path)) &&
            /^(?:UNC(?:\\|$)|Device\\(?:Mup|LanmanRedirector|WebDavRedirector)(?:\\|$))/i.test(deviceTarget))
    ) {
        const error = new Error("UNC and explicit network AppHost targets are not supported. Choose a local path.");
        error.code = "network_apphost_target";
        throw error;
    }
}

function dashboardResourcePath(view, resourceName) {
    const encodedName = encodeURIComponent(resourceName);
    switch (view) {
        case "details":
            return `/?resource=${encodedName}`;
        case "console-logs":
            return `/consolelogs/resource/${encodedName}`;
        case "structured-logs":
            return `/structuredlogs/resource/${encodedName}`;
        case "traces":
            return `/traces/resource/${encodedName}`;
        case "metrics":
            return `/metrics/resource/${encodedName}`;
        default:
            return undefined;
    }
}

function dashboardBasePath(url) {
    let pathname = url.pathname.replace(/\/+$/, "");
    if (pathname.toLowerCase().endsWith("/login")) {
        pathname = pathname.slice(0, -"/login".length);
    }
    return pathname === "/" ? "" : pathname;
}

export function buildDashboardViewUrl(value, view = "dashboard", resourceName) {
    const text = optionalText(value, 2000);
    if (!text) {
        return undefined;
    }
    try {
        const source = new URL(text);
        if (!ALLOWED_URL_PROTOCOLS.has(source.protocol)) {
            return undefined;
        }
        source.username = "";
        source.password = "";
        source.hash = "";
        if (view === "dashboard") {
            return source.toString();
        }
        const name = optionalText(resourceName, 240);
        if (!name || !DASHBOARD_RESOURCE_VIEWS.has(view)) {
            return undefined;
        }
        const resourcePath = dashboardResourcePath(view, name);
        const basePath = dashboardBasePath(source);
        const returnUrl = `${basePath}${resourcePath}`;
        const token = source.searchParams.get("t");
        if (token) {
            const login = new URL(source.origin);
            login.pathname = `${basePath}/login`;
            login.searchParams.set("returnUrl", returnUrl);
            login.searchParams.set("t", token);
            return login.toString();
        }
        return new URL(returnUrl, source.origin).toString();
    } catch {
        return undefined;
    }
}

function quoteShellArgument(value, platform) {
    const text = String(value ?? "");
    return platform === "win32"
        ? `'${text.replaceAll("'", "''")}'`
        : `'${text.replaceAll("'", "'\\''")}'`;
}

export function buildTerminalAttachCommand({
    resourceName,
    appHostPath,
    replicaIndex,
    platform = process.platform,
}) {
    const resource = optionalText(resourceName, 240);
    const appHost = optionalText(appHostPath, 4000);
    if (!resource || !appHost) {
        return undefined;
    }
    const tokens = [
        "aspire",
        "terminal",
        "attach",
        quoteShellArgument(resource, platform),
        "--apphost",
        quoteShellArgument(appHost, platform),
    ];
    const replica = optionalText(replicaIndex, 80);
    if (replica) {
        tokens.push("--replica", quoteShellArgument(replica, platform));
    }
    return tokens.join(" ");
}

function normalizePathKey(value) {
    const normalized = normalize(String(value ?? ""));
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function stableId(value) {
    return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 16);
}

export function isPathWithin(candidate, parent) {
    const candidatePath = normalizePathKey(resolve(candidate));
    const parentPath = normalizePathKey(resolve(parent));
    const pathRelative = relative(parentPath, candidatePath);
    return pathRelative !== ".." && !pathRelative.startsWith(`..${sep}`) && !isAbsolute(pathRelative);
}

function findJsonEnd(text, start) {
    const opener = text[start];
    if (opener !== "{" && opener !== "[") {
        return -1;
    }

    const stack = [opener];
    let inString = false;
    let escaped = false;
    for (let i = start + 1; i < text.length; i++) {
        const character = text[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (character === "\\") {
                escaped = true;
            } else if (character === "\"") {
                inString = false;
            }
            continue;
        }

        if (character === "\"") {
            inString = true;
            continue;
        }
        if (character === "{" || character === "[") {
            stack.push(character);
            continue;
        }
        if (character === "}" || character === "]") {
            const expected = character === "}" ? "{" : "[";
            if (stack.at(-1) !== expected) {
                return -1;
            }
            stack.pop();
            if (stack.length === 0) {
                return i + 1;
            }
        }
    }
    return -1;
}

export function extractJsonPayload(output) {
    const text = String(output ?? "").trim();
    if (!text) {
        return undefined;
    }

    try {
        return JSON.parse(text);
    } catch {
        // Aspire can write a human preamble before its JSON payload.
    }

    for (let start = 0; start < text.length; start++) {
        if (text[start] !== "{" && text[start] !== "[") {
            continue;
        }
        const end = findJsonEnd(text, start);
        if (end < 0) {
            continue;
        }
        try {
            return JSON.parse(text.slice(start, end));
        } catch {
            // Keep scanning in case this brace belonged to the human preamble.
        }
    }
    return undefined;
}

function sanitizeDashboardUrl(value) {
    const text = optionalText(value, 2000);
    if (!text) {
        return undefined;
    }
    try {
        const url = new URL(text);
        if (!ALLOWED_URL_PROTOCOLS.has(url.protocol)) {
            return undefined;
        }
        const pathname = url.pathname.replace(/\/+$/, "");
        if (pathname.toLowerCase().endsWith("/login")) {
            const basePath = dashboardBasePath(url);
            url.pathname = basePath ? `${basePath}/` : "/";
        }
        url.username = "";
        url.password = "";
        const resource = url.searchParams.get("resource");
        url.search = "";
        if (resource) {
            url.searchParams.set("resource", resource);
        }
        url.hash = "";
        return url.toString();
    } catch {
        return undefined;
    }
}

function sanitizeUrl(raw) {
    if (!isRecord(raw)) {
        return undefined;
    }
    const urlText = optionalText(raw.url, 2000);
    if (!urlText) {
        return undefined;
    }
    let parsed;
    try {
        parsed = new URL(urlText);
    } catch {
        return undefined;
    }
    if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol) && !DISPLAY_ONLY_URL_PROTOCOLS.has(parsed.protocol)) {
        return undefined;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return {
        name: optionalText(raw.name, 120) ?? "endpoint",
        displayName: optionalText(raw.displayName, 160) ?? optionalText(raw.name, 120) ?? "Endpoint",
        url: parsed.toString(),
        isLinkable: ALLOWED_URL_PROTOCOLS.has(parsed.protocol),
        isInternal: raw.isInternal === true,
    };
}

function sanitizeRelationship(raw) {
    if (!isRecord(raw)) {
        return undefined;
    }
    const resourceName = optionalText(raw.resourceName, 240);
    const type = optionalText(raw.type, 80);
    if (!resourceName || !type || !ALLOWED_RELATIONSHIP_TYPES.has(type)) {
        return undefined;
    }
    return { type, resourceName };
}

function sanitizeOptions(raw) {
    if (Array.isArray(raw)) {
        return raw
            .map((option) => {
                if (isRecord(option)) {
                    const value = optionalText(option.value ?? option.key, 500);
                    if (!value) {
                        return undefined;
                    }
                    return {
                        value,
                        label: optionalText(option.label ?? option.displayName ?? option.value ?? option.key, 500) ?? value,
                    };
                }
                const value = optionalText(option, 500);
                return value ? { value, label: value } : undefined;
            })
            .filter(Boolean);
    }
    if (!isRecord(raw)) {
        return [];
    }
    return Object.entries(raw).map(([value, label]) => ({
        value: clampText(value, 500),
        label: clampText(label, 500) || clampText(value, 500),
    }));
}

function normalizeCommandValue(inputType, value) {
    if (typeof value !== "string" || inputType.toLowerCase().includes("secret")) {
        return value;
    }
    // Match .NET String.Trim: U+0085 is whitespace, but U+FEFF is not.
    const whitespace = /\p{White_Space}/u;
    let start = 0;
    let end = value.length;
    while (start < end && whitespace.test(value[start])) start++;
    while (end > start && whitespace.test(value[end - 1])) end--;
    return value.slice(start, end);
}

function sanitizeArgumentInput(raw) {
    if (!isRecord(raw)) {
        return undefined;
    }

    const name = optionalText(raw.name, 120);
    const inputType = optionalText(raw.inputType, 80);
    if (!name || !inputType) {
        return undefined;
    }
    const maxLength = Number(raw.maxLength);
    const dependsOnInputs = Array.isArray(raw.dynamicLoading?.dependsOnInputs)
        ? raw.dynamicLoading.dependsOnInputs.map((value) => clampText(value, 120)).filter(Boolean)
        : [];
    const options = sanitizeOptions(raw.options);
    const allowCustomChoice = raw.allowCustomChoice === true;
    const value = raw.value == null || inputType.toLowerCase().includes("secret")
        ? undefined
        : normalizeCommandValue(inputType, String(raw.value));
    const safeValue = value && options.length > 0 && !allowCustomChoice
        ? options.some((option) => option.value === value) ? value : undefined
        : value;
    return {
        name,
        label: optionalText(raw.label, 240) ?? name,
        description: optionalText(raw.description, 1000),
        enableDescriptionMarkdown: raw.enableDescriptionMarkdown === true,
        inputType,
        required: raw.required === true,
        placeholder: optionalText(raw.placeholder, 500),
        options,
        allowCustomChoice,
        value: safeValue,
        disabled: raw.disabled === true,
        maxLength: Number.isFinite(maxLength) && maxLength > 0 ? Math.min(maxLength, 100_000) : undefined,
        dynamicLoading: dependsOnInputs.length > 0 || raw.dynamicLoading?.alwaysLoadOnStart === true
            ? {
                alwaysLoadOnStart: raw.dynamicLoading?.alwaysLoadOnStart === true,
                dependsOnInputs,
            }
            : undefined,
    };
}

export function sanitizeCommandArgumentInputs(payload) {
    return Array.isArray(payload) ? payload.map(sanitizeArgumentInput).filter(Boolean) : [];
}

function sanitizeCommand(name, raw, index) {
    if (!isRecord(raw)) {
        return undefined;
    }
    const commandName = optionalText(name, 160);
    if (!commandName) {
        return undefined;
    }
    const sortOrder = Number(raw.sortOrder);
    return {
        name: commandName,
        displayName: optionalText(raw.displayName, 240) ?? commandName,
        description: optionalText(raw.description, 1000),
        visibility: optionalText(raw.visibility, 120),
        state: optionalText(raw.state, 80) ?? "Enabled",
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : index,
        argumentInputs: Array.isArray(raw.argumentInputs)
            ? raw.argumentInputs.map(sanitizeArgumentInput).filter(Boolean)
            : [],
    };
}

function sanitizeHealthReports(raw) {
    if (!isRecord(raw)) {
        return [];
    }
    return Object.entries(raw)
        .map(([name, report]) => {
            if (!isRecord(report)) {
                return undefined;
            }
            // Aspire reports a null status until a registered check first returns.
            const statusText = optionalText(report.status, 80) ?? "Pending";
            const status = statusText.toLowerCase() === "healthy"
                ? "Healthy"
                : statusText.toLowerCase() === "degraded"
                    ? "Degraded"
                    : statusText.toLowerCase() === "unhealthy"
                        ? "Unhealthy"
                        : statusText;
            return {
                name: clampText(name, 160),
                status,
            };
        })
        .filter(Boolean);
}

export function sanitizeResource(raw) {
    if (!isRecord(raw)) {
        return undefined;
    }
    const name = optionalText(raw.name, 240);
    if (!name) {
        return undefined;
    }
    const commandEntries = isRecord(raw.commands) ? Object.entries(raw.commands) : [];
    const properties = isRecord(raw.properties) ? raw.properties : {};
    const terminalEnabled = optionalText(properties["terminal.enabled"], 16)?.toLowerCase() === "true";
    const stateStyleText = optionalText(raw.stateStyle, 40)?.toLowerCase();
    const exitCode = Number(raw.exitCode);
    return {
        name,
        displayName: optionalText(raw.displayName, 240) ?? name,
        resourceType: optionalText(raw.resourceType, 160) ?? "Resource",
        state: optionalText(raw.state, 80) ?? "Unknown",
        stateStyle: stateStyleText && ALLOWED_STATE_STYLES.has(stateStyleText) ? stateStyleText : undefined,
        healthStatus: optionalText(raw.healthStatus, 80),
        exitCode: Number.isInteger(exitCode) ? exitCode : undefined,
        creationTimestamp: optionalText(raw.creationTimestamp, 80),
        startTimestamp: optionalText(raw.startTimestamp, 80),
        stopTimestamp: optionalText(raw.stopTimestamp, 80),
        dashboardUrl: sanitizeDashboardUrl(raw.dashboardUrl),
        terminalEnabled,
        terminalReplicaIndex: terminalEnabled
            ? optionalText(properties["terminal.replicaIndex"], 80)
            : undefined,
        relationships: Array.isArray(raw.relationships)
            ? raw.relationships.map(sanitizeRelationship).filter(Boolean)
            : [],
        waitingFor: Array.isArray(raw.waitingFor)
            ? raw.waitingFor.map((value) => clampText(value, 240)).filter(Boolean)
            : [],
        urls: Array.isArray(raw.urls) ? raw.urls.map(sanitizeUrl).filter(Boolean) : [],
        healthReports: sanitizeHealthReports(raw.healthReports),
        commands: commandEntries
            .map(([commandName, command], index) => sanitizeCommand(commandName, command, index))
            .filter(Boolean)
            .sort((left, right) => left.sortOrder - right.sortOrder || left.displayName.localeCompare(right.displayName)),
    };
}

function classifyResource(resource) {
    const state = resource.state.toLowerCase();
    const health = resource.healthStatus?.toLowerCase();
    const reportStatuses = resource.healthReports.map((report) => report.status.toLowerCase());
    const hasUnhealthyReport = reportStatuses.some((status) =>
        status !== "healthy" && status !== "degraded" && status !== "pending");
    const hasDegradedReport = reportStatuses.includes("degraded");
    const hasPendingReport = reportStatuses.includes("pending");
    if (
        resource.stateStyle === "error"
        || state === "failedtostart"
        || state === "runtimeunhealthy"
        || (resource.exitCode !== undefined && resource.exitCode !== 0)
    ) {
        return "error";
    }
    if (["exited", "stopped", "notstarted", "finished"].includes(state)) {
        return state === "finished" && resource.stateStyle === "success" ? "healthy" : "inactive";
    }
    // No reported state yet (for example, a container not created); the dashboard shows it as Unknown.
    if (state === "unknown" && !hasUnhealthyReport) {
        return "inactive";
    }
    // The aggregate stays Unhealthy until pending checks return, so it is not a failure yet.
    if ((health === "unhealthy" && !hasPendingReport) || hasUnhealthyReport) {
        return "error";
    }

    if (
        resource.stateStyle === "warning"
        || health === "degraded"
        || hasDegradedReport
        || hasPendingReport
        || state === "starting"
        || state === "waiting"
        || state === "stopping"
    ) {
        return "warning";
    }
    if (resource.stateStyle === "success" || health === "healthy" || state === "running" || state === "finished") {
        return "healthy";
    }
    return "inactive";
}

export function classifyResourceState(resource) {
    return classifyResource(resource);
}

export function summarizeResources(resources) {
    const summary = { total: resources.length, healthy: 0, warning: 0, error: 0, inactive: 0 };
    for (const resource of resources) {
        summary[classifyResource(resource)]++;
    }
    return summary;
}

export function projectDescribePayload(payload) {
    const rawResources = Array.isArray(payload) ? payload : payload?.resources;
    const resources = Array.isArray(rawResources)
        ? rawResources.map(sanitizeResource).filter(Boolean)
        : [];
    resources.sort((left, right) => {
        const typeOrder = left.resourceType.localeCompare(right.resourceType);
        return typeOrder || left.displayName.localeCompare(right.displayName) || left.name.localeCompare(right.name);
    });
    return { resources, summary: summarizeResources(resources) };
}

export function redactText(value, max = 64 * 1024, sensitiveValues = []) {
    let text = String(value ?? "");
    for (const sensitiveValue of [...new Set(sensitiveValues.map((item) => String(item ?? "")).filter(Boolean))]
        .sort((left, right) => right.length - left.length)) {
        text = text.replaceAll(sensitiveValue, "[redacted]");
    }
    text = text
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/([?&](?:t|token|access_token|password|secret|api[-_]?key|sig|signature|credential|code)=)[^&\s]+/gi, "$1[redacted]")
        .replace(/((?:password|secret|token|api[-_]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
    return text.length > max ? `${text.slice(0, max)}\n[output truncated]` : text;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PATH_SEGMENT_PATTERN = "[^\\s\\\\/,;)\"'`]+";
const PATH_SPACED_INTERMEDIATE_PATTERN =
    `${PATH_SEGMENT_PATTERN}(?:[ \\t]${PATH_SEGMENT_PATTERN}){1,4}(?=[\\\\/])`;
const PATH_SPACED_FILE_PATTERN =
    `${PATH_SEGMENT_PATTERN}(?:[ \\t]${PATH_SEGMENT_PATTERN}){0,3}`
    + `[ \\t]${PATH_SEGMENT_PATTERN}\\.[A-Za-z0-9]{1,12}(?=$|[\\s,;)\"'])`;
const PATH_COMPONENT_PATTERN =
    `(?:${PATH_SPACED_INTERMEDIATE_PATTERN}|${PATH_SPACED_FILE_PATTERN}|${PATH_SEGMENT_PATTERN})`;
const PATH_TAIL_PATTERN = `(?:[\\\\/]${PATH_COMPONENT_PATTERN})*`;

export function redactKnownPaths(value, privatePaths = []) {
    let text = String(value ?? "");
    const flags = process.platform === "win32" ? "gi" : "g";
    for (const privatePath of [...new Set(privatePaths.filter(Boolean))]
        .sort((left, right) => right.length - left.length)) {
        const pathWithSuffix = new RegExp(`${escapeRegExp(privatePath)}${PATH_TAIL_PATTERN}`, flags);
        text = text.replace(pathWithSuffix, "[path withheld]");
    }
    return text;
}

export function relativizeWorkspacePaths(value, workspaceRoot) {
    const text = String(value ?? "");
    const root = String(workspaceRoot ?? "").replace(/[\\/]+$/, "");
    if (!root) return text;
    const flags = process.platform === "win32" ? "gi" : "g";
    const rootPattern = root.split(/[\\/]+/).map(escapeRegExp).join("[\\\\/]");
    return text
        .replace(new RegExp(`${rootPattern}[\\\\/]+`, flags), "")
        .replace(new RegExp(`${rootPattern}(?![A-Za-z0-9._-])`, flags), ".");
}

export function redactAbsolutePaths(value) {
    return String(value ?? "")
        .replace(/(["'`])[A-Za-z]:\\[^"'`\r\n]+\1/g, "$1[path withheld]$1")
        .replace(
            new RegExp(`\\b[A-Za-z]:\\\\${PATH_COMPONENT_PATTERN}${PATH_TAIL_PATTERN}`, "g"),
            "[path withheld]",
        )
        .replace(/(["'`])\/(?:Users|home|tmp|var|private|opt|usr|mnt|Volumes|workspaces|srv|data|app)\/[^"'`\r\n]+\1/g, "$1[path withheld]$1")
        .replace(
            // Only whole root segments at a path start: URL paths such as
            // https://host/app-host, URL hosts such as https://app/, and words such as
            // /homework are not local paths.
            new RegExp(
                `(?<![A-Za-z0-9._~%+-])(?<!:\\/)\\/(?:Users|home|tmp|var|private|opt|usr|mnt|Volumes|workspaces|srv|data|app)`
                + `(?![A-Za-z0-9._-])${PATH_TAIL_PATTERN}`,
                "g",
            ),
            "[path withheld]",
        );
}

const DETACHED_LOG_LINE = /^\[[^\]]*\] \[([A-Z]+)\] \[([^\]]+)\] ?(.*)$/;
const DETACHED_LOG_CATEGORIES = new Set(["Stdout", "Build", "AppHost"]);
const DETACHED_LOG_LEVELS = new Set(["WARN", "FAIL", "EROR", "CRIT"]);

// `aspire start` detaches and writes the real build and AppHost output to a child CLI
// log. Keep the user-facing lines and drop CLI diagnostics. `state.keep` carries
// whether multi-line continuations belong to a kept entry across chunks.
export function filterDetachedRunLog(text, state = { keep: false }) {
    const kept = [];
    for (const line of String(text ?? "").split(/\r?\n/)) {
        const match = DETACHED_LOG_LINE.exec(line);
        if (!match) {
            if (state.keep && line) kept.push(line);
            continue;
        }
        const [, level, category, message] = match;
        state.keep = level !== "DBUG" && level !== "TRCE"
            && (DETACHED_LOG_CATEGORIES.has(category) || DETACHED_LOG_LEVELS.has(level));
        if (state.keep) {
            kept.push(category === "Stdout" ? message.replace(/^:[a-z0-9_+-]+:\s*/i, "") : message);
        }
    }
    return kept.length ? `${kept.join("\n")}\n` : "";
}

export function samePath(left, right, platform = process.platform) {
    const normalizeForCompare = (value) => {
        const normalized = String(value ?? "").replace(/[\\/]+/g, "/");
        return platform === "win32" ? normalized.toLowerCase() : normalized;
    };
    return normalizeForCompare(left) === normalizeForCompare(right);
}

// Follows the detached child log for one `aspire start --apphost <path>` invocation.
export function createDetachedRunLogTail({
    appHostPath,
    onText,
    since = Date.now(),
    logDir = join(homedir(), ".aspire", "logs"),
    intervalMs = 500,
    maxReadBytes = 256 * 1024,
    maxPendingLineChars = 64 * 1024,
    platform = process.platform,
}) {
    let file = null;
    let offset = 0;
    let partial = "";
    let inFlight = null;
    let stopped = false;
    const state = { keep: false };
    const decoder = new StringDecoder("utf8");

    async function findLog() {
        let names;
        try {
            names = await readdir(logDir);
        } catch {
            return null;
        }
        const candidates = [];
        for (const name of names) {
            if (/_detach-child_/i.test(name)) continue;
            const stamp = /^cli_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/i.exec(name);
            if (!stamp) continue;
            const [, y, mo, d, h, mi, s] = stamp.map(Number);
            if (Date.UTC(y, mo - 1, d, h, mi, s) < since - 5000) continue;
            const path = join(logDir, name);
            try {
                const info = await stat(path);
                if (Math.max(info.birthtimeMs || 0, info.mtimeMs) >= since - 2000) {
                    candidates.push({ path, time: info.birthtimeMs || info.mtimeMs });
                }
            } catch {
                // The CLI may rotate logs while we scan.
            }
        }
        candidates.sort((a, b) => b.time - a.time);
        for (const candidate of candidates) {
            const head = (await readChunk(candidate.path, 0, 64 * 1024)).toString("utf8");
            const spawn = /Spawning child CLI: .*? --apphost (.+?) --log-file ("[^"]+?\.log"|'[^']+?\.log'|[^\s]+?\.log)(?:\s|$)/.exec(head);
            const unquote = (value) => value.replace(/^(["'])(.*)\1$/, "$2");
            if (spawn && samePath(unquote(spawn[1]), appHostPath, platform)) {
                return unquote(spawn[2]);
            }
        }
        return null;
    }

    async function readChunk(path, start, length) {
        let handle;
        try {
            handle = await open(path, "r");
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, start);
            return buffer.subarray(0, bytesRead);
        } catch {
            return Buffer.alloc(0);
        } finally {
            await handle?.close().catch(() => {});
        }
    }

    async function poll() {
        file ??= await findLog();
        if (!file) return;
        let size;
        try {
            size = (await stat(file)).size;
        } catch {
            return;
        }
        while (offset < size) {
            const length = Math.min(maxReadBytes, size - offset);
            const chunk = await readChunk(file, offset, length);
            if (!chunk.length) return;
            offset += chunk.length;
            const text = consumeDecodedText(decoder.write(chunk));
            if (text) onText(text);
        }
    }

    function consumeDecodedText(text) {
        const kept = [];
        let remaining = text;
        while (remaining) {
            const lineBreak = remaining.indexOf("\n");
            const segment = lineBreak >= 0 ? remaining.slice(0, lineBreak) : remaining;
            const available = Math.max(0, maxPendingLineChars - partial.length);
            partial += segment.slice(0, available);
            if (lineBreak < 0) break;
            const filtered = filterDetachedRunLog(`${partial}\n`, state);
            if (filtered) kept.push(filtered);
            partial = "";
            remaining = remaining.slice(lineBreak + 1);
        }
        return kept.join("");
    }

    function tick() {
        if (inFlight || stopped) return;
        inFlight = poll().catch(() => {}).finally(() => { inFlight = null; });
    }

    const timer = setInterval(tick, intervalMs);
    timer.unref?.();

    return {
        async stop() {
            if (stopped) return;
            stopped = true;
            clearInterval(timer);
            await inFlight;
            await poll().catch(() => {});
            const decoded = consumeDecodedText(decoder.end());
            const text = decoded + filterDetachedRunLog(partial, state);
            partial = "";
            if (text) onText(text);
        },
    };
}

export function parseLegacyPipelineSteps(output) {
    const text = String(output ?? "");
    const marker = /Available steps:\s*/i.exec(text);
    if (!marker) {
        return [];
    }
    const stepText = text
        .slice(marker.index + marker[0].length)
        .split(/(?:📄|See (?:AppHost )?logs at|A new version of Aspire is available)/i, 1)[0];
    return [...new Set([...stepText.matchAll(/'([^']+)'/g)]
        .map((match) => match[1].trim())
        .filter(Boolean))];
}

export function appHostDisplayName(appHostPath) {
    const fileName = basename(appHostPath);
    const extension = extname(fileName);
    if (SINGLE_FILE_APPHOST_NAMES.includes(fileName.toLowerCase())) {
        return basename(dirname(appHostPath)) || "AppHost";
    }

    const withoutExtension = extension ? fileName.slice(0, -extension.length) : fileName;
    return withoutExtension.replace(/\.apphost$/i, "") || "AppHost";
}

export function appHostIdentityHint(record) {
    const directory = defaultCwdForAppHost(record.appHostPath);
    const directoryName = basename(directory);
    const hostDirectory = /apphost$/i.test(directoryName)
        || directoryName.toLowerCase() === String(record.displayName ?? "").toLowerCase();
    const hint = basename(hostDirectory ? dirname(directory) : directory);
    const safeHint = redactAbsolutePaths(redactText(hint.replace(/[\u0000-\u001f\u007f-\u009f]/g, ""), Infinity))
        .trim().slice(0, 88);
    return `${safeHint || "AppHost"} · ${String(record.id || stableId(record.appHostPath)).slice(0, 8)}`;
}

function safeLocationText(value, maxLength) {
    const text = redactAbsolutePaths(redactText(String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ""), Infinity))
        .trim();
    return text.length > maxLength ? `…${text.slice(-(maxLength - 1))}` : text;
}

function pathSegments(directory) {
    return resolve(directory).split(/[\\/]+/).filter(Boolean);
}

function commonSegmentCount(segmentLists) {
    const key = (segment) => (process.platform === "win32" ? segment.toLowerCase() : segment);
    let count = 0;
    while (segmentLists.every((segments) =>
        count < segments.length && key(segments[count]) === key(segmentLists[0][count]))) {
        count += 1;
    }
    return count;
}

function homeRelativeLocation(directory) {
    let home;
    try {
        home = homedir();
    } catch {
        return undefined;
    }
    if (!home || !isPathWithin(directory, home)) {
        return undefined;
    }
    const rest = relative(home, directory).split(sep).filter(Boolean).join("/");
    return rest ? `~/${rest}` : "~";
}

// Duplicate AppHost names get a UI-only relative location that distinguishes them.
function applyLocationHints(pairs) {
    const groups = new Map();
    for (const pair of pairs.filter(({ record }) => record.appHostPath)) {
        const key = pair.node.label.toLowerCase();
        groups.set(key, [...(groups.get(key) ?? []), pair]);
    }
    for (const group of groups.values()) {
        if (group.length < 2) {
            continue;
        }
        const directories = group.map(({ record }) => defaultCwdForAppHost(record.appHostPath));
        const segmentLists = directories.map(pathSegments);
        const shared = Math.min(commonSegmentCount(segmentLists), ...segmentLists.map((segments) => segments.length - 1));
        const seen = new Map();
        group.forEach(({ node, record }, index) => {
            const segments = segmentLists[index];
            const relativeSegments = shared > 0 ? segments.slice(shared) : segments.slice(-3);
            let hint = safeLocationText(relativeSegments.join("/"), 72) || "AppHost";
            const duplicates = seen.get(hint) ?? 0;
            seen.set(hint, duplicates + 1);
            if (duplicates > 0) {
                hint = `${hint} · ${String(record.id || stableId(record.appHostPath)).slice(0, 8)}`;
            }
            node.locationHint = hint;
            node.locationTitle = safeLocationText(homeRelativeLocation(directories[index]) ?? hint, 400) || hint;
        });
    }
}

// Workspace AppHosts always show their folder relative to the workspace root.
function applyWorkspaceLocations(pairs) {
    const located = pairs
        .filter(({ record }) => typeof record.relativePath === "string" && record.relativePath)
        .map((pair) => {
            const slash = pair.record.relativePath.lastIndexOf("/");
            return { ...pair, folder: slash > 0 ? pair.record.relativePath.slice(0, slash) : "" };
        });
    const folderCounts = new Map();
    for (const { folder } of located) {
        folderCounts.set(folder.toLowerCase(), (folderCounts.get(folder.toLowerCase()) ?? 0) + 1);
    }
    for (const { node, record, folder } of located) {
        const shared = !folder || folderCounts.get(folder.toLowerCase()) > 1;
        const location = safeLocationText(shared ? record.relativePath : folder, 72);
        if (!location) {
            continue;
        }
        node.workspaceLocation = location;
        node.locationTitle = safeLocationText(record.relativePath, 400) || location;
    }
}

export function normalizePsPayload(payload) {
    if (!Array.isArray(payload)) {
        return [];
    }
    return payload
        .map((raw) => {
            if (!isRecord(raw)) {
                return undefined;
            }
            const appHostPath = optionalText(raw.appHostPath, 4000);
            if (!appHostPath) {
                return undefined;
            }
            const appHostPid = Number(raw.appHostPid);
            return {
                id: stableId(normalizePathKey(appHostPath)),
                appHostPath: normalize(appHostPath),
                displayName: appHostDisplayName(appHostPath),
                status: optionalText(raw.status, 40)?.toLowerCase() === "stopped" ? "stopped" : "running",
                sdkVersion: optionalText(raw.sdkVersion, 120),
                appHostPid: Number.isInteger(appHostPid) ? appHostPid : undefined,
                dashboardUrl: optionalText(raw.dashboardUrl, 2000),
            };
        })
        .filter(Boolean);
}

export function normalizeLsPayload(payload) {
    if (!Array.isArray(payload)) {
        return [];
    }
    return payload
        .map((raw) => {
            if (!isRecord(raw)) {
                return undefined;
            }
            const appHostPath = optionalText(raw.path, 4000);
            if (!appHostPath) {
                return undefined;
            }
            const status = optionalText(raw.status, 80) ?? "unknown";
            return {
                id: stableId(normalizePathKey(appHostPath)),
                appHostPath: normalize(appHostPath),
                displayName: appHostDisplayName(appHostPath),
                language: optionalText(raw.language, 120),
                discoveryStatus: status,
                buildable: status.toLowerCase() === "buildable",
                status: "stopped",
            };
        })
        .filter(Boolean);
}

function commandIsVisible(command) {
    const visibility = command.visibility;
    if (!visibility) {
        return true;
    }
    return visibility.split(",").some((part) => part.trim().toLowerCase() === "ui");
}

function commandIsRenderable(command) {
    const state = command.state?.toLowerCase();
    return commandIsVisible(command) && (state === "enabled" || state === "disabled");
}

function isParameterResource(resource) {
    return resource.resourceType.toLowerCase().includes("parameter");
}

function resourceDescription(resource) {
    const parts = [resource.resourceType];
    if (resource.state) {
        parts.push(resource.state);
    }
    if (resource.exitCode !== undefined && resource.exitCode !== 0) {
        parts.push(`Exit code ${resource.exitCode}`);
    }
    if (isParameterResource(resource)) {
        parts.push("Value protected");
    }
    return parts.join(" · ");
}

function resourceStatusLabel(resource) {
    return resource.exitCode !== undefined && resource.exitCode !== 0
        ? `${resource.state} · ${resource.exitCode}`
        : resource.state || undefined;
}

function resourceLifecycleTransitioning(resource) {
    return ["starting", "waiting", "stopping", "building"].includes(resource.state.toLowerCase());
}

function resourceLifecycleTone(resource) {
    const state = resource.state.toLowerCase();
    if (
        resource.stateStyle === "error"
        || state === "failedtostart"
        || state === "runtimeunhealthy"
        || (resource.exitCode !== undefined && resource.exitCode !== 0)
    ) {
        return "error";
    }
    if (resourceLifecycleTransitioning(resource) || resource.stateStyle === "warning") {
        return "warning";
    }
    if (state === "running" || (state === "finished" && resource.stateStyle === "success")) {
        return "healthy";
    }
    return "inactive";
}

function healthTone(status) {
    const normalized = status.toLowerCase();
    return normalized === "healthy"
        ? "healthy"
        : normalized === "degraded" || normalized === "pending" ? "warning" : "error";
}

function resourceHealthSummary(resource) {
    const state = resource.state.toLowerCase();
    const inactive = ["exited", "stopped", "notstarted", "finished"].includes(state);
    if (resource.healthReports.length > 0) {
        const healthy = resource.healthReports.filter((report) => report.status === "Healthy").length;
        const degraded = resource.healthReports.some((report) => report.status === "Degraded");
        const pending = resource.healthReports.some((report) => report.status === "Pending");
        const unhealthy = resource.healthReports.some((report) =>
            report.status !== "Healthy" && report.status !== "Degraded" && report.status !== "Pending");
        const label = healthy === resource.healthReports.length
            ? "Healthy"
            : `${healthy}/${resource.healthReports.length} healthy`;
        // Like the dashboard, do not judge aggregate health before the resource reports a state.
        if (state === "unknown" && !unhealthy && !degraded) {
            return { label: pending ? "Waiting" : label, tone: "inactive" };
        }
        return inactive
            ? {
                label: unhealthy
                    ? "Last known unhealthy"
                    : degraded
                        ? "Last known degraded"
                        : pending
                            ? "Not checked"
                            : "Last known healthy",
                tone: unhealthy ? "error" : degraded ? "warning" : "inactive",
            }
            : {
                label,
                tone: unhealthy ? "error" : degraded || pending ? "warning" : "healthy",
            };
    }
    if (resource.healthStatus) {
        return {
            label: inactive
                ? `Last known ${resource.healthStatus.toLowerCase()}`
                : resource.healthStatus,
            tone: inactive && resource.healthStatus === "Healthy"
                ? "inactive"
                : healthTone(resource.healthStatus),
        };
    }
    return undefined;
}

function resourceStateIcon(resource) {
    const state = resource.state.toLowerCase();
    const tone = classifyResource(resource);
    if (["starting", "stopping", "building", "waiting"].includes(state)) {
        return "loading";
    }
    if (["finished", "exited", "stopped", "notstarted"].includes(state)) {
        return tone === "error" ? "error" : "record";
    }
    if (tone === "healthy") {
        return "pass";
    }
    if (tone === "warning") {
        return "warning";
    }
    if (tone === "error") {
        return "error";
    }
    return "record";
}

const DEPENDENCY_TYPE_ORDER = ["Reference", "WaitFor"];

function resourceNameResolver(resources) {
    const resourceByName = new Map(resources.map((resource) => [resource.name, resource]));
    const resourceNamesByDisplayName = new Map();
    for (const resource of resources) {
        const key = resource.displayName.toLowerCase();
        const names = resourceNamesByDisplayName.get(key) ?? [];
        names.push(resource.name);
        resourceNamesByDisplayName.set(key, names);
    }
    return (value) => {
        if (resourceByName.has(value)) {
            return value;
        }
        const matches = resourceNamesByDisplayName.get(String(value ?? "").toLowerCase()) ?? [];
        return matches.length === 1 ? matches[0] : undefined;
    };
}

// Reference and WaitFor edges run from the dependency to the dependent; Parent drives tree nesting instead.
function resourceDependencies(resources, resolveName) {
    const resourceByName = new Map(resources.map((resource) => [resource.name, resource]));
    const dependsOn = new Map(resources.map((resource) => [resource.name, new Map()]));
    const usedBy = new Map(resources.map((resource) => [resource.name, new Map()]));
    const addType = (relations, owner, related, type) => {
        const types = relations.get(owner).get(related) ?? new Set();
        types.add(type);
        relations.get(owner).set(related, types);
    };
    const addEdge = (dependency, dependent, type) => {
        const from = resolveName(dependency);
        if (!from || from === dependent) {
            return;
        }
        addType(dependsOn, dependent, from, type);
        addType(usedBy, from, dependent, type);
    };
    for (const resource of resources) {
        for (const relationship of resource.relationships) {
            if (relationship.type !== "Parent") {
                addEdge(relationship.resourceName, resource.name, relationship.type);
            }
        }
        for (const dependency of resource.waitingFor) {
            addEdge(dependency, resource.name, "WaitFor");
        }
    }
    const toList = (related) => [...related.entries()]
        .map(([resourceName, types]) => ({
            resourceName,
            types: DEPENDENCY_TYPE_ORDER.filter((type) => types.has(type)),
        }))
        .sort((left, right) =>
            resourceByName.get(left.resourceName).displayName.localeCompare(resourceByName.get(right.resourceName).displayName)
            || left.resourceName.localeCompare(right.resourceName));
    return new Map(resources.map((resource) => [resource.name, {
        dependsOn: toList(dependsOn.get(resource.name)),
        usedBy: toList(usedBy.get(resource.name)),
    }]));
}

function endpointNode(appHostId, resource, endpoint, index) {
    let address;
    try {
        address = new URL(endpoint.url).host || undefined;
    } catch {
        address = undefined;
    }
    return {
        id: `apphost:${appHostId}:resource:${resource.name}:endpoint:${index}`,
        kind: "endpoint",
        label: endpoint.displayName || endpoint.name || endpoint.url,
        description: endpoint.url,
        statusLabel: address,
        icon: endpoint.isLinkable ? "link" : "endpoint",
        href: endpoint.isLinkable ? endpoint.url : undefined,
        appHostId,
        resourceName: resource.name,
        children: [],
    };
}

function healthGroupNode(appHostId, resource) {
    const healthy = resource.healthReports.filter((report) => report.status === "Healthy").length;
    const state = resource.state.toLowerCase();
    const inactive = ["exited", "stopped", "notstarted", "finished"].includes(state);
    return {
        id: `apphost:${appHostId}:resource:${resource.name}:health`,
        kind: "health-group",
        label: "Health Checks",
        description: `${healthy}/${resource.healthReports.length}`,
        icon: "heart",
        appHostId,
        resourceName: resource.name,
        defaultExpanded: false,
        children: [...resource.healthReports]
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((report) => {
                const pending = report.status === "Pending";
                return {
                    id: `apphost:${appHostId}:resource:${resource.name}:health:${stableId(report.name)}`,
                    kind: "health-check",
                    label: report.name,
                    statusLabel: pending
                        ? inactive ? "Not checked" : "Waiting"
                        : inactive ? `Last ${report.status.toLowerCase()}` : report.status,
                    icon: pending
                        ? inactive ? "record" : "loading"
                        : report.status === "Healthy" ? "pass" : report.status === "Degraded" ? "warning" : "error",
                    tone: (inactive && (pending || report.status === "Healthy")) || (pending && state === "unknown")
                        ? "inactive"
                        : healthTone(report.status),
                    appHostId,
                    resourceName: resource.name,
                    healthCheckName: report.name,
                    children: [],
                };
            }),
    };
}

function commandsGroupNode(appHostId, resource, commands) {
    return {
        id: `apphost:${appHostId}:resource:${resource.name}:commands`,
        kind: "commands-group",
        label: "Commands",
        description: `${commands.length}`,
        icon: "terminal",
        appHostId,
        resourceName: resource.name,
        defaultExpanded: false,
        children: commands.map((command) => ({
            id: `apphost:${appHostId}:resource:${resource.name}:command:${command.name}`,
            kind: "command",
            label: command.displayName,
            description: command.state?.toLowerCase() === "disabled"
                ? "Unavailable"
                : command.description || command.name,
            icon: command.name.replace(/^resource-/, "") === "start"
                ? "play"
                : command.name.replace(/^resource-/, "") === "stop"
                    ? "stop"
                    : command.name.replace(/^resource-/, "") === "restart"
                        ? "restart"
                        : command.name.replace(/^resource-/, "") === "rebuild"
                            ? "tools"
                            : "run",
            tone: command.state?.toLowerCase() === "disabled" ? "inactive" : undefined,
            appHostId,
            resourceName: resource.name,
            commandName: command.name,
            command,
            disabled: command.state?.toLowerCase() === "disabled",
            children: [],
        })),
    };
}

export function buildResourceTree(resources, appHostId) {
    const resourceByName = new Map(resources.map((resource) => [resource.name, resource]));
    const resolveName = resourceNameResolver(resources);
    const dependencies = resourceDependencies(resources, resolveName);
    const childrenByParent = new Map();
    const childNames = new Set();
    for (const resource of resources) {
        const parent = resource.relationships.find((relationship) =>
            relationship.type === "Parent" && resourceByName.has(relationship.resourceName));
        if (!parent) {
            continue;
        }
        childNames.add(resource.name);
        const children = childrenByParent.get(parent.resourceName) ?? [];
        children.push(resource);
        childrenByParent.set(parent.resourceName, children);
    }

    const buildNode = (resource, ancestors = new Set()) => {
        if (ancestors.has(resource.name)) {
            return undefined;
        }
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(resource.name);
        const childResources = [...(childrenByParent.get(resource.name) ?? [])]
            .sort((left, right) => left.displayName.localeCompare(right.displayName))
            .map((child) => buildNode(child, nextAncestors))
            .filter(Boolean);
        const endpoints = resource.urls
            .filter((endpoint) => !endpoint.isInternal)
            .map((endpoint, index) => endpointNode(appHostId, resource, endpoint, index));
        const visibleCommands = resource.commands.filter(commandIsRenderable);
        const healthSummary = resourceHealthSummary(resource);
        const waitingForLabels = resource.state.toLowerCase() === "waiting"
            ? [...new Set(resource.waitingFor
                .map(resolveName)
                .filter(Boolean)
                .map((name) => resourceByName.get(name).displayName))]
            : [];
        const trailingChildren = [
            ...endpoints,
            ...(resource.healthReports.length > 0 ? [healthGroupNode(appHostId, resource)] : []),
            ...(visibleCommands.length > 0 ? [commandsGroupNode(appHostId, resource, visibleCommands)] : []),
        ];
        return {
            id: `apphost:${appHostId}:resource:${resource.name}`,
            kind: "resource",
            label: resource.displayName,
            description: resourceDescription(resource),
            statusLabel: resourceStatusLabel(resource),
            lifecycleTone: resourceLifecycleTone(resource),
            lifecycleTransitioning: resourceLifecycleTransitioning(resource),
            healthLabel: healthSummary?.label,
            healthTone: healthSummary?.tone,
            icon: resourceStateIcon(resource),
            tone: classifyResource(resource),
            appHostId,
            resourceName: resource.name,
            terminalEnabled: resource.terminalEnabled,
            terminalReplicaIndex: resource.terminalReplicaIndex,
            isParameter: isParameterResource(resource),
            dependsOn: dependencies.get(resource.name).dependsOn,
            usedBy: dependencies.get(resource.name).usedBy,
            waitingForLabels,
            resource,
            defaultExpanded: childResources.length > 0,
            children: [...childResources, ...trailingChildren],
        };
    };

    return resources
        .filter((resource) => !childNames.has(resource.name))
        .sort((left, right) => left.displayName.localeCompare(right.displayName))
        .map((resource) => buildNode(resource))
        .filter(Boolean);
}

function modelFor(models, record) {
    return models.get(record.runtimeId ?? record.id) ?? models.get(record.id);
}

function appHostActions(record, operation) {
    if (operation) {
        return [];
    }
    if (record.status === "running") {
        return [
            ...(record.relativePath ? ["source"] : []),
            "dashboard",
            "stop",
            "deploy",
            "publish",
            "pipeline-step",
        ];
    }
    return record.buildable === false
        ? [...(record.relativePath ? ["source"] : [])]
        : [
            ...(record.relativePath ? ["source"] : []),
            "run",
            "deploy",
            "publish",
            "pipeline-step",
        ];
}

function appHostUnavailableReason(record) {
    return record.status !== "running" && record.buildable === false
        ? "Aspire could not confirm that this AppHost is buildable. Check the project, then refresh."
        : undefined;
}

function displayLanguage(value) {
    if (!value) {
        return undefined;
    }
    const normalized = value.toLowerCase();
    if (normalized === "csharp") {
        return "C#";
    }
    if (normalized.includes("typescript")) {
        return "TypeScript";
    }
    return value;
}

function rootDescription(record, model, operation) {
    if (operation) {
        return operation.label;
    }
    if (record.status !== "running") {
        const readiness = record.buildable === false ? "Needs attention" : "Ready to run";
        return [displayLanguage(record.language), readiness].filter(Boolean).join(" · ");
    }
    if (model?.error && !model?.resources?.length) {
        return "Unavailable";
    }
    if (model?.stale) {
        return `Running · ${model.resources.length} resources · Stale`;
    }
    return `Running · ${model?.resources?.length ?? 0} resources`;
}

export function buildAppHostTreeNode(record, model, {
    nestedResources = false,
    operation,
} = {}) {
    const resources = model?.resources ?? [];
    const resourceNodes = buildResourceTree(resources, record.id);
    const hasDashboard = Boolean(
        buildDashboardViewUrl(record.dashboardUrl)
        || resources.some((resource) => buildDashboardViewUrl(resource.dashboardUrl)),
    );
    const actions = appHostActions(record, operation)
        .filter((action) => action !== "dashboard" || hasDashboard);
    const appHostChildren = [
        ...(nestedResources && resourceNodes.length > 0 ? [{
            id: `apphost:${record.id}:resources`,
            kind: "resources-group",
            label: "Resources",
            description: `${resources.length}`,
            icon: "layers",
            appHostId: record.id,
            defaultExpanded: true,
            children: resourceNodes,
        }] : resourceNodes),
        ...(model?.compatibilityWarning ? [{
            id: `apphost:${record.id}:compatibility`,
            kind: "warning",
            label: "Some commands may be hidden",
            description: model.compatibilityWarning,
            icon: "warning",
            tone: "warning",
            appHostId: record.id,
            children: [],
        }] : []),
        ...(model?.error ? [{
            id: `apphost:${record.id}:error`,
            kind: "error",
            label: model.stale ? "Resource state is stale" : "Resources unavailable",
            description: model.error,
            icon: "error",
            tone: "error",
            appHostId: record.id,
            children: [],
        }] : []),
    ];
    return {
        id: `apphost:${record.id}`,
        kind: record.status === "running" ? "apphost-running" : "apphost-idle",
        label: record.displayName,
        description: rootDescription(record, model, operation),
        icon: record.status === "running" ? "apphost-running" : "apphost-idle",
        tone: model?.error && !model?.stale ? "error" : record.status === "running" ? "healthy" : "inactive",
        appHostId: record.id,
        identityHint: appHostIdentityHint(record),
        actions,
        unavailableActionReason: appHostUnavailableReason(record),
        unavailableActionLabel: appHostUnavailableReason(record) ? "Build not confirmed" : undefined,
        operation,
        defaultExpanded: record.status === "running",
        children: appHostChildren,
    };
}

function directoryKey(value) {
    return normalizePathKey(dirname(value));
}

export function combineWorkspaceAppHosts(candidates, runningHosts) {
    const remainingCandidates = [...candidates];
    const combinedRunning = [];
    for (const running of runningHosts.filter((record) => record.status === "running")) {
        let matchIndex = remainingCandidates.findIndex((candidate) => candidate.id === running.id);
        if (matchIndex < 0) {
            const sameDirectory = remainingCandidates
                .map((candidate, index) => ({ candidate, index }))
                .filter(({ candidate }) => directoryKey(candidate.appHostPath) === directoryKey(running.appHostPath));
            if (sameDirectory.length === 1) {
                matchIndex = sameDirectory[0].index;
            }
        }
        if (matchIndex < 0) {
            combinedRunning.push({ ...running, runtimeId: running.id, buildable: true, status: "running" });
            continue;
        }
        const [candidate] = remainingCandidates.splice(matchIndex, 1);
        combinedRunning.push({
            ...candidate,
            ...running,
            id: candidate.id,
            appHostPath: candidate.appHostPath,
            runtimeId: running.id,
            status: "running",
        });
    }
    return { running: combinedRunning, idle: remainingCandidates };
}

export function buildWorkspaceTree({
    candidates,
    runningHosts,
    models = new Map(),
    operations = new Map(),
}) {
    const combined = combineWorkspaceAppHosts(candidates, runningHosts);
    const runningNodes = combined.running.map((record) =>
        buildAppHostTreeNode(record, modelFor(models, record), {
            nestedResources: combined.running.length > 1,
            operation: operations.get(record.id),
        }));
    const idleNodes = combined.idle.map((record) =>
        buildAppHostTreeNode(record, undefined, { operation: operations.get(record.id) }));
    const pairs = [
        ...runningNodes.map((node, index) => ({ node, record: combined.running[index] })),
        ...idleNodes.map((node, index) => ({ node, record: combined.idle[index] })),
    ];
    applyLocationHints(pairs);
    applyWorkspaceLocations(pairs);
    const byLabel = (left, right) => left.label.localeCompare(right.label);
    return [...runningNodes.sort(byLabel), ...idleNodes.sort(byLabel)];
}

export function buildGlobalTree({
    runningHosts,
    models = new Map(),
    operations = new Map(),
}) {
    const nodes = runningHosts.map((record) => buildAppHostTreeNode(record, modelFor(models, record), {
        nestedResources: true,
        operation: operations.get(record.id),
    }));
    applyLocationHints(nodes.map((node, index) => ({ node, record: runningHosts[index] })));
    return nodes.sort((left, right) => left.label.localeCompare(right.label));
}

function nodeMatches(node, query) {
    return [node.label, node.description].some((value) => String(value ?? "").toLowerCase().includes(query));
}

export function filterTree(nodes, query) {
    const normalizedQuery = String(query ?? "").trim().toLowerCase();
    if (!normalizedQuery) {
        return nodes;
    }
    return nodes
        .map((node) => {
            const children = filterTree(node.children ?? [], normalizedQuery);
            return nodeMatches(node, normalizedQuery) || children.length > 0
                ? { ...node, defaultExpanded: children.length > 0, children }
                : undefined;
        })
        .filter(Boolean);
}

export async function mapWithConcurrency(items, limit, mapper) {
    if (!Number.isInteger(limit) || limit < 1) {
        throw new Error("Concurrency limit must be a positive integer.");
    }

    const results = new Array(items.length);
    let nextIndex = 0;
    const worker = async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) {
                return;
            }
            results[index] = await mapper(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

export function optionalFlagIsUnsupported(result, optionalFlag) {
    const flag = escapeRegExp(optionalFlag);
    const output = [result?.error, result?.stderr, result?.stdout].filter(Boolean).join("\n");
    return new RegExp(
        `(?:unrecognized|unknown|unsupported|not supported|not a valid)[^\\r\\n]{0,120}${flag}`
        + `|${flag}[^\\r\\n]{0,120}(?:unrecognized|unknown|unsupported|not supported|not found)`
        + `|resource\\s+['"]?${flag}['"]?\\s+(?:was\\s+)?not found`,
        "i",
    ).test(output);
}

export async function runWithOptionalFlagFallback(
    run,
    args,
    optionalFlag,
    shouldRetry = optionalFlagIsUnsupported,
) {
    const first = await run(args);
    if (!args.includes(optionalFlag) || !shouldRetry(first, optionalFlag)) {
        return first;
    }
    const fallback = await run(args.filter((argument) => argument !== optionalFlag));
    return { ...fallback, optionalFlagFallbackUsed: true };
}

export class SnapshotGeneration {
    #generation = 0;

    next() {
        return ++this.#generation;
    }

    isCurrent(generation) {
        return generation === this.#generation;
    }

    invalidate() {
        this.#generation++;
    }
}

export class AppHostOperationCoordinator {
    #operations = new Map();

    isBusy(appHostId) {
        return this.#operations.has(appHostId);
    }

    operation(appHostId) {
        return this.#operations.get(appHostId)?.metadata;
    }

    async run(appHostId, metadata, action) {
        if (this.#operations.has(appHostId)) {
            const error = new Error("An operation is already running for this AppHost.");
            error.code = "apphost_busy";
            throw error;
        }
        const entry = { metadata };
        const promise = Promise.resolve().then(action);
        entry.promise = promise;
        this.#operations.set(appHostId, entry);
        try {
            return await promise;
        } finally {
            if (this.#operations.get(appHostId) === entry) {
                this.#operations.delete(appHostId);
            }
        }
    }
}

function commandInputMetadataKey(appHostId, resourceName, commandName) {
    return JSON.stringify([appHostId, resourceName, commandName]);
}

function commandInputMetadataSignature(inputs) {
    return JSON.stringify(Array.isArray(inputs) ? inputs : []);
}

export class CommandInputMetadataStore {
    #entries = new Map();
    #fingerprintKey = randomBytes(32);

    #entry({ appHostId, resourceName, commandName, baseInputs }) {
        const key = commandInputMetadataKey(appHostId, resourceName, commandName);
        const entry = this.#entries.get(key);
        if (entry && entry.baseSignature !== commandInputMetadataSignature(baseInputs)) {
            this.#entries.delete(key);
            return undefined;
        }
        return entry;
    }

    #fingerprint(baseInputs, inputs, values) {
        const dependencies = [...new Set([...baseInputs, ...inputs]
            .flatMap((input) => input.dynamicLoading?.dependsOnInputs ?? []))].sort();
        // Keep dependency values (especially secrets) out of the cached authority.
        return createHmac("sha256", this.#fingerprintKey)
            .update(JSON.stringify(dependencies.map((name) => [
                name, values?.[name] == null ? null : String(values[name]),
            ]))).digest("hex");
    }

    beginLoad(options) {
        const previous = this.#entry(options);
        const ticket = Symbol("command-input-load");
        const { appHostId, resourceName, commandName, baseInputs } = options;
        const key = commandInputMetadataKey(appHostId, resourceName, commandName);
        this.#entries.set(key, {
            appHostId,
            resourceName,
            commandName,
            baseSignature: commandInputMetadataSignature(baseInputs),
            inputs: previous?.inputs,
            ticket,
            ready: false,
        });
        return ticket;
    }

    isCurrentLoad(options, ticket) {
        const entry = this.#entries.get(commandInputMetadataKey(
            options.appHostId, options.resourceName, options.commandName,
        ));
        return entry?.ticket === ticket
            && entry?.baseSignature === commandInputMetadataSignature(options.baseInputs);
    }

    failLoad(options, ticket) {
        if (this.isCurrentLoad(options, ticket)) {
            const entry = this.#entries.get(commandInputMetadataKey(
                options.appHostId, options.resourceName, options.commandName,
            ));
            entry.ready = false;
            entry.ticket = undefined;
        }
    }

    set({ appHostId, resourceName, commandName, baseInputs, inputs, values = {}, ticket }) {
        const options = { appHostId, resourceName, commandName, baseInputs };
        if (ticket && !this.isCurrentLoad(options, ticket)) {
            return false;
        }
        const key = commandInputMetadataKey(appHostId, resourceName, commandName);
        this.#entries.set(key, {
            ...options,
            baseSignature: commandInputMetadataSignature(baseInputs),
            inputs,
            fingerprint: this.#fingerprint(baseInputs ?? [], inputs, values),
            ready: true,
        });
        return true;
    }

    inputsFor(options) {
        return this.#entry(options)?.inputs;
    }

    executionInputsFor(options, values) {
        const entry = this.#entry(options);
        if (!entry) {
            return options.baseInputs?.some((input) => input.dynamicLoading)
                ? undefined : options.baseInputs ?? [];
        }
        if (!entry.ready || entry.fingerprint !== this.#fingerprint(options.baseInputs ?? [], entry.inputs, values)) {
            return undefined;
        }
        return entry.inputs;
    }

    prune(isCurrent) {
        for (const [key, entry] of this.#entries) {
            if (!isCurrent(entry)) {
                this.#entries.delete(key);
            }
        }
    }
}

export class KeyedTaskQueue {
    #tails = new Map();

    async run(key, action) {
        const previous = this.#tails.get(key) ?? Promise.resolve();
        const current = previous.catch(() => {}).then(action);
        this.#tails.set(key, current);
        try {
            return await current;
        } finally {
            if (this.#tails.get(key) === current) {
                this.#tails.delete(key);
            }
        }
    }
}

async function pathExists(path) {
    assertLocalAppHostPath(path);
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

async function configuredAppHostFrom(directory) {
    assertLocalAppHostPath(directory);
    const configPath = join(directory, "aspire.config.json");
    try {
        const config = JSON.parse(await readFile(configPath, "utf8"));
        const configuredPath = optionalText(config?.appHost?.path, 4000);
        if (!configuredPath) {
            return undefined;
        }
        assertLocalAppHostPath(configuredPath);
        const appHostPath = resolve(directory, configuredPath);
        return await pathExists(appHostPath) ? appHostPath : undefined;
    } catch (error) {
        if (error.code === "network_apphost_target") {
            throw error;
        }
        return undefined;
    }
}

async function scanImmediateAppHosts(directory) {
    const results = [];
    let entries;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch {
        return results;
    }

    for (const entry of entries) {
        const sourceAppHost = SINGLE_FILE_APPHOST_NAMES.includes(entry.name.toLowerCase());
        if (
            (entry.isFile() && (/\.apphost\.csproj$/i.test(entry.name) || sourceAppHost))
            || (entry.isSymbolicLink() && sourceAppHost && await pathExists(join(directory, entry.name)))
        ) {
            results.push(join(directory, entry.name));
            continue;
        }
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
            continue;
        }
        let children;
        try {
            children = await readdir(join(directory, entry.name), { withFileTypes: true });
        } catch {
            continue;
        }
        for (const child of children) {
            if (
                child.isFile()
                && (
                    /\.apphost\.csproj$/i.test(child.name)
                    || SINGLE_FILE_APPHOST_NAMES.includes(child.name.toLowerCase())
                )
            ) {
                results.push(join(directory, entry.name, child.name));
            }
        }
    }
    return results;
}

export async function discoverConfiguredAppHosts(workingDirectory) {
    assertLocalAppHostPath(workingDirectory || process.cwd());
    const start = resolve(workingDirectory || process.cwd());
    let current = start;
    for (let depth = 0; depth < 10; depth++) {
        const configured = await configuredAppHostFrom(current);
        if (configured) {
            return [normalize(configured)];
        }
        const parent = dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }

    const scanned = await scanImmediateAppHosts(start);
    return [...new Map(scanned.map((value) => [normalizePathKey(value), normalize(value)])).values()];
}

// Doctor keeps the same policy in its helpers because extensions install independently.
export async function resolveCliExecutable(command, env = process.env) {
    if (process.platform !== "win32") {
        return command;
    }

    const extension = win32.extname(command).toLowerCase();
    if ([".cmd", ".bat"].includes(extension)) {
        throw new Error("ASPIRE_CLI batch wrappers (.cmd/.bat) are unsupported on Windows. Set ASPIRE_CLI to the Aspire executable (.exe).");
    }

    // win32.isAbsolute also accepts drive-dependent paths such as \aspire.exe.
    const fullyQualified = (value) => win32.isAbsolute(value) && win32.parse(value).root.length > 1;
    const commandPath = win32.normalize(command);
    if (fullyQualified(commandPath)) {
        return commandPath;
    }
    if (/[\\/]/.test(command) || win32.parse(command).root) {
        throw new Error("ASPIRE_CLI must name an executable on PATH or a fully qualified executable path on Windows. Relative executable paths are unsupported.");
    }

    const executableNames = extension ? [command, `${command}.exe`] : [`${command}.exe`];
    const pathKey = Object.keys(env).sort().find((key) => key.toUpperCase() === "PATH");
    const searchPath = pathKey === undefined ? "" : env[pathKey];
    for (const entry of String(searchPath ?? "").split(";")) {
        const directory = win32.normalize(entry.trim().replace(/^"(.*)"$/, "$1"));
        if (!fullyQualified(directory)) {
            continue;
        }
        for (const executableName of executableNames) {
            const candidate = win32.join(directory, executableName);
            try {
                if ((await stat(candidate)).isFile()) {
                    return candidate;
                }
            } catch (error) {
                if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
                    throw error;
                }
            }
        }
    }
    throw new Error(`Could not find '${command}' in fully qualified PATH directories. Set ASPIRE_CLI to the full path of the Aspire executable (.exe).`);
}

export async function runProcess(command, args, {
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    env,
    sensitiveValues = [],
    onOutput,
} = {}) {
    const secrets = [...new Set(sensitiveValues.flatMap((value) => {
        const text = String(value ?? "");
        return text ? [text, JSON.stringify(text).slice(1, -1)] : [];
    }))].sort((left, right) => right.length - left.length);
    const holdback = secrets.length ? secrets[0].length - 1 : 0;
    const pendingOutput = { stdout: "", stderr: "" };
    const emitOutput = (stream, flush) => {
        let text = pendingOutput[stream];
        for (const secret of secrets) {
            text = text.replaceAll(secret, "[redacted]");
        }
        // Holding back one secret length minus one keeps a secret split across
        // chunks from being emitted before it can be recognized.
        const cut = flush ? text.length : Math.max(0, text.length - holdback);
        pendingOutput[stream] = text.slice(cut);
        if (cut > 0) {
            try {
                onOutput(stream, text.slice(0, cut));
            } catch {
                // Output observers must not affect the process result.
            }
        }
    };
    const redactOutput = (value, incomplete) => {
        let text = String(value ?? "");
        for (const secret of secrets) {
            text = text.replaceAll(secret, "[redacted]");
        }
        if (incomplete) {
            for (const secret of secrets) {
                if (secret.length < 2) continue;
                // KMP finds the longest suffix that is an incomplete secret without
                // quadratic scans when a long secret has repeated characters.
                const prefixes = new Uint32Array(secret.length);
                for (let i = 1, matched = 0; i < secret.length; i++) {
                    while (matched && secret[i] !== secret[matched]) matched = prefixes[matched - 1];
                    if (secret[i] === secret[matched]) matched++;
                    prefixes[i] = matched;
                }
                let matched = 0;
                const tail = text.slice(-(secret.length - 1));
                for (let i = 0; i < tail.length; i++) {
                    const character = tail[i];
                    while (matched && character !== secret[matched]) matched = prefixes[matched - 1];
                    if (character === secret[matched]) matched++;
                }
                if (matched) text = `${text.slice(0, -matched)}[redacted]`;
            }
        }
        return text;
    };
    return new Promise((resolveResult) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timer;
        let child;

        const finish = (result) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timer) {
                clearTimeout(timer);
            }
            if (onOutput) {
                for (const stream of ["stdout", "stderr"]) {
                    pendingOutput[stream] = redactOutput(pendingOutput[stream], result.code === null);
                    emitOutput(stream, true);
                }
            }
            resolveResult({
                ...result,
                stdout: redactOutput(result.stdout, result.code === null),
                stderr: redactOutput(result.stderr, result.code === null),
                error: result.error === undefined
                    ? undefined : redactText(redactOutput(result.error, result.code === null), 8000),
            });
        };

        const append = (current, chunk) => {
            if (settled) {
                return current;
            }
            const next = current + chunk.toString();
            if (Buffer.byteLength(next, "utf8") > maxOutputBytes) {
                try {
                    child?.kill();
                } catch {
                    // The process may already have exited.
                }
                finish({
                    ok: false,
                    code: null,
                    stdout,
                    stderr,
                    error: `Aspire CLI output exceeded ${maxOutputBytes} bytes.`,
                });
                return current;
            }
            return next;
        };

        const deadline = performance.now() + timeoutMs;
        const onTimeout = () => {
            try {
                child?.kill();
            } catch {
                // The process may already have exited.
            }
            finish({
                ok: false,
                code: null,
                stdout,
                stderr,
                error: `Aspire CLI timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
            });
        };
        timer = setTimeout(onTimeout, timeoutMs);
        timer.unref?.();

        resolveCliExecutable(command, env).then((executable) => {
            if (settled) {
                return;
            }
            if (performance.now() >= deadline) {
                onTimeout();
                return;
            }
            try {
                child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true });
            } catch (error) {
                finish({ ok: false, code: null, stdout, stderr, error: `Failed to launch Aspire CLI: ${error.message}` });
                return;
            }

            child.stdout?.setEncoding("utf8");
            child.stderr?.setEncoding("utf8");
            child.stdout?.on("data", (chunk) => {
                const before = stdout;
                stdout = append(stdout, chunk);
                if (onOutput && stdout !== before) {
                    pendingOutput.stdout += stdout.slice(before.length);
                    emitOutput("stdout", false);
                }
            });
            child.stderr?.on("data", (chunk) => {
                const before = stderr;
                stderr = append(stderr, chunk);
                if (onOutput && stderr !== before) {
                    pendingOutput.stderr += stderr.slice(before.length);
                    emitOutput("stderr", false);
                }
            });
            child.once("error", (error) => {
                finish({ ok: false, code: null, stdout, stderr, error: `Failed to run Aspire CLI: ${error.message}` });
            });
            child.once("close", (code) => {
                finish({
                    ok: code === 0,
                    code,
                    stdout,
                    stderr,
                    error: code === 0 ? undefined : stderr || stdout || `Aspire CLI exited with code ${code}.`,
                });
            });
        }, (error) => {
            if (settled) {
                return;
            }
            if (performance.now() >= deadline) {
                onTimeout();
                return;
            }
            finish({ ok: false, code: null, stdout, stderr, error: `Failed to launch Aspire CLI: ${error.message}` });
        });
    });
}

const STREAM_STDERR_TAIL_BYTES = 4096;
const STREAM_MAX_LINE_BYTES = 1024 * 1024;

// Runs a long-lived CLI process and reports complete stdout lines. stderr is
// kept only as a bounded tail for diagnostics when the process exits.
export function streamProcess(command, args, {
    cwd,
    env,
    onLine,
    onExit,
    maxLineBytes = STREAM_MAX_LINE_BYTES,
} = {}) {
    let child = null;
    let killed = false;
    let exited = false;
    let pending = "";
    let stderrTail = "";
    const exit = (result) => {
        if (exited) return;
        exited = true;
        try {
            onExit?.({ ...result, stderrTail: redactText(stderrTail, STREAM_STDERR_TAIL_BYTES) });
        } catch {
            // Exit observers must not throw into the process event loop.
        }
    };
    const emit = (line) => {
        const text = line.trim();
        if (!text) return;
        try {
            onLine?.(text);
        } catch {
            // Line observers must not stop the stream.
        }
    };
    resolveCliExecutable(command, env).then((executable) => {
        if (killed) {
            exit({ code: null, error: undefined });
            return;
        }
        try {
            child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true });
        } catch (error) {
            exit({ code: null, error: redactText(`Failed to launch Aspire CLI: ${error.message}`, 8000) });
            return;
        }
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => {
            pending += chunk;
            let index;
            while ((index = pending.indexOf("\n")) >= 0) {
                const line = pending.slice(0, index);
                pending = pending.slice(index + 1);
                if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
                    pending = "";
                    try { child.kill(); } catch { /* already exited */ }
                    return;
                }
                emit(line);
            }
            if (Buffer.byteLength(pending, "utf8") > maxLineBytes) {
                pending = "";
                try { child.kill(); } catch { /* already exited */ }
            }
        });
        child.stderr?.on("data", (chunk) => {
            stderrTail = (stderrTail + chunk).slice(-STREAM_STDERR_TAIL_BYTES);
        });
        child.once("error", (error) => {
            exit({ code: null, error: redactText(`Failed to run Aspire CLI: ${error.message}`, 8000) });
        });
        child.once("close", (code) => {
            if (pending) emit(pending);
            pending = "";
            exit({ code, error: undefined });
        });
    }, (error) => {
        exit({ code: null, error: redactText(`Failed to launch Aspire CLI: ${error.message}`, 8000) });
    });
    return {
        kill() {
            if (killed) return;
            killed = true;
            try { child?.kill(); } catch { /* already exited */ }
        },
    };
}

export function createAspireCliRunner({
    command = process.env.ASPIRE_CLI?.trim() || (process.platform === "win32" ? "aspire.exe" : "aspire"),
    run = runProcess,
    stream = streamProcess,
} = {}) {
    return {
        async run(args, options = {}) {
            return run(command, args, options);
        },
        stream(args, options = {}) {
            return stream(command, args, options);
        },
        async runJson(args, options = {}) {
            const result = await run(command, args, options);
            return {
                ...result,
                data: result.ok ? extractJsonPayload(result.stdout) : undefined,
            };
        },
    };
}

function normalizeBoolean(value) {
    if (typeof value === "boolean") {
        return value;
    }
    const text = String(value ?? "").trim().toLowerCase();
    if (text === "true") {
        return true;
    }
    if (text === "false") {
        return false;
    }
    return undefined;
}

export function validateCommandArguments(command, values) {
    if (!isRecord(values)) {
        return { ok: false, errors: [{ argumentName: "", errorMessage: "Command arguments must be an object." }] };
    }

    const inputs = Array.isArray(command?.argumentInputs) ? command.argumentInputs : [];
    const inputByName = new Map(inputs.map((input) => [input.name, input]));
    const errors = [];
    const normalizedValues = {};

    for (const name of Object.keys(values)) {
        if (!inputByName.has(name)) {
            errors.push({ argumentName: name, errorMessage: "This argument is not declared by the command." });
        }
    }

    for (const input of inputs) {
        if (input.disabled) {
            continue;
        }
        const value = normalizeCommandValue(input.inputType, values[input.name]);
        const missing = value === undefined || value === null || value === "";
        if (missing) {
            if (input.required) {
                errors.push({ argumentName: input.name, errorMessage: `${input.label || input.name} is required.` });
            }
            continue;
        }

        const kind = input.inputType.toLowerCase();
        if (kind.includes("boolean") || kind === "checkbox") {
            const booleanValue = normalizeBoolean(value);
            if (booleanValue === undefined) {
                errors.push({ argumentName: input.name, errorMessage: `${input.label || input.name} must be true or false.` });
            } else {
                normalizedValues[input.name] = booleanValue;
            }
            continue;
        }
        if (kind.includes("number")) {
            const numberValue = Number(value);
            if (!Number.isFinite(numberValue)) {
                errors.push({ argumentName: input.name, errorMessage: `${input.label || input.name} must be a number.` });
            } else {
                normalizedValues[input.name] = numberValue;
            }
            continue;
        }

        const textValue = String(value);
        if (input.maxLength && textValue.length > input.maxLength) {
            errors.push({
                argumentName: input.name,
                errorMessage: `${input.label || input.name} must be ${input.maxLength} characters or fewer.`,
            });
            continue;
        }

        if (input.options?.length > 0 && !input.allowCustomChoice) {
            const allowed = new Set(input.options.map((option) => option.value));
            if (!allowed.has(textValue)) {
                errors.push({ argumentName: input.name, errorMessage: `${input.label || input.name} has an invalid choice.` });
                continue;
            }
        }
        normalizedValues[input.name] = textValue;
    }

    return { ok: errors.length === 0, values: normalizedValues, errors };
}

export function buildCommandArgumentTokens(values = {}) {
    const entries = Object.entries(values);
    return entries.length > 0
        ? ["--", ...entries.map(([name, value]) => `--${name}=${String(value)}`)]
        : [];
}

export function buildResourceCommandArgs({ appHostPath, resourceName, commandName, arguments: values = {} }) {
    const args = [
        "resource",
        resourceName,
        commandName,
        "--apphost",
        appHostPath,
        "--non-interactive",
        "--nologo",
    ];
    return [...args, ...buildCommandArgumentTokens(values)];
}

export function publicAppHost(record, selectedAppHostId) {
    return {
        id: record.id,
        displayName: record.displayName,
        identityHint: appHostIdentityHint(record),
        status: record.status,
        sdkVersion: record.sdkVersion,
        selected: record.id === selectedAppHostId,
    };
}

export function createStoppedAppHost(appHostPath) {
    return {
        id: stableId(normalizePathKey(appHostPath)),
        appHostPath: normalize(appHostPath),
        displayName: appHostDisplayName(appHostPath),
        status: "stopped",
    };
}

export function dedupeAppHosts(records) {
    const byPath = new Map();
    for (const record of records) {
        const key = normalizePathKey(record.appHostPath);
        const existing = byPath.get(key);
        if (!existing || record.status === "running") {
            byPath.set(key, record);
        }
    }
    return [...byPath.values()].sort((left, right) =>
        left.displayName.localeCompare(right.displayName) || left.appHostPath.localeCompare(right.appHostPath));
}

function isAppHostFilePath(value) {
    const fileName = basename(value).toLowerCase();
    return fileName.endsWith(".csproj") || SINGLE_FILE_APPHOST_NAMES.includes(fileName);
}

async function appHostFileFromDirectory(directory) {
    let entries;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch {
        throw new Error("The AppHost directory could not be read.");
    }
    const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    const candidateGroups = [
        fileNames.filter((name) => /\.apphost\.csproj$/i.test(name)),
        fileNames.filter((name) => /^apphost\.(?:ts|mts|go)$/i.test(name)),
        fileNames.filter((name) => /\.csproj$/i.test(name)),
        fileNames.filter((name) => /^apphost\.cs$/i.test(name)),
    ];
    for (const candidates of candidateGroups) {
        if (candidates.length === 1) {
            return join(directory, candidates[0]);
        }
        if (candidates.length > 1) {
            throw new Error("The AppHost directory contains multiple candidate AppHost files.");
        }
    }
    throw new Error("The AppHost directory does not contain a supported AppHost file.");
}

export async function resolveRequestedAppHostPath(value, workingDirectory) {
    assertLocalAppHostPath(value);
    assertLocalAppHostPath(workingDirectory);
    const text = optionalText(value, 4000);
    if (!text) {
        return undefined;
    }
    const requestedPath = normalize(isAbsolute(text) ? text : resolve(workingDirectory, text));
    assertLocalAppHostPath(requestedPath);
    let info;
    try {
        info = await stat(requestedPath);
    } catch {
        throw new Error("The requested AppHost path does not exist.");
    }
    if (info.isFile()) {
        if (!isAppHostFilePath(requestedPath)) {
            throw new Error("The requested AppHost path is not a supported AppHost file.");
        }
        return requestedPath;
    }
    if (!info.isDirectory()) {
        throw new Error("The requested AppHost path is not a file or directory.");
    }
    return normalize(await appHostFileFromDirectory(requestedPath));
}

export function defaultCwdForAppHost(appHostPath, fallback) {
    if (!appHostPath) {
        return fallback;
    }
    return isAppHostFilePath(appHostPath) ? dirname(appHostPath) : appHostPath;
}

export function appHostOperationKey(appHostPath) {
    return stableId(normalizePathKey(defaultCwdForAppHost(appHostPath, appHostPath)));
}
