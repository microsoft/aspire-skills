function resolveConnections(resources, edges) {
    const byId = new Map(resources.map((resource) => [resource.id, resource]));
    const byName = new Map();
    for (const resource of resources) {
        byName.set(resource.name, byName.has(resource.name) ? null : resource);
    }
    const ambiguous = new Set();
    const unresolvedPeers = new Set();
    const unresolvedParentClaims = new Set();
    const endpoint = (edge, side) => {
        // Empty IDs mean "unset", matching the server's name fallback.
        if (edge[`${side}Id`]) return byId.get(edge[`${side}Id`]);
        if (byName.get(edge[side]) === null) ambiguous.add(edge[side]);
        return byName.get(edge[side]);
    };
    const connections = [];
    const unplaced = [];
    edges.forEach((edge, index) => {
        const from = endpoint(edge, "from");
        const to = endpoint(edge, "to");
        if (!from || !to) {
            if (from) unresolvedPeers.add(from.id);
            if (to) unresolvedPeers.add(to.id);
            if (edge.kind === "parent") {
                // An ambiguous child name could be any same-named resource.
                const children = from ? [from] : from === null
                    ? resources.filter((resource) => resource.name === edge.from) : [];
                for (const child of children) unresolvedParentClaims.add(child.id);
            }
            unplaced.push({ edge, index, reason: from === null || to === null ? "ambiguous" : "missing" });
        } else {
            connections.push({ edge, index, fromId: from.id, toId: to.id });
        }
    });
    return { connections, unplaced, ambiguous, unresolvedPeers, unresolvedParentClaims };
}

// Collapse cycles before assigning dependency columns; no resource is copied.
function topologyColumns(roots, connections, rootForResource) {
    const outgoing = new Map(roots.map((id) => [id, new Set()]));
    const incoming = new Map(roots.map((id) => [id, new Set()]));
    for (const { edge, fromId, toId } of connections) {
        if (edge.kind === "parent") continue;
        const from = rootForResource.get(fromId);
        const to = rootForResource.get(toId);
        if (from === to) continue;
        outgoing.get(from).add(to);
        incoming.get(to).add(from);
    }

    const visited = new Set();
    const finish = [];
    for (const root of roots) {
        if (visited.has(root)) continue;
        visited.add(root);
        const stack = [{ id: root, peers: [...outgoing.get(root)], index: 0 }];
        while (stack.length) {
            const frame = stack[stack.length - 1];
            if (frame.index === frame.peers.length) {
                finish.push(frame.id);
                stack.pop();
                continue;
            }
            const peer = frame.peers[frame.index++];
            if (!visited.has(peer)) {
                visited.add(peer);
                stack.push({ id: peer, peers: [...outgoing.get(peer)], index: 0 });
            }
        }
    }

    const componentOf = new Map();
    const components = [];
    for (const root of finish.reverse()) {
        if (componentOf.has(root)) continue;
        const component = components.length;
        components.push({ outgoing: new Set(), incoming: 0, depth: 0 });
        const stack = [root];
        componentOf.set(root, component);
        while (stack.length) {
            const id = stack.pop();
            for (const peer of incoming.get(id)) {
                if (!componentOf.has(peer)) {
                    componentOf.set(peer, component);
                    stack.push(peer);
                }
            }
        }
    }
    for (const root of roots) {
        const from = componentOf.get(root);
        for (const peer of outgoing.get(root)) {
            const to = componentOf.get(peer);
            if (from !== to && !components[from].outgoing.has(to)) {
                components[from].outgoing.add(to);
                components[to].incoming++;
            }
        }
    }
    const queue = components.flatMap((component, index) =>
        component.incoming === 0 ? [index] : [],
    );
    for (let index = 0; index < queue.length; index++) {
        const component = components[queue[index]];
        for (const target of component.outgoing) {
            components[target].depth = Math.max(components[target].depth, component.depth + 1);
            if (--components[target].incoming === 0) queue.push(target);
        }
    }
    return new Map(roots.map((id) => [id, Math.min(components[componentOf.get(id)].depth, 2)]));
}

