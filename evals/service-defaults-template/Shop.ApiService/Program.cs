var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();

var app = builder.Build();

app.MapGet("/", () => "API service is running.");
app.MapDefaultEndpoints();

app.Run();
