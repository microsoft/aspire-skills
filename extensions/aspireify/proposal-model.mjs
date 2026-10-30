import { createHash } from "node:crypto";
export {
    classifyAspireResourceKind,
    classifyServiceKind,
    compatibleAspireResourceTypes,
    isCompatibleAspireResourceKind,
    isCompatibleAspireResourceType,
    isDotNetType,
} from "./ui/resource-types.js";

export function exactType(value, fallback = "") {
    return String(value ?? "").trim() || fallback;
}

function derivedResourceName(value) {
    const normalized = String(value ?? "")
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
    if (!normalized) {
        return "";
    }
    const prefixed = /^[a-z]/.test(normalized) ? normalized : `service-${normalized}`;
    return prefixed.slice(0, 64).replace(/-+$/g, "");
}

export function resourceNameFrom(value, index) {
    return derivedResourceName(value) || `service-${index + 1}`;
}

// Fallback names for services without ASCII letters or digits must not collide with
// names derived from, or supplied for, any other service in the same discovery.
export function assignResourceNames(services) {
    const names = services.map((service) =>
        service?.resourceName == null
            ? derivedResourceName(service?.name)
            : String(service.resourceName).trim(),
    );
    const taken = new Set(names.filter(Boolean).map((name) => name.toLowerCase()));
    return names.map((name, index) => {
        if (name || services[index]?.resourceName != null) {
            return name;
        }
        let candidate = index + 1;
        while (taken.has(`service-${candidate}`)) {
            candidate += 1;
        }
        const fallback = `service-${candidate}`;
        taken.add(fallback);
        return fallback;
    });
}

// Discovered services that no proposal resource or removed generated resource maps.
// The skill supplied no treatment for them, so they are reported as not assessed.
export function unproposedServices({ services, resources, removedGeneratedResources }) {
    const mappedIds = new Set(
        [...(resources ?? []), ...(removedGeneratedResources ?? [])]
            .map((resource) => resource.serviceId)
            .filter(Boolean),
    );
    return (services ?? [])
        .filter((service) => !mappedIds.has(service.id))
        .map((service) => ({
            id: service.id,
            name: service.name,
            type: service.type,
            path: service.path,
            treatment: "not-assessed",
        }));
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
            .map(
                ({
                    userAdded,
                    userEdited,
                    sourceName,
                    generated,
                    origin,
                    edited,
                    include,
                    ...resource
                }) => resource,
            ),
        edges: (proposal?.edges ?? []).map(
            ({
                userAdded,
                userEdited,
                sourceId,
                sourceKey,
                generated,
                origin,
                edited,
                ...edge
            }) => edge,
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
