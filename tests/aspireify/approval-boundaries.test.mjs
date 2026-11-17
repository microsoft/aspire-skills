import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { DurableSnapshotStore, resolveAppHostIdentity } from "../../extensions/aspireify/provider-state.mjs";

const stubUrl = new URL("../fixtures/aspireify-sdk-stub.mjs", import.meta.url).href;
registerHooks({
    resolve(specifier, context, next) {
        return specifier === "@github/copilot-sdk/extension"
            ? { url: stubUrl, shortCircuit: true }
            : next(specifier, context);
    },
});
const workspacePath = await mkdtemp(join(tmpdir(), "aspireify-approvals-"));
const session = (globalThis.__aspireifyTestSession = {
    workspacePath, messages: [], confirm: async () => true,
});
await import("../../extensions/aspireify/extension.mjs");
const canvas = session.canvas;
test.after(() => rm(workspacePath, { recursive: true, force: true }));

function action(name, input, instanceId, provider = canvas) {
    return provider.actions.find((candidate) => candidate.name === name).handler({ instanceId, input });
}

function discovery(appHostPath, extra = {}) {
    return {
        appHostPath,
        apphostStyle: "typescript",
        services: [{ id: "api", name: "api", type: "Node.js", path: "src/api", framework: "Express", exposesHttp: true }],
        ...extra,
    };
}

function proposal(appHostPath, proposalGeneration) {
    return {
        appHostPath, proposalGeneration,
        resources: [{ id: "api", name: "api", type: "Node.js", serviceId: "api" }],
        edges: [],
    };
}

async function setup(t, instanceId) {
    const appHostPath = join(workspacePath, instanceId, "AppHost");
    const loaded = await action("load_discovery", discovery(appHostPath), instanceId);
    await action("set_proposal", proposal(appHostPath, loaded.proposalGeneration), instanceId);
    const opened = await canvas.open({ instanceId, input: { appHostPath } });
    t.after(() => canvas.onClose({ instanceId }));
    const url = new URL(opened.url);
    const headers = { "content-type": "application/json", "x-aspireify-token": url.searchParams.get("token") };
    const review = async () => (await fetch(new URL("/api/snapshot", url), { headers })).json();
    const post = async (path, snapshot, extra = {}, requestHeaders = {}) => fetch(new URL(path, url), {
        method: "POST", headers: { ...headers, ...requestHeaders },
        body: JSON.stringify({
            expectedAppHostPath: snapshot.appHostPath,
            expectedRevision: snapshot.revision,
            expectedProposalGeneration: snapshot.proposalGeneration,
            expectedProposalHash: snapshot.proposalHash,
            ...extra,
        }),
    });
    return { appHostPath, loaded, review, post };
}

function hostConfirmation(t, confirm) {
    const previous = session.confirm;
    session.confirm = confirm;
    t.after(() => { session.confirm = previous; });
}

test("all actions reject conflicting targets but accept equivalent canonical spellings", async (t) => {
    const h = await setup(t, "target-match");
    const other = join(workspacePath, "other", "AppHost");
    const identity = await resolveAppHostIdentity(h.appHostPath);
    const store = new DurableSnapshotStore(workspacePath);
    const persistedBefore = await store.load(identity.domainId);
    for (const [name, input] of [
        ["load_discovery", discovery(other)],
        ["set_proposal", proposal(other, h.loaded.proposalGeneration)],
        ["get_confirmation", { appHostPath: other }],
    ]) {
        await assert.rejects(action(name, input, "target-match"), { code: "aspireify_target_mismatch" });
    }
    assert.deepEqual(await store.load(identity.domainId), persistedBefore, "rejected targets must not change durable state");
    const before = await h.review();
    await action("set_proposal", proposal(join(h.appHostPath, "..", "AppHost"), before.proposalGeneration), "target-match");
    const current = await h.review();
    assert.equal(current.appHostPath, before.appHostPath);
    assert.equal((await h.post("/api/confirm", current)).status, 200);
    const confirmed = await action("get_confirmation", { appHostPath: h.appHostPath }, "target-match");
    assert.equal(confirmed.appHostPath, current.appHostPath);
    assert.equal(confirmed.appHostIdentity, (await resolveAppHostIdentity(h.appHostPath)).domainId);
    assert.equal(confirmed.approvedRevision, current.revision);
    assert.equal(confirmed.proposalGeneration, current.proposalGeneration);
    assert.equal(confirmed.proposalHash, current.proposalHash);
    assert.equal(confirmed.approvalSource, "host");
    assert.deepEqual(await action("get_confirmation", {}, "target-match"), confirmed);
});

