import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const section = (reference, heading) => {
  const start = reference.indexOf(heading);
  assert.notEqual(start, -1, `Missing ${heading}`);
  const end = reference.indexOf("\n#", start + heading.length);
  return reference.slice(start, end === -1 ? undefined : end);
};

const csharpBlocks = text => [...text.matchAll(/```csharp\n([\s\S]*?)\n```/g)].map(match => match[1]);

test("C# lifecycle hooks use the public eventing API", () => {
  const hooks = section(read("skills/aspireify/references/csharp-authoring.md"), "## Lifecycle Hooks");
  const code = csharpBlocks(hooks).join("\n");
  assert.ok(code, "Missing C# lifecycle hook example");

  // SubscribeBeforeStart/SubscribeAfterResourcesCreated are internal polyglot exports in
  // Aspire.Hosting, so C# AppHosts fail with CS1061. C# subscribes through builder.Eventing.
  assert.doesNotMatch(code, /builder\.Subscribe(BeforeStart|AfterResourcesCreated)\b/);
  assert.match(code, /builder\.Eventing\.Subscribe<BeforeStartEvent>\(/);
  assert.match(code, /builder\.Eventing\.Subscribe<AfterResourcesCreatedEvent>\(/);
});

test("C# endpoint examples do not assign a scheme string to EndpointAnnotation.Protocol", () => {
  const wiring = read("skills/aspireify/references/apphost-wiring.md");
  const code = csharpBlocks(wiring).join("\n");

  // EndpointAnnotation.Protocol is System.Net.Sockets.ProtocolType; a string fails with CS0029.
  // Application protocols are expressed with UriScheme and Transport.
  assert.doesNotMatch(code, /\.Protocol\s*=\s*"/);

  const grpc = /\.WithEndpoint\("grpc", endpoint =>\n\s*\{([\s\S]*?)\}\);/.exec(code)?.[1];
  assert.ok(grpc, "Missing gRPC WithEndpoint example");
  assert.match(grpc, /endpoint\.UriScheme = "http";/);
  assert.match(grpc, /endpoint\.Transport = "http2";/);
});
