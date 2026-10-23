import { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, VapError } from "@vap/protocol";
import type {
  ActionListEntry,
  Approval,
  ApprovalCreateRequest,
  Evidence,
  Grant,
  GrantCreateRequest,
  InfoResponse,
  Observation,
  ObservationRequest,
  Operation,
  OperationEvent,
  Plan,
  PlanCreateRequest,
  Receipt,
  ReconcileResolution,
  RecoveryMode,
  Task,
  TaskCreateRequest,
  TaskOutcome,
  TaskReviseRequest,
  VapErrorBody,
} from "@vap/protocol";
import type { TokenProvider } from "./tokens.js";

type Body<T> = Omit<T, "protocol_version">;

export interface VapClientOptions {
  baseUrl: string;
  token: TokenProvider;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

/**
 * Typed HTTP client for the VAP v1 API. Errors are thrown as VapError with the server's
 * retry_disposition. A transport failure on a mutation is reported as OUTCOME_UNKNOWN:
 * HTTP failure alone never proves a submitted effect did not occur.
 */
export class VapClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private infoChecked = false;

  constructor(private readonly opts: VapClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown, extra: { raw?: boolean } = {}): Promise<{ status: number; data: T; headers: Headers }> {
    const token = await this.opts.token();
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "user-agent": this.opts.userAgent ?? "vap-sdk/0.1.0",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
      });
    } catch (e) {
      if (method === "GET") throw new VapError("UNAVAILABLE", `VAP API unreachable: ${(e as Error).message}`, { retry: "safe_to_retry" });
      throw new VapError("OUTCOME_UNKNOWN", `transport failed after sending ${method} ${path}; repeat with the same request key or inspect before retrying`, { retry: "retry_with_same_key" });
    }
    const text = await res.text();
    if (extra.raw) return { status: res.status, data: text as T, headers: res.headers };
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new VapError("INTERNAL", `VAP API returned non-JSON (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const err = (parsed as { error?: VapErrorBody } | null)?.error;
      if (err && typeof err.code === "string") throw VapError.fromBody(err, res.status);
      throw new VapError(res.status >= 500 ? "UNAVAILABLE" : "INTERNAL", `VAP API returned HTTP ${res.status}`);
    }
    return { status: res.status, data: parsed as T, headers: res.headers };
  }

  private envelope<T extends object>(b: T): T & { protocol_version: "0.1" } {
    return { protocol_version: PROTOCOL_VERSION, ...b };
  }

  /** Fetches /v1/info and rejects unsupported protocol versions with a compatibility error. */
  async info(): Promise<InfoResponse> {
    const { data } = await this.call<InfoResponse>("GET", "/v1/info");
    const major = (v: string) => v.split(".")[0];
    const ours = SUPPORTED_PROTOCOL_VERSIONS.map(major);
    if (!data.supported_protocol_versions.some((v) => ours.includes(major(v)) && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(v))) {
      throw new VapError("UNSUPPORTED_PROTOCOL_VERSION", `server speaks ${data.supported_protocol_versions.join(", ")}; this client supports ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`);
    }
    this.infoChecked = true;
    return data;
  }

  private async ensureCompatible(): Promise<void> {
    if (!this.infoChecked) await this.info();
  }

  async openTask(req: Body<TaskCreateRequest>): Promise<Task> {
    await this.ensureCompatible();
    return (await this.call<Task>("POST", "/v1/tasks", this.envelope(req))).data;
  }
  async getTask(id: string): Promise<Task> {
    return (await this.call<Task>("GET", `/v1/tasks/${encodeURIComponent(id)}`)).data;
  }
  async reviseTask(id: string, req: Body<TaskReviseRequest>): Promise<Task> {
    return (await this.call<Task>("POST", `/v1/tasks/${encodeURIComponent(id)}/revisions`, this.envelope(req))).data;
  }
  async taskOutcome(id: string): Promise<TaskOutcome> {
    return (await this.call<TaskOutcome>("GET", `/v1/tasks/${encodeURIComponent(id)}/outcome`)).data;
  }
  async observe(req: Body<ObservationRequest>): Promise<Observation> {
    return (await this.call<Observation>("POST", "/v1/observations", this.envelope(req))).data;
  }
  async listActions(taskId?: string): Promise<ActionListEntry[]> {
    const q = taskId ? `?task_id=${encodeURIComponent(taskId)}` : "";
    return (await this.call<{ actions: ActionListEntry[] }>("GET", `/v1/actions${q}`)).data.actions;
  }
  async prepare(req: Body<PlanCreateRequest>): Promise<Plan> {
    await this.ensureCompatible();
    return (await this.call<Plan>("POST", "/v1/plans", this.envelope(req))).data;
  }
  async getPlan(id: string): Promise<Plan> {
    return (await this.call<Plan>("GET", `/v1/plans/${encodeURIComponent(id)}`)).data;
  }
  /** Submits a plan. Repeating the same request key returns the original operation (replayed=true). */
  async execute(planId: string, requestKey: string): Promise<{ operation: Operation; replayed: boolean }> {
    const r = await this.call<Operation>("POST", "/v1/operations", this.envelope({ plan_id: planId, request_key: requestKey }));
    return { operation: r.data, replayed: r.headers.get("idempotent-replay") === "true" };
  }
  /** The operation this principal submitted under (action, request key), or null. Use it to resume after a restart. */
  async findOperation(actionId: string, requestKey: string): Promise<Operation | null> {
    try {
      return (await this.call<Operation>("POST", "/v1/operations/lookup", this.envelope({ action_id: actionId, request_key: requestKey }))).data;
    } catch (e) {
      if (e instanceof VapError && e.code === "NOT_FOUND") return null;
      throw e;
    }
  }
  async getOperation(id: string): Promise<Operation> {
    return (await this.call<Operation>("GET", `/v1/operations/${encodeURIComponent(id)}`)).data;
  }
  async listOperations(filter: { task_id?: string; status?: string[]; limit?: number } = {}): Promise<Operation[]> {
    const q = new URLSearchParams();
    if (filter.task_id) q.set("task_id", filter.task_id);
    if (filter.status) q.set("status", filter.status.join(","));
    if (filter.limit) q.set("limit", String(filter.limit));
    return (await this.call<{ operations: Operation[] }>("GET", `/v1/operations?${q}`)).data.operations;
  }
  async receipt(id: string): Promise<Receipt> {
    return (await this.call<Receipt>("GET", `/v1/operations/${encodeURIComponent(id)}/receipt`)).data;
  }
  async evidence(id: string): Promise<Evidence[]> {
    return (await this.call<{ evidence: Evidence[] }>("GET", `/v1/operations/${encodeURIComponent(id)}/evidence`)).data.evidence;
  }
  async verify(id: string, checkIds?: string[]): Promise<{ operation: Operation; evidence: Evidence[] }> {
    return (await this.call<{ operation: Operation; evidence: Evidence[] }>("POST", `/v1/operations/${encodeURIComponent(id)}/verify`, this.envelope(checkIds ? { check_ids: checkIds } : {}))).data;
  }
  async reconcile(id: string): Promise<{ operation: Operation; resolved: boolean; resolution: ReconcileResolution; observations: Record<string, unknown>[] }> {
    return (await this.call<{ operation: Operation; resolved: boolean; resolution: ReconcileResolution; observations: Record<string, unknown>[] }>("POST", `/v1/operations/${encodeURIComponent(id)}/reconcile`, this.envelope({}))).data;
  }
  async recover(id: string, strategy: RecoveryMode, requestKey: string): Promise<{ original_operation: Operation; recovery_plan: Plan; recovery_operation: Operation | null }> {
    return (await this.call<{ original_operation: Operation; recovery_plan: Plan; recovery_operation: Operation | null }>("POST", `/v1/operations/${encodeURIComponent(id)}/recover`, this.envelope({ strategy, request_key: requestKey }))).data;
  }
  async cancel(id: string, reason?: string): Promise<{ operation: Operation; note: string }> {
    return (await this.call<{ operation: Operation; note: string }>("POST", `/v1/operations/${encodeURIComponent(id)}/cancel`, this.envelope(reason ? { reason } : {}))).data;
  }
  async events(id: string, after = 0, limit = 100): Promise<{ events: OperationEvent[]; next_after: number | null }> {
    return (await this.call<{ events: OperationEvent[]; next_after: number | null }>("GET", `/v1/operations/${encodeURIComponent(id)}/events?after=${after}&limit=${limit}`)).data;
  }
  async listGrants(): Promise<Grant[]> {
    return (await this.call<{ grants: Grant[] }>("GET", "/v1/grants")).data.grants;
  }
  async pendingApprovals(): Promise<Plan[]> {
    return (await this.call<{ plans: Plan[] }>("GET", "/v1/approvals/pending")).data.plans;
  }

  // Operator surface. Never expose these through agent tools.
  async createGrant(req: Body<GrantCreateRequest>): Promise<Grant> {
    return (await this.call<Grant>("POST", "/v1/operator/grants", this.envelope(req))).data;
  }
  async revokeGrant(id: string): Promise<Grant> {
    return (await this.call<Grant>("POST", `/v1/operator/grants/${encodeURIComponent(id)}/revoke`, this.envelope({}))).data;
  }
  async decideApproval(req: Body<ApprovalCreateRequest>): Promise<Approval> {
    return (await this.call<Approval>("POST", "/v1/operator/approvals", this.envelope(req))).data;
  }
  async setPrincipalRoles(subject: string, roles: string[]): Promise<void> {
    await this.call("POST", "/v1/operator/principals", { subject, roles });
  }
  async sweep(): Promise<Record<string, number>> {
    return (await this.call<{ sweep: Record<string, number> }>("POST", "/v1/operator/sweep", this.envelope({}))).data.sweep;
  }

  /** Polls until the operation leaves queued/running or the timeout passes. */
  async waitForOperation(id: string, opts: { timeoutMs?: number; until?: (o: Operation) => boolean } = {}): Promise<Operation> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    const until = opts.until ?? ((o: Operation) => !["queued", "running"].includes(o.execution_status) && o.verification_status !== "pending");
    let delay = 100;
    for (;;) {
      const op = await this.getOperation(id);
      if (until(op) || Date.now() > deadline) return op;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 1000);
    }
  }
}