test("renderer tokens and claimed approval fields cannot replace the host's user decision", async (t) => {
    const unconfirmed = await setup(t, "host-required-confirm");
    const confirmed = await setup(t, "host-required-restart");
    assert.equal((await confirmed.post("/api/confirm", await confirmed.review())).status, 200);
    const approval = await action("get_confirmation", {}, "host-required-restart");
    const messagesBefore = session.messages.length;
    const prompts = [];
    hostConfirmation(t, async (message) => { prompts.push(message); return false; });
    const originalConfirm = session.confirm;
    for (const [confirm, status] of [
        [undefined, 503],
        [originalConfirm, 403],
        [async () => ({ confirmed: true }), 403],
        [async () => { throw new Error("synthetic host failure"); }, 500],
    ]) {
        session.confirm = confirm;
        for (const [h, path] of [
            [unconfirmed, "/api/confirm"],
            [confirmed, "/api/approve-restart"],
        ]) {
            const before = await h.review();
            const response = await h.post(path, before, {
                userApproved: true, approvalSource: "host", confirmed: true,
            });
            assert.equal(response.status, status);
            assert.equal((await h.review()).revision, before.revision);
        }
    }
    assert.equal(prompts.length, 2);
    for (const [index, h] of [unconfirmed, confirmed].entries()) {
        const identity = JSON.parse(prompts[index].split("\n").at(-1));
        const review = await h.review();
        assert.equal(identity.appHostIdentity, (await resolveAppHostIdentity(h.appHostPath)).domainId);
        assert.equal(identity.approvedRevision, review.revision);
        assert.equal(identity.proposalGeneration, review.proposalGeneration);
        assert.equal(identity.proposalHash, review.proposalHash);
    }
    assert.equal(session.messages.length, messagesBefore, "failed host decisions must not claim user approval");
    await assert.rejects(action("get_confirmation", {}, "host-required-confirm"), { code: "aspireify_not_confirmed" });
    assert.deepEqual(await action("get_confirmation", {}, "host-required-restart"), approval);
    await assert.rejects(
        action("load_discovery", discovery(confirmed.appHostPath, { startNewRun: true }), "host-required-restart"),
        { code: "aspireify_restart_approval_required" },
    );
});

test("pending host decisions save nothing and reject a retargeted panel", async (t) => {
    for (const kind of ["confirm", "restart"]) {
        const instanceId = `pending-host-${kind}`;
        const h = await setup(t, instanceId);
        if (kind === "restart") {
            assert.equal((await h.post("/api/confirm", await h.review())).status, 200);
        }
        const before = await h.review();
        const identity = await resolveAppHostIdentity(h.appHostPath);
        const store = new DurableSnapshotStore(workspacePath);
        const persistedBefore = await store.load(identity.domainId);
        const entered = deferred();
        const release = deferred();
        const previous = session.confirm;
        session.confirm = async () => { entered.resolve(); return release.promise; };
        try {
            const pending = h.post(kind === "confirm" ? "/api/confirm" : "/api/approve-restart", before);
            assert.equal(await Promise.race([
                entered.promise.then(() => "prompted"),
                pending.then(() => "responded"),
            ]), "prompted");
            assert.deepEqual(await store.load(identity.domainId), persistedBefore, "no approval may be persisted before the user's response");
            await canvas.open({
                instanceId,
                input: { appHostPath: join(workspacePath, `${instanceId}-replacement`, "AppHost") },
            });
            release.resolve(true);
            assert.equal((await pending).status, 409);
            assert.deepEqual(await store.load(identity.domainId), persistedBefore, "retargeting invalidates an in-flight host decision");
        } finally {
            release.resolve(false);
            session.confirm = previous;
        }
    }
});

