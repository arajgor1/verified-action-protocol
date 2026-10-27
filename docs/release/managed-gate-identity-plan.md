# Managed gate on the final digest: identity plan

**Status (2026-10-27): Plan B was authorized and run; Plan A was not authorized and has never
been applied.** Results, cleanup and spend are in
[managed-staging-results.md](managed-staging-results.md). The run found a defect in
`gate-identities.sh`, described next.

**Defect in `gate-identities.sh` (765be87).** `gcloud iam service-accounts create` and the
repository bindings run without `--project`. They therefore act on gcloud's active project, not
`VAP_GCP_PROJECT`. In the Plan B run, this created one empty service account in the existing
project; it was deleted. Until the script is fixed in a later candidate, run it only with
`CLOUDSDK_CORE_PROJECT` set to the same project as `VAP_GCP_PROJECT`. The commands in section 3
now do this. Both plans run the managed gate (`managed-provision`, `deploy`,
`managed-teardown`) on runtime image
`sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849` without the project's
default build identity, which holds `roles/owner` and is not modified. Every grant below is
derived from the pipelines' commands at `765be87` and has not been exercised: a missing
permission surfaces as a failed step, and the gate's own teardown steps still run.

**This replaces the identity plan prepared earlier** (`infra/gcp/gate-identities.sh` as committed
at `765be87`). In a shared project, that plan leaves two standing permissions that the owner
asked to remove:
- project-wide service-account deletion (`roles/iam.serviceAccountDeleter`, unconditioned);
- act-as administration over every service account in the project (`roles/iam.serviceAccountAdmin`,
  limited only in which roles it may grant).

Plan A removes both inside the existing project. Plan B keeps the script unchanged, but runs it in
a new project that holds nothing else and is deleted afterwards. **Plan B is recommended**
(section 3).

## 1. Facts this plan relies on

These were checked on 2026-10-27. Google's documentation was the source for the IAM facts; the
project facts come from a read-only listing.

- **Conditions by resource name.** IAM Conditions on `resource.name` work for Cloud SQL instances,
  Secret Manager secrets and Cloud Storage objects. Cloud Run and Cloud Scheduler do not evaluate
  resource attributes, so a Cloud Run or Scheduler admin role granted on the project cannot be
  narrowed to the exercise's resources.
- **Where conditional role bindings are accepted.** Projects, service accounts, Secret Manager
  secrets, Cloud Run resources and Cloud Storage accept them; Artifact Registry repositories do
  not. A time limit, `request.time < timestamp(...)`, is therefore possible on the project,
  service-account and secret bindings below. It is not possible on the repository binding.
- **The build bucket of the verified project has uniform bucket-level access off.** Bucket-level
  conditions are therefore unavailable, so a bucket grant there covers every object in the
  bucket, including unrelated source archives and the operator-only index.
- **The verified project also holds unrelated resources.** One of them is a second Artifact
  Registry repository. At the time of the listing it held no Cloud Run service or job, no
  Scheduler job, no Cloud SQL instance and no secret.
- **The pipelines tolerate pre-existing resources.** `managed-provision` skips creating a runtime
  service account, secret or Cloud SQL instance that already exists. It still calls
  `setIamPolicy` on each runtime account and secret, and on the project for `cloudsql.client`. It
  adds new versions to the three database-URL secrets, but generates the digest key only when
  that secret does not exist yet.
- **The image must live in the deploying project.** `deploy` accepts an image only from the
  deploying project's own `vap` repository.

## 2. Plan A: inside the existing project, without the two standing permissions

**How it works.** The owner creates, before the run:
- the six runtime accounts (`vap-api`, `vap-worker`, `vap-migrator`, `vap-fixture`,
  `vap-scheduler`, `vap-smoke`);
- the four secret containers;
- the Cloud SQL instance.

The gate identities then never create a service account, and they administer only those six
accounts and four secrets. Every binding that accepts a condition lapses at `$EXP`, a time the
owner chooses, for example six hours after the start.

### Grants

