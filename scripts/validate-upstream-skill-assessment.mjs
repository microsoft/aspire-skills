import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Repository } from "./release-git.mjs";
import { checkEvalResults } from "./check-eval-results.mjs";
import { immutableSha, replaceLiteral, safeSkillPath, skillDocuments, sourceIdentity, validateDraft } from "./upstream-skill-assessment.mjs";

export const digest = value => createHash("sha256").update(value).digest("hex");
export const publicationEnvironment = "upstream-skill-publication";
export const publicationBranch = source => `upstream/aspire/${source.key}`;
export const sourceMarker = source => `<!-- upstream-aspire-source:${source.key} -->`;

export function bindingFromEnvironment(env) {
  const binding = {
    repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT,
    workflowSha: env.GITHUB_WORKFLOW_SHA, headSha: env.GITHUB_SHA, workflowRef: env.GITHUB_WORKFLOW_REF
  };
  assert.equal(binding.repository, "microsoft/aspire-skills");
  assert.match(binding.runId, /^[1-9]\d*$/);
  assert.match(binding.attempt, /^[1-9]\d*$/);
  immutableSha(binding.workflowSha);
  assert.equal(binding.headSha, binding.workflowSha);
  assert.match(binding.workflowRef, /^microsoft\/aspire-skills\/\.github\/workflows\/upstream-skill-assessment\.yml@refs\/heads\/[A-Za-z0-9._/-]+$/);
  return binding;
}

export async function assertFresh(github, target, source) {
  assert.equal(target.repository, "microsoft/aspire-skills");
  assert.equal(target.branch, "dev");
  immutableSha(target.sha);
  const { data: branch } = await github.rest.repos.getBranch({ owner: "microsoft", repo: "aspire-skills", branch: "dev" });
  assert.equal(branch.commit.sha, target.sha, "dev advanced: reassess against its new immutable base.");
  const { data: pr } = await github.rest.pulls.get({ owner: "microsoft", repo: "aspire", pull_number: source.number });
  assert.deepEqual(sourceIdentity(pr), source, "The canonical upstream source changed: reassess.");
}

export function allowedPublicationPaths(edits) {
  const paths = new Set(["opencode/v1/index.json", "opencode/v2/index.json"]);
  for (const edit of edits) {
    assert.ok(safeSkillPath(edit.path));
    paths.add(edit.path);
    const [, skill, ...rest] = edit.path.split("/");
    paths.add(`opencode/v1/${skill}/${rest.join("/")}`);
    paths.add(`opencode/v2/${skill}/${rest.join("/") === "SKILL.md" ? `${skill}.md` : rest.join("/")}`);
  }
  return paths;
}

function commandEnvironment(environment) {
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "COMSPEC", "PATHEXT", "HOME", "USERPROFILE", "CHROME_BIN", "COPILOT_CLI_PATH", "COPILOT_GITHUB_TOKEN"]) {
    if (environment[key]) env[key] = environment[key];
  }
  return {
    ...env, CI: "true", VALLY_TELEMETRY_OPTOUT: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1"
  };
}

export function execute(command, { cwd, env }) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30 * 60 * 1000,
    // npm.cmd is not directly executable by spawn on Windows.
    shell: process.platform === "win32" && ["npm", "vally"].includes(command[0])
  });
  if (result.error && !["ENOENT", "ETIMEDOUT", "ENOBUFS"].includes(result.error.code)) throw result.error;
  return { exitCode: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\nCommand error: ${result.error.code}` : ""}` };
}

function evalSpecs(root, skill) {
  const files = [];
  const visit = (directory, path) => {
    assert.ok(!lstatSync(directory).isSymbolicLink(), "Symlinked eval directory.");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), "Symlinked eval input.");
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) visit(join(directory, entry.name), child);
      else if (entry.name === "eval.yaml" && entry.isFile()) files.push(child);
    }
  };
  const path = `skills/${skill}/evals`;
  assert.ok(existsSync(join(root, path)), `No model evaluations exist for ${skill}. Human validation is required.`);
  visit(join(root, path), path);
  assert.ok(files.length > 0, `No model evaluations exist for ${skill}.`);
  return files.sort();
}

