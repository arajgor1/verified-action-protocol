import { canonicalize } from "@verified-action-protocol/protocol";
import type { Predicate } from "@verified-action-protocol/protocol";

export const MAX_PREDICATE_DEPTH = 4;

/** RFC 6901 JSON Pointer lookup. Never evaluates code. */
export function jsonPointerGet(root: unknown, pointer: string): { found: boolean; value: unknown } {
  if (pointer === "" || pointer === "/") return pointer === "" ? { found: true, value: root } : lookupKey(root, "");
  if (!pointer.startsWith("/")) return { found: false, value: undefined };
  let cur: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    const step = lookupKey(cur, key);
    if (!step.found) return step;
    cur = step.value;
  }
  return { found: true, value: cur };
}

function lookupKey(cur: unknown, key: string): { found: boolean; value: unknown } {
  if (Array.isArray(cur)) {
    if (!/^(0|[1-9][0-9]*)$/.test(key)) return { found: false, value: undefined };
    const i = Number(key);
    return i < cur.length ? { found: true, value: cur[i] } : { found: false, value: undefined };
  }
  if (cur !== null && typeof cur === "object" && Object.prototype.hasOwnProperty.call(cur, key)) {
    return { found: true, value: (cur as Record<string, unknown>)[key] };
  }
  return { found: false, value: undefined };
}

function deepEqual(a: unknown, b: unknown): boolean {
  try {
    return canonicalize(a) === canonicalize(b);
  } catch {
    return false;
  }
}

export interface PredicateEvaluation {
  ok: boolean;
  /** Human-readable reasons when ok is false. Contains paths and operators, not values. */
  mismatches: string[];
}

export class PredicateError extends Error {}

export function validatePredicate(p: Predicate, depth = 1): void {
  if (depth > MAX_PREDICATE_DEPTH) throw new PredicateError(`predicate nesting exceeds ${MAX_PREDICATE_DEPTH}`);
  switch (p.op) {
    case "all":
    case "any":
      if (!p.predicates || p.predicates.length === 0) throw new PredicateError(`${p.op} requires predicates`);
      for (const sub of p.predicates) validatePredicate(sub, depth + 1);
      return;
    case "eq":
    case "neq":
      if (p.path === undefined || !("value" in p)) throw new PredicateError(`${p.op} requires path and value`);
      return;
    case "in":
    case "not_in":
      if (p.path === undefined || !Array.isArray(p.values)) throw new PredicateError(`${p.op} requires path and values`);
      return;
    case "exists":
    case "not_exists":
      if (p.path === undefined) throw new PredicateError(`${p.op} requires path`);
      return;
    case "range":
    case "length_range":
      if (p.path === undefined || (p.min === undefined && p.max === undefined)) throw new PredicateError(`${p.op} requires path and min or max`);
      return;
  }
}

/** Evaluates a bounded declarative predicate over observed facts. */
export function evaluatePredicate(p: Predicate, facts: unknown, depth = 1): PredicateEvaluation {
  if (depth > MAX_PREDICATE_DEPTH) return { ok: false, mismatches: ["predicate too deep"] };
  const at = (path: string | undefined) => jsonPointerGet(facts, path ?? "");
  switch (p.op) {
    case "all": {
      const subs = (p.predicates ?? []).map((s) => evaluatePredicate(s, facts, depth + 1));
      const failed = subs.filter((s) => !s.ok);
      return { ok: subs.length > 0 && failed.length === 0, mismatches: failed.flatMap((s) => s.mismatches) };
    }
    case "any": {
      const subs = (p.predicates ?? []).map((s) => evaluatePredicate(s, facts, depth + 1));
      return subs.some((s) => s.ok) ? { ok: true, mismatches: [] } : { ok: false, mismatches: ["no alternative matched", ...subs.flatMap((s) => s.mismatches)] };
    }
    case "exists": {
      const r = at(p.path);
      return r.found && r.value !== null ? ok() : bad(`${p.path} does not exist`);
    }
    case "not_exists": {
      const r = at(p.path);
      return !r.found || r.value === null ? ok() : bad(`${p.path} exists`);
    }
    case "eq": {
      const r = at(p.path);
      return r.found && deepEqual(r.value, p.value) ? ok() : bad(`${p.path} is not equal to the expected value`);
    }
    case "neq": {
      const r = at(p.path);
      return !r.found || !deepEqual(r.value, p.value) ? ok() : bad(`${p.path} equals the excluded value`);
    }
    case "in": {
      const r = at(p.path);
      return r.found && (p.values ?? []).some((v) => deepEqual(r.value, v)) ? ok() : bad(`${p.path} is not in the allowed set`);
    }
    case "not_in": {
      const r = at(p.path);
      return !r.found || !(p.values ?? []).some((v) => deepEqual(r.value, v)) ? ok() : bad(`${p.path} is in the excluded set`);
    }
    case "range": {
      const r = at(p.path);
      if (!r.found || typeof r.value !== "number" || !Number.isFinite(r.value)) return bad(`${p.path} is not a finite number`);
      if (p.min !== undefined && r.value < p.min) return bad(`${p.path} is below ${p.min}`);
      if (p.max !== undefined && r.value > p.max) return bad(`${p.path} is above ${p.max}`);
      return ok();
    }
    case "length_range": {
      const r = at(p.path);
      const len = typeof r.value === "string" || Array.isArray(r.value) ? r.value.length : null;
      if (!r.found || len === null) return bad(`${p.path} has no length`);
      if (p.min !== undefined && len < p.min) return bad(`${p.path} is shorter than ${p.min}`);
      if (p.max !== undefined && len > p.max) return bad(`${p.path} is longer than ${p.max}`);
      return ok();
    }
  }
}

/** JSON pointers a predicate reads; used to project only relevant facts into evidence. */
export function predicatePaths(p: Predicate): string[] {
  if (p.op === "all" || p.op === "any") return [...new Set((p.predicates ?? []).flatMap(predicatePaths))];
  return p.path === undefined ? [] : [p.path];
}

function ok(): PredicateEvaluation {
  return { ok: true, mismatches: [] };
}

function bad(reason: string): PredicateEvaluation {
  return { ok: false, mismatches: [reason] };
}