| # | Grant | Resource scope | Condition | Held by | Granted by | Used by | Removed by |
|---|---|---|---|---|---|---|---|
| A1 | `iam.serviceAccountUser` | each gate identity (2 accounts) | until `$EXP` | submitter | owner | submitter: starts builds as that identity | owner deletes the gate identities (step A-R2) |
| A2 | `iam.serviceAccountAdmin` | each of the 6 runtime accounts | until `$EXP` | provisioner | owner | `managed-provision`: describe; grant the deployer act-as and ID-token minting on these accounts | `managed-teardown` deletes the 6 accounts and every binding on them |
| A3 | `iam.serviceAccountAdmin` | each of the 6 runtime accounts | until `$EXP` | deployer | owner | `deploy`: read `vap-smoke`'s policy. `managed-teardown`: delete the accounts | as A2 |
| A4 | `iam.serviceAccountUser` on 5 runtime accounts; `iam.serviceAccountOpenIdTokenCreator` on `vap-smoke` | those accounts only | none (granted by the pipeline) | deployer | provisioner (A2) | `deploy`: deploy as the runtime accounts; mint ID tokens for `vap-smoke` | as A2 |
| A5 | `secretmanager.admin` | each of the 4 `vap-<env>-*` secrets | until `$EXP` | provisioner | owner | add versions; grant runtime accounts access | `managed-teardown` deletes the secrets and their bindings |
| A6 | `secretmanager.admin` | each of the 4 secrets | until `$EXP` | deployer | owner | `deploy`: describe, read policies, read `database-url`. `managed-teardown`: delete | as A5 |
| A7 | `cloudsql.admin` | project | until `$EXP`, **and** instance `vap-<env>` only | provisioner, deployer | owner | provisioner: passwords, labels. Deployer: restart (durability check), delete | owner (A-R2), or lapses at `$EXP` |
| A8 | `cloudsql.viewer` | project | until `$EXP` | provisioner, deployer | owner | operation waits, instance listing | owner (A-R2), or lapses |
| A9 | `resourcemanager.projectIamAdmin` | project | until `$EXP`, **and** may add or remove only `roles/cloudsql.client` | provisioner, deployer | owner | provisioner: grants `cloudsql.client` to 4 runtime accounts, conditioned on the instance. Teardown: removes those grants | owner (A-R2), or lapses |
| A10 | `run.admin`, `cloudscheduler.admin` | project (no narrower scope exists) | until `$EXP` | deployer | owner | deploy, update, invoke and delete the exercise's Cloud Run services and jobs and its Scheduler job | owner (A-R2), or lapses |
| A11 | `secretmanager.viewer`, `iam.serviceAccountViewer`, `iam.securityReviewer`, `logging.viewer` | project (read-only) | until `$EXP` | deployer | owner | prerequisite checks, the IAM-policy evidence, Cloud Run logs, listing in the teardown check | owner (A-R2), or lapses |
| A12 | `logging.logWriter` | project | until `$EXP` | provisioner, deployer | owner | build logs | owner (A-R2), or lapses |
| A13 | `storage.objectViewer`, `storage.objectCreator` | build bucket | **none possible** (uniform access off) | provisioner, deployer | owner | read the source archive; write evidence | owner (A-R2); **does not lapse** |
| A14 | `artifactregistry.reader` | repository `vap` | **none possible** | deployer | owner | read the release image | owner (A-R2); **does not lapse** |

**Not granted to either identity:**
- service-account creation;
- service-account deletion or administration outside the six runtime accounts;
- act-as on any other account;
- Token Creator;
- Owner or Editor;
- any role grant other than `cloudsql.client`.

**Authority that remains during the window (until `$EXP`):**
- **Cloud Run and Scheduler, project-wide (A10).** The deployer can create, modify, delete or
  change the IAM policy of any Cloud Run service or job, and any Scheduler job, in the project.
  For example, it could make a private service publicly invocable. It cannot run code as another
  identity, because each deployment needs act-as, which it holds only on the five runtime
  accounts. None of these resources existed at the time of the listing.
