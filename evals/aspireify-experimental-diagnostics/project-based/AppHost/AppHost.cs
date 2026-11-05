var builder = DistributedApplication.CreateBuilder(args);

builder.AddContainer("echo", "hashicorp/http-echo")
    .WithHttpEndpoint(targetPort: 5678)
    .WithHttpProbe(ProbeType.Liveness, "/");

builder.Build().Run();
