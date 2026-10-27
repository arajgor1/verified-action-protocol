# Publication plan and inventory: VAP 0.1.0-rc.1 (prepared, not executed)

Nothing below has been done. Nothing has been pushed, tagged, published or posted, no repository
visibility has changed, and no residual security risk has been accepted. Feature work is frozen
on candidate `765be87`; later commits change documentation only. **No public action happens
before the owner explicitly authorizes it**, and each public action in section 3 is authorized on
its own (section 6).

## 1. Source, image and package mapping

| Item | Value |
|---|---|
| Branch | `publication/v0.1.0-rc1` (local only). Its own history: root `5df8873` (validated tree of the first candidate), then the commits listed in [manifest.md](manifest.md). Commit identities: `arajgor1 <arajgor1@users.noreply.github.com>` only, with `Co-Authored-By` and `Signed-off-by` trailers |
| Validated source commit | `765be87bc00464c34a5fc41abd416905b8ad9f3f` |
| Repository-tree commit | the documentation-only commit at the tip of that branch that records the manifest check ([manifest.md](manifest.md)); proposed tag `v0.1.0-rc.1` on it |
| Runtime image | `<registry>/vap/vap@sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849`, built from the validated commit by release `9fd981db`; labels `org.opencontainers.image.revision=765be87…`, `vap.support=supported`; `VAP_BUILD_VERSION=0.1.0-rc.1`; no Playwright; no setuid/setgid files. Only in the owner's private Artifact Registry |
| npm packages (built by `9fd981db`, not published) | `@verified-action-protocol/protocol`, `/core`, `/sdk`, `/store-postgres`, `/adapters`, all `0.1.0-rc.1`, files `verified-action-protocol-<name>-0.1.0-rc.1.tgz`. `/adapters` lists `playwright` only as an optional peer dependency |
| Schema bundle | `vap-schemas-0.1.tar.gz` (protocol 0.1 JSON Schemas and examples) |
| Checksums | `SHA256SUMS` of release `9fd981db` (covers private originals too; a public subset is generated at step R2) |
| License | Apache-2.0 (`LICENSE`, `NOTICE`); third-party license inventory `public-licenses.json` |
| SBOMs and scans | `public-sbom-runtime.cdx.json`, `public-sbom-source-workspaces.cdx.json`, `public-scan-runtime.txt`, `public-vulns-all-runtime.json` (sanitized copies) |
| Provenance | signed SLSA provenance recorded by Cloud Build; it names private identifiers and is **kept private**. Public build provenance is not available for this candidate (stated in the release notes); no edited copy will be published |
| Sanitized evidence | [candidate-evidence.md](candidate-evidence.md), [managed-staging-results.md](managed-staging-results.md), [../demo/ci-failure-results.md](../demo/ci-failure-results.md), [../security/runtime-decision-record.md](../security/runtime-decision-record.md), [../security/vulnerability-dispositions.md](../security/vulnerability-dispositions.md), [../acceptance.md](../acceptance.md) |
| Supported installation | a preconfigured Google Cloud project, Cloud Build only ([../quickstart.md](../quickstart.md)); optional managed deployment ([../deployment-gcp.md](../deployment-gcp.md)); npm packages per [../sdk-example.md](../sdk-example.md) once published |
| Excluded | browser adapter (experimental, disabled by default) and the worker-browser image; blank-project bootstrap; the private development branch; the operator-only index and raw evidence |

## 2. Namespace ownership (checked 2026-10-27, 15:40 UTC)

| Target | Name | Result | Ownership |
|---|---|---|---|
| npm scope | `@verified-action-protocol` | registry: `Scope not found`; no package under it | **not confirmed.** "Scope not found" means only that no organization exists. It is neither ownership nor permission to publish, and an unused scope is not a reservation. Creating the npm organization is an **owner action**: the owner creates it and confirms with `npm org ls verified-action-protocol` while logged in as themselves |
| why it matters | | the consumer-install check showed npm looking up the internal dependencies (`core`, `protocol`) by name in the registry | once anything is published, a scope held by someone else would serve those names. Publish nothing until the owner has confirmed ownership |
| npm scope | `@vap` | an unrelated publisher's organization (publishes `@vap/core`) | not ours; the docs warn against it |
| GitHub repository | `arajgor1/verified-action-protocol` | not found (account exists) | the owner's account; free to create |
| Container image | `ghcr.io/arajgor1/verified-action-protocol` | no public package | under the owner's account once pushed |

## 3. Preparation and public actions

### Preparation (outward-facing, not public)

Each of these needs the owner's authorization, but nothing becomes public.

