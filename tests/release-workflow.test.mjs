import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { job, script, step, steps } from "./helpers/workflow-source.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readWorkflow = name => readFileSync(join(repoRoot, ".github", "workflows", name), "utf8").replaceAll("\r\n", "\n");
const preparation = readWorkflow("release-aspire-skills.yml");
const testWorkflow = readWorkflow("test.yml");
const bashOnly = { skip: process.platform === "win32" ? "Release workflow Bash is exercised on Linux." : false };

function bash(source, env = {}, mock = "") {
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", mock + "\n" + source], {
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: process.env.PATH, ...env }
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function assertSuccess(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

const prepare = job(preparation, "prepare");
const publish = job(preparation, "publish");
const matrix = job(testWorkflow, "test");
const headers = section => section.split("    steps:\n")[0];
const authorization = script(prepare, "Check release permissions");
const publication = script(publish, "Push release branch and open draft PR");
const resolve = script(prepare, "Resolve source and base once");
const receive = script(publish, "Receive and verify without executing candidate code");

test("the obsolete tar release-assets publisher is absent", () => {
  assert.equal(existsSync(join(repoRoot, ".github", "workflows", "publish.yml")), false);
  for (const workflow of [preparation, testWorkflow]) {
    assert.doesNotMatch(workflow, /\bgh release\b|npm run bundle\b|actions\/attest-build-provenance/);
  }
});

test("release preparation is manual and both jobs are restricted to trusted main", () => {
  const triggers = preparation.split("\npermissions:\n")[0];
  assert.match(triggers, /^name: Release Aspire Skills$/m);
  assert.match(triggers, /^  workflow_dispatch:$/m);
  assert.doesNotMatch(triggers, /^  (?:push|pull_request|schedule|workflow_call):/m);
  assert.match(triggers, /source_commit:\n[\s\S]*?required: false\n\s+type: string/);
  assert.match(triggers, /dry_run:\n[\s\S]*?required: true\n\s+default: true\n\s+type: boolean/);
  for (const section of [prepare, publish]) {
    assert.match(headers(section), /if: github\.repository == 'microsoft\/aspire-skills' && github\.ref == 'refs\/heads\/main' && github\.event_name == 'workflow_dispatch'/);
    assert.match(headers(section), /runs-on: ubuntu-latest/);
  }
  assert.doesNotMatch(preparation, /bootstrap|continue-on-error:|always\(\)/);
});

test("release version is required for every promotion without an implicit default", () => {
  const input = preparation.match(/^      release_version:\n((?:        .*\n)+)/m)?.[1];
  assert.ok(input, "Missing release_version dispatch input");
  assert.match(input, /required: true/);
  assert.match(input, /type: string/);
  assert.match(input, /description: Release version\n/);
  assert.doesNotMatch(input, /default:/);
});

test("both actors are reauthorized as the first step on each isolated runner", () => {
  for (const section of [prepare, publish]) {
    assert.ok(steps(section)[0].startsWith("Check release permissions\n"));
    const gate = step(section, "Check release permissions");
    assert.match(gate, /shell: bash/);
    assert.match(gate, /GH_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(gate, /REPOSITORY: \$\{\{ github\.repository \}\}/);
    assert.match(gate, /ACTOR: \$\{\{ github\.actor \}\}/);
    assert.match(gate, /TRIGGERING_ACTOR: \$\{\{ github\.triggering_actor \}\}/);
    assert.equal(script(section, "Check release permissions"), authorization);
  }
  assert.match(authorization, /set -euo pipefail/);
  assert.match(authorization, /gh api "repos\/\$REPOSITORY\/collaborators\/\$actor\/permission" --jq '\.permission'/);
  assert.doesNotMatch(authorization, /\$\{\{|\|\| true|source |node |npm /);
});

test("all workflow tokens stay read-only and no Pages or privileged event is introduced", () => {
  for (const workflow of [preparation, testWorkflow]) {
    const permissions = [...workflow.matchAll(/^ *permissions:\n((?: +[\w-]+: (?:read|write|none)\n)+)/gm)];
    assert.equal(permissions.length, [...workflow.matchAll(/^ *permissions:/gm)].length);
    assert.equal(permissions.length, workflow === preparation ? 3 : 1);
    for (const [, block] of permissions) assert.equal(block.trim(), "contents: read");
    assert.doesNotMatch(workflow, /(?:^|\n) *pull-requests: write|pages:|id-token:|github-pages|publish-opencode-catalog/);
    assert.doesNotMatch(workflow, /actions\/(?:configure-pages|upload-pages-artifact|deploy-pages)|pull_request_target|workflow_run/);
    assert.doesNotMatch(workflow, /self-hosted|actions\/cache|skip-token-revoke/);
  }
});

test("every action is pinned and checkouts never persist credentials", () => {
  const pins = {
    "actions/checkout": "de0fac2e4500dabe0009e67214ff5f5447ce83dd",
    "actions/setup-node": "48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
    "actions/upload-artifact": "ea165f8d65b6e75b540449e92b4886f43607fa02",
    "actions/download-artifact": "d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "actions/create-github-app-token": "1b10c78c7865c340bc4f6099eb2f838309f1e8c3"
  };
  for (const workflow of [preparation, testWorkflow]) {
    for (const [, action, revision] of workflow.matchAll(/uses: ([^@\s]+)@([^\s]+)/g)) {
      assert.ok(Object.hasOwn(pins, action), `Unexpected action ${action}`);
      assert.equal(revision, pins[action], action);
    }
  }
  for (const section of [prepare, publish, matrix]) {
    const checkouts = steps(section).filter(content => content.includes("uses: actions/checkout@"));
    assert.equal(checkouts.length, section === matrix ? 1 : 2);
    for (const checkout of checkouts) {
      assert.match(checkout, /fetch-depth: 0/);
      assert.match(checkout, /persist-credentials: false/);
      assert.doesNotMatch(checkout, /token:/);
    }
    assert.match(step(section, "Setup Node"), /node-version: "22"/);
  }
});

test("preparation resolves origin/dev and main exactly once before trusted tests", () => {
  assert.match(step(prepare, "Checkout trusted tooling"), /ref: \$\{\{ github\.sha \}\}\n\s+path: tooling/);
  assert.match(step(prepare, "Checkout candidate repository"), /ref: main\n\s+path: candidate/);
  assert.ok(prepare.indexOf("id: resolve") < prepare.indexOf("name: Test trusted tooling"));
  assert.ok(prepare.indexOf("name: Test trusted tooling") < prepare.indexOf("id: prepare"));
  assert.match(step(prepare, "Resolve source and base once"), /RELEASE_REPO: \$\{\{ github\.workspace \}\}\/candidate/);
  assert.match(step(prepare, "Resolve source and base once"), /SOURCE_COMMIT: \$\{\{ inputs\.source_commit \}\}/);
  assert.match(step(prepare, "Resolve source and base once"), /RELEASE_VERSION: \$\{\{ inputs\.release_version \}\}/);
  assert.match(step(prepare, "Test trusted tooling"), /working-directory: tooling\n\s+run: npm test/);
  assert.equal((preparation.match(/release\.mjs" resolve/g) ?? []).length, 1);
  const generation = step(prepare, "Prepare and verify release candidate");
  assert.match(generation, /SOURCE_COMMIT: \$\{\{ steps\.resolve\.outputs\.source \}\}/);
  assert.match(generation, /BASE_COMMIT: \$\{\{ steps\.resolve\.outputs\.base \}\}/);
  assert.match(generation, /RELEASE_VERSION: \$\{\{ steps\.resolve\.outputs\.version \}\}/);
  assert.match(generation, /RELEASE_REPO: \$\{\{ github\.workspace \}\}\/candidate/);
  assert.equal(script(prepare, "Prepare and verify release candidate"),
    'set -euo pipefail\nnode "$GITHUB_WORKSPACE/tooling/scripts/release.mjs" prepare\n');
  assert.doesNotMatch(prepare, /secrets\.|ASPIRE_BOT|create-github-app-token|gh pr create|\bpush origin\b/);
});

test("job outputs bind resolved source, base, and version to the prepared candidate", () => {
  assert.match(headers(prepare), /source: \$\{\{ steps\.resolve\.outputs\.source \}\}/);
  assert.match(headers(prepare), /base: \$\{\{ steps\.resolve\.outputs\.base \}\}/);
  assert.match(headers(prepare), /version: \$\{\{ steps\.resolve\.outputs\.version \}\}/);
  assert.match(headers(prepare), /candidate: \$\{\{ steps\.prepare\.outputs\.candidate \}\}/);
  for (const [name, output] of [
    ["SOURCE_COMMIT", "source"], ["BASE_COMMIT", "base"], ["CANDIDATE_COMMIT", "candidate"], ["RELEASE_VERSION", "version"]
  ]) {
    assert.ok(step(publish, "Receive and verify without executing candidate code")
      .includes(`${name}: \${{ needs.prepare.outputs.${output} }}`));
  }
});

test("preparation and publication use only the resolved version, never the raw dispatch input", () => {
  assert.equal((preparation.match(/inputs\.release_version/g) ?? []).length, 1);
  assert.doesNotMatch(step(prepare, "Prepare and verify release candidate"), /inputs\.release_version/);
  assert.doesNotMatch(publish, /inputs\.release_version|steps\.prepare\.outputs\.version/);
  assert.match(step(publish, "Push release branch and open draft PR"),
    /RELEASE_VERSION: \$\{\{ needs\.prepare\.outputs\.version \}\}/);
  assert.equal((publish.match(/RELEASE_VERSION: \$\{\{ needs\.prepare\.outputs\.version \}\}/g) ?? []).length, 2);
});

test("dry runs still produce the checked bundle, PR body, and metadata but cannot publish", () => {
  assert.match(headers(publish), /needs: prepare/);
  assert.match(headers(publish), /&& !inputs\.dry_run/);
  assert.doesNotMatch(prepare, /inputs\.dry_run/);
  const upload = step(prepare, "Upload checked release bundle and PR body");
  const download = step(publish, "Download checked release artifact");
  for (const artifactStep of [upload, download]) {
    assert.match(artifactStep, /name: release-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  }
  assert.match(upload, /path: \|\n\s+candidate\/dist\/release\/release\.bundle\n\s+candidate\/dist\/release\/pr-body\.md\n\s+candidate\/dist\/release\/release\.json/);
  assert.match(upload, /if-no-files-found: error/);
  assert.doesNotMatch(upload, /if:|include-hidden-files: true/);
  assert.match(download, /path: \$\{\{ runner\.temp \}\}\/release-artifact/);
  assert.doesNotMatch(download, /run-id:|repository:|github-token:/);
});

test("publication imports with trusted tooling before any App token or secret is available", () => {
  assert.match(step(publish, "Checkout trusted tooling"), /ref: \$\{\{ github\.sha \}\}\n\s+path: tooling/);
  assert.match(step(publish, "Checkout receiver repository"), /ref: main\n\s+path: receiver/);
  const validation = step(publish, "Receive and verify without executing candidate code");
  assert.match(validation, /RELEASE_REPO: \$\{\{ github\.workspace \}\}\/receiver/);
  assert.match(validation, /BUNDLE_PATH: \$\{\{ runner\.temp \}\}\/release-artifact\/release\.bundle/);
  assert.match(validation, /PR_BODY_PATH: \$\{\{ runner\.temp \}\}\/release-artifact\/pr-body\.md/);
  assert.match(receive, /node "\$GITHUB_WORKSPACE\/tooling\/scripts\/release\.mjs" receive/);
  assert.doesNotMatch(publish, /\bnpm\b|working-directory: (?:receiver|candidate)|release\.mjs" (?:prepare|resolve)|git[^\n]*(?:checkout|switch|merge)/);
  assert.doesNotMatch(publish, /node "[^"\n]*\/(?:candidate|receiver|release-artifact)\//);
  assert.ok(publish.indexOf("Download checked release artifact") < publish.indexOf("id: verify"));
  assert.ok(publish.indexOf("id: verify") < publish.indexOf("secrets."));
  assert.ok(publish.indexOf("Check GitHub App prerequisites") < publish.indexOf("id: app-token"));
  assert.ok(publish.indexOf("id: app-token") < publish.indexOf("Push release branch"));
  assert.doesNotMatch(validation, /secrets\.|app-token\.outputs|GH_TOKEN/);
});

test("the App token is repository-scoped with only publication and necessary workflow permissions", () => {
  const token = step(publish, "Create short-lived repository publication token");
  assert.match(token, /client-id: \$\{\{ secrets\.ASPIRE_BOT_APP_ID \}\}/);
  assert.match(token, /private-key: \$\{\{ secrets\.ASPIRE_BOT_PRIVATE_KEY \}\}/);
  assert.doesNotMatch(preparation, /vars\.ASPIRE_BOT_APP_ID|^\s+app-id:/m);
  const prerequisites = step(publish, "Check GitHub App prerequisites");
  assert.match(prerequisites, /APP_ID: \$\{\{ secrets\.ASPIRE_BOT_APP_ID \}\}/);
  assert.match(prerequisites, /APP_PRIVATE_KEY: \$\{\{ secrets\.ASPIRE_BOT_PRIVATE_KEY \}\}/);
  assert.match(token, /owner: \$\{\{ github\.repository_owner \}\}/);
  assert.match(token, /repositories: \$\{\{ github\.event\.repository\.name \}\}/);
  assert.match(token, /permission-contents: write/);
  assert.match(token, /permission-pull-requests: write/);
  assert.match(token, /permission-workflows: \$\{\{ steps\.verify\.outputs\.workflows \}\}/);
  assert.equal((token.match(/permission-[\w-]+:/g) ?? []).length, 3);
  assert.match(receive, /diff --name-only "\$BASE_COMMIT" "\$CANDIDATE_COMMIT" -- \.github\/workflows/);
  assert.match(receive, /if \[\[ -n "\$workflow_changes" \]\]; then\n\s+echo "workflows=write" >> "\$GITHUB_OUTPUT"/);
  assert.equal((preparation.match(/uses: actions\/create-github-app-token@/g) ?? []).length, 1);
});

test("publication uses a per-command credential helper, a version branch, and the verified draft PR body", () => {
  const mutation = step(publish, "Push release branch and open draft PR");
  assert.match(mutation, /GH_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
  assert.doesNotMatch(mutation, /github\.token|GITHUB_TOKEN/);
  assert.doesNotMatch(mutation, /RUN_ID:|RUN_ATTEMPT:|SOURCE_COMMIT:|CANDIDATE_COMMIT:/);
  assert.match(publication, /branch="release\/\$\{RELEASE_VERSION\}"/);
  assert.match(publication, /git check-ref-format "refs\/heads\/\$branch"/);
  assert.match(publication, /-c credential\.helper=/);
  assert.match(publication, /ls-remote --heads origin "refs\/heads\/\$branch"/);
  assert.match(publication, /if \[\[ -n "\$existing" \]\]; then\n\s+echo "::error::Release branch \$branch already exists; refusing to overwrite a reviewed release\."\n\s+exit 1/);
  assert.match(publication, /push --force-with-lease="refs\/heads\/\$branch:" origin "refs\/heads\/release\/candidate:refs\/heads\/\$branch"/);
  assert.ok(publication.indexOf("ls-remote") < publication.indexOf("push --force-with-lease"));
  assert.match(publication, /gh pr create --repo "\$REPOSITORY" --draft --base main --head "\$branch"/);
  assert.match(publication, /--title "Release v\$\{RELEASE_VERSION\}"/);
  assert.doesNotMatch(publication, /--title "Release \$\{SOURCE_COMMIT/);
  assert.match(publication, /--body-file "\$PR_BODY_PATH"/);
  assert.doesNotMatch(publication, /https?:\/\/|git config|remote set-url|--force(?:\s|$)|--mirror|--all|set -x|tee /);
});

test("every shell step avoids GitHub expression interpolation and all required dev fetches are explicit", () => {
  for (const section of [prepare, publish, matrix]) {
    for (const content of steps(section).filter(value => value.includes("        run: "))) {
      const source = script(section, content.split("\n")[0]);
      assert.doesNotMatch(source, /\$\{\{|\beval\b/);
    }
  }
  for (const source of [resolve, receive]) {
    assert.match(source, /fetch --no-tags origin \\\n\s+\+refs\/heads\/main:refs\/remotes\/origin\/main \\\n\s+\+refs\/heads\/dev:refs\/remotes\/origin\/dev/);
    assert.match(source, /::error::Cannot fetch origin\/main and origin\/dev; both branches must exist\./);
    assert.doesNotMatch(source, /\|\| true/);
  }
});

const roleMock = String.raw`
gh() {
  if [[ "$#" != 4 || "$1" != api || "$3" != --jq || "$4" != .permission ]]; then return 2; fi
  printf 'LOOKUP:%s\n' "$2" >&2
  local result
  case "$2" in
    repos/microsoft/aspire-skills/collaborators/original/permission) result="$ACTOR_PERMISSION" ;;
    repos/microsoft/aspire-skills/collaborators/rerunner/permission) result="$RERUNNER_PERMISSION" ;;
    *) return 2 ;;
  esac
  if [[ "$result" == api-error ]]; then
    printf 'admin\n'
    return 1
  fi
  printf '%s\n' "$result"
}
`;

const allowedRoles = ["write", "maintain", "admin"];
const deniedRoles = ["read", "triage", "none", "unknown", "", "null", "WRITE", "administrator", "write,admin", "write\nadmin", "api-error"];
const scenarios = [
  ...allowedRoles.flatMap(actor => allowedRoles.map(rerunner => ({ actor, rerunner, allowed: true }))),
  ...deniedRoles.flatMap(role => [
    { actor: role, rerunner: "admin", allowed: false },
    { actor: "admin", rerunner: role, allowed: false }
  ])
];

for (const [jobName, section] of [["prepare", prepare], ["publish", publish]]) {
  const gate = script(section, "Check release permissions");
  for (const scenario of scenarios) {
    test(`${jobName} role gate: original=${JSON.stringify(scenario.actor)}, rerun=${JSON.stringify(scenario.rerunner)}`, bashOnly, () => {
      const result = bash(gate, {
        REPOSITORY: "microsoft/aspire-skills",
        ACTOR: "original",
        TRIGGERING_ACTOR: "rerunner",
        ACTOR_PERMISSION: scenario.actor,
        RERUNNER_PERMISSION: scenario.rerunner
      }, roleMock);
      assert.equal(result.status === 0, scenario.allowed, result.stdout + result.stderr);
      assert.match(result.stderr, /LOOKUP:repos\/microsoft\/aspire-skills\/collaborators\/original\/permission/);
      if (scenario.allowed || scenario.actor === "admin") {
        assert.match(result.stderr, /LOOKUP:repos\/microsoft\/aspire-skills\/collaborators\/rerunner\/permission/);
      }
      if (!scenario.allowed) assert.match(result.stdout + result.stderr, /::error::/);
    });
  }

  for (const missing of ["ACTOR", "TRIGGERING_ACTOR"]) {
    test(`${jobName} role gate fails closed for missing ${missing}`, bashOnly, () => {
      const result = bash(gate, {
        REPOSITORY: "microsoft/aspire-skills",
        ACTOR: "original",
        TRIGGERING_ACTOR: "rerunner",
        ACTOR_PERMISSION: "admin",
        RERUNNER_PERMISSION: "admin",
        [missing]: ""
      }, roleMock);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /::error::A release actor is missing/);
    });
  }
}

const validationEnv = {
  GITHUB_WORKSPACE: "/workspace with spaces",
  RELEASE_REPO: "/repository with spaces",
  GITHUB_OUTPUT: "/dev/null",
  SOURCE_COMMIT: "a".repeat(40),
  BASE_COMMIT: "b".repeat(40),
  CANDIDATE_COMMIT: "c".repeat(40),
  RELEASE_VERSION: "1.2.3",
  EXPECTED_RELEASE_VERSION: "1.2.3",
  FETCH_EXIT: "0",
  NODE_EXIT: "0",
  WORKFLOW_CHANGES: "",
  DIFF_EXIT: "0"
};
const validationMock = String.raw`
git() {
  if [[ "$1" != -C || "$2" != "$RELEASE_REPO" ]]; then return 2; fi
  case "$3" in
    fetch)
      if [[ "$#" != 7 || "$4" != --no-tags || "$5" != origin ||
        "$6" != +refs/heads/main:refs/remotes/origin/main ||
        "$7" != +refs/heads/dev:refs/remotes/origin/dev ]]; then return 2; fi
      printf 'FETCH\n' >&2
      return "$FETCH_EXIT"
      ;;
    diff)
      if [[ "$#" != 8 || "$4" != --name-only || "$5" != "$BASE_COMMIT" ||
        "$6" != "$CANDIDATE_COMMIT" || "$7" != -- || "$8" != .github/workflows ]]; then return 2; fi
      printf 'DIFF\n' >&2
      printf '%s' "$WORKFLOW_CHANGES"
      return "$DIFF_EXIT"
      ;;
    *) return 2 ;;
  esac
}
node() {
  if [[ "$#" != 2 || "$1" != "$GITHUB_WORKSPACE/tooling/scripts/release.mjs" ]]; then return 2; fi
  if [[ "$RELEASE_VERSION" != "$EXPECTED_RELEASE_VERSION" ]]; then return 2; fi
  printf 'NODE:%s\n' "$2"
  return "$NODE_EXIT"
}
`;

for (const [operation, source] of [["resolve", resolve], ["receive", receive]]) {
  test(`${operation} fetches explicit refs then invokes only the trusted script`, bashOnly, () => {
    const result = bash(source, validationEnv, validationMock);
    assertSuccess(result);
    assert.match(result.stderr, /^FETCH/m);
    assert.equal(result.stdout, `NODE:${operation}\n`);
  });
  test(`${operation} fails clearly when dev/main cannot be fetched`, bashOnly, () => {
    const result = bash(source, { ...validationEnv, FETCH_EXIT: "1" }, validationMock);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /::error::Cannot fetch origin\/main and origin\/dev/);
    assert.doesNotMatch(result.stdout, /NODE:/);
  });
}

for (const [operation, source] of [
  ["resolve", resolve],
  ["prepare", script(prepare, "Prepare and verify release candidate")],
  ["receive", receive]
]) {
  test(`${operation} forwards the exact release version to trusted core validation`, bashOnly, () => {
    const version = "1.2.3-rc.1+build.42";
    const result = bash(source, {
      ...validationEnv,
      RELEASE_VERSION: version,
      EXPECTED_RELEASE_VERSION: version
    }, validationMock);
    assertSuccess(result);
    assert.equal(result.stdout, `NODE:${operation}\n`);
  });
}

test("resolve forwards an explicit maintenance version to core without workflow content classification", bashOnly, () => {
  const result = bash(resolve, {
    ...validationEnv,
    RELEASE_VERSION: "0.0.2",
    EXPECTED_RELEASE_VERSION: "0.0.2"
  }, validationMock);
  assertSuccess(result);
  assert.equal(result.stdout, "NODE:resolve\n");
});

test("only a successfully verified workflow promotion requests workflows write", bashOnly, t => {
  const fixture = mkdtempSync(join(repoRoot, ".release-workflow-test-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const outputFile = join(fixture, "github-output");
  const run = env => {
    writeFileSync(outputFile, "");
    const result = bash(receive, { ...validationEnv, ...env, GITHUB_OUTPUT: outputFile }, validationMock);
    return { result, output: readFileSync(outputFile, "utf8") };
  };
  const unchanged = run({});
  assertSuccess(unchanged.result);
  assert.equal(unchanged.output, "");
  const changed = run({ WORKFLOW_CHANGES: ".github/workflows/test.yml" });
  assertSuccess(changed.result);
  assert.equal(changed.output, "workflows=write\n");
  const rejected = run({ NODE_EXIT: "1", WORKFLOW_CHANGES: ".github/workflows/test.yml" });
  assert.notEqual(rejected.result.status, 0);
  assert.equal(rejected.output, "");
  assert.doesNotMatch(rejected.result.stderr, /DIFF/);
  const failedDiff = run({ DIFF_EXIT: "1" });
  assert.notEqual(failedDiff.result.status, 0);
  assert.equal(failedDiff.output, "");
});

test("missing App prerequisites fail without printing secret values", bashOnly, () => {
  const source = script(publish, "Check GitHub App prerequisites");
  for (const [id, key] of [["", ""], ["123", ""], ["", "private-key-sentinel"]]) {
    const result = bash(source, { APP_ID: id, APP_PRIVATE_KEY: key });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /::error::Configure the ASPIRE_BOT_APP_ID and ASPIRE_BOT_PRIVATE_KEY secrets/);
    assert.doesNotMatch(result.stdout + result.stderr, /private-key-sentinel/);
  }
  assertSuccess(bash(source, { APP_ID: "123", APP_PRIVATE_KEY: "private-key-sentinel" }));
});

const publicationEnv = {
  RELEASE_REPO: "/receiver with spaces",
  REPOSITORY: "microsoft/aspire-skills",
  RELEASE_VERSION: "1.2.3",
  PR_BODY_PATH: "/artifact with spaces/pr-body.md",
  GH_TOKEN: "app-token-sentinel",
  REMOTE_HEAD: "",
  LOOKUP_EXIT: "0",
  PUSH_EXIT: "0"
};
const publicationMock = String.raw`
git() {
  local branch="release/$RELEASE_VERSION"
  if [[ "$1" == check-ref-format && "$#" == 2 && "$2" == "refs/heads/$branch" ]]; then
    printf 'REF:%s\n' "$2"
    return 0
  fi
  if [[ "$#" == 6 && "$1" == -C && "$2" == "$RELEASE_REPO" &&
    "$3" == ls-remote && "$4" == --heads && "$5" == origin && "$6" == "refs/heads/$branch" ]]; then
    printf '%s' "$REMOTE_HEAD"
    if [[ "$LOOKUP_EXIT" != 0 ]]; then printf 'Remote lookup failed\n' >&2; fi
    return "$LOOKUP_EXIT"
  fi
  if [[ "$#" != 12 || "$1" != -C || "$2" != "$RELEASE_REPO" ||
    "$3" != -c || "$4" != core.hooksPath=/dev/null ||
    "$5" != -c || "$6" != credential.helper= || "$7" != -c ||
    "$8" != credential.helper=\!* || "$9" != push || "\${10}" != "--force-with-lease=refs/heads/$branch:" ||
    "\${11}" != origin || "\${12}" != "refs/heads/release/candidate:refs/heads/$branch" ]]; then return 2; fi
  if [[ "$*" == *"$GH_TOKEN"* ]]; then return 3; fi
  printf 'PUSH:%s\n' "$branch"
  return "$PUSH_EXIT"
}
gh() {
  local branch="release/$RELEASE_VERSION"
  if [[ "$#" != 13 || "$1" != pr || "$2" != create || "$3" != --repo ||
    "$4" != "$REPOSITORY" || "$5" != --draft || "$6" != --base || "$7" != main ||
    "$8" != --head || "$9" != "$branch" || "\${10}" != --title ||
    "\${11}" != "Release v\${RELEASE_VERSION}" || "\${12}" != --body-file ||
    "\${13}" != "$PR_BODY_PATH" ]]; then return 2; fi
  printf 'PR:%s\n' "$branch"
  printf 'TITLE:%s\n' "\${11}"
}
`.replaceAll("\\${", "${");

test("publication creates a deterministic SemVer branch and its draft PR without exposing tokens", bashOnly, () => {
  for (const version of ["0.0.2", "1.2.3-rc.1"]) {
    const result = bash(publication, { ...publicationEnv, RELEASE_VERSION: version }, publicationMock);
    assertSuccess(result);
    const branch = `release/${version}`;
    assert.equal(result.stdout, `REF:refs/heads/${branch}\nPUSH:${branch}\nPR:${branch}\nTITLE:Release v${version}\n`);
    assert.doesNotMatch(result.stdout + result.stderr, /app-token-sentinel/);
  }
});

test("the branch and draft PR title preserve uppercase prerelease and build metadata", bashOnly, () => {
  const version = "2.0.0-RC.1+Build.42";
  const result = bash(publication, { ...publicationEnv, RELEASE_VERSION: version }, publicationMock);
  assertSuccess(result);
  assert.ok(result.stdout.includes(`PR:release/${version}\n`));
  assert.ok(result.stdout.endsWith(`TITLE:Release v${version}\n`));
  assert.doesNotMatch(result.stdout + result.stderr, /app-token-sentinel/);
});

test("an existing release branch fails before any push or PR creation", bashOnly, () => {
  const result = bash(publication, {
    ...publicationEnv,
    REMOTE_HEAD: `${"a".repeat(40)}\trefs/heads/release/${publicationEnv.RELEASE_VERSION}\n`
  }, publicationMock);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error::Release branch release\/1\.2\.3 already exists/);
  assert.doesNotMatch(result.stdout, /PUSH:|PR:/);
});

test("remote lookup failure cannot fall through to publication", bashOnly, () => {
  const result = bash(publication, { ...publicationEnv, LOOKUP_EXIT: "1" }, publicationMock);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Remote lookup failed/);
  assert.doesNotMatch(result.stdout, /PUSH:|PR:/);
});

test("failed branch publication cannot open a PR", bashOnly, () => {
  const result = bash(publication, { ...publicationEnv, PUSH_EXIT: "1" }, publicationMock);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /PR:/);
});

test("the per-command helper serves credentials only for get and never stores them", bashOnly, () => {
  const helper = publication.match(/-c 'credential\.helper=!(.+)'/)?.[1];
  assert.ok(helper);
  const get = bash(helper + " get", { GH_TOKEN: "app-token-sentinel" });
  assertSuccess(get);
  assert.equal(get.stdout, "username=x-access-token\npassword=app-token-sentinel\n");
  for (const operation of ["store", "erase"]) {
    const result = bash(helper + ` ${operation}`, { GH_TOKEN: "app-token-sentinel" });
    assertSuccess(result);
    assert.equal(result.stdout, "");
  }
});
