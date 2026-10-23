import { schemaValidator, sha256Digest, VapError } from "@vap/protocol";
import type { ActionDescriptor, InfoResponse } from "@vap/protocol";
import type { Adapter } from "./adapter.js";
import { strictestTier } from "./policy.js";

/** Bumped whenever the built-in policy defaults change; part of every policy revision. */
export const POLICY_DEFAULTS_VERSION = "policy-defaults-0.1.0";

export interface RegisteredAction {
  adapter: Adapter;
  descriptor: ActionDescriptor;
}

/**
 * Static registry of trusted adapters. Adapters are compiled into the image or installed by
 * the operator; nothing is downloaded from manifests and a manifest cannot grant itself
 * permissions (grants are separate operator records).
 */
export class AdapterRegistry {
  private readonly adapters_ = new Map<string, Adapter>();
  private readonly actions = new Map<string, RegisteredAction>();
  private frozenRevision: string | null = null;

  register(adapter: Adapter): this {
    if (this.frozenRevision) throw new Error("registry is frozen");
    if (this.adapters_.has(adapter.id)) throw new Error(`adapter ${adapter.id} registered twice`);
    const validator = schemaValidator();
    for (const d of adapter.manifest()) {
      const issues = validator.check("action", d);
      if (issues.length > 0) throw new Error(`action ${d.id} descriptor is invalid: ${JSON.stringify(issues)}`);
      if (this.actions.has(d.id)) throw new Error(`action ${d.id} registered twice`);
      if (d.adapter.id !== adapter.id || d.adapter.version !== adapter.version) {
        throw new Error(`action ${d.id} names adapter ${d.adapter.id}@${d.adapter.version}, expected ${adapter.id}@${adapter.version}`);
      }
      const minTier = strictestTier(d.side_effects);
      if (d.risk_tier < minTier) throw new Error(`action ${d.id} declares tier ${d.risk_tier} below its side effects' tier ${minTier}`);
      for (const rm of d.recovery_modes) {
        if (!d.capabilities.recovery_modes.includes(rm.mode)) throw new Error(`action ${d.id} recovery mode ${rm.mode} missing from capabilities`);
      }
      this.actions.set(d.id, { adapter, descriptor: d });
    }
    this.adapters_.set(adapter.id, adapter);
    return this;
  }

  /** Freezes the registry and computes the policy revision bound into every plan. */
  freeze(): this {
    const descriptors = [...this.actions.values()].map((a) => a.descriptor).sort((a, b) => (a.id < b.id ? -1 : 1));
    const verifiers = new Set([...this.adapters_.values()].flatMap((a) => a.verifierIds()));
    for (const { descriptor } of this.actions.values()) {
      // A verifier may live in another adapter (e.g. a browser write checked by API readback).
      for (const v of descriptor.verifier_ids) {
        if (!verifiers.has(v)) throw new Error(`action ${descriptor.id} names verifier ${v} that no registered adapter provides`);
      }
      for (const rm of descriptor.recovery_modes) {
        if (rm.action_id && !this.actions.has(rm.action_id)) {
          throw new Error(`action ${descriptor.id} recovery references unknown action ${rm.action_id}`);
        }
      }
    }
    this.frozenRevision = "pol_" + sha256Digest({ policy: POLICY_DEFAULTS_VERSION, descriptors }).slice("sha256:".length, "sha256:".length + 32);
    return this;
  }

  get policyRevision(): string {
    if (!this.frozenRevision) throw new Error("registry not frozen");
    return this.frozenRevision;
  }

  action(id: string): RegisteredAction {
    const a = this.actions.get(id);
    if (!a) throw new VapError("NOT_FOUND", `action ${id} is not registered`);
    return a;
  }

  hasAction(id: string): boolean {
    return this.actions.has(id);
  }

  listActions(): RegisteredAction[] {
    return [...this.actions.values()];
  }

  adapters(): Adapter[] {
    return [...this.adapters_.values()];
  }

  adapter(id: string): Adapter {
    const a = this.adapters_.get(id);
    if (!a) throw new VapError("NOT_FOUND", `adapter ${id} is not registered`);
    return a;
  }

  /** Longest registered prefix wins. Unregistered URIs are never fetched. */
  adapterForResource(uri: string): Adapter {
    let best: { adapter: Adapter; len: number } | null = null;
    for (const adapter of this.adapters_.values()) {
      for (const prefix of adapter.resourcePrefixes()) {
        if (uri.startsWith(prefix) && (!best || prefix.length > best.len)) best = { adapter, len: prefix.length };
      }
    }
    if (!best) throw new VapError("CAPABILITY_UNAVAILABLE", `no registered adapter resolves ${uri.split("://")[0]}:// resources`);
    return best.adapter;
  }

  adapterForVerifier(verifierId: string): Adapter {
    for (const adapter of this.adapters_.values()) if (adapter.verifierIds().includes(verifierId)) return adapter;
    throw new VapError("CAPABILITY_UNAVAILABLE", `no registered verifier ${verifierId}`);
  }

  info(): InfoResponse["adapters"] {
    return [...this.adapters_.values()].map((adapter) => ({
      id: adapter.id,
      version: adapter.version,
      provenance: adapter.provenance,
      actions: [...this.actions.values()]
        .filter((a) => a.adapter === adapter)
        .map(({ descriptor: d }) => ({
          id: d.id,
          risk_tier: d.risk_tier,
          capabilities: d.capabilities,
          declared_profiles: declaredProfiles(d),
        })),
    }));
  }

  async closeAll(): Promise<void> {
    for (const a of this.adapters_.values()) await a.close?.();
  }
}

export function declaredProfiles(d: ActionDescriptor): ("core" | "verified" | "recoverable")[] {
  const out: ("core" | "verified" | "recoverable")[] = ["core"];
  if (d.verifier_ids.length > 0 && d.capabilities.verification_methods.length > 0) out.push("verified");
  if (d.recovery_modes.length > 0) out.push("recoverable");
  return out;
}
