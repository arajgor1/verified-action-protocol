import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  API_VERSION,
  assertProtocolVersion,
  PROTOCOL_VERSION,
  schemaValidator,
  SUPPORTED_PROTOCOL_VERSIONS,
  VapError,
} from "@verified-action-protocol/protocol";
import type {
  ApprovalCreateRequest,
  GrantCreateRequest,
  HumanEvidenceRequest,
  InfoResponse,
  ObservationRequest,
  OperationCreateRequest,
  OperatorResolutionRequest,
  PlanCreateRequest,
  RecoverRequest,
  SchemaName,
  TaskCreateRequest,
  TaskReviseRequest,
} from "@verified-action-protocol/protocol";
import type { Coordinator, Logger, Principal } from "@verified-action-protocol/core";
import { hasRole, ROLES } from "@verified-action-protocol/core";
import type { Authenticator } from "./auth.js";
import { DEMO_PRINCIPALS } from "./auth.js";
import { Metrics } from "./metrics.js";
import { renderViewer } from "./viewer.js";

export interface ApiDeps {
  coordinator: Coordinator;
  auth: Authenticator;
  log: Logger;
  limits: { maxRequestBytes: number; maxInFlight: number; perPrincipalRps: number; requestKeyRetentionSeconds: number };
  build: { version: string; commit: string | null; image_digest: string | null };
  ready: () => Promise<boolean>;
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  requestId: string;
  principal: Principal | null;
}

type Handler = (ctx: Ctx, params: string[]) => Promise<{ status: number; body: unknown; schema?: SchemaName; headers?: Record<string, string>; raw?: boolean }>;

interface Route {
  method: string;
  pattern: RegExp;
  auth: boolean;
  handler: Handler;
}

const ID = "([a-z]{2,8}_[A-Za-z0-9_-]{8,64})";

class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly rps: number) {}
  take(key: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.rps, at: now };
    b.tokens = Math.min(this.rps, b.tokens + ((now - b.at) / 1000) * this.rps);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.buckets.clear();
    return true;
  }
}

