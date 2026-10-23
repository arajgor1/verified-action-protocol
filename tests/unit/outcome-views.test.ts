import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReceipt, evaluatePlan, evaluateTaskOutcome, operationView } from "@vap/core";
import type { StoredOperation, StoredPlan } from "@vap/core";
import { deriveOutcome, EXECUTION_STATUSES, retryGuidance, VERIFICATION_STATUSES } from "@vap/protocol";
import type { Evidence, Grant, Task } from "@vap/protocol";

test("outcome derivation never shows unverified or failed verification as verified", () => {
  for (const e of EXECUTION_STATUSES) {
    for (const v of VERIFICATION_STATUSES) {
      const o = deriveOutcome(e, v);
      if (o === "verified") assert.ok(e === "completed" && v === "passed");
    }
  }
  assert.equal(deriveOutcome("queued", "not_requested"), "requested");
  assert.equal(deriveOutcome("running", "not_requested"), "submitted");
  assert.equal(deriveOutcome("completed", "pending"), "completed_unverified");
  assert.equal(deriveOutcome("completed", "inconclusive"), "completed_unverified");
  assert.equal(deriveOutcome("completed", "failed"), "verification_failed");
  assert.equal(deriveOutcome("partial", "passed"), "partially_applied");
  assert.equal(deriveOutcome("unknown", "passed"), "unknown");
});

test("retry guidance requires reconciliation for unknown effects", () => {
  assert.equal(retryGuidance("unknown", "not_requested", []).disposition, "reconcile_first");
  assert.equal(retryGuidance("failed", "not_requested", [{ side_effect_id: "x", status: "unknown" }]).disposition, "reconcile_first");
  assert.equal(retryGuidance("failed", "not_requested", [{ side_effect_id: "x", status: "not_applied" }]).disposition, "safe_to_retry");
  assert.equal(retryGuidance("failed", "not_requested", [{ side_effect_id: "x", status: "applied" }]).disposition, "do_not_retry");
  assert.equal(retryGuidance("running", "not_requested", []).disposition, "do_not_retry");
  assert.equal(retryGuidance("completed", "failed", []).disposition, "do_not_retry");
});

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const task: Task = {
  protocol_version: "0.1",
  id: "tsk_aaaaaaaaaaaaaaaaaaaa",
  contract_revision: 2,
  goal: "g",
  owner: "agent",
  grant_id: "grt_aaaaaaaaaaaaaaaaaaaa",
  scope: { actions: ["*"], resources: ["issue://t/*"] },
  requirements: [],
  assumptions: [],
  required_checks: [{ id: "c1", method: "read_back", verifier_id: "http.readback", target: "issue://t/1", predicate: { op: "exists", path: "/id" }, freshness: { max_age_seconds: 60 }, deadline_seconds: 5 }],
  created_at: iso(now),
  revised_at: iso(now),
};
const grant: Grant = {
  protocol_version: "0.1",
  id: "grt_aaaaaaaaaaaaaaaaaaaa",
  principal: "agent",
  allowed_actions: ["*"],
  allowed_targets: ["issue://t/*"],
  risk_ceiling: 3,
  preauthorized_actions: [],
  limits: { max_operations: null, max_items_per_operation: null, max_concurrent_operations: null },
  expires_at: iso(now + 3600_000),
  revocation_revision: 0,
  revoked_at: null,
  issuer: "op",
  created_at: iso(now),
};
const plan = {
  id: "pln_aaaaaaaaaaaaaaaaaaaa",
  task_id: task.id,
  task_revision: 2,
  action_id: "a.b",
  adapter: { id: "x", version: "1" },
  principal: "agent",
  grant_id: grant.id,
  canonical_arguments: {},
  resource_conditions: [],
  preview: { fidelity: "estimate", summary: "", effects: [] },
  risk_tier: 2,
  required_checks: task.required_checks,
  policy_revision: "pol_1",
  grant_revocation_revision: 0,
  digest: "hmac-sha256:" + "0".repeat(64),
  created_at: iso(now),
  expires_at: iso(now + 60_000),
  recovery_of: null,
  approval_required: true,
  approval_reason: "tier 2",
  frozen: null,
  affected_resources: [],
  item_count: null,
} as StoredPlan;

