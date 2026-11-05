import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const authoring = readFileSync(
    new URL("../skills/aspireify/references/typescript-authoring.md", import.meta.url),
    "utf8",
).replace(/\r\n/g, "\n");

function yarpExample() {
    const section = /## YARP Routing\n([\s\S]*?)\n## /.exec(authoring)?.[1];
    assert.ok(section, "typescript-authoring.md must keep its YARP Routing section");
    const block = /```ts\n([\s\S]*?)```/.exec(section)?.[1];
    assert.ok(block, "YARP Routing must include a TypeScript example");
    return block;
}

// Generated SDK (13.6): addRoute/addCatchAllRoute exist only on YarpConfigurationBuilder,
// reached through YarpResource.withConfiguration(async (builder) => ...).
test("TypeScript YARP example adds routes inside withConfiguration", () => {
    const code = yarpExample();
    assert.match(code, /\.withConfiguration\(async \((\w+)\) => \{/);
    const configured = /\.withConfiguration\(async \((\w+)\) => \{([\s\S]*?)\n\s*\}\);/.exec(code);
    assert.ok(configured, "withConfiguration must wrap the route calls");
    const [, name, body] = configured;
    assert.match(body, new RegExp(`await ${name}\\.addRoute\\('/api/\\{\\*\\*catch-all\\}'`));
    assert.match(body, new RegExp(`await ${name}\\.addCatchAllRoute\\(`));
});

test("TypeScript YARP example never chains route methods on the YARP resource", () => {
    assert.doesNotMatch(yarpExample(), /addYarp\([^)]*\)\s*\n\s*\.add(?:CatchAll)?Route\(/);
});

test("TypeScript YARP example declares every resource it routes to", () => {
    const code = yarpExample();
    for (const target of code.matchAll(/(\w+)\.getEndpoint\(/g)) {
        assert.match(code, new RegExp(`const ${target[1]} = `), `${target[1]} must be declared`);
    }
});
