import {
  canonicalize,
  keyedDigest,
  newId,
  PROTOCOL_VERSION,
  schemaValidator,
  VapError,
} from "@vap/protocol";
import type {
  ActionDescriptor,
  ActionListEntry,
  Approval,
  ApprovalCreateRequest,
  Check,
  Effect,
  Evidence,
  Grant,
  GrantCreateRequest,
  HumanEvidenceRequest,
  Observation,
  ObservationRequest,
  Operation,
  OperationCreateRequest,
  OperationEvent,
  OperatorResolutionRequest,
  Plan,
  PlanCreateRequest,
  Receipt,
  RecoverRequest,
  ReconcileResolution,
  Task,
  TaskCreateRequest,
  TaskOutcome,
  TaskReviseRequest,
} from "@vap/protocol";
import type { Adapter, AdapterContext, AdapterResult, ExecuteContext, LookupResult } from "./adapter.js";
import type { ArtifactStore } from "./artifacts.js";
import type { CloudExecutor } from "./executor.js";
import type { Journal, JournalTx, OutboxItem, StoredOperation, StoredPlan } from "./journal.js";
import type { Logger } from "./log.js";
import { silentLogger } from "./log.js";
import { evaluateGrant, scopeWithinGrant, anyResourceMatch } from "./policy.js";
import { evaluatePredicate, PredicateError, predicatePaths, validatePredicate, jsonPointerGet } from "./predicate.js";
import type { Principal } from "./principal.js";
import { hasRole } from "./principal.js";
import { redact, redactString } from "./redact.js";
import type { AdapterRegistry } from "./registry.js";
import { expandTemplate } from "./template.js";
import { buildReceipt, evaluatePlan, evaluateTaskOutcome, latestAggregateEvidence, operationView, planView } from "./views.js";
import type { PlanEvaluation } from "./views.js";

export interface CoordinatorOptions {
  /** Deployment secret for keyed digests (plan digests, request-key digests). */
  digestKey: string | Uint8Array;
  /** Stable deployment identifier; part of every request-key scope. */
  deploymentId: string;
  clock?: () => number;
  log?: Logger;
  executor?: CloudExecutor | null;
  artifacts?: ArtifactStore | null;
  claimLeaseMs?: number;
  defaultPlanTtlSeconds?: number;
  requestKeyRetentionMs?: number;
  operationRetentionMs?: number;
  maxReconcileAttempts?: number;
  maxDispatchAttempts?: number;
  maxObservationBytes?: number;
  defaultExecutionTimeoutMs?: number;
  maxExecutionTimeoutMs?: number;
  cancelPollMs?: number;
}

/** Longest check deadline the API runs synchronously; longer checks go to a worker. */
export const SYNC_VERIFY_MAX_SECONDS = 20;

const VERIFIER_LIMITATION = "verifier runs inside the VAP runtime process; this is a distinct read of persisted state, not organizational or cryptographic independence";

class AcceptRace extends Error {}
class RecheckDenied extends Error {
  constructor(readonly error: VapError) {
    super(error.message);
  }
}

type DispatchStep =
  | { kind: "lost" }
  | { kind: "final"; op: StoredOperation }
  | { kind: "reconcile" }
  | { kind: "execute"; op: StoredOperation; plan: StoredPlan; attempt: number };

export interface DispatchSummary {
  operation_id: string;
  result: "claimed_elsewhere" | "claim_lost" | "already_final" | "denied" | "executed" | "reconciled" | "cancelled";
  execution_status?: string;
}

export class Coordinator {
  readonly journal: Journal;
  readonly registry: AdapterRegistry;
  readonly log: Logger;
  private readonly key: string | Uint8Array;
  private readonly deploymentId: string;
  private readonly clock: () => number;
  private readonly executor: CloudExecutor | null;
  private readonly artifacts: ArtifactStore | null;
  private readonly syncVerifications = new Map<string, number>();
  readonly opts: Required<Omit<CoordinatorOptions, "digestKey" | "deploymentId" | "clock" | "log" | "executor" | "artifacts">>;

  constructor(journal: Journal, registry: AdapterRegistry, options: CoordinatorOptions) {
    if (typeof options.digestKey === "string" ? options.digestKey.length < 32 : options.digestKey.byteLength < 32) {
      throw new Error("digestKey must be at least 32 bytes");
    }
    this.journal = journal;
    this.registry = registry;
    this.key = options.digestKey;
    this.deploymentId = options.deploymentId;
    this.clock = options.clock ?? Date.now;
    this.log = options.log ?? silentLogger;
    this.executor = options.executor ?? null;
    this.artifacts = options.artifacts ?? null;
    this.opts = {
      claimLeaseMs: options.claimLeaseMs ?? 30_000,
      defaultPlanTtlSeconds: options.defaultPlanTtlSeconds ?? 300,
      requestKeyRetentionMs: options.requestKeyRetentionMs ?? 7 * 24 * 3600_000,
      operationRetentionMs: options.operationRetentionMs ?? 30 * 24 * 3600_000,
      maxReconcileAttempts: options.maxReconcileAttempts ?? 5,
      maxDispatchAttempts: options.maxDispatchAttempts ?? 3,
      maxObservationBytes: options.maxObservationBytes ?? 64 * 1024,
      defaultExecutionTimeoutMs: options.defaultExecutionTimeoutMs ?? 60_000,
      maxExecutionTimeoutMs: options.maxExecutionTimeoutMs ?? 15 * 60_000,
      cancelPollMs: options.cancelPollMs ?? 500,
    };
  }

  now(): number {
    return this.clock();
  }

  private iso(ms = this.clock()): string {
    return new Date(ms).toISOString();
  }

  private tx<T>(fn: (tx: JournalTx) => Promise<T>): Promise<T> {
    return this.journal.transaction(fn);
  }

  private ctx(principal: string, taskId: string, operationId: string | null, deadlineMs: number, allowedTargets: string[], signal?: AbortSignal): AdapterContext {
    return {
      principal,
      taskId,
      operationId,
      deadline: this.clock() + deadlineMs,
      signal: signal ?? AbortSignal.timeout(deadlineMs),
      allowedTargets,
      log: this.log.child({ operation_id: operationId, task_id: taskId }),
    };
  }

  // ---------------------------------------------------------------- read authorization

  /** Owner (the grant's principal) or an operator/viewer may read. Others get NOT_FOUND. */
  private canRead(p: Principal, ownerId: string): boolean {
    return p.id === ownerId || hasRole(p, "operator") || hasRole(p, "viewer");
  }

  /**
   * Calls that cause destination reads or change journal state (observe, verify, reconcile)
   * need the owner or an operator. Viewers are read-only.
   */
  private canAct(p: Principal, ownerId: string): boolean {
    return p.id === ownerId || hasRole(p, "operator");
  }

  private requireRole(p: Principal, role: "operator" | "approver"): void {
    if (!hasRole(p, role)) throw new VapError("FORBIDDEN", `${role} role required`);
  }

  /**
   * Workspace resources (workspace://<operation id>/...) belong to the operation's principal.
   * A grant pattern such as workspace://* authorizes the class of resource, not other
   * principals' workspaces, so ownership is enforced here for every workspace URI.
   */
  private async assertWorkspaceOwnership(tx: JournalTx, principalId: string, uris: string[]): Promise<void> {
    for (const uri of uris) {
      const m = /^workspace:\/\/(op_[A-Za-z0-9_-]{8,64})(\/|$)/.exec(uri);
      if (!m) continue;
      const owner = await tx.getOperation(m[1]);
      if (!owner || owner.principal !== principalId) throw new VapError("NOT_FOUND", "workspace not found");
    }
  }

