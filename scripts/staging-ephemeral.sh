#!/usr/bin/env bash
# Ephemeral staging rehearsal helpers (infra/gcp/cloudbuild.staging-rehearsal.yaml). Runs the
# release image by digest as separate containers on the Cloud Build network: migration job,
# synthetic fixture, API (OIDC authentication) and worker, against PostgreSQL whose data lives on
# a named volume so the journal can outlive its container. Every container and the volume carry
# the label vap-run=<run id> and are removed by `cleanup`.
#
#   IMAGE=<registry>/vap/vap@sha256:<digest> RUN_ID=<id> bash scripts/staging-ephemeral.sh <command>
set -euo pipefail
[ "${VAP_CLOUD_EXECUTION:-}" = "1" ] || { echo "refusing to run outside a VAP cloud build" >&2; exit 3; }
: "${IMAGE:?IMAGE (digest reference) is required}" "${RUN_ID:?RUN_ID is required}"
case "$IMAGE" in *@sha256:*) ;; *) echo "IMAGE must be a digest reference" >&2; exit 2;; esac
PG_IMAGE="${PG_IMAGE:?PG_IMAGE is required}"
NET=cloudbuild
LABEL="vap-run=${RUN_ID}"
VOL="vap-pgdata-${RUN_ID}"
ENVFILE=/workspace/.vap-runtime.env   # holds the digest key; never printed, removed by cleanup
AUDIENCE="vap-staging-rehearsal"

common_runtime_env() {
  cat <<EOF
VAP_ENV=test
VAP_DEPLOYMENT_ID=staging-rehearsal
VAP_AUTH_MODE=oidc
VAP_OIDC_AUDIENCE=${AUDIENCE}
VAP_OIDC_ISSUER=http://vap-issuer:8090
VAP_OIDC_JWKS_URL=http://vap-issuer:8090/jwks.json
VAP_DATABASE_URL=postgres://vap_runtime@vap-pg:5432/vap
VAP_DISPATCH_MODE=none
VAP_ISOLATED_TEST_MODE=1
VAP_CONNECTOR_ISSUE_TRACKER_ORIGIN=http://vap-fixture:8081
VAP_IMAGE_DIGEST=${IMAGE}
VAP_CLAIM_LEASE_MS=5000
VAP_WORKER_POLL_MS=200
VAP_SWEEP_INTERVAL_MS=2000
EOF
}

start_pg() {
  docker volume inspect "$VOL" >/dev/null 2>&1 || docker volume create --label "$LABEL" "$VOL" >/dev/null
  docker run -d --network="$NET" --name=vap-pg --label="$LABEL" -e POSTGRES_HOST_AUTH_METHOD=trust \
    -v "$VOL":/var/lib/postgresql/data "$PG_IMAGE" -c max_connections=200 >/dev/null
  # Ready over TCP, as in the other pipelines: on first start the image runs a temporary
  # socket-only server for initialisation, which answers a socket check and then stops.
  for i in $(seq 1 60); do docker exec vap-pg pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && return 0; sleep 1; done
  echo "postgres did not become ready" >&2; return 1
}

start_api() {
  docker run -d --network="$NET" --name=vap-api --label="$LABEL" --env-file "$ENVFILE" \
    -e VAP_HOST=0.0.0.0 -e VAP_PORT=8080 -e VAP_BOOTSTRAP_OPERATORS="$(cat /workspace/smoke-subject)" \
    "$IMAGE" apps/api/dist/main.js >/dev/null
}

start_worker() {
  docker run -d --network="$NET" --name=vap-worker --label="$LABEL" --env-file "$ENVFILE" \
    "$IMAGE" apps/worker/dist/main.js serve >/dev/null
}

case "${1:-}" in
  database)
    start_pg
    # Least-privilege roles as in docs/deployment-gcp.md: the migrator owns the schema, the runtime
    # gets DML only, the fixture owns its own database.
    docker exec -i vap-pg psql -v ON_ERROR_STOP=1 -U postgres <<'SQL'
