import { TIER_BY_SIDE_EFFECT_CLASS } from "@verified-action-protocol/protocol";
import type { Grant, RiskTier, SideEffect, TaskScope } from "@verified-action-protocol/protocol";

/** An action inherits the strictest tier implied by any of its side effects. */
export function strictestTier(sideEffects: SideEffect[]): RiskTier {
  let tier: RiskTier = 0;
  for (const se of sideEffects) {
    const t = TIER_BY_SIDE_EFFECT_CLASS[se.class];
    if (t > tier) tier = t;
  }
  return tier;
}

/** "*" matches everything; "a.b.*" matches "a.b.<anything>"; otherwise exact. */
export function matchesActionPattern(pattern: string, actionId: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return actionId.startsWith(pattern.slice(0, -1));
  return pattern === actionId;
}

/** A trailing "*" is a prefix match; otherwise the URI must match exactly. */
export function matchesResourcePattern(pattern: string, uri: string): boolean {
  if (pattern.endsWith("*")) return uri.startsWith(pattern.slice(0, -1));
  return pattern === uri;
}

export function anyActionMatch(patterns: string[], actionId: string): boolean {
  return patterns.some((p) => matchesActionPattern(p, actionId));
}

export function anyResourceMatch(patterns: string[], uri: string): boolean {
  return patterns.some((p) => matchesResourcePattern(p, uri));
}

export interface GrantEvaluation {
  permitted: boolean;
  blockers: string[];
  requiresApproval: boolean;
  approvalReason: string | null;
}

export interface GrantEvaluationInput {
  grant: Grant;
  principalId: string;
  actionId: string;
  tier: RiskTier;
  resources: string[];
  taskScope: TaskScope;
  now: number;
}

/**
 * Evaluates a grant for one action against one set of affected resources. Enforcement
 * happens here, outside any model, so that observations and application content cannot
 * widen scope (confused-deputy control).
 */
export function evaluateGrant(input: GrantEvaluationInput): GrantEvaluation {
  const { grant, principalId, actionId, tier, resources, taskScope, now } = input;
  const blockers: string[] = [];
  if (grant.principal !== principalId) blockers.push("grant belongs to a different principal");
  if (grant.revoked_at !== null) blockers.push("grant has been revoked");
  if (Date.parse(grant.expires_at) <= now) blockers.push("grant has expired");
  if (!anyActionMatch(grant.allowed_actions, actionId)) blockers.push(`action ${actionId} is not allowed by the grant`);
  if (!anyActionMatch(taskScope.actions, actionId)) blockers.push(`action ${actionId} is outside the task scope`);
  if (tier > grant.risk_ceiling) blockers.push(`action risk tier ${tier} exceeds the grant ceiling ${grant.risk_ceiling}`);
  for (const uri of resources) {
    if (!anyResourceMatch(grant.allowed_targets, uri)) blockers.push(`resource ${uri} is not an allowed target of the grant`);
    if (!anyResourceMatch(taskScope.resources, uri)) blockers.push(`resource ${uri} is outside the task scope`);
  }
  let requiresApproval = false;
  let approvalReason: string | null = null;
  if (tier === 3) {
    requiresApproval = true;
    approvalReason = "tier 3 (sensitive or irreversible) always requires plan-bound human approval";
  } else if (tier === 2 && !anyActionMatch(grant.preauthorized_actions, actionId)) {
    requiresApproval = true;
    approvalReason = "tier 2 (compensable or hard to reverse) requires plan-bound approval unless preauthorized by the grant";
  }
  return { permitted: blockers.length === 0, blockers, requiresApproval, approvalReason };
}

/** Task scope must stay within the grant: a task can narrow authority, never widen it. */
export function scopeWithinGrant(scope: TaskScope, grant: Grant): string[] {
  const problems: string[] = [];
  for (const a of scope.actions) {
    const probe = a.endsWith(".*") ? a.slice(0, -2) + ".x" : a === "*" ? null : a;
    if (probe === null) {
      if (!grant.allowed_actions.includes("*")) problems.push(`task action pattern * is wider than the grant`);
    } else if (!anyActionMatch(grant.allowed_actions, probe)) {
      problems.push(`task action pattern ${a} is not covered by the grant`);
    }
  }
  for (const r of scope.resources) {
    const prefix = r.endsWith("*") ? r.slice(0, -1) : r;
    const covered = grant.allowed_targets.some((g) => (g.endsWith("*") ? prefix.startsWith(g.slice(0, -1)) : g === r));
    if (!covered) problems.push(`task resource pattern ${r} is not covered by the grant`);
  }
  return problems;
}
