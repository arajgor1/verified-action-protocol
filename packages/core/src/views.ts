import { deriveOutcome, isUnresolved, PROTOCOL_VERSION, retryGuidance } from "@verified-action-protocol/protocol";
import type {
  ActionDescriptor,
  Approval,
  ApprovalState,
  Evidence,
  Grant,
  Operation,
  Plan,
  PlanStatus,
  Receipt,
  ReceiptCheck,
  Task,
  TaskOutcome,
  TaskOutcomeCheck,
} from "@verified-action-protocol/protocol";
import type { StoredOperation, StoredPlan } from "./journal.js";

export function operationView(op: StoredOperation): Operation {
  return {
    protocol_version: PROTOCOL_VERSION,
    id: op.id,
    plan_id: op.plan_id,
    task_id: op.task_id,
    action_id: op.action_id,
    principal: op.principal,
    request_key_digest: op.request_key_digest,
    execution_status: op.execution_status,
    verification_status: op.verification_status,
    recovery_status: op.recovery_status,
    outcome: deriveOutcome(op.execution_status, op.verification_status),
    result_summary: op.result_summary,
    effects: op.effects,
    attempts: op.attempts,
    external_handle: op.external_handle,
    cancel_requested: op.cancel_requested,
    recovers_operation_id: op.recovers_operation_id,
    recovery_operation_ids: op.recovery_operation_ids,
    unresolved: isUnresolved(op.execution_status),
    error: op.error,
    created_at: op.created_at,
    updated_at: op.updated_at,
    submitted_at: op.submitted_at,
    completed_at: op.completed_at,
    row_revision: op.row_revision,
  };
}

export interface PlanEvaluationContext {
  now: number;
  task: Task | null;
  grant: Grant | null;
  policyRevision: string;
  currentAdapterVersion: string | null;
  approvals: Approval[];
}

export interface PlanEvaluation {
  status: PlanStatus;
  reasons: string[];
  approvalState: ApprovalState;
  approval: Approval | null;
}

/** Evaluates a stored plan's status at read/execute time. Precedence: stale, expired, denied, awaiting_approval, prepared. */
export function evaluatePlan(plan: StoredPlan, ctx: PlanEvaluationContext): PlanEvaluation {
  const stale: string[] = [];
  if (!ctx.task) stale.push("task no longer exists");
  else if (ctx.task.contract_revision !== plan.task_revision) stale.push(`task contract changed (plan bound to revision ${plan.task_revision}, current ${ctx.task.contract_revision})`);
  if (plan.policy_revision !== ctx.policyRevision) stale.push("deployment policy or action registry changed since preparation");
  if (ctx.currentAdapterVersion === null) stale.push("action is no longer registered");
  else if (ctx.currentAdapterVersion !== plan.adapter.version) stale.push(`adapter version changed (${plan.adapter.version} -> ${ctx.currentAdapterVersion})`);
  if (!ctx.grant) stale.push("grant no longer exists");
  else {
    if (ctx.grant.revocation_revision !== plan.grant_revocation_revision) stale.push("grant was revoked or modified since preparation");
    if (ctx.grant.revoked_at !== null) stale.push("grant has been revoked");
    if (Date.parse(ctx.grant.expires_at) <= ctx.now) stale.push("grant has expired");
  }

  // Latest decision bound to this exact digest wins.
  const bound = ctx.approvals.filter((a) => a.plan_digest === plan.digest).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const latest = bound[0] ?? null;
  let approvalState: ApprovalState = "not_required";
  if (plan.approval_required) {
    if (!latest) approvalState = "pending";
    else if (latest.decision === "denied") approvalState = "denied";
    else if (latest.consumed_by_operation_id) approvalState = "consumed";
    else if (Date.parse(latest.expires_at) <= ctx.now) approvalState = "expired";
    else approvalState = "approved";
  }

  if (stale.length > 0) return { status: "stale", reasons: stale, approvalState, approval: latest };
  if (Date.parse(plan.expires_at) <= ctx.now) return { status: "expired", reasons: ["plan expired"], approvalState, approval: latest };
  if (approvalState === "denied") return { status: "denied", reasons: ["approval denied"], approvalState, approval: latest };
  if (approvalState === "pending" || approvalState === "expired") {
    return { status: "awaiting_approval", reasons: [plan.approval_reason ?? "approval required"], approvalState, approval: latest };
  }
  return { status: "prepared", reasons: [], approvalState, approval: latest };
}

export function planView(plan: StoredPlan, ev: PlanEvaluation): Plan {
  const view: Plan = {
    protocol_version: PROTOCOL_VERSION,
    id: plan.id,
    task_id: plan.task_id,
    task_revision: plan.task_revision,
    action_id: plan.action_id,
    adapter: plan.adapter,
    principal: plan.principal,
    grant_id: plan.grant_id,
    canonical_arguments: plan.canonical_arguments,
    resource_conditions: plan.resource_conditions,
    preview: plan.preview,
    risk_tier: plan.risk_tier,
    required_checks: plan.required_checks,
    policy_revision: plan.policy_revision,
    grant_revocation_revision: plan.grant_revocation_revision,
    digest: plan.digest,
    created_at: plan.created_at,
    expires_at: plan.expires_at,
    status: ev.status,
    status_reasons: ev.reasons,
    approval: {
      required: plan.approval_required,
      reason: plan.approval_reason,
      state: ev.approvalState,
      approval_id: ev.approval?.id ?? null,
    },
    recovery_of: plan.recovery_of,
  };
  if (plan.frozen) view.extensions = { "vap.prepare": plan.frozen };
  return view;
}

