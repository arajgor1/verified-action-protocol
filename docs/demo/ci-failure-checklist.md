# CI-failure demo: requirement-to-test checklist

Workflow: run the repository's tests in the cloud; if a test fails, create one GitHub issue with
the failing test, commit SHA, reproduction steps and sanitized error output; verify the issue
exists and contains that information; resume safely after interruption.

Status: PASS = observed in a recorded Cloud Build run on release candidate `8833feb` (see
[../release/candidate-evidence.md](../release/candidate-evidence.md)); BLOCKED = needs an owner prerequisite; IMPLEMENTED = code
exists, not executed.

## Existing pieces reused

| Capability | Where | Reused as |
|---|---|---|
| Durable operation + dispatch intent before every call | `packages/core/src/coordinator.ts` (`dispatch`, `executeAttempt`) | unchanged |
| Request-key replay / key-reuse conflict | `submitOperation` | unchanged; plus lookup by key (new) |
| Reconciliation with fenced claims, sweeper for dead workers | `reconcileWithFence`, `sweep` | unchanged except API attempt budget |
| Read-back verification with freshness | `evaluateTarget` | unchanged |
| Tier-3 plan-bound approvals | policy + approvals | unchanged |
| SSRF-guarded HTTP client | `packages/adapters/src/net.ts` | used by the GitHub adapter |
| Redaction (canaries, token shapes) | `packages/core/src/redact.ts` | error-output sanitization |
| Fixture with separate database and control listener | `fixtures/issue-tracker` | extended with a GitHub-compatible `/gh` API |
| Cloud test pipeline, disposable PostgreSQL | `infra/gcp/cloudbuild.test.yaml` | new `demo` suite |

## Added (minimum missing pieces)

| Gap | Added |
|---|---|
| No GitHub destination | `packages/adapters/src/github-adapter.ts` (marker, marker-scan lookup, read-back checks, GitHub App auth) |
| A restarted agent could not find its operation (re-preparing creates a new plan, which conflicts under the old key) | `POST /v1/operations/lookup`, SDK `findOperation`, MCP `vap_operation_find` |
| API reconcile escalated to an operator on the first "not visible yet" | stays `still_unknown` until `VAP_MAX_RECONCILE_ATTEMPTS`; escalates at once only when the action has no lookup |
| Lease and reconcile budget not configurable | `VAP_CLAIM_LEASE_MS`, `VAP_MAX_RECONCILE_ATTEMPTS` |
| No fault injection between client and a real API | `demo/ci-failure/lib/fault-proxy.ts` (test-only) |

## Requirements

| # | Requirement | Test / evidence | Status |
|---|---|---|---|
| R1 | Tests run in the cloud; the failure is observed with its output | `observations` describe in `tests/demo/ci-failure.test.ts`; every scenario run calls `runTests` | PASS (`e85838d0`, `6891ab9b`) |
| R2 | Unique, stable workflow id from repository, commit, build event, task; restart does not create a new logical id | "workflow identity is stable..."; S3/S9 resume by request key; demo transcript | PASS (`e85838d0`, `6891ab9b`) |
| R3 | Issue contains failing test, commit SHA, reproduction steps, sanitized error output; no secret | `issue.content` check; evaluator `issueContentValid`; canary assertion | PASS (`e85838d0`, `6891ab9b`) |
| R4 | Verification reads saved destination state, not the journal | "verification reads the destination, not the journal" (edit at destination makes re-verify fail) | PASS (`e85838d0`, `6891ab9b`) |
| R5 | Operation and dispatch intent persisted before the mutation | "normal" test: `dispatch.intent` event time <= proxy receive time | PASS (`e85838d0`, `6891ab9b`) |
| R6 | Response lost after committed create: reconcile before any further mutation, no second create | contract "response lost..."; S2 | PASS (`e85838d0`, `6891ab9b`) |
| R7 | Delayed visibility: not found is not failure; stays unknown; later found | contract "delayed visibility..."; S8 | PASS (`e85838d0`, `6891ab9b`) |
| R8 | Request rejection: failed, no retry, no issue | contract "destination rejection..."; S6 | PASS (`e85838d0`, `6891ab9b`) |
| R9 | Runtime crash after submission: resume with the same operation id | S3, S9 (real child processes, SIGKILL while the reply is held); demo transcript | PASS (`e85838d0`, `6891ab9b`) |
| R10 | Duplicate submission: same key returns the existing operation | contract "duplicate submission..."; S4 (two concurrent agents) | PASS (`e85838d0`, `6891ab9b`) |
| R11 | Changed payload with same key: rejected, no destination call | contract "changed payload..." (proxy create count unchanged); S5 | PASS (`e85838d0`, `6891ab9b`) |
| R12 | Reconciliation unavailable: stays unknown, escalates, no blind create | contract "reconciliation unavailable..."; S7 | PASS (`e85838d0`, `6891ab9b`) |
| R13 | Destination state separate from the journal | fixture database is separate; evaluator reads fixture ground truth | PASS (`e85838d0`, `6891ab9b`) |
| R14 | Fault injector: forwards, receives acceptance, drops; private ground truth; same schedule for all conditions; not in production; no auth headers stored | `fault-proxy.ts`; `.dockerignore` / allowlist; scenario runner uses one schedule per scenario | PASS (`e85838d0`, `6891ab9b`) |
| R15 | Comparison: >=5 runs per scenario per condition, judged by destination inspection + ground truth | `benchmarks/ci-demo/run.ts` | PASS (`e85838d0`, `6891ab9b`) |
| R16 | Model conditions A/B/C | not implemented; needs model access and a spending limit | BLOCKED |
| R17 | Real GitHub (Layer B) bounded set | `demo/ci-failure/run-github.ts`, `infra/gcp/cloudbuild.demo-github.yaml` | BLOCKED (owner repo + GitHub App + authorization) |
| R19 | Attribution: expected repository + authenticated app identity + workflow id + planned content + created after acceptance; existence reported separately from origin; another actor's identical issue never resolves the operation | contract tests "attribution: ..." (3 tests); e2e origin assertions | PASS (`e85838d0`) |
| R20 | Approvals consistent across conditions (one scripted approval per planned create); human latency excluded | `AgentEnv.approve`; results report | PASS (`e85838d0`) |
| R21 | No local execution fallback | `scripts/cloud-guard.ts`; docs/process-deviations.md | PASS (`e85838d0`) |
| R18 | Cleanup procedure, resources recorded | `docs/demo/ci-failure-cleanup.md`, `github-resources.json`, `cleanup-github.ts` | IMPLEMENTED |
