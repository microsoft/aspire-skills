import { createHash } from "node:crypto";
export { classifyServiceKind, isDotNetType } from "./ui/resource-types.js";

const OWNERSHIP_KINDS = new Set([
    "aspire-managed",
    "service-owned",
    "external-infrastructure",
    "shared",
    "unknown",
]);
const IMPACT_STATES = new Set(["none", "required", "optional", "unknown"]);
const FACT_KINDS = new Set(["assumption", "risk"]);
const FACT_SEVERITIES = new Set(["info", "warning", "blocking"]);
const FACT_VERIFICATIONS = new Set([
    "assumption",
    "verified",
    "unverified",
    "needs-chat-decision",
]);
const DECISION_STATES = new Set(["resolved", "needs-chat-decision"]);

export function exactType(value, fallback = "") {
    return String(value ?? "").trim() || fallback;
}

export function normalizeOwnership(value) {
    if (typeof value === "string") {
        return {
            kind: "unknown",
            label: value.trim(),
            owner: "",
        };
    }
    const kind = OWNERSHIP_KINDS.has(value?.kind) ? value.kind : "unknown";
    return {
        kind,
        label: String(value?.label ?? "").trim(),
        owner: String(value?.owner ?? "").trim(),
    };
}

export function normalizePort(value, index = 0) {
    if (typeof value === "number" || typeof value === "string") {
        return {
            name: "",
            port: String(value).trim(),
            targetPort: "",
            protocol: "",
            purpose: "",
        };
    }
    return {
        name: String(value?.name ?? "").trim(),
        port: String(value?.port ?? "").trim(),
        targetPort: String(value?.targetPort ?? "").trim(),
        protocol: String(value?.protocol ?? "").trim(),
        purpose: String(value?.purpose ?? "").trim(),
        id: String(value?.id ?? `port-${index + 1}`).trim(),
    };
}

export function normalizePackage(value) {
    if (typeof value === "string") {
        return {
            name: value.trim(),
            version: "",
        };
    }
    return {
        name: String(value?.name ?? "").trim(),
        version: String(value?.version ?? "").trim(),
    };
}

export function normalizeServiceCodeImpact(value) {
    if (typeof value === "string") {
        return {
            state: "unknown",
            summary: value.trim(),
            files: [],
        };
    }
    return {
        state: IMPACT_STATES.has(value?.state) ? value.state : "unknown",
        summary: String(value?.summary ?? "").trim(),
        files: normalizeStrings(value?.files),
    };
}

export function normalizeFact(value, index = 0) {
    return {
        id: String(value?.id ?? `fact-${index + 1}`).trim(),
        kind: FACT_KINDS.has(value?.kind) ? value.kind : "assumption",
        severity: FACT_SEVERITIES.has(value?.severity) ? value.severity : "info",
        verification: FACT_VERIFICATIONS.has(value?.verification)
            ? value.verification
            : "assumption",
        title: String(value?.title ?? "").trim(),
        detail: String(value?.detail ?? "").trim(),
    };
}

export function normalizeDecision(value, index = 0) {
    return {
        id: String(value?.id ?? `decision-${index + 1}`).trim(),
        title: String(value?.title ?? "").trim(),
        summary: String(value?.summary ?? "").trim(),
        status: DECISION_STATES.has(value?.status) ? value.status : "needs-chat-decision",
    };
}

export function normalizeScope(value) {
    return {
        appHostFiles: normalizeStrings(value?.appHostFiles),
        integrationPackages: normalizePackages(value?.integrationPackages),
        serviceCodeImpacts: Array.isArray(value?.serviceCodeImpacts)
            ? value.serviceCodeImpacts.map((impact, index) => ({
                  serviceId: String(impact?.serviceId ?? "").trim(),
                  serviceName: String(impact?.serviceName ?? "").trim(),
                  ...normalizeServiceCodeImpact(impact),
                  id: String(impact?.id ?? `impact-${index + 1}`).trim(),
              }))
            : [],
    };
}

