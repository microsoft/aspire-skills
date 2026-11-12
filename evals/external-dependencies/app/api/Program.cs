using Stripe;

var builder = WebApplication.CreateBuilder(args);

// The Stripe SDK selects its own endpoint; the app only supplies a key.
builder.Services.AddSingleton<IStripeClient>(
    new StripeClient(builder.Configuration["Stripe:ApiKey"]));

builder.Services.AddHttpClient("weather", client =>
    client.BaseAddress = new Uri(builder.Configuration["Weather:BaseUrl"]!));

var app = builder.Build();

app.MapGet("/forecast/{city}", async (string city, IHttpClientFactory factory) =>
    await factory.CreateClient("weather").GetStringAsync($"v1/forecast?city={city}"));

app.MapPost("/checkout", async (IStripeClient stripe) =>
{
    var service = new PaymentIntentService(stripe);
    var intent = await service.CreateAsync(new PaymentIntentCreateOptions { Amount = 1000, Currency = "usd" });
    return Results.Ok(new { intent.ClientSecret });
});

app.Run();
