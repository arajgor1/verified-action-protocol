# Release candidate evidence index

Sanitized for the public repository:
- `<registry>` stands for the owner's private Artifact Registry path.
- Runs are identified by Cloud Build id.
- Images are identified by digest, which is sufficient to verify them.
- The exact registry path, project, identities, evidence-object locations and the mapping to the
  private development history are in the operator-only index, kept in the private evidence
  bucket and not in this repository.

Nothing has been published, pushed, tagged or made public.

## Candidate

| Item | Value |
|---|---|
| Validated commit | `61ed3b224dd666621e31768915def0355532102c` on branch `publication/v0.1.0-rc1` (5 commits reachable at validation; the previous candidate `5df8873` is its root) |
| Release scope | core: runtime image, npm packages, schema bundle. Browser adapter and worker-browser image are experimental ([../security/browser-image-assessment.md](../security/browser-image-assessment.md)) |
| Runtime image (supported) | `<registry>/vap/vap@sha256:be75a82188faf47512e00f00db6d2c452067b5a5f71ef70fe410bc192afe87d6`, labels `org.opencontainers.image.revision=61ed3b2…`, `vap.support=supported` |
| Worker-browser image (experimental) | `<registry>/vap/vap-worker-browser@sha256:eb1a00875a1c9c039c1a380ee8a7872fa7127554d6e3a47fc946f95cf08a0628`, labels `org.opencontainers.image.revision=61ed3b2…`, `vap.support=experimental` |
| Changes since `5df8873` | the managed staging exercise: provisioning, deployment-gate and teardown pipelines; owner-keyed fixture faults (test controls only) with tests; worker ids that name the Cloud Run execution; smoke-client options; documentation ([managed-staging-results.md](managed-staging-results.md)) |
| Later commits | documentation only; see [manifest.md](manifest.md) |

## Gates on the validated commit

Every run was submitted with `scripts/vap-cloud.sh` from its own fresh single-branch clone of the
publication branch.

| Gate | Cloud Build | Result |
|---|---|---|
| Full suite (`test --suite all`) | `602911a6-0ae9-4f27-9073-82497dc02da6` | PASS: 161 tests, 0 failed, 0 skipped (aggregated by the evidence step); exit-propagation negative controls; pipeline consistency tests for all 13 pipelines |
| Demo suite (`test --suite demo`) | `a54bbc0a-45b8-413d-8dad-dbaffe86c1d9` | PASS: 87 tests; demo sequence 8/8; 180-run comparison ([results](../demo/ci-failure-results.md)) |
| Release (`release --history-ref publication/v0.1.0-rc1 --strict-history`) | `d983d01e-d9dc-4e1d-93ed-b00c82e1724a` | PASS (details below) |
| Image gate (runtime digest) | `8b0c76f6-0fb9-4e79-acb7-78acff5ed59e` | PASS: revision and `vap.support=supported` labels checked; `docker run` exit propagation; demo and scenarios with the API and worker from the image |
| Ephemeral staging rehearsal (runtime digest) | `a4dae530-c6f5-4803-b347-a385fb8e4b57` | PASS ([staging-rehearsal.md](staging-rehearsal.md)) |
| **Managed staging deployment** (runtime digest) | `8f27612f-6e16-4b0c-b350-89757bae8127` | **PASS** on Cloud Run, Cloud Run jobs, Cloud Scheduler and Cloud SQL with Google-signed authentication ([managed-staging-results.md](managed-staging-results.md)) |
| Browser linkage (worker-browser digest) | `e333db2c-18cb-472b-bf3c-45e15f49dc41` | PASS ([../security/browser-image-assessment.md](../security/browser-image-assessment.md)) |
| Clean-room onboarding (`demo`, `tutorial`, `test --suite integration`) | `d97cf09a`, `6fe6bfcb`, `874d389f` on `b85d442` | PASS in a preconfigured project. The onboarding docs and the commands they use are unchanged since then |

**Release details (`d983d01e`):**
- Scans for secret classes and owner identifiers found nothing in:
  - the source archive (266 files);
  - the **full history reachable from the publication branch, in strict mode** (285 files);
  - every file in the five npm package tarballs and the schema bundle;
  - the configuration and history of both images.
