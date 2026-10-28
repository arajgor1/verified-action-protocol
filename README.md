# Verified Action Protocol (VAP) — v0.1 reference runtime

> **Status: experimental release 0.1.0-rc.1.** The protocol (0.1) and the APIs may change. The
> supported scope is the core runtime, the HTTP and registered-command adapters, the SDK and the
> MCP bridge, deployed as containers. The browser adapter, the managed Google Cloud deployment
> and real-GitHub use are not part of the supported release ([Limitations](#limitations)).

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

## Try VAP

You need Docker with Compose v2 and an internet connection. Nothing else: no build, and no
GitHub, model or cloud account.

```bash
git clone https://github.com/arajgor1/verified-action-protocol.git && cd verified-action-protocol
docker compose -f examples/quickstart/compose.yaml run --rm demo
```

This pulls the release image (`ghcr.io/arajgor1/verified-action-protocol@sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849`) and PostgreSQL 17, starts the runtime, a worker and a
synthetic issue tracker, and runs [`examples/quickstart/demo.mjs`](examples/quickstart/demo.mjs):

1. **Verified success:** an issue is reassigned under a conditional write; the owner check passes
   on a fresh read-back; repeating the request key returns the original operation.
2. **Dropped response:** the issue tracker commits a create but the reply never arrives. VAP
   reports `unknown` with `reconcile_first`, not success. Reconciliation finds the write through a
   request-key lookup, verification passes, and the tracker shows exactly one write.
3. **Partial batch:** two of four creates apply. The receipt lists the per-item effects and the
   failed aggregate check; compensation then closes exactly those two, as a separate operation.

Excerpt of scenario 2 from the fresh-environment check (Cloud Build `44bd2c7e`):

```text
2a. Dropped response, before reconciliation (unknown, never shown as success)
operation op_B3ph6s2xvajhETo4Cbpq  outcome=unknown
execution=unknown verification=not_requested recovery=none unresolved=true
  effect issue_created: unknown
  retry guidance: reconcile_first - Effects cannot be established. Reconcile before any retry; if reconciliation cannot resolve it, an operator must.
2b. After reconciliation (found_applied)
operation op_B3ph6s2xvajhETo4Cbpq  outcome=verified
execution=completed verification=passed recovery=none unresolved=false
  check owner_matches: pass (source http.issue_tracker:readback version 1)
  effect issue_created: applied issue://issue-tracker/issues/1001
  destination writes for this request: 1 (no duplicate)
  evidence:
    evd_boX0waozh2xSIP0Km6Yl check=owner_matches result=pass source=http.issue_tracker:readback version=1 freshness=fresh independence=same_process observed_at=2026-10-28T20:19:31.145Z
  events: operation.accepted -> dispatch.intent -> dispatch.result -> reconcile.started -> reconcile.result -> verification.started -> verification.result
```

The runtime keeps running after the demo. Remove everything, including the database volume:

```bash
docker compose -f examples/quickstart/compose.yaml down -v
```

The quickstart is for evaluation only: demo authentication (accepted only on the API container's
loopback interface), a fixed demo digest key and a synthetic destination. The image is
`linux/amd64` and was tested on an x86-64 Linux Docker host. Other platforms (for example Docker
Desktop on Apple silicon, under emulation) are untested.

## Connect an application

```bash
docker compose -f examples/quickstart/compose.yaml run --rm connect
```

This installs `@verified-action-protocol/sdk@0.1.0-rc.1` from npm in a throwaway Node.js 24
container and runs [`examples/connect/index.mjs`](examples/connect/index.mjs): one action from
request to `execution=completed verification=passed outcome=verified`. The core of it:

```js
import { VapClient, demoToken } from "@verified-action-protocol/sdk";

const agent = new VapClient({ baseUrl: "http://127.0.0.1:8080", token: demoToken("demo-agent") });
const task = await agent.openTask({ goal: "File an issue owned by erin", grant_id, scope, required_checks: [ownerIsErin] });
const plan = await agent.prepare({ task_id: task.id, action_id: "issues.create", arguments: { title: "Flaky checkout test", owner: "erin" } });
const { operation } = await agent.execute(plan.id, requestKey); // the same key again returns the same operation
const done = await agent.waitForOperation(operation.id);        // execution and verification are separate fields
console.log(done.outcome);                                       // "verified" only if every named check passed
```

[docs/connect.md](docs/connect.md) walks through it, lists the token providers for a real
deployment, and shows how to wrap an existing tool: an HTTP API through configuration only, a
command-line program as a registered recipe, or an MCP client through the bridge.

## Deploy

The supported deployment path is the image by digest as separate Docker containers (migration
job, API, worker) with PostgreSQL and an OIDC issuer: [docs/deployment-docker.md](docs/deployment-docker.md).
It states what was validated for this release and what was not. The image's residual
vulnerabilities are accepted only under deployment restrictions (non-root, no privileged mode, no
added capabilities or host devices, no root commands in the container, limits on command
recipes): [security decision record](docs/security/runtime-decision-record.md).

## Limitations

No universal undo, no exactly-once remote side effects, no automatic business semantics for
arbitrary APIs, no prompt-injection immunity, no compliance certification, no multi-tenant SaaS,
no arbitrary code sandbox. Cancellation is never rollback. A verifier in the same process is not
organizational or cryptographic independence; evidence records say so.
See [docs/limitations.md](docs/limitations.md).

Release-specific limitations:
- **Managed Google Cloud deployment is experimental.** On the final image it passed once and
  failed once; in the failing attempt Cloud Scheduler received HTTP 401 from Cloud Run, and the
  cause is not established. The passing live SDK call used a test stand-in for the SDK's `gcloud`
  token source ([managed-staging-results.md](docs/release/managed-staging-results.md)).
- **Docker deployment** was validated in test mode against a synthetic destination with a local
  OIDC issuer; production mode end to end, real identity providers, TLS, backups and upgrades
  were not ([deployment-docker.md](docs/deployment-docker.md)).
- **Not run:** the workflow against a real GitHub repository, and any comparison with
  model-driven agents (the demo agents are scripted policies).
- **Browser adapter and worker-browser image:** experimental, excluded from the release.
- **Residual CVEs:** 12 unfixed upstream findings in the image's Debian base, none with a fix
  available; 3 not affected, 9 accepted as exceptions under the restrictions above
  ([decision record](docs/security/runtime-decision-record.md)). Review date 2027-01-28.
- **No public build provenance** for the npm packages or the image.
- The name "VAP" is provisional.

## Evidence

The claims above link to recorded cloud runs:
- [Release manifest](docs/release/manifest.md): source commits, artifact build commit, image
  digest and package checksums.
- [Candidate evidence](docs/release/candidate-evidence.md): test suites, release gates, scans,
  SBOMs, consumer install, staging rehearsal.
- [Quickstart check](docs/release/quickstart-results.md): the two commands above in a fresh
  environment.
- [Acceptance matrix](docs/acceptance.md) and [release notes](docs/release-notes-0.1.0-rc.1.md).

## What v0.1 provides

- **Protocol**: versioned JSON Schemas (draft 2020-12) for Task, Observation, Action, Plan,
  Operation, Evidence, Grant, Approval and Event; method contracts, error codes with retry
  dispositions, canonical JSON and keyed digests; executable examples validated in CI.
- **Runtime**: authenticated HTTP API, PostgreSQL journal with an outbox, fenced worker claims,
  immutable expiring plans, plan-bound single-use approvals, caller-scoped request keys,
  reconciliation, named-check verification, declared recovery and a sweeper.
- **Adapters**: a configurable JSON **HTTP** adapter (SSRF-guarded, conditional writes,
  destination deduplication with sealed lookups), an **experimental** bounded browser adapter
  (Playwright, reviewed recipes only, explicit vs inferred attribution; disabled by default, not in
  the supported release, `playwright` is an optional peer dependency) and a **registered-command CLI**
  adapter (argument arrays, workspace containment, process-group cleanup, bounded output, never
  answers prompts).
- **Integration**: a TypeScript client and adapter SDK, the `vap` CLI, and a **stdio MCP bridge**
  exposing ordinary tools (`vap_task_open`, `vap_prepare`, `vap_execute`, `vap_verify`,
  `vap_reconcile`, ...).
- **Operations**: a read-only viewer that shows uncertainty first, structured redacted logs,
  metrics, runbooks, a GCP deployment path (Cloud Build, Artifact Registry, Cloud Run service and
  jobs, Cloud SQL, Cloud Scheduler) and teardown.

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
