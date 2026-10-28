# Quickstart check (fresh environment)

The two README commands, run unchanged in a fresh Cloud Build environment (a clean Docker host
with Docker Compose v2.35.1) from the repository files alone. Nothing in the monorepo is
installed or built. Pipeline: `infra/gcp/cloudbuild.quickstart.yaml`, dispatched with
`bash scripts/vap-cloud.sh quickstart`.

| Mode | Image | SDK source |
|---|---|---|
| `prepublication` | the release image by digest `sha256:d79c04bd…2c864849`, from the private registry | the release tarballs, checked against the release's `SHA256SUMS` |
| `public` (after publication) | the published image, pulled by the Compose file's default reference | `npm install` from the public registry |

## What each run checks

- `docker compose -f examples/quickstart/compose.yaml run --rm demo` exits 0, the dropped
  response is reported `unknown` before reconciliation, and the summary line confirms it was
  reconciled to `verified` with exactly one destination write.
- The image in the Compose file is the accepted digest, and its revision label is `765be87`.
- The running `api`, `worker` and `fixture` containers run as uid 1000, unprivileged, with all
  capabilities dropped, no added capabilities, no devices, an empty effective capability set and
  `NoNewPrivs: 1`.
- `docker compose -f examples/quickstart/compose.yaml run --rm connect` installs the SDK and
  prints a `verified` outcome.
- `docker compose ... down -v` leaves no container, network or volume of the project.

## Runs

| Cloud Build | Commit | Mode | Result |
|---|---|---|---|
| `9b29bc3b` | `77d48f6` | prepublication | **FAILED** in the demo: after reconciliation the operation stayed `completed_unverified` with verification `pending`. The API ran with inline dispatch, which does not pick up the verification that reconciliation queues; in the cloud demo a test harness drained that work explicitly. Fixed by running a separate worker container, the configuration the staging rehearsal validated, with a shared digest key |
| `fd1bd623` | `d9e9845` | prepublication | **FAILED** in the connect example: the demo passed; `prepare` was refused (`FORBIDDEN`) because the example's grant ceiling (risk tier 1) was below `issues.create` (compensable, tier 2). Fixed in the example |
| `44bd2c7e` | `6b375d1` | prepublication | **PASSED**: demo, hardening checks, connect example (`added 9 packages`, outcome `verified`), cleanup |
| `5d858653` | `b55d1cc` | prepublication | **PASSED**, on the validated source commit: same checks |

Commit `b55d1cc` is the validated source commit; it holds the final quickstart and connect
files (the only change after `6b375d1` is the Compose file's default image reference, which the
prepublication mode overrides and the public run uses).

The `public` run is part of the publication sequence: it runs after the image and packages are
published and its result is added here.

**Cost:** about 4 build-minutes per run on the default machine type.
