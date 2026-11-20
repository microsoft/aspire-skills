import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const root = new URL("../../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8").replace(/\r\n/g, "\n");
const skill = read("skills/aspireify/SKILL.md");
const scan = read("skills/aspireify/references/scan-and-propose.md");
const wiring = read("skills/aspireify/references/apphost-wiring.md");
const modeling = wiring.split("## External dependency modeling\n")[1]?.split("\n## Endpoints and ports")[0];

test("the skill inventories remote dependencies and requires canvas treatments before confirmation", () => {
    assert.match(skill, /HTTPS APIs, WebSocket streams, SDK-selected endpoints/);
    assert.match(skill, /purpose, configuration key\/source \(no secret values\), lifecycle ownership/);
    assert.match(skill, /explicit versus dynamic endpoint selection/);
    assert.match(skill, /Before confirmation,[\s\S]*every significant discovered dependency/);
    for (const disposition of ["proposed resource", "retained configuration/SDK", "outside the agreed scope", "agreed deferred investigation"]) {
        assert.ok(skill.includes(disposition), `Missing disposition: ${disposition}`);
    }
    for (const field of ["externalDependencyId", "not-modeled", "deferred", "not-assessed", "load_discovery.externalDependencies", "set_proposal.externalDependencyTreatments"]) {
        assert.ok(skill.includes(field), `Missing canvas term: ${field}`);
    }
    assert.match(skill, /Resolve material scope and behavior[\s\S]*questions in chat first/);
    assert.match(skill, /Keep external dependencies\s+distinct from runnable services/);
});

test("scan guidance records evidence and scope without turning inventory into runnable resources", () => {
    assert.match(scan, /Purpose and consumers/);
    assert.match(scan, /Configuration key\/source/);
    assert.match(scan, /Lifecycle ownership/);
    assert.match(scan, /Endpoint selection/);
    assert.match(scan, /Evidence and uncertainty/);
    assert.match(scan, /Never copy[\s\S]*secret values/);
    assert.match(scan, /Package presence alone[\s\S]*does not prove an active dependency/);
    assert.match(scan, /local-process-only AppHost can be correct/);
    assert.match(scan, /every significant discovered dependency needs a mapping or a\s+treatment/);
    assert.match(scan, /out-of-scope dependencies are\s+`not-modeled`, never left `not-assessed`/);
    assert.match(scan, /Do not put external dependencies in runnable\s+`services`/);
});

