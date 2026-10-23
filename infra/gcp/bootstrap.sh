#!/usr/bin/env bash
# One-time bootstrap of a VAP GCP project, run by the bootstrap operator with their own
# short-lived gcloud login. Creates least-privilege service accounts, Artifact Registry, a
# private evidence bucket, Cloud SQL PostgreSQL, Secret Manager secrets (generated here and
# never printed) and IAM bindings. Owner-specific values come from the environment only.
#
#   VAP_GCP_PROJECT=<project> VAP_GCP_REGION=<region> VAP_EVIDENCE_BUCKET=<bucket> \
#   VAP_ENVIRONMENT=staging bash infra/gcp/bootstrap.sh
#
# Cost note: Cloud SQL is billed while it exists (db-f1-micro is the smallest tier). Billing
# alerts are not hard caps; delete the instance with teardown.sh when finished.
set -euo pipefail

: "${VAP_GCP_PROJECT:?set VAP_GCP_PROJECT}"
: "${VAP_GCP_REGION:?set VAP_GCP_REGION}"
: "${VAP_EVIDENCE_BUCKET:?set VAP_EVIDENCE_BUCKET}"
ENVIRONMENT="${VAP_ENVIRONMENT:-staging}"
P="$VAP_GCP_PROJECT"
R="$VAP_GCP_REGION"
LABELS="vap-env=${ENVIRONMENT},vap-owner=vap-bootstrap"
g() { gcloud --project="$P" "$@"; }
sa() { echo "$1@${P}.iam.gserviceaccount.com"; }

echo "enabling APIs"
g services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com sqladmin.googleapis.com \
  secretmanager.googleapis.com cloudscheduler.googleapis.com iam.googleapis.com storage.googleapis.com

echo "service accounts"
for a in vap-ci-submitter vap-build vap-release-builder vap-api vap-worker vap-migrator vap-fixture vap-scheduler vap-deployer vap-janitor vap-smoke; do
  g iam service-accounts describe "$(sa $a)" >/dev/null 2>&1 || g iam service-accounts create "$a" --display-name="VAP $a"
done

echo "artifact registry"
g artifacts repositories describe vap --location="$R" >/dev/null 2>&1 || \
  g artifacts repositories create vap --repository-format=docker --location="$R" --labels="$LABELS" --description="VAP immutable images"

echo "private evidence bucket"
gcloud storage buckets describe "gs://${VAP_EVIDENCE_BUCKET}" --project="$P" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://${VAP_EVIDENCE_BUCKET}" --project="$P" --location="$R" --uniform-bucket-level-access --public-access-prevention
cat > /tmp/vap-lifecycle.json <<'JSON'
{"rule":[{"action":{"type":"Delete"},"condition":{"age":30}}]}
JSON
gcloud storage buckets update "gs://${VAP_EVIDENCE_BUCKET}" --lifecycle-file=/tmp/vap-lifecycle.json --update-labels="$LABELS"

echo "Cloud SQL PostgreSQL (journal and fixture databases)"
INSTANCE="vap-${ENVIRONMENT}"
g sql instances describe "$INSTANCE" >/dev/null 2>&1 || \
  g sql instances create "$INSTANCE" --database-version=POSTGRES_17 --region="$R" --tier=db-f1-micro --edition=ENTERPRISE \
    --storage-auto-increase --backup-start-time=03:00 --enable-point-in-time-recovery --labels="$LABELS"
for db in vap fixture; do g sql databases describe "$db" --instance="$INSTANCE" >/dev/null 2>&1 || g sql databases create "$db" --instance="$INSTANCE"; done

