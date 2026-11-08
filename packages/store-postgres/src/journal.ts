import pg from "pg";
import type { Pool, PoolClient, PoolConfig } from "pg";
import { PROTOCOL_VERSION, VapError } from "@verified-action-protocol/protocol";
import type { Approval, EventType, Evidence, Grant, OperationEvent, Task } from "@verified-action-protocol/protocol";
import type {
  AttemptRow,
  Journal,
  JournalTx,
  OperationFilter,
  OutboxItem,
  OutboxKind,
  Role,
  StoredOperation,
  StoredPlan,
  TombstoneRow,
} from "@verified-action-protocol/core";

type Row = Record<string, unknown>;

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return new Date(v).toISOString();
  throw new Error("expected timestamp");
}

function isoOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : iso(v);
}

function rowToOperation(r: Row): StoredOperation {
  return {
    id: r.id as string,
    plan_id: r.plan_id as string,
    task_id: r.task_id as string,
    task_revision: r.task_revision as number,
    grant_id: r.grant_id as string,
    action_id: r.action_id as string,
    principal: r.principal as string,
    request_key_digest: r.request_key_digest as string,
    request_digest: r.request_digest as string,
    execution_status: r.execution_status as StoredOperation["execution_status"],
    verification_status: r.verification_status as StoredOperation["verification_status"],
    recovery_status: r.recovery_status as StoredOperation["recovery_status"],
    result_summary: (r.result_summary as Record<string, unknown> | null) ?? null,
    effects: (r.effects as StoredOperation["effects"]) ?? [],
    attempts: r.attempts as number,
    external_handle: (r.external_handle as string | null) ?? null,
    cancel_requested: r.cancel_requested as boolean,
    recovers_operation_id: (r.recovers_operation_id as string | null) ?? null,
    recovery_operation_ids: (r.recovery_operation_ids as string[]) ?? [],
    error: (r.error as StoredOperation["error"]) ?? null,
    reconcile_attempts: r.reconcile_attempts as number,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    submitted_at: isoOrNull(r.submitted_at),
    completed_at: isoOrNull(r.completed_at),
    row_revision: r.row_revision as number,
  };
}

function rowToEvent(r: Row): OperationEvent {
  return {
    protocol_version: PROTOCOL_VERSION,
    operation_id: r.operation_id as string,
    sequence: r.sequence as number,
    type: r.type as EventType,
    at: iso(r.at),
    actor: r.actor as string,
    data: r.data as Record<string, unknown>,
  };
}

const ms = (n: number) => Math.max(0, Math.floor(n)) / 1000;

class PgTx implements JournalTx {
  constructor(private readonly c: PoolClient) {}

