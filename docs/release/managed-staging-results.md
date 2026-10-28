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
remain unverified (acceptance A8). The later Plan B run used a disposable project, which the
owner created and prepared by hand, so it does not establish blank-project onboarding either.

## Final 0.1.0-rc.1 digest in a disposable project (Plan B, 2026-10-27)

Authorized by the owner: Plan B only ([managed-gate-identity-plan.md](managed-gate-identity-plan.md)),
a $5 ceiling, one image copy, two full attempts, the live SDK check E2 in the same deployment,
and session-independent cleanup. No residual risk was accepted.

**Setup:**
- The owner created a disposable project (`<gate-project>`), linked billing, and granted the
  operator's dispatch identity Owner on that project only.
- The gate identities came from `infra/gcp/gate-identities.sh` unchanged from `765be87`.
- A watchdog was created first: a Cloud Scheduler job that deletes the project at a deadline 6
  hours after setup, calling Resource Manager as a janitor account holding only
  `resourcemanager.projectDeleter`.

**Image copy (once).** The copy build `62771f6b` used Docker.
- The copied tag resolves to
  `sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849`, identical to the
  release manifest. It was checked before any deployment.
- The temporary read grant on the existing project's repository existed for about 72 seconds;
  its removal was confirmed by listing.

| Attempt | Provision | Deploy gate (16 checked steps) | E2: live SDK call | Teardown |
|---|---|---|---|---|
| 1 | `c3931405` passed | `11ac6b7a` **PASSED**, all 16 steps | `11091b3e` **FAILED** before any SDK call: minting the `vap-smoke` token with `gcloud auth print-identity-token --impersonate-service-account` failed (error output was suppressed by the check; a defect of the E2 check, not of VAP) | `ad3630cc` passed; nothing left |
| 2 | `48a1f268` passed | `8d0fce40` **FAILED** at `scheduler-trigger`; later steps skipped by design | `7fac42d8` **PASSED** | `4270bbcf` passed; nothing left |

**Deploy gate, attempt 1 (exact final digest, dedicated identities, no Owner build identity):**
- migrations and database access controls;
- access policy (API invocable only by `vap-smoke`; instance-conditioned `cloudsql.client` only);
- wrong-audience Google token rejected (401);
- authenticated smoke operation verified;
- Cloud Scheduler started sweeper executions as `vap-scheduler` (3 succeeded);
- an operation interrupted while its verification was in flight (the verifying execution was
  RUNNING when cancelled, and the API was restarted) reached its final state;
- lost-reply reconciliation;
- the journal was identical after a Cloud SQL restart (3 operations, 18 events).

**Attempt 2 failure (unresolved; probable cause recorded, not confirmed).**
- Cloud Scheduler's calls to the Cloud Run Admin API as `vap-scheduler` returned
  **401 UNAUTHENTICATED** repeatedly from about 22:02 UTC, interleaved with successes.
- The first successful trigger came at 22:04:15, after the step's 3-minute window. Over the whole
  run, Scheduler logged 20 attempts with HTTP 200 and 11 with 401, all 401s in attempt 2.
- Attempt 1 had no 401. In attempt 2, every runtime account had been recreated with the same name
  about 3.5 minutes after attempt 1's teardown deleted it: deleted 21:32:27–21:32:38 UTC,
  recreated 21:35:50–21:36:09 UTC. The audit log shows three create calls for `vap-scheduler`.
- The probable cause is identity propagation for a recreated account name. This was not
  confirmed, and attempt 2 is a failed gate run.

**E2, attempt 2 (live SDK call against the deployed final image).**
- The five release tarballs of `9fd981db` (checksums verified) were installed into an empty
  consumer project, with registry lookups for the scope blocked.
- A Google-signed ID token for `vap-smoke` was minted through IAM Credentials `generateIdToken`.
- The documented example `offline-check.mjs` ran with `VAP_URL` set. Its live
  `VapClient.info()` returned protocol 0.1.
- `info()` reported `auth_mode` `oidc`, build `0.1.0-rc.1`, commit `765be87`, and image digest
  `sha256:d79c04bd…`.
- The same SDK call with a demo token was refused with HTTP 401.
- **Limitation:** the SDK's `gcloud` token source was answered by a strict shim that returned
  the token minted in the previous step, because the Node.js container has no gcloud.

**Deviation during setup.** `gate-identities.sh` (765be87) runs `gcloud iam service-accounts
create` and its repository binding without `--project`. With the dispatch identity's default
project set to the existing project, it created `vap-gate-provisioner` there before failing.
- That account had no bindings and no keys, and was deleted about 4 minutes later.
- The rerun pinned `CLOUDSDK_CORE_PROJECT` to the disposable project.
- The successor candidate fixes the script (explicit `--project` everywhere, checks before any
  change). That fix does not address the Scheduler failure.
