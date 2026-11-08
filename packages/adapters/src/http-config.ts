import type { Check, SideEffect } from "@verified-action-protocol/protocol";

/**
 * Declarative HTTP adapter configuration. Mappings are data, not executable templates:
 * the only substitution is {args.x}/{result.x}/{prior.x}/{item.x}/{request.key} into
 * operator-written paths and resource URIs, with URI-safe values only.
 */
export interface HttpAdapterConfig {
  id: string;
  version: string;
  /** Verifier id this adapter provides for saved-state readback checks. */
  verifier_id?: string;
  connectors: Record<string, HttpConnectorConfig>;
  resources: HttpResourceConfig[];
  actions: HttpActionConfig[];
}

export interface HttpConnectorConfig {
  origin: string;
  timeout_ms?: number;
  max_response_bytes?: number;
  /** Honoured only in isolated test mode, for synthetic fixture destinations. */
  allow_private_network?: boolean;
  auth?: { type: "none" } | { type: "bearer_env"; env: string } | { type: "header_env"; header: string; env: string };
}

export interface HttpResourceConfig {
  /** e.g. "issue://issue-tracker/issues/{id}". Placeholder values are captured from the URI. */
  uri_template: string;
  connector: string;
  /** Path template using {args.<uri placeholder>}. */
  read_path: string;
  version: { header?: string; pointer?: string };
  /** JSON pointers copied into facts; everything else is dropped (field allowlist). */
  projection: string[];
  state_source?: "authoritative_api" | "eventually_consistent_api";
}

export type ArgSource =
  | { from: "args"; field: string }
  | { from: "prior"; pointer: string }
  | { from: "result"; field: string }
  | { from: "applied_items"; field: string }
  | { from: "const"; value: unknown };

export interface HttpEffectMapping {
  side_effect_id: string;
  /** Single-resource effect, e.g. "issue://issue-tracker/issues/{result.id}". */
  resource_template?: string;
  version_pointer?: string;
  /** Batch effects: array of per-item results in the response body. */
  items_pointer?: string;
  item_status_pointer?: string;
  item_applied_values?: string[];
  item_resource_template?: string;
  item_version_pointer?: string;
}

export interface HttpActionConfig {
  id: string;
  title: string;
  description?: string;
  connector: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path template using {args.x} only. */
  path: string;
  input_schema: Record<string, unknown>;
  /** Argument fields copied into the JSON body. Nothing else is sent. */
  body_fields: string[];
  /** For batch actions: the argument field holding the item array (bounds item_count). */
  items_field?: string;
  max_items?: number;
  effect_scope: { resource_template: string; description: string };
  side_effects: SideEffect[];
  risk_tier?: 0 | 1 | 2 | 3;
  conditional_write?: {
    /** Resource read at prepare time, e.g. "issue://issue-tracker/issues/{args.issue_id}". */
    resource: string;
    mode: "native" | "best_effort";
    /** Header carrying the expected version in native mode, e.g. If-Match. */
    header?: string;
  };
  /** Header carrying the stable per-operation destination key (destination deduplication). */
  request_key_header?: string;
  lookup?: {
    /** e.g. "/requests/{request.key}" */
    path: string;
    query?: Record<string, string>;
    /** True only when the destination seals the key on lookup so "not found" is final. */
    definitive_not_found: boolean;
    status_pointer: string;
    applied_values: string[];
    partial_values?: string[];
    /** Destination statuses meaning the request was received and definitively not applied. */
    rejected_values?: string[];
    /** Pointer to the original response body inside the lookup response. */
    response_pointer?: string;
  };
  response: {
    projection: string[];
    effects: HttpEffectMapping[];
  };
  verifiers?: string[];
  recovery?: {
    mode: "compensate";
    action_id: string;
    arguments: Record<string, ArgSource>;
    uncovered_effects: string[];
    checks: RecoveryCheckTemplate[];
    description: string;
  }[];
  plan_ttl_seconds?: number;
  timeout_ms?: number;
  preconditions?: string[];
}

/** A check whose predicate value may come from frozen prior state. */
export type RecoveryCheckTemplate = Omit<Check, "predicate"> & {
  predicate: Check["predicate"] & { value_from?: ArgSource };
};

export const HTTP_CONFIG_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["id", "version", "connectors", "resources", "actions"],
  properties: {
    id: { type: "string", pattern: "^[a-z][a-z0-9_.-]{0,63}$" },
    version: { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$" },
    verifier_id: { type: "string", pattern: "^[a-z][a-z0-9_.-]{0,63}$" },
    connectors: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["origin"],
        properties: {
          origin: { type: "string", maxLength: 512 },
          timeout_ms: { type: "integer", minimum: 100, maximum: 900000 },
          max_response_bytes: { type: "integer", minimum: 1024, maximum: 16777216 },
          allow_private_network: { type: "boolean" },
          auth: {
            type: "object",
            required: ["type"],
            properties: {
              type: { enum: ["none", "bearer_env", "header_env"] },
              env: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
              header: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9-]{0,63}$" },
            },
            additionalProperties: false,
          },
        },
      },
    },
    resources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["uri_template", "connector", "read_path", "version", "projection"],
        properties: {
          uri_template: { type: "string", maxLength: 512 },
          connector: { type: "string" },
          read_path: { type: "string", pattern: "^/" },
          version: {
            type: "object",
            additionalProperties: false,
            properties: { header: { type: "string" }, pointer: { type: "string" } },
          },
          projection: { type: "array", items: { type: "string", pattern: "^(/[^/]+)+$" } },
          state_source: { enum: ["authoritative_api", "eventually_consistent_api"] },
        },
      },
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title", "connector", "method", "path", "input_schema", "body_fields", "effect_scope", "side_effects", "response"],
        // Ajv strict mode (strictRequired) needs every required key declared. Deeper structure is
        // validated by the action descriptor schema when the registry registers the adapter.
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          connector: { type: "string" },
          method: { enum: ["POST", "PUT", "PATCH", "DELETE"] },
          path: { type: "string", pattern: "^/" },
          input_schema: { type: "object" },
          body_fields: { type: "array", items: { type: "string" } },
          effect_scope: { type: "object" },
          side_effects: { type: "array" },
          response: { type: "object" },
        },
      },
    },
  },
};
