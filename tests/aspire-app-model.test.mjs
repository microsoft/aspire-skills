import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    AppHostOperationCoordinator,
    CommandInputMetadataStore,
    KeyedTaskQueue,
    SnapshotGeneration,
    appHostOperationKey,
    buildCommandArgumentTokens,
    buildDashboardViewUrl,
    buildGlobalTree,
    buildResourceGraph,
    buildResourceTree,
    buildResourceCommandArgs,
    buildTerminalAttachCommand,
    buildWorkspaceTree,
    combineWorkspaceAppHosts,
    filterTree,
    discoverConfiguredAppHosts,
    extractJsonPayload,
    mapWithConcurrency,
    normalizeLsPayload,
    normalizePsPayload,
    optionalFlagIsUnsupported,
    parseLegacyPipelineSteps,
    projectDescribePayload,
    publicAppHost,
    redactAbsolutePaths,
    redactKnownPaths,
    redactText,
    resolveRequestedAppHostPath,
    runWithOptionalFlagFallback,
    sanitizeCommandArgumentInputs,
    sanitizeResource,
    validateCommandArguments,
} from "../extensions/aspire-app-model/lib/app-model.mjs";

const syntheticRepoRoot = join(tmpdir(), "repo");
const syntheticAppsRoot = join(tmpdir(), "apps");

function repoPath(...segments) {
    return join(syntheticRepoRoot, ...segments);
}

function appsPath(...segments) {
    return join(syntheticAppsRoot, ...segments);
}

test("extractJsonPayload ignores Aspire preambles and trailing text", () => {
    const payload = extractJsonPayload("Finding AppHost...\n{\n  \"resources\": [{\"name\":\"api\"}]\n}\nDone");
    assert.deepEqual(payload, { resources: [{ name: "api" }] });
    assert.deepEqual(extractJsonPayload("notice\n[]"), []);
    assert.equal(extractJsonPayload("AppHost is not running."), undefined);
});

test("dashboard resource views preserve authentication without exposing URL construction to the renderer", () => {
    const views = new Map([
        ["details", "/dashboard/?resource=api%20worker"],
        ["console-logs", "/dashboard/consolelogs/resource/api%20worker"],
        ["structured-logs", "/dashboard/structuredlogs/resource/api%20worker"],
        ["traces", "/dashboard/traces/resource/api%20worker"],
        ["metrics", "/dashboard/metrics/resource/api%20worker"],
    ]);
    for (const [view, expectedReturnUrl] of views) {
        const result = new URL(buildDashboardViewUrl(
            "https://localhost:18888/dashboard/login?t=private-token",
            view,
            "api worker",
        ));
        assert.equal(result.pathname, "/dashboard/login");
        assert.equal(result.searchParams.get("returnUrl"), expectedReturnUrl);
        assert.equal(result.searchParams.get("t"), "private-token");
    }

    assert.equal(
        buildDashboardViewUrl("https://localhost:18888/dashboard/", "metrics", "api"),
        "https://localhost:18888/dashboard/metrics/resource/api",
    );
    assert.equal(buildDashboardViewUrl("file:///tmp/dashboard", "traces", "api"), undefined);
    assert.equal(buildDashboardViewUrl("https://localhost:18888/login?t=secret", "unknown", "api"), undefined);
});

test("terminal attach commands quote resource and AppHost arguments for the host shell", () => {
    assert.equal(
        buildTerminalAttachCommand({
            resourceName: "worker'name",
            appHostPath: "C:\\repo\\My App\\AppHost.csproj",
            replicaIndex: "2",
            platform: "win32",
        }),
        "aspire terminal attach 'worker''name' --apphost 'C:\\repo\\My App\\AppHost.csproj' --replica '2'",
    );
    assert.equal(
        buildTerminalAttachCommand({
            resourceName: "api'name",
            appHostPath: "/tmp/My App/AppHost.csproj",
            platform: "linux",
        }),
        "aspire terminal attach 'api'\\''name' --apphost '/tmp/My App/AppHost.csproj'",
    );
});

