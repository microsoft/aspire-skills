import { createBuilder } from "@aspire/hosting";

const builder = await createBuilder();
await builder.build().run();
