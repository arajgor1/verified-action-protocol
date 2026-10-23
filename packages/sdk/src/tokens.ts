import { execFile } from "node:child_process";

export type TokenProvider = () => Promise<string>;

/** Synthetic principal for the isolated loopback demo. Rejected by production deployments. */
export function demoToken(principal: string): TokenProvider {
  return async () => `demo:${principal}`;
}

/** Fixed token, e.g. injected by the platform. Never hard-code real tokens. */
export function staticToken(token: string): TokenProvider {
  return async () => token;
}

/**
 * Workload identity on GCP (Cloud Run, Cloud Build, GCE): an OIDC identity token for the
 * VAP API audience from the metadata server. Cached until shortly before expiry.
 */
export function gcpMetadataToken(audience: string): TokenProvider {
  let cached: { token: string; exp: number } | null = null;
  return async () => {
    if (cached && cached.exp - 60_000 > Date.now()) return cached.token;
    const url = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}&format=full`;
    const res = await fetch(url, { headers: { "metadata-flavor": "Google" }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`metadata identity token request failed (HTTP ${res.status})`);
    const token = (await res.text()).trim();
    cached = { token, exp: jwtExpiry(token) ?? Date.now() + 10 * 60_000 };
    return token;
  };
}

/**
 * Developer workstation identity through the gcloud CLI (short-lived, from the operator's
 * own login). The command is a fixed argument array, never a shell string.
 */
export function gcloudIdentityToken(audience?: string): TokenProvider {
  let cached: { token: string; exp: number } | null = null;
  return async () => {
    if (cached && cached.exp - 60_000 > Date.now()) return cached.token;
    const args = ["auth", "print-identity-token"];
    if (audience) args.push(`--audiences=${audience}`);
    const token = await new Promise<string>((resolve, reject) => {
      execFile("gcloud", args, { timeout: 15_000, windowsHide: true }, (err, stdout) => (err ? reject(new Error("gcloud could not produce an identity token")) : resolve(stdout.trim())));
    });
    cached = { token, exp: jwtExpiry(token) ?? Date.now() + 10 * 60_000 };
    return token;
  };
}

function jwtExpiry(token: string): number | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Selects a provider from VAP_TOKEN_SOURCE: demo:<principal> | gcp-metadata | gcloud. */
export function tokenFromEnv(env: Record<string, string | undefined> = process.env): TokenProvider {
  const src = env.VAP_TOKEN_SOURCE ?? "gcloud";
  if (src.startsWith("demo:")) return demoToken(src.slice(5));
  if (src === "gcp-metadata") {
    if (!env.VAP_AUDIENCE) throw new Error("VAP_AUDIENCE is required for gcp-metadata tokens");
    return gcpMetadataToken(env.VAP_AUDIENCE);
  }
  if (src === "gcloud") return gcloudIdentityToken(env.VAP_AUDIENCE);
  throw new Error("VAP_TOKEN_SOURCE must be demo:<principal>, gcp-metadata or gcloud");
}
