import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";

const states = new Set(["populated", "loading", "empty", "error", "long", "confirmed"]);
const extensions = ["aspire-apphosts", "aspire-doctor", "aspireify"];
const servers = [];
const urls = {};

for (const extension of extensions) {
    let state = "populated";
    const root = new URL(`../../extensions/${extension}/ui/`, import.meta.url);
    const files = new Map([
        ["/", ["index.html", "text/html; charset=utf-8"]],
        ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
        ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
        ["/canvas-theme.css", ["canvas-theme.css", "text/css; charset=utf-8"]],
        ["/canvas-icons.svg", ["canvas-icons.svg", "image/svg+xml"]],
        ...(extension === "aspire-doctor"
            ? [["/model.mjs", ["model.mjs", "text/javascript; charset=utf-8"]]]
            : []),
        ...(extension === "aspireify"
            ? ["resource-types.js", "interaction-model.js"].map(name => [
                `/${name}`, [name, "text/javascript; charset=utf-8"],
            ])
            : []),
    ]);
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url, "http://127.0.0.1");
            const refresh = extension === "aspire-apphosts" &&
                request.method === "POST" && url.pathname === "/api/refresh";
            const selection = extension === "aspire-apphosts" &&
                request.method === "POST" && url.pathname === "/api/selection";
            if (request.method !== "GET" && !refresh && !selection) {
                response.writeHead(405, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ error: "Read-only preview: actions are disabled." }));
                return;
            }
            if (selection) {
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ ok: true }));
                return;
            }
            if (url.pathname === "/favicon.ico") {
                response.writeHead(204);
                response.end();
                return;
            }
            if (url.pathname === "/") {
                state = url.searchParams.get("state") || "populated";
                if (!states.has(state)) {
                    response.writeHead(400);
                    response.end("Unknown preview state.");
                    return;
                }
            }
            if (url.pathname === "/events") {
                response.writeHead(200, { "Content-Type": "text/event-stream" });
                response.write(": preview\n\n");
                if (state !== "loading") {
                    const data = previewData(extension, state);
                    const message = extension === "aspire-apphosts"
                        ? { type: "state", state: data.state }
                        : extension === "aspire-doctor"
                            ? { type: "diagnostics", result: data }
                            : { type: "snapshot", snapshot: data };
                    response.write(`data: ${JSON.stringify(message)}\n\n`);
                }
                return;
            }
            const endpoint = {
                "aspire-apphosts": "/api/state",
                "aspire-doctor": "/api/diagnostics",
                aspireify: "/api/snapshot",
            }[extension];
            if (url.pathname === endpoint || refresh) {
                if (state === "loading") {
                    return;
                }
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(JSON.stringify(previewData(extension, state)));
                return;
            }
            const asset = files.get(url.pathname);
            if (!asset) {
                response.writeHead(404);
                response.end("Preview route not found.");
                return;
            }
            const content = await readFile(new URL(asset[0], root));
            response.writeHead(200, {
                "Content-Type": asset[1],
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
            });
            response.end(content);
        } catch (error) {
            console.error(error);
            response.writeHead(500);
            response.end("Preview asset could not be loaded.");
        }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    urls[extension] = `http://127.0.0.1:${server.address().port}/?token=preview`;
}

console.log(JSON.stringify(urls));

function previewData(extension, state) {
    const long = state === "long";
    const empty = state === "empty" || state === "error";
    const name = long ? "Sample-application-with-a-very-long-resource-name" : "api";
    const detail = long
        ? "A long description with an_unbroken_identifier_that_should_not_overflow_the_available_canvas_width. ".repeat(8)
        : "Public API with distributed tracing and health checks.";
    if (extension === "aspire-apphosts") {
        const resources = empty ? [] : [
            { id: "sample:api", kind: "resource", label: name, resourceName: "api", appHostId: "sample", description: detail, tone: "healthy", icon: "resource", children: [] },
            { id: "sample:frontend", kind: "resource", label: "frontend", resourceName: "frontend", appHostId: "sample", description: "Vite application", tone: "warning", children: [] },
            { id: "sample:cache", kind: "resource", label: "cache", resourceName: "cache", appHostId: "sample", description: "Redis", tone: "error", children: [] },
        ];
        return { state: {
            revision: 1, status: state === "error" ? "error" : "ready",
            error: state === "error" ? "The preview could not load AppHosts. Refresh to try again." : null,
            viewMode: "workspace", refreshing: false, includeHidden: false,
            generatedAt: new Date().toISOString(), lastSuccessfulAt: new Date().toISOString(),
            roots: empty ? [] : [{
                id: "sample", appHostId: "sample", kind: "apphost-running",
                label: long ? "Sample.AppHost.With.A.Long.Name.For.A.Narrow.Canvas" : "Sample.AppHost",
                identityHint: "sample · a1b2c3", actions: ["dashboard", "stop", "source"],
                children: [{ id: "resources", kind: "resources-group", children: resources }],
                graph: { nodes: resources.map((resource, layer) => ({ ...resource, layer })), edges: [] },
            }],
            summary: { appHosts: empty ? 0 : 1, running: empty ? 0 : 1, resources: resources.length },
        } };
    }
    if (extension === "aspire-doctor") {
        return {
            ok: state !== "error", revision: 1,
            error: state === "error" ? "The preview diagnostics could not be loaded. Try again." : undefined,
            data: { checks: empty ? [] : [
                { name: "Aspire CLI", category: "aspire", status: "pass", message: "The CLI is available." },
                { name: long ? name : "Container runtime", category: "container", status: "warning", message: long ? detail : "The container runtime is not running.", fix: "Start your container runtime, then rerun Aspire Doctor." },
                { name: ".NET SDK", category: "sdk", status: "fail", message: "A required SDK is missing.", fix: "Install the required .NET SDK.", metadata: { path: long ? `C:\\${"sample-workspace\\".repeat(10)}dotnet.exe` : "C:\\Program Files\\dotnet\\dotnet.exe" } },
            ], installations: [] },
        };
    }
    const resources = empty ? [] : [
        { id: "api", serviceId: "api", name, type: ".NET project", include: true, detail, serviceDefaults: true },
        { id: "frontend", serviceId: "frontend", name: "frontend", type: "Vite", include: true, detail: "Browser application" },
        { id: "cache", name: "cache", type: "Redis", include: true, detail: "Shared cache" },
    ];
    return {
        revision: 1, appHostPath: "src\\Sample.AppHost\\AppHost.cs",
        apphostStyle: "csharp-sdk", discoveryLoaded: true, proposalLoaded: true,
        proposalStale: false, proposalError: state === "error" ? "The preview proposal could not be loaded. Try again." : "",
        proposalGeneration: 1, proposalHash: "preview1234567890",
        confirmed: state === "confirmed", confirmationDelivered: state === "confirmed",
        services: [
            { id: "api", name: "Public API", type: ".NET", framework: "ASP.NET Core", path: "src\\Api\\Api.csproj", exposesHttp: true },
            { id: "frontend", name: "Frontend", type: "Node.js", framework: "Vite", path: "src\\frontend", exposesHttp: true },
        ],
        proposal: {
            generatedAt: new Date().toISOString(), resources,
            edges: empty ? [] : [
                { id: "api-cache", from: name, to: "cache", kind: "reference" },
                { id: "frontend-api", from: "frontend", to: name, kind: "waitFor" },
            ],
        },
        validation: { issues: empty ? ["Include at least one resource."] : [], resourceIssues: {} },
        history: { canUndo: false, canRedo: false },
    };
}

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        for (const server of servers) {
            server.closeAllConnections();
            server.close();
        }
    });
}
