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

const EXTERNAL_DEPENDENCY_FIELDS = [
    "id",
    "name",
    "type",
    "purpose",
    "configurationKeys",
    "source",
    "lifecycleOwner",
    "endpointSelection",
];

export function normalizeExternalDependencies(input) {
    if (input === undefined) {
        return null;
    }
    if (!Array.isArray(input)) {
        throw new Error("externalDependencies must be an array.");
    }
    const seen = new Set();
    return input.map((raw, index) => {
        const label = `externalDependencies[${index}]`;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new Error(`${label} must be an external dependency object.`);
        }
        for (const key of Object.keys(raw)) {
            if (!EXTERNAL_DEPENDENCY_FIELDS.includes(key)) {
                throw new Error(`${label}.${key} is not an external dependency field.`);
            }
        }
        const dependency = {};
        for (const key of EXTERNAL_DEPENDENCY_FIELDS.filter((field) => field !== "configurationKeys")) {
            if (raw[key] === undefined && !["id", "name", "type"].includes(key)) {
                continue;
            }
            if (typeof raw[key] !== "string" || !raw[key].trim()) {
                throw new Error(`${label}.${key} must be a non-empty string.`);
            }
            dependency[key] = raw[key].trim();
        }
        if (raw.id !== dependency.id) {
            throw new Error(`${label}.id must not have leading or trailing whitespace.`);
        }
        if (seen.has(dependency.id)) {
            throw new Error(`Discovered external dependency ID "${dependency.id}" is duplicated.`);
        }
        seen.add(dependency.id);
        if (raw.configurationKeys !== undefined) {
            if (
                !Array.isArray(raw.configurationKeys) ||
                raw.configurationKeys.some((key) => typeof key !== "string" || !key.trim())
            ) {
                throw new Error(`${label}.configurationKeys must be an array of non-empty key names, not values.`);
            }
            dependency.configurationKeys = raw.configurationKeys.map((key) => key.trim());
        }
        return dependency;
    });
}

export function validateExternalDependencyMappings(resources, externalDependencies) {
    const knownIds = new Set((externalDependencies ?? []).map((dependency) => dependency.id));
    for (const resource of resources) {
        const id = resource.externalDependencyId;
        if (id === undefined) {
            continue;
        }
        if (!knownIds.has(id)) {
            throw new Error(
                `Resource "${resource.name}" maps "${id}", which is not a discovered external dependency.`,
            );
        }
        if (resource.serviceId) {
            throw new Error(
                `Resource "${resource.name}" cannot map both a runnable service and an external dependency.`,
            );
        }
    }
}

export function externalDependencyAccounting({
    externalDependencies,
    resources,
    removedGeneratedResources,
    externalDependencyTreatments,
}) {
    const mappings = new Map();
    const currentIds = new Set((resources ?? []).map((resource) => resource.id));
    for (const resource of [
        ...(resources ?? []),
        ...(removedGeneratedResources ?? [])
            .filter((removed) => !currentIds.has(removed.id))
            .map((removed) => ({ ...removed, include: false, removed: true })),
    ]) {
        if (!resource.externalDependencyId) {
            continue;
        }
        const entries = mappings.get(resource.externalDependencyId) ?? [];
        entries.push({
            id: resource.id,
            name: resource.name,
            type: resource.type,
            include: resource.include !== false,
            ...(resource.removed ? { removed: true } : {}),
        });
        mappings.set(resource.externalDependencyId, entries);
    }
    const treatments = new Map(
        (externalDependencyTreatments ?? []).map((entry) => [entry.externalDependencyId, entry]),
    );
    return (externalDependencies ?? []).map((dependency) => {
        const resourceMappings = mappings.get(dependency.id) ?? [];
        const supplied = treatments.get(dependency.id);
        const decision = resourceMappings.length
            ? { treatment: "mapped" }
            : supplied
              ? {
                    treatment: supplied.treatment,
                    reason: supplied.reason,
                    ...(supplied.treatment === "deferred" ? { unresolved: supplied.unresolved } : {}),
                }
              : { treatment: "not-assessed" };
        return { ...dependency, resourceMappings, ...decision };
    });
}

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
    return normalizeTreatments(input, {
        field: "serviceTreatments",
        idField: "serviceId",
        entity: "service",
        knownIds: new Set((services ?? []).map((service) => service.id)),
        mappedIds: mappedServiceIds,
    });
}

export function normalizeExternalDependencyTreatments(
    input,
    { externalDependencies, mappedExternalDependencyIds },
) {
    if (input === undefined) {
        return null;
    }
    return normalizeTreatments(input, {
        field: "externalDependencyTreatments",
        idField: "externalDependencyId",
        entity: "external dependency",
        knownIds: new Set((externalDependencies ?? []).map((dependency) => dependency.id)),
        mappedIds: mappedExternalDependencyIds,
    });
}

function normalizeTreatments(input, { field, idField, entity, knownIds, mappedIds }) {
    if (!Array.isArray(input)) {
        throw new Error(`${field} must be an array.`);
    }
    const seen = new Set();
    return input.map((raw, index) => {
        const id = String(raw?.[idField] ?? "").trim();
        const treatment = String(raw?.treatment ?? "").trim();
        const reason = String(raw?.reason ?? "").trim();
        const unresolved = String(raw?.unresolved ?? "").trim();
        const label = `${field}[${index}]`;
        if (!knownIds.has(id)) {
            throw new Error(`${label} references "${id}", which is not a discovered ${entity}.`);
        }
        if (seen.has(id)) {
            throw new Error(`${label} repeats the treatment for "${id}".`);
        }
        seen.add(id);
        if (mappedIds.has(id)) {
            throw new Error(
                `${label} sets a treatment for "${id}", but a proposed resource already maps it.`,
            );
        }
        if (!SERVICE_TREATMENTS.includes(treatment)) {
            throw new Error(`${label}.treatment must be one of: ${SERVICE_TREATMENTS.join(", ")}.`);
        }
        if (!reason) {
            throw new Error(`${label}.reason is required.`);
        }
        if (treatment === "deferred" && !unresolved) {
            throw new Error(`${label}.unresolved is required for a deferred ${entity}.`);
        }
        return treatment === "deferred"
            ? { [idField]: id, treatment, reason, unresolved }
            : { [idField]: id, treatment, reason };
    });
}

export function presentationMode(proposal) {
    const count = Array.isArray(proposal?.resources)
        ? proposal.resources.filter((resource) => resource.include !== false).length
        : 0;
    return count <= 2 ? "compact" : "relationship";
}

export function stableProposalHash({
    proposalGeneration,
    proposal,
    serviceTreatments,
    externalDependencies,
}) {
    const hashInput = {
        proposalGeneration: Number(proposalGeneration) || 0,
        proposal: stripTransientProposalFields(proposal),
        // Omitted when empty so hashes of plans without treatments are unchanged.
        ...(serviceTreatments?.length ? { serviceTreatments } : {}),
        ...(externalDependencies?.length ? { externalDependencies } : {}),
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
