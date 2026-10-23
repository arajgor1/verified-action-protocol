import { PROTOCOL_VERSION, schemaValidator, sha256Digest, VapError } from "@vap/protocol";
import type { ActionDescriptor, CapabilityVector, Check, Effect, Operation, Plan, RecoveryMode } from "@vap/protocol";
import {
  anyResourceMatch,
  expandTemplate,
  jsonPointerGet,
  matchUriTemplate,
  redact,
  registerSensitiveValue,
  strictestTier,
  templateHasPlaceholders,
} from "@vap/core";
import type {
  Adapter,
  AdapterContext,
  AdapterResult,
  ExecuteContext,
  LookupResult,
  ObserveQuery,
  ObserveResult,
  PrepareResult,
  RecoveryPlanSpec,
  VerifyContext,
  VerifyObservation,
} from "@vap/core";
import type { ArgSource, HttpActionConfig, HttpAdapterConfig, HttpConnectorConfig, HttpResourceConfig } from "./http-config.js";
import { HTTP_CONFIG_SCHEMA } from "./http-config.js";
import { parseOrigin, safeRequest, SafeRequestError } from "./net.js";
import type { NetworkPolicy, SafeResponse } from "./net.js";

export interface HttpAdapterOptions {
  /** Isolated test mode allows connectors flagged allow_private_network (synthetic fixtures only). */
  isolatedTestMode?: boolean;
  env?: Record<string, string | undefined>;
}

const BASE_VERSION = "0.1.0";

function lastSegment(pointer: string): string {
  const parts = pointer.split("/");
  return parts[parts.length - 1].replace(/~1/g, "/").replace(/~0/g, "~");
}

function project(body: unknown, pointers: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of pointers) {
    const r = jsonPointerGet(body, p);
    if (r.found) out[lastSegment(p)] = r.value;
  }
  return out;
}

function compareVersions(observed: string | null, expected: string | null): "fresh" | "stale" | "unknown" {
  if (expected === null || observed === null) return "unknown";
  const o = Number(observed);
  const e = Number(expected);
  if (Number.isInteger(o) && Number.isInteger(e)) return o >= e ? "fresh" : "stale";
  return observed === expected ? "fresh" : "unknown";
}

/**
 * Configurable JSON HTTP adapter (spec section 11). One instance serves every action in one
 * operator-registered configuration. The adapter version includes a digest of the
 * configuration, so any mapping change invalidates previously prepared plans.
 */
export class HttpAdapter implements Adapter {
  readonly id: string;
  readonly version: string;
  readonly provenance = "operator_configured" as const;
  private readonly verifierId: string;
  private readonly descriptors: ActionDescriptor[];
  private readonly env: Record<string, string | undefined>;

  constructor(
    private readonly config: HttpAdapterConfig,
    private readonly opts: HttpAdapterOptions = {},
  ) {
    const issues = schemaValidator().compileInputSchema(HTTP_CONFIG_SCHEMA)(config);
    if (issues.length > 0) throw new Error(`HTTP adapter configuration is invalid: ${JSON.stringify(issues)}`);
    for (const [name, c] of Object.entries(config.connectors)) {
      parseOrigin(c.origin);
      if (c.allow_private_network && !opts.isolatedTestMode) {
        // Not an error: the flag is simply ignored outside isolated test mode.
      }
      if (c.auth && c.auth.type !== "none" && !c.auth.env) throw new Error(`connector ${name} auth requires env`);
    }
    this.id = config.id;
    this.version = `${BASE_VERSION}+cfg.${sha256Digest(config).slice(7, 19)}`;
    this.verifierId = config.verifier_id ?? "http.readback";
    this.env = opts.env ?? process.env;
    for (const c of Object.values(config.connectors)) {
      if (c.auth && c.auth.type !== "none") registerSensitiveValue(this.env[c.auth.env]);
    }
    this.descriptors = config.actions.map((a) => this.describe(a));
  }

  private policyFor(c: HttpConnectorConfig): NetworkPolicy {
    return { allowPrivateNetwork: c.allow_private_network === true, isolatedTestMode: this.opts.isolatedTestMode === true };
  }

