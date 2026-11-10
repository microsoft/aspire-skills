import { createBuilder } from "./.aspire/modules/aspire.mjs";

const builder = await createBuilder();
await builder.build().run();