- No other resource or binding was created in the existing project; this was checked by listing.

**Cleanup:**
- Evidence was copied to the private evidence location: 42 report files, sanitized copies of
  each, and the session logs.
- The project was deleted by running the watchdog job, which proves the session-independent
  path. The project went to `DELETE_REQUESTED` within seconds.
- `DELETE_REQUESTED` means deletion was requested and the project's resources are shut down. It
  is **not** completed deletion: Google holds the project for 30 days before deleting it
  permanently.
- The existing project has no `vap-*` account, no gate binding on its policy or its repository,
  and no Cloud Run service, Cloud SQL instance or secret.

**Spend (list-price estimate; billing data was not visible to the session):**
- about 92 build-minutes on the default machine type (about $0.55, or within free build minutes);
- Cloud SQL for about 1.3 hours (about $0.02);
- cents for Cloud Run, Scheduler, Artifact Registry and Secret Manager;
- **under $0.70 in total**, against the $5 ceiling.

**Further analysis of the saved logs (no new runs).**
- This uses only logs saved before the project was deleted; the project's own logs are no longer
  reachable.
- **Attempt 1:** Cloud Scheduler made 17 calls as `vap-scheduler`, from 21:14 to 21:29 UTC. All
  17 returned HTTP 200. The account had been created about 25 minutes before the first call.
- **Attempt 2:** the account had been recreated about 23 minutes before the first call (21:59
  UTC), so it was about the same age.
  - Every call in the first 5 minutes returned 401 (6 calls, 21:59–22:03).
  - After that the results were mixed: 3 returned 200 and 5 returned 401, up to 22:11.
- The status was 401 (unauthenticated) rather than 403 (permission denied). That suggests the
  credential presented for `vap-scheduler` was not accepted, rather than a missing role.
- The difference between the attempts that the logs show is that attempt 2's accounts reused
  names deleted about 3.5 minutes earlier.
- **This remains a hypothesis.** The logs do not establish the cause, and no run was made to test
  it.

**Result.** On the exact final digest, the managed deployment gate passed once (attempt 1) and
failed once (attempt 2, Scheduler authentication). The live SDK call passed once (attempt 2) and
failed once (attempt 1, test defect). The passing E2 call authenticated through a shim that stood
in for the SDK's `gcloud` token source, not through the SDK's normal token path. Each check passed in one of the two deployments, but not
both in the same one. Both failures are recorded as observed.

## Previous image run (candidate 61ed3b2): PASSED

Cloud Build `8f27612f-6e16-4b0c-b350-89757bae8127` (`bash scripts/vap-cloud.sh deploy`), runtime
image `<registry>/vap/vap@sha256:be75a82188faf47512e00f00db6d2c452067b5a5f71ef70fe410bc192afe87d6`
built from publication candidate `61ed3b2`. All 16 checked steps passed and the Cloud Run
resources were deleted.

**Applicability to the final 0.1.0-rc.1 image.** The release candidate `765be87` ships runtime
image `sha256:d79c04bd…`, which has not been deployed (no new deployment spend was authorized).
Compared file by file: the first rc.1 image `sha256:b7ecf996…` differed from the image above by
178 removed Playwright files, 77 changed files (version strings, `zod` 4.6.7, a Debian `tzdata`
update) and cleared setuid/setgid bits (inspection `3319422a`); the final image differs from that
one by the renamed package directory (`@vap` to `@verified-action-protocol`, 9 files) and 120
recompiled or relabelled files, with identical OS packages (inspection `c1838d77`). None of these
change the journal, dispatch, verification or reconciliation logic. The gate has since run on
the exact final digest (section above).

