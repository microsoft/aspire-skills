import assert from "node:assert/strict";
import test from "node:test";
import { projectTopology } from "../../extensions/aspireify/ui/connections-tree.js";
import { freezeSnapshot, stableProposalHash } from "../../extensions/aspireify/proposal-model.mjs";

const resource = (id) => ({ id: `id:${id}`, name: id, type: "Container", include: true });
const edge = (from, to, kind = "reference") => ({ id: `${from}:${kind}:${to}`, from, to, kind });
test("topology projection preserves the snapshot and proposal root ordering", () => {
    const proposal = freezeSnapshot({
        generatedAt: "2026-01-01T00:00:00.000Z",
        resources: ["db", "api", "worker", "isolated"].map(resource),
        edges: [edge("api", "db"), edge("worker", "db", "waitFor")],
    });
    const before = stableProposalHash({ proposalGeneration: 2, proposal });
    const graph = projectTopology(proposal.resources, proposal.edges);
    assert.deepEqual(graph.roots, ["id:db", "id:api", "id:worker", "id:isolated"]);
    assert.equal(graph.nodes.size, proposal.resources.length);
    assert.deepEqual(graph.connections.map((connection) => connection.edge), proposal.edges);
    assert.equal(graph.nodes.get("id:isolated").disconnected, true);
    assert.equal(graph.nodes.get("id:db").disconnected, false);
    assert.equal(stableProposalHash({ proposalGeneration: 2, proposal }), before);
    assert.deepEqual(projectTopology(proposal.resources, proposal.edges), graph);
});

test("endpoint IDs disambiguate duplicate resource names and never fall back from missing IDs", () => {
    const resources = [
        resource("api"),
        { ...resource("cache"), id: "cache-a" },
        { ...resource("cache"), id: "cache-b" },
    ];
    const connection = { ...edge("api", "cache"), fromId: "id:api", toId: "cache-a" };
    const graph = projectTopology(resources, [connection]);
    assert.equal(graph.connections[0].toId, "cache-a");
    assert.equal(graph.nodes.get("cache-a").disconnected, false);
    assert.equal(graph.nodes.get("cache-b").disconnected, true);
    const missing = projectTopology(resources, [{ ...connection, toId: "missing" }]);
    assert.equal(missing.connections.length, 0);
    assert.deepEqual(missing.unplaced.map(({ index, reason }) => [index, reason]), [[0, "missing"]]);
    assert.deepEqual(graph.unplaced, []);
    const blank = { ...edge("api", "cache"), fromId: "", toId: "" };
    assert.deepEqual(projectTopology(resources, [blank]).unplaced, [{ edge: blank, index: 0, reason: "ambiguous" }]);
    const unique = projectTopology([resource("a"), resource("b")], [{ ...edge("a", "b"), fromId: "", toId: "" }]);
    assert.deepEqual(unique.unplaced, []);
    assert.equal(unique.connections.length, 1);
});

test("name-only ambiguous endpoints are marked instead of attached to an arbitrary resource", () => {
    const resources = [
        resource("api"),
        { ...resource("cache"), id: "cache-a" },
        { ...resource("cache"), id: "cache-b" },
    ];
    for (const connection of [edge("api", "cache"), edge("cache", "api")]) {
        const graph = projectTopology(resources, [connection]);
        assert.equal(graph.connections.length, 0);
        assert.deepEqual(graph.unplaced, [{ edge: connection, index: 0, reason: "ambiguous" }]);
        const caches = [...graph.nodes.values()].filter((node) => node.resource.name === "cache");
        assert.ok(caches.every((node) => node.uncertain && !node.disconnected));
        const api = graph.nodes.get("id:api");
        assert.equal(api.uncertain, true);
        assert.equal(api.disconnected, false);
    }
});

test("topology nests ownership once and preserves shared dependencies and distinct directed connections", () => {
    const resources = ["web", "worker", "api", "postgres", "catalog", "queue"].map(resource);
    const edges = [
        edge("web", "api"),
        edge("api", "catalog"),
        edge("worker", "catalog"),
        edge("worker", "queue", "waitFor"),
        edge("catalog", "postgres", "parent"),
    ];
    const graph = projectTopology(resources, edges);
    assert.equal(graph.nodes.size, resources.length);
    assert.equal(graph.connections.length, edges.length);
    assert.deepEqual(graph.nodes.get("id:postgres").children, ["id:catalog"]);
    assert.equal(graph.nodes.get("id:catalog").parentId, "id:postgres");
    assert.equal(graph.roots.includes("id:catalog"), false);
    assert.equal(graph.connections.filter(({ toId }) => toId === "id:catalog").length, 2);
    assert.equal(graph.nodes.get("id:web").column, 0);
    assert.equal(graph.nodes.get("id:api").column, 1);
    assert.equal(graph.nodes.get("id:postgres").column, 2);
    assert.deepEqual(graph.unplaced, []);
});