test("restart requires current user approval and durably archives confirmation and edit history", async (t) => {
    const instanceId = "restart";
    const h = await setup(t, instanceId);
    let review = await h.review();
    assert.equal((await h.post("/api/service/name", review, { id: "api", value: "edited-api" })).status, 200);
    review = await h.review();
    assert.equal(review.history.canUndo, true);
    assert.equal((await h.post("/api/history/undo", review)).status, 200);
    review = await h.review();
    assert.equal(review.proposal.resources[0].name, "api");
    assert.equal((await h.post("/api/history/redo", review)).status, 200);
    review = await h.review();
    assert.equal(review.proposal.resources[0].name, "edited-api");
    assert.equal((await h.post("/api/confirm", review)).status, 200);
    const confirmation = await action("get_confirmation", { appHostPath: h.appHostPath }, instanceId);
    const identity = await resolveAppHostIdentity(h.appHostPath);
    const store = new DurableSnapshotStore(workspacePath);
    const beforeRestart = await store.load(identity.domainId);
    const restart = () => action("load_discovery", discovery(h.appHostPath, { startNewRun: true }), instanceId);
    await assert.rejects(restart(), { code: "aspireify_restart_approval_required" });
    assert.deepEqual(await action("get_confirmation", {}, instanceId), confirmation);
    assert.equal((await h.post("/api/approve-restart", review)).status, 409, "pre-confirmation revision cannot approve a restart");
    review = await h.review();
    assert.equal((await h.post("/api/approve-restart", review)).status, 200);
    const approved = await h.review();
    assert.equal(approved.restartApproved, true);
    assert.deepEqual(await action("get_confirmation", {}, instanceId), confirmation, "approval alone must not replace the review");

    const originalSave = DurableSnapshotStore.prototype.save;
    DurableSnapshotStore.prototype.save = async () => { throw new Error("synthetic archive write failure"); };
    try {
        await assert.rejects(restart(), /synthetic archive write failure/);
    } finally {
        DurableSnapshotStore.prototype.save = originalSave;
    }
    assert.deepEqual(await action("get_confirmation", {}, instanceId), confirmation);
    const loaded = await restart();
    assert.ok(loaded.proposalGeneration > confirmation.proposalGeneration, "old proposal generations must not be reused");
    await assert.rejects(action("get_confirmation", {}, instanceId), { code: "aspireify_not_confirmed" });
    await assert.rejects(restart(), { code: "aspireify_restart_approval_required" }, "approval is single-use");

    const persisted = await store.load(identity.domainId);
    assert.deepEqual(persisted.archivedRuns.at(-1).confirmation, confirmation);
    assert.deepEqual(persisted.archivedRuns.at(-1).editHistory, beforeRestart.editHistory);
    await import("../../extensions/aspireify/extension.mjs?restored-archive");
    const restored = session.canvas;
    await restored.open({ instanceId: "restored", input: { appHostPath: h.appHostPath } });
    t.after(() => restored.onClose({ instanceId: "restored" }));
    await action("set_proposal", proposal(h.appHostPath, loaded.proposalGeneration), "restored", restored);
    const reloaded = await new DurableSnapshotStore(workspacePath).load(identity.domainId);
    assert.deepEqual(reloaded.archivedRuns, persisted.archivedRuns);
});

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function blockWrite(t, domainId, nextDomainId) {
    const entered = deferred();
    const release = deferred();
    const retargetLoaded = deferred();
    const originalWrite = DurableSnapshotStore.prototype.writeRecord;
    const originalLoad = DurableSnapshotStore.prototype.load;
    DurableSnapshotStore.prototype.writeRecord = async function (target, serialized) {
        if (target === domainId) {
            entered.resolve();
            await release.promise;
        }
        return originalWrite.call(this, target, serialized);
    };
    DurableSnapshotStore.prototype.load = async function (target) {
        const snapshot = await originalLoad.call(this, target);
        if (target === nextDomainId) {
            retargetLoaded.resolve();
        }
        return snapshot;
    };
    t.after(() => {
        release.resolve();
        DurableSnapshotStore.prototype.writeRecord = originalWrite;
        DurableSnapshotStore.prototype.load = originalLoad;
    });
    return { entered, release, retargetLoaded };
}

