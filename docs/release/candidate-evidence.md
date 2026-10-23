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
| Validated commit | `5df8873f181fece8afa45b4de83ff78055f352a2`, the root commit of branch `publication/v0.1.0-rc1` (1 commit reachable at validation) |
| Release scope | core: runtime image, npm packages, schema bundle. Browser adapter and worker-browser image are experimental ([../security/browser-image-assessment.md](../security/browser-image-assessment.md)) |
| Runtime image (supported) | `<registry>/vap/vap@sha256:a5fc21aa469cd8f265b949a96a12cd5730c6f5bb132ea2a4f09b61ec1667f633`, labels `org.opencontainers.image.revision=5df8873…`, `vap.support=supported` |
| Worker-browser image (experimental) | `<registry>/vap/vap-worker-browser@sha256:1d2cd1e620d278d4608eb4c84e730d1ab7b59326ea57c51eeb938238453f1fbf`, labels `org.opencontainers.image.revision=5df8873…`, `vap.support=experimental` |
| Later commits | documentation only; see [manifest.md](manifest.md) |

## Gates on the validated commit

Every run was submitted with `scripts/vap-cloud.sh` from a fresh single-branch clone of the
publication branch.

| Gate | Cloud Build | Result |
|---|---|---|
| Full suite (`test --suite all`) | `538bad90-4007-4b03-a5d4-0a687c55765b` | PASS: 153 tests, 0 failed, 0 skipped (aggregated by the evidence step); exit-propagation negative controls; pipeline consistency tests |
| Demo suite (`test --suite demo`) | `4c378343-f903-48f0-afe9-b2b8b8d4652f` | PASS: 83 tests; demo sequence 8/8; 180-run comparison ([results](../demo/ci-failure-results.md)) |
| Release (`release --history-ref publication/v0.1.0-rc1 --strict-history`) | `9fea3c08-4559-42cc-8c7c-02cb9ef3038f` | PASS (details below) |
| Image gate (runtime digest) | `23f2f80a-ee81-4bec-a5c9-b27dd6128592` | PASS: revision and `vap.support=supported` labels checked; `docker run` exit propagation; demo 8/8 and scenarios 9/9 with the API and worker from the image |
| Ephemeral staging rehearsal (runtime digest) | `75a7534f-0d08-472c-9795-2209c24152b3` | PASS ([staging-rehearsal.md](staging-rehearsal.md)) |
| Browser linkage (worker-browser digest) | `a11ae226-7d8b-4d17-b45c-44b8eb4b9f60` | PASS ([../security/browser-image-assessment.md](../security/browser-image-assessment.md)) |
| Clean-room onboarding (`demo`, `tutorial`, `test --suite integration`) | `d97cf09a`, `6fe6bfcb`, `874d389f` on `b85d442` | PASS in a preconfigured project. The onboarding docs and the commands they use are unchanged since then |

**Release details (`9fea3c08`):**
- Scans for secret classes and owner identifiers:
  - the source archive (261 files);
  - the **full history reachable from the publication branch, in strict mode**;
  - every file in the five npm package tarballs and the schema bundle;
  - the configuration and history of both images.

  None found anything.
- The Chromium launch smoke test passed inside the worker-browser image.
- Trivy found 0 fixable HIGH/CRITICAL findings and no secrets in either image. Unfixed findings
  are assessed per CVE in
  [../security/vulnerability-dispositions.md](../security/vulnerability-dispositions.md): 12 in
  the runtime image and 42 in the worker-browser image. Owner acceptance is pending.
- CycloneDX SBOMs, license inventory (third-party notices), package tarballs, schema bundle.
- Sanitized `public-*` copies of the SBOMs, scan reports, vulnerability inventories and license
  inventory, with no owner identifiers left. The private originals are kept beside them.
- `SHA256SUMS` lists all 25 artifacts by base name and verifies against the uploaded set
  (checked).
- Signed SLSA v0.1 and v1 provenance from `https://cloudbuild.googleapis.com/GoogleHostedWorker`.

**Staging rehearsal (`75a7534f`):**
- Migrations ran as the migration role; the runtime role was refused DDL.
- Unsafe production configurations were refused.
- Wrong-audience, expired and unsigned tokens were rejected with 401 (rehearsal-local OIDC issuer).
- One operation was verified, then two were disrupted mid-flight (one awaiting verification, one
  with a lost reply). The API and worker were SIGKILLed and the database container was replaced.
- After restart, all three operations were present and verified. Verification resumed: two
  `verification.started` events. The lost reply was resolved by reconciliation with one attempt
  and no resubmission.
- Cleanup left no labelled container or volume.

## Superseded and non-passing runs (kept for the record)

| Run | Commit | Status |
|---|---|---|
| `9303cae2`, `88011a54` (manifest), `8446aedb`, `2738a3f9`, `f73e18d3`, `c9bba95d`, `0395220b`, `d97cf09a`, `6fe6bfcb`, `874d389f` | `b85d442` | passed; superseded by the publication candidate |
| `4ca0a6bc`, `4bed48b3`, `e820cdd2`, `53eae8e8`, `908d8caa`, `56771f0f` | `c4c06bb` | passed, but release `e820cdd2` **overwrote 8 private originals** in the evidence location with their sanitized copies (Cloud Build flattens artifact directories). Superseded after the fix ([../process-deviations.md](../process-deviations.md)) |
| `14de1812`, `185547dc` | browser linkage of `b85d442` | first passed; second failed (script bug, fixed) |
| `7cd320a6`, `1dfa2746`, `0b3850e0` | `35431e1` and debug | **FAILED**: staging identity attempts (`--include-email` refused; no metadata identity endpoint; IAM Credentials refused without permission) |
| earlier candidates `8833feb`, `35431e1` and others | | passed or failed as listed in previous versions of this page; superseded |
| `5a865ed5` | `5939dd8` | reported success with 1 of 24 tests failed (masked); **not a passing gate** |

## Not covered

- **Managed GCP deployment:** BLOCKED; the plan awaits authorization
  ([managed-staging-plan.md](managed-staging-plan.md)).
- **Blank-project bootstrap:** UNVERIFIED.
- **Real GitHub:** BLOCKED.
- **Paid Claude comparison:** BLOCKED.
- **Owner acceptance of residual CVE risk:** pending.
- **Publication** (pushing the branch, tags, packages, visibility): the owner's decision.
