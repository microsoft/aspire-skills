using Migration.Shared;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/", () => new
{
    service = "worker",
    marker = Environment.GetEnvironmentVariable("MIGRATION_MARKER"),
    shared = FixtureContract.Marker,
    arguments = args,
    profile = Environment.GetEnvironmentVariable("PROFILE_MARKER"),
    environment = app.Environment.EnvironmentName,
    api = ResolveApiUrl()
});

app.MapGet("/probe", async () =>
{
    var apiUrl = ResolveApiUrl()
        ?? throw new InvalidOperationException("Aspire did not inject an API endpoint.");
    using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
    var apiResponse = await client.GetStringAsync(apiUrl);
    return Results.Ok(new { apiUrl, apiResponse });
});

app.Run();

static string? ResolveApiUrl() =>
    Environment.GetEnvironmentVariable("services__api__public__0")
    ?? Environment.GetEnvironmentVariable("services__api__http__0")
    ?? Environment.GetEnvironmentVariable("services__api__https__0");
