// TypeScript shapes for the canonical objects. JSON Schema in ../schemas is the source of
// truth; these declarations are kept in lockstep by tests/unit/schema-drift.test.ts and by
// validating every runtime payload against the schemas (see ADR-0003).

import type {
  CheckMethod,
  CheckResult,
  EffectStatus,
  ErrorCode,
  EventType,
  ExecutionStatus,
  Outcome,
  PlanStatus,
  PredicateOp,
  PreviewFidelity,
  RecoveryMode,
  RecoveryStatus,
  RetryDisposition,
  SideEffectClass,
  VerificationStatus,
} from "./enums.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type RiskTier = 0 | 1 | 2 | 3;
export type Extensions = Record<string, unknown>;

export interface Predicate {
  op: PredicateOp;
  path?: string;
  value?: unknown;
  values?: unknown[];
  min?: number;
  max?: number;
  predicates?: Predicate[];
}

export interface Check {
  id: string;
  description?: string;
  method: CheckMethod;
  verifier_id: string;
  target: string;
  predicate: Predicate;
  scope?: "single" | "each_effect";
  freshness: { max_age_seconds: number };
  deadline_seconds: number;
  authorization_scope?: string | null;
  provenance?: "user" | "operator" | "agent" | "action_default";
}

export interface CapabilityVector {
  state_source: "authoritative_api" | "eventually_consistent_api" | "dom" | "filesystem" | "process" | "unavailable";
  concurrency_mode: "native_conditional" | "best_effort" | "none" | "unavailable";
  preview_fidelity: PreviewFidelity;
  retry_mode: "destination_dedup" | "lookup_then_retry" | "no_automatic_retry" | "unavailable";
  recovery_modes: RecoveryMode[];
  verification_methods: CheckMethod[];
  attribution_mode: "explicit_request_id" | "temporal_inference" | "process_identity" | "none";
  execution_isolation: "none" | "browser_context" | "workspace_directory" | "process_group";
}

export interface SideEffect {
  id: string;
  description: string;
  class: SideEffectClass;
  bounded: boolean;
}

export interface Effect {
  side_effect_id: string;
  item_index?: number | null;
  resource_uri?: string | null;
  status: EffectStatus;
  source_version?: string | null;
  detail?: string | null;
}

export interface VapErrorBody {
  code: ErrorCode;
  message: string;
  retry_disposition: RetryDisposition;
  operation_id?: string | null;
  details?: Record<string, unknown>;
  evidence_refs?: string[];
}

export interface Statement {
  id: string;
  text: string;
  provenance: "user" | "operator" | "agent" | "policy";
}

export interface TaskScope {
  actions: string[];
  resources: string[];
}

export interface Task {
  protocol_version: "0.1";
  id: string;
  contract_revision: number;
  goal: string;
  owner: string;
  grant_id: string;
  scope: TaskScope;
  requirements: Statement[];
  assumptions: Statement[];
  required_checks: Check[];
  created_at: string;
  revised_at: string;
  extensions?: Extensions;
}

export interface Observation {
  protocol_version: "0.1";
  id: string;
  resource_uri: string;
  observed_at: string;
  source: string;
  source_version: string | null;
  freshness: "fresh" | "cached" | "unknown";
  facts: Record<string, unknown>;
  unknowns: string[];
  completeness: "complete" | "partial" | "truncated";
  limits: { bytes: number; max_bytes: number; estimated_tokens: number; truncated: boolean };
  next_cursor: string | null;
  extensions?: Extensions;
}

export interface AdapterRef {
  id: string;
  version: string;
}

export interface RecoveryModeDescriptor {
  mode: RecoveryMode;
  action_id: string | null;
  description: string;
}

export interface ActionDescriptor {
  protocol_version: "0.1";
  id: string;
  title: string;
  description?: string;
  adapter: AdapterRef;
  input_schema: Record<string, unknown>;
  effect_scope: { resource_template: string; description: string };
  preconditions: string[];
  side_effects: SideEffect[];
  risk_tier: RiskTier;
  capabilities: CapabilityVector;
  verifier_ids: string[];
  recovery_modes: RecoveryModeDescriptor[];
  plan_ttl_seconds: number;
  limits?: { max_items?: number | null };
  extensions?: Extensions;
}