  /** Keeps a claim alive while fn runs; every claim holder that calls an adapter uses it. */
  private async withClaimHeartbeat<T>(operationId: string, fence: number, fn: () => Promise<T>): Promise<T> {
    const heartbeat = setInterval(() => {
      this.tx((tx) => tx.heartbeatClaim(operationId, fence, this.opts.claimLeaseMs)).catch(() => {});
    }, Math.max(1000, Math.floor(this.opts.claimLeaseMs / 3)));
    heartbeat.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
    }
  }

  // ---------------------------------------------------------------- grants (operator)

  async createGrant(operator: Principal, req: GrantCreateRequest): Promise<Grant> {
    this.requireRole(operator, "operator");
    if (Date.parse(req.expires_at) <= this.clock()) throw new VapError("INVALID_ARGUMENT", "expires_at must be in the future");
    const grant: Grant = {
      protocol_version: PROTOCOL_VERSION,
      id: newId("grt"),
      principal: req.principal,
      allowed_actions: req.allowed_actions,
      allowed_targets: req.allowed_targets,
      risk_ceiling: req.risk_ceiling,
      preauthorized_actions: req.preauthorized_actions ?? [],
      limits: req.limits ?? { max_operations: null, max_items_per_operation: null, max_concurrent_operations: null },
      expires_at: new Date(Date.parse(req.expires_at)).toISOString(),
      revocation_revision: 0,
      revoked_at: null,
      issuer: operator.id,
      created_at: this.iso(),
    };
    await this.tx((tx) => tx.insertGrant(grant));
    this.log.info("grant created", { grant_id: grant.id, principal: grant.principal, issuer: operator.id });
    return grant;
  }

  async getGrant(p: Principal, id: string): Promise<Grant> {
    const g = await this.tx((tx) => tx.getGrant(id));
    if (!g || !this.canRead(p, g.principal)) throw new VapError("NOT_FOUND", "grant not found");
    return g;
  }

  async listGrants(p: Principal): Promise<Grant[]> {
    return this.tx((tx) => tx.listGrants(hasRole(p, "operator") ? null : p.id));
  }

  /**
   * Kill switch for one grant. Stops new dispatches (queued operations are denied at the
   * dispatch recheck), rejects new writes (plans become stale), and requests cancellation
   * of running operations. It cannot undo effects that already happened.
   */
  async revokeGrant(operator: Principal, id: string): Promise<Grant> {
    this.requireRole(operator, "operator");
    return this.tx(async (tx) => {
      const g = await tx.revokeGrant(id, this.iso());
      if (!g) throw new VapError("NOT_FOUND", "grant not found");
      for (const op of await tx.listRunningOperationsForGrant(id)) {
        const locked = await tx.getOperation(op.id, true);
        if (!locked || locked.execution_status !== "running") continue;
        locked.cancel_requested = true;
        locked.updated_at = this.iso();
        await tx.updateOperation(locked);
        await tx.appendEvent(op.id, "grant.revoked_after_dispatch", operator.id, {
          grant_id: id,
          note: "grant revoked after dispatch; cancellation requested and the outcome will be reconciled; completed effects are not undone",
        });
      }
      return g;
    });
  }

  async setPrincipalRoles(operator: Principal, subject: string, roles: Principal["roles"]): Promise<void> {
    this.requireRole(operator, "operator");
    await this.tx((tx) => tx.upsertPrincipal(subject, roles));
  }

  // ---------------------------------------------------------------- tasks

  private validateChecks(checks: Check[]): void {
    const ids = new Set<string>();
    for (const c of checks) {
      if (ids.has(c.id)) throw new VapError("INVALID_ARGUMENT", `duplicate check id ${c.id}`);
      ids.add(c.id);
      try {
        validatePredicate(c.predicate);
      } catch (e) {
        if (e instanceof PredicateError) throw new VapError("INVALID_ARGUMENT", `check ${c.id}: ${e.message}`);
        throw e;
      }
      if (c.method !== "human_judgment") this.registry.adapterForVerifier(c.verifier_id);
      if ((c.scope ?? "single") === "each_effect" && c.target !== "{effect.resource_uri}") {
        throw new VapError("INVALID_ARGUMENT", `check ${c.id}: each_effect checks must use target "{effect.resource_uri}"`);
      }
    }
  }

  async openTask(p: Principal, req: TaskCreateRequest): Promise<Task> {
    this.validateChecks(req.required_checks);
    return this.tx(async (tx) => {
      const grant = await tx.getGrant(req.grant_id);
      if (!grant || grant.principal !== p.id) throw new VapError("NOT_FOUND", "grant not found for this principal");
      if (grant.revoked_at !== null || Date.parse(grant.expires_at) <= this.clock()) throw new VapError("FORBIDDEN", "grant is revoked or expired");
      const problems = scopeWithinGrant(req.scope, grant);
      if (problems.length > 0) throw new VapError("FORBIDDEN", "task scope exceeds the grant", { details: { problems } });
      const now = this.iso();
      const task: Task = {
        protocol_version: PROTOCOL_VERSION,
        id: newId("tsk"),
        contract_revision: 1,
        goal: req.goal,
        owner: p.id,
        grant_id: grant.id,
        scope: req.scope,
        requirements: req.requirements ?? [],
        assumptions: req.assumptions ?? [],
        required_checks: req.required_checks.map((c) => ({ scope: "single" as const, provenance: "user" as const, ...c })),
        created_at: now,
        revised_at: now,
      };
      if (req.extensions) task.extensions = req.extensions;
      await tx.insertTask(task);
      return task;
    });
  }

  async getTask(p: Principal, id: string): Promise<Task> {
    const t = await this.tx((tx) => tx.getTask(id));
    if (!t || !this.canRead(p, t.owner)) throw new VapError("NOT_FOUND", "task not found");
    return t;
  }

  /**
   * New contract revision. Non-operators may add checks (recorded with agent provenance)
   * and change assumptions, but cannot remove or alter user/operator checks or
   * requirements: an agent may propose checks but not weaken the user's requirements.
   */
  async reviseTask(p: Principal, id: string, req: TaskReviseRequest): Promise<Task> {
    const isOperator = hasRole(p, "operator");
    return this.tx(async (tx) => {
      const cur = await tx.getTask(id);
      if (!cur || !this.canRead(p, cur.owner)) throw new VapError("NOT_FOUND", "task not found");
      if (cur.owner !== p.id && !isOperator) throw new VapError("FORBIDDEN", "only the task owner or an operator can revise a task");
      if (cur.contract_revision !== req.expected_revision) {
        throw new VapError("CONFLICT", `task is at revision ${cur.contract_revision}, not ${req.expected_revision}`);
      }
      let checks = cur.required_checks;
      if (req.required_checks) {
        const incoming = req.required_checks.map((c) => {
          const existing = cur.required_checks.find((e) => e.id === c.id);
          if (existing) return { scope: "single" as const, ...c, provenance: existing.provenance };
          return { scope: "single" as const, ...c, provenance: isOperator ? (c.provenance ?? "operator") : ("agent" as const) };
        });
        this.validateChecks(incoming);
        if (!isOperator) {
          for (const e of cur.required_checks) {
            if (e.provenance === "agent") continue;
            const n = incoming.find((c) => c.id === e.id);
            if (!n || canonicalize(n) !== canonicalize(e)) {
              throw new VapError("FORBIDDEN", `check ${e.id} has ${e.provenance} provenance and can only be changed or removed by an operator`);
            }
          }
        }
        checks = incoming;
      }
      let requirements = cur.requirements;
      if (req.requirements) {
        if (!isOperator) {
          for (const r of cur.requirements) {
            if (r.provenance === "agent") continue;
            const n = req.requirements.find((x) => x.id === r.id);
            if (!n || n.text !== r.text || n.provenance !== r.provenance) {
              throw new VapError("FORBIDDEN", `requirement ${r.id} can only be changed or removed by an operator`);
            }
          }
          // Stored provenance is authoritative: an agent cannot relabel its own statements.
          requirements = req.requirements.map((r) => {
            const existing = cur.requirements.find((x) => x.id === r.id);
            return { ...r, provenance: existing ? existing.provenance : ("agent" as const) };
          });
        } else requirements = req.requirements;
      }
      if (req.goal !== undefined && req.goal !== cur.goal && !isOperator) {
        throw new VapError("FORBIDDEN", "only an operator can change a task goal");
      }
      const next: Task = {
        ...cur,
        contract_revision: cur.contract_revision + 1,
        goal: req.goal ?? cur.goal,
        requirements,
        assumptions: req.assumptions ?? cur.assumptions,
        required_checks: checks,
        revised_at: this.iso(),
      };
      if (!(await tx.reviseTask(next, cur.contract_revision))) throw new VapError("CONFLICT", "task was revised concurrently");
      return next;
    });
  }

  async taskOutcome(p: Principal, id: string): Promise<TaskOutcome> {
    return this.tx(async (tx) => {
      const task = await tx.getTask(id);
      if (!task || !this.canRead(p, task.owner)) throw new VapError("NOT_FOUND", "task not found");
      const evidence = await tx.listEvidenceForTask(task.id, task.contract_revision);
      const ops = await tx.listOperations({ task_id: task.id, limit: 1000 });
      return evaluateTaskOutcome(task, evidence, ops, this.clock());
    });
  }

  // ---------------------------------------------------------------- discovery

  async listActions(p: Principal, taskId: string | null): Promise<ActionListEntry[]> {
    const { task, grant } = await this.tx(async (tx) => {
      if (taskId) {
        const task = await tx.getTask(taskId);
        if (!task || !this.canRead(p, task.owner)) throw new VapError("NOT_FOUND", "task not found");
        return { task, grant: await tx.getGrant(task.grant_id) };
      }
      const grants = await tx.listGrants(p.id);
      return { task: null, grant: grants.find((g) => g.revoked_at === null && Date.parse(g.expires_at) > this.clock()) ?? null };
    });
    return this.registry.listActions().map(({ descriptor }) => {
      if (!grant) return { action: descriptor, permitted: false, requires_approval: descriptor.risk_tier >= 2, blockers: ["no active grant for this principal"] };
      const ev = evaluateGrant({
        grant,
        principalId: p.id,
        actionId: descriptor.id,
        tier: descriptor.risk_tier,
        resources: [],
        taskScope: task?.scope ?? { actions: ["*"], resources: [] },
        now: this.clock(),
      });
      return { action: descriptor, permitted: ev.permitted, requires_approval: ev.requiresApproval, blockers: ev.blockers };
    });
  }

  async observe(p: Principal, req: ObservationRequest): Promise<Observation> {
    const { task, grant } = await this.tx(async (tx) => {
      const task = await tx.getTask(req.task_id);
      if (!task || !this.canRead(p, task.owner)) throw new VapError("NOT_FOUND", "task not found");
      if (!this.canAct(p, task.owner)) throw new VapError("FORBIDDEN", "observations require the task owner or an operator");
      await this.assertWorkspaceOwnership(tx, task.owner, [req.resource_uri]);
      return { task, grant: await tx.getGrant(task.grant_id) };
    });
    if (!grant || grant.revoked_at !== null || Date.parse(grant.expires_at) <= this.clock()) throw new VapError("FORBIDDEN", "task grant is revoked or expired");
    if (!anyResourceMatch(grant.allowed_targets, req.resource_uri) || !anyResourceMatch(task.scope.resources, req.resource_uri)) {
      throw new VapError("FORBIDDEN", "resource is outside the task scope or grant");
    }
    const maxBytes = Math.min(req.max_bytes ?? this.opts.maxObservationBytes, this.opts.maxObservationBytes);
    const adapter = this.registry.adapterForResource(req.resource_uri);
    const res = await adapter.observe(
      { resource_uri: req.resource_uri, cursor: req.cursor ?? null, max_bytes: maxBytes },
      this.ctx(p.id, task.id, null, 15_000, grant.allowed_targets),
    );
    const facts = redact(res.facts) as Record<string, unknown>;
    const bounded = boundFacts(facts, maxBytes);
    return {
      protocol_version: PROTOCOL_VERSION,
      id: newId("obs"),
      resource_uri: req.resource_uri,
      observed_at: this.iso(),
      source: res.source,
      source_version: res.source_version,
      freshness: res.freshness,
      facts: bounded.facts,
      unknowns: [...res.unknowns, ...bounded.omitted.map((k) => `fact ${k} omitted by the ${maxBytes}-byte observation limit`)],
      completeness: bounded.omitted.length > 0 ? "truncated" : res.completeness,
      limits: { bytes: bounded.bytes, max_bytes: maxBytes, estimated_tokens: Math.ceil(bounded.bytes / 4), truncated: bounded.omitted.length > 0 },
      next_cursor: res.next_cursor ?? null,
    };
  }

  // ---------------------------------------------------------------- plans

  private planDigest(plan: Omit<StoredPlan, "digest">): string {
    return keyedDigest(this.key, {
      v: 1,
      deployment: this.deploymentId,
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
      expires_at: plan.expires_at,
      recovery_of: plan.recovery_of,
      frozen: plan.frozen,
      affected_resources: plan.affected_resources,
      item_count: plan.item_count,
    });
  }

  /**
   * Prepare is read-only by contract: it validates arguments, reads resource versions,
   * evaluates grant scope, produces a preview, freezes checks and policy revision, and
   * computes the keyed digest and expiry.
   */
  async preparePlan(p: Principal, req: PlanCreateRequest, recoveryOf: string | null = null, extraChecks: Check[] = []): Promise<Plan> {
    const { descriptor, adapter } = this.registry.action(req.action_id);
    const { task, grant } = await this.tx(async (tx) => {
      const task = await tx.getTask(req.task_id);
      if (!task || !this.canRead(p, task.owner)) throw new VapError("NOT_FOUND", "task not found");
      if (task.owner !== p.id) throw new VapError("FORBIDDEN", "only the task owner can prepare plans");
      return { task, grant: await tx.getGrant(task.grant_id) };
    });
    if (!grant) throw new VapError("FORBIDDEN", "task grant no longer exists");

    const pre = evaluateGrant({ grant, principalId: p.id, actionId: descriptor.id, tier: descriptor.risk_tier, resources: [], taskScope: task.scope, now: this.clock() });
    if (!pre.permitted) throw new VapError("FORBIDDEN", "action is not permitted", { details: { blockers: pre.blockers } });

    const argIssues = schemaValidator().compileInputSchema(descriptor.input_schema)(req.arguments);
    if (argIssues.length > 0) throw new VapError("INVALID_ARGUMENT", "arguments do not match the action input schema", { details: { issues: argIssues } });

    const sourceOp = req.arguments.source_operation_id;
    if (typeof sourceOp === "string") await this.tx((tx) => this.assertWorkspaceOwnership(tx, p.id, [`workspace://${sourceOp}/`]));
    const prep = await adapter.prepare(descriptor, req.arguments, this.ctx(p.id, task.id, null, 15_000, grant.allowed_targets));
    // The canonical form must be encodable (rejects non-finite numbers, undefined, etc).
    try {
      canonicalize(prep.canonical_arguments);
    } catch (e) {
      throw new VapError("INVALID_ARGUMENT", `arguments are not canonical JSON: ${(e as Error).message}`);
    }

    const full = evaluateGrant({ grant, principalId: p.id, actionId: descriptor.id, tier: descriptor.risk_tier, resources: prep.affected_resources, taskScope: task.scope, now: this.clock() });
    if (!full.permitted) throw new VapError("FORBIDDEN", "affected resources are outside the grant or task scope", { details: { blockers: full.blockers } });
    await this.tx((tx) => this.assertWorkspaceOwnership(tx, p.id, prep.affected_resources));

    const maxItems = grant.limits.max_items_per_operation;
    if (maxItems !== null) {
      const unbounded = descriptor.side_effects.filter((s) => s.class !== "none" && !s.bounded);
      if (unbounded.length > 0) {
        throw new VapError("LIMIT_EXCEEDED", "the grant caps items per operation but this action cannot bound its effects before dispatch", {
          details: { unbounded_side_effects: unbounded.map((s) => s.id) },
        });
      }
      if ((prep.item_count ?? 1) > maxItems) throw new VapError("LIMIT_EXCEEDED", `plan affects ${prep.item_count} items; the grant allows ${maxItems}`);
    }
    if (descriptor.limits?.max_items && (prep.item_count ?? 1) > descriptor.limits.max_items) {
      throw new VapError("LIMIT_EXCEEDED", `action allows at most ${descriptor.limits.max_items} items`);
    }

    let checks: Check[];
    if (req.check_ids) {
      checks = req.check_ids.map((id) => {
        const c = task.required_checks.find((x) => x.id === id);
        if (!c) throw new VapError("INVALID_ARGUMENT", `task has no check ${id}`);
        return c;
      });
    } else {
      checks = task.required_checks.filter((c) => descriptor.verifier_ids.includes(c.verifier_id) || c.method === "human_judgment");
    }
    checks = [...checks, ...extraChecks];

    const ttl = Math.min(descriptor.plan_ttl_seconds ?? this.opts.defaultPlanTtlSeconds, 86400);
    const now = this.clock();
    const base: Omit<StoredPlan, "digest"> = {
      id: newId("pln"),
      task_id: task.id,
      task_revision: task.contract_revision,
      action_id: descriptor.id,
      adapter: descriptor.adapter,
      principal: p.id,
      grant_id: grant.id,
      canonical_arguments: prep.canonical_arguments,
      resource_conditions: prep.resource_conditions,
      preview: prep.preview,
      risk_tier: descriptor.risk_tier,
      required_checks: checks,
      policy_revision: this.registry.policyRevision,
      grant_revocation_revision: grant.revocation_revision,
      created_at: this.iso(now),
      expires_at: this.iso(now + ttl * 1000),
      recovery_of: recoveryOf,
      approval_required: full.requiresApproval,
      approval_reason: full.approvalReason,
      frozen: prep.frozen ?? null,
      affected_resources: prep.affected_resources,
      item_count: prep.item_count,
    };
    const stored: StoredPlan = { ...base, digest: this.planDigest(base) };
    await this.tx((tx) => tx.insertPlan(stored));
    return this.planViewFor(stored, task, grant, []);
  }

  private planViewFor(plan: StoredPlan, task: Task | null, grant: Grant | null, approvals: Approval[]): Plan {
    return planView(plan, this.evaluate(plan, task, grant, approvals));
  }

  private evaluate(plan: StoredPlan, task: Task | null, grant: Grant | null, approvals: Approval[]): PlanEvaluation {
    const current = this.registry.hasAction(plan.action_id) ? this.registry.action(plan.action_id).descriptor.adapter.version : null;
    return evaluatePlan(plan, { now: this.clock(), task, grant, policyRevision: this.registry.policyRevision, currentAdapterVersion: current, approvals });
  }

  async getPlan(p: Principal, id: string): Promise<Plan> {
    return this.tx(async (tx) => {
      const plan = await tx.getPlan(id);
      if (!plan || !this.canRead(p, plan.principal)) throw new VapError("NOT_FOUND", "plan not found");
      const view = this.planViewFor(plan, await tx.getTask(plan.task_id), await tx.getGrant(plan.grant_id), await tx.listApprovalsForPlan(plan.id));
      const used = await tx.findOperationByPlan(plan.id);
      if (used && view.approval.state === "approved") view.approval.state = "consumed";
      return view;
    });
  }

  async listPendingApprovals(p: Principal): Promise<Plan[]> {
    if (!hasRole(p, "approver") && !hasRole(p, "operator")) throw new VapError("FORBIDDEN", "approver or operator role required");
    return this.tx(async (tx) => {
      const out: Plan[] = [];
      for (const plan of await tx.listPendingApprovalPlans(100)) {
        const view = this.planViewFor(plan, await tx.getTask(plan.task_id), await tx.getGrant(plan.grant_id), await tx.listApprovalsForPlan(plan.id));
        if (view.status === "awaiting_approval") out.push(view);
      }
      return out;
    });
  }

  /**
   * Plan-bound approval. The approver comes from authentication, must hold the approver
   * role and must not be the executing principal. The decision binds the exact digest.
   */
  async decideApproval(approver: Principal, req: ApprovalCreateRequest): Promise<Approval> {
    this.requireRole(approver, "approver");
    return this.tx(async (tx) => {
      const plan = await tx.getPlan(req.plan_id);
      if (!plan) throw new VapError("NOT_FOUND", "plan not found");
      if (approver.id === plan.principal) throw new VapError("FORBIDDEN", "self-approval is not permitted");
      if (req.plan_digest !== plan.digest) throw new VapError("CONFLICT", "plan_digest does not match the plan; review the current plan before deciding");
      const ev = this.evaluate(plan, await tx.getTask(plan.task_id), await tx.getGrant(plan.grant_id), await tx.listApprovalsForPlan(plan.id));
      if (ev.status !== "awaiting_approval") throw new VapError("CONFLICT", `plan is ${ev.status}; only plans awaiting approval can be decided`, { details: { reasons: ev.reasons } });
      if (!plan.approval_required) throw new VapError("CONFLICT", "plan does not require approval");
      const now = this.clock();
      const ttl = (req.expires_in_seconds ?? 900) * 1000;
      const approval: Approval = {
        protocol_version: PROTOCOL_VERSION,
        id: newId("apv"),
        plan_id: plan.id,
        plan_digest: plan.digest,
        decision: req.decision,
        approver: approver.id,
        approved_scope: { action_id: plan.action_id, risk_tier: plan.risk_tier, resource_uris: plan.affected_resources },
        created_at: this.iso(now),
        expires_at: this.iso(Math.min(now + ttl, Date.parse(plan.expires_at))),
        single_use: true,
        consumed_by_operation_id: null,
        note: req.note ?? null,
      };
      await tx.insertApproval(approval);
      return approval;
    });
  }

  // ---------------------------------------------------------------- execution acceptance

  private requestKeyDigest(principalId: string, actionId: string, requestKey: string): string {
    return keyedDigest(this.key, { v: 1, deployment: this.deploymentId, principal: principalId, action_id: actionId, request_key: requestKey });
  }

  /**
   * Durable acceptance (spec 7, 8). In one transaction: idempotency lookup, authorization,
   * approval consumption, operation insert, first event and outbox record. Identical
   * repeats return the original operation; a key reused with a different plan conflicts.
   */
  async submitOperation(p: Principal, req: OperationCreateRequest): Promise<{ operation: Operation; replayed: boolean }> {
    const planHead = await this.tx((tx) => tx.getPlan(req.plan_id));
    if (!planHead || planHead.principal !== p.id) throw new VapError("NOT_FOUND", "plan not found");
    const keyDigest = this.requestKeyDigest(p.id, planHead.action_id, req.request_key);
    const requestDigest = keyedDigest(this.key, { v: 1, plan_id: planHead.id, plan_digest: planHead.digest });

    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.tx(async (tx) => {
          // Lock the grant first: it serializes acceptance under one grant (limits, revocation)
          // and guarantees the key lookup below sees any concurrent submission that committed.
          const grant = await tx.getGrant(planHead.grant_id, "update");
          const existing = await tx.findOperationByRequestKey(keyDigest);
          if (existing) {
            if (existing.request_digest === requestDigest) return { op: existing, replayed: true };
            throw new VapError("KEY_REUSE_CONFLICT", "request key was already used for a different plan", { operationId: existing.id });
          }
          const tomb = await tx.findTombstone(keyDigest);
          if (tomb) {
            throw new VapError("REQUEST_KEY_EXPIRED", "request key retention expired; the original operation is no longer replayable under this key", {
              operationId: tomb.operation_id,
            });
          }
          const plan = (await tx.getPlan(req.plan_id))!;
          const task = await tx.getTask(plan.task_id);
          const prior = await tx.findOperationByPlan(plan.id);
          if (prior) {
            if (prior.request_key_digest === keyDigest && prior.request_digest === requestDigest) return { op: prior, replayed: true };
            throw new VapError("CONFLICT", "plan was already executed under a different request key; prepare a new plan", { operationId: prior.id });
          }
          const approvals = await tx.listApprovalsForPlan(plan.id);
          const ev = this.evaluate(plan, task, grant, approvals);
          if (ev.status === "stale") throw new VapError("STALE_PLAN", "plan is stale", { details: { reasons: ev.reasons } });
          if (ev.status === "expired") throw new VapError("PLAN_EXPIRED", "plan expired; prepare a new plan");
          if (ev.status === "denied") throw new VapError("FORBIDDEN", "plan approval was denied");
          if (ev.status === "awaiting_approval") throw new VapError("APPROVAL_REQUIRED", plan.approval_reason ?? "approval required", { details: { approval_state: ev.approvalState } });
          const auth = evaluateGrant({ grant: grant!, principalId: p.id, actionId: plan.action_id, tier: plan.risk_tier, resources: plan.affected_resources, taskScope: task!.scope, now: this.clock() });
          if (!auth.permitted) throw new VapError("FORBIDDEN", "not permitted", { details: { blockers: auth.blockers } });
          if (grant!.limits.max_operations !== null && (await tx.countOperationsForGrant(grant!.id, false)) >= grant!.limits.max_operations) {
            throw new VapError("LIMIT_EXCEEDED", "grant operation limit reached");
          }
          if (grant!.limits.max_concurrent_operations !== null && (await tx.countOperationsForGrant(grant!.id, true)) >= grant!.limits.max_concurrent_operations) {
            throw new VapError("LIMIT_EXCEEDED", "grant concurrent operation limit reached; resolve unresolved operations first");
          }
          const now = this.iso();
          const op: StoredOperation = {
            id: newId("op"),
            plan_id: plan.id,
            task_id: plan.task_id,
            task_revision: plan.task_revision,
            grant_id: plan.grant_id,
            action_id: plan.action_id,
            principal: p.id,
            request_key_digest: keyDigest,
            request_digest: requestDigest,
            execution_status: "queued",
            verification_status: "not_requested",
            recovery_status: "none",
            result_summary: null,
            effects: [],
            attempts: 0,
            external_handle: null,
            cancel_requested: false,
            recovers_operation_id: plan.recovery_of,
            recovery_operation_ids: [],
            error: null,
            reconcile_attempts: 0,
            created_at: now,
            updated_at: now,
            submitted_at: null,
            completed_at: null,
            row_revision: 1,
          };
          if (plan.approval_required) {
            if (!ev.approval) throw new VapError("APPROVAL_REQUIRED", "approval required");
            if (!(await tx.consumeApproval(ev.approval.id, op.id))) {
              // Consumed concurrently: if by an identical submission, the retry replays it;
              // otherwise the retry reports the plan as already executed.
              throw new AcceptRace();
            }
          }
          if (!(await tx.insertOperation(op))) throw new AcceptRace();
          await tx.appendEvent(op.id, "operation.accepted", p.id, { plan_id: plan.id, plan_digest: plan.digest, approval_id: ev.approval?.id ?? null, risk_tier: plan.risk_tier });
          if (plan.recovery_of) {
            const original = await tx.getOperation(plan.recovery_of, true);
            if (original) {
              original.recovery_operation_ids = [...original.recovery_operation_ids, op.id];
              original.recovery_status = "running";
              original.updated_at = now;
              await tx.updateOperation(original);
              await tx.appendEvent(original.id, "recovery.linked", p.id, { recovery_operation_id: op.id });
            }
          }
          await tx.enqueue("dispatch", op.id);
          return { op, replayed: false };
        });
        if (!result.replayed) this.kickExecutor(result.op.id);
        return { operation: operationView(result.op), replayed: result.replayed };
      } catch (e) {
        if (e instanceof AcceptRace && attempt < 3) continue;
        if (isUniqueViolation(e) && attempt < 3) continue;
        throw e;
      }
    }
  }

  /**
   * Returns the operation this principal submitted under (action, request key), or null. Lets a
   * restarted agent resume the original operation: re-preparing produces a new plan, and
   * submitting that plan under the old key would conflict rather than replay.
   */
  async findOperationByRequestKey(p: Principal, actionId: string, requestKey: string): Promise<Operation | null> {
    const keyDigest = this.requestKeyDigest(p.id, actionId, requestKey);
    return this.tx(async (tx) => {
      const op = await tx.findOperationByRequestKey(keyDigest);
      if (op) return op.principal === p.id ? operationView(op) : null;
      const tomb = await tx.findTombstone(keyDigest);
      if (tomb) throw new VapError("REQUEST_KEY_EXPIRED", "request key retention expired; the original operation is no longer addressable by this key", { operationId: tomb.operation_id });
      return null;
    });
  }

  private kickExecutor(operationId: string): void {
    if (!this.executor) return;
    const timer = AbortSignal.timeout(3000);
    Promise.race([
      this.executor.submit(operationId),
      new Promise((resolve) => timer.addEventListener("abort", () => resolve(null))),
    ]).catch((e) => this.log.warn("executor submit failed; the sweeper will recover the outbox item", { operation_id: operationId, error: String(e) }));
  }

  // ---------------------------------------------------------------- reads

  private async loadOperation(tx: JournalTx, p: Principal, id: string): Promise<StoredOperation> {
    const op = await tx.getOperation(id);
    if (!op || !this.canRead(p, op.principal)) throw new VapError("NOT_FOUND", "operation not found");
    return op;
  }

  async getOperation(p: Principal, id: string): Promise<Operation> {
    return this.tx(async (tx) => operationView(await this.loadOperation(tx, p, id)));
  }

  async listOperations(p: Principal, filter: { task_id?: string; status?: string[]; limit?: number }): Promise<Operation[]> {
    return this.tx(async (tx) => {
      const ops = await tx.listOperations({
        principal: hasRole(p, "operator") || hasRole(p, "viewer") ? undefined : p.id,
        task_id: filter.task_id,
        execution_status: filter.status as StoredOperation["execution_status"][] | undefined,
        limit: Math.min(filter.limit ?? 50, 200),
      });
      return ops.map(operationView);
    });
  }

  async listEvents(p: Principal, id: string, after: number, limit: number): Promise<{ events: OperationEvent[]; next_after: number | null }> {
    return this.tx(async (tx) => {
      await this.loadOperation(tx, p, id);
      const n = Math.min(Math.max(limit, 1), 200);
      const events = await tx.listEvents(id, Math.max(after, 0), n);
      return { events, next_after: events.length === n ? events[events.length - 1].sequence : null };
    });
  }

  async listEvidence(p: Principal, operationId: string): Promise<Evidence[]> {
    return this.tx(async (tx) => {
      const op = await this.loadOperation(tx, p, operationId);
      // Evidence access follows the originating task's grant.
      const grant = await tx.getGrant(op.grant_id);
      if (!grant || (grant.principal !== p.id && !hasRole(p, "operator") && !hasRole(p, "viewer"))) throw new VapError("NOT_FOUND", "operation not found");
      return tx.listEvidenceForOperation(operationId);
    });
  }

  async getArtifact(p: Principal, evidenceId: string): Promise<{ content: string; mediaType: string }> {
    const ev = await this.tx(async (tx) => {
      const e = await tx.getEvidence(evidenceId);
      if (!e) throw new VapError("NOT_FOUND", "evidence not found");
      await this.loadOperation(tx, p, e.operation_id);
      return e;
    });
    if (!ev.artifact_ref || !this.artifacts) throw new VapError("NOT_FOUND", "no artifact for this evidence");
    const a = await this.artifacts.get(ev.artifact_ref.object_id);
    if (!a) throw new VapError("NOT_FOUND", "artifact no longer retained");
    return a;
  }

  async receipt(p: Principal, id: string): Promise<Receipt> {
    return this.tx(async (tx) => {
      const op = await this.loadOperation(tx, p, id);
      const plan = (await tx.getPlan(op.plan_id))!;
      const evidence = await tx.listEvidenceForOperation(op.id);
      const descriptor = this.registry.hasAction(op.action_id) ? this.registry.action(op.action_id).descriptor : null;
      return buildReceipt(operationView(op), plan, evidence, descriptor, this.iso());
    });
  }

  // ---------------------------------------------------------------- dispatch (worker side)

  /** Processes one leased outbox item. Safe to call concurrently and repeatedly. */
  async processOutboxItem(item: OutboxItem, workerId: string): Promise<void> {
    // Keep the item leased while it runs so long verifications are not re-leased and run twice.
    const lease = setInterval(() => {
      this.tx((tx) => tx.extendOutboxLease(item.id, workerId, this.opts.claimLeaseMs)).catch(() => {});
    }, Math.max(1000, Math.floor(this.opts.claimLeaseMs / 3)));
    lease.unref?.();
    try {
      let claimed = true;
      if (item.kind === "dispatch") claimed = (await this.dispatch(item.operation_id, workerId)).result !== "claimed_elsewhere";
      else if (item.kind === "reconcile") claimed = await this.reconcileAsWorker(item.operation_id, workerId, true);
      else if (item.kind === "verify") await this.verifyInternal(item.operation_id, `worker:${workerId}`, null);
      // Another holder (a worker, or an API reconcile/cancel) has the claim: try again shortly
      // rather than dropping the work item.
      if (!claimed) await this.tx((tx) => tx.retryOutbox(item.id, 2000));
      else await this.tx((tx) => tx.completeOutbox(item.id));
    } catch (e) {
      this.log.error("outbox item failed", { outbox_id: item.id, kind: item.kind, operation_id: item.operation_id, error: e instanceof Error ? e.message : String(e) });
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(item.attempts, 6));
      await this.tx((tx) => tx.retryOutbox(item.id, delay));
    } finally {
      clearInterval(lease);
    }
  }

  /** Leases and processes due outbox items until none remain or the budget is used. */
  async drainOutbox(workerId: string, budget = 25): Promise<number> {
    let processed = 0;
    while (processed < budget) {
      const items = await this.tx((tx) => tx.leaseOutbox(workerId, Math.min(5, budget - processed), this.opts.claimLeaseMs));
      if (items.length === 0) break;
      await Promise.all(items.map((i) => this.processOutboxItem(i, workerId)));
      processed += items.length;
    }
    return processed;
  }

  private notAppliedEffects(descriptor: ActionDescriptor | null, detail: string): Effect[] {
    return (descriptor?.side_effects ?? [])
      .filter((s) => s.class !== "none")
      .map((s) => ({ side_effect_id: s.id, item_index: null, resource_uri: null, status: "not_applied" as const, source_version: null, detail }));
  }

  /** Dispatch-time revalidation (spec 6): expiry, grant, revocation, adapter and policy revision. */
  private dispatchDenial(plan: StoredPlan, task: Task | null, grant: Grant | null): VapError | null {
    const ev = this.evaluate(plan, task, grant, []);
    if (ev.status === "stale") return new VapError("STALE_PLAN", "plan became stale before dispatch", { details: { reasons: ev.reasons } });
    if (ev.status === "expired") return new VapError("PLAN_EXPIRED", "plan expired before dispatch");
    const auth = evaluateGrant({ grant: grant!, principalId: plan.principal, actionId: plan.action_id, tier: plan.risk_tier, resources: plan.affected_resources, taskScope: task!.scope, now: this.clock() });
    if (!auth.permitted) return new VapError("FORBIDDEN", "authorization no longer permits dispatch", { details: { blockers: auth.blockers } });
    return null;
  }

  async dispatch(operationId: string, workerId: string): Promise<DispatchSummary> {
    const fence = await this.tx((tx) => tx.acquireClaim(operationId, workerId, this.opts.claimLeaseMs));
    if (fence === null) return { operation_id: operationId, result: "claimed_elsewhere" };
    const heartbeat = setInterval(() => {
      this.tx((tx) => tx.heartbeatClaim(operationId, fence, this.opts.claimLeaseMs)).catch(() => {});
    }, Math.max(1000, Math.floor(this.opts.claimLeaseMs / 3)));
    heartbeat.unref?.();
    try {
      const step: DispatchStep = await this.tx(async (tx) => {
        if (!(await tx.holdsClaim(operationId, fence))) return { kind: "lost" };
        const op = await tx.getOperation(operationId, true);
        if (!op) return { kind: "lost" };
        if (["completed", "failed", "partial", "cancelled"].includes(op.execution_status)) return { kind: "final", op };
        if (op.execution_status === "running" || op.execution_status === "unknown") return { kind: "reconcile" };
        const plan = (await tx.getPlan(op.plan_id))!;
        const descriptor = this.registry.hasAction(plan.action_id) ? this.registry.action(plan.action_id).descriptor : null;
        const now = this.iso();
        if (op.cancel_requested) {
          op.execution_status = "cancelled";
          op.effects = this.notAppliedEffects(descriptor, "cancelled before submission");
          op.completed_at = now;
          op.updated_at = now;
          await tx.updateOperation(op);
          await tx.appendEvent(op.id, "cancel.result", `worker:${workerId}`, { effects: "none", note: "cancelled before submission" });
          await this.propagateRecovery(tx, op, `worker:${workerId}`);
          return { kind: "final", op };
        }
        const denial = this.dispatchDenial(plan, await tx.getTask(plan.task_id), await tx.getGrant(plan.grant_id));
        if (denial) {
          op.execution_status = "failed";
          op.effects = this.notAppliedEffects(descriptor, "dispatch denied before submission");
          op.error = denial.toBody();
          op.completed_at = now;
          op.updated_at = now;
          await tx.updateOperation(op);
          await tx.appendEvent(op.id, "dispatch.denied", `worker:${workerId}`, { code: denial.code, message: denial.message });
          await this.propagateRecovery(tx, op, `worker:${workerId}`);
          return { kind: "final", op };
        }
        const attempt = op.attempts + 1;
        await tx.insertAttempt({ operation_id: op.id, sequence: attempt, worker_id: workerId, fence, dispatch_intent_at: now, submission: null, finished_at: null, external_handle: null, outcome: null });
        op.execution_status = "running";
        op.attempts = attempt;
        op.submitted_at = op.submitted_at ?? now;
        op.updated_at = now;
        await tx.updateOperation(op);
        // Durable submission intent precedes any network call. A crash after this point
        // leaves the operation running with an expired claim, which reconciles to unknown.
        await tx.appendEvent(op.id, "dispatch.intent", `worker:${workerId}`, { attempt, fence });
        return { kind: "execute", op, plan, attempt };
      });

      if (step.kind === "lost") return { operation_id: operationId, result: "claim_lost" };
      if (step.kind === "final") {
        return {
          operation_id: operationId,
          result: step.op.execution_status === "cancelled" ? "cancelled" : step.op.error ? "denied" : "already_final",
          execution_status: step.op.execution_status,
        };
      }
      if (step.kind === "reconcile") {
        const r = await this.reconcileWithFence(operationId, fence, `worker:${workerId}`, true);
        return { operation_id: operationId, result: "reconciled", execution_status: r.operation.execution_status };
      }
      const status = await this.executeAttempt(step.op, step.plan, step.attempt, fence, workerId);
      return { operation_id: operationId, result: status === null ? "claim_lost" : "executed", execution_status: status ?? undefined };
    } finally {
      clearInterval(heartbeat);
      await this.tx((tx) => tx.releaseClaim(operationId, fence)).catch(() => {});
    }
  }

  private executionTimeout(descriptor: ActionDescriptor): number {
    const raw = descriptor.extensions?.["vap.execution_timeout_ms"];
    const t = typeof raw === "number" && Number.isFinite(raw) ? raw : this.opts.defaultExecutionTimeoutMs;
    return Math.min(Math.max(t, 1000), this.opts.maxExecutionTimeoutMs);
  }

  /** Runs one adapter submission outside any transaction and records the result under the fence. */
  private async executeAttempt(op: StoredOperation, plan: StoredPlan, attempt: number, fence: number, workerId: string): Promise<string | null> {
    const { adapter, descriptor } = this.registry.action(plan.action_id);
    const timeout = this.executionTimeout(descriptor);
    const ac = new AbortController();
    const deadlineTimer = setTimeout(() => ac.abort(new Error("execution deadline reached")), timeout);
    deadlineTimer.unref?.();
    const cancelPoll = setInterval(() => {
      this.tx((tx) => tx.getOperation(op.id))
        .then((cur) => {
          if (cur?.cancel_requested) ac.abort(new Error("cancellation requested"));
        })
        .catch(() => {});
    }, this.opts.cancelPollMs);
    cancelPoll.unref?.();

    let recheckCalled = false;
    const grantTargets = (await this.tx((tx) => tx.getGrant(plan.grant_id)))?.allowed_targets ?? [];
    const ctx: ExecuteContext = {
      ...this.ctx(op.principal, op.task_id, op.id, timeout, grantTargets, ac.signal),
      operationId: op.id,
      destinationKey: destinationKeyFor(op.id, attempt),
      attempt,
      recheck: async () => {
        recheckCalled = true;
        const denial = await this.tx(async (tx) => {
          if (!(await tx.holdsClaim(op.id, fence))) return new VapError("CONFLICT", "worker claim lost before submission");
          const cur = await tx.getOperation(op.id);
          if (cur?.cancel_requested) return new VapError("CONFLICT", "cancellation requested before submission");
          return this.dispatchDenial(plan, await tx.getTask(plan.task_id), await tx.getGrant(plan.grant_id));
        });
        if (denial) throw new RecheckDenied(denial);
        if (ac.signal.aborted) throw new RecheckDenied(new VapError("CONFLICT", "aborted before submission"));
      },
    };

    let result: AdapterResult;
    try {
      result = await adapter.execute({ ...planView(plan, this.evaluate(plan, null, null, [])), status: "prepared" }, ctx);
      if (!recheckCalled && result.submission !== "not_submitted") {
        this.log.warn("adapter reported a submission without calling recheck()", { adapter: adapter.id, operation_id: op.id });
      }
    } catch (e) {
      if (e instanceof RecheckDenied) {
        result = {
          outcome: "failed",
          submission: "not_submitted",
          effects: this.notAppliedEffects(descriptor, "denied by the pre-submission recheck"),
          result_summary: null,
          external_handle: null,
          error: e.error.toBody(),
        };
      } else if (!recheckCalled) {
        const err = e instanceof VapError ? e : new VapError("INTERNAL", `adapter failed before submission: ${redactString(String((e as Error)?.message ?? e), 256)}`);
        result = { outcome: "failed", submission: "not_submitted", effects: this.notAppliedEffects(descriptor, "adapter failed before submission"), result_summary: null, external_handle: null, error: err.toBody() };
      } else {
        result = {
          outcome: "unknown",
          submission: "maybe_submitted",
          effects: (descriptor.side_effects ?? []).filter((s) => s.class !== "none").map((s) => ({ side_effect_id: s.id, item_index: null, resource_uri: null, status: "unknown" as const, source_version: null, detail: "adapter error after submission may have started" })),
          result_summary: null,
          external_handle: null,
          error: new VapError("OUTCOME_UNKNOWN", `adapter error after submission may have started: ${redactString(String((e as Error)?.message ?? e), 256)}`).toBody(),
        };
      }
    } finally {
      clearTimeout(deadlineTimer);
      clearInterval(cancelPoll);
    }
    return this.recordResult(op.id, plan, attempt, fence, `worker:${workerId}`, result);
  }

  private async recordResult(operationId: string, plan: StoredPlan, attempt: number, fence: number, actor: string, result: AdapterResult): Promise<string | null> {
    return this.tx(async (tx) => {
      if (!(await tx.holdsClaim(operationId, fence))) {
        // A stale worker never changes journal state. The replacement worker reconciles.
        this.log.warn("claim lost before recording result; leaving the operation for reconciliation", { operation_id: operationId, fence });
        return null;
      }
      const op = (await tx.getOperation(operationId, true))!;
      const now = this.iso();
      let status: StoredOperation["execution_status"] = result.outcome;
      if (op.cancel_requested && result.outcome === "failed" && result.submission === "not_submitted") status = "cancelled";
      op.execution_status = status;
      op.effects = sanitizeEffects(result.effects);
      op.result_summary = result.result_summary ? (redact(result.result_summary) as Record<string, unknown>) : null;
      op.external_handle = result.external_handle ?? op.external_handle;
      op.error = result.error ?? null;
      op.updated_at = now;
      if (status !== "unknown") op.completed_at = now;
      if (status === "completed" || status === "partial") {
        op.verification_status = plan.required_checks.length > 0 ? "pending" : "not_requested";
        if (plan.required_checks.some((c) => c.method !== "human_judgment")) await tx.enqueue("verify", op.id);
      }
      await tx.updateOperation(op);
      await tx.finishAttempt(op.id, attempt, { submission: result.submission, external_handle: result.external_handle, outcome: result.outcome });
      await tx.appendEvent(op.id, "dispatch.result", actor, {
        attempt,
        outcome: result.outcome,
        submission: result.submission,
        effects: op.effects.length,
        error_code: result.error?.code ?? null,
        diagnostics: redact(result.diagnostics ?? {}, { maxDepth: 4, maxStringLength: 512 }),
      });
      if (status === "unknown") await tx.enqueue("reconcile", op.id, 1000);
      await this.propagateRecovery(tx, op, actor);
      return status;
    });
  }

  /** Updates the original operation's recovery_status from a recovery operation's state. */
  private async propagateRecovery(tx: JournalTx, recoveryOp: StoredOperation, actor: string): Promise<void> {
    if (!recoveryOp.recovers_operation_id) return;
    const parent = await tx.getOperation(recoveryOp.recovers_operation_id, true);
    if (!parent) return;
    let next: StoredOperation["recovery_status"];
    switch (recoveryOp.execution_status) {
      case "queued":
      case "running":
        next = "running";
        break;
      case "unknown":
        next = "unknown";
        break;
      case "failed":
      case "cancelled":
      case "partial":
        next = "failed";
        break;
      case "completed":
        next = recoveryOp.verification_status === "passed" ? "succeeded" : recoveryOp.verification_status === "failed" ? "failed" : recoveryOp.verification_status === "inconclusive" ? "unknown" : "running";
        break;
    }
    if (parent.recovery_status === next) return;
    parent.recovery_status = next;
    parent.updated_at = this.iso();
    await tx.updateOperation(parent);
    await tx.appendEvent(parent.id, "recovery.result", actor, {
      recovery_operation_id: recoveryOp.id,
      recovery_status: next,
      recovery_execution_status: recoveryOp.execution_status,
      recovery_verification_status: recoveryOp.verification_status,
    });
  }

  // ---------------------------------------------------------------- reconciliation

  async reconcile(p: Principal, id: string): Promise<{ operation: Operation; resolved: boolean; resolution: ReconcileResolution; observations: Record<string, unknown>[] }> {
    await this.tx(async (tx) => {
      const op = await this.loadOperation(tx, p, id);
      if (!this.canAct(p, op.principal)) throw new VapError("FORBIDDEN", "reconciliation requires the executing principal or an operator");
    });
    const workerId = `api-${newId("wk").slice(3)}`;
    const fence = await this.tx((tx) => tx.acquireClaim(id, workerId, this.opts.claimLeaseMs));
    if (fence === null) {
      const op = await this.getOperation(p, id);
      return { operation: op, resolved: false, resolution: "in_progress", observations: [] };
    }
    try {
      return await this.withClaimHeartbeat(id, fence, () => this.reconcileWithFence(id, fence, p.id, false));
    } finally {
      await this.tx((tx) => tx.releaseClaim(id, fence)).catch(() => {});
    }
  }

  private async reconcileAsWorker(id: string, workerId: string, automatic: boolean): Promise<boolean> {
    const fence = await this.tx((tx) => tx.acquireClaim(id, workerId, this.opts.claimLeaseMs));
    if (fence === null) return false;
    try {
      await this.withClaimHeartbeat(id, fence, () => this.reconcileWithFence(id, fence, `worker:${workerId}`, automatic));
      return true;
    } finally {
      await this.tx((tx) => tx.releaseClaim(id, fence)).catch(() => {});
    }
  }

  /**
   * Resolves running/unknown operations using the destination's lookup. Never blindly
   * resubmits: a new attempt happens only after definitive non-submission under a
   * destination deduplication contract, in automatic (worker) mode.
   */
  private async reconcileWithFence(id: string, fence: number, actor: string, automatic: boolean) {
    const pre = await this.tx(async (tx) => {
      if (!(await tx.holdsClaim(id, fence))) return null;
      const op = (await tx.getOperation(id, true))!;
      if (op.execution_status === "queued") return { op, done: "in_progress" as const };
      if (!["running", "unknown"].includes(op.execution_status)) return { op, done: "already_final" as const };
      await tx.appendEvent(op.id, "reconcile.started", actor, { automatic, prior_status: op.execution_status });
      return { op, plan: (await tx.getPlan(op.plan_id))!, done: null };
    });
    if (!pre) return { operation: await this.getOperationInternal(id), resolved: false, resolution: "in_progress" as ReconcileResolution, observations: [] };
    if (pre.done) return { operation: operationView(pre.op), resolved: pre.done === "already_final", resolution: pre.done as ReconcileResolution, observations: [] };

    const { op, plan } = pre as { op: StoredOperation; plan: StoredPlan };
    const { adapter, descriptor } = this.registry.action(plan.action_id);
    let lookup: LookupResult;
    let lookupNote: string | null = null;
    try {
      lookup = await adapter.lookup(operationView(op), planView(plan, this.evaluate(plan, null, null, [])), {
        ...this.ctx(op.principal, op.task_id, op.id, 15_000, []),
        destinationKey: destinationKeyFor(op.id, Math.max(op.attempts, 1)),
      });
    } catch (e) {
      lookupNote = e instanceof VapError ? `${e.code}: ${e.message}` : "lookup failed";
      lookup = { status: "unknown", definitive: false, effects: [], result_summary: null, external_handle: null, observations: [] };
    }

    let resubmit = false;
    const outcome = await this.tx(async (tx) => {
      if (!(await tx.holdsClaim(id, fence))) return null;
      const cur = (await tx.getOperation(id, true))!;
      if (!["running", "unknown"].includes(cur.execution_status)) return { cur, resolution: "already_final" as ReconcileResolution };
      const now = this.iso();
      let resolution: ReconcileResolution;
      if (lookup.status === "applied" || lookup.status === "partial") {
        cur.execution_status = lookup.status === "applied" ? "completed" : "partial";
        cur.effects = sanitizeEffects(lookup.effects);
        cur.result_summary = lookup.result_summary ? (redact(lookup.result_summary) as Record<string, unknown>) : cur.result_summary;
        cur.external_handle = lookup.external_handle ?? cur.external_handle;
        cur.error = null;
        cur.completed_at = now;
        cur.verification_status = plan.required_checks.length > 0 ? "pending" : "not_requested";
        if (plan.required_checks.some((c) => c.method !== "human_judgment")) await tx.enqueue("verify", cur.id);
        resolution = lookup.status === "applied" ? "found_applied" : "found_partial";
      } else if (lookup.status === "not_applied" && lookup.definitive) {
        const dedup = descriptor.capabilities.retry_mode === "destination_dedup";
        const valid = this.dispatchDenial(plan, await tx.getTask(plan.task_id), await tx.getGrant(plan.grant_id)) === null;
        // A destination that received and rejected the request is not retried automatically.
        if (automatic && dedup && valid && !lookup.destination_rejected && !cur.cancel_requested && cur.attempts < this.opts.maxDispatchAttempts) {
          resubmit = true;
          cur.execution_status = "running";
          resolution = "resubmitted_with_dedup";
        } else {
          cur.execution_status = cur.cancel_requested ? "cancelled" : "failed";
          cur.effects = this.notAppliedEffects(descriptor, "destination confirmed the request was never applied");
          cur.completed_at = now;
          resolution = "definitive_not_applied";
        }
      } else {
        cur.execution_status = "unknown";
        cur.reconcile_attempts += 1;
        // A lookup the action cannot perform will never succeed: escalate at once. Otherwise
        // (destination unavailable, or the effect not visible yet) stay unknown until attempts run out.
        const noLookup = lookupNote?.startsWith("CAPABILITY_UNAVAILABLE") === true;
        if (!noLookup && cur.reconcile_attempts < this.opts.maxReconcileAttempts) {
          // A manual call must not leave the operation unknown with nothing scheduled.
          if (automatic || !(await tx.hasPendingOutbox(cur.id, "reconcile"))) await tx.enqueue("reconcile", cur.id, Math.min(60_000, 1000 * 2 ** cur.reconcile_attempts));
          resolution = "still_unknown";
        } else {
          resolution = "operator_resolution_required";
          await tx.appendEvent(cur.id, "operator.resolution_required", actor, {
            reason: lookupNote ?? "destination lookup could not establish whether the request was applied",
          });
        }
      }
      cur.updated_at = now;
      await tx.updateOperation(cur);
      await tx.appendEvent(cur.id, "reconcile.result", actor, {
        resolution,
        lookup_status: lookup.status,
        definitive: lookup.definitive,
        note: lookupNote,
        observations: redact(lookup.observations, { maxDepth: 4, maxArrayItems: 20 }),
      });
      await this.propagateRecovery(tx, cur, actor);
      return { cur, resolution };
    });
    if (!outcome) return { operation: await this.getOperationInternal(id), resolved: false, resolution: "in_progress" as ReconcileResolution, observations: lookup.observations };

    if (resubmit) {
      const attempt = await this.tx(async (tx) => {
        if (!(await tx.holdsClaim(id, fence))) return null;
        const cur = (await tx.getOperation(id, true))!;
        const n = cur.attempts + 1;
        const now = this.iso();
        await tx.insertAttempt({ operation_id: id, sequence: n, worker_id: actor, fence, dispatch_intent_at: now, submission: null, finished_at: null, external_handle: null, outcome: null });
        cur.attempts = n;
        cur.updated_at = now;
        await tx.updateOperation(cur);
        await tx.appendEvent(id, "dispatch.intent", actor, { attempt: n, fence, reason: "definitive non-submission under destination deduplication" });
        return { cur, n };
      });
      if (attempt) await this.executeAttempt(attempt.cur, plan, attempt.n, fence, actor.replace(/^worker:/, ""));
    }
    const final = await this.getOperationInternal(id);
    const resolved = !["running", "unknown", "queued"].includes(final.execution_status);
    return { operation: final, resolved, resolution: outcome.resolution, observations: lookup.observations };
  }

  private async getOperationInternal(id: string): Promise<Operation> {
    const op = await this.tx((tx) => tx.getOperation(id));
    if (!op) throw new VapError("NOT_FOUND", "operation not found");
    return operationView(op);
  }

  /** Operator records an out-of-band determination for an unknown operation. */
  async resolveOperation(operator: Principal, id: string, req: OperatorResolutionRequest): Promise<Operation> {
    this.requireRole(operator, "operator");
    return this.tx(async (tx) => {
      const op = await tx.getOperation(id, true);
      if (!op) throw new VapError("NOT_FOUND", "operation not found");
      if (op.execution_status !== "unknown") throw new VapError("CONFLICT", `only unknown operations can be resolved by an operator (status ${op.execution_status})`);
      const plan = (await tx.getPlan(op.plan_id))!;
      op.execution_status = req.execution_status;
      op.effects = sanitizeEffects(req.effects ?? []);
      op.completed_at = this.iso();
      op.updated_at = op.completed_at;
      if (req.execution_status !== "failed") {
        op.verification_status = plan.required_checks.length > 0 ? "pending" : "not_requested";
        if (plan.required_checks.some((c) => c.method !== "human_judgment")) await tx.enqueue("verify", op.id);
      }
      await tx.updateOperation(op);
      await tx.appendEvent(op.id, "reconcile.result", operator.id, { resolution: "operator_resolved", execution_status: req.execution_status, note: redactString(req.note, 1024) });
      await this.propagateRecovery(tx, op, operator.id);
      return operationView(op);
    });
  }

  // ---------------------------------------------------------------- verification

  /**
   * API-triggered verification. Runs synchronously only when every selected check's deadline
   * fits the synchronous budget; otherwise it queues a worker verification and returns the
   * current state (verification_status stays pending). At most two synchronous verifications
   * run per principal, so one caller cannot exhaust the API's request slots.
   */
  async verify(p: Principal, id: string, checkIds: string[] | null): Promise<{ operation: Operation; evidence: Evidence[] }> {
    const plan = await this.tx(async (tx) => {
      const op = await this.loadOperation(tx, p, id);
      if (!this.canAct(p, op.principal)) throw new VapError("FORBIDDEN", "verification requires the executing principal or an operator");
      return (await tx.getPlan(op.plan_id))!;
    });
    const selected = checkIds ? plan.required_checks.filter((c) => checkIds.includes(c.id)) : plan.required_checks;
    if (selected.some((c) => c.method !== "human_judgment" && c.deadline_seconds > SYNC_VERIFY_MAX_SECONDS)) {
      await this.tx((tx) => tx.enqueue("verify", id));
      this.kickExecutor(id);
      return { operation: await this.getOperationInternal(id), evidence: [] };
    }
    const running = this.syncVerifications.get(p.id) ?? 0;
    if (running >= 2) throw new VapError("LIMIT_EXCEEDED", "too many concurrent verifications for this principal", { status: 429, retry: "retry_with_same_key" });
    this.syncVerifications.set(p.id, running + 1);
    try {
      return await this.verifyInternal(id, p.id, checkIds);
    } finally {
      const n = (this.syncVerifications.get(p.id) ?? 1) - 1;
      if (n <= 0) this.syncVerifications.delete(p.id);
      else this.syncVerifications.set(p.id, n);
    }
  }

  async verifyInternal(id: string, actor: string, checkIds: string[] | null): Promise<{ operation: Operation; evidence: Evidence[] }> {
    const pre = await this.tx(async (tx) => {
      const op = await tx.getOperation(id, true);
      if (!op) throw new VapError("NOT_FOUND", "operation not found");
      if (op.execution_status !== "completed" && op.execution_status !== "partial") {
        throw new VapError("CONFLICT", `operation execution is ${op.execution_status}; verification needs a completed or partial execution`, {
          operationId: op.id,
          retry: op.execution_status === "unknown" || op.execution_status === "running" ? "reconcile_first" : "do_not_retry",
        });
      }
      const plan = (await tx.getPlan(op.plan_id))!;
      const task = (await tx.getTask(op.task_id))!;
      const grant = await tx.getGrant(op.grant_id);
      let checks = plan.required_checks;
      if (checkIds) {
        const unknown = checkIds.filter((c) => !plan.required_checks.some((x) => x.id === c));
        if (unknown.length > 0) throw new VapError("INVALID_ARGUMENT", `plan has no checks ${unknown.join(", ")}`);
        checks = checks.filter((c) => checkIds.includes(c.id));
      }
      if (plan.required_checks.length > 0 && op.verification_status !== "pending") {
        op.verification_status = "pending";
        op.updated_at = this.iso();
        await tx.updateOperation(op);
      }
      await tx.appendEvent(op.id, "verification.started", actor, { checks: checks.map((c) => c.id) });
      return { op, plan, task, grant, checks };
    });

    const produced: Evidence[] = [];
    for (const check of pre.checks) {
      if (check.method === "human_judgment") continue;
      produced.push(...(await this.runCheck(pre.op, pre.plan, pre.task, pre.grant?.allowed_targets ?? [], check)));
    }

    return this.tx(async (tx) => {
      for (const e of produced) await tx.insertEvidence(e);
      const op = (await tx.getOperation(id, true))!;
      const all = await tx.listEvidenceForOperation(id);
      op.verification_status = aggregateVerification(pre.plan.required_checks, all);
      op.updated_at = this.iso();
      await tx.updateOperation(op);
      await tx.appendEvent(op.id, "verification.result", actor, {
        verification_status: op.verification_status,
        results: produced.filter((e) => e.item_index === null).map((e) => ({ check_id: e.check_id, result: e.result, evidence_id: e.id })),
      });
      await this.propagateRecovery(tx, op, actor);
      return { operation: operationView(op), evidence: produced };
    });
  }

  private async runCheck(op: StoredOperation, plan: StoredPlan, task: Task, allowedTargets: string[], check: Check): Promise<Evidence[]> {
    if ((check.scope ?? "single") === "each_effect") {
      const applied = op.effects.filter((e) => e.status === "applied" && e.resource_uri);
      const items: Evidence[] = [];
      for (const ef of applied) {
        items.push(await this.evaluateTarget(op, plan, task, allowedTargets, check, ef.resource_uri!, ef.source_version ?? null, ef.item_index ?? null));
      }
      const expected = plan.item_count ?? applied.length;
      const failures = items.filter((e) => e.result === "fail").length;
      const inconclusive = items.filter((e) => e.result === "inconclusive").length;
      const unknownEffects = op.effects.filter((e) => e.status === "unknown").length;
      let result: Evidence["result"] = "pass";
      const limitations: string[] = [VERIFIER_LIMITATION];
      if (failures > 0) result = "fail";
      else if (applied.length !== expected) {
        result = "fail";
        limitations.push(`aggregate invariant failed: ${applied.length} of ${expected} intended items were applied`);
      } else if (inconclusive > 0 || unknownEffects > 0 || applied.length === 0) {
        result = "inconclusive";
        if (unknownEffects > 0) limitations.push(`${unknownEffects} effects are unknown`);
      }
      const now = this.iso();
      const aggregate: Evidence = {
        protocol_version: PROTOCOL_VERSION,
        id: newId("evd"),
        operation_id: op.id,
        task_id: task.id,
        task_revision: plan.task_revision,
        check_id: check.id,
        item_index: null,
        verifier_id: check.verifier_id,
        verifier_version: this.registry.adapterForVerifier(check.verifier_id).version,
        method: check.method,
        observed_at: items.length > 0 ? items.map((e) => e.observed_at).sort()[0] : now,
        result,
        source: "aggregate",
        source_version: null,
        freshness: items.every((e) => e.freshness === "fresh") && items.length > 0 ? "fresh" : "unknown",
        observed_facts: { items_expected: expected, items_applied: applied.length, items_passed: items.filter((e) => e.result === "pass").length, item_evidence: items.map((e) => e.id) },
        artifact_ref: null,
        limitations,
        attributed_to: null,
        independence: "same_process",
        created_at: now,
      };
      return [...items, aggregate];
    }
    let target: string;
    try {
      target = expandTemplate(check.target, { result: op.result_summary, args: plan.canonical_arguments, prior: (plan.frozen?.prior as Record<string, unknown>) ?? null });
    } catch (e) {
      return [this.inconclusiveEvidence(op, plan, task, check, `check target could not be resolved: ${(e as Error).message}`)];
    }
    const expectedVersion = op.effects.find((e) => e.resource_uri === target && e.status === "applied")?.source_version ?? null;
    return [await this.evaluateTarget(op, plan, task, allowedTargets, check, target, expectedVersion, null)];
  }

  private inconclusiveEvidence(op: StoredOperation, plan: StoredPlan, task: Task, check: Check, limitation: string): Evidence {
    const now = this.iso();
    return {
      protocol_version: PROTOCOL_VERSION,
      id: newId("evd"),
      operation_id: op.id,
      task_id: task.id,
      task_revision: plan.task_revision,
      check_id: check.id,
      item_index: null,
      verifier_id: check.verifier_id,
      verifier_version: "n/a",
      method: check.method,
      observed_at: now,
      result: "inconclusive",
      source: "none",
      source_version: null,
      freshness: "unknown",
      observed_facts: {},
      artifact_ref: null,
      limitations: [limitation],
      attributed_to: null,
      independence: "same_process",
      created_at: now,
    };
  }

  /**
   * Polls one authoritative read until the predicate passes on a fresh read, fails on a
   * read known to reflect the operation's version, or the check deadline passes. A stale
   * read at the deadline is inconclusive, never a failure that would justify a retry.
   */
  private async evaluateTarget(op: StoredOperation, plan: StoredPlan, task: Task, allowedTargets: string[], check: Check, target: string, expectedVersion: string | null, itemIndex: number | null): Promise<Evidence> {
    const owned = await this.tx((tx) => this.assertWorkspaceOwnership(tx, op.principal, [target])).then(
      () => true,
      () => false,
    );
    if (!owned || !anyResourceMatch(allowedTargets, target) || !anyResourceMatch(task.scope.resources, target)) {
      const e = this.inconclusiveEvidence(op, plan, task, check, "check target is outside the task's authorized scope; not read");
      e.item_index = itemIndex;
      return e;
    }
    const adapter = this.registry.adapterForVerifier(check.verifier_id);
    const stateSource = this.registry.hasAction(plan.action_id) ? this.registry.action(plan.action_id).descriptor.capabilities.state_source : "unavailable";
    const deadline = this.clock() + check.deadline_seconds * 1000;
    let delay = 200;
    let last: Awaited<ReturnType<Adapter["verify"]>> | null = null;
    let lastErr: string | null = null;
    let result: Evidence["result"] = "inconclusive";
    const limitations: string[] = [VERIFIER_LIMITATION];
    let readAt = this.iso();
    for (;;) {
      try {
        readAt = this.iso();
        last = await adapter.verify(check, {
          ...this.ctx(op.principal, op.task_id, op.id, Math.max(1000, deadline - this.clock()), allowedTargets),
          operation: operationView(op),
          plan: planView(plan, this.evaluate(plan, null, null, [])),
          target,
          expectedVersion,
        });
        lastErr = null;
      } catch (e) {
        lastErr = e instanceof VapError ? `${e.code}: ${e.message}` : "verifier read failed";
        last = null;
      }
      if (last) {
        const ev = evaluatePredicate(check.predicate, last.facts);
        if (ev.ok && last.freshness !== "stale") {
          result = "pass";
          if (last.freshness === "unknown") limitations.push("freshness relative to the operation could not be established");
          break;
        }
        if (!ev.ok && last.freshness === "fresh" && expectedVersion !== null) {
          result = "fail";
          limitations.push(...ev.mismatches);
          break;
        }
      }
      if (this.clock() + delay >= deadline) {
        if (!last) {
          result = "inconclusive";
          limitations.push(lastErr ?? "no observation obtained before the deadline");
        } else {
          const ev = evaluatePredicate(check.predicate, last.facts);
          if (last.freshness === "stale") {
            result = "inconclusive";
            limitations.push("reads did not reach the operation's reported version before the deadline");
          } else if (!ev.ok && stateSource === "authoritative_api") {
            result = "fail";
            limitations.push(...ev.mismatches);
          } else {
            result = ev.ok ? "pass" : "inconclusive";
            if (!ev.ok) limitations.push(...ev.mismatches, "state source is not authoritative; a mismatch is not treated as proof of failure");
          }
        }
        break;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 2000);
    }
    if (last) limitations.push(...last.limitations);
    const facts = last ? projectFacts(last.facts, predicatePaths(check.predicate)) : {};
    facts["_target"] = target;
    let artifactRef: Evidence["artifact_ref"] = null;
    if (last?.artifact && this.artifacts) {
      try {
        artifactRef = await this.artifacts.put(last.artifact.content, last.artifact.media_type, { operation_id: op.id, check_id: check.id });
      } catch {
        limitations.push("evidence artifact store unavailable; artifact not retained");
      }
    }
    return {
      protocol_version: PROTOCOL_VERSION,
      id: newId("evd"),
      operation_id: op.id,
      task_id: task.id,
      task_revision: plan.task_revision,
      check_id: check.id,
      item_index: itemIndex,
      verifier_id: check.verifier_id,
      verifier_version: adapter.version,
      method: last?.method ?? (check.method === "human_judgment" ? "read_back" : check.method),
      observed_at: readAt,
      result,
      source: last?.source ?? "none",
      source_version: last?.source_version ?? null,
      freshness: last?.freshness ?? "unknown",
      observed_facts: redact(facts, { maxDepth: 5, maxStringLength: 512 }) as Record<string, unknown>,
      artifact_ref: artifactRef,
      limitations: [...new Set(limitations)].slice(0, 16).map((l) => l.slice(0, 512)),
      attributed_to: null,
      independence: "same_process",
      created_at: this.iso(),
    };
  }

  /** Attributed human judgment. Recorded as such; never relabeled as deterministic verification. */
  async recordHumanEvidence(human: Principal, req: HumanEvidenceRequest): Promise<Evidence> {
    if (!hasRole(human, "approver") && !hasRole(human, "operator")) throw new VapError("FORBIDDEN", "approver or operator role required");
    return this.tx(async (tx) => {
      const op = await tx.getOperation(req.operation_id, true);
      if (!op) throw new VapError("NOT_FOUND", "operation not found");
      if (op.principal === human.id) throw new VapError("FORBIDDEN", "the executing principal cannot judge its own operation");
      const plan = (await tx.getPlan(op.plan_id))!;
      const check = plan.required_checks.find((c) => c.id === req.check_id);
      if (!check || check.method !== "human_judgment") throw new VapError("INVALID_ARGUMENT", "plan has no human_judgment check with that id");
      const now = this.iso();
      const ev: Evidence = {
        protocol_version: PROTOCOL_VERSION,
        id: newId("evd"),
        operation_id: op.id,
        task_id: op.task_id,
        task_revision: plan.task_revision,
        check_id: check.id,
        item_index: null,
        verifier_id: check.verifier_id,
        verifier_version: "human",
        method: "human_judgment",
        observed_at: now,
        result: req.result,
        source: "human",
        source_version: null,
        freshness: "unknown",
        observed_facts: { note: redactString(req.note, 1024) },
        artifact_ref: null,
        limitations: ["human judgment: attributed opinion, not deterministic verification"],
        attributed_to: human.id,
        independence: "human",
        created_at: now,
      };
      await tx.insertEvidence(ev);
      if (op.execution_status === "completed" || op.execution_status === "partial") {
        op.verification_status = aggregateVerification(plan.required_checks, await tx.listEvidenceForOperation(op.id));
        op.updated_at = now;
        await tx.updateOperation(op);
        await tx.appendEvent(op.id, "verification.result", human.id, { verification_status: op.verification_status, human_check: check.id, result: req.result });
        await this.propagateRecovery(tx, op, human.id);
      }
      return ev;
    });
  }

  // ---------------------------------------------------------------- cancellation

  async cancel(p: Principal, id: string, reason: string | null): Promise<{ operation: Operation; note: string }> {
    await this.tx(async (tx) => {
      const op = await this.loadOperation(tx, p, id);
      if (op.principal !== p.id && !hasRole(p, "operator")) throw new VapError("FORBIDDEN", "only the executing principal or an operator can cancel");
    });
    const workerId = `api-${newId("wk").slice(3)}`;
    const fence = await this.tx((tx) => tx.acquireClaim(id, workerId, 10_000));
    try {
      return await this.tx(async (tx) => {
        const op = (await tx.getOperation(id, true))!;
        const now = this.iso();
        if (["completed", "failed", "partial", "cancelled"].includes(op.execution_status)) {
          return { operation: operationView(op), note: `operation is already ${op.execution_status}; cancellation has no effect and is never rollback` };
        }
        await tx.appendEvent(op.id, "cancel.requested", p.id, { reason: reason ? redactString(reason, 512) : null });
        if (op.execution_status === "queued" && fence !== null && (await tx.holdsClaim(id, fence))) {
          const descriptor = this.registry.hasAction(op.action_id) ? this.registry.action(op.action_id).descriptor : null;
          op.execution_status = "cancelled";
          op.cancel_requested = true;
          op.effects = this.notAppliedEffects(descriptor, "cancelled before submission");
          op.completed_at = now;
          op.updated_at = now;
          await tx.updateOperation(op);
          await tx.appendEvent(op.id, "cancel.result", p.id, { effects: "none", note: "cancelled before submission" });
          await this.propagateRecovery(tx, op, p.id);
          return { operation: operationView(op), note: "cancelled before submission; no effects occurred" };
        }
        op.cancel_requested = true;
        op.updated_at = now;
        await tx.updateOperation(op);
        return {
          operation: operationView(op),
          note: "cancellation requested; the worker stops at the next safe point and the outcome is then reconciled. Effects that already happened are not undone; cancellation is not rollback.",
        };
      });
    } finally {
      if (fence !== null) await this.tx((tx) => tx.releaseClaim(id, fence)).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- recovery

  /**
   * Recovery through a declared strategy with fresh authorization. The compensating work is
   * a separate plan and operation with its own evidence; the original history is preserved.
   */
  async recover(p: Principal, id: string, req: RecoverRequest): Promise<{ original: Operation; plan: Plan; operation: Operation | null }> {
    const { op, plan } = await this.tx(async (tx) => {
      const op = await this.loadOperation(tx, p, id);
      if (op.principal !== p.id) throw new VapError("FORBIDDEN", "only the executing principal can request recovery");
      return { op, plan: (await tx.getPlan(op.plan_id))! };
    });
    if (op.execution_status === "unknown" || op.execution_status === "running" || op.execution_status === "queued") {
      throw new VapError("OUTCOME_UNKNOWN", "effects are not established; reconcile before recovery", { operationId: op.id });
    }
    if (!op.effects.some((e) => e.status === "applied")) throw new VapError("CONFLICT", "operation has no applied effects to recover", { operationId: op.id });
    const { adapter, descriptor } = this.registry.action(op.action_id);
    const mode = descriptor.recovery_modes.find((m) => m.mode === req.strategy);
    if (!mode) throw new VapError("CAPABILITY_UNAVAILABLE", `action ${op.action_id} declares no ${req.strategy} recovery`);
    const spec = await adapter.recover(operationView(op), planView(plan, this.evaluate(plan, null, null, [])), req.strategy, this.ctx(p.id, op.task_id, op.id, 15_000, []));
    if (spec.checks.length === 0) throw new VapError("CAPABILITY_UNAVAILABLE", "recovery strategy provides no post-recovery checks");
    // Idempotency and reconcile-first for recovery: a repeated request key returns the original
    // recovery, and no new compensation starts while an earlier one is unresolved.
    const keyDigest = this.requestKeyDigest(p.id, spec.action_id, req.request_key);
    const replay = await this.tx(async (tx) => {
      const existing = await tx.findOperationByRequestKey(keyDigest);
      if (existing) {
        if (existing.recovers_operation_id !== op.id) throw new VapError("KEY_REUSE_CONFLICT", "request key was already used for a different operation", { operationId: existing.id });
        const existingPlan = (await tx.getPlan(existing.plan_id))!;
        return { existing, view: this.planViewFor(existingPlan, await tx.getTask(existingPlan.task_id), await tx.getGrant(existingPlan.grant_id), await tx.listApprovalsForPlan(existingPlan.id)) };
      }
      for (const rid of op.recovery_operation_ids) {
        const r = await tx.getOperation(rid);
        if (r && ["queued", "running", "unknown"].includes(r.execution_status)) {
          throw new VapError("OUTCOME_UNKNOWN", `earlier recovery ${rid} is ${r.execution_status}; reconcile it before requesting another`, { operationId: rid });
        }
      }
      return null;
    });
    if (replay) return { original: await this.getOperationInternal(op.id), plan: replay.view, operation: operationView(replay.existing) };
    const recoveryPlan = await this.preparePlan(
      p,
      { protocol_version: PROTOCOL_VERSION, task_id: op.task_id, action_id: spec.action_id, arguments: spec.arguments, check_ids: [] },
      op.id,
      spec.checks.map((c) => ({ ...c, provenance: "action_default" as const })),
    );
    await this.tx(async (tx) => {
      const cur = (await tx.getOperation(op.id, true))!;
      // Never overwrite running/unknown/succeeded: those reflect a recovery operation's state.
      if (cur.recovery_status === "none" || cur.recovery_status === "failed") {
        cur.recovery_status = "requested";
        cur.updated_at = this.iso();
        await tx.updateOperation(cur);
      }
      await tx.appendEvent(op.id, "recovery.requested", p.id, {
        strategy: req.strategy,
        recovery_plan_id: recoveryPlan.id,
        covered_effects: spec.covered_effects.length,
        uncovered_effects: spec.uncovered_effects,
      });
    });
    let recoveryOp: Operation | null = null;
    if (recoveryPlan.status === "prepared") {
      recoveryOp = (await this.submitOperation(p, { protocol_version: PROTOCOL_VERSION, plan_id: recoveryPlan.id, request_key: req.request_key })).operation;
    }
    return { original: await this.getOperationInternal(op.id), plan: recoveryPlan, operation: recoveryOp };
  }

  // ---------------------------------------------------------------- sweeper

  /**
   * Recovers missed outbox items and expired claims, expires request keys visibly and
   * applies retention. Unresolved submissions are reconciled, never replayed.
   */
  async sweep(workerId: string): Promise<{ orphaned: number; stranded: number; keys_expired: number; purged: number }> {
    return this.tx(async (tx) => {
      const orphaned = await tx.listOrphanedOperations(100);
      for (const op of orphaned) {
        // Any pending item (a leased dispatch that will take the reconcile path, or a reconcile)
        // already covers it; a second chain would only spend the reconcile budget twice.
        if (!(await tx.hasPendingOutbox(op.id))) {
          await tx.enqueue("reconcile", op.id);
          await tx.appendEvent(op.id, "claim.expired", `worker:${workerId}`, { note: "worker claim expired after dispatch intent; reconciling instead of resubmitting" });
        }
      }
      const stranded = await tx.listStrandedQueuedOperations(100);
      for (const op of stranded) await tx.enqueue("dispatch", op.id);
      const keys = await tx.expireRequestKeys(this.iso(this.clock() - this.opts.requestKeyRetentionMs));
      const purged = await tx.purgeResolvedOperations(this.iso(this.clock() - this.opts.operationRetentionMs));
      return { orphaned: orphaned.length, stranded: stranded.length, keys_expired: keys, purged };
    });
  }
}

// ---------------------------------------------------------------- helpers

export function aggregateVerification(checks: Check[], evidence: Evidence[]): StoredOperation["verification_status"] {
  if (checks.length === 0) return "not_requested";
  const latest = latestAggregateEvidence(evidence);
  const results = checks.map((c) => latest.get(c.id)?.result ?? "missing");
  if (results.includes("fail")) return "failed";
  if (results.every((r) => r === "pass")) return "passed";
  if (results.includes("inconclusive")) return "inconclusive";
  // Some checks passed and the rest (e.g. human judgment) have not produced evidence yet.
  return "pending";
}

function sanitizeEffects(effects: Effect[]): Effect[] {
  return effects.slice(0, 1000).map((e) => ({
    side_effect_id: e.side_effect_id,
    item_index: e.item_index ?? null,
    resource_uri: e.resource_uri ?? null,
    status: e.status,
    source_version: e.source_version ?? null,
    detail: e.detail ? redactString(e.detail, 1024) : null,
  }));
}

function projectFacts(facts: Record<string, unknown>, paths: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of paths) {
    const r = jsonPointerGet(facts, p);
    out[p] = r.found ? r.value : null;
  }
  if ("version" in facts) out["/version"] = facts["version"];
  return out;
}

function boundFacts(facts: Record<string, unknown>, maxBytes: number): { facts: Record<string, unknown>; omitted: string[]; bytes: number } {
  const full = JSON.stringify(facts);
  if (Buffer.byteLength(full) <= maxBytes) return { facts, omitted: [], bytes: Buffer.byteLength(full) };
  const out: Record<string, unknown> = {};
  const omitted: string[] = [];
  let bytes = 2;
  for (const [k, v] of Object.entries(facts)) {
    const piece = Buffer.byteLength(JSON.stringify(k) + ":" + JSON.stringify(v) + ",");
    if (bytes + piece > maxBytes) {
      omitted.push(k);
      continue;
    }
    out[k] = v;
    bytes += piece;
  }
  return { facts: out, omitted, bytes };
}

/** Destination request key for an attempt: the operation id first, then a derived fresh key. */
export function destinationKeyFor(operationId: string, attempt: number): string {
  return attempt <= 1 ? operationId : `${operationId}.a${attempt}`;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
