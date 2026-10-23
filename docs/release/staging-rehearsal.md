# Staging rehearsal

There are two rehearsals:
- an **ephemeral rehearsal**, which runs entirely inside Cloud Build within the scope already
  authorized for this project;
- a **managed-service deployment**, which needs owner authorization and bootstrap infrastructure
  that do not exist yet.

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
| Authenticated access | the API runs with `VAP_AUTH_MODE=oidc` and verifies a real Google-issued ID token minted for the build's identity (audience `vap-staging-rehearsal`). An unauthenticated request must be rejected. The build identity is the bootstrap operator, and grants itself the agent role through the operator API |
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

## Managed-service deployment (BLOCKED: plan awaiting authorization)

The bounded execution plan is in [managed-staging-plan.md](managed-staging-plan.md): resources,
sizes, scoped IAM, cost, duration, tests and teardown. It mints Google-signed tokens for a
dedicated `vap-smoke` identity with only `iam.serviceAccounts.getOpenIdToken` on that account.


`infra/gcp/cloudbuild.deploy.yaml` (`bash scripts/vap-cloud.sh deploy --image <digest>`) deploys
the image to Cloud Run with Cloud SQL, Secret Manager and Cloud Scheduler, then runs the same
checks against the deployed services.

It is **blocked** because these prerequisites are missing:

1. **Owner authorization and a spending ceiling** for persistent, billable resources: a Cloud SQL
   instance (`db-f1-micro` proposed), Cloud Run services and jobs, Scheduler, and Secret Manager
   secrets. The current authorization covers Cloud Build runs, the Artifact Registry repository
   and the Container Analysis API only.
2. **Bootstrap infrastructure** from `infra/gcp/bootstrap.sh`, run by an operator with rights to:
   - create service accounts (`vap-api`, `vap-worker`, `vap-migrator`, `vap-deployer`,
     `vap-scheduler`, `vap-fixture`, `vap-janitor`);
   - grant IAM roles;
   - create the Cloud SQL instance, databases and users;
   - create secrets.
   After it runs, the SQL grants listed in deployment-gcp.md must be applied.
3. **A deployer identity** for the pipeline with `roles/run.admin`, `roles/iam.serviceAccountUser`
   on the runtime accounts, `roles/cloudsql.client` and `roles/cloudscheduler.admin`. The current
   build identity's grants for these have not been checked or authorized.

When those exist, run the deploy pipeline with `--keep` unset (staging is torn down
automatically), then `VAP_DELETE_DATABASE=true bash infra/gcp/teardown.sh` to remove the
persistent pieces.
