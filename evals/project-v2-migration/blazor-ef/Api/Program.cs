using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

var builder = WebApplication.CreateBuilder(args);

builder.AddNpgsqlDbContext<ProbeDbContext>(
    "db",
    configureDbContextOptions: options =>
        options.UseNpgsql(postgres =>
            postgres.MigrationsAssembly(typeof(ProbeDbContext).Assembly.GetName().Name)));

var app = builder.Build();

app.MapGet("/", () => "project-v2 Blazor/EF API fixture");
app.MapGet("/health", () => Results.Text("healthy", "text/plain"));
app.MapGet("/probe", async (ProbeDbContext dbContext, CancellationToken cancellationToken) =>
{
    var marker = await dbContext.ProbeMarkers
        .AsNoTracking()
        .SingleAsync(marker => marker.Id == 1, cancellationToken);
    var runtimeValue = Environment.GetEnvironmentVariable("CUSTOM_BUILD_INPUT")
        ?? "<missing>";

    return Results.Text(
        $"blazor-ef|migration={marker.Value}|runtime={runtimeValue}",
        "text/plain");
});

app.Run();

public sealed class ProbeDbContextFactory : IDesignTimeDbContextFactory<ProbeDbContext>
{
    public ProbeDbContext CreateDbContext(string[] args)
    {
        var connectionString = Environment.GetEnvironmentVariable("ConnectionStrings__db")
            ?? "Host=localhost;Port=5432;Database=db;Username=postgres";
        var options = new DbContextOptionsBuilder<ProbeDbContext>()
            .UseNpgsql(
                connectionString,
                postgres =>
                    postgres.MigrationsAssembly(typeof(ProbeDbContext).Assembly.GetName().Name))
            .Options;

        return new ProbeDbContext(options);
    }
}
