import assert from "node:assert/strict";
import test from "node:test";
import {
    classifyServiceKind,
    exactType,
    freezeSnapshot,
    includedServicesForProposal,
    normalizeOwnership,
    normalizePackages,
    normalizeProposalMetadata,
    presentationMode,
    stableProposalHash,
    unmappedExternalServicesForProposal,
    unresolvedDecisions,
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

test("normalizes structured scope and old-schema omissions without inventing claims", () => {
    const oldSchema = normalizeProposalMetadata({}, () => new Date("2026-08-25T21:14:00Z"));
    assert.deepEqual(oldSchema.assumptionsRisks, []);
    assert.deepEqual(oldSchema.decisions, []);
    assert.deepEqual(oldSchema.scope, {
        appHostFiles: [],
        integrationPackages: [],
        serviceCodeImpacts: [],
    });

    const structured = normalizeProposalMetadata({
        generatedAt: "2026-08-25T21:14:00Z",
        scope: {
            appHostFiles: ["src/AppHost.cs"],
            integrationPackages: [
                { name: "Aspire.Hosting.PostgreSQL", version: "13.4.0-preview.2" },
            ],
            serviceCodeImpacts: [
                {
                    serviceId: "api",
                    serviceName: "todo-api",
                    state: "required",
                    summary: "Add Service Defaults.",
                    files: ["src/todo-api/Program.cs"],
                },
            ],
        },
    });
    assert.equal(structured.generatedAt, "2026-08-25T21:14:00.000Z");
    assert.deepEqual(structured.scope.integrationPackages, [
        { name: "Aspire.Hosting.PostgreSQL", version: "13.4.0-preview.2" },
    ]);
});

test("represents Rayfin-managed infrastructure as ownership instead of an Aspire claim", () => {
    assert.deepEqual(
        normalizeOwnership({
            kind: "external-infrastructure",
            label: "Rayfin-managed external infrastructure",
            owner: "Rayfin",
        }),
        {
            kind: "external-infrastructure",
            label: "Rayfin-managed external infrastructure",
            owner: "Rayfin",
        },
    );
});

test("keeps unmapped external infrastructure out of included service selections", () => {
    const services = [
        {
            id: "web",
            include: true,
            proposalCandidate: true,
            ownership: { kind: "service-owned" },
        },
        {
            id: "rayfin",
            include: true,
            proposalCandidate: false,
            ownership: { kind: "external-infrastructure" },
        },
    ];
    assert.deepEqual(
        includedServicesForProposal(services, [
            { id: "web-resource", serviceId: "web", include: true },
        ]).map((service) => service.id),
        ["web"],
    );
    assert.deepEqual(
        unmappedExternalServicesForProposal(services, [
            { id: "web-resource", serviceId: "web", include: true },
        ]).map((service) => service.id),
        ["rayfin"],
    );

    assert.deepEqual(
        includedServicesForProposal(services, [
            { id: "rayfin-resource", serviceId: "rayfin", include: true },
        ]).map((service) => service.id),
        ["web", "rayfin"],
    );
});

test("preserves ARM64 incompatibility and unresolved chat decisions as supplied facts", () => {
    const proposal = normalizeProposalMetadata({
        assumptionsRisks: [
            {
                id: "arm64",
                kind: "risk",
                severity: "blocking",
                verification: "unverified",
                title: "ARM64 image compatibility",
                detail: "The supplied image may not publish an ARM64 manifest.",
            },
            {
                id: "port",
                kind: "assumption",
                severity: "warning",
                verification: "needs-chat-decision",
                title: "Fixed development port",
                detail: "Choose whether to retain port 5173.",
            },
        ],
        decisions: [
            {
                id: "hosting",
                title: "Frontend hosting model",
                summary: "Choose static or server-hosted output in chat.",
                status: "needs-chat-decision",
            },
        ],
    });

    assert.equal(proposal.assumptionsRisks[0].title, "ARM64 image compatibility");
    assert.deepEqual(
        unresolvedDecisions(proposal).map((decision) => decision.id),
        ["hosting", "port"],
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
                include: true,
                ownership: { kind: "service-owned", label: "Todo web", owner: "Web team" },
            },
        ],
        edges: [],
        assumptionsRisks: [],
        decisions: [],
        scope: {
            appHostFiles: ["src/AppHost.cs"],
            integrationPackages: normalizePackages([]),
            serviceCodeImpacts: [],
        },
    };
    const reordered = {
        scope: proposal.scope,
        decisions: proposal.decisions,
        assumptionsRisks: proposal.assumptionsRisks,
        edges: proposal.edges,
        resources: proposal.resources,
        generatedAt: proposal.generatedAt,
    };

    const hash = stableProposalHash({ proposalGeneration: 4, proposal });
    assert.equal(stableProposalHash({ proposalGeneration: 4, proposal: reordered }), hash);
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
            scope: { appHostFiles: ["src/apphost.cs"] },
        },
    };
    const frozen = freezeSnapshot(proposal);
    proposal.proposal.resources[0].name = "changed";
    proposal.proposal.scope.appHostFiles.push("other.cs");

    assert.equal(frozen.proposal.resources[0].name, "web");
    assert.deepEqual(frozen.proposal.scope.appHostFiles, ["src/apphost.cs"]);
    assert.equal(Object.isFrozen(frozen), true);
    assert.equal(Object.isFrozen(frozen.proposal.resources[0]), true);
    assert.throws(() => {
        frozen.proposal.resources[0].name = "mutated";
    }, TypeError);
});
