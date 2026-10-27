# Release manifest (v0.1.0-rc.1, core scope)

| Item | Value |
|---|---|
| Version | `0.1.0-rc.1` |
| Validated source commit | `765be87bc00464c34a5fc41abd416905b8ad9f3f` on `publication/v0.1.0-rc1` |
| Final documentation commit | the commit on `publication/v0.1.0-rc1` that records this manifest (documentation only; checked below) |
| Supported artifacts | runtime image `<registry>/vap/vap@sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849`; npm packages `@verified-action-protocol/protocol`, `/core`, `/sdk`, `/store-postgres`, `/adapters` `0.1.0-rc.1` (built and install-tested from tarballs, not published; scope ownership not confirmed, see [publication-plan.md](publication-plan.md)); schema bundle `vap-schemas-0.1.tar.gz` |
| Experimental artifact (not published) | worker-browser image `<registry>/vap/vap-worker-browser@sha256:dfbd09fd917f09491ed4969970e68a171ce404cdab860dfebca1fd5131c0d850` |
| Artifact checksums | `SHA256SUMS` from release `9fd981db` (26 artifacts, including sanitized `public-*` copies and the consumer-install report) |
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

Cloud Build `aebc1061-3209-4df4-b6f3-fe30373da7c2`, on branch `publication/v0.1.0-rc1`, checked
validated commit `765be87` against `6dc91c1` and passed:
- the validated commit is an ancestor;
- 1 commit after it, 9 files changed, 0 outside documentation;
- 0 documented-command problems;
- the tree's owner-identifier scan is clean (275 files).

The validated commit's full reachable history was scanned in strict mode by release `9fd981db`.
Every later change is a documentation diff whose resulting tree was scanned.

| Status | Path |
|---|---|
| M | docs/acceptance.md |
| M | docs/release-notes-0.1.0-rc.1.md |
| M | docs/release/announcement-0.1.0-rc.1.md |
| M | docs/release/candidate-evidence.md |
| M | docs/release/managed-staging-results.md |
| M | docs/release/publication-plan.md |
| M | docs/security/browser-image-assessment.md |
| M | docs/security/runtime-decision-record.md |
| M | docs/security/vulnerability-dispositions.md |

The commit that adds this section changes only this file. Its check is recorded in the
operator-only index.
