# Release candidate evidence index

Sanitized for the public repository:
- `<registry>` stands for the owner's private Artifact Registry path.
- Runs are identified by Cloud Build id and run label.
- Images are identified by digest, which is sufficient to verify them.
- The exact registry path, project, identities and evidence-object locations are in the
  operator-only index, kept in the private evidence bucket and not in this repository.

Nothing has been published to a package registry or public channel, and repository visibility is
unchanged.

## Candidate

| Item | Value |
|---|---|
| Tested source commit | `b85d442db55e3c9cd183789641339d5a20ad6ecb` |
| Runtime image | `<registry>/vap/vap@sha256:6bac81edf14a6c247d324a5b666dfe06aba9d1dbf30198063707f8d8732a021a` |
| Worker-browser image | `<registry>/vap/vap-worker-browser@sha256:2eb3847db93149e1357fb390ec660d101e48f18e94e4c36331b517e7106e6291` |
| Image revision label | `org.opencontainers.image.revision=b85d442db55e3c9cd183789641339d5a20ad6ecb` (checked by the image gate and the staging rehearsal) |
| Later commits | documentation only; see [manifest.md](manifest.md) |

## Gates on the tested commit

Every run below was submitted from a fresh `git clone` with `scripts/vap-cloud.sh`.

| Gate | Command | Cloud Build | Result |
|---|---|---|---|
| Full suite | `test --suite all` | `8446aedb-b0d4-4507-97b8-d91bfc2377fd` | PASS: 151 tests, 0 failed, 0 skipped, as aggregated by the evidence step. Includes the exit-propagation negative controls, the pipeline consistency tests, conformance, faults, security, MCP, browser and demo tests, plus the deterministic benchmark |
| Demo suite | `test --suite demo` | `2738a3f9-9520-4d27-92d0-78815fc6856e` | PASS: 81 tests; demo sequence 8/8 steps; 180-run comparison ([results](../demo/ci-failure-results.md)) |
| Release build | `release` | `f73e18d3-cd85-425f-a5f2-fd22b8d5800f` | PASS (details below) |
| Image gate | `image-gate --image <runtime digest>` | `c9bba95d-16ad-417a-b9ce-bbe793c293bc` | PASS: revision label equals the commit; `docker run` exit propagation verified; demo sequence 8/8 and scenarios 9/9 with the API and worker from the image |
| Staging rehearsal (ephemeral) | `staging-rehearsal --image <runtime digest>` | `0395220b-e431-46a1-82aa-d5dc0fc027ad` | PASS ([staging-rehearsal.md](staging-rehearsal.md)) |
| Clean-room quickstart demo | `demo` | `d97cf09a-d9f4-4728-b06d-20addc9627af` | PASS |
| Clean-room tutorial | `tutorial` | `6fe6bfcb-cc92-4cf4-a5a6-5ce3ef5ea463` | PASS: custom action verified from saved state; task verified complete; request-key replay returned the same operation |
| Clean-room integration | `test --suite integration` | `874d389f-f1eb-4b84-8afb-be8cbc855cf0` | PASS: 122 tests |

**Release build details:**
- Archive secret scan: clean. Owner identifiers in the tree: none.
- Full-history scan: no secrets. Owner identifiers in history: **3 commits (advisory; publication
  blocker)**.
- Build, typecheck and unit tests.
- Both images pushed by digest.
- Chromium launch smoke test inside the worker-browser image.
- Trivy: 0 fixable HIGH/CRITICAL findings and no secrets in either image. The full inventory,
  including findings without a fix, is in
  [../security/vulnerability-dispositions.md](../security/vulnerability-dispositions.md): 12 CVEs
  in the runtime image, 42 in the worker-browser image.
- CycloneDX image SBOMs and a license inventory.
- 5 npm package tarballs and the schema bundle (built, not published).
- `SHA256SUMS`.
- Signed SLSA provenance v0.1 and v1 from `https://cloudbuild.googleapis.com/GoogleHostedWorker`
  (verify with `gcloud artifacts docker images describe <image@digest> --show-provenance`).

**Staging rehearsal:**
- Migrations ran as the migration role; the runtime role was refused DDL.
- The image refused production with isolated test mode, and production with demo authentication.
- OIDC: a wrong-audience, an expired and an unsigned token were each rejected with 401.
- A valid token's operation was verified.
- Mid-flight disruption: one operation awaiting verification and one with a lost reply. The API
  and worker were then SIGKILLed and the database container replaced.
- After restart, the pre-crash operation was still present and verified. The verification
  operation shows two `verification.started` events (interrupted, then resumed) and ended
  verified. The lost-reply operation was resolved by reconciliation with one attempt and verified;
  whether that happened before or after the crash cannot be told from its events. No operation was
  resubmitted.
- Cleanup left no labelled container or volume.
- Tokens came from a rehearsal-local issuer. Google-signed tokens for the build identity need
  `roles/iam.serviceAccountTokenCreator`, which is not granted.

## Superseded and non-passing runs (kept for the record)

| Run | Commit | Status |
|---|---|---|
| `6891ab9b`, `e85838d0`, `cd7c6639`, `eaa3cea9` | `8833feb` | passed; superseded |
| `f3b9c3b8`, `c9f85146`, `e9d71498`, `27320a84` | `35431e1` | passed; superseded (the worker-browser image on the full base had 660 package findings) |
| `7cd320a6` | `35431e1` | **FAILED**: staging identity step (`--include-email` refused for Cloud Build credentials) |
| `1dfa2746`, `0b3850e0` | debug | **FAILED**: metadata identity endpoint absent (404); IAM Credentials API refused (403) |
| `657899cf` | debug | passed (debug run of the staging pipeline, not evidence) |
| clean-room `5595fef` demo | `5595fef` | **FAILED before any step**: undeclared-reference substitution (fixed; covered by a unit test) |
| `5a865ed5` | `5939dd8` | reported success but 1 of 24 tests failed (masked); **not a passing gate** ([../process-deviations.md](../process-deviations.md)) |
| `202fca54` | `5939dd8` | cancelled |
| `84f04bc5` | `b560899` | hygiene failed (file outside the allowlist); fixed |

## Not covered

- **Managed-service staging deployment:** BLOCKED ([staging-rehearsal.md](staging-rehearsal.md)).
- **Real GitHub:** BLOCKED ([../demo/real-github-setup.md](../demo/real-github-setup.md)).
- **Paid Claude comparison:** BLOCKED on model access and a spending ceiling.
- **Publication, tags, package publishing and visibility changes:** not done; they need the
  owner's decision.
