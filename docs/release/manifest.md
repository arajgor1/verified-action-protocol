# Release manifest (v0.1.0-rc.1, core scope)

| Item | Value |
|---|---|
| Version | `0.1.0-rc.1` |
| Validated source commit | `fb4942620e396f71a4972bbea56e5d7c75fe11e0` on `publication/v0.1.0-rc1` |
| Final documentation commit | the commit on `publication/v0.1.0-rc1` that records this manifest (documentation only; checked below) |
| Supported artifacts | runtime image `<registry>/vap/vap@sha256:b7ecf996a9a8c0731cc251b0cd891510a66c40a4f587cb219a38760cea0a9467`; npm packages `@vap/protocol`, `@vap/core`, `@vap/sdk`, `@vap/store-postgres`, `@vap/adapters` `0.1.0-rc.1` (built, not published; the `@vap` scope is not available, see [publication-plan.md](publication-plan.md)); schema bundle `vap-schemas-0.1.tar.gz` |
| Experimental artifact (not published) | worker-browser image `<registry>/vap/vap-worker-browser@sha256:918e40056b7f90b38f4fc55d4063dbfc9a9ea1767b57ba5bd2f1e8967e783fc2` |
| Artifact checksums | `SHA256SUMS` from release `6bf1f9da` (25 artifacts, including sanitized `public-*` copies) |
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

Pending: recorded when the check runs on the documentation commit.
