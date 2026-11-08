# Sourced at the top of a Cloud Build step that runs with allowFailure, so that a failure does
# not skip the pipeline's teardown:  source scripts/step-guard.sh <step id>
# - skips the step (exit 0) once any earlier guarded step has failed;
# - turns on fail-fast mode (-e, pipefail);
# - records ok / failed (<exit code>) in /workspace/status/<step id> and, on failure, marks the
#   build failed (/workspace/.failed) for the final verdict step.
[ "${VAP_CLOUD_EXECUTION:-}" = "1" ] || { echo "refusing to run outside a VAP cloud build" >&2; exit 3; }
VAP_STEP="${1:?step id required}"
mkdir -p /workspace/status
if [ -e /workspace/.failed ]; then
  echo skipped > "/workspace/status/$VAP_STEP"
  echo "skipped: an earlier step failed"
  exit 0
fi
trap 'rc=$?; if [ "$rc" -eq 0 ]; then echo ok > "/workspace/status/$VAP_STEP"; else echo "failed ($rc)" > "/workspace/status/$VAP_STEP"; touch /workspace/.failed; fi' EXIT
set -eo pipefail
