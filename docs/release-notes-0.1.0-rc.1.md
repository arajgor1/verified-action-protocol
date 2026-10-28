# VAP 0.1.0-rc.1 release notes

> **Experimental release.** The protocol (0.1) and the APIs may change. Every figure below links
> to recorded Cloud Build evidence.

## What it is

VAP (Verified Action Protocol) is an execution layer for agents and integrations that change
things in other systems. An action is prepared as an immutable plan, runs under an explicit
grant, and leaves a durable operation record. Its outcome is verified with named read-back checks.
When the reply is lost, VAP reconciles before any retry, and it reports `unknown` rather than
guessing. Submitted, completed, verified, partially applied and unknown are kept apart.

## Get started

```bash
git clone https://github.com/arajgor1/verified-action-protocol.git && cd verified-action-protocol
docker compose -f examples/quickstart/compose.yaml run --rm demo      # recovery demo
docker compose -f examples/quickstart/compose.yaml run --rm connect   # SDK example
docker compose -f examples/quickstart/compose.yaml down -v            # remove everything
```

Docker with Compose v2 is all you need; no GitHub, model or cloud account. Details: the
[README](../README.md), [connect.md](connect.md) and, for a deployment,
[deployment-docker.md](deployment-docker.md).

## What is in the supported release

**Source and artifacts come from two commits.** The source tree is validated commit `b55d1cc`.
The runtime image, npm packages and schema bundle were built from `765be87`, and their revision
label says `765be87`. The later source changes are a fix to the gate-identity setup script, its
regression test, the quickstart and connect examples, cloud pipelines for the quickstart check and
for publication, and documentation; none of these files is part of the image or packages
([manifest](release/manifest.md)).

- **Protocol 0.1 (experimental):** JSON Schemas, method contracts, error codes with retry
  dispositions, canonical JSON and keyed digests, executable examples. Bundle:
  `vap-schemas-0.1.tar.gz`.
- **Runtime image** (API, worker, sweeper, migration job, synthetic fixture), referenced by
  digest, with SBOM and license inventory. **Public build provenance is not available for this
  candidate:** Cloud Build records signed SLSA provenance, but it names the owner's private
  project, build identity and storage locations, and it cannot be redacted without invalidating
  its signature, so it is kept private.
- **npm packages 0.1.0-rc.1** under the `@verified-action-protocol` scope: protocol, core, SDK
  (client and `vap` CLI), PostgreSQL store, and adapters (declarative HTTP and registered-command
  CLI). The similarly named `@vap` npm scope belongs to an unrelated publisher; do not install
  from it. Installation and a first example: [SDK example](sdk-example.md).
- **Container image:** `ghcr.io/arajgor1/verified-action-protocol@sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849`
  (`linux/amd64`, tag `0.1.0-rc.1`).
- **Supported deployment:** the image by digest as separate Docker containers with PostgreSQL and
  an OIDC issuer ([deployment-docker.md](deployment-docker.md)), as validated by the ephemeral
  staging rehearsal (test mode, synthetic destination, local issuer).
- **Experimental, not supported:** the managed Google Cloud deployment
  ([deployment-gcp.md](deployment-gcp.md)) and the contributor cloud workflow
  ([quickstart.md](quickstart.md)).

**Not in the supported release:** the browser adapter and its worker-browser image are
experimental. The adapter is disabled by default, `playwright` is only an optional peer
dependency of the adapters package, the supported runtime image contains no Playwright, and the
browser image is not published. Blank-project bootstrap (`infra/gcp/bootstrap.sh`) is excluded.

## What was tested

- **Comparison benchmark (scripted policies, synthetic destination).** Nine failure scenarios
  (lost replies, crashes mid-request, concurrent instances, changed payloads, rejections,
  unavailable lookups, delayed visibility), 5 runs each, 180 runs in total, against a synthetic
  GitHub-like fixture with a test-only fault proxy. The agents are **scripted policies, not
  models.** VAP completed 35 of 35 completable runs with no duplicates and no false task success.
  **A careful client with its own durable intent log matched VAP in every outcome category**;
  naive retry and a careful client without a durable log did not (retry: 35 false task successes
  in 40 runs that claimed completion). VAP's contribution is a reusable implementation of that
  discipline behind one contract, not a better outcome than a well-built durable client
  ([results](demo/ci-failure-results.md)).
