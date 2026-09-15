import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(repoRoot, ".github", "workflows", "publish.yml"), "utf8")
  .replace(/\r\n/g, "\n");
const sourceCommit = "a".repeat(40);
const annotatedTag = "b".repeat(40);
const otherCommit = "c".repeat(40);

test("publishing supports version-tag pushes and only manual artifact inputs", () => {
  assert.match(workflow, /^on:\n  push:\n    tags:\n      - "v\*"\n      - "\[0-9\]\*"\n  workflow_dispatch:/m);
  const inputs = workflow.match(/  workflow_dispatch:\n    inputs:\n([\s\S]*?)\npermissions:/)?.[1];
  assert.ok(inputs, "Manual dispatch inputs must be declared.");
  assert.deepEqual(
    [...inputs.matchAll(/^      ([a-z_]+):$/gm)].map(match => match[1]),
    ["include_skills", "include_extensions"]
  );
  assert.doesNotMatch(workflow, /inputs\.version|RELEASE_VERSION/);
});

test("releases retain up to 100 pending runs without replacing earlier queued releases", () => {
  assert.match(workflow, /concurrency:\n  group: \$\{\{ github\.workflow \}\}\n  queue: max\n  cancel-in-progress: false/);
});

test("deleted tag pushes skip the publish job", () => {
  assert.match(workflow, /  publish:\n    name: Publish bundles\n    if: \$\{\{ github\.event_name != 'push' \|\| !github\.event\.deleted \}\}/);
});

test("manual publishing defaults to skills checked and extensions unchecked", () => {
  assert.match(workflow, /workflow_dispatch:\n    inputs:/);
  for (const [bundle, defaultValue] of [["skills", true], ["extensions", false]]) {
    assert.match(workflow, new RegExp(
      `      include_${bundle}:\\n        description: Include aspire-${bundle}\\n        type: boolean\\n        default: ${defaultValue}\\n`
    ));
  }
  assert.match(stepSource("Select bundles"), /INCLUDE_SKILLS: \$\{\{ inputs\.include_skills \}\}/);
  assert.match(stepSource("Select bundles"), /INCLUDE_EXTENSIONS: \$\{\{ inputs\.include_extensions \}\}/);
  assert.ok(workflow.indexOf("- name: Select bundles") < workflow.indexOf("- name: Checkout"));
});

test("building, attesting, and publishing share the selected bundle outputs", () => {
  assert.match(stepSource("Select bundles"), /id: selection\n/);
  assert.match(stepSource("Build bundles"), /BUNDLES: \$\{\{ steps\.selection\.outputs\.bundles \}\}/);
  assert.match(stepSource("Build bundles"), /VERSION: \$\{\{ steps\.version\.outputs\.version \}\}/);
  assert.match(stepSource("Build bundles"), /SOURCE_COMMIT: \$\{\{ steps\.version\.outputs\.source_commit \}\}/);
  assert.match(stepSource("Build bundles"), /id: build\n/);
  assert.match(stepSource("Attest bundles"), /subject-path: \$\{\{ steps\.build\.outputs\.assets \}\}/);
  assert.match(stepSource("Publish GitHub release"), /BUNDLE_ASSETS: \$\{\{ steps\.build\.outputs\.assets \}\}/);
});

