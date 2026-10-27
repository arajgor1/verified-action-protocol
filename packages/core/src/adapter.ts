import type {
  ActionDescriptor,
  Check,
  Effect,
  Operation,
  Plan,
  Preview,
  RecoveryMode,
  ResourceCondition,
  VapErrorBody,
} from "@verified-action-protocol/protocol";
import type { Logger } from "./log.js";

/**
 * Adapter contract (spec section 10). Methods an adapter does not support must throw
 * VapError("CAPABILITY_UNAVAILABLE", <safe explanation>). The context never carries
 * deployment-admin credentials; connectors inject their own scoped authentication.
 */
export interface AdapterContext {
  principal: string;
  taskId: string;
  operationId: string | null;
  /** Epoch milliseconds after which the adapter must stop and report what it knows. */
  deadline: number;
  signal: AbortSignal;
  /** Resource patterns the grant and task allow. Adapters must not touch anything else. */
  allowedTargets: string[];
  log: Logger;
  /**
   * Destination request key of the operation's latest attempt (set for execute and lookup).
   * Attempt 1 uses the operation id; a resubmission after a sealed, definitive "not found"
   * uses a fresh key so the seal keeps rejecting the original request.
   */
  destinationKey?: string;
}

export interface ObserveQuery {
  resource_uri: string;
  cursor: string | null;
  max_bytes: number;
}

export interface ObserveResult {
  source: string;
  source_version: string | null;
  freshness: "fresh" | "cached" | "unknown";
  facts: Record<string, unknown>;
  unknowns: string[];
  completeness: "complete" | "partial" | "truncated";
  next_cursor?: string | null;
}

export interface PrepareResult {
  canonical_arguments: Record<string, unknown>;
  resource_conditions: ResourceCondition[];
  preview: Preview;
  /** Resources the action may affect; each must be within grant and task scope. */
  affected_resources: string[];
  /** Number of items for batch actions, used to enforce caps before dispatch. */
  item_count: number | null;
  /** Adapter-private data frozen into the plan (e.g. prior state for compensation). */
  frozen?: Record<string, unknown>;
}

export interface ExecuteContext extends AdapterContext {
  operationId: string;
  /** Stable per operation; sent to destinations that support request deduplication. */
  destinationKey: string;
  attempt: number;
  /**
   * Re-checks the worker claim and authorization immediately before submission. Throws
   * if dispatch must not proceed. Adapters call it once, right before the network call.
   */
  recheck(): Promise<void>;
}

export type SubmissionCertainty = "not_submitted" | "maybe_submitted" | "submitted";

export interface AdapterResult {
  outcome: "completed" | "failed" | "partial" | "unknown";
  /** Whether any request could have reached the destination. not_submitted is a definitive claim. */
  submission: SubmissionCertainty;
  effects: Effect[];
  result_summary: Record<string, unknown> | null;
  external_handle: string | null;
  error?: VapErrorBody | null;
  /** Redacted, bounded diagnostics (e.g. HTTP status, parse status, linked network events). */
  diagnostics?: Record<string, unknown>;
}

export interface LookupResult {
  status: "applied" | "partial" | "not_applied" | "unknown";
  /** True only when the destination guarantees the answer (e.g. sealed idempotency lookup). */
  definitive: boolean;
  /** The destination received the request and rejected it (never resubmit automatically). */
  destination_rejected?: boolean;
  effects: Effect[];
  result_summary: Record<string, unknown> | null;
  external_handle: string | null;
  observations: Record<string, unknown>[];
}

export interface VerifyContext extends AdapterContext {
  operation: Operation;
  plan: Plan;
  /** Fully expanded resource URI the check targets. */
  target: string;
  /** Minimum destination version the operation reported for this target, if known. */
  expectedVersion: string | null;
}

/** One authoritative read for a check. The core evaluates the predicate, never the adapter. */
export interface VerifyObservation {
  facts: Record<string, unknown>;
  source: string;
  source_version: string | null;
  freshness: "fresh" | "stale" | "unknown";
  method: "read_back" | "test" | "assertion" | "trace";
  limitations: string[];
  artifact?: { content: string; media_type: string } | null;
}

export interface RecoveryPlanSpec {
  action_id: string;
  arguments: Record<string, unknown>;
  /** Effects of the original operation this recovery addresses. */
  covered_effects: Effect[];
  /** Effects that cannot be reversed by this strategy (e.g. a delivered notification). */
  uncovered_effects: string[];
  /** Checks that establish the post-recovery state. Required. */
  checks: Check[];
}

export interface Adapter {
  readonly id: string;
  readonly version: string;
  readonly provenance: "built_in" | "operator_configured";
  manifest(): ActionDescriptor[];
  /** Resource URI prefixes (scheme://authority/) this adapter resolves for observe and verify. */
  resourcePrefixes(): string[];
  verifierIds(): string[];
  observe(query: ObserveQuery, ctx: AdapterContext): Promise<ObserveResult>;
  prepare(action: ActionDescriptor, args: Record<string, unknown>, ctx: AdapterContext): Promise<PrepareResult>;
  execute(plan: Plan, ctx: ExecuteContext): Promise<AdapterResult>;
  lookup(operation: Operation, plan: Plan, ctx: AdapterContext): Promise<LookupResult>;
  verify(check: Check, ctx: VerifyContext): Promise<VerifyObservation>;
  recover(operation: Operation, plan: Plan, strategy: RecoveryMode, ctx: AdapterContext): Promise<RecoveryPlanSpec>;
  /** Releases browser contexts, process groups, sockets. */
  close?(): Promise<void>;
}
