import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const otel = readFileSync(
    new URL("../skills/aspireify/references/opentelemetry.md", import.meta.url),
    "utf8",
).replace(/\r\n/g, "\n");

function nodeSection() {
    const section = /## Node\.js\/TypeScript services\n([\s\S]*?)\n## /.exec(otel)?.[1];
    assert.ok(section, "opentelemetry.md must keep its Node.js/TypeScript services section");
    return section;
}

function installedPackages(section) {
    const install = /^npm install (.+)$/m.exec(section)?.[1];
    assert.ok(install, "Node.js section must show an npm install command");
    return install.split(/\s+/);
}

function instrumentationSnippet(section) {
    const snippet = /```typescript\n([\s\S]*?)```/.exec(section)?.[1];
    assert.ok(snippet, "Node.js section must show an instrumentation snippet");
    return snippet;
}

// @opentelemetry/exporter-otlp-grpc is deprecated and stuck at 0.26.0. Its exporters fail tsc
// against current @opentelemetry/sdk-node (TS2322/TS2741) and export no telemetry to the dashboard.
test("Node.js OTel guidance uses the signal-specific OTLP gRPC exporters", () => {
    const section = nodeSection();
    const packages = installedPackages(section);
    assert.ok(!packages.includes("@opentelemetry/exporter-otlp-grpc"), "must not install the deprecated combined exporter");
    assert.doesNotMatch(instrumentationSnippet(section), /from '@opentelemetry\/exporter-otlp-grpc'/);
    assert.ok(packages.includes("@opentelemetry/exporter-trace-otlp-grpc"));
    assert.ok(packages.includes("@opentelemetry/exporter-metrics-otlp-grpc"));
});

test("Node.js OTel install command covers every package the snippet imports", () => {
    const section = nodeSection();
    const packages = new Set(installedPackages(section));
    const imports = [...instrumentationSnippet(section).matchAll(/from '(@opentelemetry\/[^']+)'/g)].map((m) => m[1]);
    assert.ok(imports.length > 0);
    for (const name of imports) {
        assert.ok(packages.has(name), `${name} is imported but not in the npm install command`);
    }
});

// @opentelemetry/sdk-node 0.300.0 removed NodeSDKConfiguration.metricReader (TS2561).
test("Node.js OTel snippet passes metric readers as metricReaders", () => {
    const snippet = instrumentationSnippet(nodeSection());
    assert.match(snippet, /metricReaders: \[/);
    assert.doesNotMatch(snippet, /metricReader:/);
});