  private describe(a: HttpActionConfig): ActionDescriptor {
    const resource = a.conditional_write ? this.resourceForTemplate(a.conditional_write.resource) : null;
    const stateSource = resource?.state_source ?? this.config.resources[0]?.state_source ?? "authoritative_api";
    const capabilities: CapabilityVector = {
      state_source: stateSource,
      concurrency_mode: a.conditional_write ? (a.conditional_write.mode === "native" ? "native_conditional" : "best_effort") : "none",
      preview_fidelity: "estimate",
      retry_mode: a.request_key_header && a.lookup?.definitive_not_found ? "destination_dedup" : a.lookup ? "lookup_then_retry" : "no_automatic_retry",
      recovery_modes: [...new Set((a.recovery ?? []).map((r) => r.mode))],
      verification_methods: ["read_back"],
      attribution_mode: a.request_key_header ? "explicit_request_id" : "none",
      execution_isolation: "none",
    };
    const d: ActionDescriptor = {
      protocol_version: PROTOCOL_VERSION,
      id: a.id,
      title: a.title,
      adapter: { id: this.id, version: this.version },
      input_schema: a.input_schema,
      effect_scope: a.effect_scope,
      preconditions: a.preconditions ?? [],
      side_effects: a.side_effects,
      risk_tier: a.risk_tier ?? strictestTier(a.side_effects),
      capabilities,
      verifier_ids: a.verifiers ?? [this.verifierId],
      recovery_modes: (a.recovery ?? []).map((r) => ({ mode: r.mode, action_id: r.action_id, description: r.description })),
      plan_ttl_seconds: a.plan_ttl_seconds ?? 300,
      limits: { max_items: a.max_items ?? null },
    };
    if (a.description) d.description = a.description;
    if (a.timeout_ms) d.extensions = { "vap.execution_timeout_ms": a.timeout_ms };
    return d;
  }

  manifest(): ActionDescriptor[] {
    return this.descriptors;
  }

  resourcePrefixes(): string[] {
    return this.config.resources.map((r) => r.uri_template.slice(0, r.uri_template.indexOf("{") === -1 ? undefined : r.uri_template.indexOf("{")));
  }

  verifierIds(): string[] {
    return [this.verifierId];
  }

  private action(id: string): HttpActionConfig {
    const a = this.config.actions.find((x) => x.id === id);
    if (!a) throw new VapError("NOT_FOUND", `action ${id} is not configured`);
    return a;
  }

  private connector(name: string): HttpConnectorConfig {
    const c = this.config.connectors[name];
    if (!c) throw new VapError("INTERNAL", `connector ${name} is not configured`);
    return c;
  }

  private resourceForTemplate(template: string): HttpResourceConfig | null {
    const prefix = template.slice(0, template.indexOf("{") === -1 ? undefined : template.indexOf("{"));
    return this.config.resources.find((r) => r.uri_template.startsWith(prefix) || prefix.startsWith(r.uri_template.slice(0, r.uri_template.indexOf("{")))) ?? null;
  }

  private matchResource(uri: string): { resource: HttpResourceConfig; params: Record<string, string> } {
    for (const r of this.config.resources) {
      const params = matchUriTemplate(r.uri_template, uri);
      if (params) return { resource: r, params };
    }
    throw new VapError("NOT_FOUND", "resource URI does not match any registered resource template");
  }

  private authHeaders(c: HttpConnectorConfig): Record<string, string> {
    if (!c.auth || c.auth.type === "none") return {};
    const value = this.env[c.auth.env];
    if (!value) throw new VapError("UNAVAILABLE", "connector credential is not configured in this deployment");
    if (c.auth.type === "bearer_env") return { authorization: `Bearer ${value}` };
    return { [c.auth.header.toLowerCase()]: value };
  }