test("plan status precedence: stale before expired before approval", () => {
  const ctx = { now, task, grant, policyRevision: "pol_1", currentAdapterVersion: "1", approvals: [] };
  assert.equal(evaluatePlan(plan, ctx).status, "awaiting_approval");
  assert.equal(evaluatePlan(plan, { ...ctx, task: { ...task, contract_revision: 3 } }).status, "stale");
  assert.equal(evaluatePlan(plan, { ...ctx, policyRevision: "pol_2" }).status, "stale");
  assert.equal(evaluatePlan(plan, { ...ctx, currentAdapterVersion: "2" }).status, "stale");
  assert.equal(evaluatePlan(plan, { ...ctx, grant: { ...grant, revocation_revision: 1 } }).status, "stale");
  assert.equal(evaluatePlan({ ...plan, expires_at: iso(now - 1) }, ctx).status, "expired");
  const approval = { protocol_version: "0.1" as const, id: "apv_aaaaaaaaaaaaaaaaaaaa", plan_id: plan.id, plan_digest: plan.digest, decision: "approved" as const, approver: "human", approved_scope: { action_id: "a.b", risk_tier: 2 as const, resource_uris: [] }, created_at: iso(now), expires_at: iso(now + 1000), single_use: true as const, consumed_by_operation_id: null, note: null };
  assert.equal(evaluatePlan(plan, { ...ctx, approvals: [approval] }).status, "prepared");
  assert.equal(evaluatePlan(plan, { ...ctx, approvals: [{ ...approval, plan_digest: "hmac-sha256:" + "1".repeat(64) }] }).status, "awaiting_approval", "approval for a different digest does not count");
  assert.equal(evaluatePlan(plan, { ...ctx, approvals: [{ ...approval, decision: "denied" }] }).status, "denied");
  assert.equal(evaluatePlan(plan, { ...ctx, approvals: [{ ...approval, expires_at: iso(now - 1) }] }).status, "awaiting_approval");
});

function ev(over: Partial<Evidence>): Evidence {
  return {
    protocol_version: "0.1",
    id: "evd_aaaaaaaaaaaaaaaaaaaa",
    operation_id: "op_aaaaaaaaaaaaaaaaaaaa",
    task_id: task.id,
    task_revision: 2,
    check_id: "c1",
    item_index: null,
    verifier_id: "http.readback",
    verifier_version: "1",
    method: "read_back",
    observed_at: iso(now),
    result: "pass",
    source: "s",
    source_version: "1",
    freshness: "fresh",
    observed_facts: {},
    artifact_ref: null,
    limitations: [],
    attributed_to: null,
    independence: "same_process",
    created_at: iso(now),
    ...over,
  };
}

const op: StoredOperation = {
  id: "op_aaaaaaaaaaaaaaaaaaaa",
  plan_id: plan.id,
  task_id: task.id,
  task_revision: 2,
  grant_id: grant.id,
  action_id: "a.b",
  principal: "agent",
  request_key_digest: "hmac-sha256:" + "2".repeat(64),
  request_digest: "x",
  execution_status: "completed",
  verification_status: "passed",
  recovery_status: "none",
  result_summary: null,
  effects: [],
  attempts: 1,
  external_handle: null,
  cancel_requested: false,
  recovers_operation_id: null,
  recovery_operation_ids: [],
  error: null,
  reconcile_attempts: 0,
  created_at: iso(now),
  updated_at: iso(now),
  submitted_at: iso(now),
  completed_at: iso(now),
  row_revision: 1,
};

test("task completion requires fresh passing evidence for the current revision and no unresolved operations", () => {
  assert.ok(evaluateTaskOutcome(task, [ev({})], [op], now).verified_complete);
  assert.ok(!evaluateTaskOutcome(task, [], [op], now).verified_complete, "missing evidence is not a pass");
  assert.ok(!evaluateTaskOutcome(task, [ev({ task_revision: 1 })], [op], now).verified_complete, "evidence for an old revision does not count");
  assert.equal(evaluateTaskOutcome(task, [ev({ observed_at: iso(now - 120_000) })], [op], now).checks[0].status, "stale");
  assert.equal(evaluateTaskOutcome(task, [ev({ result: "inconclusive" })], [op], now).checks[0].status, "inconclusive");
  assert.ok(!evaluateTaskOutcome(task, [ev({})], [op, { ...op, id: "op_bbbbbbbbbbbbbbbbbbbb", execution_status: "unknown" }], now).verified_complete);
  assert.ok(!evaluateTaskOutcome({ ...task, required_checks: [] }, [], [op], now).verified_complete, "no checks means nothing is verified");
  const later = ev({ id: "evd_bbbbbbbbbbbbbbbbbbbb", result: "fail", created_at: iso(now + 1) });
  assert.equal(evaluateTaskOutcome(task, [ev({}), later], [op], now + 1).checks[0].status, "fail", "the latest evidence wins");
});

test("receipts list unobservable or unverified effects explicitly", () => {
  const descriptor = {
    side_effects: [
      { id: "issue_created", description: "issue record created", class: "compensable", bounded: true },
      { id: "notification_sent", description: "external notification delivery", class: "irreversible", bounded: true },
    ],
    recovery_modes: [{ mode: "compensate", action_id: "x.y", description: "" }],
  } as never;
  const o = operationView({ ...op, effects: [{ side_effect_id: "issue_created", item_index: null, resource_uri: "issue://t/1", status: "applied", source_version: "1", detail: null }] });
  const r = buildReceipt(o, plan, [ev({ observed_facts: { _target: "issue://t/1" } })], descriptor, iso(now));
  assert.deepEqual(r.unverified_effects, ["external notification delivery (not observable by this adapter)"]);
  assert.equal(r.checks[0].result, "pass");
  assert.ok(r.recovery.available);
  const r2 = buildReceipt(o, plan, [], descriptor, iso(now));
  assert.equal(r2.checks[0].result, "missing");
  assert.equal(r2.unverified_effects.length, 2);
});