secret() { # name value-producing-command
  if ! g secrets describe "$1" >/dev/null 2>&1; then
    g secrets create "$1" --replication-policy=automatic --labels="$LABELS" >/dev/null
    eval "$2" | g secrets versions add "$1" --data-file=- >/dev/null
  fi
}
rand() { openssl rand -hex 24; }
CONN="${P}:${R}:${INSTANCE}"
for user in vap_migrator vap_runtime vap_fixture; do
  if ! g sql users list --instance="$INSTANCE" --format='value(name)' | grep -qx "$user"; then
    PW="$(rand)"
    g sql users create "$user" --instance="$INSTANCE" --password="$PW" >/dev/null
    case "$user" in
      vap_migrator) secret "vap-${ENVIRONMENT}-migration-database-url" "printf 'postgresql://vap_migrator:%s@localhost/vap?host=/cloudsql/%s' '$PW' '$CONN'" ;;
      vap_runtime) secret "vap-${ENVIRONMENT}-database-url" "printf 'postgresql://vap_runtime:%s@localhost/vap?host=/cloudsql/%s' '$PW' '$CONN'" ;;
      vap_fixture) secret "vap-${ENVIRONMENT}-fixture-database-url" "printf 'postgresql://vap_fixture:%s@localhost/fixture?host=/cloudsql/%s' '$PW' '$CONN'" ;;
    esac
    unset PW
  fi
done
secret "vap-${ENVIRONMENT}-digest-key" "openssl rand -hex 32"
echo "NOTE: grant database privileges once with a SQL client: vap_migrator owns schema public in 'vap';"
echo "      vap_runtime gets SELECT, INSERT, UPDATE, DELETE on all tables and USAGE on sequences (no DDL);"
echo "      vap_fixture owns database 'fixture'. See docs/deployment-gcp.md."

echo "IAM (least privilege)"
bind() { g projects add-iam-policy-binding "$P" --member="serviceAccount:$(sa "$1")" --role="$2" --condition=None >/dev/null; }
bind vap-api roles/cloudsql.client
bind vap-worker roles/cloudsql.client
bind vap-migrator roles/cloudsql.client
bind vap-fixture roles/cloudsql.client
bind vap-scheduler roles/run.invoker
bind vap-deployer roles/run.admin
bind vap-deployer roles/cloudscheduler.admin
bind vap-release-builder roles/artifactregistry.writer
bind vap-janitor roles/run.developer
for s in "vap-${ENVIRONMENT}-database-url" "vap-${ENVIRONMENT}-digest-key"; do
  for a in vap-api vap-worker; do g secrets add-iam-policy-binding "$s" --member="serviceAccount:$(sa $a)" --role=roles/secretmanager.secretAccessor >/dev/null; done
done
g secrets add-iam-policy-binding "vap-${ENVIRONMENT}-migration-database-url" --member="serviceAccount:$(sa vap-migrator)" --role=roles/secretmanager.secretAccessor >/dev/null
g secrets add-iam-policy-binding "vap-${ENVIRONMENT}-fixture-database-url" --member="serviceAccount:$(sa vap-fixture)" --role=roles/secretmanager.secretAccessor >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${VAP_EVIDENCE_BUCKET}" --member="serviceAccount:$(sa vap-api)" --role=roles/storage.objectAdmin >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${VAP_EVIDENCE_BUCKET}" --member="serviceAccount:$(sa vap-worker)" --role=roles/storage.objectAdmin >/dev/null
for a in vap-api vap-worker vap-migrator vap-fixture; do
  g iam service-accounts add-iam-policy-binding "$(sa $a)" --member="serviceAccount:$(sa vap-deployer)" --role=roles/iam.serviceAccountUser >/dev/null
done
# Smoke identity: vap-deployer may mint Google-signed ID tokens for vap-smoke only
# (iam.serviceAccounts.getOpenIdToken on that one account; not Token Creator, which would also
# allow access tokens and blob signing). run.invoker on the API service is granted per service by
# cloudbuild.deploy.yaml.
g iam service-accounts add-iam-policy-binding "$(sa vap-smoke)" --member="serviceAccount:$(sa vap-deployer)"   --role=roles/iam.serviceAccountOpenIdTokenCreator >/dev/null
# The deployer runs the deploy builds: logs and evidence objects only.
bind vap-deployer roles/logging.logWriter
gcloud storage buckets add-iam-policy-binding "gs://${VAP_EVIDENCE_BUCKET}" --member="serviceAccount:$(sa vap-deployer)" --role=roles/storage.objectCreator >/dev/null
# vap-api gets permission to run the worker job with overrides on that single job resource
# only (granted by cloudbuild.deploy.yaml after the job exists); no project-wide Run role and
# no actAs on vap-worker.

echo "done. Configure Cloud Build to run deploy builds as $(sa vap-deployer) and test builds as $(sa vap-build)."
echo "Set a budget alert in the billing console; alerts are not hard spending caps."
