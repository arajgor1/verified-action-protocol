import type {
  Approval,
  Effect,
  EventType,
  Evidence,
  ExecutionStatus,
  Grant,
  Operation,
  OperationEvent,
  Plan,
  RecoveryStatus,
  Task,
  VapErrorBody,
  VerificationStatus,
} from "@vap/protocol";
import type { Role } from "./principal.js";

/** Plan as persisted: immutable fields only. status/approval are evaluated at read time. */
export type StoredPlan = Omit<Plan, "protocol_version" | "status" | "status_reasons" | "approval"> & {
  approval_required: boolean;
  approval_reason: string | null;
  /** Adapter-private frozen data (also covered by the digest). */
  frozen: Record<string, unknown> | null;
  affected_resources: string[];
  item_count: number | null;
};

/** Operation as persisted. outcome and unresolved are derived on read. */
export interface StoredOperation {
  id: string;
  plan_id: string;
  task_id: string;
  task_revision: number;
  grant_id: string;
  action_id: string;
  principal: string;
  request_key_digest: string;
  /** Keyed digest of {plan_id, plan_digest}; identical repeats must match it exactly. */
  request_digest: string;
  execution_status: ExecutionStatus;
  verification_status: VerificationStatus;
  recovery_status: RecoveryStatus;
  result_summary: Record<string, unknown> | null;
  effects: Effect[];
  attempts: number;
  external_handle: string | null;
  cancel_requested: boolean;
  recovers_operation_id: string | null;
  recovery_operation_ids: string[];
  error: VapErrorBody | null;
  reconcile_attempts: number;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  completed_at: string | null;
  row_revision: number;
}

export interface AttemptRow {
  operation_id: string;
  sequence: number;
  worker_id: string;
  fence: number;
  dispatch_intent_at: string;
  submission: "not_submitted" | "maybe_submitted" | "submitted" | null;
  finished_at: string | null;
  external_handle: string | null;
  outcome: string | null;
}

export type OutboxKind = "dispatch" | "reconcile" | "verify";

export interface OutboxItem {
  id: number;
  kind: OutboxKind;
  operation_id: string;
  attempts: number;
  available_at: string;
}

export interface OperationFilter {
  principal?: string;
  task_id?: string;
  execution_status?: ExecutionStatus[];
  limit: number;
}

export interface TombstoneRow {
  request_key_digest: string;
  operation_id: string;
  expired_at: string;
}

/**
 * Transactional view of the journal. Every method runs inside the caller's database
 * transaction. The coordinator never holds a transaction open across an external call.
 */
export interface JournalTx {
  // principals and roles (operator-managed)
  getRoles(subject: string): Promise<Role[]>;
  upsertPrincipal(subject: string, roles: Role[]): Promise<void>;
  insertPrincipalIfAbsent(subject: string, roles: Role[]): Promise<void>;

  // grants
  insertGrant(grant: Grant): Promise<void>;
  getGrant(id: string, lock?: "share" | "update"): Promise<Grant | null>;
  listGrants(principal: string | null): Promise<Grant[]>;
  revokeGrant(id: string, at: string): Promise<Grant | null>;

  // tasks
  insertTask(task: Task): Promise<void>;
  /** Compare-and-set on contract_revision; also appends to task_revisions. */
  reviseTask(task: Task, expectedRevision: number): Promise<boolean>;
  getTask(id: string): Promise<Task | null>;

  // plans
  insertPlan(plan: StoredPlan): Promise<void>;
  getPlan(id: string): Promise<StoredPlan | null>;

  // approvals
  insertApproval(approval: Approval): Promise<void>;
  listApprovalsForPlan(planId: string): Promise<Approval[]>;
  /** Marks a single-use approval consumed; false if it was already consumed. */
  consumeApproval(approvalId: string, operationId: string): Promise<boolean>;
  listPendingApprovalPlans(limit: number): Promise<StoredPlan[]>;

  // operations
  findOperationByRequestKey(requestKeyDigest: string): Promise<StoredOperation | null>;
  findOperationByPlan(planId: string): Promise<StoredOperation | null>;
  findTombstone(requestKeyDigest: string): Promise<TombstoneRow | null>;
  /** Inserts; returns false on a unique-constraint race (request key or plan). */
  insertOperation(op: StoredOperation): Promise<boolean>;
  getOperation(id: string, lock?: boolean): Promise<StoredOperation | null>;
  /** Writes all mutable fields and bumps row_revision. */
  updateOperation(op: StoredOperation): Promise<StoredOperation>;
  listOperations(filter: OperationFilter): Promise<StoredOperation[]>;
  countOperationsForGrant(grantId: string, unresolvedOnly: boolean): Promise<number>;
  listRunningOperationsForGrant(grantId: string): Promise<StoredOperation[]>;

  // attempts
  insertAttempt(row: AttemptRow): Promise<void>;
  finishAttempt(operationId: string, sequence: number, fields: Pick<AttemptRow, "submission" | "external_handle" | "outcome">): Promise<void>;
  listAttempts(operationId: string): Promise<AttemptRow[]>;

  // events (append-only)
  appendEvent(operationId: string, type: EventType, actor: string, data: Record<string, unknown>): Promise<OperationEvent>;
  listEvents(operationId: string, after: number, limit: number): Promise<OperationEvent[]>;

  // evidence
  insertEvidence(evidence: Evidence): Promise<void>;
  getEvidence(id: string): Promise<Evidence | null>;
  listEvidenceForOperation(operationId: string): Promise<Evidence[]>;
  listEvidenceForTask(taskId: string, taskRevision: number): Promise<Evidence[]>;

  // outbox
  enqueue(kind: OutboxKind, operationId: string, delayMs?: number): Promise<void>;
  hasPendingOutbox(operationId: string, kind?: OutboxKind): Promise<boolean>;
  /** Leases due items with FOR UPDATE SKIP LOCKED; leased items are invisible until the lease expires. */
  leaseOutbox(workerId: string, limit: number, leaseMs: number, kinds?: OutboxKind[]): Promise<OutboxItem[]>;
  completeOutbox(id: number): Promise<void>;
  /** Renews the lease of an item this worker holds. */
  extendOutboxLease(id: number, workerId: string, leaseMs: number): Promise<void>;
  retryOutbox(id: number, delayMs: number): Promise<void>;

  // worker claims with fencing
  /** Returns a new, strictly larger fence token, or null while another claim is live. */
  acquireClaim(operationId: string, workerId: string, leaseMs: number): Promise<number | null>;
  /** Locks the claim row and reports whether fence is the current live claim. */
  holdsClaim(operationId: string, fence: number): Promise<boolean>;
  heartbeatClaim(operationId: string, fence: number, leaseMs: number): Promise<boolean>;
  releaseClaim(operationId: string, fence: number): Promise<void>;
  /** Running operations whose claim lease expired (the worker died mid-flight). */
  listOrphanedOperations(limit: number): Promise<StoredOperation[]>;
  /** Queued operations with no pending outbox item. */
  listStrandedQueuedOperations(limit: number): Promise<StoredOperation[]>;

  // retention
  expireRequestKeys(olderThanIso: string): Promise<number>;
  purgeResolvedOperations(olderThanIso: string): Promise<number>;
}

export interface Journal {
  transaction<T>(fn: (tx: JournalTx) => Promise<T>): Promise<T>;
  /** Readiness: true when a trivial query succeeds. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