test("topology retains cycles, disconnected resources, and parallel relation kinds", () => {
    const resources = ["a", "b", "c", "isolated"].map(resource);
    const edges = [
        edge("a", "b"),
        edge("b", "a"),
        edge("a", "b", "waitFor"),
        edge("b", "c"),
    ];
    const graph = projectTopology(resources, edges);
    assert.equal(graph.connections.length, 4);
    assert.equal(graph.nodes.get("id:a").column, graph.nodes.get("id:b").column);
    assert.equal(graph.nodes.get("id:c").column, graph.nodes.get("id:b").column + 1);
    assert.equal(graph.nodes.get("id:isolated").disconnected, true);
    assert.equal(graph.nodes.get("id:a").disconnected, false);
});

test("topology keeps ambiguous and stale IDs unplaced and never misattributes them", () => {
    const resources = [
        resource("api"),
        { ...resource("cache"), id: "cache-a" },
        { ...resource("cache"), id: "cache-b" },
    ];
    const edges = [
        { ...edge("api", "cache"), fromId: "id:api", toId: "cache-a" },
        edge("api", "cache", "waitFor"),
        { ...edge("cache", "api"), fromId: "gone", toId: "id:api" },
    ];
    const graph = projectTopology(resources, edges);
    assert.deepEqual(graph.connections.map(({ fromId, toId }) => [fromId, toId]), [["id:api", "cache-a"]]);
    assert.deepEqual(graph.unplaced.map(({ index, reason }) => [index, reason]), [
        [1, "ambiguous"], [2, "missing"],
    ]);
    assert.equal(graph.nodes.get("cache-b").uncertain, true);
    assert.equal(graph.nodes.get("id:api").disconnected, false);
});

test("topology reports multiple parents and ownership cycles instead of inventing containment", () => {
    const resources = ["a", "b", "c", "d"].map(resource);
    const edges = [
        edge("a", "b", "parent"),
        edge("a", "c", "parent"),
        edge("b", "c", "parent"),
        edge("c", "b", "parent"),
        edge("d", "b", "parent"),
    ];
    const graph = projectTopology(resources, edges);
    assert.deepEqual(graph.unplaced.map(({ index, reason }) => [index, reason]), [
        [0, "multiple-parents"], [1, "multiple-parents"],
        [2, "parent-cycle"], [3, "parent-cycle"],
    ]);
    assert.equal(graph.nodes.get("id:a").parentId, null);
    assert.equal(graph.nodes.get("id:b").parentId, null);
    assert.equal(graph.nodes.get("id:c").parentId, null);
    assert.equal(graph.nodes.get("id:d").parentId, "id:b");
    assert.equal(graph.connections.length, edges.length);
});

test("topology projection remains iterative on large cyclic graphs", () => {
    const resources = Array.from({ length: 15_000 }, (_, index) => resource(String(index)));
    const edges = resources.map((entry, index) => edge(entry.name, resources[(index + 1) % resources.length].name));
    const graph = projectTopology(resources, edges);
    assert.equal(graph.nodes.size, resources.length);
    assert.equal(graph.connections.length, edges.length);
    assert.equal(graph.columnWidths.length, 1);
});

test("topology does not nest a child while another parent claim is unresolved", () => {
    const resources = [resource("child"), resource("parent"), resource("dup"), { ...resource("dup"), id: "id:dup-2" }];
    const edges = [edge("child", "parent", "parent"), edge("child", "dup", "parent")];
    const graph = projectTopology(resources, edges);
    assert.equal(graph.nodes.get("id:child").parentId, null);
    assert.deepEqual(graph.unplaced.map(({ index, reason }) => [index, reason]), [
        [0, "multiple-parents"], [1, "ambiguous"],
    ]);
});

test("topology does not nest any child that an ambiguous parent claim could name", () => {
    const resources = [resource("child"), { ...resource("child"), id: "id:child-2" }, resource("p1"), resource("p2")];
    const edges = [
        { ...edge("child", "p1", "parent"), fromId: "id:child", toId: "id:p1" },
        edge("child", "p2", "parent"),
    ];
    const graph = projectTopology(resources, edges);
    assert.equal(graph.nodes.get("id:child").parentId, null);
    assert.deepEqual(graph.unplaced.map(({ index, reason }) => [index, reason]), [
        [0, "multiple-parents"], [1, "ambiguous"],
    ]);
});
