using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Publishing;
using Migration.Shared;

var builder = DistributedApplication.CreateBuilder(args);
builder.AddDockerComposeEnvironment("compose");
var imagePrefix = Environment.GetEnvironmentVariable("MIGRATION_IMAGE_PREFIX") ?? "project-v2-fixture";

#pragma warning disable ASPIREPIPELINES003
builder.AddProject<Projects.CatalogApi>("dockerfile-api", launchProfileName: null)
    .WithEnvironment("MIGRATION_MARKER", FixtureContract.Marker)
    .WithHttpEndpoint(targetPort: builder.ExecutionContext.IsPublishMode ? 8080 : null, name: "http")
    .WithHttpHealthCheck("/", endpointName: "http")
    .WithExternalHttpEndpoints()
    .PublishAsDockerFile(container => container
        .WithDockerfile("..", "Migration.Api/Dockerfile.custom")
        .WithImage($"{imagePrefix}-dockerfile-api", "validation")
        .WithContainerBuildOptions(options =>
        {
            options.TargetPlatform = ContainerTargetPlatform.LinuxArm64;
        }));
#pragma warning restore ASPIREPIPELINES003

var prebuilt = builder.AddProject<Projects.CatalogApi>("prebuilt-api", launchProfileName: null)
    .WithEnvironment("MIGRATION_MARKER", FixtureContract.Marker)
    .WithHttpEndpoint(targetPort: builder.ExecutionContext.IsPublishMode ? 8080 : null, name: "http")
    .WithHttpHealthCheck("/", endpointName: "http")
    .WithExternalHttpEndpoints();

if (builder.ExecutionContext.IsPublishMode)
{
    prebuilt.WithAnnotation(new ContainerImageAnnotation
    {
        Registry = "localhost",
        Image = $"{imagePrefix}-dockerfile-api",
        Tag = "validation"
    }, ResourceAnnotationMutationBehavior.Replace);
}

builder.Build().Run();