test("sanitizeResource exposes only the app-model allow-list", () => {
    const resource = sanitizeResource({
        name: "server-ab12",
        displayName: "server",
        resourceType: "Project",
        state: "Running",
        stateStyle: "success",
        healthStatus: "Healthy",
        source: "C:\\private\\server.csproj",
        environment: {
            API_TOKEN: "super-secret",
            FEATURE_FLAG: "true",
        },
        properties: {
            "terminal.enabled": "true",
            "terminal.replicaIndex": "2",
            Value: "secret-value",
            "resource.connectionString": "Host=db;Password=secret",
        },
        volumes: [{ source: "C:\\private\\data", target: "/data" }],
        dashboardUrl: "https://admin:password@localhost:18888/login?t=live-token&resource=server",
        relationships: [
            { type: "Reference", resourceName: "db" },
            { type: "Unknown", resourceName: "ignored" },
        ],
        urls: [{
            name: "https",
            displayName: "HTTPS",
            url: "https://user:password@localhost:7001/path?sig=super-secret#access_token=secret",
            isInternal: false,
        }],
        healthReports: {
            ready: { status: "healthy", description: "may contain sensitive text" },
        },
        commands: {
            createVacation: {
                displayName: "Create vacation",
                description: "Create one",
                state: "Enabled",
                argumentInputs: [
                    { name: "adminKey", label: "Admin key", inputType: "SecretText", required: true, value: "secret" },
                ],
            },
        },
    });

    assert.equal(resource.name, "server-ab12");
    assert.equal(resource.dashboardUrl, "https://localhost:18888/?resource=server");
    assert.equal(resource.urls[0].url, "https://localhost:7001/path");
    assert.deepEqual(resource.relationships, [{ type: "Reference", resourceName: "db" }]);
    assert.deepEqual(resource.healthReports, [{ name: "ready", status: "Healthy" }]);
    assert.equal(resource.commands[0].argumentInputs[0].value, undefined);
    assert.equal(resource.terminalEnabled, true);
    assert.equal(resource.terminalReplicaIndex, "2");
    assert.equal("source" in resource, false);
    assert.equal("environment" in resource, false);
    assert.equal("properties" in resource, false);
    assert.equal("volumes" in resource, false);
    assert.doesNotMatch(JSON.stringify(resource), /super-secret|secret-value|Password=secret/);
});

test("projectDescribePayload summarizes runtime health", () => {
    const projected = projectDescribePayload({
        resources: [
            { name: "api", resourceType: "Project", state: "Running", healthStatus: "Healthy" },
            { name: "worker", resourceType: "Project", state: "Waiting" },
            { name: "db", resourceType: "Container", state: "FailedToStart" },
            { name: "tool", resourceType: "Executable", state: "NotStarted" },
        ],
    });

    assert.deepEqual(projected.summary, {
        total: 4,
        healthy: 1,
        warning: 1,
        error: 1,
        inactive: 1,
    });
});

test("resource status prefers lifecycle and current health checks over stale aggregate health", () => {
    const projected = projectDescribePayload({
        resources: [
            {
                name: "cache",
                resourceType: "Container",
                state: "Exited",
                healthStatus: "Healthy",
                exitCode: 137,
            },
            {
                name: "server",
                resourceType: "Project",
                state: "Finished",
                healthReports: { ready: { status: "Unhealthy" } },
            },
            {
                name: "installer",
                resourceType: "Executable",
                state: "Finished",
                stateStyle: "success",
            },
        ],
    });
    const nodes = buildResourceTree(projected.resources, "host");
    const byName = new Map(nodes.map((node) => [node.label, node]));

    assert.equal(byName.get("cache").tone, "error");
    assert.equal(byName.get("cache").statusLabel, "Exited · 137");
    assert.equal(byName.get("cache").lifecycleTone, "error");
    assert.equal(byName.get("cache").healthLabel, "Last known healthy");
    assert.equal(byName.get("cache").healthTone, "inactive");
    assert.equal(byName.get("server").tone, "inactive");
    assert.equal(byName.get("server").statusLabel, "Finished");
    assert.equal(byName.get("server").lifecycleTone, "inactive");
    assert.equal(byName.get("server").healthLabel, "Last known unhealthy");
    assert.equal(byName.get("server").healthTone, "error");
    assert.equal(byName.get("installer").tone, "healthy");
    assert.equal(byName.get("installer").statusLabel, "Finished");
    assert.equal(byName.get("installer").lifecycleTone, "healthy");
    assert.equal(byName.get("installer").healthLabel, undefined);
    assert.deepEqual(projected.summary, {
        total: 3,
        healthy: 1,
        warning: 0,
        error: 1,
        inactive: 1,
    });
});

test("resource graph layers dependencies before dependents and preserves relationship semantics", () => {
    const resources = projectDescribePayload({
        resources: [
            { name: "cache", resourceType: "Container", state: "Running" },
            { name: "postgres", resourceType: "Container", state: "Running" },
            {
                name: "catalog",
                resourceType: "PostgresDatabaseResource",
                state: "Running",
                relationships: [{ type: "Parent", resourceName: "postgres" }],
            },
            {
                name: "api",
                resourceType: "Project",
                state: "Running",
                relationships: [
                    { type: "Reference", resourceName: "cache" },
                    { type: "Reference", resourceName: "catalog" },
                    { type: "WaitFor", resourceName: "cache" },
                ],
                waitingFor: ["cache", "catalog"],
            },
            {
                name: "web",
                resourceType: "Project",
                state: "Running",
                relationships: [{ type: "Reference", resourceName: "api" }],
                waitingFor: ["api"],
            },
            { name: "worker", resourceType: "Project", state: "Running" },
        ],
    }).resources;

    const graph = buildResourceGraph(resources);
    const nodeByName = new Map(graph.nodes.map((node) => [node.resourceName, node]));
    const edgeByPair = new Map(graph.edges.map((edge) => [`${edge.from}->${edge.to}`, edge]));

    assert.equal(nodeByName.get("cache").layer, 0);
    assert.equal(nodeByName.get("postgres").layer, 0);
    assert.equal(nodeByName.get("worker").layer, 0);
    assert.equal(nodeByName.get("catalog").layer, 1);
    assert.equal(nodeByName.get("api").layer, 2);
    assert.equal(nodeByName.get("web").layer, 3);
    assert.deepEqual(edgeByPair.get("cache->api").types, ["Reference", "WaitFor"]);
    assert.deepEqual(edgeByPair.get("catalog->api").types, ["Reference", "WaitFor"]);
    assert.deepEqual(edgeByPair.get("postgres->catalog").types, ["Parent"]);
    assert.deepEqual(edgeByPair.get("api->web").types, ["Reference", "WaitFor"]);
    assert.equal(graph.edges.length, 4);
});