test("scan guidance is one inventory, disposition and canvas payload flow", () => {
    const headings = [...scan.matchAll(/^#{2,3} (.+)$/gm)].map(match => match[1]);
    const order = ["Significant dependency inventory", "Choose a disposition and canvas treatment", "Send the canvas payload"];
    const positions = order.map(heading => headings.indexOf(heading));
    assert.ok(positions.every(position => position >= 0), `Missing flow headings: ${headings.join(", ")}`);
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
    assert.equal(positions[2] - positions[0], 2, "Keep the flow contiguous");
    assert.ok(!headings.includes("External inventory handoff"), "Merge the handoff into the flow");

    const table = scan.split("### Choose a disposition and canvas treatment\n")[1].split("\n### ")[0];
    const rows = Object.fromEntries([...table.matchAll(/^\| \*\*(.+?)\*\* \| (.+?) \|/gm)].map(match => [match[1], match[2]]));
    assert.match(rows["Proposed resource"], /`externalDependencyId`/);
    assert.match(rows["Retained configuration/SDK ownership"], /`not-modeled`/);
    assert.match(rows["Outside the agreed scope"], /`not-modeled`/);
    assert.match(rows["Agreed deferred investigation"], /`deferred`[\s\S]*`unresolved`/);
    assert.match(table, /`not-assessed`[\s\S]*must not remain at confirmation/);

    for (const field of ["load_discovery.externalDependencies", "externalDependencyId", "set_proposal.externalDependencyTreatments", "get_confirmation.externalDependencies"]) {
        assert.ok(scan.includes(`\`${field}\``), `Missing canvas field: ${field}`);
    }
    assert.doesNotMatch(scan, /Use only fields\s+supported by the current canvas action schemas/);
});

test("external modeling distinguishes configuration, descriptive resources and intentional wiring", () => {
    assert.ok(modeling, "Missing external modeling policy");
    assert.match(modeling, /Descriptive-only visibility/);
    assert.match(modeling, /Consumers may retain their existing configuration and SDKs/);
    assert.match(modeling, /`AddParameter` can hold an endpoint value; it does not describe the service itself/);
    assert.match(wiring, /`WithReference` does not automatically configure arbitrary SDK options/);
    const blocks = [...modeling.matchAll(/```csharp\n([\s\S]*?)```/g)].map(match => match[1]);
    assert.equal(blocks.length, 3, "Keep distinct configuration-only, descriptive-only and deliberate wiring examples");
    assert.match(blocks[0], /\.WithEnvironment\("Catalog__BaseUrl", catalogUrl\)/);
    assert.doesNotMatch(blocks[0], /AddExternalService/);
    assert.match(blocks[1], /builder\.AddExternalService\("catalog", catalogUrl\)/);
    assert.doesNotMatch(blocks[1], /\.WithReference|\.WithEnvironment|\.WaitFor|\.WithHttpHealthCheck/);
    assert.match(blocks[2], /\.WithEnvironment\("Catalog__BaseUrl", catalog\)/);
    assert.doesNotMatch(blocks.join("\n"), /\.WithReference|\.WaitFor|\.WithHttpHealthCheck/);
});

test("external guidance preserves SDK behavior and avoids unsafe default diagnostics and gates", () => {
    assert.match(modeling, /credential providers, endpoint discovery/);
    assert.match(modeling, /protected HTTP transports[\s\S]*retry policies,[\s\S]*stream reconnect\/resubscription, failover and recovery/);
    assert.match(modeling, /Do not invent a representative endpoint/);
    assert.match(modeling, /Do not add `WithHttpHealthCheck` to `ws:\/\/` or `wss:\/\/` URLs/);
    assert.match(modeling, /invent `\/health` paths/);
    assert.match(modeling, /separate HTTP client, not the SDK's protected[\s\S]*transport or auth pipeline/);
    assert.match(modeling, /startup gates are \*\*off by default\*\*/);
    assert.match(modeling, /explicit agreement/);
    assert.doesNotMatch(wiring, /Always pair `WithReference\(\)` with `WaitFor\(\)`/);
    assert.match(modeling, /making a parameter secret does not make a rendered URL safe/);
    assert.match(modeling, /e3008dc09c8aa26b666c6557165178c4a0bb9b5e/);
});

test("external modeling evals use generic read-only source evidence and focused graders", () => {
    const specUrl = new URL("skills/aspireify/evals/eval.yaml", root);
    const evaluation = parse(readFileSync(specUrl, "utf8"));
    for (const name of ["aspireify-external-discovery-001", "aspireify-external-visibility-001"]) {
        const stimulus = evaluation.stimuli.find(entry => entry.name === name);
        assert.ok(stimulus, `Missing ${name}`);
        assert.ok(stimulus.rubric.length >= 3);
        for (const type of ["prompt", "diff-empty", "skill-invocation"]) {
            assert.ok(stimulus.graders.some(grader => grader.type === type), `${name}: missing ${type}`);
        }
        assert.ok(stimulus.graders.filter(grader => grader.type === "prompt").length >= 3);
        for (const fixture of stimulus.environment.files) {
            assert.ok(existsSync(resolve(dirname(fileURLToPath(specUrl)), fixture.src)));
        }
        const pythonFixture = stimulus.environment.files.find(fixture => fixture.dest === "app/worker");
        assert.equal(pythonFixture.src, "../../../evals/external-dependencies-python");
    }
    const names = evaluation.stimuli.map(entry => entry.name);
    assert.equal(new Set(names).size, names.length, "Eval stimulus names must be unique");
    const discovery = evaluation.stimuli.find(entry => entry.name === "aspireify-external-discovery-001");
    assert.match(discovery.prompt, /outside the agreed scope/);
    assert.ok(discovery.rubric.some(item => /out-of-scope[\s\S]*not-modeled/.test(item)));
    const settings = JSON.parse(read("evals/external-dependencies-python/settings.json"));
    for (const key of ["catalogBaseUrl", "streamUrl"]) {
        const url = new URL(settings[key]);
        assert.ok(url.hostname.endsWith(".example.invalid"));
        assert.equal(url.username + url.password + url.search + url.hash, "");
    }
    assert.equal(new URL(settings.streamUrl).protocol, "wss:");
    const worker = read("evals/external-dependencies-python/worker.py");
    for (const evidence of [
        "catalogBaseUrl", "streamUrl", "storageRegion", "CATALOG_TOKEN", "STREAM_TOKEN",
        "PROVIDER_CA_BUNDLE", "reconnect=5", '"mode": "adaptive"', "boto3.client(",
    ]) {
        assert.ok(worker.includes(evidence), `Missing fixture evidence: ${evidence}`);
    }
    assert.doesNotMatch(worker, /endpoint_url\s*=|\/health/);
});
