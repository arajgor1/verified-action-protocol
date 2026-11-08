# VAP 0.1 protocol overview

JSON Schema (draft 2020-12, `packages/protocol/schemas`) is the source of truth. Schemas use the
reserved, non-resolvable `https://schemas.vap.invalid/0.1/` identifier namespace and ship with
the package; they are never fetched. Every example in `packages/protocol/examples` validates in
CI (`*.invalid-*.json` files are negative examples that must fail).

## Objects

| Object | Purpose | Key rules |
|---|---|---|
| Task | goal, grant, scope, requirements, assumptions, required checks | checks are immutable per `contract_revision`; changes create a new revision and stale older plans; agents can add checks (provenance `agent`) but cannot weaken user or operator checks |
| Observation | read state through a registered adapter | `source_version` is the destination's (explicit null when absent); `freshness`, `unknowns`, `completeness`; facts are untrusted data and byte-bounded (default 64 KiB) |
| Action | registered adapter operation | `input_schema`, side effects with classes, risk tier (strictest side effect), per-action capability vector, verifiers, recovery modes |
| Plan | immutable, expiring preparation | canonical arguments, resource conditions (`native`/`best_effort`/`none` enforcement), preview with fidelity, bound checks, policy revision, keyed digest |
| Operation | durably accepted execution | separate execution/verification/recovery status, effects, attempts, request-key digest |
| Evidence | one evaluated check (or batch item) | method, verifier version, source and version, freshness, result, limitations, independence |
| Grant | operator-issued authority | action/target patterns, risk ceiling, preauthorized tier-2 actions, limits, expiry, revocation revision |
| Approval | plan-bound decision | exact plan digest, approver from authentication, single use, expiry |
| Event | append-only journal entry | `(operation_id, sequence)` unique and monotonic |

## Wire rules

- UTC ISO 8601 timestamps; opaque string ids (`<prefix>_<base62>`); explicit `null` for
  unavailable versions; `protocol_version: "0.1"` on every body.
- Request bodies reject unknown fields. Principal, approver and issuer always come from
  authentication, never from a body.
- Extensions live under `extensions` with reverse-DNS keys; they never alter security semantics.
- Request bodies are capped at 256 KiB. Observation facts default to 64 KiB with truncation
  reported in `unknowns` and `limits`. Token counts are estimates (bytes/4).
- Resource URIs identify application objects and resolve only through registered adapters;
  they are never permissions or fetch URLs.
- Clients reject unsupported protocol majors (`UNSUPPORTED_PROTOCOL_VERSION`).

## Methods

| HTTP | MCP tool | Result |
|---|---|---|
| `POST /v1/tasks` | `vap_task_open` | Task (revision 1) |
| `POST /v1/tasks/{id}/revisions` | — | new contract revision |
| `GET /v1/tasks/{id}/outcome` | `vap_task_outcome` | verified completion evaluation |
| `POST /v1/observations` | `vap_observe` | Observation |
| `GET /v1/actions?task_id=` | `vap_actions_list` | descriptors with `permitted`, `requires_approval`, `blockers` |
| `POST /v1/plans` | `vap_prepare` | immutable Plan (201) |
| `GET /v1/plans/{id}` | — | Plan with evaluated status and approval state |
| `POST /v1/operations` | `vap_execute` | 202 Operation; 200 with `idempotent-replay: true` for repeats |
| `POST /v1/operations/lookup` | `vap_operation_find` | the caller's Operation for (action, request key), or 404 |
| `GET /v1/operations/{id}` | `vap_operation_get` | Operation |
| `GET /v1/operations/{id}/receipt` | `vap_operation_get` (`include_receipt`) | Receipt |
| `GET /v1/operations/{id}/evidence` | — | Evidence list |
| `POST /v1/operations/{id}/verify` | `vap_verify` | Operation and new evidence |
| `POST /v1/operations/{id}/reconcile` | `vap_reconcile` | resolution and observations |
| `POST /v1/operations/{id}/recover` | `vap_recover` | recovery plan and separate recovery operation |
| `POST /v1/operations/{id}/cancel` | `vap_cancel` | cancellation requested; never rollback |
| `GET /v1/operations/{id}/events?after=&limit=` | `vap_events_list` | event page with sequence cursor |
| `GET /v1/info` | `vap_info` | protocol, build, adapters and capabilities |

Operator-only (never agent tools): `POST /v1/operator/grants`, `/grants/{id}/revoke`,
`/approvals`, `/principals`, `/evidence` (human judgment), `/operations/{id}/resolve`, `/sweep`.
Read helpers: `GET /v1/grants`, `GET /v1/approvals/pending`, `/metrics`, `/viewer`.
`/healthz` and `/readyz` reveal no secrets or records.

## Errors

`{ "protocol_version": "0.1", "error": { "code", "message", "retry_disposition", "operation_id", "details", "evidence_refs" } }`

| Code | HTTP | Default retry disposition |
|---|---|---|
| INVALID_ARGUMENT | 400 | fix_request |
| UNAUTHORIZED | 401 | fix_request |
| FORBIDDEN | 403 | do_not_retry |
| NOT_FOUND | 404 | do_not_retry |
| STALE_PLAN | 409 | fix_request |
| PLAN_EXPIRED | 409 | fix_request |
| APPROVAL_REQUIRED | 403 | retry_with_same_key |
| KEY_REUSE_CONFLICT | 409 | fix_request |
| REQUEST_KEY_EXPIRED | 409 | reconcile_first |
| LIMIT_EXCEEDED | 413/429 | fix_request |
| CAPABILITY_UNAVAILABLE | 501 | do_not_retry |
| DESTINATION_UNAVAILABLE | 503 | reconcile_first |
| OUTCOME_UNKNOWN | 409 | reconcile_first |
| CONFLICT | 409 | fix_request |
| UNSUPPORTED_PROTOCOL_VERSION | 400 | fix_request |
| UNAVAILABLE | 503 | retry_with_same_key |
| INTERNAL | 500 | retry_with_same_key |

## Request identity

A request key is scoped to deployment, authenticated principal and action, and stored only as a
keyed digest. One logical operation exists per key (unique constraint). The stored request
digest binds the plan: identical repeats return the original operation, a different plan
conflicts, and a plan executes at most once. After the retention window keys expire visibly
(`REQUEST_KEY_EXPIRED`) instead of silently allowing a duplicate.
