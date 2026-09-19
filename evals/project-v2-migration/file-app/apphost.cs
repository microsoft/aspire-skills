#:sdk Aspire.AppHost.Sdk@13.6.0-dev
#:package Aspire.Hosting.AppHost@13.6.0-dev
#:package Aspire.Hosting.Docker@13.6.0-dev
#:property AspireUseCliBundle=true

using Aspire.Hosting.Publishing;

var builder = DistributedApplication.CreateBuilder(args);
builder.AddDockerComposeEnvironment("compose");

var imagePrefix = Environment.GetEnvironmentVariable("MIGRATION_IMAGE_PREFIX")
    ?? "project-v2-fixture";
var imageArchive = Environment.GetEnvironmentVariable("MIGRATION_IMAGE_ARCHIVE");

#pragma warning disable ASPIRECSHARPAPPS001
var fileApi = builder.AddCSharpApp("file-api", "file-api.cs")
    .WithEnvironment("RUNTIME_ONLY", "preserve-me")
    .WithHttpEndpoint(name: "http")
    .WithHttpHealthCheck("/health", endpointName: "http")
    .WithExternalHttpEndpoints();
#pragma warning restore ASPIRECSHARPAPPS001

#pragma warning disable ASPIREPIPELINES003
fileApi.WithContainerBuildOptions(options =>
{
    options.LocalImageName = $"{imagePrefix}-file-api";
    options.LocalImageTag = "validation";
    options.TargetPlatform = ContainerTargetPlatform.LinuxArm64;
    if (!string.IsNullOrWhiteSpace(imageArchive))
    {
        options.Destination = ContainerImageDestination.Archive;
        options.OutputPath = imageArchive;
        options.ImageFormat = ContainerImageFormat.Docker;
    }
});
#pragma warning restore ASPIREPIPELINES003

builder.Build().Run();
