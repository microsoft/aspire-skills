import { createBuilder } from "./.aspire/modules/aspire.mjs";

const builder = await createBuilder();

const api = await builder.addProject("named-api", "../Api/Api.csproj", {
  launchProfileOrOptions: "http"
});

await api.withReplicas(2);

await builder.build().run();
