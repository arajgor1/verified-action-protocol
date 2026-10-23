# ADR 0007: Workstation as control interface; lockfile resolved metadata-only

Status: accepted

All installs, builds, tests, browsers and benchmarks for gates run in Cloud Build. The
workstation only creates `git archive`s of exact commits and submits them
(`scripts/vap-cloud.sh`, which needs only git and gcloud). Archive validation and history
scanning run as the first cloud build steps; no repository code runs locally.

The committed `package-lock.json` was produced with
`npm install --package-lock-only --ignore-scripts`, which fetches registry metadata only: it
installs nothing and runs no scripts or repository code. `cloudbuild.lock.yaml` can regenerate it
in the cloud. Transitive `jose` and `zod` are pinned with `overrides` to releases at least two
weeks old.