export function validationPlan(root, edits) {
  const skills = [...new Set(edits.map(edit => edit.path.split("/")[1]))].sort();
  const specs = skills.map(skill => ({ skill, paths: evalSpecs(root, skill) }));
  return [
    ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    ["npm", "run", "catalog"],
    ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", "add", "--", "skills", "opencode"],
    ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
      "-c", "user.name=Aspire Skills Bot", "-c", "user.email=aspire-skills-bot@users.noreply.github.com",
      "commit", "--quiet", "-m", "docs: validate isolated upstream guidance",
      "-m", "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"],
    ["npm", "test"],
    ["vally", "lint", "skills"],
    ...specs.flatMap(({ paths }) => paths.map(path => ["vally", "lint", "--eval-spec", path])),
    ["npm", "run", "catalog:check"],
    ...specs.map(({ skill, paths }) => [
      "vally", "eval", "--require-pass", "--runs", "1", "--max-retries", "2",
      ...paths.flatMap(path => ["--eval-spec", path]),
      "--tag", "priority=p0,p1", "--workers", "1", "--output-dir", `.upstream-results/${skill}`
    ]),
    ["node", "scripts/check-eval-results.mjs", ".upstream-results", ...skills]
  ];
}

function quote(text) {
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
  return `${fence}text\n${text}\n${fence}`;
}

function commandText(command) {
  return command.map(argument => /^[A-Za-z0-9_./:=@,+-]+$/.test(argument) ? argument : JSON.stringify(argument)).join(" ");
}

export function previewFor(item, target, binding) {
  const report = item.report;
  const source = report.source;
  const title = `docs: align ${item.skills.join(", ")} with Aspire PR #${source.number}`;
  const body = [
    "## Grounded upstream guidance update", "",
    `Source: ${source.url}`, `Merge SHA: \`${source.merge}\``,
    `Reported base/head: \`${source.base}\` / \`${source.head}\``,
    `Target branch: \`${source.branch}\`; merged ${source.mergedAt}.`,
    `Release / compatibility scope: **${source.release}**. Shipping release is unknown; no publication is inferred.`,
    `Skills base: \`${target.repository}@${target.sha}\` (\`${target.branch}\`).`, "",
    "Affected API / CLI command:", quote(report.api), "Rationale:", quote(report.reason), "",
    "### Immutable implementation and test evidence",
    ...report.citations.map(citation => `${citation.url}\n${quote(citation.quote)}`), "",
    "### Actual isolated validation",
    ...item.commands.map(result => `- \`${commandText(result.command)}\`: ${result.exitCode === 0 ? "passed (exit 0)" : `FAILED (exit ${result.exitCode})`}`),
    `- ${item.trials} model-backed p0/p1 trials completed with passing grades; result integrity checked.`,
    `- Validation run: https://github.com/${binding.repository}/actions/runs/${binding.runId}/attempts/${binding.attempt}`, "",
    "This is a draft. Maintainer review and normal repository checks are required before merge.",
    "Only the normal reviewed release flow publishes skills. No release or merge is authorized by this proposal.", "",
    `Source identity: \`upstream-aspire-source:${source.key}\``,
    sourceMarker(source)
  ].join("\n");
  assert.ok(Buffer.byteLength(body) <= 60000, "Draft PR body exceeds GitHub's limit.");
  return { title, body, diff: item.diff };
}