test("resource graph keeps cycles stable without inventing dependency depth", () => {
    const resources = projectDescribePayload({
        resources: [
            { name: "x", resourceType: "Project", state: "Running" },
            {
                name: "a",
                resourceType: "Project",
                state: "Running",
                relationships: [
                    { type: "Reference", resourceName: "x" },
                    { type: "Reference", resourceName: "b" },
                ],
            },
            {
                name: "b",
                resourceType: "Project",
                state: "Running",
                relationships: [{ type: "Reference", resourceName: "a" }],
            },
            {
                name: "c",
                resourceType: "Project",
                state: "Running",
                relationships: [{ type: "Reference", resourceName: "b" }],
            },
        ],
    }).resources;

    const graph = buildResourceGraph(resources);
    assert.deepEqual(graph.nodes.map((node) => [node.resourceName, node.layer]), [
        ["x", 0],
        ["a", 1],
        ["b", 1],
        ["c", 2],
    ]);
    assert.equal(graph.edges.length, 4);
});

test("resource graph resolves unique waitingFor display names without guessing ambiguous names", () => {
    const graph = buildResourceGraph(projectDescribePayload({
        resources: [
            { name: "messaging-abcxyz", displayName: "messaging", resourceType: "Container", state: "Running" },
            { name: "api", resourceType: "Project", state: "Running", waitingFor: ["messaging"] },
        ],
    }).resources);
    assert.deepEqual(graph.edges.map((edge) => [edge.from, edge.to, edge.types]), [
        ["messaging-abcxyz", "api", ["WaitFor"]],
    ]);

    const ambiguous = buildResourceGraph(projectDescribePayload({
        resources: [
            { name: "worker-one", displayName: "worker", resourceType: "Project", state: "Running" },
            { name: "worker-two", displayName: "worker", resourceType: "Project", state: "Running" },
            { name: "api", resourceType: "Project", state: "Running", waitingFor: ["worker"] },
        ],
    }).resources);
    assert.equal(ambiguous.edges.length, 0);
    assert.deepEqual(
        ambiguous.nodes.filter((node) => node.resourceName.startsWith("worker-")).map((node) => node.label),
        ["worker-one", "worker-two"],
    );
});

test("ps projection never exposes the token-bearing dashboard URL", () => {
    const records = normalizePsPayload([{
        appHostPath: repoPath("Demo.AppHost", "Demo.AppHost.csproj"),
        appHostPid: 123,
        status: "running",
        sdkVersion: "13.5.2",
        dashboardUrl: "https://localhost:18888/login?t=secret",
        logFilePath: "C:\\private\\apphost.log",
    }]);

    const publicRecord = publicAppHost(records[0], records[0].id);
    assert.deepEqual(publicRecord, {
        id: records[0].id,
        displayName: "Demo",
        status: "running",
        sdkVersion: "13.5.2",
        selected: true,
    });
    assert.doesNotMatch(JSON.stringify(publicRecord), /dashboard|secret|private|repo/i);
    const [treeNode] = buildGlobalTree({ runningHosts: records, models: new Map() });
    assert.ok(treeNode.actions.includes("dashboard"));
    assert.doesNotMatch(JSON.stringify(treeNode), /login\?t=secret/);

    const withoutStatus = normalizePsPayload([{
        appHostPath: repoPath("Other.AppHost", "Other.AppHost.csproj"),
        appHostPid: 456,
    }]);
    assert.equal(withoutStatus[0].status, "running");

    const [invalidDashboard] = normalizePsPayload([{
        appHostPath: repoPath("Invalid.AppHost", "Invalid.AppHost.csproj"),
        dashboardUrl: "file:///private/dashboard",
    }]);
    const [invalidTreeNode] = buildGlobalTree({
        runningHosts: [invalidDashboard],
        models: new Map(),
    });
    assert.equal(invalidTreeNode.actions.includes("dashboard"), false);
});

test("command argument validation enforces declared types and choices", () => {
    const command = {
        argumentInputs: [
            { name: "name", label: "Name", inputType: "Text", required: true, maxLength: 8 },
            { name: "days", label: "Days", inputType: "Number", required: true },
            { name: "notify", label: "Notify", inputType: "Boolean", required: false },
            {
                name: "region",
                label: "Region",
                inputType: "Choice",
                required: true,
                allowCustomChoice: false,
                options: [{ value: "west", label: "West" }],
            },
        ],
    };

    assert.deepEqual(validateCommandArguments(command, {
        name: "Vacay",
        days: "7",
        notify: "false",
        region: "west",
    }), {
        ok: true,
        values: { name: "Vacay", days: 7, notify: false, region: "west" },
        errors: [],
    });

    const invalid = validateCommandArguments(command, {
        name: "A name that is too long",
        days: "many",
        region: "east",
        extra: "not declared",
    });
    assert.equal(invalid.ok, false);
    assert.deepEqual(invalid.errors.map((error) => error.argumentName).sort(), ["days", "extra", "name", "region"]);
});

