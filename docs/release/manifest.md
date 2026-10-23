# Release manifest (v0.1.0 release candidate, core scope)

| Item | Value |
|---|---|
| Validated source commit | `5df8873f181fece8afa45b4de83ff78055f352a2`, root of `publication/v0.1.0-rc1` |
| Final documentation commit | the commit on `publication/v0.1.0-rc1` that adds this manifest (documentation only; checked below) |
| Supported artifacts | runtime image `<registry>/vap/vap@sha256:a5fc21aa469cd8f265b949a96a12cd5730c6f5bb132ea2a4f09b61ec1667f633`; npm packages `@vap/protocol`, `@vap/core`, `@vap/sdk`, `@vap/store-postgres`, `@vap/adapters` 0.1.0 (built, not published); schema bundle `vap-schemas-0.1.tar.gz` |
| Experimental artifact | worker-browser image `<registry>/vap/vap-worker-browser@sha256:1d2cd1e620d278d4608eb4c84e730d1ab7b59326ea57c51eeb938238453f1fbf` |
| Artifact checksums | `SHA256SUMS` from release `9fea3c08` (25 artifacts, including sanitized `public-*` copies) |
| Gate evidence | [candidate-evidence.md](candidate-evidence.md) |
| Private mapping | the publication tree is identical to a commit on the private development branch; the mapping is in the operator-only index |

## Diff between the validated code and the final tree

`bash scripts/vap-cloud.sh manifest --tested <sha> --images <digests>` runs
`scripts/release-manifest.mjs` in Cloud Build against the publication branch's own history. It
fails unless:
- the validated commit is an ancestor of the final tree;
- every changed path is documentation (`docs/**` or `*.md`);
- every documented `scripts/vap-cloud.sh` command and `infra/gcp` pipeline exists in the
  validated commit.

## Manifest check result

Cloud Build `343e02e0-feb8-4ab5-8c14-af41ca3fcee9`, on branch `publication/v0.1.0-rc1`, checked
validated commit `5df8873` against `7777b07` and passed:
- the validated commit is an ancestor;
- 1 commit after it, 8 files changed, 0 outside documentation;
- 0 documented-command problems;
- the tree's owner-identifier scan is clean.

The validated commit's full reachable history was scanned in strict mode by release `9fea3c08`.
Every later change is a documentation diff whose resulting tree was scanned.

| Status | Path |
|---|---|
| M | docs/demo/ci-failure-results.md |
| M | docs/demo/evidence/ci-demo-receipt.json |
| M | docs/demo/evidence/ci-demo-transcript.md |
| M | docs/process-deviations.md |
| M | docs/release/candidate-evidence.md |
| M | docs/release/manifest.md |
| M | docs/security/browser-image-assessment.md |
| M | docs/security/vulnerability-dispositions.md |

Documented dispatcher commands, all present in the validated commit: `browser-linkage`, `cleanup`, `demo`, `deploy`, `image-gate`, `lock`, `manifest`, `release`, `staging-rehearsal`, `test`, `tutorial`.

The commit that adds this section changes only this file. Its check is recorded in the
operator-only index.
