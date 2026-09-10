import assert from "node:assert/strict";
import test from "node:test";
import {
    confirmationIsDisabled,
    createFieldOperationCoordinator,
    fieldOperationKey,
    operationFailureChannel,
    selectionFocusTarget,
} from "../../extensions/aspireify/ui/interaction-model.js";

test("field reset invalidates a pending blur save and can run after it settles", async () => {
    const coordinator = createFieldOperationCoordinator();
    const key = fieldOperationKey("api", "name");
    let finishSave;
    const dirtySave = new Promise((resolve) => {
        finishSave = resolve;
    });
    const saveVersion = coordinator.begin(key);
    coordinator.track(key, dirtySave);

    const resetVersion = coordinator.invalidate(key);
    const settled = coordinator.settle(key);
    finishSave();
    await settled;

    assert.equal(coordinator.isCurrent(key, saveVersion), false);
    assert.equal(coordinator.isCurrent(key, resetVersion), true);
});

test("stacked activation moves focus to the inspector while arrow navigation stays visible", () => {
    assert.equal(selectionFocusTarget({ narrow: true, activation: "activate" }), "inspector");
    assert.equal(selectionFocusTarget({ narrow: true, activation: "navigate" }), "overview");
    assert.equal(selectionFocusTarget({ narrow: false, activation: "activate" }), "overview");
});

test("a failed mutation blocks confirmation until the displayed state is reconciled", () => {
    assert.equal(
        confirmationIsDisabled({
            proposalLoaded: true,
            proposalStale: false,
            issueCount: 0,
            confirmed: false,
            confirmationDelivered: false,
            pendingMutations: 0,
            mutationError: "The reset could not be saved.",
        }),
        true,
    );
    assert.equal(
        confirmationIsDisabled({
            proposalLoaded: true,
            proposalStale: false,
            issueCount: 0,
            confirmed: false,
            confirmationDelivered: false,
            pendingMutations: 0,
            mutationError: "",
        }),
        false,
    );
});

test("a durable confirmation can retry its chat handoff", () => {
    assert.equal(
        confirmationIsDisabled({
            proposalLoaded: true,
            proposalStale: false,
            issueCount: 0,
            confirmed: true,
            confirmationDelivered: false,
            pendingMutations: 0,
            mutationError: "",
        }),
        false,
    );
    assert.equal(
        confirmationIsDisabled({
            proposalLoaded: true,
            proposalStale: false,
            issueCount: 0,
            confirmed: true,
            confirmationDelivered: true,
            pendingMutations: 0,
            mutationError: "",
        }),
        true,
    );
});

test("a failed durable confirmation can be retried without changing the proposal", () => {
    assert.equal(
        operationFailureChannel({ confirmationAction: true, confirmed: false }),
        "confirmation",
    );
    assert.equal(
        confirmationIsDisabled({
            proposalLoaded: true,
            proposalStale: false,
            issueCount: 0,
            confirmed: false,
            confirmationDelivered: false,
            pendingMutations: 0,
            mutationError: "",
        }),
        false,
    );
    assert.equal(
        operationFailureChannel({ confirmationAction: true, confirmed: true }),
        "handoff",
    );
    assert.equal(
        operationFailureChannel({ confirmationAction: false, confirmed: false }),
        "mutation",
    );
});
