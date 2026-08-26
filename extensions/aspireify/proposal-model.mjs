import { createHash } from "node:crypto";
export { classifyServiceKind, isDotNetType } from "./ui/resource-types.js";

export function exactType(value, fallback = "") {
    return String(value ?? "").trim() || fallback;
}

export function presentationMode(proposal) {
    const count = Array.isArray(proposal?.resources)
        ? proposal.resources.filter((resource) => resource.include !== false).length
        : 0;
    return count <= 2 ? "compact" : "relationship";
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
            .map(({ userAdded, userEdited, sourceName, include, ...resource }) => resource),
        edges: (proposal?.edges ?? []).map(
            ({ userAdded, userEdited, sourceId, sourceKey, ...edge }) => edge,
        ),
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

function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) {
        return value;
    }
    for (const nested of Object.values(value)) {
        deepFreeze(nested);
    }
    return Object.freeze(value);
}
