#:sdk Aspire.AppHost.Sdk@13.6.0-dev
#:package Aspire.Hosting.AppHost@13.6.0-dev
#:property AspireUseCliBundle=true

var builder = DistributedApplication.CreateBuilder(args);

#pragma warning disable ASPIRECSHARPAPPS001
builder.AddCSharpApp("file-api", "file-api.cs")
    .WithEnvironment("RUNTIME_ONLY", "preserve-me");
#pragma warning restore ASPIRECSHARPAPPS001

builder.Build().Run();
