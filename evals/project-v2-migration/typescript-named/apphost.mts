import { createBuilder, ContainerTargetPlatform } from "./.aspire/modules/aspire.mjs";

const builder = await createBuilder();
await builder.addDockerComposeEnvironment("compose");
const imagePrefix = process.env.MIGRATION_IMAGE_PREFIX ?? "project-v2-fixture";

const api = await builder.addProject("named-api", "../Migration.Api/Migration.Api.csproj", {
  launchProfileOrOptions: "http"
});

await api.withReplicas(2);
await api.withHttpHealthCheck({ path: "/", endpointName: "http" });
await api.withExternalHttpEndpoints();
await api.withContainerBuildOptions(async options => {
  await options.localImageName.set(`${imagePrefix}-named-api`);
  await options.localImageTag.set("validation");
  await options.targetPlatform.set(ContainerTargetPlatform.LinuxArm64);
});

await builder.build().run();
