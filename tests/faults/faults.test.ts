// Mandatory failure scenarios T03-T05, T07-T10, T13, T17, T18 against real PostgreSQL and the fixture.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Coordinator } from "@vap/core";
import type { Journal, JournalTx } from "@vap/core";
import { PROTOCOL_VERSION, VapError } from "@vap/protocol";
import type { Grant } from "@vap/protocol";
import { recordScenario, writeReport } from "../helpers/report.ts";
import { AGENT, APPROVER, DIGEST_KEY, key, OPERATOR, ownerCheck, sleep, startHarness } from "../helpers/harness.ts";
import type { Harness } from "../helpers/harness.ts";

const isCode = (code: string) => (e: unknown) => e instanceof VapError && e.code === code;
let h: Harness;
let grant: Grant;
const linux = process.platform === "linux";

before(async () => {
  h = await startHarness({ coordinator: { claimLeaseMs: 3000 } });
  grant = await h.grant();
});
after(async () => {
  await writeReport("faults");
  await h?.close();
});

async function createPlan(title = "Fault create", g: Grant = grant) {
  const task = await h.task(g, [ownerCheck("bob")]);
  return h.agent.prepare({ task_id: task.id, action_id: "issues.create", arguments: { title, owner: "bob" } });
}

/**
 * Simulates a worker that durably recorded dispatch intent and then died. With dropOutbox the
 * outbox item is also gone (a lost job launch), so only the scheduled sweeper can find it.
 */
async function simulateIntentThenCrash(operationId: string, dropOutbox = true): Promise<void> {
  await h.journal.transaction(async (tx) => {
    const fence = await tx.acquireClaim(operationId, "doomed-worker", 200);
    assert.ok(fence);
    const op = (await tx.getOperation(operationId, true))!;
    const now = new Date().toISOString();
    await tx.insertAttempt({ operation_id: op.id, sequence: 1, worker_id: "doomed-worker", fence: fence!, dispatch_intent_at: now, submission: null, finished_at: null, external_handle: null, outcome: null });
    op.execution_status = "running";
    op.attempts = 1;
    op.submitted_at = now;
    op.updated_at = now;
    await tx.updateOperation(op);
    await tx.appendEvent(op.id, "dispatch.intent", "worker:doomed-worker", { attempt: 1, fence });
  });
  if (dropOutbox) await h.journal.pool.query("UPDATE outbox SET completed_at = now() WHERE operation_id = $1 AND completed_at IS NULL", [operationId]);
  await sleep(300);
}

describe("T03 crash before durable acceptance", () => {
  test("a failure inside the acceptance transaction acknowledges nothing; a later submission works", async () => {
    const plan = await createPlan("T03");
    let armed = true;
    const faulty: Journal = {
      transaction: <T>(fn: (tx: JournalTx) => Promise<T>) =>
        h.journal.transaction((tx) =>
          fn(
            new Proxy(tx, {
              get(target, prop) {
                const v = (target as unknown as Record<string | symbol, unknown>)[prop];
                if (prop === "appendEvent" && armed) {
                  return async () => {
                    armed = false;
                    throw new Error("simulated process crash before commit");
                  };
                }
                return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
              },
            }),
          ),
        ),
      ping: () => h.journal.ping(),
      close: async () => {},
    };
    const crashing = new Coordinator(faulty, h.registry, { digestKey: DIGEST_KEY, deploymentId: "test" });
    const k = key("t03");
    await assert.rejects(crashing.submitOperation(AGENT, { protocol_version: PROTOCOL_VERSION, plan_id: plan.id, request_key: k }), /simulated process crash/);
    const { rows } = await h.journal.pool.query("SELECT count(*)::int AS n FROM operations WHERE plan_id = $1", [plan.id]);
    assert.equal(rows[0].n, 0, "no acknowledged operation");
    const ok = await h.agent.execute(plan.id, k);
    assert.equal(ok.replayed, false);
    await h.drain();
    assert.equal((await h.agent.getOperation(ok.operation.id)).execution_status, "completed");
    recordScenario("T03", true);
  });
});

