#!/usr/bin/env bash
# Creates (or removes) the two dedicated build identities for the managed staging gate, so the
# gate does not run as the project's default build identity. Run by the project owner with their
# own gcloud credentials; it changes project IAM and is not run by any pipeline.
#
#   VAP_GCP_PROJECT=<project id> VAP_SUBMITTER=<user or service account that submits the builds> \
#     [VAP_GCP_PROJECT_NUMBER=<project number>] bash infra/gcp/gate-identities.sh create|remove
#
# Every project-dependent command names VAP_GCP_PROJECT explicitly (--project, or a resource that
# lives in it); the active gcloud project is never read or changed. Before changing anything the
# script checks that the project exists and is ACTIVE, that its id (and number, when
# VAP_GCP_PROJECT_NUMBER is given) matches, and, for `create`, that the build bucket and the `vap`
# repository belong to it. Any mismatch stops it before the first change. Use it only in a project
# dedicated to the exercise (docs/deployment-gcp.md, "Dedicated gate identities").
#
# vap-gate-provisioner runs `managed-provision`; vap-gate-deployer runs `deploy` and
# `managed-teardown`. Neither is given Owner, Editor, project-wide act-as, Token Creator, or the
# ability to grant roles other than the ones named in the conditions below.
set -euo pipefail
die() { echo "gate-identities: $*; nothing was changed" >&2; exit 2; }
case "${1:-}" in create|remove) OP="$1" ;; *) sed -n '2,18p' "$0"; exit 2 ;; esac
P="${VAP_GCP_PROJECT:-}"
[ -n "$P" ] || die "set VAP_GCP_PROJECT to the target project id (the active gcloud project is not used)"
[[ "$P" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "VAP_GCP_PROJECT is not a project id: $P"
[ -n "${VAP_SUBMITTER:-}" ] || die "set VAP_SUBMITTER (user:<email> or serviceAccount:<email>)"
[[ "$VAP_SUBMITTER" =~ ^(user|serviceAccount):[^,[:space:]]+$ ]] || die "VAP_SUBMITTER must be user:<email> or serviceAccount:<email>"
E="${VAP_ENVIRONMENT:-staging}"; REGION="${VAP_GCP_REGION:-us-central1}"
BUCKET="${VAP_BUILD_BUCKET:-${P}_cloudbuild}"   # source archives and the evidence prefix
PROV="vap-gate-provisioner@$P.iam.gserviceaccount.com"
DEPL="vap-gate-deployer@$P.iam.gserviceaccount.com"

# Pre-mutation checks: read-only calls, each naming the target project.
DESC=$(gcloud projects describe "$P" --format='value(projectId,projectNumber,lifecycleState)' 2>/dev/null) || die "project $P not found or not readable"
read -r PID N STATE <<< "$DESC"
[ "${PID:-}" = "$P" ] || die "project lookup for $P returned ${PID:-nothing}"
[[ "${N:-}" =~ ^[0-9]+$ ]] || die "project $P has no project number"
[ "${STATE:-}" = ACTIVE ] || die "project $P is ${STATE:-in an unknown state}, not ACTIVE"
[ -z "${VAP_GCP_PROJECT_NUMBER:-}" ] || [ "$N" = "$VAP_GCP_PROJECT_NUMBER" ] || die "project $P has number $N, not VAP_GCP_PROJECT_NUMBER=$VAP_GCP_PROJECT_NUMBER"
HAVE_BUCKET=0; HAVE_REPO=0
# Captured first: with pipefail, `gcloud ... | grep -q` can fail when grep exits early.
BUCKETS=$(gcloud storage buckets list --project="$P" --format='value(name)' 2>/dev/null || true)
REPO=$(gcloud artifacts repositories describe vap --project="$P" --location="$REGION" --format='value(name)' 2>/dev/null || true)
grep -qxF "$BUCKET" <<< "$BUCKETS" && HAVE_BUCKET=1
grep -qxF "projects/$P/locations/$REGION/repositories/vap" <<< "$REPO" && HAVE_REPO=1
if [ "$OP" = create ]; then
  [ $HAVE_BUCKET = 1 ] || die "bucket $BUCKET is not a bucket of project $P"
  [ $HAVE_REPO = 1 ] || die "repository vap is not in project $P ($REGION)"
fi
echo "target project $P (number $N, ACTIVE); the active gcloud project is not used"
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

case "$OP" in
  create)
    for a in vap-gate-provisioner vap-gate-deployer; do
      gcloud iam service-accounts describe "$a@$P.iam.gserviceaccount.com" --project="$P" >/dev/null 2>&1 \
        || gcloud iam service-accounts create "$a" --project="$P" --display-name="VAP managed gate ($a)" --description="Dedicated build identity for the VAP managed staging gate" >/dev/null
      # The submitting principal may start builds that run as this account (act-as on it only).
      gcloud iam service-accounts add-iam-policy-binding "$a@$P.iam.gserviceaccount.com" --project="$P" --member="$VAP_SUBMITTER" --role=roles/iam.serviceAccountUser >/dev/null
      echo "account $a ready; submitter may run builds as it"
    done
    for r in "${PROV_ROLES[@]}"; do binding add "serviceAccount:$PROV" "$r"; done
    for r in "${DEPL_ROLES[@]}"; do binding add "serviceAccount:$DEPL" "$r"; done
    for m in "serviceAccount:$PROV" "serviceAccount:$DEPL"; do
      # Read the uploaded source archive; write evidence under the same bucket.
      gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --project="$P" --member="$m" --role=roles/storage.objectViewer >/dev/null
      gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --project="$P" --member="$m" --role=roles/storage.objectCreator >/dev/null
      echo "bucket $BUCKET objectViewer and objectCreator for ${m#serviceAccount:}"
    done
    gcloud artifacts repositories add-iam-policy-binding vap --project="$P" --location="$REGION" --member="serviceAccount:$DEPL" --role=roles/artifactregistry.reader >/dev/null
    echo "artifactregistry.reader on repository vap for $DEPL"
    ;;
  remove)
    for r in "${PROV_ROLES[@]}"; do binding remove "serviceAccount:$PROV" "$r"; done
    for r in "${DEPL_ROLES[@]}"; do binding remove "serviceAccount:$DEPL" "$r"; done
    for m in "serviceAccount:$PROV" "serviceAccount:$DEPL"; do
      for role in roles/storage.objectViewer roles/storage.objectCreator; do
        [ $HAVE_BUCKET = 1 ] || continue
        gcloud storage buckets remove-iam-policy-binding "gs://$BUCKET" --project="$P" --member="$m" --role="$role" >/dev/null 2>&1 || true
      done
    done
    [ $HAVE_REPO = 0 ] || gcloud artifacts repositories remove-iam-policy-binding vap --project="$P" --location="$REGION" --member="serviceAccount:$DEPL" --role=roles/artifactregistry.reader >/dev/null 2>&1 || true
    for a in vap-gate-provisioner vap-gate-deployer; do
      gcloud iam service-accounts delete "$a@$P.iam.gserviceaccount.com" --project="$P" --quiet >/dev/null 2>&1 && echo "deleted $a" || echo "absent  $a"
    done
    ;;
esac
