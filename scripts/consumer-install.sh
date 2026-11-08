#!/usr/bin/env bash
# Release gate: installs the packed npm tarballs into an empty consumer project in a fresh
# directory with its own HOME and npm cache, as a user of the published packages would, then runs
# the documented SDK example (docs/sdk-example.md) and a TypeScript check of the published
# declarations. Fails if the default installation brings in Playwright or browser binaries, or if
# any package of the scope would be fetched from a registry instead of the local tarballs.
#
#   bash scripts/consumer-install.sh <directory with *.tgz> <report file>
set -euo pipefail
PKGS="$(cd "$1" && pwd)"; REPORT="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; SRC="$(pwd)"
SCOPE="verified-action-protocol"
C="$(mktemp -d /tmp/consumer.XXXXXX)"
export HOME="$C/home" npm_config_cache="$C/npm-cache" npm_config_update_notifier=false
mkdir -p "$HOME" "$C/app"
exec > >(tee "$REPORT") 2>&1

cd "$C/app"
# The scope is not on the public registry yet (and may later hold other packages): any registry
# lookup for it must fail instead of resolving to something other than these tarballs.
printf '@%s:registry=http://127.0.0.1:9/\n' "$SCOPE" > .npmrc
printf '{ "name": "vap-consumer-check", "version": "0.0.0", "private": true, "type": "module" }\n' > package.json
TGZ=("$PKGS"/"$SCOPE"-*.tgz)
[ "${#TGZ[@]}" -eq 5 ] || { echo "expected 5 package tarballs in $PKGS, found ${#TGZ[@]}"; exit 1; }
echo "== npm install (default options) of: $(cd "$PKGS" && ls "$SCOPE"-*.tgz | tr '\n' ' ')"
# HTTP log kept so the report shows every registry request (the blocked scope fails closed).
npm install --no-audit --no-fund --loglevel=http "${TGZ[@]}" 2> "$C/npm-http.log" || { cat "$C/npm-http.log"; exit 1; }
echo "registry requests: $(grep -c 'npm http fetch' "$C/npm-http.log" || true) (blocked-scope requests: $(grep -c '127.0.0.1:9' "$C/npm-http.log" || true))"
grep '127.0.0.1:9' "$C/npm-http.log" | head -5 || true
npm ls --all > "$C/npm-ls.txt" || true
echo "== installed packages: $(grep -c . "$C/npm-ls.txt") lines of npm ls --all"

echo "== Playwright and browser binaries must be absent"
# npm lists the optional peer as "UNMET OPTIONAL DEPENDENCY" when it is not installed.
installed=$(grep -E ' playwright(-core)?@' "$C/npm-ls.txt" | grep -v 'UNMET OPTIONAL DEPENDENCY' || true)
if [ -e node_modules/playwright ] || [ -e node_modules/playwright-core ] || [ -n "$installed" ]; then
  echo "FAIL: the default installation brought in Playwright"; grep -E 'playwright' "$C/npm-ls.txt"; exit 1
fi
grep -E 'playwright' "$C/npm-ls.txt" || true
found=$(find "$C" "$HOME" \( -iname 'ms-playwright' -o -iname 'chromium*' -o -iname 'headless_shell' -o -iname 'chrome' \) -print)
[ -z "$found" ] || { echo "FAIL: browser binaries present: $found"; exit 1; }
echo "ok: no playwright, playwright-core, ms-playwright cache or Chromium in the consumer"

echo "== every package of the scope comes from the local tarballs"
node -e '
  const lock = require(process.cwd() + "/package-lock.json");
  const scoped = Object.entries(lock.packages).filter(([k]) => k.includes("node_modules/@" + process.argv[1] + "/"));
  if (scoped.length !== 5) { console.log("FAIL: expected 5 scoped packages, found " + scoped.length); process.exit(1); }
  for (const [k, v] of scoped) {
    if (!String(v.resolved ?? "").startsWith("file:")) { console.log("FAIL: " + k + " resolved from " + v.resolved); process.exit(1); }
    console.log("ok: " + k + " " + v.version + " <- " + v.resolved.replace(/^.*\//, ""));
  }' "$SCOPE"
test -x node_modules/.bin/vap && test -x node_modules/.bin/vap-migrate && echo "ok: bin entries vap and vap-migrate installed"

echo "== documented SDK example (examples/sdk/offline-check.mjs)"
cp "$SRC/examples/sdk/offline-check.mjs" "$SRC/examples/config/adapters.tutorial.json" .
env -u VAP_URL node offline-check.mjs adapters.tutorial.json

echo "== TypeScript consumer check of the published declarations (skipLibCheck off)"
cp "$SRC/examples/sdk/typecheck.ts" "$SRC/examples/sdk/tsconfig.json" .
npm install --no-audit --no-fund --no-save typescript@5.9.3 @types/node@24.19.1
[ ! -e node_modules/playwright ] || { echo "FAIL: playwright appeared with the TypeScript toolchain"; exit 1; }
npx --no-install tsc -p tsconfig.json
echo "ok: declarations type-check without playwright"
echo "CONSUMER INSTALL PASSED"
