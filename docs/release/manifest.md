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

Cloud Build `ad9e97a1-ecc0-4e5d-9616-36d39c4c86b9`, on branch `publication/v0.1.0-rc1`, checked
validated commit `61ed3b2` against `354d97d` and passed:
- the validated commit is an ancestor;
- 1 commit after it, 10 files changed, 0 outside documentation;
- 0 documented-command problems;
- the tree's owner-identifier scan is clean (266 files).

The validated commit's full reachable history was scanned in strict mode by release `d983d01e`.
Every later change is a documentation diff whose resulting tree was scanned.

| Status | Path |
|---|---|
| M | docs/acceptance.md |
| M | docs/demo/ci-failure-results.md |
| M | docs/demo/evidence/ci-demo-receipt.json |
| M | docs/demo/evidence/ci-demo-transcript.md |
| M | docs/release/candidate-evidence.md |
| M | docs/release/managed-staging-results.md |
| M | docs/release/manifest.md |
| M | docs/release/staging-rehearsal.md |
| M | docs/security/browser-image-assessment.md |
| M | docs/security/vulnerability-dispositions.md |

The commit that adds this section changes only this file. Its check is recorded in the
operator-only index.
