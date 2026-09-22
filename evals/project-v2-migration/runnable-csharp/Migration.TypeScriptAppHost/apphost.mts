import { createBuilder, ContainerTargetPlatform } from "./.aspire/modules/aspire.mjs";

const builder = await createBuilder();
await builder.addDockerComposeEnvironment("compose");
const imagePrefix = process.env.MIGRATION_IMAGE_PREFIX ?? "project-v2-fixture";

const cache = await builder.addRedis("cache");

const api = await builder
  .addProject("api", "../Migration.Api/Migration.Api.csproj")
  .withReference(cache)
  .withEnvironment("MIGRATION_MARKER", "project-v2-fixture")
  .withHttpHealthCheck({ path: "/", endpointName: "http" })
  .withExternalHttpEndpoints()
  .withReplicas(2)
  .withContainerBuildOptions(async options => {
    await options.localImageName.set(`${imagePrefix}-api`);
    await options.localImageTag.set("validation");
    await options.targetPlatform.set(ContainerTargetPlatform.LinuxArm64);
  });

await builder
  .addProject("worker", "../Migration.Worker/Migration.Worker.csproj")
  .withReference(api)
  .waitFor(api)
  .withEnvironment("MIGRATION_MARKER", "project-v2-fixture")
  .withHttpEndpoint({ name: "status" })
  .withHttpHealthCheck({ path: "/", endpointName: "status" })
  .withContainerBuildOptions(async options => {
    await options.localImageName.set(`${imagePrefix}-worker`);
    await options.localImageTag.set("validation");
    await options.targetPlatform.set(ContainerTargetPlatform.LinuxArm64);
  });

await builder.build().run();
