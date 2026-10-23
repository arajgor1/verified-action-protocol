# CI-failure demo: created resources and cleanup

## Fixture layer (Layer A)

Everything runs inside one Cloud Build job: a disposable PostgreSQL container (label
`vap-run=<run id>`), per-run databases (dropped at the end of each run), the fixture and runtime
processes. The pipeline's `teardown` step removes the container; nothing outlives the build.
Evidence goes to `gs://<evidence bucket>/runs/<run id>/` (30-day lifecycle).

## Real GitHub (Layer B)

`demo/ci-failure/run-github.ts` writes `github-resources.json` listing every issue the
destination accepted (from the fault proxy's records, including issues whose reply was dropped):
repository, issue number, URL, workflow id, scenario and condition. Issues are left open.

To review them (read-only):

```bash
node demo/ci-failure/cleanup-github.ts
```

To close them, only after the repository owner authorizes the cleanup scope:

```bash
VAP_GITHUB_CLEANUP_AUTHORIZED=1 node demo/ci-failure/cleanup-github.ts --close --only 12,13,14
```

Both need `VAP_GITHUB_REPOSITORY` and the GitHub App variables from the secret store. A GitHub
App cannot delete issues; closing sets `state_reason: not_planned`. Notifications already sent to
watchers cannot be recalled, which is why the action is tier 3. Run the cleanup in a Cloud Build
step with the same `availableSecrets` block as `infra/gcp/cloudbuild.demo-github.yaml`.
