#!/usr/bin/env bash
# Deletes the VAP resources of one environment and reports each deleted, retained or failed
# resource. Only resources created by bootstrap.sh/cloudbuild.deploy.yaml for that
# environment are touched; nothing else in the project is discovered or deleted.
#
#   VAP_GCP_PROJECT=<project> VAP_GCP_REGION=<region> VAP_ENVIRONMENT=staging \
#   VAP_DELETE_DATABASE=true bash infra/gcp/teardown.sh
set -uo pipefail
: "${VAP_GCP_PROJECT:?}"
: "${VAP_GCP_REGION:?}"
E="${VAP_ENVIRONMENT:-staging}"
P="$VAP_GCP_PROJECT"
R="$VAP_GCP_REGION"
report() { printf '%-10s %s\n' "$1" "$2"; }
try() { local what="$1"; shift; if "$@" --quiet >/dev/null 2>&1; then report deleted "$what"; else report failed "$what"; fi; }

for s in "vap-api-$E" "vap-fixture-$E"; do try "service $s" gcloud run services delete "$s" --project="$P" --region="$R"; done
for j in "vap-worker-$E" "vap-sweeper-$E" "vap-migrate-$E"; do try "job $j" gcloud run jobs delete "$j" --project="$P" --region="$R"; done
try "scheduler vap-sweeper-$E" gcloud scheduler jobs delete "vap-sweeper-$E" --project="$P" --location="$R"
if [ "${VAP_DELETE_DATABASE:-false}" = "true" ]; then
  try "sql instance vap-$E" gcloud sql instances delete "vap-$E" --project="$P"
  for s in database-url migration-database-url fixture-database-url digest-key; do try "secret vap-$E-$s" gcloud secrets delete "vap-$E-$s" --project="$P"; done
else
  report retained "sql instance vap-$E and its secrets (set VAP_DELETE_DATABASE=true to delete; backups follow Cloud SQL retention)"
fi
report retained "evidence bucket and Artifact Registry images (immutable release records)"
