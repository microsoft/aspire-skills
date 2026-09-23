#:sdk Microsoft.NET.Sdk.Web
#:property PublishAot=true

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/", () => "project-v2 file-app fixture");
app.MapGet("/health", () => Results.Text("healthy", "text/plain"));
app.MapGet("/probe", () =>
    Results.Text(
        $"file-api|runtime={Environment.GetEnvironmentVariable("RUNTIME_ONLY") ?? "<missing>"}",
        "text/plain"));

app.Run();
