import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const ALLOWED_STATE_STYLES = new Set(["success", "warning", "error", "info"]);
const ALLOWED_RELATIONSHIP_TYPES = new Set(["Reference", "WaitFor", "Parent"]);
const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:"]);
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
    return pathRelative === "" || (!pathRelative.startsWith("..") && !isAbsolute(pathRelative));
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
        if (url.pathname.toLowerCase().includes("/login")) {
            url.pathname = "/";
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
    const value = inputType.toLowerCase().includes("secret")
        ? undefined
        : optionalText(raw.value, Number.isFinite(maxLength) && maxLength > 0 ? Math.min(maxLength, 100_000) : 100_000);
    const safeValue = value && options.length > 0 && !allowCustomChoice
        ? options.some((option) => option.value === value) ? value : undefined
        : value;
    return {
        name,
        label: optionalText(raw.label, 240) ?? name,
        description: optionalText(raw.description, 1000),
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
            return {
                name: clampText(name, 160),
                status: optionalText(report.status, 80) ?? "Unknown",
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
    if (resource.stateStyle === "error" || health === "unhealthy" || state === "failedtostart" || state === "runtimeunhealthy") {
        return "error";
    }

    if (
        resource.stateStyle === "warning"
        || health === "degraded"
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

export function redactAbsolutePaths(value) {
    return String(value ?? "")
        .replace(/(["'`])[A-Za-z]:\\[^"'`\r\n]+\1/g, "$1[path withheld]$1")
        .replace(
            new RegExp(`\\b[A-Za-z]:\\\\${PATH_COMPONENT_PATTERN}${PATH_TAIL_PATTERN}`, "g"),
            "[path withheld]",
        )
        .replace(/(["'`])\/(?:Users|home|tmp|var|private|opt|usr|mnt|Volumes|workspaces|srv|data|app)\/[^"'`\r\n]+\1/g, "$1[path withheld]$1")
        .replace(
            new RegExp(
                `\\/(?:Users|home|tmp|var|private|opt|usr|mnt|Volumes|workspaces|srv|data|app)`
                + `${PATH_TAIL_PATTERN}`,
                "g",
            ),
            "[path withheld]",
        );
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
    if (["apphost.cs", "apphost.ts", "apphost.mts"].includes(fileName.toLowerCase())) {
        return basename(dirname(appHostPath)) || "AppHost";
    }
    const withoutExtension = extension ? fileName.slice(0, -extension.length) : fileName;
    return withoutExtension.replace(/\.apphost$/i, "") || "AppHost";
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

function resourceDescription(resource) {
    const parts = [resource.resourceType];
    if (resource.state) {
        parts.push(resource.state);
    }
    if (resource.exitCode !== undefined && resource.exitCode !== 0) {
        parts.push(`Exit code ${resource.exitCode}`);
    }
    if (resource.resourceType.toLowerCase().includes("parameter")) {
        parts.push("Value protected");
    }
    return parts.join(" · ");
}

function resourceStatusLabel(resource) {
    if (resource.healthReports.length > 0) {
        const healthy = resource.healthReports.filter((report) => report.status === "Healthy").length;
        return healthy === resource.healthReports.length
            ? "Healthy"
            : `${healthy}/${resource.healthReports.length} healthy`;
    }
    return resource.healthStatus || resource.state || undefined;
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

function endpointNode(appHostId, resource, endpoint, index) {
    return {
        id: `apphost:${appHostId}:resource:${resource.name}:endpoint:${index}`,
        kind: "endpoint",
        label: endpoint.displayName || endpoint.name || endpoint.url,
        description: endpoint.url,
        icon: endpoint.isLinkable ? "link" : "endpoint",
        href: endpoint.isLinkable ? endpoint.url : undefined,
        appHostId,
        resourceName: resource.name,
        children: [],
    };
}

function healthGroupNode(appHostId, resource) {
    const healthy = resource.healthReports.filter((report) => report.status === "Healthy").length;
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
            .map((report) => ({
                id: `apphost:${appHostId}:resource:${resource.name}:health:${stableId(report.name)}`,
                kind: "health-check",
                label: report.name,
                statusLabel: report.status,
                icon: report.status === "Healthy" ? "pass" : report.status === "Degraded" ? "warning" : "error",
                tone: report.status === "Healthy" ? "healthy" : report.status === "Degraded" ? "warning" : "error",
                appHostId,
                resourceName: resource.name,
                healthCheckName: report.name,
                children: [],
            })),
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
            icon: resourceStateIcon(resource),
            tone: classifyResource(resource),
            appHostId,
            resourceName: resource.name,
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

function baseDashboardUrl(resources) {
    const value = resources.find((resource) => resource.dashboardUrl)?.dashboardUrl;
    if (!value) {
        return undefined;
    }
    try {
        const url = new URL(value);
        url.searchParams.delete("resource");
        return url.toString();
    } catch {
        return undefined;
    }
}

export function buildAppHostTreeNode(record, model, {
    nestedResources = false,
    operation,
} = {}) {
    const resources = model?.resources ?? [];
    const resourceNodes = buildResourceTree(resources, record.id);
    const dashboardUrl = baseDashboardUrl(resources);
    const actions = appHostActions(record, operation)
        .filter((action) => action !== "dashboard" || dashboardUrl);
    const appHostChildren = [
        ...(dashboardUrl ? [{
            id: `apphost:${record.id}:dashboard`,
            kind: "endpoint",
            label: "Dashboard",
            description: dashboardUrl,
            icon: "dashboard",
            href: dashboardUrl,
            appHostId: record.id,
            children: [],
        }] : []),
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
        actions,
        unavailableActionReason: appHostUnavailableReason(record),
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
    const byLabel = (left, right) => left.label.localeCompare(right.label);
    return [...runningNodes.sort(byLabel), ...idleNodes.sort(byLabel)];
}

export function buildGlobalTree({
    runningHosts,
    models = new Map(),
    operations = new Map(),
}) {
    return runningHosts
        .map((record) => buildAppHostTreeNode(record, modelFor(models, record), {
            nestedResources: true,
            operation: operations.get(record.id),
        }))
        .sort((left, right) => left.label.localeCompare(right.label));
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

    set({ appHostId, resourceName, commandName, baseInputs, inputs }) {
        const key = commandInputMetadataKey(appHostId, resourceName, commandName);
        this.#entries.set(key, {
            appHostId,
            resourceName,
            commandName,
            baseSignature: commandInputMetadataSignature(baseInputs),
            inputs,
        });
    }

    inputsFor({ appHostId, resourceName, commandName, baseInputs }) {
        const key = commandInputMetadataKey(appHostId, resourceName, commandName);
        const entry = this.#entries.get(key);
        if (!entry) {
            return undefined;
        }
        if (entry.baseSignature !== commandInputMetadataSignature(baseInputs)) {
            this.#entries.delete(key);
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
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

async function configuredAppHostFrom(directory) {
    const configPath = join(directory, "aspire.config.json");
    try {
        const config = JSON.parse(await readFile(configPath, "utf8"));
        const configuredPath = optionalText(config?.appHost?.path, 4000);
        if (!configuredPath) {
            return undefined;
        }
        const appHostPath = resolve(directory, configuredPath);
        return await pathExists(appHostPath) ? appHostPath : undefined;
    } catch {
        return undefined;
    }
}

async function scanImmediateAppHosts(directory) {
    const results = [];
    const directCandidates = [
        join(directory, "apphost.cs"),
        join(directory, "apphost.ts"),
        join(directory, "apphost.mts"),
    ];
    for (const candidate of directCandidates) {
        if (await pathExists(candidate)) {
            results.push(candidate);
        }
    }

    let entries;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch {
        return results;
    }

    for (const entry of entries) {
        if (entry.isFile() && /\.apphost\.csproj$/i.test(entry.name)) {
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
                    || child.name.toLowerCase() === "apphost.cs"
                    || child.name.toLowerCase() === "apphost.ts"
                    || child.name.toLowerCase() === "apphost.mts"
                )
            ) {
                results.push(join(directory, entry.name, child.name));
            }
        }
    }
    return results;
}

export async function discoverConfiguredAppHosts(workingDirectory) {
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

function windowsCliSpawn(command, args, options) {
    const encodedArgs = Buffer.from(JSON.stringify(args), "utf8").toString("base64");
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ASPIRE_CANVAS_ARGS_B64))",
        "$parsedArgs = ConvertFrom-Json -InputObject $json",
        "[string[]]$cliArgs = @()",
        "foreach ($item in $parsedArgs) { $cliArgs += [string]$item }",
        "& $env:ASPIRE_CANVAS_CLI @cliArgs",
        "if ($null -eq $LASTEXITCODE) { exit 0 } else { exit $LASTEXITCODE }",
    ].join("; ");
    return spawn(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
            ...options,
            env: {
                ...process.env,
                ...options.env,
                ASPIRE_CANVAS_CLI: command,
                ASPIRE_CANVAS_ARGS_B64: encodedArgs,
            },
        },
    );
}

export function runProcess(command, args, {
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    env,
} = {}) {
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
            resolveResult(result);
        };

        const append = (current, chunk) => {
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

        try {
            const spawnOptions = { cwd, env, windowsHide: true };
            const commandExtension = extname(command).toLowerCase();
            child = process.platform === "win32" && [".cmd", ".bat"].includes(commandExtension)
                ? windowsCliSpawn(command, args, spawnOptions)
                : spawn(command, args, spawnOptions);
        } catch (error) {
            finish({ ok: false, code: null, stdout, stderr, error: `Failed to launch Aspire CLI: ${error.message}` });
            return;
        }

        child.stdout?.on("data", (chunk) => {
            stdout = append(stdout, chunk);
        });
        child.stderr?.on("data", (chunk) => {
            stderr = append(stderr, chunk);
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
                error: code === 0 ? undefined : redactText(stderr || stdout || `Aspire CLI exited with code ${code}.`, 8000),
            });
        });

        timer = setTimeout(() => {
            try {
                child.kill();
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
        }, timeoutMs);
        timer.unref?.();
    });
}

export function createAspireCliRunner({
    command = process.env.ASPIRE_CLI?.trim() || (process.platform === "win32" ? "aspire.exe" : "aspire"),
    run = runProcess,
} = {}) {
    return {
        async run(args, options = {}) {
            return run(command, args, options);
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
        const value = values[input.name];
        const missing = value === undefined || value === null || (typeof value === "string" && value.trim() === "");
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
    return fileName.endsWith(".csproj") || ["apphost.cs", "apphost.ts", "apphost.mts"].includes(fileName);
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
        fileNames.filter((name) => /^apphost\.(?:ts|mts)$/i.test(name)),
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
    const text = optionalText(value, 4000);
    if (!text) {
        return undefined;
    }
    const requestedPath = normalize(isAbsolute(text) ? text : resolve(workingDirectory, text));
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
