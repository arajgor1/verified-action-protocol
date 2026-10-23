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

The result of that check is recorded below.