describe("T04 crash after dispatch intent before the reply is recorded", () => {
  test("never-delivered request: reconcile proves non-submission, then resubmits under the dedup contract", async () => {
    const plan = await createPlan("T04a");
    const { operation } = await h.agent.execute(plan.id, key("t04a"));
    await simulateIntentThenCrash(operation.id);
    assert.equal((await h.agent.getOperation(operation.id)).execution_status, "running");
    const sweep = await h.coordinator.sweep("sweeper");
    assert.ok(sweep.orphaned >= 1);
    await h.drain();
    const op = await h.agent.waitForOperation(operation.id);
    assert.equal(op.execution_status, "completed");
    assert.equal(op.attempts, 2);
    // The original key was sealed by the definitive lookup; the resubmission used a fresh key.
    assert.equal((await h.control(`/writes/${operation.id}`)).writes, 0);
    assert.equal((await h.control(`/writes/${operation.id}.a2`)).writes, 1);
    const types = (await h.agent.events(operation.id)).events.map((e) => [e.type, e.data.resolution]);
    assert.ok(types.some(([t, r]) => t === "reconcile.result" && r === "resubmitted_with_dedup"));
    recordScenario("T04a", true);
  });

  test("delivered-then-crashed request: reconcile finds the effect and never duplicates it", async () => {
    const plan = await createPlan("T04b");
    const { operation } = await h.agent.execute(plan.id, key("t04b"));
    // The dispatch outbox item survives: its lease expires and a duplicate start reconciles instead of resubmitting.
    await simulateIntentThenCrash(operation.id, false);
    // The in-flight request reached the destination and committed before the crash.
    await fetch(h.fixture.url + "/issues", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": operation.id }, body: JSON.stringify({ title: "T04b", owner: "bob" }) });
    await h.drain();
    const op = await h.agent.waitForOperation(operation.id);
    assert.equal(op.execution_status, "completed");
    assert.equal(op.attempts, 1, "no new submission");
    assert.equal((await h.control(`/writes/${operation.id}`)).writes, 1);
    recordScenario("T04b", true);
  });

  test("without a destination lookup the outcome stays unknown and needs an operator", async () => {
    const issue = await h.seedIssue("alice");
    const task = await h.task(grant, []);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner_best_effort", arguments: { issue_id: issue.id, owner: "bob" } });
    const { operation } = await h.agent.execute(plan.id, key("t04c"));
    await simulateIntentThenCrash(operation.id);
    const r = await h.agent.reconcile(operation.id);
    assert.equal(r.operation.execution_status, "unknown");
    assert.equal(r.resolution, "operator_resolution_required");
    assert.equal(r.operation.attempts, 1, "never a blind mutation retry");
    assert.equal((await h.agent.receipt(operation.id)).retry_guidance.disposition, "reconcile_first");
    await assert.rejects(h.agent.recover(operation.id, "compensate", key()), isCode("OUTCOME_UNKNOWN"));
    const resolved = await h.coordinator.resolveOperation(OPERATOR, operation.id, { protocol_version: PROTOCOL_VERSION, execution_status: "failed", effects: [{ side_effect_id: "owner_changed", status: "not_applied" }], note: "checked destination audit log; no write" });
    assert.equal(resolved.execution_status, "failed");
    recordScenario("T04c", true);
  });
});

describe("T05 destination commits and the reply is dropped", () => {
  test("operation becomes unknown, lookup recovers the original effect without duplication", async () => {
    const plan = await createPlan("T05");
    await h.fault("lost_reply", { count: 1 });
    const { operation } = await h.agent.execute(plan.id, key("t05"));
    await h.drain();
    const unknown = await h.agent.getOperation(operation.id);
    assert.equal(unknown.execution_status, "unknown");
    assert.equal(unknown.outcome, "unknown");
    assert.equal(unknown.unresolved, true);
    const r = await h.agent.reconcile(operation.id);
    assert.equal(r.resolution, "found_applied");
    await h.drain();
    const op = await h.agent.getOperation(operation.id);
    assert.equal(op.outcome, "verified");
    assert.equal((await h.control(`/writes/${operation.id}`)).writes, 1);
    recordScenario("T05", true);
  });
});

describe("T07 eventually consistent reads", () => {
  test("verification waits for the operation's version instead of failing", async () => {
    const issue = await h.seedIssue("alice");
    const task = await h.task(grant, [ownerCheck("bob", `issue://issue-tracker/issues/${issue.id}`, { deadline_seconds: 15 })]);
    await h.fault("delay_visibility", { count: 1, delay_ms: 2500 });
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issue.id, owner: "bob" } });
    const { operation } = await h.agent.execute(plan.id, key("t07a"));
    await h.drain();
    const op = await h.agent.waitForOperation(operation.id, { timeoutMs: 30_000 });
    assert.equal(op.verification_status, "passed");
    recordScenario("T07a", true);
  });

  test("a deadline reached while reads are stale is inconclusive, not a failure, and triggers no retry", async () => {
    const issue = await h.seedIssue("alice");
    const task = await h.task(grant, [ownerCheck("bob", `issue://issue-tracker/issues/${issue.id}`, { deadline_seconds: 1 })]);
    await h.fault("delay_visibility", { count: 1, delay_ms: 6000 });
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issue.id, owner: "bob" } });
    const { operation } = await h.agent.execute(plan.id, key("t07b"));
    await h.drain();
    const op = await h.agent.waitForOperation(operation.id);
    assert.equal(op.execution_status, "completed");
    assert.equal(op.verification_status, "inconclusive");
    assert.equal(op.outcome, "completed_unverified");
    assert.equal(op.attempts, 1);
    const ev = (await h.agent.evidence(op.id)).find((e) => e.item_index === null)!;
    assert.equal(ev.result, "inconclusive");
    assert.equal(ev.freshness, "stale");
    await sleep(6000);
    const again = await h.agent.verify(op.id);
    assert.equal(again.operation.verification_status, "passed", "a later fresh read passes");
    recordScenario("T07b", true);
  });
});