for (const kind of ["proposal", "discovery", "restart"]) {
    test(`retargeting waits for a pending ${kind} commit`, async (t) => {
        const instanceId = `committing-${kind}`;
        const h = await setup(t, instanceId);
        if (kind === "restart") {
            assert.equal((await h.post("/api/service/name", await h.review(), { id: "api", value: "edited-api" })).status, 200);
            assert.equal((await h.post("/api/confirm", await h.review())).status, 200);
            assert.equal((await h.post("/api/approve-restart", await h.review())).status, 200);
        }
        const identity = await resolveAppHostIdentity(h.appHostPath);
        const replacement = join(workspacePath, `${instanceId}-replacement`, "AppHost");
        const nextIdentity = await resolveAppHostIdentity(replacement);
        const store = new DurableSnapshotStore(workspacePath);
        const before = await store.load(identity.domainId);
        const gate = blockWrite(t, identity.domainId, nextIdentity.domainId);
        const writing = (kind === "proposal"
            ? action("set_proposal", {
                ...proposal(h.appHostPath, h.loaded.proposalGeneration),
                resources: [{ id: "api", name: "updated-api", type: "Node.js", serviceId: "api" }],
            }, instanceId)
            : action("load_discovery", discovery(h.appHostPath, {
                repoName: "updated-repository",
                ...(kind === "restart" ? { startNewRun: true } : {}),
            }), instanceId)
        ).then((value) => ({ value }), (error) => ({ error }));
        let retarget;
        try {
            await gate.entered.promise;
            let retargeted = false;
            retarget = canvas.open({ instanceId, input: { appHostPath: replacement } }).then((result) => {
                retargeted = true;
                return result;
            });
            await gate.retargetLoaded.promise;
            await nextTurn();
            assert.equal(retargeted, false, "the binding must remain stable until the action finishes");
            assert.deepEqual(await store.load(identity.domainId), before);
            gate.release.resolve();
            const outcome = await writing;
            assert.ifError(outcome.error);
            assert.equal(outcome.value.ok, true);
            await retarget;
            assert.equal((await h.review()).appHostPath, nextIdentity.appHostPath);
            const after = await store.load(identity.domainId);
            assert.equal(after.revision, before.revision + 1);
            assert.equal(await store.load(nextIdentity.domainId), null, "retargeting must not write the replacement target");
            if (kind === "proposal") {
                assert.equal(after.proposal.resources[0].name, "updated-api");
            } else {
                assert.equal(after.repoName, "updated-repository");
                assert.equal(after.proposalGeneration, before.proposalGeneration + 1);
            }
            if (kind === "restart") {
                assert.equal(after.confirmation, null);
                assert.equal(after.restartApproval, null);
                assert.deepEqual(after.archivedRuns.at(-1).confirmation, before.confirmation);
                assert.deepEqual(after.archivedRuns.at(-1).editHistory, before.editHistory);
            }
        } finally {
            gate.release.resolve();
            await Promise.allSettled([writing, retarget]);
        }
    });
}

