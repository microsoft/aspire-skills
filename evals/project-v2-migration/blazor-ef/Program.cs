var builder = DistributedApplication.CreateBuilder(args);

var db = builder.AddPostgres("db");
var api = builder.AddProject<Projects.Api>("api")
    .WithReference(db)
    .WithEnvironment("CUSTOM_BUILD_INPUT", "runtime-value");

api.AddEFMigrations("api-migrations")
    .WithMigrationsProject<Projects.Migrations>();

#pragma warning disable ASPIREBLAZOR001
var client = builder.AddBlazorWasmProject<Projects.Client>("client")
    .WithReference(api);

builder.AddBlazorGateway("gateway")
    .WithBlazorClientApp(client, apiPrefix: "backend", otlpPrefix: "telemetry",
        proxyTelemetry: true);
#pragma warning restore ASPIREBLAZOR001

builder.Build().Run();