describe("T08 batch partly succeeds", () => {
  test("per-item effects, partial status, and recovery only for identified effects", async () => {
    const task = await h.task(grant, [{ ...ownerCheck("bob", "{effect.resource_uri}"), scope: "each_effect" }]);
    await h.fault("partial_batch", { count: 1, fail_after: 2 });
    const items = [1, 2, 3, 4].map((i) => ({ title: `Batch item ${i}`, owner: "bob" }));
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.batch_create", arguments: { items } });
    assert.equal(plan.preview.effects[0].item_count, 4);
    const { operation } = await h.agent.execute(plan.id, key("t08"));
    await h.drain();
    const op = await h.agent.waitForOperation(operation.id);
    assert.equal(op.execution_status, "partial");
    assert.equal(op.outcome, "partially_applied");
    assert.equal(op.effects.filter((e) => e.status === "applied").length, 2);
    assert.equal(op.effects.filter((e) => e.status === "not_applied").length, 2);
    assert.equal(op.verification_status, "failed", "aggregate invariant: 2 of 4 items");
    const receipt = await h.agent.receipt(op.id);
    assert.equal(receipt.checks.filter((c) => c.item_index !== null).length, 2, "per-item evidence");
    const rec = await h.agent.recover(op.id, "compensate", key("t08rec"));
    assert.deepEqual(rec.recovery_plan.canonical_arguments.issue_ids, op.effects.filter((e) => e.status === "applied").map((e) => e.resource_uri!.split("/").pop()));
    await h.drain();
    const original = await h.agent.getOperation(op.id);
    assert.equal(original.recovery_status, "succeeded");
    assert.equal(original.execution_status, "partial", "history preserved");
    recordScenario("T08", true);
  });
});

