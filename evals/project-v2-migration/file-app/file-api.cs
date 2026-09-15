#:sdk Microsoft.NET.Sdk.Web
#:property PublishAot=true

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/", () => Environment.GetEnvironmentVariable("RUNTIME_ONLY"));
app.Run();
