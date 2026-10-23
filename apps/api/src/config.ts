import { randomBytes } from "node:crypto";

export interface RuntimeConfig {
  env: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  digestKey: string;
  deploymentId: string;
  authMode: "oidc" | "demo";
  oidcIssuer: string;
  oidcAudience: string | null;
  oidcJwksUrl: string;
  adaptersConfigPath: string;
  isolatedTestMode: boolean;
  enableBrowser: boolean;
  dispatchMode: "inline" | "cloud-run-job" | "none";
  workerJob: string | null;
  evidenceBucket: string | null;
  bootstrapOperators: string[];
  bootstrapApprovers: string[];
  buildVersion: string;
  buildCommit: string | null;
  imageDigest: string | null;
  maxRequestBytes: number;
  maxInFlight: number;
  perPrincipalRps: number;
  claimLeaseMs: number;
  maxReconcileAttempts: number;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Reads configuration from the environment. Owner-specific values (project, region,
 * secrets) are injected by the deployment, never committed. Fails closed on unsafe
 * combinations, most importantly demo authentication outside isolated loopback mode.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env, role: "api" | "worker" = "api"): RuntimeConfig {
  const mode = (env.VAP_ENV ?? "production") as RuntimeConfig["env"];
  if (!["development", "test", "production"].includes(mode)) throw new Error("VAP_ENV must be development, test or production");
  const authMode = (env.VAP_AUTH_MODE ?? "oidc") as RuntimeConfig["authMode"];
  if (!["oidc", "demo"].includes(authMode)) throw new Error("VAP_AUTH_MODE must be oidc or demo");
  const host = env.VAP_HOST ?? (authMode === "demo" ? "127.0.0.1" : "0.0.0.0");

  if (authMode === "demo" && role === "api") {
    if (mode === "production") throw new Error("refusing to start: demo authentication is enabled in production");
    if (!LOOPBACK.has(host)) throw new Error("refusing to start: demo authentication requires a loopback-only listener (VAP_HOST=127.0.0.1)");
    if (env.K_SERVICE || env.CLOUD_RUN_JOB) throw new Error("refusing to start: demo authentication is not permitted on Cloud Run");
  }
  const databaseUrl = env.VAP_DATABASE_URL;
  if (!databaseUrl) throw new Error("VAP_DATABASE_URL is required");
  let digestKey = env.VAP_DIGEST_KEY ?? "";
  if (digestKey.length < 32) {
    if (mode === "production") throw new Error("VAP_DIGEST_KEY (at least 32 characters, from the deployment's secret facility) is required in production");
    // Ephemeral development key: digests do not survive restarts, which is acceptable only for throwaway demos.
    digestKey = randomBytes(32).toString("hex");
  }
  if (role === "api" && authMode === "oidc" && !env.VAP_OIDC_AUDIENCE) throw new Error("VAP_OIDC_AUDIENCE is required for OIDC authentication");
  const isolated = env.VAP_ISOLATED_TEST_MODE === "1";
  if (isolated && mode === "production") throw new Error("refusing to start: isolated test mode (private fixture destinations) is not allowed in production");
  const dispatchMode = (env.VAP_DISPATCH_MODE ?? "inline") as RuntimeConfig["dispatchMode"];
  if (!["inline", "cloud-run-job", "none"].includes(dispatchMode)) throw new Error("VAP_DISPATCH_MODE must be inline, cloud-run-job or none");
  if (dispatchMode === "cloud-run-job" && !env.VAP_WORKER_JOB) throw new Error("VAP_WORKER_JOB is required for cloud-run-job dispatch");
  const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    env: mode,
    host,
    port: Number(env.PORT ?? env.VAP_PORT ?? 8080),
    databaseUrl,
    digestKey,
    deploymentId: env.VAP_DEPLOYMENT_ID ?? "default",
    authMode,
    oidcIssuer: env.VAP_OIDC_ISSUER ?? "https://accounts.google.com",
    oidcAudience: env.VAP_OIDC_AUDIENCE ?? null,
    oidcJwksUrl: env.VAP_OIDC_JWKS_URL ?? "https://www.googleapis.com/oauth2/v3/certs",
    adaptersConfigPath: env.VAP_ADAPTERS_CONFIG ?? "examples/config/adapters.fixture.json",
    isolatedTestMode: isolated,
    enableBrowser: env.VAP_ENABLE_BROWSER === "1",
    dispatchMode,
    workerJob: env.VAP_WORKER_JOB ?? null,
    evidenceBucket: env.VAP_EVIDENCE_BUCKET ?? null,
    bootstrapOperators: list(env.VAP_BOOTSTRAP_OPERATORS),
    bootstrapApprovers: list(env.VAP_BOOTSTRAP_APPROVERS),
    buildVersion: env.VAP_BUILD_VERSION ?? "0.1.0",
    buildCommit: env.VAP_BUILD_COMMIT ?? null,
    imageDigest: env.VAP_IMAGE_DIGEST ?? null,
    maxRequestBytes: 256 * 1024,
    maxInFlight: Number(env.VAP_MAX_IN_FLIGHT ?? 64),
    perPrincipalRps: Number(env.VAP_PRINCIPAL_RPS ?? 50),
    claimLeaseMs: boundedInt(env.VAP_CLAIM_LEASE_MS, 30_000, 2_000, 600_000, "VAP_CLAIM_LEASE_MS"),
    maxReconcileAttempts: boundedInt(env.VAP_MAX_RECONCILE_ATTEMPTS, 5, 1, 50, "VAP_MAX_RECONCILE_ATTEMPTS"),
  };
}

function boundedInt(v: string | undefined, d: number, min: number, max: number, name: string): number {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return n;
}