- **Cloud SQL access grants (A9).** Both identities can grant `cloudsql.client` to any principal.
  That role allows connecting to the project's instances; database credentials are still
  required.
- **Logs (A11).** The deployer can read every log in the project.
- **Build bucket (A13).** Both can read every object in the build bucket, including unrelated
  source archives and the operator-only index, and can add objects. This grant does not lapse.
- **Metadata reads (A11).** Service-account names, secret names (not values), instance metadata
  and the project IAM policy.

### Commands (owner, with their own credentials; not run)

```bash
P=<project>; R=<region>; E=staging
EXP=<RFC 3339 UTC time, e.g. six hours after the start>
SUB=<user:... or serviceAccount:... that submits the builds>
PROV=vap-gate-provisioner@$P.iam.gserviceaccount.com; DEPL=vap-gate-deployer@$P.iam.gserviceaccount.com
RUNTIME="vap-api vap-worker vap-migrator vap-fixture vap-scheduler vap-smoke"
SECRETS="database-url migration-database-url fixture-database-url digest-key"
cond() { printf 'title: %s\ndescription: VAP managed gate\nexpression: "%s"\n' "$1" "$2" > "$1.yaml"; }
T="request.time < timestamp('$EXP')"
cond until "$T"
cond sql-until "$T && resource.type == 'sqladmin.googleapis.com/Instance' && resource.name == 'projects/$P/instances/vap-$E'"
cond sqlclient-until "$T && api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly(['roles/cloudsql.client'])"

# A-0: accounts, secret containers and the instance (the instance bills from here; about $0.013/hour)
for a in vap-gate-provisioner vap-gate-deployer $RUNTIME; do gcloud iam service-accounts create $a --project=$P; done
for s in $SECRETS; do gcloud secrets create vap-$E-$s --replication-policy=automatic --project=$P; done
# managed-provision generates the digest key only when the secret is missing, so give the
# pre-created secret its first version here (generated in a pipe, never printed or stored)
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | gcloud secrets versions add vap-$E-digest-key --data-file=- --project=$P
gcloud sql instances create vap-$E --project=$P --database-version=POSTGRES_17 --edition=enterprise \
  --tier=db-f1-micro --region=$R --storage-type=SSD --storage-size=10 --no-storage-auto-increase \
  --backup-start-time=03:00 --retained-backups-count=1 --enable-point-in-time-recovery \
  --retained-transaction-log-days=1 --no-deletion-protection --no-final-backup

# A1
for g in $PROV $DEPL; do gcloud iam service-accounts add-iam-policy-binding $g --project=$P --member=$SUB --role=roles/iam.serviceAccountUser --condition-from-file=until.yaml; done
# A2, A3
for a in $RUNTIME; do for g in $PROV $DEPL; do
  gcloud iam service-accounts add-iam-policy-binding $a@$P.iam.gserviceaccount.com --project=$P --member=serviceAccount:$g --role=roles/iam.serviceAccountAdmin --condition-from-file=until.yaml
done; done
# A5, A6
for s in $SECRETS; do for g in $PROV $DEPL; do
  gcloud secrets add-iam-policy-binding vap-$E-$s --project=$P --member=serviceAccount:$g --role=roles/secretmanager.admin --condition-from-file=until.yaml
done; done
# A7 to A12 (project level)
pb() { gcloud projects add-iam-policy-binding $P --member=serviceAccount:$1 --role=roles/$2 --condition-from-file=$3.yaml >/dev/null; }
for g in $PROV $DEPL; do pb $g cloudsql.admin sql-until; pb $g cloudsql.viewer until; pb $g resourcemanager.projectIamAdmin sqlclient-until; pb $g logging.logWriter until; done
for r in run.admin cloudscheduler.admin secretmanager.viewer iam.serviceAccountViewer iam.securityReviewer logging.viewer; do pb $DEPL $r until; done
# A13, A14 (unconditioned: these resources accept no conditions here)
for g in $PROV $DEPL; do for r in storage.objectViewer storage.objectCreator; do
  gcloud storage buckets add-iam-policy-binding gs://${P}_cloudbuild --member=serviceAccount:$g --role=roles/$r
done; done
gcloud artifacts repositories add-iam-policy-binding vap --project=$P --location=$R --member=serviceAccount:$DEPL --role=roles/artifactregistry.reader

# The gate (submitter); --expires must not be later than $EXP
VAP_BUILD_SERVICE_ACCOUNT=$PROV bash scripts/vap-cloud.sh managed-provision --expires <unix time before $EXP> --deployer $DEPL
VAP_BUILD_SERVICE_ACCOUNT=$DEPL bash scripts/vap-cloud.sh deploy --image $R-docker.pkg.dev/$P/vap/vap@sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849
VAP_BUILD_SERVICE_ACCOUNT=$DEPL bash scripts/vap-cloud.sh managed-teardown   # A-R1
```