describe("T09 approval binding", () => {
  test("expired, replayed, self-issued, mismatched and denied approvals never dispatch", async () => {
    const strict = await h.grant({ preauthorized_actions: [] });
    const before = await h.control("/stats");
    const plan = await createPlan("T09", strict);
    assert.equal(plan.status, "awaiting_approval");
    await assert.rejects(h.agent.execute(plan.id, key()), isCode("APPROVAL_REQUIRED"));
    // self-approval: the executing principal holding the approver role
    await assert.rejects(h.coordinator.decideApproval({ ...AGENT, roles: ["agent", "approver"] }, { protocol_version: PROTOCOL_VERSION, plan_id: plan.id, plan_digest: plan.digest, decision: "approved" }), isCode("FORBIDDEN"));
    // agents cannot approve at all
    await assert.rejects(h.agent.decideApproval({ plan_id: plan.id, plan_digest: plan.digest, decision: "approved" }), isCode("FORBIDDEN"));
    // digest of a different plan
    const other = await createPlan("T09 changed arguments", strict);
    await assert.rejects(h.approver.decideApproval({ plan_id: plan.id, plan_digest: other.digest, decision: "approved" }), isCode("CONFLICT"));
    // expired approval
    await h.approver.decideApproval({ plan_id: plan.id, plan_digest: plan.digest, decision: "approved", expires_in_seconds: 10 });
    const future = new Coordinator(h.journal, h.registry, { digestKey: DIGEST_KEY, deploymentId: "test", clock: () => Date.now() + 60_000 });
    await assert.rejects(future.submitOperation(AGENT, { protocol_version: PROTOCOL_VERSION, plan_id: plan.id, request_key: key() }), isCode("APPROVAL_REQUIRED"));
    // a valid approval is single-use and bound to this plan only
    const { operation } = await h.agent.execute(plan.id, key("t09"));
    await assert.rejects(h.agent.execute(plan.id, key()), isCode("CONFLICT"));
    assert.equal((await h.agent.getPlan(other.id)).approval.state, "pending", "approval does not transfer to changed arguments");
    // denial
    const denied = await createPlan("T09 denied", strict);
    await h.approver.decideApproval({ plan_id: denied.id, plan_digest: denied.digest, decision: "denied" });
    assert.equal((await h.agent.getPlan(denied.id)).status, "denied");
    await assert.rejects(h.agent.execute(denied.id, key()), isCode("FORBIDDEN"));
    await h.drain();
    const afterStats = await h.control("/stats");
    assert.equal(afterStats.writes - before.writes, 1, "only the validly approved plan reached the destination");
    assert.equal((await h.agent.getOperation(operation.id)).execution_status, "completed");
    void APPROVER;
    recordScenario("T09", true);
  });
});

describe("T10 grant revocation", () => {
  test("revoked before dispatch: denied with no effect", async () => {
    const g = await h.grant();
    const plan = await createPlan("T10a", g);
    const { operation } = await h.agent.execute(plan.id, key("t10a"));
    await h.operator.revokeGrant(g.id);
    await h.drain();
    const op = await h.agent.getOperation(operation.id);
    assert.equal(op.execution_status, "failed");
    assert.ok(["STALE_PLAN", "FORBIDDEN"].includes(op.error!.code));
    assert.ok(op.effects.every((e) => e.status === "not_applied"));
    assert.equal((await h.control(`/writes/${operation.id}`)).writes, 0);
    assert.ok((await h.agent.events(op.id)).events.some((e) => e.type === "dispatch.denied"));
    recordScenario("T10a", true);
  });

  test("revoked after dispatch: cancellation requested and an honest effect record", { skip: !linux && "Linux process groups" }, async () => {
    const g = await h.grant();
    const task = await h.task(g, []);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "cli.sleep", arguments: { ms: 1900 } });
    const { operation } = await h.agent.execute(plan.id, key("t10b"));
    const draining = h.drain();
    await h.agent.waitForOperation(operation.id, { until: (o) => o.execution_status !== "queued", timeoutMs: 10_000 });
    await h.operator.revokeGrant(g.id);
    await draining;
    const op = await h.agent.waitForOperation(operation.id);
    const events = (await h.agent.events(op.id)).events.map((e) => e.type);
    assert.ok(events.includes("grant.revoked_after_dispatch"));
    // Depending on timing the revocation lands before the pre-submission recheck (cancelled with
    // nothing applied) or after submission (failed/completed/unknown with observed effects).
    if (op.execution_status === "cancelled") assert.ok(op.effects.every((e) => e.status === "not_applied"), "cancelled only when nothing applied");
    else assert.ok(["failed", "completed", "unknown"].includes(op.execution_status));
    recordScenario("T10b", true);
  });
});

describe("T13 stale or missing evidence", () => {
  test("stale evidence and unbound checks prevent verified completion", async () => {
    const issue = await h.seedIssue("alice");
    const task = await h.task(grant, [
      ownerCheck("bob", `issue://issue-tracker/issues/${issue.id}`, { freshness: { max_age_seconds: 1 } }),
      { ...ownerCheck("bob", `issue://issue-tracker/issues/${issue.id}`), id: "never_run" },
    ]);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issue.id, owner: "bob" }, check_ids: ["owner_matches"] });
    const { operation } = await h.agent.execute(plan.id, key("t13"));
    await h.drain();
    assert.equal((await h.agent.getOperation(operation.id)).verification_status, "passed");
    await sleep(1500);
    const outcome = await h.agent.taskOutcome(task.id);
    assert.equal(outcome.verified_complete, false);
    assert.equal(outcome.checks.find((c) => c.check_id === "owner_matches")?.status, "stale");
    assert.equal(outcome.checks.find((c) => c.check_id === "never_run")?.status, "missing");
    recordScenario("T13", true);
  });
});

