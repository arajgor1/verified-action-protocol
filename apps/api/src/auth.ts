import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import { VapError } from "@verified-action-protocol/protocol";
import type { Journal, Principal, Role } from "@verified-action-protocol/core";

export interface Authenticator {
  readonly mode: "oidc" | "demo";
  authenticate(authorizationHeader: string | undefined, cookieHeader?: string | undefined): Promise<Principal>;
}

/**
 * Synthetic principals for the isolated loopback demo only. Production startup refuses
 * demo mode (see config.ts).
 */
export const DEMO_PRINCIPALS: Record<string, Role[]> = {
  "demo-agent": ["agent"],
  "demo-agent-2": ["agent"],
  "demo-operator": ["operator", "viewer"],
  "demo-approver": ["approver"],
  "demo-viewer": ["viewer"],
};

export class DemoAuthenticator implements Authenticator {
  readonly mode = "demo" as const;
  async authenticate(authorization: string | undefined, cookie?: string): Promise<Principal> {
    let name: string | null = null;
    const m = /^Bearer demo:([a-z0-9-]{1,40})$/.exec(authorization ?? "");
    if (m) name = m[1];
    else {
      const c = /(?:^|;\s*)vap_demo=([a-z0-9-]{1,40})/.exec(cookie ?? "");
      if (c) name = c[1];
    }
    if (!name || !DEMO_PRINCIPALS[name]) throw new VapError("UNAUTHORIZED", "missing or unknown demo principal");
    return { id: name, roles: DEMO_PRINCIPALS[name], authMethod: "demo" };
  }
}

/**
 * Verifies OIDC ID tokens (Google-issued for Cloud Run workloads and operators). Checks
 * issuer, audience, expiry and signature; maps the verified subject to operator-managed
 * roles. Client-supplied identity headers and body principal fields are never consulted.
 */
export class OidcAuthenticator implements Authenticator {
  readonly mode = "oidc" as const;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly journal: Journal,
    private readonly issuer: string,
    private readonly audience: string,
    jwksUrl: string,
  ) {
    this.jwks = createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: 5000, cooldownDuration: 30_000 });
  }

  async authenticate(authorization: string | undefined): Promise<Principal> {
    const m = /^Bearer ([A-Za-z0-9._~+/=-]{20,8192})$/.exec(authorization ?? "");
    if (!m) throw new VapError("UNAUTHORIZED", "bearer token required");
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(m[1], this.jwks, {
        issuer: [this.issuer, this.issuer.replace(/^https:\/\//, "")],
        audience: this.audience,
        clockTolerance: 30,
        requiredClaims: ["exp", "sub"],
      }));
    } catch {
      throw new VapError("UNAUTHORIZED", "token verification failed");
    }
    // One identity, one principal: the verified email is the only accepted subject. Tokens
    // without it are rejected rather than mapped to a second principal keyed on `sub`.
    // (Request Google ID tokens with format=full / --include-email.)
    const email = typeof payload.email === "string" && payload.email_verified === true ? payload.email.toLowerCase() : null;
    if (!email) throw new VapError("UNAUTHORIZED", "token must carry a verified email claim");
    const subject = email;
    const roles = await this.journal.transaction((tx) => tx.getRoles(subject));
    return { id: subject, roles, authMethod: "oidc" };
  }
}
