# Release manifest (v0.1.0 release candidate, core scope)

| Item | Value |
|---|---|
| Validated source commit | `61ed3b224dd666621e31768915def0355532102c` on `publication/v0.1.0-rc1` |
| Final documentation commit | the commit on `publication/v0.1.0-rc1` that records this manifest (documentation only; checked below) |
| Supported artifacts | runtime image `<registry>/vap/vap@sha256:be75a82188faf47512e00f00db6d2c452067b5a5f71ef70fe410bc192afe87d6`; npm packages `@vap/protocol`, `@vap/core`, `@vap/sdk`, `@vap/store-postgres`, `@vap/adapters` 0.1.0 (built, not published); schema bundle `vap-schemas-0.1.tar.gz` |
| Experimental artifact | worker-browser image `<registry>/vap/vap-worker-browser@sha256:eb1a00875a1c9c039c1a380ee8a7872fa7127554d6e3a47fc946f95cf08a0628` |
| Artifact checksums | `SHA256SUMS` from release `d983d01e` (25 artifacts, including sanitized `public-*` copies) |
| Gate evidence | [candidate-evidence.md](candidate-evidence.md); managed staging: [managed-staging-results.md](managed-staging-results.md) |
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

Pending: recorded when the check runs on the documentation commit.