export function normalizeProposalMetadata(value, now = () => new Date()) {
    const suppliedDate = new Date(value?.generatedAt ?? "");
    const generatedAt = Number.isNaN(suppliedDate.getTime())
        ? now().toISOString()
        : suppliedDate.toISOString();
    return {
        generatedAt,
        assumptionsRisks: Array.isArray(value?.assumptionsRisks)
            ? value.assumptionsRisks.map(normalizeFact)
            : [],
        decisions: Array.isArray(value?.decisions)
            ? value.decisions.map(normalizeDecision)
            : [],
        scope: normalizeScope(value?.scope),
    };
}

export function normalizePorts(values) {
    return Array.isArray(values) ? values.map(normalizePort).filter(hasPortContent) : [];
}

export function normalizePackages(values) {
    return Array.isArray(values)
        ? values.map(normalizePackage).filter((package_) => package_.name)
        : [];
}

export function unresolvedDecisions(proposal) {
    const decisions = Array.isArray(proposal?.decisions) ? proposal.decisions : [];
    const facts = Array.isArray(proposal?.assumptionsRisks) ? proposal.assumptionsRisks : [];
    return [
        ...decisions.filter((decision) => decision.status === "needs-chat-decision"),
        ...facts
            .filter((fact) => fact.verification === "needs-chat-decision")
            .map((fact) => ({
                id: fact.id,
                title: fact.title,
                summary: fact.detail,
                status: "needs-chat-decision",
            })),
    ];
}

export function presentationMode(proposal) {
    const count = Array.isArray(proposal?.resources)
        ? proposal.resources.filter((resource) => resource.include !== false).length
        : 0;
    return count <= 2 ? "compact" : "relationship";
}

export function includedServicesForProposal(services, resources) {
    const mappedServiceIds = mappedIncludedServiceIds(resources);
    return (services ?? []).filter(
        (service) =>
            service.include &&
            (service.proposalCandidate || mappedServiceIds.has(service.id)),
    );
}

export function unmappedExternalServicesForProposal(services, resources) {
    const mappedServiceIds = mappedIncludedServiceIds(resources);
    return (services ?? []).filter(
        (service) =>
            service.ownership?.kind === "external-infrastructure" &&
            !mappedServiceIds.has(service.id),
    );
}

export function stableProposalHash({ proposalGeneration, proposal }) {
    const hashInput = {
        proposalGeneration: Number(proposalGeneration) || 0,
        proposal: stripTransientProposalFields(proposal),
    };
    return createHash("sha256").update(canonicalJson(hashInput)).digest("hex");
}

export function freezeSnapshot(value) {
    return deepFreeze(structuredClone(value));
}

function stripTransientProposalFields(proposal) {
    return {
        generatedAt: String(proposal?.generatedAt ?? ""),
        resources: (proposal?.resources ?? [])
            .filter((resource) => resource.include !== false)
            .map(
                ({
                    userAdded,
                    userEdited,
                    sourceId,
                    sourceKey,
                    include,
                    ...resource
                }) => resource,
            ),
        edges: (proposal?.edges ?? []).map(
            ({ userAdded, userEdited, sourceId, sourceKey, ...edge }) => edge,
        ),
        assumptionsRisks: proposal?.assumptionsRisks ?? [],
        decisions: proposal?.decisions ?? [],
        scope: proposal?.scope ?? normalizeScope(),
    };
}

function canonicalJson(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (value && typeof value === "object") {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

function normalizeStrings(values) {
    return Array.isArray(values)
        ? values.map((value) => String(value ?? "").trim()).filter(Boolean)
        : [];
}

function hasPortContent(port) {
    return Boolean(port.name || port.port || port.targetPort || port.protocol || port.purpose);
}

function mappedIncludedServiceIds(resources) {
    return new Set(
        (resources ?? [])
            .filter((resource) => resource.include && resource.serviceId)
            .map((resource) => resource.serviceId),
    );
}

function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) {
        return value;
    }
    for (const nested of Object.values(value)) {
        deepFreeze(nested);
    }
    return Object.freeze(value);
}