export interface ResourceCondition {
  resource_uri: string;
  expected_version: string | null;
  enforcement: "native" | "best_effort" | "none";
}

export interface Preview {
  fidelity: PreviewFidelity;
  summary: string;
  effects: { side_effect_id: string; class: SideEffectClass; description: string; item_count: number | null }[];
}

export type ApprovalState = "not_required" | "pending" | "approved" | "denied" | "expired" | "consumed";

export interface Plan {
  protocol_version: "0.1";
  id: string;
  task_id: string;
  task_revision: number;
  action_id: string;
  adapter: AdapterRef;
  principal: string;
  grant_id: string;
  canonical_arguments: Record<string, unknown>;
  resource_conditions: ResourceCondition[];
  preview: Preview;
  risk_tier: RiskTier;
  required_checks: Check[];
  policy_revision: string;
  grant_revocation_revision: number;
  digest: string;
  created_at: string;
  expires_at: string;
  status: PlanStatus;
  status_reasons?: string[];
  approval: { required: boolean; reason: string | null; state: ApprovalState; approval_id: string | null };
  recovery_of: string | null;
  extensions?: Extensions;
}

export interface Operation {
  protocol_version: "0.1";
  id: string;
  plan_id: string;
  task_id: string;
  action_id: string;
  principal: string;
  request_key_digest: string;
  execution_status: ExecutionStatus;
  verification_status: VerificationStatus;
  recovery_status: RecoveryStatus;
  outcome: Outcome;
  result_summary: Record<string, unknown> | null;
  effects: Effect[];
  attempts: number;
  external_handle: string | null;
  cancel_requested: boolean;
  recovers_operation_id: string | null;
  recovery_operation_ids: string[];
  unresolved: boolean;
  error: VapErrorBody | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  completed_at: string | null;
  row_revision: number;
  extensions?: Extensions;
}

export interface ArtifactRef {
  digest: string;
  object_id: string;
  bytes: number;
}

export interface Evidence {
  protocol_version: "0.1";
  id: string;
  operation_id: string;
  task_id: string;
  task_revision: number;
  check_id: string;
  item_index: number | null;
  verifier_id: string;
  verifier_version: string;
  method: CheckMethod;
  observed_at: string;
  result: CheckResult;
  source: string;
  source_version: string | null;
  freshness: "fresh" | "stale" | "unknown";
  observed_facts: Record<string, unknown>;
  artifact_ref: ArtifactRef | null;
  limitations: string[];
  attributed_to: string | null;
  independence: "same_process" | "separate_process" | "human";
  created_at: string;
  extensions?: Extensions;
}

export interface GrantLimits {
  max_operations: number | null;
  max_items_per_operation: number | null;
  max_concurrent_operations: number | null;
}

export interface Grant {
  protocol_version: "0.1";
  id: string;
  principal: string;
  allowed_actions: string[];
  allowed_targets: string[];
  risk_ceiling: RiskTier;
  preauthorized_actions: string[];
  limits: GrantLimits;
  expires_at: string;
  revocation_revision: number;
  revoked_at: string | null;
  issuer: string;
  created_at: string;
  extensions?: Extensions;
}

export interface Approval {
  protocol_version: "0.1";
  id: string;
  plan_id: string;
  plan_digest: string;
  decision: "approved" | "denied";
  approver: string;
  approved_scope: { action_id: string; risk_tier: RiskTier; resource_uris: string[] };
  created_at: string;
  expires_at: string;
  single_use: true;
  consumed_by_operation_id: string | null;
  note: string | null;
}

export interface OperationEvent {
  protocol_version: "0.1";
  operation_id: string;
  sequence: number;
  type: EventType;
  at: string;
  actor: string;
  data: Record<string, unknown>;
}

export interface ReceiptCheck {
  id: string;
  result: CheckResult | "missing";
  method: CheckMethod | null;
  source: string | null;
  source_version: string | null;
  evidence_id: string | null;
  observed_at: string | null;
  item_index: number | null;
}

