# Verified Action Protocol (VAP) — v0.1 reference runtime

> **Status: release candidate, not yet published.** Unit, integration, browser, demo, release
> (images, scans, SBOMs, provenance) and image-digest gates have recorded Cloud Build evidence.
> The managed-service staging deployment and the real-GitHub demo are blocked on owner
> prerequisites. See [docs/acceptance.md](docs/acceptance.md) for the live gate status.
> Protocol stability: **experimental (0.1)**. The name "VAP" is provisional.

Agents that call APIs, browsers and command lines get back ambiguous answers. A timeout may
mean "nothing happened" or "it happened and the reply was lost". A 200 can arrive before the
change is visible. A "success" can cover a batch that half-applied. VAP is an execution layer
that keeps these cases apart and lets you inspect them.

| What the agent asked for | What VAP records | Displayed outcome |
|---|---|---|
| a plan was prepared and execution accepted | `queued` | **requested** |
| submission may have reached the destination | `running` | **submitted** |
| the adapter finished, checks not yet passed | `completed` + `pending`/`inconclusive` | **completed_unverified** |
| every named check passed on fresh evidence | `completed` + `passed` | **verified** |
| a known subset of effects happened | `partial` | **partially_applied** |
| VAP cannot establish whether effects happened | `unknown` | **unknown**: reconcile before any retry |

Execution status and verification status are **separate fields**. `outcome` is derived from
them for display and never replaces them ([docs/protocol/outcomes.md](docs/protocol/outcomes.md)).
A completed execution with failed verification is never shown as success.

## What v0.1 provides

- **Protocol**: versioned JSON Schemas (draft 2020-12) for Task, Observation, Action, Plan,
  Operation, Evidence, Grant, Approval and Event; method contracts, error codes with retry
  dispositions, canonical JSON and keyed digests; executable examples validated in CI.
- **Runtime**: authenticated HTTP API, PostgreSQL journal with an outbox, fenced worker claims,
  immutable expiring plans, plan-bound single-use approvals, caller-scoped request keys,
  reconciliation, named-check verification, declared recovery and a sweeper.
- **Adapters**: a configurable JSON **HTTP** adapter (SSRF-guarded, conditional writes,
  destination deduplication with sealed lookups), a bounded **browser** adapter (Playwright,
  reviewed recipes only, explicit vs inferred attribution) and a **registered-command CLI**
  adapter (argument arrays, workspace containment, process-group cleanup, bounded output, never
  answers prompts).
- **Integration**: a TypeScript client and adapter SDK, the `vap` CLI, and a **stdio MCP bridge**
  exposing ordinary tools (`vap_task_open`, `vap_prepare`, `vap_execute`, `vap_verify`,
  `vap_reconcile`, ...).
- **Operations**: a read-only viewer that shows uncertainty first, structured redacted logs,
  metrics, runbooks, a GCP deployment path (Cloud Build, Artifact Registry, Cloud Run service and
  jobs, Cloud SQL, Cloud Scheduler) and teardown.

## What it does not do

No universal undo, no exactly-once remote side effects, no automatic business semantics for
arbitrary APIs, no prompt-injection immunity, no compliance certification, no multi-tenant SaaS,
no arbitrary code sandbox. Cancellation is never rollback. A verifier in the same process is not
organizational or cryptographic independence; evidence records say so.
See [docs/limitations.md](docs/limitations.md).

## Quickstart (cloud)

All builds, tests and demos run in cloud containers. Your workstation only submits work.

Do the setup in [docs/quickstart.md](docs/quickstart.md), section "0. Before you start". It
covers cloning, `gcloud` sign-in, the APIs to enable, permissions and an evidence bucket. Then:

```bash
export VAP_GCP_PROJECT=<project> VAP_GCP_REGION=<region> VAP_EVIDENCE_BUCKET=<bucket>
# run the fixture demo in Cloud Build: verified success, lost reply reconciled without duplication, partial batch
bash scripts/vap-cloud.sh demo
```

`scripts/vap-cloud.sh` needs only `git`, `bash` and `gcloud`. It archives the exact commit and
submits it, so nothing is installed or executed on your workstation. The durable deployment's
`infra/gcp/bootstrap.sh` is not needed for the demo. Excerpt of the receipts from a recorded run
(demo pipeline, commit `49885af`):

```text
2a. Lost reply, before reconciliation (unknown, never shown as success)
operation op_fmWM0SjbezTjVZEOb5lP  outcome=unknown
execution=unknown verification=not_requested recovery=none unresolved=true
  retry guidance: reconcile_first - Effects cannot be established. Reconcile before any retry; if reconciliation cannot resolve it, an operator must.
2b. After reconciliation (found_applied)
operation op_fmWM0SjbezTjVZEOb5lP  outcome=verified
  check owner_matches: pass (source http.issue_tracker:readback version 1)
  destination writes for this request key: 1 (no duplicate)
```

