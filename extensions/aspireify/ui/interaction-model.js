export function createFieldOperationCoordinator() {
    const versions = new Map();
    const pending = new Map();

    return {
        begin(key) {
            const version = (versions.get(key) ?? 0) + 1;
            versions.set(key, version);
            return version;
        },
        isCurrent(key, version) {
            return versions.get(key) === version;
        },
        invalidate(key) {
            const version = (versions.get(key) ?? 0) + 1;
            versions.set(key, version);
            return version;
        },
        track(key, operation) {
            pending.set(key, operation);
            const release = () => {
                if (pending.get(key) === operation) {
                    pending.delete(key);
                }
            };
            void operation.then(release, release);
            return operation;
        },
        async settle(key) {
            await pending.get(key);
        },
        keysForResource(resourceId) {
            const prefix = `${String(resourceId)}\u0000`;
            return [...new Set([...versions.keys(), ...pending.keys()])].filter((key) =>
                key.startsWith(prefix),
            );
        },
        clear() {
            versions.clear();
            pending.clear();
        },
    };
}

export function fieldOperationKey(resourceId, field) {
    return `${String(resourceId)}\u0000${String(field)}`;
}

export function selectionFocusTarget({ narrow, activation }) {
    return narrow && activation === "activate" ? "inspector" : "overview";
}

export function operationFailureChannel({ confirmationAction, confirmed }) {
    if (!confirmationAction) {
        return "mutation";
    }
    return confirmed ? "handoff" : "confirmation";
}

export function confirmationIsDisabled({
    proposalLoaded,
    proposalStale,
    issueCount,
    confirmed,
    confirmationDelivered,
    pendingMutations,
    mutationError,
}) {
    return (
        !proposalLoaded ||
        proposalStale ||
        issueCount > 0 ||
        (confirmed && confirmationDelivered) ||
        pendingMutations > 0 ||
        Boolean(mutationError)
    );
}
