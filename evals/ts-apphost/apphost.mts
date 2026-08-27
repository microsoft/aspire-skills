import { createBuilder } from "./.aspire/modules/aspire.mjs";

const builder = await createBuilder();

const redis = await builder.addRedis("cache");
const api = await builder
  .addProject("apiservice", "../api")
  .withReference(redis);

await builder
  .addProject("web", "../web")
  .withReference(api)
  .withExternalHttpEndpoints();

await builder.build().run();