  private async one<T extends Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    const r = await this.c.query(sql, params);
    return (r.rows[0] as T | undefined) ?? null;
  }

  private async many<T extends Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.c.query(sql, params)).rows as T[];
  }

  // principals
  async getRoles(subject: string): Promise<Role[]> {
    const r = await this.one<{ roles: Role[] }>("SELECT roles FROM principals WHERE subject = $1", [subject]);
    return r?.roles ?? [];
  }

  async upsertPrincipal(subject: string, roles: Role[]): Promise<void> {
    await this.c.query(
      "INSERT INTO principals (subject, roles, updated_at) VALUES ($1, $2, now()) ON CONFLICT (subject) DO UPDATE SET roles = EXCLUDED.roles, updated_at = now()",
      [subject, roles],
    );
  }

  async insertPrincipalIfAbsent(subject: string, roles: Role[]): Promise<void> {
    await this.c.query("INSERT INTO principals (subject, roles, updated_at) VALUES ($1, $2, now()) ON CONFLICT (subject) DO NOTHING", [subject, roles]);
  }

  // grants
  async insertGrant(g: Grant): Promise<void> {
    await this.c.query(
      "INSERT INTO grants (id, principal, revocation_revision, revoked_at, expires_at, body, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [g.id, g.principal, g.revocation_revision, g.revoked_at, g.expires_at, JSON.stringify(g), g.created_at],
    );
  }

  async getGrant(id: string, lock?: "share" | "update"): Promise<Grant | null> {
    const suffix = lock === "update" ? " FOR UPDATE" : lock === "share" ? " FOR SHARE" : "";
    const r = await this.one<{ body: Grant }>(`SELECT body FROM grants WHERE id = $1${suffix}`, [id]);
    return r?.body ?? null;
  }

  async listGrants(principal: string | null): Promise<Grant[]> {
    const rows = principal
      ? await this.many<{ body: Grant }>("SELECT body FROM grants WHERE principal = $1 ORDER BY created_at DESC LIMIT 200", [principal])
      : await this.many<{ body: Grant }>("SELECT body FROM grants ORDER BY created_at DESC LIMIT 200");
    return rows.map((r) => r.body);
  }

  async revokeGrant(id: string, at: string): Promise<Grant | null> {
    const g = await this.getGrant(id, "update");
    if (!g) return null;
    const next: Grant = { ...g, revocation_revision: g.revocation_revision + 1, revoked_at: g.revoked_at ?? at };
    await this.c.query("UPDATE grants SET revocation_revision = $2, revoked_at = $3, body = $4 WHERE id = $1", [
      id,
      next.revocation_revision,
      next.revoked_at,
      JSON.stringify(next),
    ]);
    return next;
  }

  // tasks
  async insertTask(t: Task): Promise<void> {
    await this.c.query(
      "INSERT INTO tasks (id, owner, grant_id, contract_revision, body, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
      [t.id, t.owner, t.grant_id, t.contract_revision, JSON.stringify(t), t.created_at],
    );
    await this.c.query("INSERT INTO task_revisions (task_id, contract_revision, body, created_at) VALUES ($1,$2,$3,$4)", [
      t.id,
      t.contract_revision,
      JSON.stringify(t),
      t.revised_at,
    ]);
  }

  async reviseTask(t: Task, expectedRevision: number): Promise<boolean> {
    const r = await this.c.query("UPDATE tasks SET contract_revision = $2, body = $3, updated_at = $4 WHERE id = $1 AND contract_revision = $5", [
      t.id,
      t.contract_revision,
      JSON.stringify(t),
      t.revised_at,
      expectedRevision,
    ]);
    if (r.rowCount !== 1) return false;
    await this.c.query("INSERT INTO task_revisions (task_id, contract_revision, body, created_at) VALUES ($1,$2,$3,$4)", [
      t.id,
      t.contract_revision,
      JSON.stringify(t),
      t.revised_at,
    ]);
    return true;
  }

  async getTask(id: string): Promise<Task | null> {
    return (await this.one<{ body: Task }>("SELECT body FROM tasks WHERE id = $1", [id]))?.body ?? null;
  }

  // plans
  async insertPlan(p: StoredPlan): Promise<void> {
    await this.c.query(
      "INSERT INTO plans (id, task_id, principal, action_id, digest, approval_required, expires_at, body, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [p.id, p.task_id, p.principal, p.action_id, p.digest, p.approval_required, p.expires_at, JSON.stringify(p), p.created_at],
    );
  }

  async getPlan(id: string): Promise<StoredPlan | null> {
    return (await this.one<{ body: StoredPlan }>("SELECT body FROM plans WHERE id = $1", [id]))?.body ?? null;
  }

  // approvals
  async insertApproval(a: Approval): Promise<void> {
    await this.c.query(
      "INSERT INTO approvals (id, plan_id, plan_digest, decision, approver, expires_at, consumed_by_operation_id, body, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [a.id, a.plan_id, a.plan_digest, a.decision, a.approver, a.expires_at, a.consumed_by_operation_id, JSON.stringify(a), a.created_at],
    );
  }

  async listApprovalsForPlan(planId: string): Promise<Approval[]> {
    const rows = await this.many<{ body: Approval; consumed_by_operation_id: string | null }>(
      "SELECT body, consumed_by_operation_id FROM approvals WHERE plan_id = $1 ORDER BY created_at",
      [planId],
    );
    return rows.map((r) => ({ ...r.body, consumed_by_operation_id: r.consumed_by_operation_id }));
  }

  async consumeApproval(approvalId: string, operationId: string): Promise<boolean> {
    const r = await this.c.query(
      "UPDATE approvals SET consumed_by_operation_id = $2, body = jsonb_set(body, '{consumed_by_operation_id}', to_jsonb($2::text)) WHERE id = $1 AND consumed_by_operation_id IS NULL AND decision = 'approved' AND expires_at > now()",
      [approvalId, operationId],
    );
    return r.rowCount === 1;
  }

  async listPendingApprovalPlans(limit: number): Promise<StoredPlan[]> {
    const rows = await this.many<{ body: StoredPlan }>(
      `SELECT p.body FROM plans p
        WHERE p.approval_required AND p.expires_at > now()
          AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.plan_id = p.id)
        ORDER BY p.created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => r.body);
  }

  // operations
  async findOperationByRequestKey(digest: string): Promise<StoredOperation | null> {
    const r = await this.one("SELECT * FROM operations WHERE request_key_digest = $1 AND NOT request_key_expired", [digest]);
    return r ? rowToOperation(r) : null;
  }

  async findOperationByPlan(planId: string): Promise<StoredOperation | null> {
    const r = await this.one("SELECT * FROM operations WHERE plan_id = $1", [planId]);
    return r ? rowToOperation(r) : null;
  }

  async findTombstone(digest: string): Promise<TombstoneRow | null> {
    const r = await this.one<{ request_key_digest: string; operation_id: string; expired_at: Date }>(
      "SELECT request_key_digest, operation_id, expired_at FROM request_key_tombstones WHERE request_key_digest = $1",
      [digest],
    );
    return r ? { request_key_digest: r.request_key_digest, operation_id: r.operation_id, expired_at: iso(r.expired_at) } : null;
  }

  async insertOperation(op: StoredOperation): Promise<boolean> {
    const r = await this.c.query(
      `INSERT INTO operations (id, plan_id, task_id, task_revision, grant_id, action_id, principal, request_key_digest, request_digest,
         execution_status, verification_status, recovery_status, result_summary, effects, attempts, external_handle, cancel_requested,
         recovers_operation_id, recovery_operation_ids, error, reconcile_attempts, created_at, updated_at, submitted_at, completed_at, row_revision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
       ON CONFLICT DO NOTHING`,
      [
        op.id,
        op.plan_id,
        op.task_id,
        op.task_revision,
        op.grant_id,
        op.action_id,
        op.principal,
        op.request_key_digest,
        op.request_digest,
        op.execution_status,
        op.verification_status,
        op.recovery_status,
        op.result_summary === null ? null : JSON.stringify(op.result_summary),
        JSON.stringify(op.effects),
        op.attempts,
        op.external_handle,
        op.cancel_requested,
        op.recovers_operation_id,
        op.recovery_operation_ids,
        op.error === null ? null : JSON.stringify(op.error),
        op.reconcile_attempts,
        op.created_at,
        op.updated_at,
        op.submitted_at,
        op.completed_at,
        op.row_revision,
      ],
    );
    return r.rowCount === 1;
  }

  async getOperation(id: string, lock = false): Promise<StoredOperation | null> {
    const r = await this.one(`SELECT * FROM operations WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
    return r ? rowToOperation(r) : null;
  }

  async updateOperation(op: StoredOperation): Promise<StoredOperation> {
    const r = await this.one(
      `UPDATE operations SET execution_status = $2, verification_status = $3, recovery_status = $4, result_summary = $5, effects = $6,
         attempts = $7, external_handle = $8, cancel_requested = $9, recovery_operation_ids = $10, error = $11, reconcile_attempts = $12,
         updated_at = $13, submitted_at = $14, completed_at = $15, row_revision = row_revision + 1
       WHERE id = $1 RETURNING *`,
      [
        op.id,
        op.execution_status,
        op.verification_status,
        op.recovery_status,
        op.result_summary === null ? null : JSON.stringify(op.result_summary),
        JSON.stringify(op.effects),
        op.attempts,
        op.external_handle,
        op.cancel_requested,
        op.recovery_operation_ids,
        op.error === null ? null : JSON.stringify(op.error),
        op.reconcile_attempts,
        op.updated_at,
        op.submitted_at,
        op.completed_at,
      ],
    );
    if (!r) throw new VapError("NOT_FOUND", "operation vanished during update");
    const updated = rowToOperation(r);
    op.row_revision = updated.row_revision;
    return updated;
  }

  async listOperations(f: OperationFilter): Promise<StoredOperation[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.principal) {
      params.push(f.principal);
      where.push(`principal = $${params.length}`);
    }
    if (f.task_id) {
      params.push(f.task_id);
      where.push(`task_id = $${params.length}`);
    }
    if (f.execution_status && f.execution_status.length > 0) {
      params.push(f.execution_status);
      where.push(`execution_status = ANY($${params.length})`);
    }
    params.push(f.limit);
    const sql = `SELECT * FROM operations ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT $${params.length}`;
    return (await this.many(sql, params)).map(rowToOperation);
  }

  async countOperationsForGrant(grantId: string, unresolvedOnly: boolean): Promise<number> {
    const r = await this.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM operations WHERE grant_id = $1 ${unresolvedOnly ? "AND execution_status IN ('queued','running','unknown')" : ""}`,
      [grantId],
    );
    return Number(r?.n ?? 0);
  }

  async listRunningOperationsForGrant(grantId: string): Promise<StoredOperation[]> {
    return (await this.many("SELECT * FROM operations WHERE grant_id = $1 AND execution_status = 'running'", [grantId])).map(rowToOperation);
  }

  // attempts
  async insertAttempt(a: AttemptRow): Promise<void> {
    await this.c.query(
      "INSERT INTO attempts (operation_id, sequence, worker_id, fence, dispatch_intent_at, submission, finished_at, external_handle, outcome) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [a.operation_id, a.sequence, a.worker_id, a.fence, a.dispatch_intent_at, a.submission, a.finished_at, a.external_handle, a.outcome],
    );
  }

  async finishAttempt(operationId: string, sequence: number, f: Pick<AttemptRow, "submission" | "external_handle" | "outcome">): Promise<void> {
    await this.c.query(
      "UPDATE attempts SET submission = $3, external_handle = $4, outcome = $5, finished_at = now() WHERE operation_id = $1 AND sequence = $2",
      [operationId, sequence, f.submission, f.external_handle, f.outcome],
    );
  }

  async listAttempts(operationId: string): Promise<AttemptRow[]> {
    const rows = await this.many("SELECT * FROM attempts WHERE operation_id = $1 ORDER BY sequence", [operationId]);
    return rows.map((r) => ({
      operation_id: r.operation_id as string,
      sequence: r.sequence as number,
      worker_id: r.worker_id as string,
      fence: Number(r.fence),
      dispatch_intent_at: iso(r.dispatch_intent_at),
      submission: (r.submission as AttemptRow["submission"]) ?? null,
      finished_at: isoOrNull(r.finished_at),
      external_handle: (r.external_handle as string | null) ?? null,
      outcome: (r.outcome as string | null) ?? null,
    }));
  }

  // events
  async appendEvent(operationId: string, type: EventType, actor: string, data: Record<string, unknown>): Promise<OperationEvent> {
    // Serialize appends per operation by locking its row (re-locking a held lock is a no-op).
    await this.c.query("SELECT 1 FROM operations WHERE id = $1 FOR UPDATE", [operationId]);
    const r = await this.one(
      `INSERT INTO events (operation_id, sequence, type, actor, data, at)
       VALUES ($1, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM events WHERE operation_id = $1), $2, $3, $4, now())
       RETURNING *`,
      [operationId, type, actor, JSON.stringify(data)],
    );
    return rowToEvent(r!);
  }

  async listEvents(operationId: string, after: number, limit: number): Promise<OperationEvent[]> {
    return (await this.many("SELECT * FROM events WHERE operation_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3", [operationId, after, limit])).map(rowToEvent);
  }

  // evidence
  async insertEvidence(e: Evidence): Promise<void> {
    await this.c.query(
      "INSERT INTO evidence (id, operation_id, task_id, task_revision, check_id, item_index, result, observed_at, body, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [e.id, e.operation_id, e.task_id, e.task_revision, e.check_id, e.item_index, e.result, e.observed_at, JSON.stringify(e), e.created_at],
    );
  }

  async getEvidence(id: string): Promise<Evidence | null> {
    return (await this.one<{ body: Evidence }>("SELECT body FROM evidence WHERE id = $1", [id]))?.body ?? null;
  }

  async listEvidenceForOperation(operationId: string): Promise<Evidence[]> {
    return (await this.many<{ body: Evidence }>("SELECT body FROM (SELECT body, created_at, id FROM evidence WHERE operation_id = $1 ORDER BY created_at DESC, id DESC LIMIT 2000) e ORDER BY created_at, id", [operationId])).map((r) => r.body);
  }

  async listEvidenceForTask(taskId: string, taskRevision: number): Promise<Evidence[]> {
    return (
      await this.many<{ body: Evidence }>("SELECT body FROM (SELECT body, created_at, id FROM evidence WHERE task_id = $1 AND task_revision = $2 ORDER BY created_at DESC, id DESC LIMIT 5000) e ORDER BY created_at, id", [taskId, taskRevision])
    ).map((r) => r.body);
  }

  // outbox
  async enqueue(kind: OutboxKind, operationId: string, delayMs = 0): Promise<void> {
    await this.c.query("INSERT INTO outbox (kind, operation_id, available_at) VALUES ($1, $2, now() + make_interval(secs => $3::double precision))", [
      kind,
      operationId,
      ms(delayMs),
    ]);
  }

  async hasPendingOutbox(operationId: string, kind?: OutboxKind): Promise<boolean> {
    const r = kind
      ? await this.one("SELECT 1 AS x FROM outbox WHERE operation_id = $1 AND kind = $2 AND completed_at IS NULL LIMIT 1", [operationId, kind])
      : await this.one("SELECT 1 AS x FROM outbox WHERE operation_id = $1 AND completed_at IS NULL LIMIT 1", [operationId]);
    return r !== null;
  }

  async leaseOutbox(workerId: string, limit: number, leaseMs: number, kinds?: OutboxKind[]): Promise<OutboxItem[]> {
    const rows = await this.many(
      `UPDATE outbox SET leased_by = $1, lease_expires_at = now() + make_interval(secs => $3::double precision), attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM outbox
           WHERE completed_at IS NULL AND available_at <= now()
             AND (lease_expires_at IS NULL OR lease_expires_at < now())
             AND ($4::text[] IS NULL OR kind = ANY($4::text[]))
           ORDER BY available_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT $2)
        RETURNING id, kind, operation_id, attempts, available_at`,
      [workerId, limit, ms(leaseMs), kinds ?? null],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      kind: r.kind as OutboxKind,
      operation_id: r.operation_id as string,
      attempts: r.attempts as number,
      available_at: iso(r.available_at),
    }));
  }

  async completeOutbox(id: number): Promise<void> {
    await this.c.query("UPDATE outbox SET completed_at = now(), lease_expires_at = NULL WHERE id = $1", [id]);
  }

  async extendOutboxLease(id: number, workerId: string, leaseMs: number): Promise<void> {
    await this.c.query(
      "UPDATE outbox SET lease_expires_at = now() + make_interval(secs => $3::double precision) WHERE id = $1 AND leased_by = $2 AND completed_at IS NULL",
      [id, workerId, ms(leaseMs)],
    );
  }

  async retryOutbox(id: number, delayMs: number): Promise<void> {
    await this.c.query(
      "UPDATE outbox SET available_at = now() + make_interval(secs => $2::double precision), leased_by = NULL, lease_expires_at = NULL WHERE id = $1",
      [id, ms(delayMs)],
    );
  }

  // claims
  async acquireClaim(operationId: string, workerId: string, leaseMs: number): Promise<number | null> {
    const r = await this.one<{ fence: string }>(
      `INSERT INTO worker_claims (operation_id, worker_id, fence, lease_expires_at, heartbeat_at)
       VALUES ($1, $2, 1, now() + make_interval(secs => $3::double precision), now())
       ON CONFLICT (operation_id) DO UPDATE
         SET worker_id = EXCLUDED.worker_id, fence = worker_claims.fence + 1,
             lease_expires_at = EXCLUDED.lease_expires_at, heartbeat_at = now()
         WHERE worker_claims.lease_expires_at < now()
       RETURNING fence`,
      [operationId, workerId, ms(leaseMs)],
    );
    return r ? Number(r.fence) : null;
  }

  async holdsClaim(operationId: string, fence: number): Promise<boolean> {
    const r = await this.one<{ fence: string; live: boolean }>(
      "SELECT fence, lease_expires_at > now() AS live FROM worker_claims WHERE operation_id = $1 FOR UPDATE",
      [operationId],
    );
    return r !== null && Number(r.fence) === fence && r.live;
  }

  async heartbeatClaim(operationId: string, fence: number, leaseMs: number): Promise<boolean> {
    const r = await this.c.query(
      "UPDATE worker_claims SET lease_expires_at = now() + make_interval(secs => $3::double precision), heartbeat_at = now() WHERE operation_id = $1 AND fence = $2 AND lease_expires_at > now()",
      [operationId, fence, ms(leaseMs)],
    );
    return r.rowCount === 1;
  }

  async releaseClaim(operationId: string, fence: number): Promise<void> {
    await this.c.query("UPDATE worker_claims SET lease_expires_at = now() - interval '1 millisecond' WHERE operation_id = $1 AND fence = $2", [
      operationId,
      fence,
    ]);
  }

  async listOrphanedOperations(limit: number): Promise<StoredOperation[]> {
    const rows = await this.many(
      `SELECT o.* FROM operations o
        WHERE o.execution_status = 'running'
          AND NOT EXISTS (SELECT 1 FROM worker_claims c WHERE c.operation_id = o.id AND c.lease_expires_at > now())
          AND NOT EXISTS (SELECT 1 FROM outbox b WHERE b.operation_id = o.id AND b.completed_at IS NULL)
        ORDER BY o.updated_at LIMIT $1`,
      [limit],
    );
    return rows.map(rowToOperation);
  }

  async listStrandedQueuedOperations(limit: number): Promise<StoredOperation[]> {
    const rows = await this.many(
      `SELECT o.* FROM operations o
        WHERE o.execution_status = 'queued' AND o.created_at < now() - interval '5 seconds'
          AND NOT EXISTS (SELECT 1 FROM worker_claims c WHERE c.operation_id = o.id AND c.lease_expires_at > now())
          AND NOT EXISTS (SELECT 1 FROM outbox b WHERE b.operation_id = o.id AND b.completed_at IS NULL)
        ORDER BY o.created_at LIMIT $1`,
      [limit],
    );
    return rows.map(rowToOperation);
  }

  // retention
  async expireRequestKeys(olderThanIso: string): Promise<number> {
    const r = await this.c.query(
      `WITH expired AS (
         UPDATE operations SET request_key_expired = true
          WHERE NOT request_key_expired AND created_at < $1
            AND execution_status IN ('completed','failed','partial','cancelled')
          RETURNING request_key_digest, id)
       INSERT INTO request_key_tombstones (request_key_digest, operation_id, expired_at)
       SELECT request_key_digest, id, now() FROM expired
       ON CONFLICT DO NOTHING`,
      [olderThanIso],
    );
    return r.rowCount ?? 0;
  }

  async purgeResolvedOperations(olderThanIso: string): Promise<number> {
    await this.c.query("DELETE FROM artifacts WHERE created_at < $1", [olderThanIso]);
    const r = await this.c.query(
      `DELETE FROM operations
        WHERE request_key_expired AND completed_at < $1
          AND execution_status IN ('completed','failed','partial','cancelled')
          AND recovery_status NOT IN ('requested','running','unknown')`,
      [olderThanIso],
    );
    return r.rowCount ?? 0;
  }
}

export interface PgJournalOptions {
  connectionString?: string;
  pool?: PoolConfig;
  statementTimeoutMs?: number;
}

/**
 * PostgreSQL journal. Mutation acceptance fails closed: if a transaction cannot be
 * durably recorded the caller receives UNAVAILABLE and nothing is acknowledged.
 */
export class PgJournal implements Journal {
  readonly pool: Pool;
  private readonly statementTimeoutMs: number;

  constructor(opts: PgJournalOptions) {
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ...opts.pool,
    });
    this.pool.on("error", () => {
      // Idle client errors are surfaced on the next checkout.
    });
    this.statementTimeoutMs = opts.statementTimeoutMs ?? 15_000;
  }

  async transaction<T>(fn: (tx: JournalTx) => Promise<T>): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (e) {
      throw new VapError("UNAVAILABLE", "journal database is unavailable; nothing was recorded", { cause: e });
    }
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout = ${Math.floor(this.statementTimeoutMs)}`);
      const result = await fn(new PgTx(client));
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (e instanceof VapError) throw e;
      const code = (e as { code?: string }).code;
      if (code === "23505") throw e; // unique violation: callers retry the acceptance transaction
      if (code && /^(08|57P|53)/.test(code)) {
        throw new VapError("UNAVAILABLE", "journal database is unavailable; the transaction was rolled back", { cause: e });
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