  private async send(c: HttpConnectorConfig, method: string, path: string, body: unknown, extraHeaders: Record<string, string>, signal: AbortSignal, timeoutMs?: number): Promise<SafeResponse> {
    return safeRequest({
      origin: c.origin,
      method,
      path,
      headers: { accept: "application/json", "cache-control": "no-cache", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...this.authHeaders(c), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: timeoutMs ?? c.timeout_ms ?? 10_000,
      maxResponseBytes: c.max_response_bytes ?? 1024 * 1024,
      signal,
      policy: this.policyFor(c),
    });
  }

  private async readResource(uri: string, signal: AbortSignal): Promise<{ resource: HttpResourceConfig; status: number; facts: Record<string, unknown>; version: string | null; raw: unknown }> {
    const { resource, params } = this.matchResource(uri);
    const c = this.connector(resource.connector);
    const path = expandTemplate(resource.read_path, { args: params });
    let res: SafeResponse;
    try {
      res = await this.send(c, "GET", path, undefined, {}, signal);
    } catch (e) {
      if (e instanceof SafeRequestError) throw new VapError("DESTINATION_UNAVAILABLE", `read failed: ${e.message}`);
      throw e;
    }
    if (res.status === 404) return { resource, status: 404, facts: {}, version: null, raw: null };
    if (res.status < 200 || res.status >= 300) throw new VapError("DESTINATION_UNAVAILABLE", `read returned HTTP ${res.status}`);
    const facts = project(res.json, resource.projection);
    let version: string | null = null;
    if (resource.version.header) version = res.headers[resource.version.header.toLowerCase()]?.replace(/^W\//, "").replace(/"/g, "") ?? null;
    if (version === null && resource.version.pointer) {
      const v = jsonPointerGet(res.json, resource.version.pointer);
      version = v.found && (typeof v.value === "string" || typeof v.value === "number") ? String(v.value) : null;
    }
    return { resource, status: res.status, facts, version, raw: res.json };
  }

  async observe(q: ObserveQuery, ctx: AdapterContext): Promise<ObserveResult> {
    const r = await this.readResource(q.resource_uri, ctx.signal);
    if (r.status === 404) {
      return { source: `${this.id}:readback`, source_version: null, freshness: "fresh", facts: { exists: false }, unknowns: [], completeness: "complete" };
    }
    const unknowns = r.resource.projection.filter((p) => !(lastSegment(p) in r.facts)).map((p) => `field ${lastSegment(p)} was not present`);
    return {
      source: `${this.id}:readback`,
      source_version: r.version,
      freshness: r.resource.state_source === "eventually_consistent_api" ? "unknown" : "fresh",
      facts: { exists: true, ...r.facts },
      unknowns,
      completeness: unknowns.length > 0 ? "partial" : "complete",
    };
  }

  async prepare(action: ActionDescriptor, args: Record<string, unknown>, ctx: AdapterContext): Promise<PrepareResult> {
    const a = this.action(action.id);
    const canonical = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
    const itemCount = a.items_field ? (Array.isArray(canonical[a.items_field]) ? (canonical[a.items_field] as unknown[]).length : 0) : null;
    const scope = a.effect_scope.resource_template;
    const hasResult = /\{(result|item)\./.test(scope);
    const affected = hasResult ? [scope.slice(0, scope.search(/\{(result|item)\./)) + "*"] : [expandTemplate(scope, { args: canonical })];
    const conditions: PrepareResult["resource_conditions"] = [];
    let frozen: Record<string, unknown> | undefined;
    if (a.conditional_write) {
      const uri = expandTemplate(a.conditional_write.resource, { args: canonical });
      if (!anyResourceMatch(ctx.allowedTargets, uri)) throw new VapError("FORBIDDEN", "conditional-write resource is outside the grant");
      const cur = await this.readResource(uri, ctx.signal);
      if (cur.status === 404) throw new VapError("INVALID_ARGUMENT", "target resource does not exist");
      conditions.push({ resource_uri: uri, expected_version: cur.version, enforcement: a.conditional_write.mode === "native" ? "native" : "best_effort" });
      frozen = { prior: redact(cur.facts) as Record<string, unknown>, prior_version: cur.version };
      if (!affected.includes(uri)) affected.push(uri);
    }
    const fields = a.body_fields.filter((f) => f in canonical);
    return {
      canonical_arguments: canonical,
      resource_conditions: conditions,
      preview: {
        fidelity: "estimate",
        summary: `${a.title}: ${a.method} ${a.path} with fields [${fields.join(", ")}]${itemCount !== null ? ` for ${itemCount} items` : ""}. Remote behavior beyond the declared side effects is not simulated.`,
        effects: a.side_effects.map((s) => ({ side_effect_id: s.id, class: s.class, description: s.description, item_count: itemCount })),
      },
      affected_resources: affected,
      item_count: itemCount,
      frozen,
    };
  }

  private mapEffects(a: HttpActionConfig, body: unknown, resultSummary: Record<string, unknown>): { effects: Effect[]; applied: number; total: number } {
    const effects: Effect[] = [];
    let applied = 0;
    let total = 0;
    for (const m of a.response.effects) {
      if (m.items_pointer) {
        const items = jsonPointerGet(body, m.items_pointer);
        const list = Array.isArray(items.value) ? items.value : [];
        list.forEach((item, i) => {
          total++;
          const st = m.item_status_pointer ? jsonPointerGet(item, m.item_status_pointer) : { found: false, value: undefined };
          const ok = st.found && (m.item_applied_values ?? ["applied"]).includes(String(st.value));
          if (ok) applied++;
          let uri: string | null = null;
          try {
            uri = ok && m.item_resource_template ? expandTemplate(m.item_resource_template, { item: item as Record<string, unknown> }) : null;
          } catch {
            uri = null;
          }
          const ver = m.item_version_pointer ? jsonPointerGet(item, m.item_version_pointer) : { found: false, value: undefined };
          effects.push({
            side_effect_id: m.side_effect_id,
            item_index: i,
            resource_uri: uri,
            status: ok ? "applied" : "not_applied",
            source_version: ver.found ? String(ver.value) : null,
            detail: ok ? null : `item status ${st.found ? String(st.value) : "missing"}`,
          });
        });
      } else {
        total++;
        applied++;
        let uri: string | null = null;
        if (m.resource_template) uri = expandTemplate(m.resource_template, { result: resultSummary });
        const ver = m.version_pointer ? jsonPointerGet(body, m.version_pointer) : { found: false, value: undefined };
        effects.push({ side_effect_id: m.side_effect_id, item_index: null, resource_uri: uri, status: "applied", source_version: ver.found ? String(ver.value) : null, detail: null });
      }
    }
    return { effects, applied, total };
  }

  private allEffects(a: HttpActionConfig, status: Effect["status"], detail: string): Effect[] {
    return a.side_effects.filter((s) => s.class !== "none" && a.response.effects.some((m) => m.side_effect_id === s.id)).map((s) => ({
      side_effect_id: s.id,
      item_index: null,
      resource_uri: null,
      status,
      source_version: null,
      detail,
    }));
  }

  private fromResponse(a: HttpActionConfig, res: SafeResponse, handle: string): AdapterResult {
    const diag = { http_status: res.status, truncated: res.truncated };
    if (res.status >= 200 && res.status < 300) {
      if (res.truncated || (res.json === null && res.status !== 204)) {
        return { outcome: "unknown", submission: "submitted", effects: this.allEffects(a, "unknown", "destination accepted but the response could not be parsed"), result_summary: null, external_handle: handle, diagnostics: diag, error: new VapError("OUTCOME_UNKNOWN", "destination response could not be interpreted").toBody() };
      }
      const summary = project(res.json, a.response.projection);
      const { effects, applied, total } = this.mapEffects(a, res.json, summary);
      if (total === 0 && a.response.effects.length > 0) {
        return { outcome: "unknown", submission: "submitted", effects: this.allEffects(a, "unknown", "destination accepted but reported no item results"), result_summary: summary, external_handle: handle, diagnostics: diag, error: new VapError("OUTCOME_UNKNOWN", "destination response contained no recognizable effects").toBody() };
      }
      const outcome = applied === total ? "completed" : applied === 0 ? "failed" : "partial";
      return { outcome, submission: "submitted", effects, result_summary: summary, external_handle: handle, diagnostics: diag };
    }
    if (res.status === 409 || res.status === 412) {
      return { outcome: "failed", submission: "submitted", effects: this.allEffects(a, "not_applied", "destination rejected the conditional write"), result_summary: null, external_handle: handle, diagnostics: diag, error: new VapError("CONFLICT", "destination rejected the write because the resource version changed").toBody() };
    }
    if (res.status >= 300 && res.status < 400) {
      return { outcome: "failed", submission: "submitted", effects: this.allEffects(a, "not_applied", "redirect not followed"), result_summary: null, external_handle: handle, diagnostics: diag, error: new VapError("DESTINATION_UNAVAILABLE", "destination redirected; redirects are never followed").toBody() };
    }
    if (res.status >= 400 && res.status < 500) {
      const fieldErrors = Array.isArray((res.json as { errors?: unknown })?.errors)
        ? ((res.json as { errors: { field?: unknown; code?: unknown }[] }).errors.slice(0, 20).map((e) => ({ field: typeof e.field === "string" ? e.field : null, code: typeof e.code === "string" ? e.code : null })))
        : [];
      return {
        outcome: "failed",
        submission: "submitted",
        effects: this.allEffects(a, "not_applied", `destination rejected the request with HTTP ${res.status}`),
        result_summary: null,
        external_handle: handle,
        diagnostics: { ...diag, field_errors: fieldErrors },
        error: new VapError("INVALID_ARGUMENT", `destination rejected the request (HTTP ${res.status})`, { details: { field_errors: fieldErrors } }).toBody(),
      };
    }
    return { outcome: "unknown", submission: "submitted", effects: this.allEffects(a, "unknown", `destination returned HTTP ${res.status}`), result_summary: null, external_handle: handle, diagnostics: diag, error: new VapError("OUTCOME_UNKNOWN", `destination returned HTTP ${res.status}; it may have applied the request`).toBody() };
  }

  async execute(plan: Plan, ctx: ExecuteContext): Promise<AdapterResult> {
    const a = this.action(plan.action_id);
    const c = this.connector(a.connector);
    const args = plan.canonical_arguments;
    const path = expandTemplate(a.path, { args });
    const body: Record<string, unknown> = {};
    for (const f of a.body_fields) if (f in args) body[f] = args[f];
    const headers: Record<string, string> = {};
    if (a.request_key_header) headers[a.request_key_header.toLowerCase()] = ctx.destinationKey;
    const cond = plan.resource_conditions[0];
    if (a.conditional_write && cond) {
      if (a.conditional_write.mode === "native") {
        if (cond.expected_version === null) {
          return { outcome: "failed", submission: "not_submitted", effects: this.allEffects(a, "not_applied", "no destination version to condition on"), result_summary: null, external_handle: null, error: new VapError("CAPABILITY_UNAVAILABLE", "native conditional write needs a destination version").toBody() };
        }
        headers[(a.conditional_write.header ?? "if-match").toLowerCase()] = `"${cond.expected_version}"`;
      } else {
        // Best effort: a read followed by an unconditional write. A concurrent writer can still
        // interleave between these two requests; the plan records enforcement=best_effort.
        const cur = await this.readResource(cond.resource_uri, ctx.signal);
        if (cur.version !== cond.expected_version) {
          return { outcome: "failed", submission: "not_submitted", effects: this.allEffects(a, "not_applied", "resource changed since preparation"), result_summary: null, external_handle: null, error: new VapError("STALE_PLAN", "resource version changed since the plan was prepared").toBody() };
        }
      }
    }
    await ctx.recheck();
    let res: SafeResponse;
    try {
      res = await this.send(c, a.method, path, a.body_fields.length > 0 ? body : undefined, headers, ctx.signal, a.timeout_ms);
    } catch (e) {
      if (e instanceof SafeRequestError) {
        if (e.submission === "not_submitted") {
          return { outcome: "failed", submission: "not_submitted", effects: this.allEffects(a, "not_applied", "request never reached the destination"), result_summary: null, external_handle: null, diagnostics: { network_error: e.code }, error: new VapError("DESTINATION_UNAVAILABLE", `request was not delivered: ${e.message}`).toBody() };
        }
        return { outcome: "unknown", submission: "maybe_submitted", effects: this.allEffects(a, "unknown", "reply lost after the request may have been delivered"), result_summary: null, external_handle: ctx.destinationKey, diagnostics: { network_error: e.code }, error: new VapError("OUTCOME_UNKNOWN", `reply lost: ${e.message}`).toBody() };
      }
      throw e;
    }
    return this.fromResponse(a, res, ctx.destinationKey);
  }

  async lookup(operation: Operation, plan: Plan, ctx: AdapterContext): Promise<LookupResult> {
    const a = this.action(plan.action_id);
    if (!a.lookup || !a.request_key_header) throw new VapError("CAPABILITY_UNAVAILABLE", `action ${a.id} has no destination lookup`);
    const c = this.connector(a.connector);
    const destKey = ctx.destinationKey ?? operation.id;
    let path = expandTemplate(a.lookup.path, { request: { key: destKey } });
    const q = new URLSearchParams(a.lookup.query ?? {}).toString();
    if (q) path += `?${q}`;
    let res: SafeResponse;
    try {
      res = await this.send(c, "GET", path, undefined, {}, ctx.signal);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "lookup failed";
      return { status: "unknown", definitive: false, effects: [], result_summary: null, external_handle: null, observations: [{ lookup_error: msg }] };
    }
    const obs = { lookup_http_status: res.status };
    if (res.status === 404) {
      return { status: "not_applied", definitive: a.lookup.definitive_not_found, effects: [], result_summary: null, external_handle: destKey, observations: [obs] };
    }
    if (res.status !== 200 || res.json === null) return { status: "unknown", definitive: false, effects: [], result_summary: null, external_handle: null, observations: [obs] };
    const st = jsonPointerGet(res.json, a.lookup.status_pointer);
    const value = st.found ? String(st.value) : "";
    const original = a.lookup.response_pointer ? jsonPointerGet(res.json, a.lookup.response_pointer).value : res.json;
    if (a.lookup.applied_values.includes(value) || (a.lookup.partial_values ?? []).includes(value)) {
      const summary = project(original, a.response.projection);
      const mapped = this.mapEffects(a, original, summary);
      const status = mapped.applied === mapped.total ? "applied" : mapped.applied === 0 ? "not_applied" : "partial";
      return { status, definitive: true, effects: mapped.effects, result_summary: summary, external_handle: destKey, observations: [{ ...obs, destination_status: value }] };
    }
    if ((a.lookup.rejected_values ?? []).includes(value)) {
      return { status: "not_applied", definitive: true, destination_rejected: true, effects: [], result_summary: null, external_handle: destKey, observations: [{ ...obs, destination_status: value }] };
    }
    return { status: "unknown", definitive: false, effects: [], result_summary: null, external_handle: null, observations: [{ ...obs, destination_status: value }] };
  }

  async verify(check: Check, ctx: VerifyContext): Promise<VerifyObservation> {
    if (check.verifier_id !== this.verifierId) throw new VapError("CAPABILITY_UNAVAILABLE", `verifier ${check.verifier_id} is not provided by ${this.id}`);
    if (check.method !== "read_back") throw new VapError("CAPABILITY_UNAVAILABLE", `${this.verifierId} only performs read_back checks`);
    const r = await this.readResource(ctx.target, ctx.signal);
    const facts = r.status === 404 ? { exists: false } : { exists: true, ...r.facts };
    const limitations: string[] = [];
    if (r.resource.state_source === "eventually_consistent_api") limitations.push("destination reads are eventually consistent");
    return {
      facts,
      source: `${this.id}:readback`,
      source_version: r.version,
      freshness: r.status === 404 ? "unknown" : compareVersions(r.version, ctx.expectedVersion),
      method: "read_back",
      limitations,
      artifact: { content: JSON.stringify({ target: ctx.target, http_status: r.status, version: r.version, facts }), media_type: "application/json" },
    };
  }

  private resolveSource(src: ArgSource, op: Operation, plan: Plan): unknown {
    const frozen = (plan.extensions?.["vap.prepare"] ?? {}) as { prior?: Record<string, unknown> };
    switch (src.from) {
      case "const":
        return src.value;
      case "args":
        return plan.canonical_arguments[src.field];
      case "result":
        return op.result_summary?.[src.field];
      case "prior": {
        const r = jsonPointerGet(frozen.prior ?? {}, src.pointer);
        if (!r.found) throw new VapError("CAPABILITY_UNAVAILABLE", "prior state needed for compensation was not captured at preparation");
        return r.value;
      }
      case "applied_items":
        return op.effects
          .filter((e) => e.status === "applied" && e.resource_uri)
          .map((e) => e.resource_uri!.split("/").pop())
          .filter((x) => x !== undefined);
    }
  }

  async recover(operation: Operation, plan: Plan, strategy: RecoveryMode, _ctx: AdapterContext): Promise<RecoveryPlanSpec> {
    const a = this.action(plan.action_id);
    const r = (a.recovery ?? []).find((x) => x.mode === strategy);
    if (!r) throw new VapError("CAPABILITY_UNAVAILABLE", `action ${a.id} declares no ${strategy} recovery`);
    const args: Record<string, unknown> = {};
    for (const [k, src] of Object.entries(r.arguments)) args[k] = this.resolveSource(src, operation, plan);
    const checks: Check[] = r.checks.map((t) => {
      const { value_from, ...pred } = t.predicate;
      const predicate = value_from ? { ...pred, value: this.resolveSource(value_from, operation, plan) } : pred;
      const target = templateHasPlaceholders(t.target) && !t.target.includes("{effect.") ? expandTemplate(t.target, { args: plan.canonical_arguments, result: operation.result_summary }) : t.target;
      return { ...t, target, predicate };
    });
    return {
      action_id: r.action_id,
      arguments: args,
      covered_effects: operation.effects.filter((e) => e.status === "applied"),
      uncovered_effects: r.uncovered_effects,
      checks,
    };
  }
}
