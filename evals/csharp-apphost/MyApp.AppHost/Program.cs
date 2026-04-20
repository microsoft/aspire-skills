var builder = DistributedApplication.CreateBuilder(args);

var redis = builder.AddRedis("cache");
var postgres = builder.AddPostgres("db").AddDatabase("catalogdb");

var apiService = builder.AddProject<Projects.MyApp_ApiService>("apiservice")
    .WithReference(redis)
    .WithReference(postgres);

builder.AddProject<Projects.MyApp_Web>("webfrontend")
    .WithExternalHttpEndpoints()
    .WithReference(apiService);

builder.Build().Run();
