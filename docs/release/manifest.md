# Release manifest (v0.1.0-rc.1, core scope)

Two commits matter, and they are different:
- the **validated source commit** is the tree that was tested and that the release ships as
  source;
- the **artifact build commit** is the tree the runtime image, npm packages and schema bundle
  were built from.

| Item | Value |
|---|---|
| Version | `0.1.0-rc.1` |
| Validated source commit (the source the release ships) | `b55d1cc943038a21af1da92241158a0598e19808` on `publication/v0.1.0-rc1`. Full suite passed in Cloud Build `1c16c003` (184 tests: unit 86, integration 69, browser 5, demo 24). Quickstart check passed on it (`5d858653`). Earlier validated source commit: `82f5bca` (`c0b37f6c`, 180 tests) |
| Artifact build commit (runtime image, npm packages, schema bundle) | `765be87bc00464c34a5fc41abd416905b8ad9f3f`, built, scanned and install-tested by release `9fd981db` |
| Source difference between the two | `infra/gcp/gate-identities.sh` (project-targeting fix) and its regression test; `examples/quickstart/*` and `examples/connect/*`; `infra/gcp/cloudbuild.quickstart.yaml`, `infra/gcp/cloudbuild.publish.yaml` and their `scripts/vap-cloud.sh` commands; `release-allowlist.txt`; documentation. None is in the image or a package: the image build copies only `packages`, `apps`, `fixtures`, `examples/config` and the root manifests (the `.dockerignore` allowlist), and every package's `files` lists only its build output (plus schemas, examples and migrations). So the artifacts built from `765be87` are the release artifacts. Their revision label is `765be87` |
| Documentation commit checked by the manifest check | the commit that adds this text; the result is recorded below in the next commit |
| Final documentation-only commit | the tip of `publication/v0.1.0-rc1`, which records the manifest check result. It changes documentation only and is **not** itself checked by the manifest check; the publication dry run runs on it. Its id is stated with the release; the tag goes on it |
| Public destinations (planned, [publication-plan.md](publication-plan.md) section 9) | `ghcr.io/arajgor1/verified-action-protocol@sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849` (tag `0.1.0-rc.1`, digest preserved by the copy); npm `@verified-action-protocol/*@0.1.0-rc.1` (dist-tag `next`); GitHub `arajgor1/verified-action-protocol`, tag `v0.1.0-rc.1` |
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

Pending: the check runs with `--tested b55d1cc` against the commit that adds this text. Its
result is recorded in the next commit, which changes only documentation.

Earlier checks: `b41371cc` (validated commit `82f5bca` against `0de4720`, passed) and `ffc82a0e`
(`765be87` against `56641bc`).
