import { createBuilder } from "./.aspire/modules/aspire.mjs";

const builder = await createBuilder();

const cache = await builder.addRedis("cache");

const api = await builder
  .addProject("api", "../Migration.Api/Migration.Api.csproj")
  .withReference(cache)
  .withEnvironment("MIGRATION_MARKER", "project-v2-fixture")
  .withHttpHealthCheck({ path: "/", endpointName: "http" })
  .withExternalHttpEndpoints()
  .withReplicas(2);

await builder
  .addProject("worker", "../Migration.Worker/Migration.Worker.csproj")
  .withReference(api)
  .waitFor(api)
  .withEnvironment("MIGRATION_MARKER", "project-v2-fixture")
  .withHttpEndpoint({ name: "status" })
  .withHttpHealthCheck({ path: "/", endpointName: "status" });

await builder.build().run();