test("closing a panel waits for its active canvas action to commit", async (t) => {
    const instanceId = "closing-commit";
    const h = await setup(t, instanceId);
    const identity = await resolveAppHostIdentity(h.appHostPath);
    const store = new DurableSnapshotStore(workspacePath);
    const before = await store.load(identity.domainId);
    const gate = blockWrite(t, identity.domainId);
    const writing = action("set_proposal", proposal(h.appHostPath, h.loaded.proposalGeneration), instanceId)
        .then((value) => ({ value }), (error) => ({ error }));
    let closing;
    try {
        await gate.entered.promise;
        closing = canvas.onClose({ instanceId });
        await nextTurn();
        gate.release.resolve();
        const outcome = await writing;
        assert.ifError(outcome.error);
        assert.equal(outcome.value.ok, true);
        await closing;
        assert.equal((await store.load(identity.domainId)).revision, before.revision + 1);
        await canvas.open({ instanceId, input: { appHostPath: h.appHostPath } });
    } finally {
        gate.release.resolve();
        await Promise.allSettled([writing, closing]);
    }
});

test("closing a pending host prompt does not block opening another target", async (t) => {
    const instanceId = "closing-prompt";
    const h = await setup(t, instanceId);
    const identity = await resolveAppHostIdentity(h.appHostPath);
    const replacement = join(workspacePath, `${instanceId}-replacement`, "AppHost");
    const nextIdentity = await resolveAppHostIdentity(replacement);
    const store = new DurableSnapshotStore(workspacePath);
    const before = await store.load(identity.domainId);
    const gate = blockWrite(t, identity.domainId, nextIdentity.domainId);
    const asked = deferred();
    const answer = deferred();
    hostConfirmation(t, async () => { asked.resolve(); return answer.promise; });
    const confirming = h.post("/api/confirm", await h.review(), {}, { Connection: "close" }).then(async (response) => {
        await response.text();
        return response.status;
    });
    let closing;
    let reopening;
    try {
        await asked.promise;
        closing = canvas.onClose({ instanceId });
        let reopened = false;
        reopening = canvas.open({ instanceId, input: { appHostPath: replacement } }).then(() => { reopened = true; });
        await gate.retargetLoaded.promise;
        await nextTurn();
        assert.equal(reopened, true, "server cleanup must not hold the binding while a host prompt is pending");
        answer.resolve(true);
        assert.equal(await confirming, 409);
        await Promise.all([closing, reopening]);
        assert.deepEqual(await store.load(identity.domainId), before, "a closed prompt must not persist approval");
    } finally {
        answer.resolve(false);
        gate.release.resolve();
        await Promise.allSettled([confirming, closing, reopening]);
    }
});

test("queued actions reject a retargeted binding without writing after the active commit", async (t) => {
    const instanceId = "queued";
    const h = await setup(t, instanceId);
    const identity = await resolveAppHostIdentity(h.appHostPath);
    const replacement = join(workspacePath, "retargeted", "AppHost");
    const nextIdentity = await resolveAppHostIdentity(replacement);
    const store = new DurableSnapshotStore(workspacePath);
    const before = await store.load(identity.domainId);
    const gate = blockWrite(t, identity.domainId, nextIdentity.domainId);
    const operations = [];
    try {
        const writing = action("set_proposal", proposal(h.appHostPath, h.loaded.proposalGeneration), instanceId);
        const written = writing.then((value) => ({ value }), (error) => ({ error }));
        operations.push(written);
        await gate.entered.promise;
        const queued = [
            action("load_discovery", discovery(), instanceId),
            action("set_proposal", proposal(undefined, h.loaded.proposalGeneration), instanceId),
            action("get_confirmation", {}, instanceId),
        ];
        const rejected = queued.map((operation) => assert.rejects(operation, { code: "aspireify_target_mismatch" }));
        operations.push(...rejected);
        const retarget = canvas.open({ instanceId, input: { appHostPath: replacement } });
        operations.push(retarget);
        await gate.retargetLoaded.promise;
        await nextTurn();
        gate.release.resolve();
        const outcome = await written;
        assert.ifError(outcome.error);
        await Promise.all([retarget, ...rejected]);
        await canvas.open({ instanceId, input: { appHostPath: h.appHostPath } });
        const after = await h.review();
        assert.equal(after.proposalGeneration, h.loaded.proposalGeneration, "queued discovery must not mutate the original target");
        assert.equal((await store.load(identity.domainId)).revision, before.revision + 1);
    } finally {
        gate.release.resolve();
        await Promise.allSettled(operations);
    }
});

