#!/usr/bin/env bash
# Negative controls for the pipelines: proves that a failure inside each wrapper the pipelines
# use actually produces a non-zero exit, instead of trusting `set -e` by inspection. Runs in
# Cloud Build (infra/gcp/cloudbuild.test.yaml, step exit-propagation); it never touches real
# reports. Exits non-zero if any wrapper swallows a failure.
set -uo pipefail
[ "${VAP_CLOUD_EXECUTION:-}" = "1" ] || { echo "refusing to run outside a VAP cloud build" >&2; exit 3; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK" "$ROOT/tests/unit/zz-exit-probe.test.ts"' EXIT
broken=0
expect_fail() { # name, command...
  local name="$1"; shift
  if "$@" >"$WORK/$name.out" 2>&1; then echo "SWALLOWED: $name exited 0"; broken=1; else echo "propagates: $name (exit $?)"; fi
}
expect_ok() {
  local name="$1"; shift
  if "$@" >"$WORK/$name.out" 2>&1; then echo "ok: $name"; else echo "UNEXPECTED FAILURE: $name"; cat "$WORK/$name.out"; broken=1; fi
}

cat > "$WORK/fail.test.mjs" <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
test("deliberate failure", () => assert.equal(1, 2));
EOF
cat > "$WORK/pass.test.mjs" <<'EOF'
import { test } from "node:test";
test("passes", () => {});
EOF

cd "$ROOT"
# 1. node --test with the guard, through the same `| tee` pipeline shape the steps use.
expect_fail node-test-tee bash -c "set -eo pipefail; node --import ./scripts/cloud-guard.ts --test '$WORK/fail.test.mjs' 2>&1 | tee '$WORK/a.log'"
expect_ok node-test-tee-pass bash -c "set -eo pipefail; node --import ./scripts/cloud-guard.ts --test '$WORK/pass.test.mjs' 2>&1 | tee '$WORK/b.log'"
# 2. an npm script wrapper with a failing test file inside its glob.
cp "$WORK/fail.test.mjs" tests/unit/zz-exit-probe.test.ts
expect_fail npm-run-test-unit bash -c "set -eo pipefail; npm run --silent test:unit 2>&1 | tee '$WORK/c.log'"
rm -f tests/unit/zz-exit-probe.test.ts
# 3. a multi-command step: a failing test must stop the commands after it.
expect_fail multi-command-step bash -c "set -eo pipefail; node --import ./scripts/cloud-guard.ts --test '$WORK/fail.test.mjs' 2>&1 | tee '$WORK/d.log'; echo should-not-run > '$WORK/after'"
[ -f "$WORK/after" ] && { echo "SWALLOWED: a command ran after a failing test"; broken=1; }
# 4. evidence aggregation fails on a failing report even when the producing step did not.
mkdir -p "$WORK/rep-fail" "$WORK/rep-pass"
printf 'ℹ tests 3\nℹ pass 2\nℹ fail 1\n' > "$WORK/rep-fail/x.log"
printf 'ℹ tests 3\nℹ pass 3\nℹ fail 0\n' > "$WORK/rep-pass/x.log"
expect_fail evidence-aggregation node scripts/evidence.mjs "$WORK/rep-fail"
expect_ok evidence-aggregation-pass node scripts/evidence.mjs "$WORK/rep-pass"
echo '{"failures": 1}' > "$WORK/rep-fail/scenarios-vap.json"
rm -f "$WORK/rep-fail/x.log" "$WORK/rep-fail/evidence.json"
expect_fail evidence-scenarios node scripts/evidence.mjs "$WORK/rep-fail"
# 5. a node entry point that exits non-zero, through tee.
expect_fail node-exit-tee bash -c "set -eo pipefail; node -e 'process.exit(5)' | tee '$WORK/e.log'"
# 6. the cloud guard itself refuses without the variable.
expect_fail cloud-guard env -u VAP_CLOUD_EXECUTION node --import ./scripts/cloud-guard.ts -e '0'

if [ "$broken" -ne 0 ]; then echo "exit propagation check FAILED"; exit 1; fi
echo "exit propagation check passed"