Full steps: [docs/quickstart.md](docs/quickstart.md). Durable deployment (optional, needs
bootstrap): [docs/deployment-gcp.md](docs/deployment-gcp.md).

## Register your own HTTP action (configuration only)

Abridged; the tutorial adds the `lookup` block that lets a lost reply reconcile without
duplication.

```json
{
  "id": "issues.set_status",
  "title": "Set issue status",
  "connector": "issue_tracker",
  "method": "PATCH",
  "path": "/issues/{args.issue_id}",
  "input_schema": { "type": "object", "additionalProperties": false, "required": ["issue_id", "status"],
    "properties": { "issue_id": { "type": "string", "pattern": "^[0-9]{1,18}$" }, "status": { "enum": ["open", "in_progress", "closed"], "type": "string" } } },
  "body_fields": ["status"],
  "effect_scope": { "resource_template": "issue://issue-tracker/issues/{args.issue_id}", "description": "issue status" },
  "side_effects": [{ "id": "status_changed", "description": "issue status updated", "class": "remote_reversible", "bounded": true }],
  "conditional_write": { "resource": "issue://issue-tracker/issues/{args.issue_id}", "mode": "native", "header": "If-Match" },
  "request_key_header": "Idempotency-Key",
  "response": { "projection": ["/id", "/status", "/version"],
    "effects": [{ "side_effect_id": "status_changed", "resource_template": "issue://issue-tracker/issues/{result.id}", "version_pointer": "/version" }] }
}
```

Add a saved-state check to the task and VAP verifies the result by reading it back. The
tutorial [docs/tutorial-custom-http-action.md](docs/tutorial-custom-http-action.md) runs this
action with your configuration in the cloud (`bash scripts/vap-cloud.sh tutorial`).

## Demo: one verified GitHub issue from a failed build, even after a lost reply or a crash

[docs/demo/ci-failure.md](docs/demo/ci-failure.md) shows an agent that turns a failing test into
one verified issue, or stops honestly with "unknown" when the destination cannot be inspected.
It resumes safely after the create's reply is lost and the runtime is killed. Included: a
sanitized transcript from a real cloud run, and a comparison against no-VAP policies
([results](docs/demo/ci-failure-results.md)). That comparison includes a careful client with its
own intent log, which matched VAP's outcomes: VAP is presented as reusable execution
infrastructure, not as the only way to get them.

## Connect an agent through MCP

The bridge runs next to your agent, not on the build workstation. Run it from a built checkout
or from the release image (`docker run -i <image> apps/mcp/dist/main.js`), pointed at a deployed
API:

```bash
VAP_URL=https://<your-vap-api-url> VAP_TOKEN_SOURCE=gcp-metadata VAP_AUDIENCE=https://<your-vap-api-url> node apps/mcp/dist/main.js
```

The bridge is an ordinary stdio MCP server built on the official SDK (`@modelcontextprotocol/sdk`
1.32.1). It holds no authority of its own; operator endpoints are not exposed as tools.
Compatibility is claimed only for the SDK client tested in `tests/mcp`
([docs/mcp.md](docs/mcp.md)).

## Inspect

From an environment with the SDK's `vap` CLI (a built checkout; the npm packages are not
published yet) and access to a deployed API:

```bash
vap operation inspect op_... --evidence --events
vap task inspect tsk_...
```

The read-only viewer is served at `/viewer` with the same authorization as the API.

## Repository map

| Path | Contents |
|---|---|
| `packages/protocol` | JSON Schemas, types, canonical JSON, errors, outcome derivation, examples |
| `packages/core` | policy, plans, lifecycle, reconciliation, verification, coordinator |
| `packages/store-postgres` | migrations, journal, outbox, fenced claims |
| `packages/sdk` | client, token providers, adapter SDK, static conformance, `vap` CLI |
| `packages/adapters` | HTTP, browser, registered-CLI adapters |
| `apps/api`, `apps/worker`, `apps/mcp` | gateway and viewer, dispatcher/sweeper, MCP bridge |
| `fixtures/` | deterministic issue tracker and registered CLI commands |
| `tests/` | unit, conformance (incl. T01–T02), faults (T03–T18), security, browser, MCP, CI-failure demo |
| `benchmarks/` | deterministic baseline-vs-VAP harness and latency runs |
| `infra/gcp`, `scripts/` | Cloud Build pipelines, bootstrap/teardown, hygiene and evidence tools |
| `docs/` | protocol, architecture, operations, ADRs, acceptance matrix |

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). The security model
and threat-model tests are in [docs/security/threat-model.md](docs/security/threat-model.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Commits are signed off (DCO). Tests run in the cloud;
fork pull requests wait for a maintainer to dispatch the exact SHA to the low-privilege test
project. Licensed under [Apache-2.0](LICENSE).