test("restart approval cannot cross targets or survive a changed revision", async (t) => {
    const h = await setup(t, "stale-approval");
    assert.equal((await h.post("/api/confirm", await h.review())).status, 200);
    assert.equal((await h.post("/api/approve-restart", await h.review())).status, 200);
    const identity = await resolveAppHostIdentity(h.appHostPath);
    const store = new DurableSnapshotStore(workspacePath);
    const persisted = await store.load(identity.domainId);
    persisted.revision += 1;
    await store.save(identity.domainId, persisted);
    await import("../../extensions/aspireify/extension.mjs?stale-approval");
    const restored = session.canvas;
    await restored.open({ instanceId: "stale-restored", input: { appHostPath: h.appHostPath } });
    t.after(() => restored.onClose({ instanceId: "stale-restored" }));
    await assert.rejects(
        action("load_discovery", discovery(h.appHostPath, { startNewRun: true }), "stale-restored", restored),
        { code: "aspireify_restart_approval_required" },
    );
    const other = await setup(t, "approval-other-target");
    assert.equal((await other.post("/api/confirm", await other.review())).status, 200);
    await assert.rejects(
        action("load_discovery", discovery(other.appHostPath, { startNewRun: true }), "approval-other-target"),
        { code: "aspireify_restart_approval_required" },
    );
});

test("failed restart notifications preserve approval and can be retried", async (t) => {
    let promptCount = 0;
    hostConfirmation(t, async () => { promptCount += 1; return true; });
    const h = await setup(t, "restart-notification");
    assert.equal((await h.post("/api/confirm", await h.review())).status, 200);
    session.sendError = new Error("synthetic chat failure");
    try {
        const response = await h.post("/api/approve-restart", await h.review());
        assert.equal(response.status, 202);
        assert.deepEqual(await response.json(), { ok: true, delivered: false, error: "synthetic chat failure" });
        const pending = await h.review();
        assert.equal(pending.restartApproved, true);
        assert.equal(pending.restartNotificationPending, true);
        assert.equal(pending.confirmed, true);
    } finally {
        delete session.sendError;
    }
    const identity = await resolveAppHostIdentity(h.appHostPath);
    const store = new DurableSnapshotStore(workspacePath);
    const pendingApproval = (await store.load(identity.domainId)).restartApproval;
    assert.equal((await h.post("/api/approve-restart", await h.review())).status, 200);
    const delivered = await h.review();
    assert.equal(delivered.restartApproved, true);
    assert.equal(delivered.restartNotificationPending, false);
    assert.equal(promptCount, 2, "notification retries must reuse the saved host decision");
    const deliveredApproval = (await store.load(identity.domainId)).restartApproval;
    assert.equal(deliveredApproval.approvedRevision, pendingApproval.approvedRevision);
    const messageCount = session.messages.length;
    assert.equal((await h.post("/api/approve-restart", delivered)).status, 200);
    assert.equal((await h.review()).revision, delivered.revision, "repeated approval is idempotent");
    assert.equal(session.messages.length, messageCount);
    await action("load_discovery", discovery(h.appHostPath, { startNewRun: true }), "restart-notification");
    assert.equal((await h.review()).confirmed, false);
});

