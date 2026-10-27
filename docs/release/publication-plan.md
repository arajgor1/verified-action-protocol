# Publication plan and inventory: VAP 0.1.0-rc.1 (prepared, not executed)

Nothing below has been done. Nothing has been pushed, tagged, published or posted, and no
repository visibility has changed. Each step needs the owner's approval (last section).

## 1. Inventory

| Item | Value |
|---|---|
| Branch | `publication/v0.1.0-rc1` (local only). Its own history: root `5df8873` (validated tree of the first candidate), then the commits listed in [manifest.md](manifest.md). Commit identities: `arajgor1 <arajgor1@users.noreply.github.com>` only, with `Co-Authored-By` and `Signed-off-by` trailers |
| Repository-tree commit | the documentation-only commit at the tip of that branch that records the manifest check ([manifest.md](manifest.md)); proposed tag `v0.1.0-rc.1` on it |
| Validated runtime source commit | `fb4942620e396f71a4972bbea56e5d7c75fe11e0` |
| Runtime image | `sha256:b7ecf996a9a8c0731cc251b0cd891510a66c40a4f587cb219a38760cea0a9467`, revision label `fb49426…`, `vap.support=supported`, `VAP_BUILD_VERSION=0.1.0-rc.1`; currently only in the owner's private Artifact Registry |
| Packages (built, not published) | `@vap/protocol`, `@vap/core`, `@vap/sdk`, `@vap/store-postgres`, `@vap/adapters`, all `0.1.0-rc.1` (`vap-*-0.1.0-rc.1.tgz`). `@vap/adapters` lists `playwright` only as an optional peer dependency. **The `@vap` npm scope belongs to another publisher** (see section 2) |
| Schema bundle | `vap-schemas-0.1.tar.gz` (protocol 0.1 JSON Schemas and examples) |
| Checksums | `SHA256SUMS` from release `6bf1f9da` (25 artifacts; includes private originals, so a public subset must be generated, see step 4) |
| License | Apache-2.0 (`LICENSE`, `NOTICE`); third-party license inventory `public-licenses.json` |
| SBOMs and scans | `public-sbom-runtime.cdx.json`, `public-sbom-source-workspaces.cdx.json`, `public-scan-runtime.txt`, `public-vulns-all-runtime.json` (sanitized copies) |
| Provenance | signed SLSA provenance recorded by Cloud Build for both images. It names the owner's project, build identity and storage locations, so it cannot be sanitized without breaking its signature (decision D6) |
| Sanitized evidence report | in the repository: [candidate-evidence.md](candidate-evidence.md), [managed-staging-results.md](managed-staging-results.md), [../demo/ci-failure-results.md](../demo/ci-failure-results.md), [../security/runtime-decision-record.md](../security/runtime-decision-record.md), [../security/vulnerability-dispositions.md](../security/vulnerability-dispositions.md), [../acceptance.md](../acceptance.md) |
| Supported installation path | a preconfigured Google Cloud project, Cloud Build only ([../quickstart.md](../quickstart.md)); optional managed deployment ([../deployment-gcp.md](../deployment-gcp.md)) |
| Known limitations | [../release-notes-0.1.0-rc.1.md](../release-notes-0.1.0-rc.1.md) ("What has not been run", "Limitations"), [../limitations.md](../limitations.md) |
| Excluded | browser adapter (experimental, disabled by default) and the worker-browser image; blank-project bootstrap; the private development branch; the operator-only index and raw evidence |

## 2. Name availability (checked 2026-10-27)

| Target | Name | Result |
|---|---|---|
| npm scope | `@vap` | **taken**: an existing organization of another publisher, which already publishes `@vap/core` (since 2022) and four other packages |
| npm scope | `@verified-action-protocol` | no user or organization found (appears available; an npm organization must be created by the owner) |
| npm scope | `@vaprotocol` | no user or organization found |
| npm package | `vap` (unscoped) | taken (unrelated framework) |
| npm package | `verified-action-protocol`, `vap-protocol` | not found |
| GitHub repository | `arajgor1/verified-action-protocol`, `arajgor1/vap` | not found (the account `arajgor1` exists) |
| Container image | `ghcr.io/arajgor1/vap` | no public package found |

**Consequence:** the packages cannot be published under their current names. Worse, a public
repository whose docs and imports say `@vap/core` would point readers at an unrelated package
on npm (a dependency-confusion risk). The packages must be renamed to an owned scope before npm
publication, and preferably before the repository becomes public.

## 3. What would become public, and where

