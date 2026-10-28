# Release manifest (v0.1.0-rc.1, core scope)

Two commits matter, and they are different:
- the **validated source commit** is the tree that was tested and that the release ships as
  source;
- the **artifact build commit** is the tree the runtime image, npm packages and schema bundle
  were built from.

| Item | Value |
|---|---|
| Version | `0.1.0-rc.1` |
| Validated source commit (source and script validation) | `82f5bcab572575a57a35131fb5ff5c73412a3d30` on `publication/v0.1.0-rc1`. Full suite passed in Cloud Build `c0b37f6c` (180 tests, including the 19 cases of `tests/unit/gate-identities.test.ts`) |
| Artifact build commit (runtime image, npm packages, schema bundle) | `765be87bc00464c34a5fc41abd416905b8ad9f3f`, built, scanned and install-tested by release `9fd981db` |
| Source difference between the two | `infra/gcp/gate-identities.sh` (project-targeting fix), `tests/unit/gate-identities.test.ts` (its regression test), and documentation. Neither file is in the image build context (the `.dockerignore` allowlist admits only `packages`, `apps`, `fixtures`, `examples` and the root manifests) or in any package's `files`, so the artifacts built from `765be87` are the release artifacts. Their revision label is `765be87` |
| Final documentation commit | the commit on `publication/v0.1.0-rc1` that records the manifest check below (documentation only) |
| Supported artifacts | runtime image `<registry>/vap/vap@sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849`; npm packages `@verified-action-protocol/protocol`, `/core`, `/sdk`, `/store-postgres`, `/adapters` `0.1.0-rc.1` (built and install-tested from tarballs, not published; scope ownership not confirmed, see [publication-plan.md](publication-plan.md)); schema bundle `vap-schemas-0.1.tar.gz` |
| Experimental artifact (not published) | worker-browser image `<registry>/vap/vap-worker-browser@sha256:dfbd09fd917f09491ed4969970e68a171ce404cdab860dfebca1fd5131c0d850` |
| Artifact checksums | `SHA256SUMS` from release `9fd981db` (26 artifacts, including sanitized `public-*` copies and the consumer-install report); table below |
| Gate evidence | [candidate-evidence.md](candidate-evidence.md) |
| Private mapping | the publication tree is identical to a commit on the private development branch; the mapping is in the operator-only index |

### Unchanged artifacts (checked 2026-10-28, read-only)

- Release `9fd981db` recorded build commit `765be87…` and pushed both images under that commit's
  tag with the digests above. Both digests resolve in the registry.
- The tarballs and schema bundle stored with that release match its `SHA256SUMS`:

| SHA-256 | File |
|---|---|
| `d3d6031dce3ca433a516b46e3fd1f52904fa5c0a6cd4e1b91a8e4752fe9334eb` | `verified-action-protocol-protocol-0.1.0-rc.1.tgz` |
| `bed28672f1325ac5bb319487faef0a09e8ae8530f84dae66883e0bbd9ae7d184` | `verified-action-protocol-core-0.1.0-rc.1.tgz` |
| `e31f8f5fde198006b11e417895e79b6621a8c36b2cb8b36923ffcea07dfe810d` | `verified-action-protocol-sdk-0.1.0-rc.1.tgz` |
| `70bb7de2f588451e9ddeb67fd8f36c58ff58210d16fdc3f9b67ce656f89d93f9` | `verified-action-protocol-store-postgres-0.1.0-rc.1.tgz` |
| `a1c30270f2d7db9bd3c97a5c01aa6283025680755bd96240dd47858ae6f6f427` | `verified-action-protocol-adapters-0.1.0-rc.1.tgz` |
| `4149ae8d4aa463decce5806e8c4678c5b99db134d88a6620263aeb99603b8434` | `vap-schemas-0.1.tar.gz` |

## Diff between the validated code and the final tree

`bash scripts/vap-cloud.sh manifest --tested <sha> --images <digests>` runs
`scripts/release-manifest.mjs` in Cloud Build against the publication branch's own history. It
fails unless:
- the validated commit is an ancestor of the final tree;
- every changed path is documentation (`docs/**` or `*.md`);
- every documented `scripts/vap-cloud.sh` command and `infra/gcp` pipeline exists in the
  validated commit.

## Manifest check result

Cloud Build `b41371cc-fd34-4938-9ac6-1941536423ca`, on branch `publication/v0.1.0-rc1`, checked
validated source commit `82f5bcab572575a57a35131fb5ff5c73412a3d30` against documentation commit
`0de4720b1dd715517ec3db350674be04aa000291` and passed:
- the validated commit is an ancestor;
- 2 commits after it, 6 files changed, 0 outside documentation;
- 0 documented-command problems;
- the image digests recorded are the runtime and worker-browser digests above;
- the tree's identifier scan is clean (277 files).

It superseded check `ffc82a0e` (validated commit `765be87` against `56641bc`).

The validated source commit's history up to `765be87` was scanned in strict mode by release
`9fd981db`. The later commits change `infra/gcp/gate-identities.sh`,
`tests/unit/gate-identities.test.ts` and documentation; the final tree that contains them was
scanned by this check.

| Status | Path |
|---|---|
| M | docs/deployment-gcp.md |
| M | docs/release-notes-0.1.0-rc.1.md |
| M | docs/release/candidate-evidence.md |
| M | docs/release/managed-gate-identity-plan.md |
| M | docs/release/manifest.md |
| M | docs/release/publication-plan.md |

The commit that adds this section changes only documentation (this file and the decision packet
in [publication-plan.md](publication-plan.md), section 8). Its own check is not run; its diff
against `0de4720` is recorded in the operator-only index.
