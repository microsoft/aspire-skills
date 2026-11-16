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

export const SERVICE_TREATMENTS = Object.freeze(["not-modeled", "deferred"]);

// Discovered services that no proposal resource or removed generated resource maps.
// Each keeps the skill-supplied treatment, or is reported as not assessed without one.
export function unproposedServices({
    services,
    resources,
    removedGeneratedResources,
    serviceTreatments,
}) {
    const mappedIds = new Set(
        [...(resources ?? []), ...(removedGeneratedResources ?? [])]
            .map((resource) => resource.serviceId)
            .filter(Boolean),
    );
    const treatments = new Map(
        (serviceTreatments ?? []).map((treatment) => [treatment.serviceId, treatment]),
    );
    return (services ?? [])
        .filter((service) => !mappedIds.has(service.id))
        .map((service) => {
            const entry = {
                id: service.id,
                name: service.name,
                type: service.type,
                path: service.path,
            };
            const supplied = treatments.get(service.id);
            if (!supplied) {
                return { ...entry, treatment: "not-assessed" };
            }
            return {
                ...entry,
                treatment: supplied.treatment,
                reason: supplied.reason,
                ...(supplied.treatment === "deferred" ? { unresolved: supplied.unresolved } : {}),
            };
        });
}

// Validates skill-supplied treatments for discovered services left out of the graph.
export function normalizeServiceTreatments(input, { services, mappedServiceIds }) {
    if (input == null) {
        return null;
    }
    if (!Array.isArray(input)) {
        throw new Error("serviceTreatments must be an array.");
    }
    const knownIds = new Set((services ?? []).map((service) => service.id));
    const seen = new Set();
    return input.map((raw, index) => {
        const serviceId = String(raw?.serviceId ?? "").trim();
        const treatment = String(raw?.treatment ?? "").trim();
        const reason = String(raw?.reason ?? "").trim();
        const unresolved = String(raw?.unresolved ?? "").trim();
        const label = `serviceTreatments[${index}]`;
        if (!knownIds.has(serviceId)) {
            throw new Error(`${label} references "${serviceId}", which is not a discovered service.`);
        }
        if (seen.has(serviceId)) {
            throw new Error(`${label} repeats the treatment for "${serviceId}".`);
        }
        seen.add(serviceId);
        if (mappedServiceIds.has(serviceId)) {
            throw new Error(
                `${label} sets a treatment for "${serviceId}", but a proposed resource already maps it.`,
            );
        }
        if (!SERVICE_TREATMENTS.includes(treatment)) {
            throw new Error(`${label}.treatment must be one of: ${SERVICE_TREATMENTS.join(", ")}.`);
        }
        if (!reason) {
            throw new Error(`${label}.reason is required.`);
        }
        if (treatment === "deferred" && !unresolved) {
            throw new Error(`${label}.unresolved is required for a deferred service.`);
        }
        return treatment === "deferred"
            ? { serviceId, treatment, reason, unresolved }
            : { serviceId, treatment, reason };
    });
}

export function presentationMode(proposal) {
    const count = Array.isArray(proposal?.resources)
        ? proposal.resources.filter((resource) => resource.include !== false).length
        : 0;
    return count <= 2 ? "compact" : "relationship";
}

export function stableProposalHash({ proposalGeneration, proposal, serviceTreatments }) {
    const hashInput = {
        proposalGeneration: Number(proposalGeneration) || 0,
        proposal: stripTransientProposalFields(proposal),
        // Omitted when empty so hashes of plans without treatments are unchanged.
        ...(serviceTreatments?.length ? { serviceTreatments } : {}),
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
