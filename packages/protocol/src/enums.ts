// Enumerations mirrored from schemas/common.schema.json. tests/unit/schema-drift.test.ts
// fails if these arrays and the schema enums diverge.

export const PROTOCOL_VERSION = "0.1" as const;
export const SUPPORTED_PROTOCOL_VERSIONS = ["0.1"] as const;
export const API_VERSION = "v1" as const;

export const EXECUTION_STATUSES = ["queued", "running", "completed", "failed", "partial", "unknown", "cancelled"] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const VERIFICATION_STATUSES = ["not_requested", "pending", "passed", "failed", "inconclusive"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const RECOVERY_STATUSES = ["none", "requested", "running", "succeeded", "failed", "unknown"] as const;
export type RecoveryStatus = (typeof RECOVERY_STATUSES)[number];

export const PLAN_STATUSES = ["prepared", "awaiting_approval", "denied", "expired", "stale"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const OUTCOMES = [
  "requested",
  "submitted",
  "completed_unverified",
  "verified",
  "verification_failed",
  "partially_applied",
  "failed",
  "cancelled",
  "unknown",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const SIDE_EFFECT_CLASSES = ["none", "local_reversible", "remote_reversible", "compensable", "irreversible"] as const;
export type SideEffectClass = (typeof SIDE_EFFECT_CLASSES)[number];

export const CHECK_METHODS = ["read_back", "test", "assertion", "trace", "human_judgment"] as const;
export type CheckMethod = (typeof CHECK_METHODS)[number];

export const CHECK_RESULTS = ["pass", "fail", "inconclusive"] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];

export const PREVIEW_FIDELITIES = ["exact", "sandbox", "estimate", "none"] as const;
export type PreviewFidelity = (typeof PREVIEW_FIDELITIES)[number];

export const EFFECT_STATUSES = ["applied", "not_applied", "unknown"] as const;
export type EffectStatus = (typeof EFFECT_STATUSES)[number];

export const RECOVERY_MODES = ["compensate", "restore_snapshot"] as const;
export type RecoveryMode = (typeof RECOVERY_MODES)[number];

export const RETRY_DISPOSITIONS = ["safe_to_retry", "retry_with_same_key", "fix_request", "reconcile_first", "do_not_retry"] as const;
export type RetryDisposition = (typeof RETRY_DISPOSITIONS)[number];

export const ERROR_CODES = [
  "INVALID_ARGUMENT",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "STALE_PLAN",
  "PLAN_EXPIRED",
  "APPROVAL_REQUIRED",
  "KEY_REUSE_CONFLICT",
  "REQUEST_KEY_EXPIRED",
  "LIMIT_EXCEEDED",
  "CAPABILITY_UNAVAILABLE",
  "DESTINATION_UNAVAILABLE",
  "OUTCOME_UNKNOWN",
  "CONFLICT",
  "UNSUPPORTED_PROTOCOL_VERSION",
  "UNAVAILABLE",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const PREDICATE_OPS = ["eq", "neq", "in", "not_in", "exists", "not_exists", "range", "length_range", "all", "any"] as const;
export type PredicateOp = (typeof PREDICATE_OPS)[number];

export const EVENT_TYPES = [
  "operation.accepted",
  "dispatch.denied",
  "dispatch.intent",
  "dispatch.result",
  "dispatch.claim_lost",
  "reconcile.started",
  "reconcile.result",
  "verification.started",
  "verification.result",
  "cancel.requested",
  "cancel.result",
  "recovery.requested",
  "recovery.linked",
  "recovery.result",
  "grant.revoked_after_dispatch",
  "operator.resolution_required",
  "claim.expired",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Risk tier implied by each side-effect class. An action inherits the strictest. */
export const TIER_BY_SIDE_EFFECT_CLASS: Record<SideEffectClass, 0 | 1 | 2 | 3> = {
  none: 0,
  local_reversible: 1,
  remote_reversible: 1,
  compensable: 2,
  irreversible: 3,
};

/** Execution statuses after which no further execution is expected from VAP. */
export const FINAL_EXECUTION_STATUSES: readonly ExecutionStatus[] = ["completed", "failed", "partial", "cancelled"];

/** Statuses under which an operation may still have effects VAP has not established. */
export const UNRESOLVED_EXECUTION_STATUSES: readonly ExecutionStatus[] = ["queued", "running", "unknown"];