| # | Action | Result |
|---|---|---|
| R1 | create the GitHub repository **private**; push `publication/v0.1.0-rc1` as `main`; push the annotated tag `v0.1.0-rc.1` on the repository-tree commit | source, history and tag visible only to the owner |
| R2 | create the GitHub prerelease `v0.1.0-rc.1` as a **draft**, with its assets (the release notes; `vap-schemas-0.1.tar.gz`, the four sanitized `public-*` files and `public-licenses.json`; a `SHA256SUMS` covering exactly those files) | drafts are visible only to people with write access to the repository |
| R3 | copy the runtime image by digest to `ghcr.io/arajgor1/verified-action-protocol:0.1.0-rc.1` | GitHub Container Registry packages owned by a personal account are private when first pushed |

### Independently public actions

Each action makes something different public. Each needs its own explicit authorization, and the
first one needs it before anything is public.

| # | Public action | What becomes public | Reversible? | Preconditions |
|---|---|---|---|---|
| PA1 | **Source visibility:** repository → public | the full history of the branch, the tag, every tracked file (code, docs, this plan with placeholders). Draft releases and the container package stay private | the setting can be reverted, but clones, forks and caches made in the meantime remain | R1; residual-CVE decision (D1); provenance disclosure as written (D6) |
| PA2 | **Release assets:** publish the draft prerelease | release notes, the listed assets and their `SHA256SUMS` | the release can be deleted; downloaded copies remain | R2 and PA1. A release published while the repository is private becomes public with PA1, so publish the draft only after PA1 |
| PA3 | **Container visibility:** GHCR package → public | the runtime image `sha256:d79c04bd…` (all its layers and labels) | **no:** GitHub states that a public package cannot be made private again | R3; D1 |
| PA4 | **npm packages:** publish the five packages `0.1.0-rc.1` with dist-tag `next` | the five tarballs, public immediately | **effectively no:** unpublishing is possible within 72 hours (later only under narrow conditions), and a used `name@version` can never be reused | owner-confirmed scope ownership (D2); D1 |
| — | Announcement | the text in [announcement-0.1.0-rc.1.md](announcement-0.1.0-rc.1.md) | no | PA1 and PA4 done, and E1 passed (section 4). The owner decides whether E2 is also required |

**Never public in this release:**
- the worker-browser image;
- the private Artifact Registry repository and the evidence bucket;
- the operator-only index and build provenance;
- the private development branch and its history.

### Exact commands (to run only after the matching authorization)

Run from a fresh clone of the local repository, by the owner, or with credentials the owner
supplies to the session at that time (never pasted into chat).

```bash
# R1: private repository, branch, tag
gh repo create arajgor1/verified-action-protocol --private --description "Verified Action Protocol (VAP): experimental execution layer for verified agent actions"
git remote add publication https://github.com/arajgor1/verified-action-protocol.git
git push publication publication/v0.1.0-rc1:main
git tag -a v0.1.0-rc.1 <repository-tree commit> -m "VAP 0.1.0-rc.1 (experimental core release candidate)"
git push publication v0.1.0-rc.1

# R2: draft prerelease. Assets come from the private evidence location of release 9fd981db
# (operator index) and are checked against that release's SHA256SUMS first.
mkdir assets && cd assets   # download the files listed in R2 here
grep -E ' (vap-schemas-0\.1\.tar\.gz|public-.*)$' ../SHA256SUMS.release | sha256sum -c -
sha256sum vap-schemas-0.1.tar.gz public-* > SHA256SUMS
gh release create v0.1.0-rc.1 --repo arajgor1/verified-action-protocol --draft --prerelease \
  --title "VAP 0.1.0-rc.1 (experimental)" --notes-file ../docs/release-notes-0.1.0-rc.1.md \
  vap-schemas-0.1.tar.gz public-* SHA256SUMS

# R3: copy by digest, in a Cloud Build step holding a GitHub token with write:packages that the
# owner stores in Secret Manager; then check that the digest is unchanged
crane copy <registry>/vap/vap@sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849 ghcr.io/arajgor1/verified-action-protocol:0.1.0-rc.1
crane digest ghcr.io/arajgor1/verified-action-protocol:0.1.0-rc.1   # must print sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849

# PA1: source visibility
gh repo edit arajgor1/verified-action-protocol --visibility public --accept-visibility-change-consequences

# PA2: release assets
gh release edit v0.1.0-rc.1 --repo arajgor1/verified-action-protocol --draft=false --prerelease

# PA3: container visibility. On the package's settings page on GitHub, use "Change visibility" to
# make it public (a web-interface step; irreversible).

# PA4: npm packages, by the owner after `npm org ls verified-action-protocol` succeeds for them.
# Tarballs from 9fd981db, verified against that release's SHA256SUMS first; dependency order.
grep -E ' verified-action-protocol-.*\.tgz$' SHA256SUMS.release | sha256sum -c -
for p in protocol core store-postgres sdk adapters; do
  npm publish --tag next --access public "verified-action-protocol-$p-0.1.0-rc.1.tgz"
done
```