export interface Receipt {
  protocol_version: "0.1";
  operation_id: string;
  task_id: string;
  action_id: string;
  outcome: Outcome;
  execution_status: ExecutionStatus;
  verification_status: VerificationStatus;
  recovery_status: RecoveryStatus;
  unresolved: boolean;
  effects: Effect[];
  checks: ReceiptCheck[];
  unverified_effects: string[];
  recovery: { modes: RecoveryMode[]; available: boolean; status: RecoveryStatus; recovery_operation_ids: string[] };
  retry_guidance: { disposition: RetryDisposition; explanation: string };
  generated_at: string;
}

export interface TaskOutcomeCheck {
  check_id: string;
  status: "pass" | "fail" | "inconclusive" | "missing" | "stale";
  evidence_id: string | null;
  observed_at: string | null;
  operation_id: string | null;
}

export interface TaskOutcome {
  protocol_version: "0.1";
  task_id: string;
  contract_revision: number;
  verified_complete: boolean;
  reasons: string[];
  checks: TaskOutcomeCheck[];
  unresolved_operations: string[];
  evaluated_at: string;
}

export interface ActionListEntry {
  action: ActionDescriptor;
  permitted: boolean;
  requires_approval: boolean;
  blockers: string[];
}

export interface InfoResponse {
  protocol_version: "0.1";
  api_version: "v1";
  supported_protocol_versions: string[];
  build: { version: string; commit: string | null; image_digest: string | null };
  auth_mode: "oidc" | "demo";
  adapters: {
    id: string;
    version: string;
    provenance: "built_in" | "operator_configured";
    actions: { id: string; risk_tier: RiskTier; capabilities: CapabilityVector; declared_profiles: ("core" | "verified" | "recoverable")[] }[];
  }[];
  limits: {
    max_request_bytes: number;
    max_observation_bytes: number;
    default_plan_ttl_seconds: number;
    request_key_retention_seconds: number;
  };
}

export type ReconcileResolution =
  | "already_final"
  | "found_applied"
  | "found_partial"
  | "definitive_not_applied"
  | "resubmitted_with_dedup"
  | "still_unknown"
  | "operator_resolution_required"
  | "in_progress";

// Request bodies
export interface TaskCreateRequest {
  protocol_version: "0.1";
  goal: string;
  grant_id: string;
  scope: TaskScope;
  requirements?: Statement[];
  assumptions?: Statement[];
  required_checks: Check[];
  extensions?: Extensions;
}

export interface TaskReviseRequest {
  protocol_version: "0.1";
  expected_revision: number;
  goal?: string;
  requirements?: Statement[];
  assumptions?: Statement[];
  required_checks?: Check[];
}

export interface ObservationRequest {
  protocol_version: "0.1";
  task_id: string;
  resource_uri: string;
  cursor?: string | null;
  max_bytes?: number;
}

export interface PlanCreateRequest {
  protocol_version: "0.1";
  task_id: string;
  action_id: string;
  arguments: Record<string, unknown>;
  check_ids?: string[];
}

export interface OperationCreateRequest {
  protocol_version: "0.1";
  plan_id: string;
  request_key: string;
}

export interface GrantCreateRequest {
  protocol_version: "0.1";
  principal: string;
  allowed_actions: string[];
  allowed_targets: string[];
  risk_ceiling: RiskTier;
  preauthorized_actions?: string[];
  limits?: GrantLimits;
  expires_at: string;
}

export interface ApprovalCreateRequest {
  protocol_version: "0.1";
  plan_id: string;
  plan_digest: string;
  decision: "approved" | "denied";
  expires_in_seconds?: number;
  note?: string;
}

export interface RecoverRequest {
  protocol_version: "0.1";
  strategy: RecoveryMode;
  request_key: string;
}

export interface OperatorResolutionRequest {
  protocol_version: "0.1";
  execution_status: "completed" | "failed" | "partial";
  effects?: Effect[];
  note: string;
}

export interface HumanEvidenceRequest {
  protocol_version: "0.1";
  operation_id: string;
  check_id: string;
  result: CheckResult;
  note: string;
}
