import assert from "node:assert/strict";
import test from "node:test";
import {
    classifyServiceKind,
    exactType,
    freezeSnapshot,
    presentationMode,
    stableProposalHash,
} from "../extensions/aspireify/proposal-model.mjs";

test("preserves precise service and Aspire type labels", () => {
    assert.equal(exactType("Vite SPA"), "Vite SPA");
    assert.equal(exactType("Next.js SSR"), "Next.js SSR");
    assert.equal(classifyServiceKind(".NET project"), "dotnet");
    assert.equal(classifyServiceKind("ASP.NET Core API"), "dotnet");
    assert.equal(classifyServiceKind("Blazor Server"), "dotnet");
    assert.equal(classifyServiceKind("Worker Service"), "dotnet");
    assert.equal(classifyServiceKind("Vite SPA"), "node");
    assert.equal(classifyServiceKind("Docker Compose service"), "container");
});

test("uses compact presentation for one or two resources and relationship mode above that", () => {
    assert.equal(presentationMode({ resources: [{ include: true }] }), "compact");
    assert.equal(
        presentationMode({ resources: [{ include: true }, { include: true }] }),
        "compact",
    );
    assert.equal(
        presentationMode({
            resources: [{ include: true }, { include: true }, { include: true }],
        }),
        "relationship",
    );
});

test("stable proposal hash is canonical, generation-bound, and content-sensitive", () => {
    const proposal = {
        generatedAt: "2026-08-25T21:14:00.000Z",
        resources: [
            {
                id: "web",
                name: "web",
                type: "Vite SPA",
                serviceId: "todo-web",
                sourceName: "todo-web",
                include: true,
            },
        ],
        edges: [],
    };
    const reordered = {
        edges: proposal.edges,
        resources: proposal.resources,
        generatedAt: proposal.generatedAt,
    };

    const hash = stableProposalHash({ proposalGeneration: 4, proposal });
    assert.equal(stableProposalHash({ proposalGeneration: 4, proposal: reordered }), hash);
    assert.equal(
        stableProposalHash({
            proposalGeneration: 4,
            proposal: {
                ...proposal,
                resources: [{ ...proposal.resources[0], sourceName: "internal-rename" }],
            },
        }),
        hash,
    );
    assert.notEqual(stableProposalHash({ proposalGeneration: 5, proposal }), hash);
    assert.notEqual(
        stableProposalHash({
            proposalGeneration: 4,
            proposal: {
                ...proposal,
                resources: [{ ...proposal.resources[0], type: "Vite SPA with SSR" }],
            },
        }),
        hash,
    );
});

test("confirmed snapshots are deeply frozen and detached from mutable proposal state", () => {
    const proposal = {
        proposalGeneration: 7,
        proposalHash: "abc123",
        proposal: {
            resources: [{ id: "web", name: "web", type: "Vite SPA" }],
            edges: [{ from: "web", to: "api", kind: "reference" }],
        },
    };
    const frozen = freezeSnapshot(proposal);
    proposal.proposal.resources[0].name = "changed";
    proposal.proposal.edges[0].to = "changed";

    assert.equal(frozen.proposal.resources[0].name, "web");
    assert.equal(frozen.proposal.edges[0].to, "api");
    assert.equal(Object.isFrozen(frozen), true);
    assert.equal(Object.isFrozen(frozen.proposal.resources[0]), true);
    assert.throws(() => {
        frozen.proposal.resources[0].name = "mutated";
    }, TypeError);
});
