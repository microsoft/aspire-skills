using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Docker.Resources.ComposeNodes;
using Aspire.Hosting.Docker.Resources.ServiceNodes;
using Aspire.Hosting.Publishing;

var builder = DistributedApplication.CreateBuilder(args);
builder.AddDockerComposeEnvironment("compose");

var imagePrefix = Environment.GetEnvironmentVariable("MIGRATION_IMAGE_PREFIX")
    ?? "project-v2-fixture";
const string targetRuntime = "linux-arm64";

var postgres = builder.AddPostgres("postgres")
    .PublishAsDockerComposeService((_, service) =>
    {
        service.Healthcheck = new Healthcheck
        {
            Test = ["CMD-SHELL", "pg_isready -U postgres"],
            Interval = "2s",
            Timeout = "5s",
            Retries = 30,
            StartPeriod = "5s"
        };
    });
var db = postgres.AddDatabase("db");

var api = builder.AddProject<Projects.Api>("api")
    .WithReference(db)
    .WithEnvironment("CUSTOM_BUILD_INPUT", "runtime-value")
    .WithHttpEndpoint(name: "http")
    .WithHttpHealthCheck("/health", endpointName: "http")
    .WithExternalHttpEndpoints();

#pragma warning disable ASPIREPIPELINES003
api.WithContainerBuildOptions(options =>
{
    options.LocalImageName = $"{imagePrefix}-api";
    options.LocalImageTag = "validation";
    options.TargetPlatform = ContainerTargetPlatform.LinuxArm64;
});
#pragma warning restore ASPIREPIPELINES003

var migrations = api.AddEFMigrations("api-migrations")
    .WithMigrationsProject<Projects.Migrations>()
    .WithReference(db)
    .WaitFor(db)
    .RunDatabaseUpdateOnStart()
    .PublishAsMigrationScript()
    .PublishAsMigrationBundle(
        targetRuntime: targetRuntime,
        publishContainer: true,
        baseImage: "mcr.microsoft.com/dotnet/aspnet:10.0");

#pragma warning disable ASPIREPIPELINES003
migrations.WithContainerBuildOptions(options =>
{
    options.LocalImageName = $"{imagePrefix}-blazor-migrations";
    options.LocalImageTag = "validation";
    options.TargetPlatform = ContainerTargetPlatform.LinuxArm64;
});
#pragma warning restore ASPIREPIPELINES003

migrations.PublishAsDockerComposeService((_, service) =>
{
    service.DependsOn["postgres"] = new ServiceDependency
    {
        Condition = "service_healthy"
    };
    service.Restart = "no";
});

api.WaitForCompletion(migrations);

#pragma warning disable ASPIREBLAZOR001
var client = builder.AddBlazorWasmProject<Projects.Client>("client")
    .WithReference(api);

var gateway = builder.AddBlazorGateway("gateway")
    .WithBlazorClientApp(client, apiPrefix: "backend", otlpPrefix: "telemetry",
        proxyTelemetry: true)
    .WaitFor(api)
    .WithExternalHttpEndpoints();
#pragma warning restore ASPIREBLAZOR001

#pragma warning disable ASPIREPIPELINES003
gateway.WithContainerBuildOptions(options =>
{
    options.LocalImageName = $"{imagePrefix}-gateway";
    options.LocalImageTag = "validation";
    options.TargetPlatform = ContainerTargetPlatform.LinuxArm64;
});
#pragma warning restore ASPIREPIPELINES003

if (builder.ExecutionContext.IsPublishMode)
{
    var httpEndpoint = gateway.Resource.Annotations
        .OfType<EndpointAnnotation>()
        .Single(endpoint => endpoint.Name == "http");
    httpEndpoint.TargetPort = 8080;

    var httpsEndpoint = gateway.Resource.Annotations
        .OfType<EndpointAnnotation>()
        .Single(endpoint => endpoint.Name == "https");
    gateway.Resource.Annotations.Remove(httpsEndpoint);

    migrations.WithImage($"{imagePrefix}-blazor-migrations", "validation");

#pragma warning disable ASPIREPIPELINES003
    var gatewayBuild = gateway.Resource.Annotations
        .OfType<DockerfileBuildAnnotation>()
        .SingleOrDefault();
    if (gatewayBuild is not null)
    {
        gatewayBuild.ImageName = $"{imagePrefix}-gateway";
        gatewayBuild.ImageTag = "validation";
    }
#pragma warning restore ASPIREPIPELINES003

    var clientPublish = builder.Resources
        .OfType<ContainerResource>()
        .Single(resource => resource.Name == "clientpublish");

#pragma warning disable ASPIREPIPELINES003
    var clientPublishBuild = clientPublish.Annotations
        .OfType<DockerfileBuildAnnotation>()
        .Single();
    clientPublishBuild.ImageName = $"localhost/{imagePrefix}-blazor-clientpublish";
    clientPublishBuild.ImageTag = "validation";
    clientPublishBuild.HasEntrypoint = false;

    var clientPublishBuilder = builder.CreateResourceBuilder(clientPublish);
    clientPublishBuilder.WithContainerBuildOptions(options =>
    {
        options.TargetPlatform = ContainerTargetPlatform.LinuxArm64;
    });
#pragma warning restore ASPIREPIPELINES003
}

builder.Build().Run();
