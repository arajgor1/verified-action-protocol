# Publication plan and inventory: VAP 0.1.0-rc.1 (prepared, not executed)

Nothing below has been done. Nothing has been pushed, tagged, published or posted, no repository
visibility has changed, and no residual security risk has been accepted. Each step needs the
owner's approval (section 6).

## 1. Source, image and package mapping

| Item | Value |
|---|---|
| Branch | `publication/v0.1.0-rc1` (local only). Its own history: root `5df8873` (validated tree of the first candidate), then the commits listed in [manifest.md](manifest.md). Commit identities: `arajgor1 <arajgor1@users.noreply.github.com>` only, with `Co-Authored-By` and `Signed-off-by` trailers |
| Validated source commit | `765be87bc00464c34a5fc41abd416905b8ad9f3f` |
| Repository-tree commit | the documentation-only commit at the tip of that branch that records the manifest check ([manifest.md](manifest.md)); proposed tag `v0.1.0-rc.1` on it |
| Runtime image | `<registry>/vap/vap@sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849`, built from the validated commit by release `9fd981db`; labels `org.opencontainers.image.revision=765be87…`, `vap.support=supported`; `VAP_BUILD_VERSION=0.1.0-rc.1`; no Playwright; no setuid/setgid files. Only in the owner's private Artifact Registry |
| npm packages (built by `9fd981db`, not published) | `@verified-action-protocol/protocol`, `/core`, `/sdk`, `/store-postgres`, `/adapters`, all `0.1.0-rc.1`, files `verified-action-protocol-<name>-0.1.0-rc.1.tgz`. `/adapters` lists `playwright` only as an optional peer dependency |
| Schema bundle | `vap-schemas-0.1.tar.gz` (protocol 0.1 JSON Schemas and examples) |
| Checksums | `SHA256SUMS` of release `9fd981db` (covers private originals too; a public subset is generated at step 3) |
| License | Apache-2.0 (`LICENSE`, `NOTICE`); third-party license inventory `public-licenses.json` |
| SBOMs and scans | `public-sbom-runtime.cdx.json`, `public-sbom-source-workspaces.cdx.json`, `public-scan-runtime.txt`, `public-vulns-all-runtime.json` (sanitized copies) |
| Provenance | signed SLSA provenance recorded by Cloud Build; it names private identifiers and is **kept private**. Public build provenance is not available for this candidate (stated in the release notes); no edited copy will be published |
| Sanitized evidence | [candidate-evidence.md](candidate-evidence.md), [managed-staging-results.md](managed-staging-results.md), [../demo/ci-failure-results.md](../demo/ci-failure-results.md), [../security/runtime-decision-record.md](../security/runtime-decision-record.md), [../security/vulnerability-dispositions.md](../security/vulnerability-dispositions.md), [../acceptance.md](../acceptance.md) |
| Supported installation | a preconfigured Google Cloud project, Cloud Build only ([../quickstart.md](../quickstart.md)); optional managed deployment ([../deployment-gcp.md](../deployment-gcp.md)); npm packages per [../sdk-example.md](../sdk-example.md) once published |
| Excluded | browser adapter (experimental, disabled by default) and the worker-browser image; blank-project bootstrap; the private development branch; the operator-only index and raw evidence |

## 2. Namespace ownership (checked 2026-10-27, 15:40 UTC)

| Target | Name | Result | Ownership |
|---|---|---|---|
| npm scope | `@verified-action-protocol` | registry: `Scope not found`; no package under it | **not confirmed.** No organization exists, so nobody owns it yet; an unused scope is not a reservation. The owner must create the npm organization and confirm with `npm org ls verified-action-protocol` (logged in as themselves) |
| why it matters | | the consumer-install gate showed npm looking up the internal dependencies (`core`, `protocol`) by name in the registry; once anything is published, a scope held by someone else would serve those names | publish nothing until the scope is owned |
| npm scope | `@vap` | an unrelated publisher's organization (publishes `@vap/core`) | not ours; the docs warn against it |
| GitHub repository | `arajgor1/verified-action-protocol` | not found (account exists) | the owner's account; free to create |
| Container image | `ghcr.io/arajgor1/verified-action-protocol` | no public package | under the owner's account once pushed |

