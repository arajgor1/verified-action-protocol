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
| Validated source commit | `b55d1cc943038a21af1da92241158a0598e19808` on branch `publication/v0.1.0-rc1`: full suite passed (`1c16c003`, 184 tests) and the quickstart check passed (`5d858653`). It differs from the artifact build commit by the gate-identities script fix and its test, the quickstart and connect examples, the quickstart and publication pipelines, and documentation, none of which is in the image or packages ([manifest.md](manifest.md)) |
| Artifact build commit | `765be87bc00464c34a5fc41abd416905b8ad9f3f` (16 commits reachable at its validation): the gates below ran on it, and the image and packages were built from it |
| Version | `0.1.0-rc.1` (npm packages, runtime build version, MCP bridge, SDK/CLI user agents) |
| Package names | `@verified-action-protocol/protocol`, `/core`, `/sdk`, `/store-postgres`, `/adapters` (renamed from `@vap/*`, a scope owned by an unrelated publisher). npm scope ownership is **not confirmed** ([publication-plan.md](publication-plan.md), section 2) |
| Release scope | core: runtime image, npm packages, schema bundle. The browser adapter and worker-browser image are experimental and not part of the release ([../security/browser-image-assessment.md](../security/browser-image-assessment.md)) |
| Runtime image (supported) | `<registry>/vap/vap@sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849`, labels `org.opencontainers.image.revision=765be87…`, `vap.support=supported`; no Playwright; no setuid/setgid files |
| Worker-browser image (experimental, not published) | `<registry>/vap/vap-worker-browser@sha256:dfbd09fd917f09491ed4969970e68a171ce404cdab860dfebca1fd5131c0d850`, `vap.support=experimental` |
| Changes since `fb49426` | package scope `@verified-action-protocol`; consumer-install gate in the release pipeline and the documented SDK example; the browser adapter's test-only `launch` option no longer exposes Playwright types; dispatcher support for a dedicated build identity and the provisioning `--deployer` option (managed gate, prepared); the staging rehearsal waits for PostgreSQL over TCP; documentation |
| Later commits | documentation only; see [manifest.md](manifest.md) |

## Gates on the artifact build commit

Every run was submitted with `scripts/vap-cloud.sh` from its own fresh single-branch clone of the
publication branch, except the inspection (an ad-hoc read-only build against the image digests).

| Gate | Cloud Build | Result |
|---|---|---|
| Full suite (`test --suite all`) | `e6408b5a-979a-48fc-838c-e2f785388e38` | PASS: 161 tests, 0 failed, 0 skipped; exit-propagation negative controls; pipeline consistency tests |
| Release (`release --history-ref publication/v0.1.0-rc1 --strict-history`) | `9fd981db-24f0-4675-b1bd-0363512f7b15` | PASS (details below), including the consumer install |
| Image gate (runtime digest) | `8f320a3b-87e0-47bf-9c42-eb95b2ddb4d7` | PASS: revision and support labels; exit propagation; demo and scenarios with the API and worker from the image |
| Ephemeral staging rehearsal (runtime digest) | `9736a54b-b9ba-4674-97f9-f6c555e85a7c` | PASS ([staging-rehearsal.md](staging-rehearsal.md)) |
| Runtime image inspection (read-only) | `c1838d77-0240-40ef-8eac-a249920b01cd` | same OS packages, security properties and mapped libraries as the first rc.1 image `sha256:b7ecf996…`; differences: 9 files renamed from `@vap` to `@verified-action-protocol`, 120 recompiled or relabelled files ([decision record](../security/runtime-decision-record.md)) |

**Consumer install (release step `consumer-install`, report `consumer-install.txt`):** the five
tarballs installed with default options into an empty project with its own `HOME` and npm cache.
Registry lookups for the scope were pointed at an unreachable address: npm tried 9 such lookups
(for the transitive `core` and `protocol` dependencies), they failed, and every scoped package
resolved from its local tarball. So, once published, internal dependencies resolve by name from
the registry; the scope must be owned before anything is published. `npm ls` showed
`UNMET OPTIONAL DEPENDENCY playwright@1.63.0`; no `playwright`, `playwright-core`, browser cache or
Chromium was installed. The `vap` and `vap-migrate` bin entries were installed. The SDK example
loaded the tutorial configuration (7 actions), found 0 conformance findings and computed the
canonical digest; it skipped the client call (no deployed API). `typecheck.ts` compiled with
`skipLibCheck` off and no Playwright installed. **Scope of this check:** it installed local
tarballs, not packages from the npm registry, and ran the SDK example offline. Two end-to-end
checks remain, not yet run ([publication-plan.md](publication-plan.md), section 4):
- E1: a fresh install from the public npm registry;
- E2: a live SDK call against the final managed image.

