import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateGrant, evaluatePredicate, matchesActionPattern, matchesResourcePattern, scopeWithinGrant, strictestTier, validatePredicate } from "@verified-action-protocol/core";
import type { Grant } from "@verified-action-protocol/protocol";

const facts = { owner: "bob", n: 5, tags: ["a", "b"], nested: { "x/y": 1 }, nil: null };

test("predicates use a bounded declarative operator set", () => {
  assert.ok(evaluatePredicate({ op: "eq", path: "/owner", value: "bob" }, facts).ok);
  assert.ok(!evaluatePredicate({ op: "eq", path: "/owner", value: "alice" }, facts).ok);
  assert.ok(evaluatePredicate({ op: "neq", path: "/owner", value: "alice" }, facts).ok);
  assert.ok(evaluatePredicate({ op: "in", path: "/owner", values: ["alice", "bob"] }, facts).ok);
  assert.ok(evaluatePredicate({ op: "not_in", path: "/owner", values: ["carol"] }, facts).ok);
  assert.ok(evaluatePredicate({ op: "exists", path: "/n" }, facts).ok);
  assert.ok(!evaluatePredicate({ op: "exists", path: "/nil" }, facts).ok, "null is treated as absent");
  assert.ok(evaluatePredicate({ op: "not_exists", path: "/missing" }, facts).ok);
  assert.ok(evaluatePredicate({ op: "range", path: "/n", min: 1, max: 5 }, facts).ok);
  assert.ok(!evaluatePredicate({ op: "range", path: "/n", min: 6 }, facts).ok);
  assert.ok(evaluatePredicate({ op: "length_range", path: "/tags", min: 2, max: 2 }, facts).ok);
  assert.ok(evaluatePredicate({ op: "eq", path: "/nested/x~1y", value: 1 }, facts).ok, "JSON pointer escaping");
  assert.ok(evaluatePredicate({ op: "all", predicates: [{ op: "eq", path: "/owner", value: "bob" }, { op: "range", path: "/n", min: 0 }] }, facts).ok);
  assert.ok(evaluatePredicate({ op: "any", predicates: [{ op: "eq", path: "/owner", value: "x" }, { op: "eq", path: "/n", value: 5 }] }, facts).ok);
});

test("predicates reject deep nesting and malformed definitions", () => {
  let p: any = { op: "eq", path: "/n", value: 5 };
  for (let i = 0; i < 5; i++) p = { op: "all", predicates: [p] };
  assert.throws(() => validatePredicate(p));
  assert.ok(!evaluatePredicate(p, facts).ok);
  assert.throws(() => validatePredicate({ op: "eq", path: "/x" } as never));
  assert.throws(() => validatePredicate({ op: "range", path: "/x" }));
});

test("strings that look like code are compared, never evaluated", () => {
  const r = evaluatePredicate({ op: "eq", path: "/owner", value: "process.exit(1)" }, { owner: "process.exit(1)" });
  assert.ok(r.ok);
});

test("risk tier is the strictest side effect", () => {
  assert.equal(strictestTier([]), 0);
  assert.equal(strictestTier([{ id: "a", description: "", class: "remote_reversible", bounded: true }]), 1);
  assert.equal(strictestTier([{ id: "a", description: "", class: "remote_reversible", bounded: true }, { id: "b", description: "", class: "irreversible", bounded: true }]), 3);
});

test("action and resource patterns", () => {
  assert.ok(matchesActionPattern("*", "a.b"));
  assert.ok(matchesActionPattern("issues.*", "issues.create"));
  assert.ok(!matchesActionPattern("issues.*", "issuesx.create"));
  assert.ok(!matchesActionPattern("issues.create", "issues.create_and_notify"));
  assert.ok(matchesResourcePattern("issue://t/*", "issue://t/issues/1"));
  assert.ok(!matchesResourcePattern("issue://t/issues/1", "issue://t/issues/10"));
});

const grant: Grant = {
  protocol_version: "0.1",
  id: "grt_aaaaaaaaaaaaaaaaaaaa",
  principal: "agent",
  allowed_actions: ["issues.*"],
  allowed_targets: ["issue://t/*"],
  risk_ceiling: 2,
  preauthorized_actions: ["issues.create"],
  limits: { max_operations: null, max_items_per_operation: null, max_concurrent_operations: null },
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  revocation_revision: 0,
  revoked_at: null,
  issuer: "op",
  created_at: new Date().toISOString(),
};
const scope = { actions: ["issues.*"], resources: ["issue://t/*"] };

test("grant evaluation enforces principal, scope, ceiling and approval tiers", () => {
  const base = { grant, principalId: "agent", actionId: "issues.update", tier: 1 as const, resources: ["issue://t/issues/1"], taskScope: scope, now: Date.now() };
  assert.deepEqual(evaluateGrant(base), { permitted: true, blockers: [], requiresApproval: false, approvalReason: null });
  assert.ok(!evaluateGrant({ ...base, principalId: "other" }).permitted);
  assert.ok(!evaluateGrant({ ...base, resources: ["issue://other/1"] }).permitted);
  assert.ok(!evaluateGrant({ ...base, tier: 3 }).permitted, "tier above ceiling");
  assert.ok(evaluateGrant({ ...base, tier: 2 }).requiresApproval, "tier 2 needs approval unless preauthorized");
  assert.ok(!evaluateGrant({ ...base, tier: 2, actionId: "issues.create" }).requiresApproval);
  assert.ok(evaluateGrant({ ...base, grant: { ...grant, risk_ceiling: 3, preauthorized_actions: ["*"] }, tier: 3 }).requiresApproval, "tier 3 always needs approval");
  assert.ok(!evaluateGrant({ ...base, grant: { ...grant, revoked_at: new Date().toISOString() } }).permitted);
  // Derive "already expired" from the same instant the evaluation uses (no clock-tick flake).
  assert.ok(!evaluateGrant({ ...base, grant: { ...grant, expires_at: new Date(base.now - 1).toISOString() } }).permitted);
});

test("task scope can narrow but never widen a grant", () => {
  assert.deepEqual(scopeWithinGrant({ actions: ["issues.create"], resources: ["issue://t/issues/*"] }, grant), []);
  assert.ok(scopeWithinGrant({ actions: ["*"], resources: ["issue://t/*"] }, grant).length > 0);
  assert.ok(scopeWithinGrant({ actions: ["issues.*"], resources: ["issue://*"] }, grant).length > 0);
});