npm provenance attestations need a supported CI provider (GitHub Actions). Packages published
from a workstation or from Cloud Build carry none, which is consistent with "no public
provenance".

## 4. Remaining end-to-end checks

The consumer-install check of release `9fd981db` installed **local tarballs**, with registry
lookups for the scope blocked. It ran the SDK example **offline**, so the client call was
skipped. Two end-to-end checks were left: E1 has not run; E2 ran during the Plan B managed gate.

| # | Check | Needs | How |
|---|---|---|---|
| E1 | fresh install from the public npm registry | PA4 | in a fresh container with an empty npm cache, run the documented command `npm install @verified-action-protocol/sdk@0.1.0-rc.1 @verified-action-protocol/adapters@0.1.0-rc.1` ([../sdk-example.md](../sdk-example.md)). Then repeat the consumer-install checks against the result: no Playwright or browser binaries; every `@verified-action-protocol` package resolved from `registry.npmjs.org`; integrity hashes match the published tarballs; the offline example runs; `typecheck.ts` compiles |
| E2 | live SDK call against the final managed image | a managed deployment of `sha256:d79c04bd…` left running (`deploy --keep`), and an ID token for the API's audience | **ran in the Plan B gate.** Passed in attempt 2 (`7fac42d8`): `offline-check.mjs` with `VAP_URL` set, `info()` reporting the exact digest and `oidc`, and a demo token refused. Failed in attempt 1 (`11091b3e`) on the check's own token minting. It used the release tarballs, not the registry; E1 still requires publication ([managed-staging-results.md](managed-staging-results.md)) |

## 5. Managed gate on the final digest (Plan B run; mixed result)

Plan B ran on 2026-10-27, as authorized. The deploy gate passed in attempt 1 and failed in
attempt 2; results in [managed-staging-results.md](managed-staging-results.md). The identity plan,
the exact grants, the removal steps and the bounded spend are in
[managed-gate-identity-plan.md](managed-gate-identity-plan.md):
- **Plan B (recommended):** a disposable project, using `infra/gcp/gate-identities.sh` unchanged;
- **Plan A:** the existing project, without project-wide service-account deletion or act-as
  administration.

**Build and deployment permissions** belong to the two gate identities, and are held only while
the builds run. **Application runtime permissions** belong to the six exercise accounts
(`vap-api`, `vap-worker`, `vap-migrator`, `vap-fixture`, `vap-scheduler`, `vap-smoke`). Each of
those is bound on one secret, one job, one service or the one instance, unchanged from the
verified run.

## 6. Decisions that require the owner's approval

| # | Decision | Status and recommendation |
|---|---|---|
| D1 | Residual risk of the runtime image's 12 unfixed CVEs | **open.** Three choices, one per category, in the [decision record](../security/runtime-decision-record.md). Nothing is accepted until the owner says so. Precondition for PA1, PA3 and PA4 |
| D2 | npm scope `@verified-action-protocol` | **owner action.** The rename is done and tested from tarballs. Ownership is not confirmed: the owner creates the organization and confirms it. Precondition for PA4 |
| D3 | Managed gate on `sha256:d79c04bd…` | **Plan B authorized and run** (Plan A not authorized). Gate PASS in attempt 1 and FAIL in attempt 2 (Scheduler 401, unresolved); E2 FAIL in attempt 1 (test defect) and PASS in attempt 2. Spend estimated under $0.70. Whether this is sufficient is the owner's decision |
| D4–D5 | Names and tokens: repository `arajgor1/verified-action-protocol`, GHCR image name, a GitHub token for the image copy | names kept as proposed. Tokens are supplied through Secret Manager or the owner's own session, never in chat |
| D6 | Provenance | kept private; disclosed as unavailable in the release notes and announcement |
| D7 | Tag `v0.1.0-rc.1`, GitHub prerelease | as stated (R1, R2, PA2) |
| D8 | Announcement | draft ready. Post only after PA1, PA4 and E1 |
| D9 | Default build identity holds `roles/owner` | not modified. The dedicated identities are the test of a restricted setup |
| — | Preparation R1–R3, and each public action PA1–PA4 | each needs its own explicit authorization |