## 3. What would become public, and where

| # | What | Where (proposed) |
|---|---|---|
| P1 | the branch history and tree above | new GitHub repository `github.com/arajgor1/verified-action-protocol`, default branch `main` = `publication/v0.1.0-rc1`; created private, made public at the visibility step |
| P2 | annotated tag `v0.1.0-rc.1` on the repository-tree commit | same repository |
| P3 | GitHub **prerelease** `v0.1.0-rc.1`: release notes; assets `vap-schemas-0.1.tar.gz`, the four sanitized `public-*` files and `public-licenses.json`, and a `SHA256SUMS` covering exactly those assets | same repository |
| P4 | the runtime image, copied by digest (digest unchanged) | `ghcr.io/arajgor1/verified-action-protocol:0.1.0-rc.1` |
| P5 | the five npm packages `0.1.0-rc.1`, dist-tag `next` | npmjs.com, scope `@verified-action-protocol`, only after ownership is confirmed |
| P6 | the announcement | channel chosen by the owner; only after a clean install from npm works |

**Never public in this release:** the worker-browser image, the private Artifact Registry
repository, the evidence bucket, the operator-only index, build provenance, the private
development branch and its history.

## 4. Exact publication commands (to run only after approval)

Run from a fresh clone of the local repository, by the owner or with credentials the owner
supplies to the session at that time (never pasted into chat). `<remote>` is the new repository.

```bash
# P1, P2: private repository first, then push and tag
gh repo create arajgor1/verified-action-protocol --private --description "Verified Action Protocol (VAP): experimental execution layer for verified agent actions"
git remote add publication https://github.com/arajgor1/verified-action-protocol.git
git push publication publication/v0.1.0-rc1:main
git tag -a v0.1.0-rc.1 <repository-tree commit> -m "VAP 0.1.0-rc.1 (experimental core release candidate)"
git push publication v0.1.0-rc.1

# P3: assets from the private evidence location of release 9fd981db (operator index), checked
# against that release's SHA256SUMS, then a public SHA256SUMS of exactly these files
mkdir assets && cd assets   # download the files listed in P3 here
grep -E ' (vap-schemas-0\.1\.tar\.gz|public-.*)$' ../SHA256SUMS.release | sha256sum -c -
sha256sum vap-schemas-0.1.tar.gz public-* > SHA256SUMS
gh release create v0.1.0-rc.1 --repo arajgor1/verified-action-protocol --prerelease \
  --title "VAP 0.1.0-rc.1 (experimental)" --notes-file ../docs/release-notes-0.1.0-rc.1.md \
  vap-schemas-0.1.tar.gz public-* SHA256SUMS

# P4: copy by digest in a Cloud Build step holding a GitHub token with write:packages that the
# owner stores in Secret Manager; then check the digest is unchanged and make the package public
crane copy <registry>/vap/vap@sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849 ghcr.io/arajgor1/verified-action-protocol:0.1.0-rc.1
crane digest ghcr.io/arajgor1/verified-action-protocol:0.1.0-rc.1   # must print sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849

# P5: after `npm org ls verified-action-protocol` succeeds for the owner; tarballs from 9fd981db,
# verified with sha256sum -c against its SHA256SUMS first; dependency order
for p in protocol core store-postgres sdk adapters; do
  npm publish --tag next --access public "verified-action-protocol-$p-0.1.0-rc.1.tgz"
done
# then, in an empty directory: npm install @verified-action-protocol/sdk @verified-action-protocol/adapters
# and run examples/sdk/offline-check.mjs (docs/sdk-example.md) before announcing

# visibility, last
gh repo edit arajgor1/verified-action-protocol --visibility public --accept-visibility-change-consequences
```

npm provenance attestations need a supported CI provider (GitHub Actions); packages published
from a workstation or Cloud Build carry none, consistent with "no public provenance".