test("command input defaults preserve non-secret values only", () => {
    const inputs = sanitizeCommandArgumentInputs([
        { name: "count", inputType: "Number", value: "3" },
        { name: "enabled", inputType: "Boolean", value: "true" },
        {
            name: "region",
            inputType: "Choice",
            value: "west",
            options: [{ value: "west", label: "West" }],
        },
        {
            name: "invalidRegion",
            inputType: "Choice",
            value: "east",
            options: [{ value: "west", label: "West" }],
        },
        { name: "token", inputType: "SecretText", value: "do-not-expose" },
    ]);

    assert.equal(inputs.find((input) => input.name === "count").value, "3");
    assert.equal(inputs.find((input) => input.name === "enabled").value, "true");
    assert.equal(inputs.find((input) => input.name === "region").value, "west");
    assert.equal(inputs.find((input) => input.name === "invalidRegion").value, undefined);
    assert.equal(inputs.find((input) => input.name === "token").value, undefined);
    assert.doesNotMatch(JSON.stringify(inputs), /do-not-expose/);
});

test("resource command arguments use the CLI delimiter and declared input names", () => {
    assert.deepEqual(buildResourceCommandArgs({
        appHostPath: "C:\\repo\\AppHost.csproj",
        resourceName: "server-ab12",
        commandName: "createVacation",
        arguments: {
            startDate: "2026-09-01",
            sendEmail: false,
        },
    }), [
        "resource",
        "server-ab12",
        "createVacation",
        "--apphost",
        "C:\\repo\\AppHost.csproj",
        "--non-interactive",
        "--nologo",
        "--",
        "--startDate=2026-09-01",
        "--sendEmail=false",
    ]);
    assert.deepEqual(buildCommandArgumentTokens({ startDate: "2026-09-01" }), [
        "--",
        "--startDate=2026-09-01",
    ]);
});

test("redactText strips common token and secret forms", () => {
    const value = redactText(
        "\u001b[31mfailed\u001b[0m https://localhost/login?t=abc123 password=hunter2 API_KEY: value",
    );
    assert.equal(value, "failed https://localhost/login?t=[redacted] password=[redacted] API_KEY: [redacted]");
});

test("redactText removes exact submitted secret values", () => {
    assert.equal(
        redactText("Rotated to hunter2-abc", 1024, ["hunter2-abc"]),
        "Rotated to [redacted]",
    );
});

test("redactAbsolutePaths handles delimited Windows and POSIX paths without swallowing diagnostics", () => {
    assert.equal(
        redactAbsolutePaths("appHostPath=/Users/dev/secret/App.AppHost.csproj not found"),
        "appHostPath=[path withheld] not found",
    );
    assert.equal(
        redactAbsolutePaths("Could not load '/srv/data/App.AppHost.csproj' because it is invalid"),
        "Could not load '[path withheld]' because it is invalid",
    );
    assert.equal(
        redactAbsolutePaths("MSB4025: C:\\repo\\App.csproj is invalid"),
        "MSB4025: [path withheld] is invalid",
    );
    assert.equal(
        redactAbsolutePaths("open C:\\Users\\Jane Doe\\secrets.txt failed"),
        "open [path withheld] failed",
    );
    assert.equal(
        redactAbsolutePaths("open /Users/jane doe/secrets.txt failed"),
        "open [path withheld] failed",
    );
});

test("redactKnownPaths consumes private path suffixes", () => {
    const workspace = "C:\\repo";
    const appHost = "C:\\repo\\Secret.AppHost\\Secret.AppHost.csproj";
    const redacted = redactKnownPaths(
        `Build failed for ${appHost} and C:\\repo\\src\\Internal Data\\credentials.json`,
        [workspace, appHost],
    );
    assert.equal(redacted, "Build failed for [path withheld] and [path withheld]");
    assert.equal(
        redactKnownPaths("Build failed for C:\\repo\\src\\App.csproj is invalid", [workspace]),
        "Build failed for [path withheld] is invalid",
    );
    assert.equal(
        redactKnownPaths("open /Users/dev/repo/src/Internal Data/credentials.json failed", ["/Users/dev/repo"]),
        "open [path withheld] failed",
    );
});

test("parseLegacyPipelineSteps supports Aspire 13.5 available-step output", () => {
    assert.deepEqual(
        parseLegacyPipelineSteps(
            "Step '--format' not found in pipeline. Available steps: 'deploy', 'build',\n'publish-manifest' See logs at C:\\private\\cli.log",
        ),
        ["deploy", "build", "publish-manifest"],
    );
});