| # | What | Where (proposed) |
|---|---|---|
| P1 | the branch history and tree above | new public GitHub repository `github.com/arajgor1/verified-action-protocol`, default branch `main` = `publication/v0.1.0-rc1` |
| P2 | annotated tag `v0.1.0-rc.1` on the repository-tree commit | same repository |
| P3 | GitHub prerelease `v0.1.0-rc.1`: release notes; assets `vap-schemas-0.1.tar.gz`, the sanitized SBOMs, license inventory, scan report and vulnerability inventory of the runtime image, and a public `SHA256SUMS` covering exactly those assets | same repository |
| P4 | the runtime image, copied by digest (digest unchanged) | `ghcr.io/arajgor1/verified-action-protocol:0.1.0-rc.1` (public package) |
| P5 | npm packages `0.1.0-rc.1` under the chosen scope, dist-tag `next` (not `latest`) | npmjs.com, only after the rename (decision D2) |
| P6 | the announcement | channel chosen by the owner (decision D8); draft in [announcement-0.1.0-rc.1.md](announcement-0.1.0-rc.1.md) |

**Never public in this release:** the worker-browser image, the private Artifact Registry
repository, the evidence bucket, the operator-only index, the private development branch and
its history.

## 4. Exact steps (to run only after approval)

1. **Repository** (P1, P2): create the empty repository (owner, in the GitHub UI or
   `gh repo create arajgor1/verified-action-protocol --public` only at the visibility step), then
   `git push <remote> publication/v0.1.0-rc1:main` and
   `git tag -a v0.1.0-rc.1 <repository-tree commit> -m "VAP 0.1.0-rc.1"` followed by
   `git push <remote> v0.1.0-rc.1`. Pushing to a private repository first and switching
   visibility later is the safer order.
2. **Release assets** (P3): download the listed `public-*` files and the schema bundle from the
   private evidence location, generate `SHA256SUMS` for exactly those files, check them against
   the release `SHA256SUMS`, and create the prerelease
   (`gh release create v0.1.0-rc.1 --prerelease --notes-file docs/release-notes-0.1.0-rc.1.md <files>`).
3. **Image** (P4): copy by digest from Artifact Registry to GHCR in a Cloud Build step that holds a
   GitHub token with `write:packages` supplied by the owner (`crane copy <registry>/vap/vap@sha256:b7ecf996… ghcr.io/arajgor1/verified-action-protocol:0.1.0-rc.1`),
   then verify the digest is unchanged and make the package public.
4. **npm** (P5): after D2 and the rename commit and its gates, `npm publish --tag next --access public`
   for each tarball from the release build, in dependency order (protocol, core, store-postgres,
   sdk, adapters). npm provenance attestations need a supported CI provider (GitHub Actions);
   from Cloud Build they are not available.
5. **Announcement** (P6): post the draft with the repository URL filled in.

## 5. Decisions that require the owner's approval

| # | Decision | Recommendation |
|---|---|---|
| D1 | Accept the residual risk of the runtime image's 12 CVEs ([decision record](../security/runtime-decision-record.md)) | the reviewer recommends acceptance with the stated restrictions; this is not accepted until you say so |
| D2 | npm scope: `@verified-action-protocol` (or another owned scope), create the npm organization, and authorize the mechanical rename of the five packages and their imports, followed by the full gate set (suite, release, image gate, rehearsal; build cost about $1–2, no deployment) | approve before the repository becomes public; alternatively publish rc.1 without npm packages and rename before rc.2, accepting the confusion risk in section 2 |
| D3 | Rerun the managed staging gate on the rc.1 image `sha256:b7ecf996…` (new deployment spend: about $0.20–0.50 including Cloud SQL for about an hour, plus provisioning and teardown builds) | recommended before publication, so the deployment evidence is on the exact released digest |
| D4 | Repository name and owner (`arajgor1/verified-action-protocol` proposed) and the visibility change | your choice |
| D5 | Container registry and image name (`ghcr.io/arajgor1/verified-action-protocol` proposed), and a GitHub token for the copy | your choice; the token must be supplied by you |
| D6 | Whether to publish the Cloud Build provenance, which exposes the project and build identity | recommended: do not publish it for rc.1; state in the release notes that provenance is held privately and can be verified on request |
| D7 | Tag name `v0.1.0-rc.1` and prerelease status | recommended as stated |
| D8 | Announcement text and channel | your choice; the draft states the limitations required |
| D9 | The project's Cloud Build identity holds `roles/owner` (found during preparation, predates this work) | consider reducing it to the roles listed in [../deployment-gcp.md](../deployment-gcp.md); not changed here |
