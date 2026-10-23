# Staging rehearsal

There are two rehearsals:
- an **ephemeral rehearsal**, which runs entirely inside Cloud Build within the scope already
  authorized for this project;
- a **managed-service deployment** on Cloud Run, Cloud SQL, Secret Manager and Cloud Scheduler,
  run once under the owner's authorization ([managed-staging-results.md](managed-staging-results.md)).

## Ephemeral rehearsal (runnable now)

```bash
bash scripts/vap-cloud.sh staging-rehearsal --commit <tested sha> --image <registry>/vap/vap@sha256:<digest>
```

Pipeline: `infra/gcp/cloudbuild.staging-rehearsal.yaml`. It runs the release image **by digest**
as separate containers, and checks first that the image's revision label equals the commit.

| Requirement | How it is exercised |
|---|---|
| Migrations | the image's migration CLI runs as `vap_migrator`, which owns the schema; the runtime connects as `vap_runtime`, which has DML only. The pipeline proves the runtime role cannot run DDL. These are the roles described in deployment-gcp.md |
| Unsafe configuration refused | the image started in production mode with isolated test mode, or with demo authentication, must refuse to start with its own refusal message |
| Authenticated access | the API runs with `VAP_AUTH_MODE=oidc` and verifies ID tokens signed by a **rehearsal-local test issuer** (JWKS served inside the build; audience `vap-staging-rehearsal`): signature, issuer, audience, expiry and verified email. Wrong-audience, expired, unsigned and missing tokens must be rejected. The test issuer exists only in this rehearsal; Google-signed authentication is covered by the managed deployment, never by this issuer |
| Worker dispatch | the API runs with `VAP_DISPATCH_MODE=none`; a separate worker container drains the outbox, dispatches, verifies and reconciles |
| Restart recovery | two operations are left mid-flight: one awaiting verification (its write is invisible for 25 s) and one with a lost reply (outcome unknown). The API and worker are then killed with SIGKILL and the database container is removed |
| Durable journal survival | PostgreSQL data lives on a named volume. A new database container, API and worker start on that volume. The operation completed before the crash must still be present and verified, and both disrupted operations must reach an honest final state: verified, or `unknown`, never resubmitted without reconciliation |
| Cleanup | every container and the volume carry `vap-run=<run id>`. Cleanup removes them and fails if anything labelled remains |

**Differences from the managed deployment:**
- It uses Docker containers instead of Cloud Run.
- It uses PostgreSQL in a container instead of Cloud SQL.
- It uses a generated digest key in a build-local file instead of Secret Manager.
- The sweeper runs inside the worker loop instead of on Cloud Scheduler.
- `VAP_ENV=test` with isolated test mode, because the synthetic fixture is on a private Docker
  network, which production mode correctly refuses to reach. That refusal is itself checked.

**Cost:** build minutes only. No persistent resources are created.

## Managed-service deployment

Run once under the owner's authorization: plan [managed-staging-plan.md](managed-staging-plan.md)
(with the as-executed differences), results and teardown
[managed-staging-results.md](managed-staging-results.md). It covers what this rehearsal cannot:
Cloud Run and Cloud Run jobs, Cloud SQL, Secret Manager, Cloud Scheduler, Cloud Run IAM and
Google-signed ID tokens. A managed database cannot be SIGKILLed; it was restarted instead.
