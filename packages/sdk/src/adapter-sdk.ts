import { PROTOCOL_VERSION, schemaValidator, TIER_BY_SIDE_EFFECT_CLASS, VapError } from "@vap/protocol";
import type { ActionDescriptor, CapabilityVector, Check, Operation, Plan, RecoveryMode, SideEffect } from "@vap/protocol";
import { strictestTier } from "@vap/core";
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

export { redact, redactString, registerSensitiveValue, allowlist } from "@vap/core";
export type { Adapter, AdapterContext, AdapterResult, ExecuteContext, LookupResult, ObserveQuery, ObserveResult, PrepareResult, RecoveryPlanSpec, VerifyContext, VerifyObservation } from "@vap/core";

/** Error constructor for unsupported adapter methods. */
export function unavailable(explanation: string): VapError {
  return new VapError("CAPABILITY_UNAVAILABLE", explanation);
}

export interface ActionSpec {
  id: string;
  title: string;
  description?: string;
  input_schema: Record<string, unknown>;
  effect_scope: { resource_template: string; description: string };
  side_effects: SideEffect[];
  capabilities: CapabilityVector;
  verifier_ids?: string[];
  recovery_modes?: { mode: RecoveryMode; action_id: string | null; description: string }[];
  preconditions?: string[];
  plan_ttl_seconds?: number;
  execution_timeout_ms?: number;
}

/** Typed registration helper: derives the risk tier from side effects and validates the descriptor. */
export function defineAction(adapter: { id: string; version: string }, spec: ActionSpec): ActionDescriptor {
  const d: ActionDescriptor = {
    protocol_version: PROTOCOL_VERSION,
    id: spec.id,
    title: spec.title,
    adapter: { id: adapter.id, version: adapter.version },
    input_schema: spec.input_schema,
    effect_scope: spec.effect_scope,
    preconditions: spec.preconditions ?? [],
    side_effects: spec.side_effects,
    risk_tier: strictestTier(spec.side_effects),
    capabilities: spec.capabilities,
    verifier_ids: spec.verifier_ids ?? [],
    recovery_modes: spec.recovery_modes ?? [],
    plan_ttl_seconds: spec.plan_ttl_seconds ?? 300,
  };
  if (spec.description) d.description = spec.description;
  if (spec.execution_timeout_ms) d.extensions = { "vap.execution_timeout_ms": spec.execution_timeout_ms };
  const issues = schemaValidator().check("action", d);
  if (issues.length > 0) throw new Error(`action ${spec.id} is invalid: ${JSON.stringify(issues)}`);
  return d;
}

/**
 * Base class with honest defaults: every optional method reports CAPABILITY_UNAVAILABLE.
 * Subclasses implement manifest/prepare/execute at minimum. Adapters are trusted reviewed
 * code compiled into the image; they are never loaded from remote manifests.
 */
export abstract class BaseAdapter implements Adapter {
  abstract readonly id: string;
  abstract readonly version: string;
  readonly provenance: "built_in" | "operator_configured" = "built_in";
  abstract manifest(): ActionDescriptor[];
  resourcePrefixes(): string[] {
    return [];
  }
  verifierIds(): string[] {
    return [];
  }
  async observe(_q: ObserveQuery, _ctx: AdapterContext): Promise<ObserveResult> {
    throw unavailable(`${this.id} does not support observe`);
  }
  abstract prepare(action: ActionDescriptor, args: Record<string, unknown>, ctx: AdapterContext): Promise<PrepareResult>;
  abstract execute(plan: Plan, ctx: ExecuteContext): Promise<AdapterResult>;
  async lookup(_op: Operation, _plan: Plan, _ctx: AdapterContext): Promise<LookupResult> {
    throw unavailable(`${this.id} has no destination lookup; unknown outcomes need operator resolution`);
  }
  async verify(_check: Check, _ctx: VerifyContext): Promise<VerifyObservation> {
    throw unavailable(`${this.id} provides no verifier`);
  }
  async recover(_op: Operation, _plan: Plan, strategy: RecoveryMode, _ctx: AdapterContext): Promise<RecoveryPlanSpec> {
    throw unavailable(`${this.id} declares no ${strategy} recovery`);
  }
}

export interface StaticConformanceFinding {
  action_id: string | null;
  severity: "error" | "warning";
  message: string;
}

/**
 * Static adapter conformance (no destination required): descriptor schema validity, tier
 * consistency, capability coherence, verifier and recovery declarations, and that
 * unsupported methods fail with CAPABILITY_UNAVAILABLE. Runtime profile tests (Core,
 * Verified, Recoverable) run against real PostgreSQL in tests/conformance.
 */
export async function staticConformance(adapter: Adapter): Promise<StaticConformanceFinding[]> {
  const findings: StaticConformanceFinding[] = [];
  const validator = schemaValidator();
  const ids = new Set<string>();
  for (const d of adapter.manifest()) {
    const f = (severity: "error" | "warning", message: string) => findings.push({ action_id: d.id, severity, message });
    for (const i of validator.check("action", d)) f("error", `descriptor ${i.path}: ${i.message}`);
    if (ids.has(d.id)) f("error", "duplicate action id");
    ids.add(d.id);
    if (d.adapter.id !== adapter.id || d.adapter.version !== adapter.version) f("error", "descriptor adapter reference does not match the adapter");
    const min = Math.max(0, ...d.side_effects.map((s) => TIER_BY_SIDE_EFFECT_CLASS[s.class]));
    if (d.risk_tier < min) f("error", `risk tier ${d.risk_tier} is below the strictest side effect tier ${min}`);
    for (const rm of d.recovery_modes) if (!d.capabilities.recovery_modes.includes(rm.mode)) f("error", `recovery mode ${rm.mode} is not in the capability vector`);
    for (const m of d.capabilities.recovery_modes) if (!d.recovery_modes.some((r) => r.mode === m)) f("error", `capability claims ${m} recovery without a declared strategy`);
    if (d.capabilities.verification_methods.length > 0 && d.verifier_ids.length === 0) f("warning", "verification methods are declared but no verifier is named");
    if (d.capabilities.retry_mode === "destination_dedup" && d.capabilities.attribution_mode !== "explicit_request_id") f("error", "destination_dedup requires explicit request-id attribution");
    if (d.side_effects.some((s) => s.class !== "none") && d.capabilities.preview_fidelity === "exact" && d.capabilities.state_source !== "filesystem") {
      f("warning", "exact preview fidelity for remote effects is rarely achievable; prefer estimate or sandbox");
    }
  }
  const ctx: AdapterContext = { principal: "conformance", taskId: "tsk_conformance00", operationId: null, deadline: Date.now() + 1000, signal: AbortSignal.timeout(1000), allowedTargets: [], log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } };
  if (adapter.resourcePrefixes().length === 0) {
    try {
      await adapter.observe({ resource_uri: "none://x/y", cursor: null, max_bytes: 1024 }, ctx);
      findings.push({ action_id: null, severity: "error", message: "observe succeeded without any declared resource prefix" });
    } catch (e) {
      if (!(e instanceof VapError) || e.code !== "CAPABILITY_UNAVAILABLE") findings.push({ action_id: null, severity: "error", message: "unsupported observe must throw CAPABILITY_UNAVAILABLE" });
    }
  }
  return findings;
}
