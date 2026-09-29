using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Microsoft.Extensions.DependencyInjection;

var builder = DistributedApplication.CreateBuilder(args);
var toolPath = Path.GetFullPath(Path.Combine(builder.AppHostDirectory, "../Tool/bin/Debug/net10.0/Tool.dll"));
var resource = builder.AddExecutable("worker", "dotnet", builder.AppHostDirectory, toolPath);

builder.Build().Run();