describe("T17 duplicate worker launches and expired fences", () => {
  test("only one concurrent worker dispatches; the stale fence cannot write", async () => {
    const plan = await createPlan("T17");
    const { operation } = await h.agent.execute(plan.id, key("t17"));
    const results = await Promise.all([h.coordinator.dispatch(operation.id, "w1"), h.coordinator.dispatch(operation.id, "w2"), h.coordinator.dispatch(operation.id, "w3")]);
    assert.equal(results.filter((r) => r.result === "executed").length, 1, JSON.stringify(results));
    assert.equal((await h.control(`/writes/${operation.id}`)).writes, 1);
    const op = await h.agent.getOperation(operation.id);
    assert.equal(op.attempts, 1);

    const f1 = await h.journal.transaction((tx) => tx.acquireClaim(operation.id, "stale-worker", 100));
    await sleep(200);
    const f2 = await h.journal.transaction((tx) => tx.acquireClaim(operation.id, "new-worker", 5000));
    assert.ok(f1 !== null && f2 !== null && f2 > f1);
    assert.equal(await h.journal.transaction((tx) => tx.holdsClaim(operation.id, f1!)), false);
    assert.equal(await h.journal.transaction((tx) => tx.holdsClaim(operation.id, f2!)), true);
    const before = await h.agent.getOperation(operation.id);
    const recorded = await (h.coordinator as any).recordResult(operation.id, await h.journal.transaction((tx) => tx.getPlan(op.plan_id)), 1, f1, "worker:stale-worker", {
      outcome: "failed",
      submission: "not_submitted",
      effects: [],
      result_summary: null,
      external_handle: null,
    });
    assert.equal(recorded, null, "stale worker is fenced out");
    const afterOp = await h.agent.getOperation(operation.id);
    assert.equal(afterOp.row_revision, before.row_revision);
    await assert.rejects(h.journal.pool.query("UPDATE worker_claims SET fence = fence - 1 WHERE operation_id = $1", [operation.id]), /must not decrease/);
    await h.journal.transaction((tx) => tx.releaseClaim(operation.id, f2!));
    recordScenario("T17", true);
  });
});

describe("T18 recovery fails or loses its reply", () => {
  test("a recovery with a lost reply is unknown; reconciliation resolves it; original history is preserved", async () => {
    const issue = await h.seedIssue("alice");
    const task = await h.task(grant, [ownerCheck("bob", `issue://issue-tracker/issues/${issue.id}`)]);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issue.id, owner: "bob" } });
    const { operation } = await h.agent.execute(plan.id, key("t18"));
    await h.drain();
    await h.fault("lost_reply", { count: 1 });
    const rec = await h.agent.recover(operation.id, "compensate", key("t18rec"));
    await h.drain();
    const recOp = await h.agent.getOperation(rec.recovery_operation!.id);
    assert.equal(recOp.execution_status, "unknown");
    assert.equal((await h.agent.getOperation(operation.id)).recovery_status, "unknown");
    await h.agent.reconcile(recOp.id);
    await h.drain();
    const original = await h.agent.getOperation(operation.id);
    assert.equal(original.recovery_status, "succeeded");
    assert.equal(original.execution_status, "completed");
    const statuses = (await h.agent.events(operation.id)).events.filter((e) => e.type === "recovery.result").map((e) => e.data.recovery_status);
    assert.ok(statuses.includes("unknown") && statuses.at(-1) === "succeeded", JSON.stringify(statuses));
    recordScenario("T18a", true);
  });

  test("a recovery rejected by the destination is failed, and the original is unchanged", async () => {
    const issue = await h.seedIssue("alice");
    const task = await h.task(grant, []);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issue.id, owner: "bob" } });
    const { operation } = await h.agent.execute(plan.id, key("t18b"));
    await h.drain();
    await h.fault("reject_validation", { count: 1 });
    const rec = await h.agent.recover(operation.id, "compensate", key("t18brec"));
    await h.drain();
    assert.equal((await h.agent.getOperation(rec.recovery_operation!.id)).execution_status, "failed");
    const original = await h.agent.getOperation(operation.id);
    assert.equal(original.recovery_status, "failed");
    assert.equal(original.execution_status, "completed");
    recordScenario("T18b", true);
  });
});