export function projectTopology(resources, edges) {
    const { connections, unplaced, ambiguous, unresolvedPeers, unresolvedParentClaims } =
        resolveConnections(resources, edges);
    const connected = new Set();
    const parentConnections = new Map();
    for (const connection of connections) {
        connected.add(connection.fromId);
        connected.add(connection.toId);
        if (connection.edge.kind === "parent") {
            if (!parentConnections.has(connection.fromId)) {
                parentConnections.set(connection.fromId, []);
            }
            parentConnections.get(connection.fromId).push(connection);
        }
    }

    const parentOf = new Map();
    const invalidParents = new Map();
    for (const [child, candidates] of parentConnections) {
        const parents = new Set(candidates.map((connection) => connection.toId));
        // An unresolved parent claim could name a different parent, so don't nest.
        if (parents.size > 1 || unresolvedParentClaims.has(child)) {
            invalidParents.set(child, "multiple-parents");
        } else {
            parentOf.set(child, candidates[0].toId);
        }
    }
    const visited = new Set();
    for (const child of parentOf.keys()) {
        if (visited.has(child)) continue;
        const path = [];
        const pathIndex = new Map();
        let current = child;
        while (parentOf.has(current) && !visited.has(current)) {
            if (pathIndex.has(current)) {
                for (const cyclic of path.slice(pathIndex.get(current))) {
                    invalidParents.set(cyclic, "parent-cycle");
                }
                break;
            }
            pathIndex.set(current, path.length);
            path.push(current);
            current = parentOf.get(current);
        }
        for (const id of path) visited.add(id);
    }
    for (const [child, reason] of invalidParents) {
        parentOf.delete(child);
        for (const connection of parentConnections.get(child)) {
            unplaced.push({ edge: connection.edge, index: connection.index, reason });
            unresolvedPeers.add(connection.fromId);
            unresolvedPeers.add(connection.toId);
        }
    }
    unplaced.sort((left, right) => left.index - right.index);

    const nodes = new Map(resources.map((resource) => [resource.id, {
        resource,
        parentId: parentOf.get(resource.id) ?? null,
        children: [],
        uncertain: ambiguous.has(resource.name) || unresolvedPeers.has(resource.id),
        disconnected: !connected.has(resource.id) &&
            !ambiguous.has(resource.name) && !unresolvedPeers.has(resource.id),
    }]));
    const roots = [];
    for (const resource of resources) {
        const node = nodes.get(resource.id);
        if (node.parentId === null) roots.push(resource.id);
        else nodes.get(node.parentId).children.push(resource.id);
    }

    const rootForResource = new Map();
    for (const resource of resources) {
        let current = resource.id;
        const path = [];
        while (!rootForResource.has(current) && parentOf.has(current)) {
            path.push(current);
            current = parentOf.get(current);
        }
        const root = rootForResource.get(current) ?? current;
        rootForResource.set(current, root);
        for (const id of path) rootForResource.set(id, root);
    }
    const columns = topologyColumns(roots, connections, rootForResource);
    const columnWidths = [220, 220, 220];
    const rows = [0, 0, 0];
    let columnCount = 1;
    for (const root of roots) {
        const column = columns.get(root);
        const node = nodes.get(root);
        node.column = column;
        node.row = rows[column]++;
        columnCount = Math.max(columnCount, column + 1);
        const stack = [{ id: root, depth: 0 }];
        while (stack.length) {
            const { id, depth } = stack.pop();
            columnWidths[column] = Math.max(columnWidths[column], 200 + depth * 20);
            for (const child of nodes.get(id).children) stack.push({ id: child, depth: depth + 1 });
        }
    }
    return { nodes, roots, connections, unplaced, columnWidths: columnWidths.slice(0, columnCount) };
}
