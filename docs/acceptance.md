# Acceptance matrix and gate status

**Overall state: CORE RELEASE CANDIDATE (not published).** The supported v0.1 scope is the core
runtime: the runtime image, the npm packages and the schema bundle. The browser adapter and the
worker-browser image are **experimental** and outside that scope until the owner accepts their
residual risk ([security/browser-image-assessment.md](security/browser-image-assessment.md)).

Status values:
- **PASS:** cloud evidence is recorded for the validated commit.
- **PARTIAL:** passed with a named, documented gap.
- **FAIL**
- **BLOCKED:** a named external prerequisite is missing.
- **NOT RUN**
- **UNVERIFIED:** never exercised.

The validated commit, image digests and gate runs are in [release/manifest.md](release/manifest.md)
and [release/candidate-evidence.md](release/candidate-evidence.md).

## Release-readiness gates

| Gate | Status | Evidence / gap |
|---|---|---|
| A1 Repository | PASS | Fresh-clone builds and tests in Cloud Build; tree, history, package and image-configuration scans, including owner identifiers, on the publication candidate |
| A2 Protocol | PASS | Schemas and examples validate under Ajv strict mode; MCP over stdio with `@modelcontextprotocol/sdk` 1.32.1 |
| A3 Runtime | PASS | Conformance, faults T01–T18 and restore against real PostgreSQL; restart recovery with the shipped image in the ephemeral rehearsal |
| A4 Adapters | PASS (core) | HTTP, CLI and GitHub adapters. The browser adapter's suite also passes, but it is experimental and outside the supported scope |
| A5 Verification | PASS | Read-back verification and evidence; destination-state verification; attribution (existence separate from origin) |
| A6 Security, core scope | PASS (technical); owner acceptance pending | Security suite and reviews. No secrets and 0 fixable HIGH/CRITICAL findings in the final runtime image `sha256:d79c04bd…` (release `9fd981db`). Its 12 unfixed CVEs each have a recorded decision with evidence and restrictions ([security/runtime-decision-record.md](security/runtime-decision-record.md)): 3 component absent, 6 conditionally unreachable (restrictions enforced by the image except where noted), 3 present but not used. The image has no setuid/setgid files and no Playwright |
| A6 Security, browser image | INCOMPLETE (experimental) | The technical assessment is evidence-based (linkage inspection). The four critical findings are absent code, not loaded, or conditional on a D-Bus peer that is not present. Several glib HIGH findings remain **unverified**. Owner acceptance of residual risk is **pending**, so the image is outside the supported scope |
| A7 Ephemeral staging rehearsal | PASS | Release image by digest inside Cloud Build: migrations with least-privilege roles, OIDC with a rehearsal-local issuer, worker dispatch, SIGKILL restart mid-operation, database container replacement, journal survival, verified cleanup ([release/staging-rehearsal.md](release/staging-rehearsal.md)) |
| A7 Managed GCP deployment | **PASS** on the previous image; on the final digest: gate PASS in 1 of 2 attempts, live SDK call PASS in 1 of 2 (see results) | Candidate `61ed3b2`, runtime digest `sha256:be75a821…`, Cloud Build `8f27612f`: Cloud Run API (IAM-protected, OIDC with Google-signed tokens), Cloud Run worker, sweeper and migration jobs, Cloud Scheduler, Cloud SQL PostgreSQL 17 and Secret Manager; migrations, database and IAM access controls, dispatch, an interruption while verification was demonstrably in flight, restart recovery, reconciliation and journal durability across API and Cloud SQL restarts; every resource removed afterwards ([release/managed-staging-results.md](release/managed-staging-results.md)). **Final 0.1.0-rc.1 image** `sha256:d79c04bd…`, in a disposable project with dedicated build identities: attempt 1 deploy gate passed all 16 steps (`11ac6b7a`) and its live SDK check failed on a test defect; attempt 2 gate failed at the Scheduler trigger (`8d0fce40`, 401 from Cloud Run, unresolved) and the live SDK call against the deployed image passed (`7fac42d8`) ([release/managed-staging-results.md](release/managed-staging-results.md)). One small shared-core instance, no load, no HA |
| A8 Fresh-clone onboarding, preconfigured environment | PASS | Two clean-room review rounds with fixes. Quickstart demo, tutorial and integration suite run from a fresh clone in a project with the APIs, IAM and bucket already in place ([release/clean-room-review.md](release/clean-room-review.md)) |
| A8 Blank-project bootstrap | **EXCLUDED** from the supported release | Never run from a blank project; two known defects (`sql users create` makes `cloudsqlsuperuser` members; project-level admin roles for `vap-deployer`). `bootstrap.sh` refuses to run unless `VAP_ALLOW_UNSUPPORTED_BOOTSTRAP=1`. The supported path is a preconfigured project ([quickstart.md](quickstart.md)) |
| A9 Packaging | PASS | Images by digest with signed SLSA v0.1 and v1 provenance (kept private: it names private identifiers, so no public provenance for rc.1); CycloneDX SBOMs; license inventory; package tarballs under `@verified-action-protocol` installed from local tarballs into an empty consumer project in the release pipeline (no Playwright by default, offline SDK example runs, declarations type-check; a fresh public-registry install and a live SDK call against the final managed image remain); schema bundle; SHA256SUMS; sanitized public copies of the generated artifacts; image-digest gate. Nothing published; npm scope ownership not yet confirmed |
| A10 Honesty | PASS | Corrected metrics with the logged baseline and measured overhead kept; failed and superseded runs listed; process deviations recorded |
| Exit propagation | PASS | Negative controls in every test build and in the image gate; the evidence step fails on any failing report |
| Real GitHub demo | BLOCKED | Needs the owner's repository, GitHub App secrets, an issue cap and authorization ([demo/real-github-setup.md](demo/real-github-setup.md)) |
| Paid Claude comparison | BLOCKED | Needs model access and a spending ceiling. No claim is made about model performance |
| Publication | BLOCKED (owner decision) | A clean publication branch is prepared and scanned (see the manifest). Pushing it, tagging, publishing packages and any visibility change are the owner's decision |

