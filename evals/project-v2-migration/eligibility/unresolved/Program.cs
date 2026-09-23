var builder = DistributedApplication.CreateBuilder(args);
builder.AddProject<Projects.Service>("service");
builder.Build().Run();