### Removal

- **A-R1. `managed-teardown`, run as the deployer.** It deletes:
  - the Cloud Run services and jobs and the Scheduler job;
  - the instance;
  - the four secrets, with their bindings (A5, A6, and the runtime accounts' access);
  - the runtime accounts' `cloudsql.client` grants;
  - the six runtime accounts, with every binding on them (A2, A3, A4).

  It then verifies by listing. If it fails, the owner reruns it, or runs the same deletions with
  their own credentials.
- **A-R2. Owner.** Remove the gate identities' project bindings first, so no
  `deleted:serviceAccount` entries remain. Then remove the bucket and repository bindings. Then
  delete the two gate identities, which also deletes the bindings on them (A1).

  ```bash
  for g in $PROV $DEPL; do
    for r in $(gcloud projects get-iam-policy $P --flatten=bindings --filter="bindings.members:serviceAccount:$g" --format='value(bindings.role)' | sort -u); do
      gcloud projects remove-iam-policy-binding $P --member=serviceAccount:$g --role=$r --all >/dev/null; done
    for r in storage.objectViewer storage.objectCreator; do gcloud storage buckets remove-iam-policy-binding gs://${P}_cloudbuild --member=serviceAccount:$g --role=roles/$r; done
  done
  gcloud artifacts repositories remove-iam-policy-binding vap --project=$P --location=$R --member=serviceAccount:$DEPL --role=roles/artifactregistry.reader
  gcloud iam service-accounts delete $PROV --project=$P --quiet; gcloud iam service-accounts delete $DEPL --project=$P --quiet
  ```
- **A-R3. Check.** Each of the following must print nothing:

  ```bash
  gcloud projects get-iam-policy $P --flatten=bindings --format='value(bindings.members)' | grep -E 'vap-'
  gcloud storage buckets get-iam-policy gs://${P}_cloudbuild --format=json | grep -E 'vap-gate'
  gcloud artifacts repositories get-iam-policy vap --project=$P --location=$R --format=json | grep -E 'vap-gate'
  gcloud iam service-accounts list --project=$P --format='value(email)' | grep -E '^vap-'
  ```

  If A-R2 is missed:
  - the time-conditioned grants (A1 to A12) stop working at `$EXP`, but they stay in the policy
    until they are removed;
  - A13 and A14 never lapse, so the owner must remove them.

## 3. Plan B (recommended): a disposable project, deleted afterwards

**How it works.** The owner creates a new project that holds only this exercise. The gate runs
there with the dedicated identities exactly as committed at `765be87`
(`infra/gcp/gate-identities.sh`). The script's project-wide permissions then cover only the gate
project's own accounts and resources. Deleting the project removes every resource, account and
binding in it.

The main project is touched in two ways only:
- one read grant on repository `vap`, held while the image is copied;
- the evidence, which is copied back to the main project.

**Why recommended:**
- The four residual authorities of Plan A (Cloud Run and Scheduler, Cloud SQL access grants,
  logs, build bucket) have nothing to reach in an empty project.
- Removal is a single, checkable step.
- No file of `765be87` changes.

**Costs and risks of this plan:**
- The image has to be copied by digest into the gate project, because `deploy` accepts only the
  deploying project's own repository.
- The owner needs permission to create a project and link it to billing.
- A deleted project can be restored for 30 days; billing stops when it is shut down.

### Grants

| # | Grant | Resource scope | Held by | Granted by | Used by | Removed by |
|---|---|---|---|---|---|---|
| B1 | Owner (as the creator) | gate project | owner | project creation | setup and removal | project deletion |
| B2 | `cloudbuild.builds.editor`, `logging.viewer`, `storage.admin`, `serviceusage.serviceUsageConsumer` | gate project | submitter | owner | submits builds, reads logs, uploads source, reads evidence | project deletion |
| B3 | every grant made by `gate-identities.sh create` (listed in [../deployment-gcp.md](../deployment-gcp.md), "Dedicated gate identities") | gate project, its build bucket and its `vap` repository | provisioner, deployer, submitter | owner (runs the script) | the gate | project deletion |
| B4 | `artifactregistry.writer` | gate project's `vap` repository | deployer | owner | the image copy | project deletion |
| B5 | `artifactregistry.reader` | **main project's** `vap` repository | deployer of the gate project | owner | the image copy only | owner removes it immediately after the copy (B-4), and checks again at the end (B-7) |

**Remaining authority, and where it ends.**
- **Inside the gate project.** The authority listed for the 765be87 script applies:
  - the provisioner can grant act-as on any account in the gate project;
  - the deployer can delete any account and modify any Cloud Run or Scheduler resource there.

  Every such account and resource belongs to the exercise.
- **In the main project.** For as long as B5 exists, the gate project's deployer can read every
  image in the main project's `vap` repository, including the excluded worker-browser image. It
  cannot change anything there.

### Commands (owner, with their own credentials, except the builds; not run)

```bash
MAIN=<project>; GATE=<new project id>; R=<region>; SUB=<submitter>; BILLING=<billing account id>
DIGEST=sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849

# B-1: project, billing, APIs, repository, build bucket
gcloud projects create $GATE --name="VAP managed gate (disposable)" --labels=vap-purpose=managed-gate
gcloud billing projects link $GATE --billing-account=$BILLING
gcloud services enable cloudbuild.googleapis.com storage.googleapis.com logging.googleapis.com \
  run.googleapis.com artifactregistry.googleapis.com sqladmin.googleapis.com sql-component.googleapis.com \
  secretmanager.googleapis.com cloudscheduler.googleapis.com iam.googleapis.com iamcredentials.googleapis.com \
  cloudresourcemanager.googleapis.com --project=$GATE
gcloud artifacts repositories create vap --repository-format=docker --location=$R --project=$GATE
gcloud storage buckets create gs://${GATE}_cloudbuild --project=$GATE --location=$R --uniform-bucket-level-access

# B-2: the submitter (B2), then the dedicated identities exactly as committed (B3)
for r in cloudbuild.builds.editor logging.viewer storage.admin serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding $GATE --member=$SUB --role=roles/$r --condition=None; done
CLOUDSDK_CORE_PROJECT=$GATE VAP_GCP_PROJECT=$GATE VAP_GCP_REGION=$R VAP_SUBMITTER=$SUB bash infra/gcp/gate-identities.sh create
PROV=vap-gate-provisioner@$GATE.iam.gserviceaccount.com; DEPL=vap-gate-deployer@$GATE.iam.gserviceaccount.com

# B-3: copy the image by digest (B4, B5), as a build in the gate project
gcloud artifacts repositories add-iam-policy-binding vap --project=$GATE --location=$R --member=serviceAccount:$DEPL --role=roles/artifactregistry.writer
gcloud artifacts repositories add-iam-policy-binding vap --project=$MAIN --location=$R --member=serviceAccount:$DEPL --role=roles/artifactregistry.reader
cat > copy-image.yaml <<'EOF'
steps:
  - name: gcr.io/cloud-builders/docker@sha256:0aca0f95e1ba8f9107263d3e9782d5ce99a5b60d35b3f8985e4534b65552636f
    entrypoint: bash
    args: ["-c", "set -e; docker pull $_SRC; docker tag $_SRC $_DST; docker push $_DST"]
options: {logging: CLOUD_LOGGING_ONLY}
EOF
gcloud builds submit --no-source --config=copy-image.yaml --project=$GATE --region=$R \
  --service-account=projects/$GATE/serviceAccounts/$DEPL \
  --substitutions=_SRC=$R-docker.pkg.dev/$MAIN/vap/vap@$DIGEST,_DST=$R-docker.pkg.dev/$GATE/vap/vap:0.1.0-rc.1
# The copy must keep the digest. If this fails, stop: the gate would not test the exact image.
gcloud artifacts docker images describe $R-docker.pkg.dev/$GATE/vap/vap@$DIGEST

# B-4: remove the cross-project read grant at once
gcloud artifacts repositories remove-iam-policy-binding vap --project=$MAIN --location=$R --member=serviceAccount:$DEPL --role=roles/artifactregistry.reader

# B-5: the gate (submitter)
export VAP_GCP_PROJECT=$GATE VAP_GCP_REGION=$R VAP_EVIDENCE_BUCKET=${GATE}_cloudbuild/vap-evidence
VAP_BUILD_SERVICE_ACCOUNT=$PROV bash scripts/vap-cloud.sh managed-provision --expires $(( $(date +%s) + 4*3600 )) --deployer $DEPL
VAP_BUILD_SERVICE_ACCOUNT=$DEPL bash scripts/vap-cloud.sh deploy --image $R-docker.pkg.dev/$GATE/vap/vap@$DIGEST
VAP_BUILD_SERVICE_ACCOUNT=$DEPL bash scripts/vap-cloud.sh managed-teardown

# B-6: copy the evidence to the main project's private evidence location
gcloud storage cp -r gs://${GATE}_cloudbuild/vap-evidence/* gs://<main evidence location>/managed-gate/

# B-7: delete the project, then check that the main project holds no grant for it
gcloud projects delete $GATE --quiet
gcloud artifacts repositories get-iam-policy vap --project=$MAIN --location=$R --format=json | grep -c "@$GATE\." # must print 0
```

**Plain Docker for the copy.** The copy uses the Docker builder the pipelines already pin, not a
new tool. Docker is expected to keep the digest of a single-platform image it pulled from a
registry, but this is not guaranteed. The `describe ...@$DIGEST` check therefore decides: if
the digest differs, the run stops before any deployment spend. A digest-preserving copy tool
(`crane`) would then need its own pinned image and approval.

## 4. Bounded spend (both plans)

| Item | Estimate (list prices) |
|---|---|
| One clean pass: provision, deploy and teardown builds, about 40 build-minutes | $0.24, or within the free monthly build minutes |
| Cloud SQL `db-f1-micro`, about 1.5 hours | $0.02 |
| Cloud Run, Scheduler, Secret Manager | a few cents |
| Plan B only: copy build (about 2 minutes), image storage until deletion | under $0.05 |
| **One clean pass** | **about $0.30 (A) or $0.35 (B)** |

**Stop rule.** At most two attempts of the provision, deploy and teardown sequence, and one image
copy:
- stop and report after the second failure, or after any teardown that leaves resources behind;
- worst case about $2;
- **requested ceiling: $5**.

Google Cloud budgets only send notifications and do not stop spending, so the ceiling is enforced
by the stop rule, not by billing. Plan B can add a budget alert on the gate project.

## 5. What the gate does and does not cover

It covers the managed deployment checks of [managed-staging-results.md](managed-staging-results.md)
on the exact release digest, run with dedicated identities instead of an Owner identity.

It does not cover the two remaining end-to-end checks
([publication-plan.md](publication-plan.md), section 4):
- E1, a fresh install from the public npm registry;
- E2, a live SDK call against the final managed image.
