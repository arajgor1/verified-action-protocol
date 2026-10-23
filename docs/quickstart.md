# Cloud quickstart

Everything below runs in Google Cloud Build. Your workstation only submits work. It needs `git`,
`bash` and `gcloud`. The only repository file that runs on it is the dispatcher
`scripts/vap-cloud.sh`, which archives a commit and submits it. Nothing is installed locally.

## 0. Before you start

**Tools.** You need `git`, `bash`, and a current Google Cloud CLI with the `beta` component
(`gcloud components install beta`, or your package manager's equivalent). The dispatcher uses
it to print build logs from Cloud Logging. The pipelines themselves use Cloud SDK 563. On Windows, use Git Bash or
WSL: the commands below are bash, not PowerShell.

**Get the code.** Clone the repository and work from its root:

```bash
git clone <repository URL> vap && cd vap
```

The cloud always runs a **committed** tree: `scripts/vap-cloud.sh` archives an exact commit.
Commit your changes before you submit, or they will not be part of the run.

**Sign in and choose a project.**

```bash
gcloud auth login
gcloud config set project <your-project-id>
```

Use a project with billing enabled that you are allowed to spend in. The quickstart creates no persistent resources apart
from your evidence bucket and the source bucket Cloud Build makes on first use. You pay for build
minutes on `E2_HIGHCPU_8` machines; see Cloud Build pricing for your region. Durations measured
from recorded runs, from submission to finish:

| Command | Recorded duration |
|---|---|
| `demo` | 0.8 min |
| `tutorial` | 0.9 min |
| `test --suite integration` | 1.6 min |
| `test --suite all` (every test, including the demo tests; not the comparison) | 4.1 min |
| `test --suite demo` (demo tests plus the 180-run comparison, which only this suite runs) | 12.6 min |

**Enable the APIs** (once per project; needs `roles/serviceusage.serviceUsageAdmin` or owner):

```bash
gcloud services enable cloudbuild.googleapis.com storage.googleapis.com logging.googleapis.com
```

**Permissions.** You, the person submitting, need on the project:
- `roles/cloudbuild.builds.editor` to submit builds;
- `roles/logging.viewer` so `vap-cloud.sh` can print the build log;
- `roles/storage.admin`, or an administrator who creates the buckets for you. The first
  `gcloud builds submit` creates the source bucket `<project>_cloudbuild`, and you create the
  evidence bucket below. To read the reports afterwards, `roles/storage.objectViewer` on the
  evidence bucket is enough.

An administrator can grant these to you as follows (`--condition=None` keeps the bindings
unconditional):

```bash
for r in roles/cloudbuild.builds.editor roles/logging.viewer roles/storage.admin; do
  gcloud projects add-iam-policy-binding <your-project-id> --member=user:<you@example.com> --role=$r --condition=None
done
```

The builds run as the project's default Cloud Build service account, which depends on the
project's age and organization policy. Look it up, then let it write reports to the evidence
bucket once that bucket exists:

```bash
gcloud builds get-default-service-account --region=<your-region>
gcloud storage buckets add-iam-policy-binding gs://<your-evidence-bucket>   --member=serviceAccount:<the account printed above> --role=roles/storage.objectCreator
```

**Create a private evidence bucket** (once). Any location works; one close to your build region
is cheapest. `VAP_GCP_REGION` below is the Cloud Build region where builds run, for example
`us-central1`. Use a region where Cloud Build's default pool and `E2_HIGHCPU_8` machines are
available.

```bash
gcloud storage buckets create gs://<your-evidence-bucket> --location=<your-region> \
  --uniform-bucket-level-access --public-access-prevention
```

**Set the operator values** for this shell session. Never commit them:

```bash
export VAP_GCP_PROJECT=<your-project-id> VAP_GCP_REGION=<your-region> VAP_EVIDENCE_BUCKET=<your-evidence-bucket>
```

**Commits and outputs.** Every command uses the current `HEAD` unless you pass
`--commit <sha>`. Local summaries go to `release-out/`, which is git-ignored.

**Where results appear.** Each command prints
`Cloud Build <build id> (run <run id>, commit <sha>)` and a console URL for the live log. It then
reports status changes, prints the full build log when the build ends, and finishes with
`build <id>: SUCCESS|FAILURE`. It also writes a local summary to
`release-out/evidence/<build id>.json`. Reports land in `gs://$VAP_EVIDENCE_BUCKET/<kind>/<run id>/`,
for example `demo/r20261022…/`.

Nothing here needs `infra/gcp/bootstrap.sh`. Bootstrap is only for the optional durable
deployment at the end.

## 1. Run the demo

```bash
bash scripts/vap-cloud.sh demo
```

The build starts a disposable PostgreSQL container and the synthetic issue tracker, then runs
three scenarios against the API:

1. **Verified success:** an issue is reassigned with a native conditional write. The owner check
   passes on a fresh readback, and repeating the request key returns the original operation.
2. **Lost reply:** the fixture commits the write and drops the reply. The receipt shows `unknown`
   with `reconcile_first`. Reconciliation finds the effect through the sealed request-key lookup,
   and the destination write count is 1.
3. **Partial batch:** two of four items apply. The receipt lists per-item effects and a failed
   aggregate check. Compensation then closes exactly the two created issues, as a separate
   operation.

Receipts are printed in the build log and saved to `gs://$VAP_EVIDENCE_BUCKET/demo/<run id>/demo-output.txt`.
The build removes its database container at the end.

## 2. Run the custom-action tutorial

```bash
bash scripts/vap-cloud.sh tutorial
```

This runs [the tutorial](tutorial-custom-http-action.md) with the configuration in
`examples/config/adapters.tutorial.json`. Edit that file (or pass `--config <your file>`),
commit it, and run the command again to try your own action.

## 3. Run the test suites

```bash
bash scripts/vap-cloud.sh test --suite all --commit "$(git rev-parse HEAD)"
```

Suites:

| Suite | Contents |
|---|---|
| `unit` | unit tests |
| `integration` | conformance (including fault scenarios T01–T02), the fault suite (T03–T18), security and the MCP smoke test, against real PostgreSQL |
| `browser` | the browser adapter with Playwright Chromium |
| `demo` | the CI-failure demonstration ([demo/ci-failure.md](demo/ci-failure.md)): tests, transcript and the comparison harness |
| `all` | every suite above, plus the deterministic benchmark |

Each run writes `evidence.json` (build id, commit, aggregated test totals, checksums) to your
evidence bucket. The build fails if any test fails.

## Maintainers: re-resolving the lockfile (optional)

`package-lock.json` is committed and every build uses `npm ci --ignore-scripts`. Re-resolve only
after changing a package manifest:

```bash
bash scripts/vap-cloud.sh lock
```

The new lockfile lands in `gs://$VAP_EVIDENCE_BUCKET/lock/<run id>/` for review before you commit
it. The run id is printed when the command starts.

## Optional: a durable deployment

The durable profile runs on Cloud Run, Cloud SQL, Secret Manager and Cloud Scheduler. It needs
the one-time `infra/gcp/bootstrap.sh`, run by an operator with rights to create service
accounts, IAM bindings and Cloud SQL, and it bills while it exists. See
[deployment-gcp.md](deployment-gcp.md). With a deployed API:

```bash
gcloud run services proxy vap-api-staging --region "$VAP_GCP_REGION" --port 8080
```

Then open `http://localhost:8080/viewer`. The proxy adds your identity token; you need
`roles/run.invoker` on the service. The viewer lists unknown outcomes first and never labels
unverified work as success.

## Cleanup

The demo, tutorial and test pipelines remove their containers. Delete the evidence bucket when
you no longer need the reports. For deployments, run `bash infra/gcp/teardown.sh` (see
deployment-gcp.md); it reports each deleted, retained or failed resource.
