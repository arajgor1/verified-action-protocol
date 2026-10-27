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
| Validated commit | `fb4942620e396f71a4972bbea56e5d7c75fe11e0` on branch `publication/v0.1.0-rc1` (10 commits reachable at validation) |
| Version | `0.1.0-rc.1` (npm packages, runtime build version, MCP bridge, SDK/CLI user agents) |
| Release scope | core: runtime image, npm packages, schema bundle. The browser adapter and worker-browser image are experimental and not part of the release ([../security/browser-image-assessment.md](../security/browser-image-assessment.md)) |
| Runtime image (supported) | `<registry>/vap/vap@sha256:b7ecf996a9a8c0731cc251b0cd891510a66c40a4f587cb219a38760cea0a9467`, labels `org.opencontainers.image.revision=fb49426…`, `vap.support=supported`; no Playwright; no setuid/setgid files |
| Worker-browser image (experimental, not published) | `<registry>/vap/vap-worker-browser@sha256:918e40056b7f90b38f4fc55d4063dbfc9a9ea1767b57ba5bd2f1e8967e783fc2`, `vap.support=experimental` |
| Changes since `61ed3b2` | version `0.1.0-rc.1`; `playwright` an optional peer of `@vap/adapters` and removed from the runtime image; setuid/setgid bits cleared in the runtime image; `zod` 4.6.7 (CVE-2023-54404); `bootstrap.sh` refuses to run (blank-project bootstrap excluded); rehearsal diagnostics; documentation |
| Later commits | documentation only; see [manifest.md](manifest.md) |

## Gates on the validated commit

Every run was submitted with `scripts/vap-cloud.sh` from its own fresh single-branch clone of the
publication branch, except the inspection (an ad-hoc read-only build against the image digests).

| Gate | Cloud Build | Result |
|---|---|---|
| Full suite (`test --suite all`) | `4f341fdd-45a3-4c3d-a199-27b5d70cb5de` | PASS: 161 tests, 0 failed, 0 skipped; exit-propagation negative controls; pipeline consistency tests |
| Release (`release --history-ref publication/v0.1.0-rc1 --strict-history`) | `6bf1f9da-2880-468d-a866-cebf365ab50b` | PASS (details below) |
| Image gate (runtime digest) | `bb0aba7b-6661-4124-8355-1f1a944f823b` | PASS: revision and support labels; exit propagation; demo and scenarios with the API and worker from the image |
| Ephemeral staging rehearsal (runtime digest) | `62558572-b448-4c97-b357-f51aaa543564` | PASS ([staging-rehearsal.md](staging-rehearsal.md)) |
| Browser linkage (worker-browser digest) | `92b42b7b-1a9c-408d-8f7c-4a1893e25868` | PASS ([../security/browser-image-assessment.md](../security/browser-image-assessment.md)) |
| Runtime image inspection (read-only) | `d56d4bae-822d-4875-9089-a12cabfe30f3`, `3319422a-3cff-453f-b078-fef0bb12f80c` | evidence for the [decision record](../security/runtime-decision-record.md) and the comparison with the managed-gate image (below) |

**Not rerun on this commit, with the reason:**
- **Demo comparison (180 runs):** `a54bbc0a` on `61ed3b2`. The scripted agents, fault proxy and
  fixture are unchanged since; the demo tests run in the full suite above.
- **Managed staging deployment:** `8f27612f` on `61ed3b2`, image
  `sha256:be75a82188faf47512e00f00db6d2c452067b5a5f71ef70fe410bc192afe87d6`. Not rerun because no
  new deployment spend was authorized. The two images, compared file by file (`3319422a`): 8,551
  vs 8,373 files; 0 added; 178 removed (all Playwright); 77 changed (version strings in 20
  application files, `zod` 20 files, a Debian `tzdata` update and package-manager records). The
  comparison is by content; the cleared setuid/setgid bits are mode changes, measured separately
  (12 such files before, 0 now). Whether to rerun the managed gate on the rc.1 image is an owner
  decision ([publication-plan.md](publication-plan.md)).
- **Clean-room onboarding:** `d97cf09a`, `6fe6bfcb`, `874d389f` on `b85d442`, in a preconfigured
  project; the quickstart's commands are unchanged since.

**Release details (`6bf1f9da`):**
- Scans for secret classes and owner identifiers found nothing in the source archive, the full
  history reachable from the publication branch (strict mode), every file of the five package
  tarballs and the schema bundle, and the configuration and history of both images.
- The Chromium launch smoke test passed inside the worker-browser image.
- Trivy: 0 fixable HIGH/CRITICAL findings and no secrets in either image. Unfixed: 12 CVEs in the
  runtime image (each in the [decision record](../security/runtime-decision-record.md)), 41 in
  the worker-browser image ([../security/vulnerability-dispositions.md](../security/vulnerability-dispositions.md)).
  Owner acceptance is pending.
- CycloneDX SBOMs, license inventory, package tarballs `vap-*-0.1.0-rc.1.tgz`, schema bundle.
- Sanitized `public-*` copies of the SBOMs, scan reports, vulnerability inventories and license
  inventory; the private originals are kept beside them.
- `SHA256SUMS` lists all 25 artifacts by base name.
- Signed SLSA provenance from `https://cloudbuild.googleapis.com/GoogleHostedWorker`.

## Superseded and non-passing runs (kept for the record)

| Run | Commit | Status |
|---|---|---|
| `1e096bd6`, `2017dc04`, `e724ce2d`, `2e3e5ff1` | `d3008a9` | passed; superseded. The read-only inspection `2c1de6e5` of its runtime image found Playwright still present (npm keeps it as `devOptional`) and 12 setuid/setgid files; both fixed in `fb49426` |
| `91e481f0` | `d3008a9` | **FAILED**: staging rehearsal, step `start-disrupted-operations`. The reason went to a report that Cloud Build does not upload for failed builds, so it is **unexplained**; the rehearsal now prints the report tail on failure, and it passed on `fb49426` (`62558572`) |
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
