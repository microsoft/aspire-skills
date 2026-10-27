var builder = DistributedApplication.CreateBuilder(args);

var functions = builder.AddAzureFunctionsProject<Projects.Functions>("functions");
var fsharp = builder.AddProject<Projects.FSharpService>("fsharp");
var direct = builder.AddResource(new ProjectResource("direct"));
var custom = builder.AddProject<Projects.CustomPublisher>("custom")
    .PublishAsCustomImage();
var existing = builder.AddDotnetProject("already-migrated", "../Existing/Existing.csproj");

UseConcreteProjectResource(custom);

builder.Build().Run();

static void UseConcreteProjectResource(IResourceBuilder<ProjectResource> resource)
{
}