- **Normal-path overhead, measured and disclosed:** median 703 ms for VAP against 179–195 ms for
  the no-VAP policies in the normal scenario (after runtime start-up; human approval latency
  excluded). VAP makes 9 tool calls against 4 there, for the plan, durable journal writes and two
  read-back checks.
- **Managed GCP deployment and interruption recovery.** On Cloud Run, Cloud Run jobs, Cloud
  Scheduler and Cloud SQL with Google-signed authentication: migrations, database and IAM access
  controls, dispatch, an operation interrupted while its verification was demonstrably in flight
  (the verifying execution was running when cancelled and the API was restarted), recovery with
  one submission, reconciliation of a lost reply, and journal durability across API and Cloud SQL
  restarts ([results](release/managed-staging-results.md)). One small shared-core instance, one
  region, no load and no high availability. This ran on the image of the preceding candidate; the
  0.1.0-rc.1 image differs by version strings, `zod` 4.6.7, a Debian time-zone data update, the
  removal of Playwright, cleared setuid bits and the package rename. On the final image, in a
  disposable project with dedicated build identities and no Owner build identity:
  - the managed gate passed once and failed once (Cloud Scheduler received 401 from Cloud Run in
    the second attempt; unresolved);
  - a live SDK call from the release tarballs against the deployed image passed once and failed
    once (a defect in the check).
- **Quickstart in a fresh environment:** both commands above, unchanged, on a clean Docker host
  with the release image by digest and the release tarballs: the dropped response was reported
  `unknown`, reconciled to `verified` with one destination write; the connect example reached
  `verified`; the VAP containers ran as uid 1000 with no capabilities and `no_new_privs`
  ([results](release/quickstart-results.md), including two failed attempts and their fixes). The
  same check against the public image and npm registry runs after publication.
- **Package installation:** the exact release tarballs installed into an empty project with
  registry lookups for the scope blocked: no Playwright, browser cache or Chromium installed by
  default, the documented SDK example ran, and the published TypeScript declarations
  type-checked with `skipLibCheck` off.
- **Not shown:** a live SDK call against the image deployed on the managed path through the SDK's
  normal gcloud token source (the passing call used a test stand-in for it).
- **Release gates:** 161 tests on the build commit (184 on the validated source commit), fault and security suites, an ephemeral staging rehearsal, image
  scans with 0 fixable HIGH/CRITICAL findings, secret and identifier scans of the source, its
  history, the packages and the images ([evidence index](release/candidate-evidence.md)).

## What has not been run

- **Real GitHub:** the same workflow against a real repository has not run.
- **Claude-model comparison:** no model-driven agent was evaluated; no claim is made about model
  performance.
- **Blank-project onboarding** of a new Google Cloud project.

## Security notes

The runtime image has 12 unfixed upstream CVEs and none with a fix available. Each is assessed
in the [decision record](security/runtime-decision-record.md): 3 are in components absent from
the image; 6 are unreachable given the image's contents (no setuid files, no fstab user mounts),
its non-root default user, and restrictions operators must keep; and 3 are in installed tools or
libraries that VAP does not run, which an operator's recipe or a launch as root could reach.
The owner accepted the residual risk for this exact image digest on 2026-10-28: the 3 absent
components as not affected, the other 9 as accepted exceptions (not proof of safety), conditional
on the deployment restrictions. Review date 2027-01-28, or earlier when a fix becomes available,
applicability changes or the supported deployment conditions change. The acceptance does not
cover new findings or another image. The runtime image contains no setuid/setgid files and no browser automation code. Its default
user is non-root; the image cannot stop a launcher from running it as root or privileged, so
the [deployment restrictions](security/runtime-decision-record.md#deployment-restrictions-that-are-not-enforced-by-the-image)
apply to every deployment.

## Limitations

No exactly-once remote effects, universal undo, prompt-injection immunity or compliance claims.
Verification in the same process is not independent attestation. A lost-reply completion found by
lookup has an inferred, not proven, origin. MCP compatibility is limited to the tested SDK client
over stdio. Protocol 0.1 may change incompatibly. See [limitations.md](limitations.md).

## Feedback

Issues and pull requests are welcome; see CONTRIBUTING.md. Adapter proposals should state the
capability vector and how each guarantee is tested.
