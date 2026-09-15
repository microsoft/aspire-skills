using Migration.Shared;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/", () => new
{
    service = "api",
    marker = Environment.GetEnvironmentVariable("MIGRATION_MARKER"),
    shared = FixtureContract.Marker
});

app.Run();