test("the built-in repository token verifies existing tags and publishes without App credentials", () => {
  assert.match(workflow, /permissions:\n  contents: write\n/);
  assert.match(stepSource("Checkout"), /persist-credentials: false/);
  assert.doesNotMatch(workflow, /create-github-app-token|RELEASE_APP_|release-token/);
  for (const step of ["Verify release tag", "Publish GitHub release"]) {
    assert.match(stepSource(step), /GH_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(stepSource(step), /TAG_NAME: \$\{\{ steps\.version\.outputs\.tag \}\}/);
  }
  assert.match(stepSource("Verify release tag"), /SOURCE_COMMIT: \$\{\{ steps\.version\.outputs\.source_commit \}\}/);
  assert.match(stepSource("Publish GitHub release"), /--verify-tag/);
  assert.doesNotMatch(workflow, /\/git\/refs|--raw-field|--target/);

  const orderedSteps = [
    "Select bundles",
    "Checkout",
    "Read release version",
    "Test bundles",
    "Build bundles",
    "Attest bundles",
    "Verify release tag",
    "Publish GitHub release"
  ].map(name => workflow.indexOf(`- name: ${name}`));
  assert.deepEqual(orderedSteps, [...orderedSteps].sort((left, right) => left - right));
});

for (const scenario of [
  { name: "prefixed tag pushes", event: "push", tag: "v9.9.9", skills: "", extensions: "", bundles: ["skills"] },
  { name: "unprefixed tag pushes", event: "push", tag: "9.9.9", skills: "", extensions: "", bundles: ["skills"] },
  { name: "tag pushes ignoring dispatch inputs", event: "push", skills: "false", extensions: "true", bundles: ["skills"] },
  { name: "manual skills only", skills: "true", extensions: "false", bundles: ["skills"] },
  { name: "manual extensions only", skills: "false", extensions: "true", bundles: ["extensions"] },
  { name: "manual both bundles", skills: "true", extensions: "true", bundles: ["skills", "extensions"] }
]) {
  test(`${scenario.name} build and publish only selected assets`, t => {
    const selection = runStep(t, "Select bundles", {
      GITHUB_EVENT_NAME: scenario.event ?? "workflow_dispatch",
      INCLUDE_SKILLS: scenario.skills,
      INCLUDE_EXTENSIONS: scenario.extensions
    });
    assert.equal(selection.status, 0, selection.stderr);
    assert.equal(selection.outputs, `bundles=${scenario.bundles.join(" ")}\n`);

    const build = runStep(t, "Build bundles", {
      BUNDLES: selection.outputs.trim().slice("bundles=".length),
      VERSION: "9.9.9",
      SOURCE_COMMIT: sourceCommit
    }, `
npm() {
  printf '<%s>' "$@"
  printf '\\n'
}
`);
    assert.equal(build.status, 0, build.stderr);
    assert.equal(build.stdout, scenario.bundles.map(bundle => formatArgs([
      "run", "bundle", "--",
      "--bundle", bundle,
      "--version", "9.9.9",
      "--out", "dist",
      "--source-commit", sourceCommit
    ])).join(""));

    const assets = scenario.bundles.map(bundle => `dist/aspire-${bundle}-v9.9.9.tgz`);
    assert.equal(build.outputs, `assets<<EOF\n${assets.join("\n")}\nEOF\n`);
    const assetOutput = build.outputs.slice("assets<<EOF\n".length, -"\nEOF\n".length);
    const tag = scenario.tag ?? "v9.9.9";

    for (const releaseExists of [true, false]) {
      const publish = runStep(t, "Publish GitHub release", {
        BUNDLE_ASSETS: assetOutput,
        TAG_NAME: tag,
        VERSION: "9.9.9",
        RELEASE_EXISTS_STATUS: releaseExists ? "0" : "1"
      }, `
gh() {
  if [[ "$1 $2" == "release view" ]]; then
    return "$RELEASE_EXISTS_STATUS"
  fi
  printf '<%s>' "$@"
  printf '\\n'
}
`);
      assert.equal(publish.status, 0, publish.stderr);
      assert.equal(publish.stdout, formatArgs(releaseExists
        ? ["release", "upload", tag, ...assets, "--clobber"]
        : ["release", "create", tag, ...assets, "--verify-tag", "--title", tag, "--notes", "Aspire bundles 9.9.9"]));
    }
  });
}

test("manual publishing rejects an empty selection", t => {
  const result = runStep(t, "Select bundles", {
    INCLUDE_SKILLS: "false",
    INCLUDE_EXTENSIONS: "false"
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::Select at least one bundle: aspire-skills or aspire-extensions\./);
  assert.equal(result.outputs, "");
});

for (const failedBundle of ["skills", "extensions"]) {
  test(`a failed ${failedBundle} build does not expose partial release assets`, t => {
    const result = runStep(t, "Build bundles", {
      BUNDLES: "skills extensions",
      VERSION: "9.9.9",
      SOURCE_COMMIT: sourceCommit,
      FAILED_BUNDLE: failedBundle
    }, 'npm() { [[ "$5" != "$FAILED_BUNDLE" ]]; }');
    assert.equal(result.status, 1);
    assert.equal(result.outputs, "");
  });
}

for (const event of ["workflow_dispatch", "push"]) {
  for (const version of ["0.0.3", "v0.0.3", "v1.2.3-preview.1", "1.2.3.4", "v1.2.3.4"]) {
    test(`${event} version ${version} resolves the correct release tag and commit`, t => {
      const result = runStep(t, "Read release version", {
        GITHUB_EVENT_NAME: event,
        GITHUB_REF_TYPE: "tag",
        GITHUB_REF_NAME: version,
        SOURCE_COMMIT: sourceCommit
      }, `
git() {
  if [[ "$1" == "check-ref-format" ]]; then
    command git "$@"
    return
  fi
  [[ "$*" == "rev-parse HEAD^{commit}" ]] || return 1
  printf '%s\\n' "$SOURCE_COMMIT"
}
`);
      assert.equal(result.status, 0, result.stderr);
      const normalized = version.replace(/^v/, "");
      assert.equal(result.outputs, `source_commit=${sourceCommit}\nversion=${normalized}\ntag=${version}\n`);
    });
  }

  for (const version of ["0.0.3..preview", "v0.0.3..preview", "0.0.3-preview..1", "v0.0.3-preview..1", "0.0.3-preview.", "v0.0.3-preview."]) {
    test(`${event} publishing rejects invalid Git tag name ${JSON.stringify(version)} before emitting outputs`, t => {
      const result = runStep(t, "Read release version", {
        GITHUB_EVENT_NAME: event,
        GITHUB_REF_TYPE: "tag",
        GITHUB_REF_NAME: version
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /::error::Tag '.+' is not a valid Git reference\./);
      assert.equal(result.outputs, "");
    });
  }

  for (const version of ["", "v", "vv0.0.3", "V0.0.3", "1.2", "refs/tags/v1.2.3", "1.2.3\ninjected=true", "1.2.3;exit 0"]) {
    test(`${event} publishing rejects invalid version ${JSON.stringify(version)}`, t => {
      const result = runStep(t, "Read release version", {
        GITHUB_EVENT_NAME: event,
        GITHUB_REF_TYPE: "tag",
        GITHUB_REF_NAME: version
      }, "git() { return 99; }");
      assert.equal(result.status, 1);
      assert.match(result.stderr, /::error::Tag '.*' is not a supported release version\./s);
      assert.equal(result.outputs, "");
    });
  }
}

for (const event of ["workflow_dispatch", "push"]) {
  test(`${event} publishing rejects branch refs`, t => {
    const result = runStep(t, "Read release version", {
      GITHUB_EVENT_NAME: event,
      GITHUB_REF_TYPE: "branch",
      GITHUB_REF_NAME: "main"
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Select an existing version tag when running this workflow/);
    assert.equal(result.outputs, "");
  });

  test(`${event} publishing never creates a missing or deleted tag`, t => {
    const result = runTagStep(t, { GITHUB_EVENT_NAME: event });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Tag 'v9\.9\.9' no longer exists\. Select an existing version tag/);
    assert.equal(result.stdout, "");
  });

  for (const type of ["commit", "tag"]) {
    test(`${event} verifies an existing ${type} tag at the source commit without mutation`, t => {
      const result = runTagStep(t, {
        GITHUB_EVENT_NAME: event,
        TAG_OBJECT: `${type}\t${type === "tag" ? annotatedTag : sourceCommit}`
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `Verified tag 'v9.9.9' at '${sourceCommit}'.\n`);
    });
  }
}

for (const type of ["commit", "tag", "blob"]) {
  test(`an existing ${type} tag with the wrong target fails without mutation`, t => {
    const result = runTagStep(t, {
      TAG_OBJECT: `${type}\t${type === "tag" ? annotatedTag : otherCommit}`,
      ANNOTATED_TAG_OBJECT: `commit\t${otherCommit}`
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::Tag 'v9\.9\.9' does not point to release commit/);
    assert.equal(result.stdout, "");
  });
}

for (const failure of ["LOOKUP_STATUS", "ANNOTATED_LOOKUP_STATUS"]) {
  test(`tag API failure ${failure} aborts rather than reporting success`, t => {
    const result = runTagStep(t, {
      [failure]: "1",
      TAG_OBJECT: failure === "ANNOTATED_LOOKUP_STATUS" ? `tag\t${annotatedTag}` : ""
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /tag API failed/);
    assert.equal(result.stdout, "");
  });
}

function runTagStep(t, env = {}) {
  return runStep(t, "Verify release tag", {
    GITHUB_REPOSITORY: "microsoft/aspire-skills",
    TAG_NAME: "v9.9.9",
    SOURCE_COMMIT: sourceCommit,
    TAG_OBJECT: "",
    ANNOTATED_TAG_OBJECT: `commit\t${sourceCommit}`,
    LOOKUP_STATUS: "0",
    ANNOTATED_LOOKUP_STATUS: "0",
    ...env
  }, `
gh() {
  [[ "$1" == "api" ]] || return 99
  case "$2" in
    "repos/microsoft/aspire-skills/git/matching-refs/tags/v9.9.9")
      [[ "$3" == "--jq" ]] || return 99
      [[ "$4" == '.[] | select(.ref == "refs/tags/v9.9.9") | [.object.type, .object.sha] | @tsv' ]] || return 99
      if [[ "$LOOKUP_STATUS" != "0" ]]; then
        echo "tag API failed" >&2
        return "$LOOKUP_STATUS"
      fi
      printf '%s\\n' "$TAG_OBJECT"
      ;;
    "repos/microsoft/aspire-skills/git/tags/${annotatedTag}")
      [[ "$3" == "--jq" && "$4" == '[.object.type, .object.sha] | @tsv' ]] || return 99
      if [[ "$ANNOTATED_LOOKUP_STATUS" != "0" ]]; then
        echo "tag API failed" >&2
        return "$ANNOTATED_LOOKUP_STATUS"
      fi
      printf '%s\\n' "$ANNOTATED_TAG_OBJECT"
      ;;
    *)
      echo "Unexpected tag API request" >&2
      return 99
      ;;
  esac
}
`);
}

function stepSource(name) {
  const step = workflow.split(/^      - name: /m).find(source => source.startsWith(`${name}\n`));
  assert.ok(step, `Missing publish step: ${name}`);
  return step;
}

function runStep(t, name, env, setup = "") {
  const script = stepSource(name).match(/        run: \|\n([\s\S]*)$/)?.[1];
  assert.ok(script, `Missing Bash script for publish step: ${name}`);
  const workspace = mkdtempSync(join(tmpdir(), "aspire-publish-workflow-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", `${setup}\n${script.replace(/^ {10}/gm, "")}`], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      ...env,
      GITHUB_OUTPUT: "github-output"
    }
  });
  assert.equal(result.error, undefined, result.error?.message);

  const outputPath = join(workspace, "github-output");
  return {
    ...result,
    outputs: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : ""
  };
}

function formatArgs(args) {
  return `${args.map(arg => `<${arg}>`).join("")}\n`;
}