export function createApiServer(deps: ApiDeps): http.Server {
  const { coordinator: c, auth, log } = deps;
  const validator = schemaValidator();
  const metrics = new Metrics();
  const buckets = new TokenBuckets(deps.limits.perPrincipalRps);
  let inFlight = 0;

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > deps.limits.maxRequestBytes) return reject(new VapError("LIMIT_EXCEEDED", `request body exceeds ${deps.limits.maxRequestBytes} bytes`, { status: 413 }));
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > deps.limits.maxRequestBytes) {
          reject(new VapError("LIMIT_EXCEEDED", `request body exceeds ${deps.limits.maxRequestBytes} bytes`, { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (size === 0) return resolve({});
        if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
          return reject(new VapError("INVALID_ARGUMENT", "content-type must be application/json", { status: 415 }));
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"), (_k, v) => v));
        } catch {
          reject(new VapError("INVALID_ARGUMENT", "body is not valid JSON"));
        }
      });
      req.on("error", reject);
    });

  async function body<T>(ctx: Ctx, schema: SchemaName): Promise<T> {
    const b = await readBody(ctx.req);
    assertProtocolVersion(b);
    return validator.assertRequest<T>(schema, b);
  }

  const P = (ctx: Ctx): Principal => ctx.principal!;
  const qInt = (ctx: Ctx, k: string, d: number) => {
    const v = ctx.url.searchParams.get(k);
    const n = v === null ? d : Number(v);
    if (!Number.isInteger(n) || n < 0) throw new VapError("INVALID_ARGUMENT", `${k} must be a non-negative integer`);
    return n;
  };
  const envelope = (b: Record<string, unknown>) => ({ protocol_version: PROTOCOL_VERSION, ...b });

  const routes: Route[] = [
    { method: "GET", pattern: /^\/healthz$/, auth: false, handler: async () => ({ status: 200, body: { status: "ok" } }) },
    {
      method: "GET",
      pattern: /^\/readyz$/,
      auth: false,
      handler: async () => {
        const ok = await deps.ready();
        return { status: ok ? 200 : 503, body: { status: ok ? "ready" : "not_ready" } };
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/info$/,
      auth: true,
      handler: async () => {
        const info: InfoResponse = {
          protocol_version: PROTOCOL_VERSION,
          api_version: API_VERSION,
          supported_protocol_versions: [...SUPPORTED_PROTOCOL_VERSIONS],
          build: deps.build,
          auth_mode: auth.mode,
          adapters: c.registry.info(),
          limits: {
            max_request_bytes: deps.limits.maxRequestBytes,
            max_observation_bytes: c.opts.maxObservationBytes,
            default_plan_ttl_seconds: c.opts.defaultPlanTtlSeconds,
            request_key_retention_seconds: deps.limits.requestKeyRetentionSeconds,
          },
        };
        return { status: 200, body: info, schema: "messages#info" };
      },
    },
    // tasks
    { method: "POST", pattern: /^\/v1\/tasks$/, auth: true, handler: async (ctx) => ({ status: 201, body: await c.openTask(P(ctx), await body<TaskCreateRequest>(ctx, "messages#task_create_request")), schema: "task" }) },
    { method: "GET", pattern: new RegExp(`^/v1/tasks/${ID}$`), auth: true, handler: async (ctx, [id]) => ({ status: 200, body: await c.getTask(P(ctx), id), schema: "task" }) },
    {
      method: "POST",
      pattern: new RegExp(`^/v1/tasks/${ID}/revisions$`),
      auth: true,
      handler: async (ctx, [id]) => ({ status: 201, body: await c.reviseTask(P(ctx), id, await body<TaskReviseRequest>(ctx, "messages#task_revise_request")), schema: "task" }),
    },
    { method: "GET", pattern: new RegExp(`^/v1/tasks/${ID}/outcome$`), auth: true, handler: async (ctx, [id]) => ({ status: 200, body: await c.taskOutcome(P(ctx), id), schema: "messages#task_outcome" }) },
    // discovery and observation
    { method: "POST", pattern: /^\/v1\/observations$/, auth: true, handler: async (ctx) => ({ status: 200, body: await c.observe(P(ctx), await body<ObservationRequest>(ctx, "messages#observation_request")), schema: "observation" }) },
    {
      method: "GET",
      pattern: /^\/v1\/actions$/,
      auth: true,
      handler: async (ctx) => ({ status: 200, body: envelope({ actions: await c.listActions(P(ctx), ctx.url.searchParams.get("task_id")) }), schema: "messages#action_list_response" }),
    },
    // plans
    { method: "POST", pattern: /^\/v1\/plans$/, auth: true, handler: async (ctx) => ({ status: 201, body: await c.preparePlan(P(ctx), await body<PlanCreateRequest>(ctx, "messages#plan_create_request")), schema: "plan" }) },
    { method: "GET", pattern: new RegExp(`^/v1/plans/${ID}$`), auth: true, handler: async (ctx, [id]) => ({ status: 200, body: await c.getPlan(P(ctx), id), schema: "plan" }) },
    // operations
    {
      method: "POST",
      pattern: /^\/v1\/operations$/,
      auth: true,
      handler: async (ctx) => {
        const r = await c.submitOperation(P(ctx), await body<OperationCreateRequest>(ctx, "messages#operation_create_request"));
        return { status: r.replayed ? 200 : 202, body: r.operation, schema: "operation", headers: r.replayed ? { "idempotent-replay": "true" } : {} };
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/operations$/,
      auth: true,
      handler: async (ctx) => {
        const status = ctx.url.searchParams.get("status");
        const ops = await c.listOperations(P(ctx), { task_id: ctx.url.searchParams.get("task_id") ?? undefined, status: status ? status.split(",") : undefined, limit: qInt(ctx, "limit", 50) });
        return { status: 200, body: envelope({ operations: ops }) };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/operations\/lookup$/,
      auth: true,
      handler: async (ctx) => {
        const b = await body<{ action_id: string; request_key: string }>(ctx, "messages#operation_lookup_request");
        const op = await c.findOperationByRequestKey(P(ctx), b.action_id, b.request_key);
        if (!op) throw new VapError("NOT_FOUND", "no operation was submitted by this principal under that action and request key");
        return { status: 200, body: op, schema: "operation" };
      },
    },
    { method: "GET", pattern: new RegExp(`^/v1/operations/${ID}$`), auth: true, handler: async (ctx, [id]) => ({ status: 200, body: await c.getOperation(P(ctx), id), schema: "operation" }) },
    { method: "GET", pattern: new RegExp(`^/v1/operations/${ID}/receipt$`), auth: true, handler: async (ctx, [id]) => ({ status: 200, body: await c.receipt(P(ctx), id), schema: "messages#receipt" }) },
    { method: "GET", pattern: new RegExp(`^/v1/operations/${ID}/evidence$`), auth: true, handler: async (ctx, [id]) => ({ status: 200, body: envelope({ evidence: await c.listEvidence(P(ctx), id) }) }) },
    {
      method: "GET",
      pattern: new RegExp(`^/v1/evidence/${ID}/artifact$`),
      auth: true,
      handler: async (ctx, [id]) => {
        const a = await c.getArtifact(P(ctx), id);
        return { status: 200, body: a.content, raw: true, headers: { "content-type": a.mediaType === "application/json" ? "application/json" : "text/plain; charset=utf-8", "content-disposition": "attachment" } };
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/v1/operations/${ID}/verify$`),
      auth: true,
      handler: async (ctx, [id]) => {
        const b = await body<{ check_ids?: string[] }>(ctx, "messages#verify_request");
        return { status: 200, body: envelope(await c.verify(P(ctx), id, b.check_ids ?? null)), schema: "messages#verify_response" };
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/v1/operations/${ID}/reconcile$`),
      auth: true,
      handler: async (ctx, [id]) => {
        await body(ctx, "messages#reconcile_request");
        return { status: 200, body: envelope(await c.reconcile(P(ctx), id)), schema: "messages#reconcile_response" };
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/v1/operations/${ID}/recover$`),
      auth: true,
      handler: async (ctx, [id]) => {
        const r = await c.recover(P(ctx), id, await body<RecoverRequest>(ctx, "messages#recover_request"));
        return { status: 202, body: envelope({ original_operation: r.original, recovery_plan: r.plan, recovery_operation: r.operation }), schema: "messages#recover_response" };
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/v1/operations/${ID}/cancel$`),
      auth: true,
      handler: async (ctx, [id]) => {
        const b = await body<{ reason?: string }>(ctx, "messages#cancel_request");
        return { status: 202, body: envelope(await c.cancel(P(ctx), id, b.reason ?? null)), schema: "messages#cancel_response" };
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^/v1/operations/${ID}/events$`),
      auth: true,
      handler: async (ctx, [id]) => ({ status: 200, body: envelope(await c.listEvents(P(ctx), id, qInt(ctx, "after", 0), qInt(ctx, "limit", 100))), schema: "messages#event_page" }),
    },
    // approvals: agents can read pending state through GET /v1/plans/{id}; deciding is operator-only.
    { method: "GET", pattern: /^\/v1\/approvals\/pending$/, auth: true, handler: async (ctx) => ({ status: 200, body: envelope({ plans: await c.listPendingApprovals(P(ctx)) }) }) },
    { method: "GET", pattern: /^\/v1\/grants$/, auth: true, handler: async (ctx) => ({ status: 200, body: envelope({ grants: await c.listGrants(P(ctx)) }) }) },
    { method: "GET", pattern: new RegExp(`^/v1/grants/${ID}$`), auth: true, handler: async (ctx, [id]) => ({ status: 200, body: await c.getGrant(P(ctx), id), schema: "grant" }) },
    // operator-only surface (never exposed as agent tools)
    { method: "POST", pattern: /^\/v1\/operator\/grants$/, auth: true, handler: async (ctx) => ({ status: 201, body: await c.createGrant(P(ctx), await body<GrantCreateRequest>(ctx, "messages#grant_create_request")), schema: "grant" }) },
    { method: "POST", pattern: new RegExp(`^/v1/operator/grants/${ID}/revoke$`), auth: true, handler: async (ctx, [id]) => ({ status: 200, body: await c.revokeGrant(P(ctx), id), schema: "grant" }) },
    {
      method: "POST",
      pattern: /^\/v1\/operator\/approvals$/,
      auth: true,
      handler: async (ctx) => ({ status: 201, body: await c.decideApproval(P(ctx), await body<ApprovalCreateRequest>(ctx, "messages#approval_create_request")), schema: "approval" }),
    },
    {
      method: "POST",
      pattern: /^\/v1\/operator\/evidence$/,
      auth: true,
      handler: async (ctx) => ({ status: 201, body: await c.recordHumanEvidence(P(ctx), await body<HumanEvidenceRequest>(ctx, "messages#human_evidence_request")), schema: "evidence" }),
    },
    {
      method: "POST",
      pattern: new RegExp(`^/v1/operator/operations/${ID}/resolve$`),
      auth: true,
      handler: async (ctx, [id]) => ({ status: 200, body: await c.resolveOperation(P(ctx), id, await body<OperatorResolutionRequest>(ctx, "messages#operator_resolution_request")), schema: "operation" }),
    },
    {
      method: "POST",
      pattern: /^\/v1\/operator\/principals$/,
      auth: true,
      handler: async (ctx) => {
        const b = (await readBody(ctx.req)) as { subject?: unknown; roles?: unknown };
        if (typeof b.subject !== "string" || b.subject.length === 0 || b.subject.length > 320 || !Array.isArray(b.roles) || !b.roles.every((r) => (ROLES as readonly string[]).includes(r as string))) {
          throw new VapError("INVALID_ARGUMENT", "subject (string) and roles (subset of agent, operator, approver, viewer) are required");
        }
        await c.setPrincipalRoles(P(ctx), b.subject, b.roles as Principal["roles"]);
        return { status: 200, body: envelope({ subject: b.subject, roles: b.roles }) };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/operator\/sweep$/,
      auth: true,
      handler: async (ctx) => {
        if (!hasRole(P(ctx), "operator")) throw new VapError("FORBIDDEN", "operator role required");
        return { status: 200, body: envelope({ sweep: await c.sweep(`api-${ctx.requestId.slice(0, 8)}`) }) };
      },
    },
    {
      method: "GET",
      pattern: /^\/metrics$/,
      auth: true,
      handler: async (ctx) => {
        if (!hasRole(P(ctx), "operator") && !hasRole(P(ctx), "viewer")) throw new VapError("FORBIDDEN", "operator or viewer role required");
        return { status: 200, body: await metrics.render(c), raw: true, headers: { "content-type": "text/plain; version=0.0.4" } };
      },
    },
    // read-only viewer
    {
      method: "GET",
      pattern: /^\/viewer(\/.*)?$/,
      auth: true,
      handler: async (ctx) => ({ status: 200, body: await renderViewer(c, P(ctx), ctx.url), raw: true, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'", "x-frame-options": "DENY" } }),
    },
  ];

  if (auth.mode === "demo") {
    // Loopback demo convenience: sets a cookie naming a synthetic demo principal.
    routes.push({
      method: "GET",
      pattern: /^\/demo-login$/,
      auth: false,
      handler: async (ctx) => {
        const who = ctx.url.searchParams.get("as") ?? "demo-operator";
        if (!DEMO_PRINCIPALS[who]) throw new VapError("INVALID_ARGUMENT", "unknown demo principal");
        return { status: 302, body: "", raw: true, headers: { location: "/viewer", "set-cookie": `vap_demo=${who}; HttpOnly; SameSite=Strict; Path=/` } };
      },
    });
  }

  const send = (res: ServerResponse, status: number, payload: unknown, headers: Record<string, string>, raw: boolean) => {
    if (res.headersSent) return;
    const common = { "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers };
    if (raw) {
      res.writeHead(status, common);
      res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
      return;
    }
    res.writeHead(status, { "content-type": "application/json", ...common });
    res.end(JSON.stringify(payload));
  };

  return http.createServer((req, res) => {
    const started = Date.now();
    const requestId = (typeof req.headers["x-cloud-trace-context"] === "string" ? req.headers["x-cloud-trace-context"].split("/")[0] : null) ?? randomUUID();
    const url = new URL(req.url ?? "/", "http://vap.invalid");
    const ctx: Ctx = { req, res, url, requestId, principal: null };
    const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    const finish = (status: number, code: string | null) => {
      metrics.observeRequest(route ? route.pattern.source : "unmatched", status, Date.now() - started);
      log.info("request", { request_id: requestId, method: req.method, route: route ? route.pattern.source : null, status, code, principal: ctx.principal?.id ?? null, duration_ms: Date.now() - started });
    };
    if (inFlight >= deps.limits.maxInFlight) {
      const err = new VapError("UNAVAILABLE", "server is at its concurrency limit; retry with the same request key", { status: 503 });
      send(res, 503, { protocol_version: PROTOCOL_VERSION, error: err.toBody() }, { "retry-after": "1" }, false);
      finish(503, err.code);
      return;
    }
    inFlight++;
    (async () => {
      if (!route) throw new VapError("NOT_FOUND", "no such endpoint");
      if (route.auth) {
        try {
          ctx.principal = await auth.authenticate(req.headers.authorization, req.headers.cookie);
        } catch (e) {
          metrics.authDenials++;
          throw e;
        }
        if (ctx.principal.roles.length === 0) {
          metrics.authDenials++;
          throw new VapError("FORBIDDEN", "authenticated principal has no VAP role; an operator must assign one");
        }
        if (!buckets.take(ctx.principal.id)) throw new VapError("LIMIT_EXCEEDED", "rate limit exceeded", { status: 429 });
      }
      const params = route.pattern.exec(url.pathname)!.slice(1).filter((x) => x !== undefined);
      const r = await route.handler(ctx, params);
      if (r.schema && !r.raw) validator.assertResponse(r.schema, r.body);
      send(res, r.status, r.body, r.headers ?? {}, r.raw === true);
      finish(r.status, null);
    })()
      .catch((e: unknown) => {
        const err = e instanceof VapError ? e : new VapError("INTERNAL", "internal error");
        if (!(e instanceof VapError) || err.code === "INTERNAL") log.error("request failed", { request_id: requestId, error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack?.split("\n").slice(0, 5).join(" | ") : null });
        if (err.code === "FORBIDDEN" || err.code === "UNAUTHORIZED") metrics.authorizationDenials++;
        const headers: Record<string, string> = err.code === "UNAUTHORIZED" ? { "www-authenticate": 'Bearer realm="vap"' } : {};
        send(res, err.httpStatus, { protocol_version: PROTOCOL_VERSION, error: err.toBody() }, headers, false);
        finish(err.httpStatus, err.code);
      })
      .finally(() => {
        inFlight--;
      });
  });
}