**Not rerun on this commit, with the reason:**
- **Browser linkage:** `92b42b7b` on `fb49426`. The browser image is excluded from the release.
- **Demo comparison (180 runs):** `a54bbc0a` on `61ed3b2`. The scripted agents, fault proxy and
  fixture are unchanged apart from import names; the demo tests run in the full suite above.
- **Managed staging deployment on the final digest** (Plan B, a disposable project,
  [managed-staging-results.md](managed-staging-results.md)). It ran with the dedicated gate
  identities, not an Owner build identity. Image copy `62771f6b` kept the digest.
  - Attempt 1: provision `c3931405`, deploy `11ac6b7a` **PASSED** (all 16 steps), E2 `11091b3e`
    **FAILED** (a defect in the E2 check's token minting; no SDK call was made), teardown
    `ad3630cc`.
  - Attempt 2: provision `48a1f268`, deploy `8d0fce40` **FAILED** at `scheduler-trigger` (Cloud
    Scheduler received 401 from the Cloud Run Admin API; unresolved, probable cause recorded),
    E2 `7fac42d8` **PASSED**, teardown `4270bbcf`.

  The project is `DELETE_REQUESTED` (deletion requested, not completed).
- **Release preparation on `b55d1cc` (validated source commit).** Docker Compose quickstart
  and SDK connect example, checked in a fresh environment with the release image by digest and
  the release tarballs ([quickstart-results.md](quickstart-results.md): `44bd2c7e` on `6b375d1`
  and `5d858653` on `b55d1cc` passed; `9b29bc3b` and `fd1bd623` failed and were fixed). Full
  suite `1c16c003` (184 tests). Publication dry run `c9360016` on `0b8be52`: asset checksums,
  history identifier scan (34 commits, clean), npm names free, image copy with digest preserved
  (to a private test path, deleted afterwards). A full-suite run on `0b8be52` (`1ccbc6e4`) was
  cancelled when `b55d1cc` superseded it.
- **Successor candidate `82f5bca` (earlier validated source commit).** It fixes the project targeting
  of `infra/gcp/gate-identities.sh` and adds `tests/unit/gate-identities.test.ts`. Neither file
  is in the image build context or the npm packages.
  - The full suite on `4d50c16` (`75c210a7`) failed in the unit step because of a defect in the
    new test.
  - The corrected test is in `82f5bca`; the full suite passed there (`c0b37f6c`, 180 tests).
  - Manifest check: [manifest.md](manifest.md). Details: [publication-plan.md](publication-plan.md),
    section 7. The previous image's run
  is `8f27612f` on `61ed3b2`.
- **Clean-room onboarding:** `d97cf09a`, `6fe6bfcb`, `874d389f` on `b85d442`, in a preconfigured
  project; the quickstart's commands are unchanged since.

**Release details (`9fd981db`):**
- Scans for secret classes and owner identifiers found nothing in the source archive, the full
  history reachable from the publication branch (strict mode), every file of the five package
  tarballs and the schema bundle, and the configuration and history of both images.
- The Chromium launch smoke test passed inside the worker-browser image.
- Trivy: 0 fixable HIGH/CRITICAL findings and no secrets in either image. Unfixed: the same 12 CVEs
  in the runtime image as before (each in the [decision record](../security/runtime-decision-record.md)),
  41 in the worker-browser image ([../security/vulnerability-dispositions.md](../security/vulnerability-dispositions.md)).
  Owner acceptance is pending.
- CycloneDX SBOMs, license inventory, package tarballs `verified-action-protocol-*-0.1.0-rc.1.tgz`,
  schema bundle, consumer-install report.
- Sanitized `public-*` copies of the SBOMs, scan reports, vulnerability inventories and license
  inventory; the private originals are kept beside them.
- `SHA256SUMS` lists all 26 artifacts by base name. Package tarballs and schema bundle:

  | File | SHA-256 |
  |---|---|
  | `verified-action-protocol-protocol-0.1.0-rc.1.tgz` | `d3d6031dce3ca433a516b46e3fd1f52904fa5c0a6cd4e1b91a8e4752fe9334eb` |
  | `verified-action-protocol-core-0.1.0-rc.1.tgz` | `bed28672f1325ac5bb319487faef0a09e8ae8530f84dae66883e0bbd9ae7d184` |
  | `verified-action-protocol-sdk-0.1.0-rc.1.tgz` | `e31f8f5fde198006b11e417895e79b6621a8c36b2cb8b36923ffcea07dfe810d` |
  | `verified-action-protocol-store-postgres-0.1.0-rc.1.tgz` | `70bb7de2f588451e9ddeb67fd8f36c58ff58210d16fdc3f9b67ce656f89d93f9` |
  | `verified-action-protocol-adapters-0.1.0-rc.1.tgz` | `a1c30270f2d7db9bd3c97a5c01aa6283025680755bd96240dd47858ae6f6f427` |
  | `vap-schemas-0.1.tar.gz` | `4149ae8d4aa463decce5806e8c4678c5b99db134d88a6620263aeb99603b8434` |

- Signed SLSA provenance from `https://cloudbuild.googleapis.com/GoogleHostedWorker`, kept
  private (it names private identifiers); no public provenance for this candidate.

## Superseded and non-passing runs (kept for the record)

| Run | Commit | Status |
|---|---|---|
| `2d562e8e`, `34420b84`, `35b5b2ff`, `77425596` (inspection) | `47bff9e` | passed (suite, release with consumer install, image gate); superseded by `765be87` |
| `4ec46176` | `47bff9e` | **FAILED**: staging rehearsal, step `database`, before the VAP image ran: `pg_isready` over the socket succeeded, then `psql` found no socket. Explained by the log and the PostgreSQL image's behaviour (a temporary socket-only server during first-start initialisation); the rehearsal now waits over TCP like every other pipeline (`765be87`). This does **not** explain `91e481f0` below, which failed in a different step |
| `22a40ffe` | `ae323ba` | passed (full suite); superseded |
| `c362c236` | `ae323ba` | **FAILED**: release, step `consumer-install`, on a defect in the new check (it counted npm's `UNMET OPTIONAL DEPENDENCY playwright` line as an installation); fixed in `47bff9e` |
| `4f341fdd`, `6bf1f9da`, `bb0aba7b`, `62558572`, `92b42b7b`, `d56d4bae`, `3319422a`, `8f36d50e` (manifest) | `fb49426` | passed; superseded by `765be87` (package rename) |
| `1e096bd6`, `2017dc04`, `e724ce2d`, `2e3e5ff1` | `d3008a9` | passed; superseded. The read-only inspection `2c1de6e5` of its runtime image found Playwright still present (npm keeps it as `devOptional`) and 12 setuid/setgid files; both fixed in `fb49426` |
| `91e481f0` | `d3008a9` | **FAILED, unexplained**: staging rehearsal, step `start-disrupted-operations`. The reason went to a report that Cloud Build does not upload for failed builds. The rehearsal now prints the report tail on failure. Later passes (`62558572`, `9736a54b`) do not explain it; it remains unresolved historical evidence |
| `919be049` | `2019140` | passed (full suite) |
| `4ce77bf8` | `2019140` | **FAILED** (correctly): release scan found fixable HIGH CVE-2023-54404 in `zod` 4.6.5, newly listed in the vulnerability database; fixed with `zod` 4.6.7. The same `zod` version is in the earlier images, including the managed-gate image |
| `602911a6`, `a54bbc0a`, `d983d01e`, `8b0c76f6`, `a4dae530`, `8f27612f`, `e333db2c`, `ad9e97a1` | `61ed3b2` | passed; superseded by `fb49426` (the demo comparison and the managed gate are not rerun; see above) |
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

- **Blank-project bootstrap:** excluded from the supported release (`bootstrap.sh` refuses to run
  unless explicitly overridden).
- **Real GitHub:** BLOCKED.
- **Paid Claude comparison:** BLOCKED.
- **Owner acceptance of residual CVE risk:** pending ([decision record](../security/runtime-decision-record.md)).
- **Publication** (repository, tag, packages, image, announcement): the owner's decision
  ([publication-plan.md](publication-plan.md)).
