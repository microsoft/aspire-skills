import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { assertCredentialFreeHandoff } from "../../evals/grade-external-handoff.mjs";

const root = new URL("../../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8").replace(/\r\n/g, "\n");
const skill = read("skills/aspireify/SKILL.md");
const scan = read("skills/aspireify/references/scan-and-propose.md");
const wiring = read("skills/aspireify/references/apphost-wiring.md");
const modeling = wiring.split("## External dependency modeling\n")[1]?.split("\n## Endpoints and ports")[0];

test("credential handoff grader rejects leaks in captured tool arguments, including incomplete calls", () => {
    const { catalogToken } = JSON.parse(read("evals/external-dependencies-python/settings.json"));
    const trajectory = args => ({ trajectory: { events: [
        { type: "tool_call", data: { toolName: "invoke_canvas_action", arguments: args } },
    ] } });
    for (const args of [
        { input: { externalDependencies: [{ evidence: { credential: catalogToken } }] } },
        { input: { externalDependencyTreatments: [{ reason: catalogToken }] } },
        { input: JSON.stringify({ externalDependencies: [{ credential: catalogToken }] }) },
    ]) {
        assert.throws(() => assertCredentialFreeHandoff(trajectory(args), catalogToken), /leaked/);
    }
    assert.doesNotThrow(() => assertCredentialFreeHandoff(trajectory({
        input: { externalDependencies: [{ configurationKeys: ["catalogToken"], evidence: "settings.json" }] },
    }), catalogToken));
    assert.doesNotThrow(() => assertCredentialFreeHandoff({ trajectory: { events: [
        { type: "tool_result", data: { result: catalogToken } },
    ] } }, catalogToken));
    assert.throws(() => assertCredentialFreeHandoff({}, catalogToken), /Missing captured/);
    assert.throws(() => assertCredentialFreeHandoff(trajectory({}), ""), /Missing credential/);
    for (const args of [undefined, null, 42]) {
        assert.throws(() => assertCredentialFreeHandoff(trajectory(args), catalogToken), /Missing captured tool-call arguments/);
    }
});

test("hosts without a canvas confirm equivalent external accounting in chat", () => {
    for (const document of [skill, scan]) {
        const fallback = document.split("\n\n").find(paragraph => /canvas host is unavailable/.test(paragraph));
        assert.ok(fallback, "Missing canvas-unavailable fallback");
        for (const concept of [/inventory/, /mappings/, /treatments/, /reasons/, /unresolved/, /chat/, /explicit user confirmation/]) {
            assert.match(fallback, concept);
        }
    }
    assert.match(skill, /never invent a canvas approval/);
    assert.match(scan, /do not fabricate[\s\S]*`get_confirmation`/);
});

test("local runnable services retain service accounting, not external treatments", () => {
    const inventory = scan.split("### Significant dependency inventory\n")[1].split("\n### ")[0];
    for (const field of ["services", "serviceId", "serviceTreatments"]) {
        assert.ok(inventory.includes(`\`${field}\``), `Missing local service field: ${field}`);
    }
    assert.match(inventory, /only[\s\S]*separately operated or provider-managed/);
    assert.match(inventory, /not AppHost-launched local services/);
    assert.match(skill, /Local runnable services[\s\S]*not the external dependency inventory/);
});

test("validation inspects external resources without requiring default health waits", () => {
    const validation = read("skills/aspireify/references/validation.md");
    const flow = validation.split("## Flow\n")[1].split("\n## ")[0];
    assert.match(flow, /aspire describe --format Json --include-hidden/);
    assert.match(flow, /aspire wait[^\n]*per local runnable resource/);
    assert.match(flow, /external-service resources[\s\S]*exclude[\s\S]*default validation waits/);
    assert.match(flow, /explicit[\s\S]*user agreement/);
    const handoff = validation.split("## Hand-off Criteria\n")[1].split("\n## ")[0];
    assert.match(handoff, /every[\s\S]*local runnable resource/);
    assert.match(handoff, /explicitly agreed external readiness checks/);
    assert.doesNotMatch(validation, /every resource reaches a healthy state|All resources reached healthy state/);
});

