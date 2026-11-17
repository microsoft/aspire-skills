// A spanning forest of the supplied graph: each resource expands once, each edge
// appears once, and repeated targets are terminal references, not resource copies.
export function projectConnectionsTree(resources, edges) {
    const byName = new Map(resources.map((resource) => [resource.name, resource]));
    const outgoing = new Map(resources.map((resource) => [resource.id, []]));
    const incoming = new Set();
    edges.forEach((edge, index) => {
        const from = byName.get(edge.from);
        const to = byName.get(edge.to);
        if (from && to) {
            outgoing.get(from.id).push({ edge, target: to, index });
            incoming.add(to.id);
        }
    });

    const roots = [];
    const nodes = new Map();
    const visited = new Set();
    const active = new Set();
    const candidates = [
        ...resources.filter((resource) => !incoming.has(resource.id)),
        ...resources,
    ];
    const resourceKey = (resource) => JSON.stringify(["resource", resource.id]);
    const addNode = (resource, parent, connection) => {
        const reference = active.has(resource.id)
            ? "cycle"
            : visited.has(resource.id) ? "shared" : null;
        const node = {
            key: reference
                ? JSON.stringify(["connection", connection.edge.id ?? connection.index])
                : resourceKey(resource),
            resource,
            edge: connection?.edge ?? null,
            parentKey: parent?.key ?? null,
            targetKey: resourceKey(resource),
            reference,
            disconnected: !incoming.has(resource.id) && !outgoing.get(resource.id).length,
            children: [],
        };
        nodes.set(node.key, node);
        (parent ? parent.children : roots).push(node.key);
        return node;
    };

    // Iterative DFS also bounds call-stack use for long chains and large cycles.
    for (const resource of candidates) {
        if (visited.has(resource.id)) continue;
        const root = addNode(resource, null, null);
        visited.add(resource.id);
        active.add(resource.id);
        const stack = [{ node: root, index: 0 }];
        while (stack.length) {
            const frame = stack[stack.length - 1];
            const connections = outgoing.get(frame.node.resource.id);
            if (frame.index === connections.length) {
                active.delete(frame.node.resource.id);
                stack.pop();
                continue;
            }
            const connection = connections[frame.index++];
            const child = addNode(connection.target, frame.node, connection);
            if (!child.reference) {
                visited.add(child.resource.id);
                active.add(child.resource.id);
                stack.push({ node: child, index: 0 });
            }
        }
    }
    return { roots, nodes };
}

export function visibleConnectionTreeNodes(tree, expandedKeys) {
    const visible = [];
    const stack = [...tree.roots].reverse();
    while (stack.length) {
        const node = tree.nodes.get(stack.pop());
        visible.push(node);
        if (expandedKeys.has(node.key)) {
            for (let index = node.children.length - 1; index >= 0; index--) {
                stack.push(node.children[index]);
            }
        }
    }
    return visible;
}
