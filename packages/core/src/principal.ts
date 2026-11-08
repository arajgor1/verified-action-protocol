export const ROLES = ["agent", "operator", "approver", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/**
 * An authenticated caller. id is the verified token subject (or the synthetic demo
 * principal in isolated loopback mode). Never derived from headers or request bodies.
 */
export interface Principal {
  id: string;
  roles: Role[];
  authMethod: "oidc" | "demo" | "internal";
}

export function hasRole(p: Principal, role: Role): boolean {
  return p.roles.includes(role);
}

export const SYSTEM_PRINCIPAL: Principal = { id: "system", roles: [], authMethod: "internal" };
