#!/usr/bin/env bash
# Dependency-free cloud dispatcher for workstations that act only as a control interface: it
# needs git and gcloud, installs nothing and runs no repository code locally. It mirrors the
# `vap cloud ...` and `vap release check` commands of the TypeScript CLI.
#
#   bash scripts/vap-cloud.sh demo
#   bash scripts/vap-cloud.sh test   [--suite unit|integration|browser|demo|all] [--commit <sha>]
#   bash scripts/vap-cloud.sh lock
#   bash scripts/vap-cloud.sh release [--commit <sha>] [--history-ref <branch> --strict-history]
#   bash scripts/vap-cloud.sh image-gate --image <registry/path@sha256:...> [--commit <sha>]
#   bash scripts/vap-cloud.sh tutorial [--config examples/config/adapters.tutorial.json]
#   bash scripts/vap-cloud.sh manifest --tested <sha> --images <ref@sha256:...+ref@sha256:...> [--commit <final sha>]
#   bash scripts/vap-cloud.sh browser-linkage --image <registry/path@sha256:...> --image-commit <sha>
#   bash scripts/vap-cloud.sh staging-rehearsal --image <registry/path@sha256:...> [--commit <sha>]
#   bash scripts/vap-cloud.sh deploy --image <registry/path@sha256:...> [--keep]
#   bash scripts/vap-cloud.sh cleanup --run <run_id>
#
# Requires VAP_GCP_PROJECT, VAP_GCP_REGION and VAP_EVIDENCE_BUCKET from the operator's private
# configuration. Fails closed when they are missing; there is no local fallback.
set -euo pipefail

cmd="${1:-}"; shift || true
SUITE=all; COMMIT=""; IMAGE=""; RUN=""; TEARDOWN=true; TESTED=""; IMAGES=""; IMAGE_COMMIT=""; HISTREF="--all"; STRICT=0; CONFIG="examples/config/adapters.tutorial.json"
while [ $# -gt 0 ]; do
  case "$1" in
    --suite) SUITE="$2"; shift 2 ;;
    --commit) COMMIT="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --run) RUN="$2"; shift 2 ;;
    --keep) TEARDOWN=false; shift ;;
    --tested) TESTED="$2"; shift 2 ;;
    --images) IMAGES="$2"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    --image-commit) IMAGE_COMMIT="$2"; shift 2 ;;
    --history-ref) HISTREF="$2"; shift 2 ;;
    --strict-history) STRICT=1; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done

: "${VAP_GCP_PROJECT:?set VAP_GCP_PROJECT (operator-private); refusing to fall back to local execution}"
: "${VAP_GCP_REGION:?set VAP_GCP_REGION}"
: "${VAP_EVIDENCE_BUCKET:?set VAP_EVIDENCE_BUCKET}"
command -v gcloud >/dev/null || { echo "gcloud is required" >&2; exit 2; }

COMMIT="${COMMIT:-$(git rev-parse HEAD)}"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || COMMIT="$(git rev-parse "$COMMIT")"
RUN_ID="${RUN:-r$(date -u +%Y%m%d%H%M%S)$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')}"
OUT="release-out"; mkdir -p "$OUT/evidence"
SRC="$OUT/source-${COMMIT:0:12}.tar.gz"

archive() {
  if [ "${1:-}" = "history" ]; then
    # --all by default; a publication candidate bundles only its own branch (--history-ref).
    git bundle create history.bundle $HISTREF
    git archive --format=tar.gz --add-file=history.bundle -o "$SRC" "$COMMIT"
    rm -f history.bundle
  else
    git archive --format=tar.gz -o "$SRC" "$COMMIT"
  fi
}

submit() { # config substitutions
  local id
  id=$(gcloud builds submit "$SRC" --project="$VAP_GCP_PROJECT" --region="$VAP_GCP_REGION" --config="$1" \
    --substitutions="$2,_EVIDENCE_BUCKET=${VAP_EVIDENCE_BUCKET}" --async --format='value(id)')
  echo "Cloud Build $id (run $RUN_ID, commit $COMMIT)"
  # Follow the build by polling its status (live log streaming needs extra Python modules in
  # gcloud), then print the full log from Cloud Logging, where the pipelines write it. The console
  # URL printed by gcloud above shows the live log as well.
  local st last=""
  while :; do
    st=$(gcloud builds describe "$id" --project="$VAP_GCP_PROJECT" --region="$VAP_GCP_REGION" --format='value(status)')
    [ "$st" != "$last" ] && { echo "status: $st"; last="$st"; }
    case "$st" in QUEUED|PENDING|WORKING) sleep 10 ;; *) break ;; esac
  done
  gcloud beta builds log "$id" --project="$VAP_GCP_PROJECT" --region="$VAP_GCP_REGION" 2>/dev/null \
    || echo "(install the gcloud beta component to print the build log here, or open the console URL above)"
  gcloud builds describe "$id" --project="$VAP_GCP_PROJECT" --region="$VAP_GCP_REGION" \
    --format='json(id,status,startTime,finishTime,results.images)' > "$OUT/evidence/$id.json"
  local status
  status=$(gcloud builds describe "$id" --project="$VAP_GCP_PROJECT" --region="$VAP_GCP_REGION" --format='value(status)')
  echo "build $id: $status (evidence index: $OUT/evidence/$id.json; artifacts: gs://$VAP_EVIDENCE_BUCKET)"
  [ "$status" = "SUCCESS" ]
}