## 5. Managed gate on the final digest (prepared, not run)

Uses dedicated build identities instead of the project's default build identity, which is not
modified ([../deployment-gcp.md](../deployment-gcp.md), "Dedicated gate identities", lists every
binding and what each does not prevent). Run from a fresh clone of the branch with the operator's
`VAP_GCP_PROJECT`, `VAP_GCP_REGION` and `VAP_EVIDENCE_BUCKET`:

```bash
# 0. owner, with their own credentials (creates two service accounts and their bindings)
VAP_GCP_PROJECT=<project> VAP_SUBMITTER=<user:... or serviceAccount:... that submits builds> \
  bash infra/gcp/gate-identities.sh create
PROV=vap-gate-provisioner@<project>.iam.gserviceaccount.com
DEPL=vap-gate-deployer@<project>.iam.gserviceaccount.com
# 1. provisioning as the provisioner: runtime accounts, Cloud SQL, secrets, scoped bindings
VAP_BUILD_SERVICE_ACCOUNT=$PROV bash scripts/vap-cloud.sh managed-provision --expires $(( $(date +%s) + 4*3600 )) --deployer $DEPL
# 2. the gate, as the deployer, on the exact release digest
VAP_BUILD_SERVICE_ACCOUNT=$DEPL bash scripts/vap-cloud.sh deploy --image <region>-docker.pkg.dev/<project>/vap/vap@sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849
# 3. teardown as the deployer (rerun if IAM listing lags); if a missing permission blocks it,
#    rerun without VAP_BUILD_SERVICE_ACCOUNT, which uses the default build identity unchanged
VAP_BUILD_SERVICE_ACCOUNT=$DEPL bash scripts/vap-cloud.sh managed-teardown
# 4. optional: remove the two identities
VAP_GCP_PROJECT=<project> VAP_SUBMITTER=<same> bash infra/gcp/gate-identities.sh remove
```

**Build and deployment permissions** are those of the two gate identities, used only during the
three builds. **Application runtime permissions** are those of the six exercise accounts the
provisioning creates (`vap-api`, `vap-worker`, `vap-migrator`, `vap-fixture`, `vap-scheduler`,
`vap-smoke`), each bound on one secret, one job, one service or the one instance; they are
unchanged from the verified run.

**Cost estimate (list prices, us-central1):** about $0.30 for one clean pass: three builds on the
default machine type (about 40 build-minutes, $0.24, or within the free monthly minutes), Cloud
SQL db-f1-micro for about 1.5 hours ($0.02), and cents for Cloud Run, Scheduler and Secret
Manager. Failed attempts that need reruns could bring it to $1–2. Suggested ceiling: $5.

**Authorization this needs:** running `gate-identities.sh` (new service accounts and project IAM
bindings, a persistent change; the owner runs it or authorizes it), and the deployment spend.

## 6. Decisions that require the owner's approval

| # | Decision | Status and recommendation |
|---|---|---|
| D1 | Residual risk of the runtime image's 12 unfixed CVEs | **open.** Review the [decision record](../security/runtime-decision-record.md), including its reachability section and the three restrictions the image does not enforce. Nothing is accepted until you say so |
| D2 | npm scope `@verified-action-protocol` | the rename is done and tested from tarballs; **ownership not confirmed**: create the npm organization, then confirm |
| D3 | Managed gate on `sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849` with the dedicated identities | prepared (section 5); needs the identity creation and the spend authorized |
| D4–D5 | Repository `arajgor1/verified-action-protocol`, GHCR image name, visibility change, a GitHub token for the image copy | names kept as proposed; tokens are supplied through Secret Manager or the owner's own session, never in chat |
| D6 | Provenance | kept private; disclosed as unavailable in the release notes and announcement |
| D7 | Tag `v0.1.0-rc.1`, GitHub prerelease | as stated |
| D8 | Announcement | draft ready; post only after a clean install from npm works |
| D9 | Default build identity holds `roles/owner` | not modified; the dedicated identities in section 5 are the test of a restricted setup |
