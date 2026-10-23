# Managed staging deployment: results

Sanitized: `<project>` stands for the owner's project; service URLs, account emails and evidence
locations are in the operator-only index. Runs are identified by Cloud Build id.

**Scope.** One managed staging exercise in the owner's existing project, authorized with a $25
ceiling (paid model comparisons excluded), scoped IAM only, and same-day teardown. It used Cloud
Run (API and synthetic fixture), Cloud Run jobs (migration, worker, sweeper), Cloud Scheduler,
Cloud SQL for PostgreSQL 17, Secret Manager and Google-signed ID tokens. The browser adapter
stayed disabled and its image was neither deployed nor published.

**Not established here.** Blank-project onboarding: the project already had Cloud Build,
Artifact Registry and the evidence bucket, so `bootstrap.sh` and the quickstart's project setup
remain unverified (acceptance A8). Creating another billed project was not authorized.

## Final candidate run

Pending: recorded when the managed gate runs on the publication candidate's runtime image.

## Development runs (image built from the development branch)

| Run | Image | Result |
|---|---|---|
| `6f7ff47f`, `bc5503f8`, `0f46be49` | — | provisioning FAILED, fixed and rerun: `sql instances create --labels` is beta-only; Cloud SQL's `postgres` may not name `NOSUPERUSER`; the admin needed explicit `SET` membership on the owning roles |
| `724d7264` | — | provisioning PASSED |
| `ac8832ba` | `sha256:4b197d15…` | FAILED at migrate: Cloud Run's Cloud SQL attachment needs `sql-component.googleapis.com` (gcloud prompted and aborted). Guarded steps were skipped and teardown ran |
| `1706cefd` | `sha256:4b197d15…` | FAILED at interrupt: `executions cancel` reports a cancelled execution as an error although Cloud Run recorded `cancelledCount: 1`. Evidence was lost because Cloud Build uploads artifacts only for successful builds; an explicit upload step was added |
| `24fc9ae6` | `sha256:4b197d15…` | FAILED (correctly) at the recovery check: the cancelled execution was the one launched for the operation, but another execution draining the shared outbox was verifying it, so the verification finished uninterrupted with one `verification.started`. Fixed by naming worker ids after the Cloud Run execution and cancelling the execution that holds the verification |
| `606a4298` | `sha256:3110efa3…` | **PASSED**, every check below |
| `e0f425f5` | `sha256:c6fe8562…` (superseded candidate `661a1b2`) | FAILED at smoke: Cloud Run IAM answered 403 to the first authenticated call, seconds after `run.invoker` was granted to `vap-smoke` (IAM propagation; earlier runs passed only because intermediate steps took longer). The identity step now waits until the call is admitted, up to 5 minutes. The other six gates on `661a1b2` passed |

### What `606a4298` showed

| Requirement | Evidence |
|---|---|
| Migrations | job `vap-migrate-staging` ran as `vap-migrator` (1 migration, `0001_initial`); the API refuses to start on an outdated schema |
| Database access control | as `vap_runtime`: journal readable; `CREATE TABLE` refused (`permission denied for schema public`); `DROP TABLE` refused (`must be owner`); connecting to the fixture database refused. No application role is a member of `cloudsqlsuperuser` |
| IAM | the API is invocable only by `vap-smoke` (no `allUsers`); `vap-api` may run only the worker job with overrides; `vap-scheduler` may run only the sweeper job; each secret is readable only by the accounts that need it; the only project-level bindings of the exercise accounts are `cloudsql.client` conditioned on the staging instance. The synthetic fixture was public for the exercise |
| Google-signed authentication | ID tokens for `vap-smoke` minted through IAM Credentials (`getOpenIdToken` on that account only); VAP reported OIDC authentication; unauthenticated request rejected; Google-signed token with the wrong audience rejected (401) |
| Scheduler | a sweeper execution created by `vap-scheduler` (Cloud Scheduler, OAuth) succeeded |
| Dispatch | the authenticated smoke operation dispatched through Cloud Run jobs and ended `verified` |
| In-flight interruption | operation `op_c9ktfLdIZf9VeQkhRUN9`: write committed (`dispatch.result` 07:42:08.252), verification polling (`verification.started` 07:42:08.325; the fixture kept the new version invisible for 180 s). The verifying process was sweeper execution `vap-sweeper-staging-6bdqs` (it had picked up the shared outbox item before the dedicated worker started), RUNNING when cancelled at 07:42:14.978; Cloud Run recorded `cancelledCount: 1`. The API was moved to a new revision. Verification was still `pending` afterwards |
| Restart recovery | verification started again at 07:42:38.862 and produced its first result at 07:45:10.187 (after the visibility delay): `verified`, 1 submission |
| Reconciliation | operation with a lost reply: `reconcile.started`, `reconcile.result`, then `verified`, 1 submission, no resubmission |
| Journal durability | all three operations and their 18 events read back identically after the API restart and after a Cloud SQL instance restart |
| Cleanup (run resources) | both services, the three jobs and the scheduler job deleted; none remained |
