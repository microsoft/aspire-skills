import assert from "node:assert/strict";
import test from "node:test";
import {
    projectConnectionsTree,
    visibleConnectionTreeNodes,
} from "../../extensions/aspireify/ui/connections-tree.js";
import { freezeSnapshot, stableProposalHash } from "../../extensions/aspireify/proposal-model.mjs";

const resource = (id) => ({ id: `id:${id}`, name: id, type: "Container", include: true });
const edge = (from, to, kind = "reference") => ({ id: `${from}:${kind}:${to}`, from, to, kind });
const canonical = (tree) => [...tree.nodes.values()].filter((node) => !node.reference);

test("the forest preserves each resource and supplied directed edge without changing the snapshot", () => {
    const proposal = freezeSnapshot({
        generatedAt: "2026-01-01T00:00:00.000Z",
        resources: ["db", "api", "worker", "isolated"].map(resource),
        edges: [edge("api", "db"), edge("worker", "db", "waitFor")],
    });
    const before = stableProposalHash({ proposalGeneration: 2, proposal });
    const tree = projectConnectionsTree(proposal.resources, proposal.edges);
    assert.deepEqual(tree.roots.map((key) => tree.nodes.get(key).resource.name), [
        "api", "worker", "isolated",
    ]);
    assert.deepEqual(canonical(tree).map((node) => node.resource.name), ["api", "db", "worker", "isolated"]);
    assert.deepEqual([...tree.nodes.values()].filter((node) => node.edge).map((node) => node.edge), proposal.edges);
    const shared = [...tree.nodes.values()].find((node) => node.reference);
    assert.equal(shared.reference, "shared");
    assert.equal(tree.nodes.get(shared.targetKey).resource, shared.resource);
    assert.equal(shared.edge.kind, "waitFor");
    assert.deepEqual(shared.children, []);
    assert.equal(canonical(tree).find((node) => node.resource.name === "isolated").disconnected, true);
    assert.equal(canonical(tree).find((node) => node.resource.name === "db").disconnected, false);
    assert.equal(stableProposalHash({ proposalGeneration: 2, proposal }), before);
    assert.deepEqual(projectConnectionsTree(proposal.resources, proposal.edges), tree);
});

for (const connections of [
    [edge("a", "a")],
    [edge("a", "b"), edge("b", "a", "parent")],
    [edge("a", "b"), edge("b", "c"), edge("c", "a", "waitFor")],
]) {
    test(`cycles terminate explicitly: ${connections.map((connection) => connection.id).join(", ")}`, () => {
        const resources = [...new Set(connections.flatMap(({ from, to }) => [from, to]))].map(resource);
        const tree = projectConnectionsTree(resources, connections);
        const cycles = [...tree.nodes.values()].filter((node) => node.reference === "cycle");
        assert.equal(cycles.length, 1);
        assert.deepEqual(cycles[0].children, []);
        assert.equal(tree.nodes.get(cycles[0].targetKey).resource, cycles[0].resource);
        assert.equal(canonical(tree).length, resources.length);
        assert.equal([...tree.nodes.values()].filter((node) => node.edge).length, connections.length);
        assert.equal(visibleConnectionTreeNodes(tree, new Set(tree.nodes.keys())).length, tree.nodes.size);
    });
}

test("a diamond and parallel relationship kinds point to the same canonical dependency", () => {
    const resources = ["api", "worker", "db", "store"].map(resource);
    const edges = [
        edge("api", "db"), edge("api", "worker"), edge("worker", "db"),
        edge("db", "store", "parent"), edge("api", "db", "waitFor"),
    ];
    const tree = projectConnectionsTree(resources, edges);
    assert.equal(canonical(tree).length, resources.length);
    assert.equal(tree.nodes.size, edges.length + tree.roots.length);
    const references = [...tree.nodes.values()].filter((node) => node.reference === "shared");
    assert.equal(references.length, 2);
    assert.equal(references[0].targetKey, references[1].targetKey);
    assert.deepEqual(references.map((node) => node.edge.kind), ["reference", "waitFor"]);
});

test("empty, disconnected, and out-of-scope endpoints do not invent resources or edges", () => {
    assert.deepEqual(projectConnectionsTree([], []), { roots: [], nodes: new Map() });
    const tree = projectConnectionsTree(["a", "b"].map(resource), [
        edge("a", "missing"), edge("missing", "b"),
    ]);
    assert.equal(tree.roots.length, 2);
    assert.ok([...tree.nodes.values()].every((node) => node.disconnected && !node.edge));
    assert.equal(visibleConnectionTreeNodes(tree, new Set()).length, 2);
});

test("only expanded branches are visible, with parents preceding children", () => {
    const tree = projectConnectionsTree(["a", "b", "c", "d"].map(resource), [
        edge("a", "b"), edge("b", "c"),
    ]);
    const root = tree.roots[0];
    const child = tree.nodes.get(root).children[0];
    const names = (keys) => visibleConnectionTreeNodes(tree, keys).map((node) => node.resource.name);
    assert.deepEqual(names(new Set()), ["a", "d"]);
    assert.deepEqual(names(new Set([root])), ["a", "b", "d"]);
    assert.deepEqual(names(new Set([root, child])), ["a", "b", "c", "d"]);
    assert.deepEqual(names(new Set([child])), ["a", "d"]);
});

test("large cyclic chains use bounded iterative projection instead of recursive expansion", () => {
    const resources = Array.from({ length: 15_000 }, (_, index) => resource(String(index)));
    const edges = resources.map((entry, index) => edge(entry.name, resources[(index + 1) % resources.length].name));
    const tree = projectConnectionsTree(resources, edges);
    assert.equal(tree.roots.length, 1);
    assert.equal(tree.nodes.size, resources.length + 1);
    assert.equal(visibleConnectionTreeNodes(tree, new Set(tree.nodes.keys())).length, resources.length + 1);
});

test("endpoint IDs disambiguate duplicate resource names and never fall back from missing IDs", () => {
    const resources = [
        resource("api"),
        { ...resource("cache"), id: "cache-a" },
        { ...resource("cache"), id: "cache-b" },
    ];
    const connection = { ...edge("api", "cache"), fromId: "id:api", toId: "cache-a" };
    const tree = projectConnectionsTree(resources, [connection]);
    const target = [...tree.nodes.values()].find((node) => node.edge);
    assert.equal(target.resource.id, "cache-a");
    assert.equal(canonical(tree).find((node) => node.resource.id === "cache-a").disconnected, false);
    assert.equal(canonical(tree).find((node) => node.resource.id === "cache-b").disconnected, true);
    const missing = projectConnectionsTree(resources, [{ ...connection, toId: "missing" }]);
    assert.ok([...missing.nodes.values()].every((node) => !node.edge));
});

test("name-only ambiguous endpoints are marked instead of attached to an arbitrary resource", () => {
    const resources = [
        resource("api"),
        { ...resource("cache"), id: "cache-a" },
        { ...resource("cache"), id: "cache-b" },
    ];
    for (const connection of [edge("api", "cache"), edge("cache", "api")]) {
        const tree = projectConnectionsTree(resources, [connection]);
        assert.ok([...tree.nodes.values()].every((node) => !node.edge));
        const caches = canonical(tree).filter((node) => node.resource.name === "cache");
        assert.ok(caches.every((node) => node.ambiguous && !node.disconnected));
        const api = canonical(tree).find((node) => node.resource.name === "api");
        assert.equal(api.ambiguous, true);
        assert.equal(api.disconnected, false);
    }
});
