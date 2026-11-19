using System.Net.WebSockets;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddHostedService<QuoteListener>();
builder.Build().Run();

sealed class QuoteListener(IConfiguration configuration, ILogger<QuoteListener> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var socket = new ClientWebSocket();
        await socket.ConnectAsync(new Uri(configuration["Quotes:StreamUrl"]!), stoppingToken);
        var buffer = new byte[4096];
        while (!stoppingToken.IsCancellationRequested)
        {
            var result = await socket.ReceiveAsync(buffer, stoppingToken);
            logger.LogInformation("Received {Count} quote bytes", result.Count);
        }
    }
}