test("the extension README points to an existing canvas payload heading", () => {
    const readme = read("extensions/aspireify/README.md");
    const anchor = readme.match(/scan-and-propose\.md#([a-z-]+)/)?.[1];
    assert.ok(anchor);
    const headings = [...scan.matchAll(/^#+ (.+)$/gm)].map(match => match[1].toLowerCase().replaceAll(" ", "-"));
    assert.ok(headings.includes(anchor), `Broken scan guidance anchor: ${anchor}`);
});

test("the skill inventories remote dependencies and requires canvas treatments before confirmation", () => {
    for (const concept of [/HTTPS/, /WebSocket/, /SDK-selected/, /configuration/, /lifecycle ownership/, /dynamic endpoint/]) {
        assert.match(skill, concept);
    }
    for (const field of ["externalDependencyId", "not-modeled", "deferred", "not-assessed", "load_discovery.externalDependencies", "set_proposal.externalDependencyTreatments"]) {
        assert.ok(skill.includes(field), `Missing canvas term: ${field}`);
    }
    const confirmation = skill.split("\n\n").find(paragraph => /confirmation/i.test(paragraph) && /`not-assessed`/.test(paragraph));
    assert.ok(confirmation, "Missing pre-confirmation dependency accounting");
    for (const concept of [/every significant/i, /scope/i, /behavior/i, /chat first/i, /unassessed rather than\s+approved/, /follow up in chat/]) {
        assert.match(confirmation, concept);
    }
    assert.match(skill, /external dependencies[\s\S]*distinct from runnable services/);
});

test("scan guidance records evidence and scope without turning inventory into runnable resources", () => {
    for (const concept of [/purpose/i, /consumer/i, /configuration key/i, /lifecycle ownership/i, /endpoint selection/i, /evidence/i, /uncertainty/i]) {
        assert.match(scan, concept);
    }
    assert.match(scan, /Never copy[\s\S]*secret values/);
    assert.match(scan, /Package presence[\s\S]*consumer/);
    assert.match(scan, /out-of-scope[\s\S]*`not-modeled`/);
    assert.match(scan, /Do not put external dependencies in runnable\s+`services`/);
});

test("scan guidance is one inventory, disposition and canvas payload flow", () => {
    const headings = [...scan.matchAll(/^#{2,3} (.+)$/gm)].map(match => match[1]);
    const order = [/dependency inventory/i, /disposition.*treatment/i, /canvas payload/i];
    const positions = order.map(heading => headings.findIndex(value => heading.test(value)));
    assert.ok(positions.every(position => position >= 0), `Missing flow headings: ${headings.join(", ")}`);
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
    assert.equal(positions[2] - positions[0], 2, "Keep the flow contiguous");
    const table = scan.split(`### ${headings[positions[1]]}\n`)[1].split("\n### ")[0];
    const rows = Object.fromEntries([...table.matchAll(/^\| \*\*(.+?)\*\* \| (.+?) \|/gm)].map(match => [match[1], match[2]]));
    assert.match(rows["Proposed resource"], /`externalDependencyId`/);
    assert.match(rows["Retained configuration/SDK ownership"], /`not-modeled`/);
    assert.match(rows["Outside the agreed scope"], /`not-modeled`/);
    assert.match(rows["Agreed deferred investigation"], /`deferred`[\s\S]*`unresolved`/);
    assert.match(table, /`not-assessed`[\s\S]*allows confirmation[\s\S]*unassessed, not approved/);
    assert.doesNotMatch(table, /must not remain at confirmation/);
    assert.match(scan, /confirms while items remain\s+`not-assessed`[\s\S]*carry them forward as\s+unassessed[\s\S]*follow up in chat/);

    for (const field of ["load_discovery.externalDependencies", "externalDependencyId", "set_proposal.externalDependencyTreatments", "get_confirmation.externalDependencies"]) {
        assert.ok(scan.includes(`\`${field}\``), `Missing canvas field: ${field}`);
    }
});

test("external modeling distinguishes configuration, descriptive resources and intentional wiring", () => {
    assert.ok(modeling, "Missing external modeling policy");
    assert.match(modeling, /Descriptive-only visibility/);
    assert.match(modeling, /retain[\s\S]*configuration and SDKs/);
    assert.match(modeling, /`AddParameter`[\s\S]*does not[\s\S]*service/);
    assert.match(wiring, /`WithReference`[\s\S]*not[\s\S]*SDK options/);
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
    for (const concept of [/credential providers/, /endpoint discovery/, /protected HTTP transports/, /retry/, /reconnect/, /failover/, /recovery/]) {
        assert.match(modeling, concept);
    }
    assert.match(modeling, /Do not invent[\s\S]*endpoint/);
    assert.match(modeling, /Do not add `WithHttpHealthCheck` to `ws:\/\/` or `wss:\/\/` URLs/);
    assert.match(modeling, /invent `\/health` paths/);
    assert.match(modeling, /separate HTTP client[\s\S]*SDK/);
    assert.match(modeling, /startup gates[\s\S]*off by default/);
    assert.match(modeling, /explicit agreement/);
    assert.match(modeling, /credential-free URLs/);
});

test("external wait exclusions preserve validation and ordering for local resources", () => {
    const validation = skill.split("### 4. Validate\n")[1]?.split("\n### ")[0];
    assert.ok(validation);
    assert.match(validation, /aspire wait <resource>[^\n]*each local[^\n]*project[^\n]*container/);
    assert.doesNotMatch(validation.split("```bash\n")[1].split("```")[0], /agreed readiness contract/);
    assert.match(validation, /Exclude external-service resources[\s\S]*explicit agreement/);

    const ordering = wiring.split("## Dependency ordering:")[1]?.split("\n## ")[0];
    assert.ok(ordering);
    assert.match(ordering, /Always pair `WithReference\(\)`[\s\S]*`WaitFor\(\)`[\s\S]*local infrastructure/);
    assert.match(ordering, /Local services[\s\S]*generally also wait/);
    assert.match(ordering, /External dependencies[\s\S]*not[\s\S]*startup gates by default/);
    assert.match(ordering, /\.WithReference\(db\)\s+\.WaitFor\(db\)/);
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
    assert.match(settings.catalogToken, /^SYNTHETIC_ONLY_NOT_A_CREDENTIAL_/);
    for (const name of ["aspireify-external-discovery-001", "aspireify-external-visibility-001"]) {
        const stimulus = evaluation.stimuli.find(entry => entry.name === name);
        assert.ok(stimulus.graders.some(grader => grader.type === "output-not-contains"
            && grader.config.substring === settings.catalogToken), `${name}: missing synthetic credential leak guard`);
        assert.ok(stimulus.graders.some(grader => grader.type === "program"
            && grader.config.args[0] === ".grader/grade-external-handoff.mjs"
            && grader.config.args[1] === settings.catalogToken), `${name}: missing captured tool-argument leak guard`);
        const handoff = stimulus.graders.find(grader => grader.name.startsWith("redacts-credentials-in-external-handoff"));
        assert.ok(handoff);
        assert.match(handoff.config.prompt, /canvas handoff/);
    }
    assert.match(discovery.prompt, /no canvas/);
    assert.ok(discovery.graders.some(grader => grader.name === "supports-chat-fallback-without-fabricated-approval"));
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
