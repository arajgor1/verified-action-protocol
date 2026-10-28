# Changelog

All notable changes are recorded here. The protocol is experimental until 1.0.

## 0.1.0-rc.1 (experimental)

### Added
- Docker Compose quickstart (`examples/quickstart`): runtime, worker, PostgreSQL and the synthetic
  issue tracker from the release image, with a recovery demo and an SDK connect example
  (`examples/connect`); a fresh-environment cloud check (`vap-cloud.sh quickstart`).
- Supported Docker deployment guide; publication pipeline with a dry-run default
  (`vap-cloud.sh publish`).
- Protocol 0.1: JSON Schemas for Task, Observation, Action, Plan, Operation, Evidence, Grant,
  Approval, Event and all request/response messages; canonical JSON; keyed digests; error codes
  with retry dispositions; outcome derivation; executable and negative examples.
- Runtime: HTTP API (`/v1`), PostgreSQL journal with immutable plans, append-only events and
  evidence, outbox, fenced worker claims, request-key tombstones, retention.
- Coordinator: grants and task scope, plan preparation, plan-bound single-use approvals,
  durable acceptance, dispatch revalidation, reconciliation with sealed destination lookups,
  named-check verification with freshness, recovery as separate operations, cancellation,
  operator resolution, human-judgment evidence, sweeper.
- Adapters: declarative HTTP (SSRF-guarded), Playwright browser recipes, registered-command CLI.
- Fixtures: deterministic issue tracker with fault controls; CLI commands.
- Integration: TypeScript client and adapter SDK, `vap` CLI, `scripts/vap-cloud.sh`, stdio MCP bridge.
- Operations: read-only viewer, metrics, structured redacted logs, runbooks.
- Cloud: Cloud Build pipelines (test, demo, release, deploy, cleanup, lock), GCP bootstrap and
  teardown, keyless GitHub dispatch workflow.
- Tests: unit, conformance, faults T01–T18, security, browser, MCP; deterministic benchmark.

### Known gaps
- No cloud run has been recorded for this candidate; all cloud gates are BLOCKED pending
  operator authorization of cloud execution. See docs/acceptance.md.