| Requirement | Evidence |
|---|---|
| Migrations | job `vap-migrate-staging` ran as `vap-migrator`: 1 migration, `0001_initial` |
| Database access control | as `vap_runtime`: journal readable; `CREATE TABLE` refused (`permission denied for schema public`); `DROP TABLE` refused (`must be owner of table`); fixture database refused (`permission denied for database "fixture"`). No application role is a member of `cloudsqlsuperuser` (provisioning `724d7264`) |
| IAM | API invocable only by `vap-smoke`, no public member; `vap-api` may run only the worker job with overrides; `vap-scheduler` may run only the sweeper job; each secret readable only by the accounts that use it; the exercise accounts' only project-level binding is `cloudsql.client` conditioned on the staging instance. The synthetic fixture was public for the exercise |
| Google-signed authentication | ID tokens for `vap-smoke` minted through IAM Credentials with `getOpenIdToken` on that account only; VAP ran OIDC verification (issuer, audience = service URL, expiry, signature, verified email); unauthenticated request rejected; Google-signed token with the wrong audience rejected with 401. Test-issuer authentication was not used |
| Scheduler | sweeper executions started by Cloud Scheduler as `vap-scheduler` (creator recorded by Cloud Run) succeeded: 3 by the time of the check |
| Dispatch | operation `op_rnJjCBfQOXHZ0CmLEkAc` dispatched through a Cloud Run job execution and ended `verified` |
| In-flight interruption | operation `op_tkqNwUxcvMWL0rGQ3GdN`: write committed (`dispatch.result` 08:55:30.500), verification polling (`verification.started` 08:55:30.538; the fixture kept the new version invisible for 180 s). The verifying process was job execution `vap-worker-staging-9jm58`, which had been launched for the smoke operation and picked up this operation's outbox item. It was RUNNING (`runningCount: 1`) when cancelled at 08:55:36.726, and Cloud Run recorded `cancelledCount: 1` (completion 08:55:51). The API was moved to a new revision. Verification was still `pending` after both |
| Restart recovery | verification started again at 08:57:07.217 (after the claim lease expired) and produced its first result at 08:58:30.966: `verified`, 1 submission, 2 `verification.started` events |
| Reconciliation | operation `op_KzrAkNrpQNIhRDRDs6fe` (reply lost after the write committed): `reconcile.started`, `reconcile.result`, then `verified`, 1 submission, no resubmission |
| Journal durability | the three operations and their 18 events read back identically before and after a Cloud SQL instance restart (08:59:08), and after the API restart |
| Cleanup | the gate deleted both services, the three jobs and the scheduler job and verified none remained; `cloudbuild.managed-teardown.yaml` then removed Cloud SQL, the secrets, the bindings and the accounts (see "Teardown and cost") |

**What this does not show.** One region, one small instance tier (shared core, no SLA), no
load, no high availability, a synthetic destination, and a single interruption per run. The
worker and sweeper are separate executions of the same image; a crash of Cloud SQL itself
(as opposed to a restart) was not induced.

## Teardown and cost

**Teardown.** `managed-teardown` run `72b77e7b` deleted the Cloud SQL instance (no final backup),
the four secrets, the four instance-conditioned project bindings and the six exercise accounts
(with the token-creator and other bindings on them). Its listing check then still showed
`vap-smoke`, seconds after the deletion succeeded (IAM listing is eventually consistent), so
the build reported failure. Direct checks found nothing left, and the idempotent rerun `805dc08e`
reported every resource absent and verified: no Cloud Run service, job, scheduler job, Cloud SQL
instance or backup, secret, exercise account or project binding remains. (The verification step
should retry its listing; that is a follow-up, not part of this candidate.)

**Retained by design:** the evidence objects and the release images (release records). The
project's APIs enabled for this exercise (`sqladmin`, `sql-component`, `secretmanager`,
`cloudscheduler`, `cloudresourcemanager`) stay enabled; enabled APIs cost nothing by themselves.

**Spend (estimated; billing data was not readable).** The Cloud Billing API is not enabled and the
build identity has no billing permissions, so no observed figure is available, and no budget
alert could be set or checked; budget alerts are notifications, not caps, in any case.

| Item | Usage | Estimate (list prices, us-central1) |
|---|---|---|
| Cloud Build, e2-highcpu-8 (tests, releases, image gates, rehearsals) | 73 build-minutes | about $1.14 ($0.0156/min) |
| Cloud Build, default e2-standard-2 (provisioning, deploys, linkage, teardown) | 96 build-minutes | up to $0.58 ($0.006/min); covered by the 2,500 free minutes per month if unused |
| Cloud SQL db-f1-micro, 10 GB SSD, about 2.7 h | instance-hours | about $0.04 ($0.0105/h + $0.000233/GiB-h) |
| Cloud Run, Cloud Scheduler, Secret Manager, logging | a few hundred requests and executions; 1 scheduler job; 4 secrets for about 3 h | cents at most |
| **Total for the exercise** | | **about $1.20–1.80**, well under the $25 ceiling |

**Continuing cost.** Artifact Registry storage for the repository (about 5.4 GB in total, all
releases so far, layers shared) at $0.10 per GB-month beyond the free 0.5 GB: about $0.50 a
month until superseded development images are deleted by the owner. Evidence objects expire
after 30 days.

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