/** Latest aggregate evidence (item_index null) per check id. */
export function latestAggregateEvidence(evidence: Evidence[]): Map<string, Evidence> {
  const out = new Map<string, Evidence>();
  for (const e of evidence) {
    if (e.item_index !== null) continue;
    const prev = out.get(e.check_id);
    if (!prev || prev.created_at < e.created_at || (prev.created_at === e.created_at && prev.id < e.id)) out.set(e.check_id, e);
  }
  return out;
}

export function buildReceipt(op: Operation, plan: StoredPlan, evidence: Evidence[], descriptor: ActionDescriptor | null, now: string): Receipt {
  const latest = latestAggregateEvidence(evidence);
  const checks: ReceiptCheck[] = [];
  for (const c of plan.required_checks) {
    const e = latest.get(c.id);
    checks.push({
      id: c.id,
      result: e ? e.result : "missing",
      method: e ? e.method : null,
      source: e ? e.source : null,
      source_version: e ? e.source_version : null,
      evidence_id: e ? e.id : null,
      observed_at: e ? e.observed_at : null,
      item_index: null,
    });
    // Per-item results for batch checks, from the same verification run as the aggregate.
    const itemIds = new Set(Array.isArray(e?.observed_facts["item_evidence"]) ? (e!.observed_facts["item_evidence"] as string[]) : []);
    for (const item of evidence.filter((x) => x.check_id === c.id && x.item_index !== null)) {
      if (!itemIds.has(item.id)) continue;
      checks.push({
        id: c.id,
        result: item.result,
        method: item.method,
        source: item.source,
        source_version: item.source_version,
        evidence_id: item.id,
        observed_at: item.observed_at,
        item_index: item.item_index,
      });
    }
  }

  const verifiedUris = new Set(
    evidence.filter((e) => e.result === "pass").map((e) => (typeof e.observed_facts["_target"] === "string" ? (e.observed_facts["_target"] as string) : "")),
  );
  const unverified: string[] = [];
  const declared = descriptor?.side_effects ?? [];
  for (const se of declared) {
    if (se.class === "none") continue;
    const records = op.effects.filter((ef) => ef.side_effect_id === se.id);
    if (records.length === 0) {
      if (op.execution_status === "completed" || op.execution_status === "partial") unverified.push(`${se.description} (not observable by this adapter)`);
      continue;
    }
    for (const r of records) {
      if (r.status === "not_applied") continue;
      if (r.status === "unknown" || !r.resource_uri || !verifiedUris.has(r.resource_uri)) {
        unverified.push(`${se.description}${r.resource_uri ? ` (${r.resource_uri})` : ""}${r.status === "unknown" ? " [effect unknown]" : ""}`);
      }
    }
  }

  const modes = descriptor?.recovery_modes.map((m) => m.mode) ?? [];
  const recoverable = modes.length > 0 && op.effects.some((e) => e.status === "applied") && !isUnresolved(op.execution_status);
  return {
    protocol_version: PROTOCOL_VERSION,
    operation_id: op.id,
    task_id: op.task_id,
    action_id: op.action_id,
    outcome: op.outcome,
    execution_status: op.execution_status,
    verification_status: op.verification_status,
    recovery_status: op.recovery_status,
    unresolved: op.unresolved,
    effects: op.effects,
    checks,
    unverified_effects: unverified,
    recovery: { modes, available: recoverable, status: op.recovery_status, recovery_operation_ids: op.recovery_operation_ids },
    retry_guidance: retryGuidance(op.execution_status, op.verification_status, op.effects),
    generated_at: now,
  };
}

export function evaluateTaskOutcome(task: Task, evidence: Evidence[], operations: StoredOperation[], now: number): TaskOutcome {
  const latest = latestAggregateEvidence(evidence.filter((e) => e.task_revision === task.contract_revision));
  const reasons: string[] = [];
  const checks: TaskOutcomeCheck[] = task.required_checks.map((c) => {
    const e = latest.get(c.id);
    if (!e) {
      reasons.push(`check ${c.id} has no evidence for contract revision ${task.contract_revision}`);
      return { check_id: c.id, status: "missing", evidence_id: null, observed_at: null, operation_id: null };
    }
    if (e.result !== "pass") {
      reasons.push(`check ${c.id} is ${e.result}`);
      return { check_id: c.id, status: e.result, evidence_id: e.id, observed_at: e.observed_at, operation_id: e.operation_id };
    }
    const age = (now - Date.parse(e.observed_at)) / 1000;
    if (age > c.freshness.max_age_seconds) {
      reasons.push(`check ${c.id} evidence is stale (${Math.round(age)}s old, limit ${c.freshness.max_age_seconds}s)`);
      return { check_id: c.id, status: "stale", evidence_id: e.id, observed_at: e.observed_at, operation_id: e.operation_id };
    }
    return { check_id: c.id, status: "pass", evidence_id: e.id, observed_at: e.observed_at, operation_id: e.operation_id };
  });
  const unresolved = operations
    .filter((o) => isUnresolved(o.execution_status) || ["requested", "running", "unknown"].includes(o.recovery_status))
    .map((o) => o.id);
  for (const id of unresolved) reasons.push(`operation ${id} is unresolved and could still violate the task constraints`);
  if (task.required_checks.length === 0) reasons.push("the task declares no required checks, so nothing can be verified");
  const verified = task.required_checks.length > 0 && checks.every((c) => c.status === "pass") && unresolved.length === 0;
  return {
    protocol_version: PROTOCOL_VERSION,
    task_id: task.id,
    contract_revision: task.contract_revision,
    verified_complete: verified,
    reasons,
    checks,
    unresolved_operations: unresolved,
    evaluated_at: new Date(now).toISOString(),
  };
}