test("confirmation notification retries preserve the host-approved snapshot", async (t) => {
    const h = await setup(t, "confirmation-notification");
    let promptCount = 0;
    hostConfirmation(t, async () => { promptCount += 1; return true; });
    session.sendError = new Error("synthetic confirmation notification failure");
    try {
        assert.equal((await h.post("/api/confirm", await h.review())).status, 202);
    } finally {
        delete session.sendError;
    }
    const approval = await action("get_confirmation", {}, "confirmation-notification");
    assert.equal(approval.approvalSource, "host");
    assert.equal((await h.post("/api/confirm", await h.review())).status, 200);
    assert.equal(promptCount, 1, "retrying chat delivery is not another approval");
    assert.deepEqual(await action("get_confirmation", {}, "confirmation-notification"), approval);
});

test("saved approvals without host provenance cannot authorize readback or a restart", async (t) => {
    const h = await setup(t, "untrusted-saved-approval");
    assert.equal((await h.post("/api/confirm", await h.review())).status, 200);
    assert.equal((await h.post("/api/approve-restart", await h.review())).status, 200);
    const identity = await resolveAppHostIdentity(h.appHostPath);
    const store = new DurableSnapshotStore(workspacePath);
    const persisted = await store.load(identity.domainId);
    delete persisted.confirmation.approvalSource;
    delete persisted.restartApproval.approvalSource;
    await store.save(identity.domainId, persisted);
    await import("../../extensions/aspireify/extension.mjs?untrusted-saved-approval");
    const restored = session.canvas;
    const instanceId = "untrusted-restored";
    const opened = await restored.open({ instanceId, input: { appHostPath: h.appHostPath } });
    t.after(() => restored.onClose({ instanceId }));
    await assert.rejects(action("get_confirmation", {}, instanceId, restored), {
        code: "aspireify_user_confirmation_required",
    });
    await assert.rejects(
        action("load_discovery", discovery(h.appHostPath, { startNewRun: true }), instanceId, restored),
        { code: "aspireify_restart_approval_required" },
    );
    const url = new URL(opened.url);
    const headers = { "content-type": "application/json", "x-aspireify-token": url.searchParams.get("token") };
    const review = await (await fetch(new URL("/api/snapshot", url), { headers })).json();
    assert.equal(review.restartApproved, false);
    const body = JSON.stringify({
        expectedAppHostPath: review.appHostPath, expectedRevision: review.revision,
        expectedProposalGeneration: review.proposalGeneration, expectedProposalHash: review.proposalHash,
    });
    const retry = await fetch(new URL("/api/confirm", url), { method: "POST", headers, body });
    assert.equal(retry.status, 409, "legacy confirmation cannot be laundered through notification retry");
    const restart = await fetch(new URL("/api/approve-restart", url), { method: "POST", headers, body });
    assert.equal(restart.status, 200, "a new host decision can authorize replacing an old review");
    await action("load_discovery", discovery(h.appHostPath, { startNewRun: true }), instanceId, restored);
    const archived = (await store.load(identity.domainId)).archivedRuns.at(-1);
    assert.deepEqual(archived.confirmation, persisted.confirmation, "legacy evidence is archived without inventing user provenance");
});

test("legacy approvals without target and revision fail explicitly instead of inventing identity", async (t) => {
    const appHostPath = join(workspacePath, "legacy", "AppHost");
    const identity = await resolveAppHostIdentity(appHostPath);
    const legacy = {
        services: [],
        proposal: { resources: [], edges: [] },
        confirmation: { confirmed: true, proposalGeneration: 1, proposalHash: "legacy" },
    };
    await new DurableSnapshotStore(workspacePath).save(identity.domainId, legacy);
    await canvas.open({ instanceId: "legacy", input: { appHostPath } });
    t.after(() => canvas.onClose({ instanceId: "legacy" }));
    await assert.rejects(action("get_confirmation", { appHostPath }, "legacy"), {
        code: "aspireify_confirmation_identity_missing",
    });
});
