# Deploy with Docker (supported path for 0.1.0-rc.1)

The supported deployment for this release is the runtime image, by digest, as separate
containers on a Docker host: a migration job, the API and a worker, with PostgreSQL and an OIDC
issuer you provide. The managed Google Cloud path is experimental ([below](#managed-google-cloud-experimental)).

```text
image: ghcr.io/arajgor1/verified-action-protocol@sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849
```

## What was validated, and what was not

This configuration is the one the **ephemeral staging rehearsal** ran on this exact digest (Cloud
Build `9736a54b`, [release/staging-rehearsal.md](release/staging-rehearsal.md)):
- migrations as a schema-owning role, with the runtime role proven unable to run DDL;
- startup refusals: production mode with private test destinations, and production mode with
  demo authentication, each refused with its own message;
- OIDC authentication against a rehearsal-local issuer: signature, issuer, audience, expiry and
  verified email; wrong-audience, expired, unsigned and missing tokens rejected;
- a separate worker that dispatches, verifies and reconciles;
- restart recovery: API and worker killed with SIGKILL and the database container replaced while
  operations were mid-flight; the journal on its volume survived and every operation reached an
  honest final state (verified, or `unknown`), never a silent resubmission.

Not validated for this release:
- **`VAP_ENV=production` end to end.** The rehearsal ran `VAP_ENV=test` with isolated test mode,
  because its synthetic destination is on a private network that production mode refuses to
  reach. Production mode was exercised only for its startup refusals.
- **Google-issued or other real identity providers.** The rehearsal used a local test issuer.
- TLS termination, backups, upgrades between versions, multiple API replicas and resource sizing.

## Restrictions (conditions of the security acceptance)

The image's residual vulnerabilities were accepted for this digest only under these conditions
([security/runtime-decision-record.md](security/runtime-decision-record.md#deployment-restrictions-that-are-not-enforced-by-the-image)):
- run every VAP container as the image's non-root user (uid 1000): no `--user 0`, no
  `--privileged`, no added capabilities, no host devices, no root commands inside the container
  (`docker exec -u 0`), no host `nsenter` into it;
- do not register CLI recipes that run `mount`, `nsenter`, `blkid`, partition tools, `gzip` or its
  wrappers, `tar` on compressed archives, or terminfo tools on untrusted input.

The image cannot enforce the first group itself; the launcher does. Add `--cap-drop ALL` and
`--security-opt no-new-privileges` to every `docker run` below.

## Steps

**1. PostgreSQL 17 with two roles.** The migrator owns the schema; the runtime gets DML only.

```sql
CREATE ROLE vap_migrator LOGIN PASSWORD '<migrator password>';
CREATE ROLE vap_runtime LOGIN PASSWORD '<runtime password>';
CREATE DATABASE vap OWNER vap_migrator;
\c vap
ALTER DEFAULT PRIVILEGES FOR ROLE vap_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vap_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE vap_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO vap_runtime;
```

**2. A runtime environment file**, readable only by the operator. Generate the digest key once and
keep it: plan digests do not verify across a key change.

```bash
umask 077
cat > vap.env <<EOF
VAP_ENV=production
VAP_DEPLOYMENT_ID=<name>
VAP_DATABASE_URL=postgres://vap_runtime:<runtime password>@<db host>:5432/vap
VAP_DIGEST_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
VAP_AUTH_MODE=oidc
VAP_OIDC_ISSUER=<issuer URL>
VAP_OIDC_JWKS_URL=<issuer JWKS URL>
VAP_OIDC_AUDIENCE=<audience your clients request>
VAP_DISPATCH_MODE=none
VAP_ADAPTERS_CONFIG=/app/config/adapters.json
EOF
```

Tokens must carry a verified `email` claim; it is the principal. For each connector in your
adapters configuration, set `VAP_CONNECTOR_<NAME>_ORIGIN`. Production mode refuses private and
loopback destinations.

**3. Migrate**, as the migrator:

```bash
IMAGE=ghcr.io/arajgor1/verified-action-protocol@sha256:d79c04bd44775e65750fe909f3194ca74ef9c796f10e8995aedb6a9d2c864849
docker run --rm --cap-drop ALL --security-opt no-new-privileges \
  -e VAP_MIGRATION_DATABASE_URL=postgres://vap_migrator:<migrator password>@<db host>:5432/vap \
  "$IMAGE" packages/store-postgres/dist/migrate-cli.js
```

**4. Start the API and the worker.** The first operator gets roles from
`VAP_BOOTSTRAP_OPERATORS` (applied only when the subject has no roles yet); it then assigns roles
to agents through the API (`vap` CLI or `setPrincipalRoles`).

```bash
docker run -d --name vap-api --restart unless-stopped --cap-drop ALL --security-opt no-new-privileges \
  --env-file vap.env -e VAP_BOOTSTRAP_OPERATORS=<operator email> \
  -v "$PWD/adapters.json:/app/config/adapters.json:ro" -p 127.0.0.1:8080:8080 \
  "$IMAGE" apps/api/dist/main.js
docker run -d --name vap-worker --restart unless-stopped --cap-drop ALL --security-opt no-new-privileges \
  --env-file vap.env -v "$PWD/adapters.json:/app/config/adapters.json:ro" \
  "$IMAGE" apps/worker/dist/main.js serve
```

The worker also runs the recovery sweep (requeues missed work, reconciles expired claims,
expires request keys). Put a TLS-terminating reverse proxy in front of port 8080. Health:
`GET /healthz`; readiness, including the database: `GET /readyz`; metrics: `GET /metrics`
(authenticated).

**5. Check it.** From a client with a token for your audience:

```bash
curl -fsS -H "Authorization: Bearer <ID token>" https://<your host>/v1/info
```

## Managed Google Cloud (experimental)

[deployment-gcp.md](deployment-gcp.md) deploys to Cloud Run, Cloud SQL, Secret Manager and Cloud
Scheduler. It is **not** a supported path in this release. On the final image the managed gate
passed once and failed once: in the failing attempt Cloud Scheduler received HTTP 401 from Cloud
Run, and the cause is not established. The passing live SDK call used a test stand-in for the
SDK's `gcloud` token source, so the normal token path against a deployed image is not shown
([release/managed-staging-results.md](release/managed-staging-results.md)).
