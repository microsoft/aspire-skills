import { AppHost } from "@aspire/apphost";

const app = new AppHost("myapp");

const redis = app.addRedis("cache");
const api = app.addProject("apiservice", "../api")
  .withReference(redis);

app.addProject("web", "../web")
  .withReference(api)
  .withExternalHttpEndpoints();

app.build();
