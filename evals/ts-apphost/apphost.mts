import { createBuilder } from "./.aspire/modules/aspire.mjs";

const builder = await createBuilder();

const redis = builder.addRedis("cache");
const api = builder
  .addProject("apiservice", "../api")
  .withReference(redis);

builder
  .addProject("web", "../web")
  .withReference(api)
  .withExternalHttpEndpoints();

await builder.build().run();