export async function validateCandidates({ root, output, prepared, review, binding, github, environment = process.env, runCommand = execute }) {
  const repository = new Repository(root);
  immutableSha(review.target.sha);
  assert.deepEqual(review.target, prepared.target);
  const items = [];
  mkdirSync(output, { recursive: true });
  for (const report of review.reports.filter(report => report.status === "draft")) {
    await assertFresh(github, review.target, report.source);
    const candidate = prepared.sources.find(item => item.source.key === report.source.key);
    assert.ok(candidate, "Draft has no immutable assessment evidence.");
    const checked = validateDraft({
      status: report.status, reason: report.reason, api: report.api,
      citations: report.citations.map(({ path, quote }) => ({ path, quote })), edits: report.edits
    }, candidate, prepared.documents);
    const work = join(output, `checkout-${report.source.key}`);
    assert.ok(!existsSync(work), "Refuse to reuse a candidate checkout.");
    repository.run(["clone", "--quiet", "--no-hardlinks", "--no-checkout", root, work]);
    const isolated = new Repository(work);
    const item = { report: { source: report.source, ...checked }, status: "blocked", skills: [...new Set(checked.edits.map(edit => edit.path.split("/")[1]))].sort(), commands: [] };
    try {
      isolated.run(["checkout", "--quiet", "--detach", review.target.sha]);
      assert.equal(isolated.sha("HEAD"), review.target.sha);
      const current = skillDocuments(work);
      assert.deepEqual(current, prepared.documents, "The supplied guidance is not the pinned dev checkout.");
      for (const edit of checked.edits) writeFileSync(join(work, edit.path), replaceLiteral(current[edit.path], edit.before, edit.after));
      const plan = validationPlan(work, checked.edits);
      const scratch = join(work, ".upstream-tmp");
      mkdirSync(scratch);
      let validatedHead;
      for (const [index, command] of plan.entries()) {
        const result = runCommand(command, {
          cwd: work, env: { ...commandEnvironment(environment), TEMP: scratch, TMP: scratch, TMPDIR: scratch }
        });
        assert.ok(Number.isInteger(result.exitCode));
        const log = `${report.source.key}-${index + 1}.log`;
        // Never persist runtime credentials, even when a tool includes one in an error.
        let outputText = result.output;
        if (environment.COPILOT_GITHUB_TOKEN) outputText = outputText.replaceAll(environment.COPILOT_GITHUB_TOKEN, "[REDACTED]");
        writeFileSync(join(output, log), outputText);
        item.commands.push({ command, exitCode: result.exitCode, log });
        if (result.exitCode !== 0) break;
        if (command[0] === "git" && command.includes("commit")) validatedHead = isolated.sha("HEAD");
      }
      if (item.commands.length === plan.length && item.commands.every(command => command.exitCode === 0)) {
        assert.ok(validatedHead);
        assert.equal(isolated.sha("HEAD"), validatedHead, "Validation changed the candidate commit.");
        assert.equal(isolated.run(["status", "--porcelain", "--untracked-files=no"]), "", "Validation modified the committed candidate.");
        const { trials } = checkEvalResults(join(work, ".upstream-results"), item.skills);
        const resultFiles = [];
        const find = path => {
          for (const entry of readdirSync(path, { withFileTypes: true })) {
            if (entry.isDirectory()) find(join(path, entry.name));
            else if (entry.name === "results.jsonl") resultFiles.push(join(path, entry.name));
          }
        };
        find(join(work, ".upstream-results"));
        const covered = new Set();
        for (const path of resultFiles) {
          const records = readFileSync(path, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
          assert.ok(records.filter(record => record.type === "trial-result").every(record => record.gradeResult.passed),
            "A model-backed grade failed.");
          for (const record of records.filter(record => record.type === "run-summary")) {
            for (const evaluation of record.evals.filter(evaluation => evaluation.stimuliRun > 0)) {
              covered.add(resolve(work, evaluation.evalFilePath));
            }
          }
        }
        for (const spec of item.skills.flatMap(skill => evalSpecs(work, skill))) {
          assert.ok(covered.has(resolve(work, spec)), `Model evaluation did not cover ${spec}.`);
        }
        item.trials = trials;
        for (const edit of checked.edits) {
          assert.equal(readFileSync(join(work, edit.path), "utf8"), replaceLiteral(current[edit.path], edit.before, edit.after),
            "Validation altered the exact proposed Markdown replacement.");
        }
        const changed = isolated.run(["diff", "--name-only", "-z", "--no-ext-diff", review.target.sha]).split("\0").filter(Boolean);
        const allowed = allowedPublicationPaths(checked.edits);
        assert.ok(changed.length > 0 && changed.every(path => allowed.has(path)), "Validation modified a file outside the approved Markdown/catalog scope.");
        assert.equal(isolated.run(["ls-files", "--others", "--exclude-standard", "-z", "--", "skills", "opencode"]), "", "Unexpected new published files.");
        item.files = changed.sort().map(path => {
          const stat = lstatSync(join(work, path));
          assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 256 * 1024);
          const content = readFileSync(join(work, path), "utf8");
          return { path, content, digest: digest(content) };
        });
        item.diff = isolated.run(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", review.target.sha, "--", "skills", "opencode"]);
        await assertFresh(github, review.target, report.source);
        item.status = "validated";
        item.report.validation = {
          tests: "passed", catalogs: "passed", lint: "passed", evals: "passed",
          maintainerReview: "required", publication: "approval-required"
        };
        item.preview = previewFor(item, review.target, binding);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    items.push(item);
  }
  const publication = { schema: 1, binding, target: review.target, assessedAt: review.assessedAt, items };
  const json = JSON.stringify(publication, null, 2);
  assert.ok(Buffer.byteLength(json) <= 8 * 1024 * 1024, "Publication bundle exceeds 8 MiB: narrow the source window.");
  writeFileSync(join(output, "publication.json"), json);
  writeFileSync(join(output, "preview.txt"), items.map(item => item.status === "validated"
    ? `SOURCE ${item.report.source.url}\nTITLE\n${item.preview.title}\nBODY\n${item.preview.body}\nDIFF\n${item.preview.diff}`
    : `BLOCKED ${item.report.source.url}\n${item.commands.map(result => `${result.command.join(" ")}: exit ${result.exitCode}`).join("\n")}`).join("\n\n"));
  return { publication, digest: digest(json) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  throw new Error("Invoke validateCandidates from the read-only workflow adapter with its canonical GitHub reader.");
}
