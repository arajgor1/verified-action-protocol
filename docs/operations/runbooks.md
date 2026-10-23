# Operations and runbooks

## Operator surface

- **Viewer** (`/viewer`, through `gcloud run services proxy`): unknown outcomes first, then recent
  operations; each operation shows checks, effects, not-verified effects, retry guidance,
  recovery links and the event journal.
- **CLI**: `vap operation inspect <id> --evidence --events`, `vap task inspect <id>`,
  `vap doctor --remote`.
- **Metrics** (`/metrics`, operator or viewer role): operations by execution and verification
  status, unknown count and oldest age, outbox depth and oldest age by kind, live worker claims,
  failed or unknown recoveries, authentication and authorization denials, request counts and
  durations.
- **Logs**: structured JSON with request and operation ids, safe error codes and durations;
  redacted before serialization; no request bodies or credentials.

## Kill switch

Revoke the grant (`POST /v1/operator/grants/{id}/revoke`). New dispatches stop, new writes are
rejected, running operations get cancellation requests. Then reconcile and record remaining
uncertainty. Revocation cannot undo remote effects.

Each runbook lists detection, containment, inspection, recovery, evidence and escalation.

## Lost reply / unknown outcome
- **Detect**: `vap_unknown_outcomes` > 0; viewer alert; receipts with `reconcile_first`.
- **Contain**: do not retry the action or prepare a duplicate plan.
- **Inspect**: `vap operation inspect <id> --events`; check `dispatch.result` diagnostics.
- **Recover**: `POST .../reconcile`. If it stays unknown with `operator_resolution_required`,
  check the destination's own audit trail and record the finding with the resolve endpoint.
- **Evidence**: reconcile events, lookup observations, operator note.
- **Escalate**: the destination owner when its lookup is unavailable.

## Stalled worker
- **Detect**: `vap_outbox_oldest_seconds` growing; operations stuck in `running` with no live claim.
- **Contain**: nothing to stop; claims expire by lease.
- **Inspect**: Cloud Run job executions; `vap_worker_claims_live`.
- **Recover**: the sweeper requeues missed work and reconciles orphaned running operations; run
  it manually with `gcloud run jobs execute vap-sweeper-<env>`.
- **Evidence**: `claim.expired` and `reconcile.result` events.
- **Escalate**: platform quota or job failures.

## Database outage
- **Detect**: `/readyz` 503; API returns `UNAVAILABLE`.
- **Contain**: mutation acceptance fails closed; nothing is acknowledged that is not recorded.
  Clients retry with the same request key.
- **Inspect**: Cloud SQL status and connections.
- **Recover**: restore service; outbox and sweeper resume. For restores, verify unresolved
  submissions remain `unknown` and are reconciled, never replayed.
- **Evidence**: incident timeline, restore drill output.
- **Escalate**: database owner.

## Invalid migration
- **Detect**: migration job fails; API refuses to start (`schema is at X, build expects Y`).
- **Contain**: keep the previous image serving; the failed migration is rolled back
  transactionally.
- **Recover**: fix forward with a new migration; never edit an applied one (checksums are
  enforced). Do not reverse destructive changes blindly.
- **Escalate**: maintainers.

## Expired identity / authentication failures
- **Detect**: spikes in `vap_authentication_denials_total`; 401s.
- **Recover**: check token audience (must equal the service URL), issuer and clock; refresh
  workload identity bindings; operators get roles through `/v1/operator/principals`.

## Approval service unavailable
- **Detect**: plans accumulating in `awaiting_approval`; `/v1/approvals/pending`.
- **Contain**: tier 2–3 actions do not run without approval; that is the intended fail-closed state.
- **Recover**: approvers decide on the exact plan digest; expired plans are re-prepared.

## Suspected leaked secret
- **Contain**: rotate the credential at its source immediately (operator-directed); revoke grants
  that used it.
- **Inspect**: run `scripts/release-hygiene.mjs --history` and the private operator rules in the
  cloud; check logs and evidence for the value without printing it.
- **Recover**: rewrite history if it reached the repository; republish only after a clean scan.
- **Escalate**: security contact (SECURITY.md).

## Exhausted cloud quota / budget boundary
- **Detect**: build or job launch failures; budget alerts (not hard caps).
- **Contain**: stop dispatching new cloud work; queued operations wait in the outbox.
- **Recover**: raise quota or reduce concurrency; tear down idle staging.
- **Evidence**: build ids, billing report. **Escalate**: the owner, who sets the spend ceiling.

## Fixture cleanup failure
- **Detect**: teardown reports `failed` entries; resources with expired `vap-run` labels.
- **Recover**: `bash scripts/vap-cloud.sh cleanup --run <id>` or `infra/gcp/teardown.sh`.

## Artifact store outage
- **Detect**: evidence records with the limitation "evidence artifact store unavailable".
- **Contain**: verification continues with bounded inline facts; status is not upgraded because
  an artifact is missing, and requirements are not dropped.
- **Recover**: restore bucket access; re-verify if a fuller artifact is needed.

## Data lifecycle

Redacted operation metadata and evidence are kept 30 days by default (configurable); request
keys are kept for the retry window (7 days by default) and then tombstoned so reuse fails
visibly; unresolved operations are never purged. Artifacts follow the bucket lifecycle. Backups
follow Cloud SQL retention, so deletion from backups is not immediate.

## Maintenance

Supported runtime: Node 24 LTS, PostgreSQL 17, the image digests in `toolchain.json`. Dependency
upgrades require conformance reruns and image scans. A failing guarantee disables that capability
(declare it `unavailable`) until fixed.
