# VAP 0.1.0-rc.1 release notes (draft, not published)

> **Experimental core release candidate.** Publication, repository visibility, package names and
> any announcement are the owner's decisions and have not happened. Every figure below links to
> the recorded Cloud Build evidence.

## What it is

VAP (Verified Action Protocol) is an execution layer for agents and integrations that change
things in other systems. An action is prepared as an immutable plan, runs under an explicit
grant, and leaves a durable operation record. Its outcome is verified with named read-back checks.
When the reply is lost, VAP reconciles before any retry, and it reports `unknown` rather than
guessing. Submitted, completed, verified, partially applied and unknown are kept apart.

## What is in the supported release

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
- **Installation path:** a preconfigured Google Cloud project; everything builds and runs in
  Cloud Build ([quickstart](quickstart.md)). The optional durable deployment runs on Cloud Run,
  Cloud Run jobs, Cloud Scheduler, Cloud SQL and Secret Manager ([deployment](deployment-gcp.md)).

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
  removal of Playwright, cleared setuid bits and the package rename, and has not itself been
  deployed. A rerun on the final image is prepared but has not run.
- **Package installation:** the exact release tarballs installed into an empty project in a fresh
  directory with its own npm cache, with registry lookups for the scope blocked: no Playwright,
  browser cache or Chromium installed by default, the documented SDK example ran, and the
  published TypeScript declarations type-checked with `skipLibCheck` off. This installed local
  tarballs, not packages from the npm registry (nothing is published yet), and the example ran
  offline, with no call to a deployed API. Two checks remain:
  - a fresh install from the public registry;
  - a live SDK call against the final image deployed on the managed path.
- **Release gates:** 161 tests, fault and security suites, an ephemeral staging rehearsal, image
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
the image, 6 are unreachable under restrictions the image enforces (no setuid files, non-root
user, no fstab user mounts) or that operators must keep, and 3 are in tools VAP never runs.
Acceptance of the residual risk is the owner's decision and is pending at the time of writing.
The runtime image runs as a non-root user and contains no setuid/setgid files and no browser
automation code.

## Limitations

No exactly-once remote effects, universal undo, prompt-injection immunity or compliance claims.
Verification in the same process is not independent attestation. A lost-reply completion found by
lookup has an inferred, not proven, origin. MCP compatibility is limited to the tested SDK client
over stdio. Protocol 0.1 may change incompatibly. See [limitations.md](limitations.md).

## Feedback

Issues and pull requests are welcome; see CONTRIBUTING.md. Adapter proposals should state the
capability vector and how each guarantee is tested.
