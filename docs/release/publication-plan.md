# Publication plan and inventory: VAP 0.1.0-rc.1 (prepared, not executed)

Nothing has been pushed, tagged, published or posted, and no repository visibility has changed.
The owner accepted the residual security risk for the runtime image digest on 2026-10-28 (D1).
Feature work is frozen. The validated source commit is `b55d1cc`; it differs from artifact build
commit `765be87` by the gate-identities script fix and its regression test, the quickstart and
connect examples, the quickstart and publication pipelines with their dispatcher commands, and
documentation. None of these is in the image or the packages. **Publication happens only as the
single bounded sequence of [section 9](#9-publication-sequence-for-the-owners-approval), after
the owner approves it.** It replaces the step-by-step authorizations of sections 3 and 6.

## 1. Source, image and package mapping

| Item | Value |
|---|---|
| Branch | `publication/v0.1.0-rc1` (local only). Its own history: root `5df8873` (validated tree of the first candidate), then the commits listed in [manifest.md](manifest.md). Commit identities: `arajgor1 <arajgor1@users.noreply.github.com>` only, with `Co-Authored-By` and `Signed-off-by` trailers |
| Validated source commit | `82f5bcab572575a57a35131fb5ff5c73412a3d30` (full suite passed, Cloud Build `c0b37f6c`) |
| Artifact build commit | `765be87bc00464c34a5fc41abd416905b8ad9f3f`: the image, npm packages and schema bundle below were built from it (release `9fd981db`) and are unchanged by the later source changes ([manifest.md](manifest.md)) |
| Repository-tree commit | the documentation-only commit at the tip of that branch that records the manifest check ([manifest.md](manifest.md)); proposed tag `v0.1.0-rc.1` on it |
| Runtime image | `<registry>/vap/vap@sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849`, built from the artifact build commit by release `9fd981db`; labels `org.opencontainers.image.revision=765be87…`, `vap.support=supported`; `VAP_BUILD_VERSION=0.1.0-rc.1`; no Playwright; no setuid/setgid files. Only in the owner's private Artifact Registry |
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
| D1 | Residual risk of the runtime image's 12 unfixed CVEs | **accepted by the owner (2026-10-28)** for digest `sha256:d79c04bd…` only: 3 not affected, 9 accepted exceptions under the deployment restrictions; review 2027-01-28 ([decision record](../security/runtime-decision-record.md#owner-decision)) |
| D2 | npm scope `@verified-action-protocol` | **owner action.** The rename is done and tested from tarballs. Ownership is not confirmed: the owner creates the organization and confirms it. Precondition for PA4 |
| D3 | Managed gate on `sha256:d79c04bd…` | **Plan B authorized and run** (Plan A not authorized). Gate PASS in attempt 1 and FAIL in attempt 2 (Scheduler 401, unresolved); E2 FAIL in attempt 1 (test defect) and PASS in attempt 2. Spend estimated under $0.70. Whether this is sufficient is the owner's decision |
| D4–D5 | Names and tokens: repository `arajgor1/verified-action-protocol`, GHCR image name, a GitHub token for the image copy | names kept as proposed. Tokens are supplied through Secret Manager or the owner's own session, never in chat |
| D6 | Provenance | kept private; disclosed as unavailable in the release notes and announcement |
| D7 | Tag `v0.1.0-rc.1`, GitHub prerelease | as stated (R1, R2, PA2) |
| D8 | Announcement | draft ready ([announcement-0.1.0-rc.1.md](announcement-0.1.0-rc.1.md)). The owner posts it after the public check of section 9 passes |
| D9 | Default build identity holds `roles/owner` | not modified. The dedicated identities are the test of a restricted setup |
| — | Preparation R1–R3, and each public action PA1–PA4 | each needs its own explicit authorization |
| D10 | Successor candidate validation (V1, V2) | **done.** On `82f5bca`: V1 passed (`c0b37f6c`), V2 passed (`b41371cc`, against `0de4720`). The earlier V1 on `4d50c16` failed (test defect) |
| D11 | Release path | **confirmed by the owner (2026-10-28): Option 1**, preparing the experimental core release with the limitations of section 8 stated; no further deployment gate. This confirms the release path only: it accepts no residual CVE risk and authorizes no publication or preparation step |

## 7. Successor candidate and release options

Cloud testing is stopped. No deployment, account recreation or further spend is authorized. The
first authorized validation (V1 and V2 on `4d50c16`, up to $0.15) stopped when V1 failed. The
second (V1 and V2 on `82f5bca`, up to $0.15) is recorded below.

### The successor candidate

- **What changed:** one fix. `infra/gcp/gate-identities.sh` requires an explicit target project,
  passes it to every project-dependent command in `create` and `remove`, and stops before any
  change if the project is missing, not ACTIVE, or inconsistent with the target. For `create`, it
  also checks that the build bucket and the `vap` repository belong to the project.
- **Test:** `tests/unit/gate-identities.test.ts` runs the script against a fake `gcloud` with a
  deliberately different active project. It checks that setup and removal target only the
  supplied project, and that 14 inconsistent or missing inputs stop it before any change.
- **What is unchanged:**
  - The changed files are outside the image build context (`.dockerignore` admits only `packages`,
    `apps`, `fixtures`, `examples` and the root manifests) and outside every package's `files`.
  - So runtime image `sha256:d79c04bd…` and the tarballs of release `9fd981db`, built from
    `765be87`, are the artifacts the successor would ship unchanged. Their revision label stays
    `765be87`, and the release notes must say so.
- **Validation status: V1 and V2 passed on `82f5bca`** (V1 first failed on `4d50c16`). Nothing
  was executed locally.

**V1 on `82f5bca`: passed (Cloud Build `c0b37f6c`, about 5 build-minutes, under $0.10).** Every
step passed: source hygiene, install, build, exit propagation, unit (82), integration
(34 + 20 + 12 + 3), browser (5), demo (24) and benchmark; 180 tests in all. All 19 cases of the
gate-identities regression test passed, including the counts of project-level bindings and the
check that every lookup precedes the first change.

**V1 on `4d50c16`: failed (Cloud Build `75c210a7`, about 1 build-minute, under $0.03).**
- Source hygiene, install, build and exit propagation passed. The unit step ran 82 tests: 80
  passed and 2 failed. The integration, browser, demo and benchmark steps did not run.
- Both failures are in the new test. The `create` and `remove` cases each failed when counting
  project-level role bindings (`gcloud projects add-iam-policy-binding <project>` and its removal).
- **Cause, from the log and the test source:** the test classified each recorded call by its
  first three words. For `gcloud projects ...` the third word is the project id, so project-level
  bindings never matched the list of changing commands and were counted as zero.
- In the same two cases, the targeting checks ran before the failing line and passed: every
  recorded call named only the supplied project. The account, bucket and repository binding counts
  also passed. The "checks before the first change" assertions in the `create` case come after the
  failing line and did not run.
- The other 17 cases of the new test passed (the 14 refusals, the skipped bindings on `remove`,
  the matching project number and the configuration check), but, because of the same defect, their "no change" checks did not
  recognize project-level bindings.
- The script was not changed by this result. Whether it behaves as intended for project-level
  bindings is not yet shown by a passing test.

**Corrected test (prepared, not run).** A successor commit changes only
`tests/unit/gate-identities.test.ts`: `gcloud projects` calls are classified by their first two
words. This makes the counts, the ordering check and every "no change" check cover project-level
bindings. It is a new candidate commit (`82f5bca`), so it needed a new V1 and V2 authorization.

**The two checks** (each run needs owner authorization):

| # | Check | Command | Estimate |
|---|---|---|---|
| V1 | full suite, including the new regression test, on the successor commit | `bash scripts/vap-cloud.sh test --suite all --commit <successor>` | about 4 build-minutes on `E2_HIGHCPU_8`, under $0.10 |
| V2 | release manifest, with the successor as the validated commit, plus the tree's identifier scan | `bash scripts/vap-cloud.sh manifest --tested <successor> --images <runtime digest>+<browser digest>` | about 2 build-minutes, under $0.05 |

The strict history scan runs only in the release pipeline, which would also rebuild the images.
It is not proposed: the successor adds two files and documentation, and V2 scans the resulting
tree.

**V2 on `82f5bca`: passed (Cloud Build `b41371cc`, under 1 build-minute).** Checked against
documentation commit `0de4720`: 2 commits and 6 files after the validated commit, all
documentation; no documented-command problems; identifier scan of 277 files clean
([manifest.md](manifest.md)).

**Spend for the successor validation:** about 6 build-minutes in three builds (`75c210a7`,
`c0b37f6c`, `b41371cc`), estimated under $0.12 in total; under $0.10 of it within the second
authorization.

### Option 1 (owner's stated preference): experimental core release with stated limitations

- **Release:** source `82f5bca` (plus documentation) as `v0.1.0-rc.1`, experimental core scope.
  V1 and V2 have passed. Its artifacts are those built from `765be87`, as above.
- **Managed deployment status in the release notes and README:**

  > Managed deployment is experimental. On the final image, in a disposable project with
  > dedicated build identities, the managed gate passed once and failed once. The failure was an
  > intermittent authentication failure: Cloud Scheduler received HTTP 401 from Cloud Run. It is
  > unresolved, and its cause is not established. A live SDK call against the deployed image
  > passed once and failed once (the failure was a defect in the check). The passing call used a
  > test stand-in for the SDK's gcloud token source.

- **Still required, each by the owner:**
  - the residual-CVE decisions (D1);
  - npm scope ownership (D2);
  - authorization of each preparation step (R1–R3) and each public action (PA1–PA4).
- **Not authorized now.**

### Option 2: a separately authorized, bounded deployment validation after the fix

- **Run:** after V1 and V2, one more Plan B run in a new disposable project, using the fixed
  script and the same digest. Accounts are created there once and never recreated during the
  run.
- **Bounds (proposed):**
  - one attempt (provision, deploy with `--keep`, E2, teardown);
  - the watchdog from the first run;
  - deletion of the project afterwards;
  - a $2 ceiling (one attempt was about $0.35 in the first run).
- **What it could show:** whether the Scheduler 401 recurs with accounts that were never
  recreated. A clean pass would not explain the earlier failure.
- **E2 token path:** E2 would still use the stand-in unless the check runs in an image that
  contains both Node.js and gcloud. That change would need its own approval.
- **Owner steps:** the same as before (project, billing, access grant).
- **Not authorized now.**

## 8. Decision packet: experimental core release `v0.1.0-rc.1`

The owner confirmed Option 1 (D11). Nothing else in this section is authorized: no residual risk
is accepted, and no preparation or public action may start.

### What would be released

| Item | Value |
|---|---|
| Validated source commit | `82f5bca`: full suite passed (`c0b37f6c`) |
| Artifact build commit | `765be87`: the artifacts below were built from it |
| Documentation commit checked by V2 | `0de4720` (`b41371cc`) |
| Final documentation-only commit | the tip of `publication/v0.1.0-rc1`; not checked by V2; its id is stated with the release ([manifest.md](manifest.md)). The proposed tag goes on it |
| Artifacts | built from `765be87` by release `9fd981db`: runtime image `sha256:d79c04bd…2c864849`, the five npm tarballs and `vap-schemas-0.1.tar.gz`, checksums in [manifest.md](manifest.md) |
| Excluded | browser adapter and worker-browser image (experimental), blank-project bootstrap, private development branch, operator index, raw evidence, private provenance |
| Evidence | full suite on the source commit (`c0b37f6c`, 180 tests); release gates, scans and consumer install on the build commit (`9fd981db` and [candidate-evidence.md](candidate-evidence.md)); manifest check (`b41371cc`) |

### Limitations the release states

- **Managed deployment is experimental**, with the text in section 7, Option 1: on the final
  image the managed gate passed once and failed once. Cloud Scheduler received HTTP 401 from Cloud
  Run in the failing attempt. That failure is unresolved and its cause is not established.
- **Live SDK call:** passed once against the deployed final image, through a test stand-in for the
  SDK's gcloud token source. The SDK's normal token path against a deployed image is not shown.
- **Real GitHub:** the workflow against a real GitHub repository has not run.
- **Model comparison:** no model-driven agent was evaluated or compared; the demo agents are
  scripted policies.
- **npm registry install (E1):** not run; it needs publication.
- **Public build provenance:** not available (kept private).
- **Residual CVEs:** 12 unfixed in the runtime image, with the assessment in the
  [decision record](../security/runtime-decision-record.md).
- **Artifacts and source differ by commit:** the artifacts carry revision `765be87`; the source
  is `82f5bca`. The difference is a setup script and its test, outside every artifact.

### Unresolved items carried with the release

- The Scheduler 401 cause: a hypothesis from the saved logs only (reused account names), not
  tested ([managed-staging-results.md](managed-staging-results.md)).
- The disposable gate project is `DELETE_REQUESTED`; deletion completes when Google's hold
  period ends, not before.

### Owner decisions, in order

1. **D11:** done; Option 1 confirmed.
2. **D1:** the residual-CVE decisions, one per category in the decision record. Required before
   PA1, PA3 and PA4.
3. **D2:** create the npm organization `verified-action-protocol` and confirm ownership.
   Required before PA4.
4. **R1–R3:** each preparation step (private repository and tag, draft prerelease, private image
   copy), authorized one at a time.
5. **PA1–PA4:** each public action, authorized one at a time, in the order of section 3.
6. **Announcement:** after PA1 and PA4, and after E1 passes.

Not requested: another managed deployment gate, IAM changes, or acceptance of any risk on the
owner's behalf.

## 9. Publication sequence (for the owner's approval)

One bounded sequence replaces the separate authorizations above. The owner approves it once; it
then runs without further questions, stops at the first failure, never overwrites a published
version, and reports exactly what was published.

**Destinations (all version `0.1.0-rc.1`):**

| Target | Destination | Content |
|---|---|---|
| Source | `github.com/arajgor1/verified-action-protocol`, branch `main` and tag `v0.1.0-rc.1` | the history of `publication/v0.1.0-rc1` up to the final documentation commit (history identifier scan in the dry run) |
| Container image | `ghcr.io/arajgor1/verified-action-protocol:0.1.0-rc.1` | `sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849`, copied with its digest preserved |
| GitHub prerelease | `v0.1.0-rc.1` on the repository | the release notes; the five npm tarballs, `vap-schemas-0.1.tar.gz`, `public-sbom-runtime.cdx.json`, `public-sbom-source-workspaces.cdx.json`, `public-scan-runtime.txt`, `public-vulns-all-runtime.json`, `public-licenses.json`, and `RELEASE-SHA256SUMS` covering exactly those files |
| npm | `@verified-action-protocol/{protocol,core,store-postgres,adapters,sdk}@0.1.0-rc.1`, dist-tag `next`, public | the release tarballs, checksums in [manifest.md](manifest.md) |
| Excluded | | the worker-browser image and every browser artifact, private reports, provenance, the operator index |

**Sequence:**
1. **Dry run** on the final commit: `vap-cloud.sh publish` without `--for-real`. Checks the
   asset checksums, the history identifier scan, that no target already holds different content,
   and copies the image to a private test path to prove the digest is preserved (then deleted).
2. **Publish** (`--for-real`), one Cloud Build run, in this order: container image (private
   package), source and tag, GitHub prerelease, npm packages. The repository and the package keep
   the visibility the owner created them with; npm is public at once, so it goes last.
3. **Owner:** make the repository and the `verified-action-protocol` container package public
   (GitHub settings; a public package cannot be made private again).
4. **Public check:** `vap-cloud.sh quickstart` in public mode, from a fresh environment: the
   README commands pull the public image and install the SDK from npm. Result recorded in
   [quickstart-results.md](quickstart-results.md).
5. The owner posts the announcement.

**On failure:** stop, report which targets were written. A re-run skips targets that already
hold identical content and stops on any that differ. A published npm version is never
unpublished or reused; a wrong one is superseded by a new version.