case "$cmd" in
  demo) archive; submit infra/gcp/cloudbuild.demo.yaml "_RUN_ID=$RUN_ID,_COMMIT_SHA=$COMMIT" ;;
  test)
    [[ "$SUITE" =~ ^(unit|integration|browser|demo|all)$ ]] || { echo "--suite must be unit|integration|browser|demo|all" >&2; exit 2; }
    archive; submit infra/gcp/cloudbuild.test.yaml "_RUN_ID=$RUN_ID,_COMMIT_SHA=$COMMIT,_SUITE=$SUITE" ;;
  lock) archive; submit infra/gcp/cloudbuild.lock.yaml "_RUN_ID=$RUN_ID" ;;
  release) archive history; submit infra/gcp/cloudbuild.release.yaml "_RUN_ID=$RUN_ID,_COMMIT_SHA=$COMMIT,_HISTORY_STRICT=$STRICT" ;;
  image-gate)
    [[ "$IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "--image must be an immutable digest reference" >&2; exit 2; }
    archive; submit infra/gcp/cloudbuild.image-gate.yaml "_RUN_ID=$RUN_ID,_COMMIT_SHA=$COMMIT,_IMAGE=$IMAGE" ;;
  tutorial)
    [[ "$CONFIG" =~ ^[A-Za-z0-9._/-]+\.json$ && "$CONFIG" != *..* ]] || { echo "--config must be a repository-relative .json path" >&2; exit 2; }
    git cat-file -e "$COMMIT:$CONFIG" 2>/dev/null || { echo "$CONFIG is not in commit ${COMMIT:0:12}; commit your configuration first (the cloud runs the committed tree)" >&2; exit 2; }
    archive; submit infra/gcp/cloudbuild.tutorial.yaml "_RUN_ID=$RUN_ID,_COMMIT_SHA=$COMMIT,_CONFIG=$CONFIG" ;;
  manifest)
    [[ "$TESTED" =~ ^[0-9a-f]{7,40}$ ]] || { echo "--tested must be the tested commit sha" >&2; exit 2; }
    [[ "$IMAGES" =~ ^[^,]+@sha256:[0-9a-f]{64}(\+[^,]+@sha256:[0-9a-f]{64})*$ ]] || { echo "--images must be digest references joined with +" >&2; exit 2; }
    archive history; submit infra/gcp/cloudbuild.manifest.yaml "_RUN_ID=$RUN_ID,_COMMIT_SHA=$COMMIT,_TESTED_COMMIT=$TESTED,_IMAGES=$IMAGES" ;;
  browser-linkage)
    [[ "$IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "--image must be an immutable digest reference" >&2; exit 2; }
    [[ "$IMAGE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "--image-commit must be the 40-character commit the image was built from" >&2; exit 2; }
    archive; submit infra/gcp/cloudbuild.browser-linkage.yaml "_RUN_ID=$RUN_ID,_COMMIT_SHA=$COMMIT,_IMAGE=$IMAGE,_IMAGE_COMMIT=$IMAGE_COMMIT" ;;
  staging-rehearsal)
    [[ "$IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "--image must be an immutable digest reference" >&2; exit 2; }
    archive; submit infra/gcp/cloudbuild.staging-rehearsal.yaml "_RUN_ID=$RUN_ID,_COMMIT_SHA=$COMMIT,_IMAGE=$IMAGE" ;;
  deploy)
    [[ "$IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "--image must be an immutable digest reference" >&2; exit 2; }
    archive; submit infra/gcp/cloudbuild.deploy.yaml "_RUN_ID=$RUN_ID,_IMAGE=$IMAGE,_ENVIRONMENT=staging,_TEARDOWN=$TEARDOWN" ;;
  cleanup)
    [[ "$RUN" =~ ^[a-z0-9]{6,40}$ ]] || { echo "--run must be a VAP run id" >&2; exit 2; }
    archive; submit infra/gcp/cloudbuild.cleanup.yaml "_RUN_ID=$RUN" ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