- The Chromium launch smoke test passed inside the worker-browser image.
- Trivy found 0 fixable HIGH/CRITICAL findings and no secrets in either image. Unfixed findings
  are assessed per CVE in
  [../security/vulnerability-dispositions.md](../security/vulnerability-dispositions.md): 12 in
  the runtime image and 42 in the worker-browser image, the same CVEs as the previous candidate.
  Owner acceptance is pending.
- CycloneDX SBOMs, license inventory (third-party notices), package tarballs, schema bundle.
- Sanitized `public-*` copies (8) of the SBOMs, scan reports, vulnerability inventories and
  license inventory, with no owner identifiers left. The private originals are kept beside them.
- `SHA256SUMS` lists all 25 artifacts by base name.
- Signed SLSA provenance from `https://cloudbuild.googleapis.com/GoogleHostedWorker`.

**Managed staging (`8f27612f`), summary:** migrations as the migration identity; runtime database
role refused DDL, `DROP` and the fixture database; IAM assertions (API invocable only by the smoke
identity, job- and secret-scoped grants, instance-conditioned Cloud SQL client); Google-signed
tokens accepted and a wrong-audience token rejected; a Scheduler-started sweep; an operation
interrupted while its verification was polling (the verifying execution was RUNNING when
cancelled, and the API restarted), then resumed and verified with one submission; a lost reply
resolved by reconciliation with one submission; the journal identical across an API restart and a
Cloud SQL restart; every exercise resource removed afterwards (teardown `805dc08e`).

## Superseded and non-passing runs (kept for the record)

| Run | Commit | Status |
|---|---|---|
| `538bad90`, `4c378343`, `9fea3c08`, `23f2f80a`, `75a7534f`, `a11ae226`, `343e02e0`, `3c055663` | `5df8873` | passed; superseded by `61ed3b2` |
| `5db55841`, `7e6e65f6`, `56ab2d07`, `0b7f695d`, `f7339438`, `ab369139` | `661a1b2` | passed; superseded by `61ed3b2` |
| `e0f425f5` | `661a1b2` | **FAILED**: managed gate, Cloud Run IAM propagation race (fixed in `61ed3b2`) |
| `6f7ff47f`, `bc5503f8`, `0f46be49`, `724d7264`, `ac8832ba`, `1706cefd`, `24fc9ae6`, `606a4298`, `72b77e7b` and the releases and tests they used | development branch | managed-exercise development runs; failures and fixes listed in [managed-staging-results.md](managed-staging-results.md) |
| `9303cae2`, `88011a54` (manifest), `8446aedb`, `2738a3f9`, `f73e18d3`, `c9bba95d`, `0395220b`, `d97cf09a`, `6fe6bfcb`, `874d389f` | `b85d442` | passed; superseded by the publication candidate |
| `4ca0a6bc`, `4bed48b3`, `e820cdd2`, `53eae8e8`, `908d8caa`, `56771f0f` | `c4c06bb` | passed, but release `e820cdd2` **overwrote 8 private originals** in the evidence location with their sanitized copies (Cloud Build flattens artifact directories). Superseded after the fix ([../process-deviations.md](../process-deviations.md)) |
| `14de1812`, `185547dc` | browser linkage of `b85d442` | first passed; second failed (script bug, fixed) |
| `7cd320a6`, `1dfa2746`, `0b3850e0` | `35431e1` and debug | **FAILED**: staging identity attempts (`--include-email` refused; no metadata identity endpoint; IAM Credentials refused without permission) |
| earlier candidates `8833feb`, `35431e1` and others | | passed or failed as listed in previous versions of this page; superseded |
| `5a865ed5` | `5939dd8` | reported success with 1 of 24 tests failed (masked); **not a passing gate** |

## Not covered

- **Blank-project bootstrap:** UNVERIFIED. The managed exercise ran in a project that already had
  Cloud Build, Artifact Registry and the evidence bucket; creating a new billed project was not
  authorized.
- **Real GitHub:** BLOCKED.
- **Paid Claude comparison:** BLOCKED.
- **Owner acceptance of residual CVE risk:** pending.
- **Publication** (pushing the branch, tags, packages, visibility): the owner's decision.
