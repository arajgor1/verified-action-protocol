# Real-GitHub run (Layer B): setup and procedure

**Status: BLOCKED.** The run waits until the owner supplies all of the following:
- a dedicated repository;
- the private authentication configuration;
- resource limits;
- explicit authorization to create issues.

Nothing here has been executed. No credential value belongs in chat, in the repository, in
build logs or in evidence. The owner creates secrets from their own terminal; the runner only
reads them at build time.

## 1. What the owner provides

| Item | Example form | Where it lives |
|---|---|---|
| Dedicated demo repository | `owner/vap-ci-demo` (used for nothing else; private or public is the owner's choice and is not changed by VAP) | build substitution `_GITHUB_REPOSITORY` |
| GitHub App bot login | `<app-slug>[bot]` | build substitution `_GITHUB_AUTHOR_LOGIN` |
| App id, installation id, private key | three Secret Manager secrets | `projects/<project>/secrets/<name>`; names passed as `_SECRET_APP_ID`, `_SECRET_INSTALLATION_ID`, `_SECRET_PRIVATE_KEY` |
| Issue cap | 1–20 (defaults to 3) | `_MAX_ISSUES`; the runner refuses a plan that could exceed it and stops before any create past it |
| Runs per schedule | 1–3 | `_RUNS` |
| Authorization | `_AUTHORIZED=1` | set only by the owner when submitting |
| Cleanup decision | none, or a list of issue numbers to close | a separate, later cleanup build |

## 2. GitHub App, least privilege

1. Create a GitHub App owned by the repository owner. Webhooks: off. Callback URL: none.
2. **Repository permissions:** Issues *Read and write*, Metadata *Read-only* (mandatory). Nothing else: no Contents, Pull requests, Actions, Administration, or organization or account permissions.
3. **Install it only on the dedicated repository** ("Only select repositories"). Its installation token then cannot reach any other repository.
4. Generate one private key. Store it straight into Secret Manager from your own machine (step 3) and delete the downloaded file afterwards. Do not paste it anywhere.
5. Note the app id, the installation id (from the installation URL) and the bot login `<app-slug>[bot]`. The adapter only accepts issues authored by that login when it resolves a lost reply.

The adapter exchanges a 9-minute RS256 app JWT for an installation token that lasts at most one
hour. It registers the key, the JWT and the token for redaction, and sends them only over HTTPS
(via the loopback fault proxy in this test build; see the limitations).

## 3. Secret Manager, least privilege

The owner runs these commands, with `gcloud` authenticated as themselves. Values come from
files or stdin and are never echoed:

```bash
gcloud secrets create vap-demo-github-app-id --replication-policy=automatic --project=<project>
gcloud secrets versions add vap-demo-github-app-id --data-file=- --project=<project>   # type the id, then Ctrl-D
gcloud secrets create vap-demo-github-installation-id --replication-policy=automatic --project=<project>
gcloud secrets versions add vap-demo-github-installation-id --data-file=- --project=<project>
gcloud secrets create vap-demo-github-app-private-key --replication-policy=automatic --project=<project>
gcloud secrets versions add vap-demo-github-app-private-key --data-file=<path to the downloaded .pem> --project=<project>
```

**Runner permissions.** Use a dedicated service account for these builds (for example
`vap-demo-github-runner@<project>.iam.gserviceaccount.com`), not a broad default or shared
account. It needs:

| Permission | Granted on | Why |
|---|---|---|
| `roles/secretmanager.secretAccessor` (contains `secretmanager.versions.access`) | each of the three secrets, individually: `gcloud secrets add-iam-policy-binding <secret> --member=serviceAccount:<runner> --role=roles/secretmanager.secretAccessor` | Cloud Build `availableSecrets` reads the `latest` version at build start |
| `roles/logging.logWriter` | project | build logs (`CLOUD_LOGGING_ONLY`) |
| `roles/storage.objectCreator` | the evidence bucket only | upload reports |
| `roles/artifactregistry.reader` | not needed | the build uses public, digest-pinned images |

It needs **no** project-level Secret Manager role and no `secretmanager.secrets.list`,
`.get`, `.create` or `.setIamPolicy`. Whoever submits the build needs
`roles/cloudbuild.builds.editor` and `iam.serviceAccounts.actAs` on the runner account
(`roles/iam.serviceAccountUser` on that account only). Submit with
`--service-account=projects/<project>/serviceAccounts/<runner>`.

## 4. Procedure

1. Make sure the candidate commit passed its cloud gates (see `docs/release/candidate-evidence.md`).
2. The owner submits the build from the candidate commit's archive:

   ```bash
   gcloud builds submit <archive of the commit> --config infra/gcp/cloudbuild.demo-github.yaml \
     --service-account=projects/<project>/serviceAccounts/<runner> \
     --substitutions=_RUN_ID=<id>,_COMMIT_SHA=<sha>,_EVIDENCE_BUCKET=<bucket>,_GITHUB_REPOSITORY=<owner/repo>,_GITHUB_AUTHOR_LOGIN=<app-slug>[bot],_SECRET_APP_ID=<name>,_SECRET_INSTALLATION_ID=<name>,_SECRET_PRIVATE_KEY=<name>,_MAX_ISSUES=3,_RUNS=1,_AUTHORIZED=1
   ```

3. The build runs three schedules once each by default: normal, response lost after the create,
   and a crash while the create's reply is in flight. It creates at most `_MAX_ISSUES` issues. The
   evaluator then reads GitHub directly (not through the proxy) and records each issue's origin
   evidence.
4. Outputs: `ci-demo-github-results.json` and `github-resources.json` (every accepted create, with
   its issue URL), both in `gs://<bucket>/demo-github/<run id>/`. Issues stay open.
5. Cleanup, only on the owner's decision: `node demo/ci-failure/cleanup-github.ts --close --only <numbers>`
   with `VAP_GITHUB_CLEANUP_AUTHORIZED=1`, in a build that uses the same secrets and runner account
   ([ci-failure-cleanup.md](ci-failure-cleanup.md)). The app cannot delete issues and notifications cannot be
   recalled.

## 5. What a real run will and will not show

- **It will show:** that the adapter, marker lookup and attribution rules work against
  `api.github.com`, including after a lost reply and a crash.
- **It will not show:** exactly-once creation. GitHub cannot deduplicate, and an issue found after
  a lost reply has an *inferred* origin: expected repository, app identity, marker, planned
  content, created after acceptance. It is not proven to come from this operation.
- **Approvals:** they stay scripted (one per planned create, the demo's policy), so human latency
  is not measured.
