#!/usr/bin/env bash
# Creates (or removes) the two dedicated build identities for the managed staging gate, so the
# gate does not run as the project's default build identity. Run by the project owner with their
# own gcloud credentials; it changes project IAM and is not run by any pipeline.
#
#   VAP_GCP_PROJECT=<project> VAP_SUBMITTER=<user or service account that submits the builds> \
#     bash infra/gcp/gate-identities.sh create|remove
#
# vap-gate-provisioner runs `managed-provision`; vap-gate-deployer runs `deploy` and
# `managed-teardown` (docs/deployment-gcp.md, "Dedicated gate identities"). Neither is given
# Owner, Editor, project-wide act-as, Token Creator, or the ability to grant roles other than the
# ones named in the conditions below. These bindings are derived from the pipelines' commands and
# have not yet been exercised.
set -euo pipefail
: "${VAP_GCP_PROJECT:?set VAP_GCP_PROJECT}"
: "${VAP_SUBMITTER:?set VAP_SUBMITTER (user:<email> or serviceAccount:<email>)}"
P="$VAP_GCP_PROJECT"; N=$(gcloud projects describe "$P" --format='value(projectNumber)')
E="${VAP_ENVIRONMENT:-staging}"; REGION="${VAP_GCP_REGION:-us-central1}"
BUCKET="${VAP_BUILD_BUCKET:-${P}_cloudbuild}"   # source archives and the evidence prefix
PROV="vap-gate-provisioner@$P.iam.gserviceaccount.com"
DEPL="vap-gate-deployer@$P.iam.gserviceaccount.com"
[[ "$VAP_SUBMITTER" =~ ^(user|serviceAccount):[^,[:space:]]+$ ]] || { echo "VAP_SUBMITTER must be user:<email> or serviceAccount:<email>" >&2; exit 2; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

cond() { # file title expression
  printf 'title: %s\ndescription: VAP managed gate\nexpression: "%s"\n' "$2" "$3" > "$T/$1.yaml"
}
# setIamPolicy may only add or remove these roles (IAM Conditions on role grants).
cond grants-sqlclient "grants-cloudsql-client-only" "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly(['roles/cloudsql.client'])"
cond grants-actas "grants-actas-and-idtoken-only" "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly(['roles/iam.serviceAccountUser', 'roles/iam.serviceAccountOpenIdTokenCreator'])"
cond sql-instance "vap-$E-instance-only" "resource.type == 'sqladmin.googleapis.com/Instance' && resource.name == 'projects/$P/instances/vap-$E'"
cond env-secrets "vap-$E-secrets-only" "resource.name.startsWith('projects/$N/secrets/vap-$E-')"
cond runtime-secret "vap-$E-database-url-only" "resource.name.startsWith('projects/$N/secrets/vap-$E-database-url/')"

# role [condition file]
PROV_ROLES=(
  "roles/iam.serviceAccountCreator"
  "roles/iam.serviceAccountAdmin grants-actas"
  "roles/resourcemanager.projectIamAdmin grants-sqlclient"
  "roles/cloudsql.admin"
  "roles/secretmanager.admin"
  "roles/logging.logWriter"
)
DEPL_ROLES=(
  "roles/run.admin"
  "roles/cloudscheduler.admin"
  "roles/cloudsql.admin sql-instance"
  "roles/cloudsql.viewer"
  "roles/secretmanager.admin env-secrets"
  "roles/secretmanager.secretAccessor runtime-secret"
  "roles/secretmanager.viewer"
  "roles/iam.serviceAccountViewer"
  "roles/iam.serviceAccountDeleter"
  "roles/resourcemanager.projectIamAdmin grants-sqlclient"
  "roles/iam.securityReviewer"
  "roles/logging.viewer"
  "roles/logging.logWriter"
)

binding() { # add|remove member "role [cond]"
  local op="$1" m="$2" role="${3%% *}" c="" ; [ "$3" = "$role" ] || c="${3#* }"
  local args=(--member="$m" --role="$role")
  if [ -n "$c" ]; then args+=(--condition-from-file="$T/$c.yaml"); else args+=(--condition=None); fi
  if [ "$op" = add ]; then gcloud projects add-iam-policy-binding "$P" "${args[@]}" >/dev/null
  else gcloud projects remove-iam-policy-binding "$P" "${args[@]/--condition=None/--all}" >/dev/null 2>&1 || true; fi
  echo "$op $role${c:+ (condition $c)} for ${m#serviceAccount:}"
}

case "${1:-}" in
  create)
    for a in vap-gate-provisioner vap-gate-deployer; do
      gcloud iam service-accounts describe "$a@$P.iam.gserviceaccount.com" >/dev/null 2>&1 \
        || gcloud iam service-accounts create "$a" --display-name="VAP managed gate ($a)" --description="Dedicated build identity for the VAP managed staging gate" >/dev/null
      # The submitting principal may start builds that run as this account (act-as on it only).
      gcloud iam service-accounts add-iam-policy-binding "$a@$P.iam.gserviceaccount.com" --member="$VAP_SUBMITTER" --role=roles/iam.serviceAccountUser >/dev/null
      echo "account $a ready; submitter may run builds as it"
    done
    for r in "${PROV_ROLES[@]}"; do binding add "serviceAccount:$PROV" "$r"; done
    for r in "${DEPL_ROLES[@]}"; do binding add "serviceAccount:$DEPL" "$r"; done
    for m in "serviceAccount:$PROV" "serviceAccount:$DEPL"; do
      # Read the uploaded source archive; write evidence under the same bucket.
      gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="$m" --role=roles/storage.objectViewer >/dev/null
      gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="$m" --role=roles/storage.objectCreator >/dev/null
      echo "bucket $BUCKET objectViewer and objectCreator for ${m#serviceAccount:}"
    done
    gcloud artifacts repositories add-iam-policy-binding vap --location="$REGION" --member="serviceAccount:$DEPL" --role=roles/artifactregistry.reader >/dev/null
    echo "artifactregistry.reader on repository vap for $DEPL"
    ;;
  remove)
    for r in "${PROV_ROLES[@]}"; do binding remove "serviceAccount:$PROV" "$r"; done
    for r in "${DEPL_ROLES[@]}"; do binding remove "serviceAccount:$DEPL" "$r"; done
    for m in "serviceAccount:$PROV" "serviceAccount:$DEPL"; do
      for role in roles/storage.objectViewer roles/storage.objectCreator; do
        gcloud storage buckets remove-iam-policy-binding "gs://$BUCKET" --member="$m" --role="$role" >/dev/null 2>&1 || true
      done
    done
    gcloud artifacts repositories remove-iam-policy-binding vap --location="$REGION" --member="serviceAccount:$DEPL" --role=roles/artifactregistry.reader >/dev/null 2>&1 || true
    for a in vap-gate-provisioner vap-gate-deployer; do
      gcloud iam service-accounts delete "$a@$P.iam.gserviceaccount.com" --quiet >/dev/null 2>&1 && echo "deleted $a" || echo "absent  $a"
    done
    ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