CREATE ROLE vap_migrator LOGIN;
CREATE ROLE vap_runtime LOGIN;
CREATE ROLE vap_fixture LOGIN;
CREATE DATABASE vap OWNER vap_migrator;
CREATE DATABASE fixture OWNER vap_fixture;
\c vap
ALTER DEFAULT PRIVILEGES FOR ROLE vap_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vap_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE vap_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO vap_runtime;
SQL
    ;;
  migrate)
    docker run --rm --network="$NET" --label="$LABEL" -e VAP_MIGRATION_DATABASE_URL=postgres://vap_migrator@vap-pg:5432/vap \
      "$IMAGE" packages/store-postgres/dist/migrate-cli.js
    # The runtime identity has no DDL rights.
    if docker exec vap-pg psql -U vap_runtime -d vap -c "CREATE TABLE ddl_probe (x int)" >/dev/null 2>&1; then echo "runtime role could run DDL" >&2; exit 1; fi
    echo "runtime role refused DDL as intended"
    ;;
  env)
    umask 077
    { common_runtime_env; echo "VAP_DIGEST_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"; } > "$ENVFILE"
    echo "runtime environment written (digest key generated in the build, not printed)"
    ;;
  refuse-unsafe)
    # Production mode must refuse private test destinations and demo authentication, and refuse
    # for that reason (not because of some unrelated error).
    refuse() { local out; if out=$(docker run --rm --network="$NET" --label="$LABEL" "$@" "$IMAGE" apps/api/dist/main.js 2>&1); then echo "production started with an unsafe configuration" >&2; exit 1; fi
      echo "$out" | grep -q "refusing to start" || { echo "startup failed, but not with the expected refusal" >&2; echo "$out" | tail -5 >&2; exit 1; }; }
    refuse -e VAP_ENV=production -e VAP_ISOLATED_TEST_MODE=1 -e VAP_DATABASE_URL=postgres://vap_runtime@vap-pg:5432/vap -e VAP_DIGEST_KEY=0123456789abcdef0123456789abcdef -e VAP_OIDC_AUDIENCE=x
    refuse -e VAP_ENV=production -e VAP_AUTH_MODE=demo -e VAP_DATABASE_URL=postgres://vap_runtime@vap-pg:5432/vap -e VAP_DIGEST_KEY=0123456789abcdef0123456789abcdef
    echo "unsafe configurations refused at startup"
    ;;
  start)
    # Rehearsal-local OIDC issuer: serves only the public JWKS generated in the build.
    docker run -d --network="$NET" --name=vap-issuer --label="$LABEL" -v /workspace/.issuer-public:/jwks:ro --entrypoint node "$IMAGE"       -e "require('http').createServer((q,s)=>{if(q.url==='/jwks.json'){s.writeHead(200,{'content-type':'application/json'});s.end(require('fs').readFileSync('/jwks/jwks.json'))}else{s.writeHead(404);s.end()}}).listen(8090,'0.0.0.0')" >/dev/null
    docker run -d --network="$NET" --name=vap-fixture --label="$LABEL" -e FIXTURE_DATABASE_URL=postgres://vap_fixture@vap-pg:5432/fixture \
      -e FIXTURE_HOST=0.0.0.0 -e PORT=8081 -e FIXTURE_TEST_CONTROLS=1 -e FIXTURE_CONTROL_HOST=0.0.0.0 -e FIXTURE_CONTROL_PORT=8082 \
      "$IMAGE" fixtures/issue-tracker/dist/main.js >/dev/null
    start_api
    start_worker
    echo "fixture, api and worker started"
    ;;
  crash)
    # Abrupt failure of everything, including the database container: SIGKILL the application
    # processes, then replace the PostgreSQL container. Only the named volume survives.
    docker kill --signal=KILL vap-api vap-worker >/dev/null
    docker rm -f vap-api vap-worker vap-pg >/dev/null
    echo "api and worker killed, database container removed; volume ${VOL} retained"
    ;;
  restart)
    start_pg
    start_api
    start_worker
    echo "database, api and worker restarted on the surviving volume"
    ;;
  logs)
    mkdir -p /workspace/reports
    for c in vap-api vap-worker vap-fixture vap-issuer; do docker logs "$c" > "/workspace/reports/container-$c.log" 2>&1 || true; done
    ;;
  cleanup)
    rm -rf "$ENVFILE" /workspace/.vap-token /workspace/.vap-token-* /workspace/.issuer /workspace/.issuer-public
    ids=$(docker ps -aq --filter "label=$LABEL")
    [ -n "$ids" ] && docker rm -f $ids >/dev/null
    vols=$(docker volume ls -q --filter "label=$LABEL")
    [ -n "$vols" ] && docker volume rm $vols >/dev/null
    left="$(docker ps -aq --filter "label=$LABEL") $(docker volume ls -q --filter "label=$LABEL")"
    if [ -n "$(echo "$left" | tr -d ' ')" ]; then echo "cleanup left resources behind" >&2; exit 1; fi
    echo "cleanup: no container or volume labelled ${LABEL} remains"
    ;;
  *) echo "usage: staging-ephemeral.sh database|migrate|env|refuse-unsafe|start|crash|restart|logs|cleanup" >&2; exit 2 ;;
esac
