using Migration.Shared;

var builder = DistributedApplication.CreateBuilder(args);

var cache = builder.AddRedis("cache");

var api = builder.AddProject<Projects.CatalogApi>("api", launchProfileName: "http")
    .WithReference(cache)
    .WithEnvironment("MIGRATION_MARKER", FixtureContract.Marker)
    .WithHttpEndpoint(name: "public")
    .WithHttpHealthCheck("/", endpointName: "http")
    .WithExternalHttpEndpoints()
    .WithReplicas(2);

builder.AddProject<Projects.Migration_Worker>("worker", launchProfileName: null)
    .WithReference(api)
    .WaitFor(api)
    .WithArgs("--mode", "fixture")
    .WithEnvironment("MIGRATION_MARKER", FixtureContract.Marker)
    .WithHttpEndpoint(name: "status")
    .WithHttpHealthCheck("/", endpointName: "status");

builder.Build().Run();