test("discoverConfiguredAppHosts resolves aspire.config.json without scanning private files", async () => {
    const root = await mkdtemp(join(tmpdir(), "aspire-app-model-"));
    try {
        const appHostDirectory = join(root, "Sample.AppHost");
        const nestedDirectory = join(root, "src", "Api");
        const appHostPath = join(appHostDirectory, "Sample.AppHost.csproj");
        await mkdir(appHostDirectory, { recursive: true });
        await mkdir(nestedDirectory, { recursive: true });
        await writeFile(appHostPath, "<Project />");
        await writeFile(join(root, "aspire.config.json"), JSON.stringify({
            appHost: { path: "Sample.AppHost/Sample.AppHost.csproj" },
        }));

        assert.deepEqual(await discoverConfiguredAppHosts(nestedDirectory), [appHostPath]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("workspace fallback discovers file-based TypeScript AppHosts with mts extensions", async () => {
    const root = await mkdtemp(join(tmpdir(), "aspire-mts-apphost-"));
    try {
        const nestedDirectory = join(root, "nested");
        const directAppHost = join(root, "apphost.mts");
        const nestedAppHost = join(nestedDirectory, "apphost.mts");
        await mkdir(nestedDirectory);
        await writeFile(directAppHost, "export default {};");
        await writeFile(nestedAppHost, "export default {};");

        assert.deepEqual(
            new Set(await discoverConfiguredAppHosts(root)),
            new Set([directAppHost, nestedAppHost]),
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("normalizeLsPayload preserves buildability without exposing candidate paths publicly", () => {
    const candidates = normalizeLsPayload([
        { path: repoPath("First.AppHost", "First.AppHost.csproj"), language: "csharp", status: "buildable" },
        { path: repoPath("apphost.ts"), language: "typescript/nodejs", status: "possibly-unbuildable" },
    ]);

    assert.equal(candidates[0].displayName, "First");
    assert.equal(candidates[0].buildable, true);
    assert.equal(candidates[1].buildable, false);
    assert.equal(candidates[1].displayName, "repo");
    assert.notEqual(candidates[0].id, candidates[1].id);
});

test("buildResourceTree follows VS Code child ordering and command visibility", () => {
    const resources = projectDescribePayload({
        resources: [
            {
                name: "postgres",
                displayName: "postgres",
                resourceType: "Container",
                state: "Running",
                healthStatus: "Healthy",
                properties: {
                    "terminal.enabled": "true",
                    "terminal.replicaIndex": "3",
                },
                urls: [
                    { name: "tcp", displayName: "TCP", url: "tcp://localhost:5432", isInternal: false },
                    { name: "postgres", displayName: "Postgres", url: "postgres://admin:secret@localhost:5432/app", isInternal: false },
                    { name: "unsafe", displayName: "Unsafe", url: "javascript:alert(1)", isInternal: false },
                ],
                healthReports: { ready: { status: "Healthy" } },
                commands: {
                    visible: { displayName: "Visible", visibility: "UI, Api", state: "Enabled", sortOrder: 2 },
                    disabled: { displayName: "Disabled", visibility: "UI", state: "Disabled", sortOrder: 1 },
                    apiOnly: { displayName: "API only", visibility: "Api", state: "Enabled", sortOrder: 0 },
                },
            },
            {
                name: "vacations",
                displayName: "vacations",
                resourceType: "PostgresDatabaseResource",
                state: "Running",
                relationships: [{ type: "Parent", resourceName: "postgres" }],
            },
        ],
    }).resources;

    const [postgres] = buildResourceTree(resources, "host");
    assert.equal(postgres.label, "postgres");
    assert.equal(postgres.statusLabel, "Running");
    assert.equal(postgres.healthLabel, "Healthy");
    assert.equal(postgres.terminalEnabled, true);
    assert.equal(postgres.terminalReplicaIndex, "3");
    assert.deepEqual(postgres.children.map((child) => child.kind), [
        "resource",
        "endpoint",
        "endpoint",
        "health-group",
        "commands-group",
    ]);
    assert.equal(postgres.children[1].href, undefined);
    assert.equal(postgres.children[2].href, undefined);
    assert.doesNotMatch(postgres.children[2].description, /admin|secret/);
    assert.equal(postgres.children.some((child) => child.label === "Unsafe"), false);
    const commands = postgres.children.at(-1).children;
    assert.deepEqual(commands.map((command) => command.label), ["Disabled", "Visible"]);
    assert.equal(commands[0].disabled, true);
});

test("buildWorkspaceTree flattens one running host and minimizes mixed grouping", () => {
    const [candidateA, candidateB] = normalizeLsPayload([
        { path: repoPath("A.AppHost", "A.AppHost.csproj"), language: "csharp", status: "buildable" },
        { path: repoPath("B.AppHost", "B.AppHost.csproj"), language: "csharp", status: "buildable" },
    ]);
    const runningA = { ...candidateA, status: "running", runtimeId: candidateA.id };
    const models = new Map([[candidateA.id, {
        resources: projectDescribePayload({ resources: [{ name: "api", resourceType: "Project", state: "Running" }] }).resources,
        summary: { total: 1 },
    }]]);

    const mixed = buildWorkspaceTree({
        candidates: [candidateA, candidateB],
        runningHosts: [runningA],
        models,
    });

    assert.deepEqual(mixed.map((node) => node.kind), ["apphost-running", "apphost-idle"]);
    assert.equal(mixed[0].children.some((child) => child.kind === "resources-group"), false);
    assert.equal(mixed[0].children.some((child) => child.kind === "resource"), true);

    const idleOnly = buildWorkspaceTree({
        candidates: [candidateA, candidateB],
        runningHosts: [],
    });
    assert.deepEqual(idleOnly.map((node) => node.label), ["A", "B"]);
    assert.ok(idleOnly.every((node) => node.kind === "apphost-idle"));
});

test("unbuildable Workspace AppHosts retain source and explain disabled operations", () => {
    const [candidate] = normalizeLsPayload([{
        path: repoPath("Broken.AppHost", "Broken.AppHost.csproj"),
        language: "csharp",
        status: "possibly-unbuildable",
    }]);
    candidate.relativePath = "Broken.AppHost/Broken.AppHost.csproj";

    const [node] = buildWorkspaceTree({
        candidates: [candidate],
        runningHosts: [],
    });

    assert.deepEqual(node.actions, ["source"]);
    assert.equal(node.description, "C# · Needs attention");
    assert.match(node.unavailableActionReason, /could not confirm.*buildable/i);
    assert.equal("relativePath" in node, false);
});

test("combineWorkspaceAppHosts excludes stopped ps records from the running tree", () => {
    const [candidate] = normalizeLsPayload([
        { path: repoPath("A.AppHost", "A.AppHost.csproj"), language: "csharp", status: "buildable" },
    ]);
    const [stopped] = normalizePsPayload([
        { appHostPath: candidate.appHostPath, appHostPid: 123, status: "stopped" },
    ]);
    const combined = combineWorkspaceAppHosts([candidate], [stopped]);
    assert.equal(combined.running.length, 0);
    assert.equal(combined.idle.length, 1);
});

test("buildGlobalTree retains a healthy host beside a failed host", () => {
    const hosts = normalizePsPayload([
        { appHostPath: appsPath("A.AppHost", "A.AppHost.csproj"), appHostPid: 1, status: "running" },
        { appHostPath: appsPath("B.AppHost", "B.AppHost.csproj"), appHostPid: 2, status: "running" },
    ]);
    const models = new Map([
        [hosts[0].id, {
            resources: projectDescribePayload({ resources: [{ name: "api", resourceType: "Project", state: "Running" }] }).resources,
        }],
        [hosts[1].id, { resources: [], error: "describe failed", stale: false }],
    ]);

    const tree = buildGlobalTree({ runningHosts: hosts, models });
    assert.equal(tree.length, 2);
    assert.equal(tree.find((node) => node.label === "A").children.some((child) => child.kind === "resources-group"), true);
    assert.equal(tree.find((node) => node.label === "B").children.at(-1).kind, "error");
});

test("filterTree keeps ancestors of matching descendants", () => {
    const tree = [{
        id: "host",
        label: "AppHost",
        description: "",
        children: [{
            id: "resources",
            label: "Resources",
            description: "",
            children: [{ id: "api", label: "checkout-api", description: "Project", children: [] }],
        }],
    }];
    const result = filterTree(tree, "checkout");
    assert.equal(result[0].label, "AppHost");
    assert.equal(result[0].children[0].label, "Resources");
    assert.equal(result[0].children[0].children[0].label, "checkout-api");
    assert.equal(result[0].defaultExpanded, true);
});

test("mapWithConcurrency never exceeds the configured fanout", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 4, async (value) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return value * 2;
    });

    assert.equal(peak, 4);
    assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14]);
});

test("runWithOptionalFlagFallback retries only unsupported optional flags", async () => {
    const invocations = [];
    const result = await runWithOptionalFlagFallback(async (args) => {
        invocations.push(args);
        return invocations.length === 1
            ? { ok: true, stdout: "Resource '--include-disabled-commands' not found." }
            : { ok: true, data: { resources: [] } };
    }, [
        "describe",
        "--include-disabled-commands",
        "--format",
        "Json",
    ], "--include-disabled-commands");

    assert.equal(result.ok, true);
    assert.equal(result.optionalFlagFallbackUsed, true);
    assert.deepEqual(invocations, [
        ["describe", "--include-disabled-commands", "--format", "Json"],
        ["describe", "--format", "Json"],
    ]);
});

test("optional flag fallback does not repeat genuine failures", async () => {
    assert.equal(
        optionalFlagIsUnsupported(
            { ok: false, error: "Unrecognized command or argument '--new-flag'." },
            "--new-flag",
        ),
        true,
    );
    assert.equal(
        optionalFlagIsUnsupported({ ok: false, error: "AppHost build failed." }, "--new-flag"),
        false,
    );

    let invocations = 0;
    const result = await runWithOptionalFlagFallback(async () => {
        invocations++;
        return { ok: false, error: "Aspire CLI timed out after 30 seconds." };
    }, ["describe", "--new-flag"], "--new-flag");
    assert.equal(result.ok, false);
    assert.equal(invocations, 1);
});

test("SnapshotGeneration rejects superseded refresh publications", () => {
    const generation = new SnapshotGeneration();
    const first = generation.next();
    const second = generation.next();
    assert.equal(generation.isCurrent(first), false);
    assert.equal(generation.isCurrent(second), true);
    generation.invalidate();
    assert.equal(generation.isCurrent(second), false);
});

test("AppHostOperationCoordinator serializes one host without blocking another", async () => {
    const coordinator = new AppHostOperationCoordinator();
    let releaseA;
    const operationA = coordinator.run("a", { label: "Starting..." }, () =>
        new Promise((resolve) => { releaseA = resolve; }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(coordinator.isBusy("a"), true);
    assert.equal(coordinator.isBusy("b"), false);
    await assert.rejects(
        coordinator.run("a", { label: "Stopping..." }, async () => {}),
        (error) => error.code === "apphost_busy",
    );
    await coordinator.run("b", { label: "Publishing..." }, async () => "b");
    releaseA("a");
    assert.equal(await operationA, "a");
    assert.equal(coordinator.isBusy("a"), false);
});

test("dynamic command input metadata remains authoritative until its base changes", () => {
    const store = new CommandInputMetadataStore();
    const baseInputs = [
        {
            name: "environment",
            label: "Environment",
            inputType: "Choice",
            required: true,
            options: [{ value: "dev", label: "Development" }],
        },
        {
            name: "key",
            label: "Key",
            inputType: "Text",
            required: true,
            disabled: true,
        },
    ];
    const loadedInputs = [
        {
            ...baseInputs[0],
            options: [...baseInputs[0].options, { value: "prod", label: "Production" }],
        },
        {
            ...baseInputs[1],
            disabled: false,
        },
    ];
    const identity = { appHostId: "host", resourceName: "api", commandName: "deploy" };
    store.set({ ...identity, baseInputs, inputs: loadedInputs });

    const currentInputs = store.inputsFor({ ...identity, baseInputs });
    const validation = validateCommandArguments(
        { argumentInputs: currentInputs },
        { environment: "prod", key: "value" },
    );
    assert.equal(validation.ok, true);
    assert.equal(validation.values.key, "value");
    assert.equal(store.inputsFor({ ...identity, baseInputs: [...baseInputs, { name: "new" }] }), undefined);
});

test("KeyedTaskQueue applies same-command work in issue order", async () => {
    const queue = new KeyedTaskQueue();
    let releaseFirst;
    const order = [];
    const first = queue.run("command", async () => {
        order.push("first-start");
        await new Promise((resolve) => { releaseFirst = resolve; });
        order.push("first-end");
    });
    const second = queue.run("command", async () => {
        order.push("second");
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first-start", "first-end", "second"]);
});

test("AppHost operation identity is stable across source and project paths", () => {
    assert.equal(
        appHostOperationKey(repoPath("Sample.AppHost", "Sample.AppHost.csproj")),
        appHostOperationKey(repoPath("Sample.AppHost", "AppHost.cs")),
    );
    assert.equal(
        appHostOperationKey(repoPath("Sample.AppHost")),
        appHostOperationKey(repoPath("Sample.AppHost", "Sample.AppHost.csproj")),
    );
    assert.notEqual(
        appHostOperationKey(repoPath("Sample.AppHost")),
        appHostOperationKey(repoPath("Other.AppHost")),
    );
});

test("directory AppHost inputs resolve to a concrete project", async () => {
    const root = await mkdtemp(join(tmpdir(), "aspire-apphost-path-"));
    try {
        const appHostDirectory = join(root, "Sample.AppHost");
        const projectPath = join(appHostDirectory, "Sample.AppHost.csproj");
        await mkdir(appHostDirectory);
        await writeFile(projectPath, "<Project />");

        assert.equal(await resolveRequestedAppHostPath(appHostDirectory, root), projectPath);
        assert.equal(await resolveRequestedAppHostPath(projectPath, root), projectPath);
        await assert.rejects(
            resolveRequestedAppHostPath(join(root, "missing"), root),
            /does not exist/,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("canvas source carries the confirmed direction and protected data routes", async () => {
    const root = new URL("../extensions/aspire-app-model/", import.meta.url);
    const [html, client, styles, provider, model] = await Promise.all([
        import("node:fs/promises").then(({ readFile }) => readFile(new URL("ui/index.html", root), "utf8")),
        import("node:fs/promises").then(({ readFile }) => readFile(new URL("ui/app.js", root), "utf8")),
        import("node:fs/promises").then(({ readFile }) => readFile(new URL("ui/styles.css", root), "utf8")),
        import("node:fs/promises").then(({ readFile }) => readFile(new URL("extension.mjs", root), "utf8")),
        import("node:fs/promises").then(({ readFile }) => readFile(new URL("lib/app-model.mjs", root), "utf8")),
    ]);

    assert.match(html, /THESIS: Aspire's operational model becomes a canvas-native workspace/);
    assert.match(html, />Aspire AppHosts</);
    assert.match(html, /class="model-view"/);
    assert.match(client, /\/api\/copilot-context/);
    assert.match(client, /\/api\/open-dashboard/);
    assert.match(client, /\/api\/open-dashboard-view/);
    assert.match(client, /\/api\/open-endpoint/);
    assert.match(client, /\/api\/open-terminal/);
    assert.match(client, /\/api\/command/);
    assert.match(client, /host-action-bar/);
    assert.match(client, /Add to Copilot chat/);
    assert.match(client, /resource-board/);
    assert.match(client, /app-model-tabs/);
    assert.match(client, /resource-graph/);
    assert.match(client, /drawResourceGraphEdges/);
    assert.match(client, /graphEdgePresentation/);
    assert.match(client, /is-combined/);
    assert.match(client, /rememberAppModelViewState/);
    assert.match(client, /restoreAppModelViewState/);
    assert.match(client, /renderedAppHostId/);
    assert.match(client, /actionMenuTrigger/);
    assert.match(client, /hideActionMenu\(\{ restoreFocus: true \}\)/);
    assert.doesNotMatch(client, /dashboardActionChip/);
    assert.doesNotMatch(client, /"Diagnostics"/);
    assert.match(client, /role: "tablist"/);
    assert.match(client, /shortLabel/);
    assert.match(client, /CONFIRMATIONS/);
    assert.match(client, /unavailableActionReason/);
    assert.match(client, /clearActiveCommand\(\)/);
    assert.match(client, /cachedInputs.*baseInputs/s);
    assert.match(client, /input\.value/);
    assert.match(client, /pruneCommandDraft/);
    assert.match(client, /dynamicLoadGenerations/);
    assert.match(client, /focusCommandPanel/);
    assert.match(client, /confirmationCancel/);
    assert.match(client, /document\.startViewTransition/);
    assert.match(client, /is-mode-switching/);
    assert.match(client, /class: "resource-card-identity"/);
    assert.doesNotMatch(client, /class: "resource-card-main"/);
    assert.match(client, /navigator\.clipboard\?\.writeText/);
    assert.match(client, /class: "resource-name-copy"/);
    assert.match(client, /Console logs/);
    assert.match(client, /Structured logs/);
    assert.match(client, /Traces/);
    assert.match(client, /Metrics/);
    assert.match(styles, /--border-strong:/);
    assert.match(styles, /view-transition-name: app-model-surface/);
    assert.doesNotMatch(styles, /\.resource-card:hover/);
    const resourceBoardStyles = styles.slice(
        styles.indexOf(".resource-board {"),
        styles.indexOf(".resource-card {"),
    );
    const resourceCardStyles = styles.slice(
        styles.indexOf(".resource-card {"),
        styles.indexOf(".resource-card.has-command-panel"),
    );
    assert.doesNotMatch(resourceBoardStyles, /grid-auto-rows:\s*1fr/);
    assert.doesNotMatch(resourceCardStyles, /height:\s*100%/);
    assert.match(provider, /CommandInputMetadataStore/);
    assert.match(provider, /sendAttachmentsToMessage/);
    assert.match(provider, /type: "extension_context"/);
    assert.match(provider, /canvasId: "browser"/);
    assert.match(provider, /canvasId: "terminal"/);
    assert.match(provider, /buildDashboardViewUrl/);
    assert.match(model, /graph: buildResourceGraph\(resources\)/);
    assert.match(provider, /buildTerminalAttachCommand/);
    assert.match(provider, /privateDashboardUrl/);
    assert.match(provider, /KeyedTaskQueue/);
    assert.match(provider, /submittedSecretValues/);
    assert.match(provider, /optionalFlagFallbackUsed/);
    assert.match(provider, /status: hasRoots \? "stale" : "error"/);
    assert.match(provider, /Content-Security-Policy/);
    assert.match(provider, /error\?\.status === 413 \? 413 : 400/);
    assert.match(provider, /const showProgress = force \|\| entry\.state\.status === "loading"/);
    assert.doesNotMatch(provider, /showProgress = force \|\| entry\.state\.roots\.length === 0/);
    assert.equal(client.includes('querySelector("[data-apphost-primary]")'), false);
    assert.equal(client.includes('querySelector("[data-apphost-primary]:not([disabled])")'), true);

    const copyHandler = client.slice(
        client.indexOf("async function copyResourceName"),
        client.indexOf("function setModeButtons"),
    );
    const nodeActionHandler = client.slice(
        client.indexOf("async function executeNodeAction"),
        client.indexOf("async function choosePipelineStep"),
    );
    assert.doesNotMatch(copyHandler, /DASHBOARD_VIEW_ACTIONS|\/api\/open-dashboard-view/);
    assert.match(nodeActionHandler, /DASHBOARD_VIEW_ACTIONS/);
    assert.match(nodeActionHandler, /\/api\/open-dashboard-view/);
});

test("canvas uses a focused Workspace and Global resource board instead of an explorer tree", async () => {
    const [html, client] = await Promise.all([
        import("node:fs/promises").then(({ readFile }) => readFile(
            new URL("../extensions/aspire-app-model/ui/index.html", import.meta.url),
            "utf8",
        )),
        import("node:fs/promises").then(({ readFile }) => readFile(
            new URL("../extensions/aspire-app-model/ui/app.js", import.meta.url),
            "utf8",
        )),
    ]);

    assert.match(html, />Workspace</);
    assert.match(html, />Global</);
    assert.match(client, /apphost-switcher/);
    assert.match(client, /resource-board/);
    assert.doesNotMatch(html, /role="tree"|>Graph</);
});
