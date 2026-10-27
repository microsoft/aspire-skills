using Migration.Shared;
using Aspire.Hosting.Publishing;

var builder = DistributedApplication.CreateBuilder(args);
builder.AddDockerComposeEnvironment("compose");
var imagePrefix = Environment.GetEnvironmentVariable("MIGRATION_IMAGE_PREFIX") ?? "project-v2-fixture";

var cache = builder.AddRedis("cache");

#pragma warning disable ASPIREPIPELINES003
var api = builder.AddProject<Projects.CatalogApi>("api", launchProfileName: "http")
    .WithReference(cache)
    .WithEnvironment("MIGRATION_MARKER", FixtureContract.Marker)
    .WithHttpEndpoint(name: "public")
    .WithHttpHealthCheck("/", endpointName: "http")
    .WithExternalHttpEndpoints()
    .WithReplicas(2)
    .WithContainerBuildOptions(options =>
    {
        options.LocalImageName = $"{imagePrefix}-api";
        options.LocalImageTag = "validation";
        options.TargetPlatform = ContainerTargetPlatform.LinuxArm64;
    });

builder.AddProject<Projects.Migration_Worker>("worker", launchProfileName: null)
    .WithReference(api)
    .WaitFor(api)
    .WithArgs("--mode", "fixture")
    .WithEnvironment("MIGRATION_MARKER", FixtureContract.Marker)
    .WithHttpEndpoint(name: "status")
    .WithHttpHealthCheck("/", endpointName: "status")
    .WithContainerBuildOptions(options =>
    {
        options.LocalImageName = $"{imagePrefix}-worker";
        options.LocalImageTag = "validation";
        options.TargetPlatform = ContainerTargetPlatform.LinuxArm64;
    });
#pragma warning restore ASPIREPIPELINES003

builder.Build().Run();