## CI-failure demonstration

| Item | Status | Evidence |
|---|---|---|
| Fixture layer: 9 scenarios end to end, crash and restart with real runtime processes | PASS | `8446aedb`, `2738a3f9` |
| Demo sequence (lost reply, uncertainty, crash, resume, reconcile, verify, one issue) | PASS | `2738a3f9`, and with the release image in `c9bba95d` |
| Comparison with corrected task-level metrics (scripted policies) | PASS | [demo/ci-failure-results.md](demo/ci-failure-results.md) |
| Attribution (existence separate from origin; another actor's identical issue not accepted) | PASS | `2738a3f9`, `8446aedb` |
| Real GitHub layer | BLOCKED | see above |

## Milestones

| ID | Status | Notes |
|---|---|---|
| M0 | PASS (smoke) | repo, toolchain pins, lockfile, threat-model draft; cloud build, typecheck and unit suite pass in Cloud Build `1f7ccb1d` |
| M1 | IMPLEMENTED | schemas, methods, errors, examples frozen for 0.1 |
| M2 | IMPLEMENTED | PostgreSQL store, lifecycle, keys, outbox, fences; remote tests NOT RUN |
| M3 | IMPLEMENTED | grants, immutable plans, approvals; remote tests NOT RUN |
| M4 | IMPLEMENTED | HTTP adapter and fixture; remote tests NOT RUN |
| M5 | IMPLEMENTED | browser and CLI adapters; remote tests NOT RUN |
| M6 | IMPLEMENTED | verification, recovery, SDK, MCP bridge; MCP smoke NOT RUN |
| M7 | PASS (staging) | durable deployment pipeline and sweeper; managed staging gate passed (`8f27612f`) |
| M8 | PARTIAL | fault and security suites and the deterministic benchmark pass in three runs; image scanning and release hardening pending |
| M9 | PARTIAL | release candidate `765be87` (0.1.0-rc.1, `@verified-action-protocol` packages) built, scanned and attested (`9fd981db`); clean-room onboarding passed in a preconfigured project; managed staging passed on the previous image; blank-project bootstrap excluded; no tag or publication (owner decisions) |

## Product requirements

| ID | Requirement | Tests |
|---|---|---|
| PR01 | immutable checks; revision stales plans | `tests/conformance/lifecycle.test.ts` "PR01 contract revisions" |
| PR02 | discovery and observation with source, version, unknowns | lifecycle "PR02 discovery and observation" |
| PR03 | expiring immutable plans; changed args cannot execute | lifecycle "PR03 ..."; unit `outcome-views` plan precedence; plans DB trigger |
| PR04 | request keys: replay returns original, change conflicts | lifecycle T01/T02; MCP replay |
| PR05 | state survives restart; lost replies unknown until reconciled | lifecycle restart; faults T05, T14 |
| PR06 | named checks; missing/failed/inconclusive block completion | lifecycle PR06; faults T07, T13; unit task outcome |
| PR07 | recovery with fresh authorization as a separate operation | http-adapter Recoverable; faults T08, T18; cli restore |
| PR08 | redacted receipts and events; access follows the grant | lifecycle PR08; security id guessing; T15 |

## Mandatory failure scenarios

| ID | Test |
|---|---|
| T01 | lifecycle "T01: identical concurrent submissions" |
| T02 | lifecycle "T02: the same key with a different plan" |
| T03 | faults "T03 crash before durable acceptance" |
| T04 | faults "T04 ..." (never delivered, delivered then crashed, no lookup) |
| T05 | faults "T05 destination commits and the reply is dropped" |
| T06 | http-adapter "T06 concurrency" (native rejects stale write, racing writers, best-effort declares no protection) |
| T07 | faults "T07 eventually consistent reads" |
| T08 | faults "T08 batch partly succeeds" |
| T09 | faults "T09 approval binding" |
| T10 | faults "T10 grant revocation" (before and after dispatch) |
| T11 | cli-adapter "T11" (child outlives parent, timeout) |
| T12 | browser "T12: unrelated background traffic" |
| T13 | faults "T13 stale or missing evidence" |
| T14 | faults/restore.test.ts |
| T15 | security "T15 secret canaries" |
| T16 | security "T16 SSRF, redirects, traversal"; unit net and CLI containment |
| T17 | faults "T17 duplicate worker launches and expired fences" |
| T18 | faults "T18 recovery fails or loses its reply" |

Gate policy: every deterministic scenario must pass in the canonical cloud profile on the release
commit in at least three fresh complete runs; retries and failures are recorded, not just the
final green run.

## Evidence index

Each cloud run writes `evidence.json` (`gate_id`, `requirement_ids`, `commit_sha`,
`cloud_run_id`, `command`, `image_digest`, `result`, `artifact_checksum`, `reviewer_role`,
`reviewed_at`, `limitations`) to the private evidence bucket. Public evidence carries sanitized
run identifiers only.

| Cloud run | Commit | Suite | Result | Notes |
|---|---|---|---|---|
| Cloud Build `b6953520` | `2ad5b9e` | unit | FAIL | source hygiene, `npm ci`, build and typecheck passed; 34/35 unit tests passed; extension-name pattern rejected `vap.execution_timeout_ms` (fixed in `26ceb7e`) |
| Cloud Build `1f7ccb1d` | `26ceb7e` | unit | PASS | 35/35 unit tests; source hygiene, build and typecheck passed; evidence.json and unit.log in the private evidence location |
| Cloud Build `09824d5d` | `2dfc60e` | integration | PASS | unit 35/35; conformance 34/34; faults 16/16; security 12/12; MCP 3/3; 0 skipped; conformance-*.json reports uploaded (duration 1m49s) |
| Cloud Build `0a7e9343` | `2130889` | browser | FAIL | unit flake: grant-expiry test raced the clock (fixed in `6f3b674`) |
| Cloud Build `76010d27` | `6f3b674` | browser | FAIL | 0/5: browser egress lockdown blocked the approved origin; error not surfaced (diagnostics added in `ea5e319`) |
| Cloud Build `44a5976f` | `ea5e319` | browser | FAIL | 0/5: `net::ERR_PROXY_CONNECTION_FAILED`, Chromium ignored the proxy bypass; replaced by a policy-enforcing egress proxy (`585e762`) |
| Cloud Build `91df2deb` | `585e762` | browser | FAIL | 4/5: T12 saw no background request (fixture timing, `68d321d`) |
| Cloud Build `8b374721` | `68d321d` | browser | FAIL | 4/5: T12 still no background request; capture diagnostics added (`8d0bce9`) |
| Cloud Build `7290488a` | `8d0bce9` | browser | FAIL | 4/5: only navigation and the linked POST captured; `requestfinished` never fired for unread polling bodies (fixed in `4762b3d`) |
| Cloud Build `9095a404` | `4762b3d` | browser | PASS | unit 36/36; browser 5/5 incl. T12; `browser.issues.create_via_form` passes core and verified profiles (duration 1m32s) |
| Cloud Build `0655e173` | `90b45ee` | all (run 1 of 3) | PASS | 106/106 tests, 0 skipped; benchmark (2m59s) |
| Cloud Build `bf06b3fe` | `90b45ee` | all (run 2 of 3) | PASS | 106/106 tests, 0 skipped; benchmark (3m00s) |
| Cloud Build `3e5cea0b` | `90b45ee` | all (run 3 of 3) | PASS | 106/106 tests, 0 skipped; benchmark (3m22s) |
| Cloud Build `8e3d9ae6` | `69181c5` | release | FAIL | runtime image scan: 7 fixable HIGH/CRITICAL in Debian perl-base and 7 HIGH in the bundled npm CLI (fixed in `ee4bb05`) |
| Cloud Build `a5715064` | `ee4bb05` | release | FAIL (provenance only) | every step passed and both images were pushed; build marked FAILURE because SLSA provenance needs the Container Analysis API; npm SBOM found incomplete (fixed in `3d3bd48`) |
| Cloud Build `0d172c5d` | `0c57b52` | release | PASS | Container Analysis API enabled by the owner; SLSA v1 provenance recorded for both images; complete image SBOMs; scans clean (6m31s) |
