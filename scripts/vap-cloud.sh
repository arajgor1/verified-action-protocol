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
#   bash scripts/vap-cloud.sh managed-provision --expires <unix seconds> [--deployer <service account email>]
#   bash scripts/vap-cloud.sh deploy --image <registry/path@sha256:...> [--keep]
#   bash scripts/vap-cloud.sh managed-teardown
#   bash scripts/vap-cloud.sh cleanup --run <run_id>
#   bash scripts/vap-cloud.sh quickstart [--image <registry/path@sha256:...> --packages <gs://release artifacts>]
#   bash scripts/vap-cloud.sh publish --image <registry/path@sha256:...> --packages <gs://release artifacts> --history-ref <branch> [--dry-run-image <registry/path>] [--for-real]
#
# Requires VAP_GCP_PROJECT, VAP_GCP_REGION and VAP_EVIDENCE_BUCKET from the operator's private
# configuration. Fails closed when they are missing; there is no local fallback. Optional:
# VAP_BUILD_SERVICE_ACCOUNT (an email) runs the build as that dedicated build identity instead of
# the project's default one (infra/gcp/gate-identities.sh).
set -euo pipefail

cmd="${1:-}"; shift || true
SUITE=all; COMMIT=""; IMAGE=""; RUN=""; TEARDOWN=true; TESTED=""; IMAGES=""; IMAGE_COMMIT=""; HISTREF="--all"; STRICT=0; EXPIRES=""; DEPLOYER=""; PACKAGES=""; DRY=1; DRYDST=""; CONFIG="examples/config/adapters.tutorial.json"
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
    --expires) EXPIRES="$2"; shift 2 ;;
    --deployer) DEPLOYER="$2"; shift 2 ;;
    --packages) PACKAGES="$2"; shift 2 ;;
    --dry-run-image) DRYDST="$2"; shift 2 ;;
    --for-real) DRY=0; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done

: "${VAP_GCP_PROJECT:?set VAP_GCP_PROJECT (operator-private); refusing to fall back to local execution}"
: "${VAP_GCP_REGION:?set VAP_GCP_REGION}"
: "${VAP_EVIDENCE_BUCKET:?set VAP_EVIDENCE_BUCKET}"
command -v gcloud >/dev/null || { echo "gcloud is required" >&2; exit 2; }
SA_FLAG=()
if [ -n "${VAP_BUILD_SERVICE_ACCOUNT:-}" ]; then
  [[ "$VAP_BUILD_SERVICE_ACCOUNT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z0-9.-]+\.iam\.gserviceaccount\.com$ ]] || { echo "VAP_BUILD_SERVICE_ACCOUNT must be a service account email" >&2; exit 2; }
  SA_FLAG=(--service-account="projects/$VAP_GCP_PROJECT/serviceAccounts/$VAP_BUILD_SERVICE_ACCOUNT")
fi

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
    --substitutions="$2,_EVIDENCE_BUCKET=${VAP_EVIDENCE_BUCKET}" ${SA_FLAG[@]+"${SA_FLAG[@]}"} --async --format='value(id)')
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
  managed-provision)
    [[ "$EXPIRES" =~ ^[0-9]{10}$ ]] || { echo "--expires must be the teardown deadline in unix seconds" >&2; exit 2; }
    [[ -z "$DEPLOYER" || "$DEPLOYER" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z0-9.-]+\.iam\.gserviceaccount\.com$ ]] || { echo "--deployer must be a service account email" >&2; exit 2; }
    archive; submit infra/gcp/cloudbuild.managed-provision.yaml "_RUN_ID=$RUN_ID,_ENVIRONMENT=staging,_EXPIRES=$EXPIRES,_DEPLOYER=$DEPLOYER" ;;
  managed-teardown) archive; submit infra/gcp/cloudbuild.managed-teardown.yaml "_RUN_ID=$RUN_ID,_ENVIRONMENT=staging" ;;
  deploy)
    [[ "$IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "--image must be an immutable digest reference" >&2; exit 2; }
    archive; submit infra/gcp/cloudbuild.deploy.yaml "_RUN_ID=$RUN_ID,_IMAGE=$IMAGE,_ENVIRONMENT=staging,_TEARDOWN=$TEARDOWN" ;;
  cleanup)
    [[ "$RUN" =~ ^[a-z0-9]{6,40}$ ]] || { echo "--run must be a VAP run id" >&2; exit 2; }
    archive; submit infra/gcp/cloudbuild.cleanup.yaml "_RUN_ID=$RUN" ;;
  quickstart)
    # Without --image and --packages: the published image and npm packages (public mode).
    if [ -n "$IMAGE$PACKAGES" ]; then
      [[ "$IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "--image must be an immutable digest reference" >&2; exit 2; }
      [[ "$PACKAGES" =~ ^gs://[a-z0-9_./-]+[a-z0-9]$ ]] || { echo "--packages must be the gs:// directory holding the release tarballs and SHA256SUMS" >&2; exit 2; }
    fi
    archive; submit infra/gcp/cloudbuild.quickstart.yaml "_RUN_ID=$RUN_ID,_COMMIT_SHA=$COMMIT,_IMAGE=$IMAGE,_PACKAGES=$PACKAGES" ;;
  publish)
    # Dry run unless --for-real. Real mode reads the Secret Manager secret versions named by
    # VAP_GITHUB_SECRET and VAP_NPM_SECRET (operator-private; never their values).
    [[ "$IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "--image must be an immutable digest reference" >&2; exit 2; }
    [[ "$PACKAGES" =~ ^gs://[a-z0-9_./-]+[a-z0-9]$ ]] || { echo "--packages must be the gs:// directory holding the release artifacts" >&2; exit 2; }
    [ "$HISTREF" != "--all" ] || { echo "--history-ref <release branch> is required: only that branch's history is published" >&2; exit 2; }
    if [ "$DRY" = 0 ]; then
      [[ "${VAP_GITHUB_SECRET:-}" =~ ^projects/[^/]+/secrets/[^/]+/versions/[^/]+$ && "${VAP_NPM_SECRET:-}" =~ ^projects/[^/]+/secrets/[^/]+/versions/[^/]+$ ]]         || { echo "--for-real needs VAP_GITHUB_SECRET and VAP_NPM_SECRET (secret version resource names)" >&2; exit 2; }
    fi
    archive history; submit infra/gcp/cloudbuild.publish.yaml "_RUN_ID=$RUN_ID,_COMMIT_SHA=$COMMIT,_IMAGE=$IMAGE,_PACKAGES=$PACKAGES,_DRY_RUN=$DRY,_DRYRUN_IMAGE_DST=$DRYDST,_GITHUB_SECRET=${VAP_GITHUB_SECRET:-},_NPM_SECRET=${VAP_NPM_SECRET:-}" ;;
  *) sed -n '2,24p' "$0"; exit 2 ;;
esac
