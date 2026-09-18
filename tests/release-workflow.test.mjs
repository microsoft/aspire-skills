import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(repoRoot, ".github", "workflows", "publish.yml"), "utf8")
  .replaceAll("\r\n", "\n");

const mocks = `
git() {
  printf 'git %s\\n' "$*" >> commands
  case "$1" in
    ls-remote)
      if [[ "$REMOTE_ERROR" == "true" ]]; then
        echo "Remote lookup failed" >&2
        return 128
      fi
      if [[ "$TAG_EXISTS" == "true" ]]; then
        printf '%s\\trefs/tags/%s\\n' "$TAG_COMMIT" "$TAG_NAME"
      fi
      ;;
    rev-list) printf '%s\\n' "$TAG_COMMIT" ;;
    fetch|tag|push) ;;
    *) echo "Unexpected git command: $*" >&2; return 99 ;;
  esac
}
gh() {
  printf 'gh %s\\n' "$*" >> commands
  case "$1 $2" in
    "release view") [[ "$RELEASE_EXISTS" == "true" ]] ;;
    "release create"|"release upload") ;;
    *) echo "Unexpected gh command: $*" >&2; return 99 ;;
  esac
}
`;

test("new versions request publication and a tag", t => {
  const result = runStep(t, "Check release status");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs, "create_tag=true\npublish=true\n");
});

test("remote lookup failures cannot be mistaken for a missing tag", t => {
  const result = runStep(t, "Check release status", { REMOTE_ERROR: "true" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Remote lookup failed/);
  assert.equal(result.outputs, "");
});

test("published versions are skipped on later same-version branch commits", t => {
  const result = runStep(t, "Check release status", {
    TAG_EXISTS: "true", RELEASE_EXISTS: "true", TAG_COMMIT: "previous"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs, "create_tag=false\npublish=false\n");
});

test("a new bump cannot reuse another commit's published tag", t => {
  const result = runStep(t, "Check release status", {
    TAG_EXISTS: "true", RELEASE_EXISTS: "true", TAG_COMMIT: "previous",
    VERSION_CHANGED: "true"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already belongs to previous/);
  assert.doesNotMatch(result.outputs, /publish=true/);
});

test("a failed release can be retried at the tagged commit without recreating its tag", t => {
  const result = runStep(t, "Check release status", { TAG_EXISTS: "true" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs, "create_tag=false\npublish=true\n");
});

test("an unpublished existing tag cannot be moved to another commit", t => {
  const result = runStep(t, "Check release status", {
    TAG_EXISTS: "true", TAG_COMMIT: "previous"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /points to previous instead of current/);
});

test("tag recovery requires a remote tag but permits replacing existing release assets", t => {
  const missing = runStep(t, "Check release status", { AUTO_TAG: "false" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /does not exist on origin/);
  const existing = runStep(t, "Check release status", {
    AUTO_TAG: "false", TAG_EXISTS: "true", RELEASE_EXISTS: "true"
  });
  assert.equal(existing.status, 0, existing.stderr);
  assert.equal(existing.outputs, "create_tag=false\npublish=true\n");
});

test("tag creation uses the resolved source commit without force", t => {
  const result = runStep(t, "Create release tag");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.commands, "git tag v0.0.2 current\ngit push origin refs/tags/v0.0.2\n");
});

test("default publication creates or repairs the release with only the skills asset", t => {
  for (const exists of ["false", "true"]) {
    const result = runStep(t, "Publish GitHub release", { RELEASE_EXISTS: exists });
    assert.equal(result.status, 0, result.stderr);
    const assets = "v0.0.2 dist/aspire-skills-v0.0.2.tgz";
    assert.ok(result.commands.includes(
      exists === "true"
        ? `gh release upload ${assets} --clobber`
        : `gh release create ${assets} --verify-tag --title v0.0.2 --notes Aspire bundles 0.0.2`
    ), result.commands);
    assert.doesNotMatch(result.commands, /aspire-extensions/);
  }
});

function runStep(t, name, env = {}) {
  const root = mkdtempSync(join(tmpdir(), "aspire-release-workflow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const step = workflow.split(`      - name: ${name}\n`)[1]?.split("\n      - name:")[0];
  assert.ok(step, `Workflow step '${name}' must exist.`);
  const script = step.split("        run: |\n")[1];
  assert.ok(script, `Workflow step '${name}' must use a Bash script.`);
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c",
    `${mocks}\n${script.replace(/^          /gm, "")}`], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: "outputs",
      AUTO_TAG: "true", TAG_NAME: "v0.0.2", VERSION: "0.0.2",
      SOURCE_COMMIT: "current", TAG_COMMIT: "current",
      SKILLS_ASSET: "dist/aspire-skills-v0.0.2.tgz",
      EXTENSIONS_ASSET: "dist/aspire-extensions-v0.0.2.tgz",
      INCLUDE_SKILLS: "true", INCLUDE_EXTENSIONS: "false",
      REMOTE_ERROR: "false", TAG_EXISTS: "false",
      RELEASE_EXISTS: "false", VERSION_CHANGED: "false",
      ...env
    }
  });
  assert.ifError(result.error);
  return {
    ...result,
    outputs: existsSync(join(root, "outputs")) ? readFileSync(join(root, "outputs"), "utf8") : "",
    commands: existsSync(join(root, "commands")) ? readFileSync(join(root, "commands"), "utf8") : ""
  };
}
