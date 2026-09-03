import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  beginDiagnosticsRun,
  completeDiagnosticsRun,
  listenOnLoopback,
  readJsonBody,
  requestErrorStatus,
  runLatestDiagnostics
} from "../extensions/aspire-doctor/provider-helpers.mjs";
import {
  normalizeDoctorData,
  shouldApplyResult,
  summaryStatusText
} from "../extensions/aspire-doctor/ui/model.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = join(repoRoot, "extensions", "aspire-doctor");

test("doctor summaries are derived from the visible checks", () => {
  const data = normalizeDoctorData({
    checks: [
      { name: "sdk", status: "passed" },
      { name: "cli", status: "warn" },
      { name: "docker", status: "failed" }
    ],
    summary: { passed: 99, warnings: 88, failed: 77 }
  });

  assert.deepEqual(data.summary, { passed: 1, warnings: 1, failed: 1 });
  assert.deepEqual(data.notices, [{
    title: "Doctor summary adjusted",
    message: "The reported summary did not match the checks. Counts were recalculated from the visible results."
  }]);
});

test("empty diagnostics use neutral status copy", () => {
  const data = normalizeDoctorData({ checks: [], summary: { passed: 0, warnings: 0, failed: 0 } });

  assert.deepEqual(data.summary, { passed: 0, warnings: 0, failed: 0 });
  assert.equal(summaryStatusText(data.summary, data.checks.length), "No checks reported");
});

test("missing checks report a format notice", () => {
  const data = normalizeDoctorData({ summary: { passed: 0, warnings: 0, failed: 0 } });

  assert.equal(data.checks.length, 0);
  assert.equal(data.notices[0].title, "Doctor output format changed");
});

test("older diagnostics revisions cannot replace newer results", () => {
  assert.equal(shouldApplyResult(4, { revision: 3 }), false);
  assert.equal(shouldApplyResult(4, { revision: 4 }), false);
  assert.equal(shouldApplyResult(4, { revision: 5 }), true);
  assert.equal(shouldApplyResult(4, { revision: 5, superseded: true }), false);
  assert.equal(shouldApplyResult(4, {}), true);
});

test("provider revisions identify superseded runs", () => {
  const entry = {};
  const first = beginDiagnosticsRun(entry);
  const second = beginDiagnosticsRun(entry);
  const firstCompletion = completeDiagnosticsRun(entry, first, { ok: true });
  const secondCompletion = completeDiagnosticsRun(entry, second, { ok: true });

  assert.equal(firstCompletion.isCurrent, false);
  assert.equal(firstCompletion.result.revision, 1);
  assert.equal(firstCompletion.result.superseded, true);
  assert.equal(secondCompletion.isCurrent, true);
  assert.equal(secondCompletion.result.revision, 2);
  assert.equal(secondCompletion.result.superseded, false);
});

test("only the newest overlapping diagnostics run is published", async () => {
  const entry = {};
  const firstRun = deferred();
  const secondRun = deferred();
  const published = [];

  const firstCompletion = runLatestDiagnostics(entry, () => firstRun.promise, (result) => published.push(result));
  const secondCompletion = runLatestDiagnostics(entry, () => secondRun.promise, (result) => published.push(result));

  secondRun.resolve({ ok: true, data: { value: "new" } });
  assert.equal((await secondCompletion).isCurrent, true);
  firstRun.resolve({ ok: true, data: { value: "old" } });
  assert.equal((await firstCompletion).isCurrent, false);

  assert.deepEqual(published, [{
    ok: true,
    data: { value: "new" },
    revision: 2,
    superseded: false
  }]);
});

test("JSON request bodies have deterministic validation errors", async () => {
  const invalid = new PassThrough();
  const invalidResult = readJsonBody(invalid);
  invalid.end("{");
  await assert.rejects(invalidResult, (error) => {
    assert.equal(requestErrorStatus(error), 400);
    assert.match(error.message, /^Invalid JSON:/);
    return true;
  });

  const oversized = new PassThrough();
  const oversizedResult = readJsonBody(oversized, 8);
  oversized.end('{"value":"too large"}');
  await assert.rejects(oversizedResult, (error) => {
    assert.equal(requestErrorStatus(error), 413);
    assert.equal(error.message, "Request body too large.");
    return true;
  });
});

test("loopback startup removes temporary error listeners", async () => {
  class TestServer extends EventEmitter {
    constructor(error = null) {
      super();
      this.error = error;
    }

    listen(port, host, callback) {
      assert.equal(port, 0);
      assert.equal(host, "127.0.0.1");
      queueMicrotask(() => {
        if (this.error) {
          this.emit("error", this.error);
        } else {
          callback();
        }
      });
    }
  }

  const successfulServer = new TestServer();
  await listenOnLoopback(successfulServer);
  assert.equal(successfulServer.listenerCount("error"), 0);

  const failedServer = new TestServer(new Error("bind failed"));
  await assert.rejects(listenOnLoopback(failedServer), /bind failed/);
  assert.equal(failedServer.listenerCount("error"), 0);

  class ThrowingServer extends EventEmitter {
    listen() {
      throw new Error("listen threw");
    }
  }

  const throwingServer = new ThrowingServer();
  await assert.rejects(listenOnLoopback(throwingServer), /listen threw/);
  assert.equal(throwingServer.listenerCount("error"), 0);
});

test("renderer exposes responsive and accessible review controls", async () => {
  const [html, app, styles] = await Promise.all([
    readFile(join(extensionRoot, "ui", "index.html"), "utf8"),
    readFile(join(extensionRoot, "ui", "app.js"), "utf8"),
    readFile(join(extensionRoot, "ui", "styles.css"), "utf8")
  ]);

  assert.match(html, /<h1[^>]+id="page-title"/);
  assert.match(html, /id="tb-sub" role="status" aria-live="polite"/);
  assert.match(html, /id="error"[^>]+role="alert"/);
  assert.match(html, /id="toggle-passed"/);
  assert.match(html, /id="toggle-details"/);
  assert.match(app, /devtools: "Developer tools"/);
  assert.match(app, /latestVersionChannel: "Latest channel"/);
  assert.match(app, /Copy command/);
  assert.match(app, /"aria-description": value/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]+\.diag-fix[\s\S]+flex-direction: column/);
  assert.match(styles, /@media \(max-width: 430px\)[\s\S]+\.diag-fix-actions[\s\S]+grid-template-columns/);
  assert.match(styles, /@media \(pointer: coarse\)/);
});

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
