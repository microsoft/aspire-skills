import { createBuilder } from "./.aspire/modules/aspire.mjs";

const builder = await createBuilder();

const defaultProfile = await builder.addProject("default-api", "../Api/Api.csproj");
const namedProfile = await builder.addProject("named-api", "../Api/Api.csproj", {
  launchProfileOrOptions: "http"
});

namedProfile.withReference(defaultProfile);

await builder.build().run();
