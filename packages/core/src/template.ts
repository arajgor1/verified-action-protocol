import { VapError } from "@verified-action-protocol/protocol";

const PLACEHOLDER = /\{(result|args|prior|item|request)\.([A-Za-z0-9_]{1,64}(?:\.[A-Za-z0-9_]{1,64}){0,3})\}/g;
const SAFE_SEGMENT = /^[A-Za-z0-9._~-]{1,256}$/;

export interface TemplateSources {
  result?: Record<string, unknown> | null;
  args?: Record<string, unknown>;
  prior?: Record<string, unknown> | null;
  item?: Record<string, unknown> | null;
  request?: Record<string, unknown> | null;
}

function getPath(obj: Record<string, unknown> | null | undefined, dotted: string): unknown {
  let cur: unknown = obj;
  for (const key of dotted.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Substitutes {result.x}, {args.x}, {prior.x}, {item.x} and {request.x} placeholders. This is the only
 * expansion that exists: no expressions, no defaults, no nested templates. Substituted
 * values must be short URI-safe tokens, which also prevents "." / ".." path segments.
 */
export function expandTemplate(template: string, sources: TemplateSources): string {
  return template.replace(PLACEHOLDER, (_m, src: keyof TemplateSources, path: string) => {
    const v = getPath(sources[src] ?? null, path);
    if (typeof v !== "string" && typeof v !== "number") {
      throw new VapError("INVALID_ARGUMENT", `template value ${src}.${path} is missing or not a scalar`);
    }
    const s = String(v);
    if (!SAFE_SEGMENT.test(s) || s === "." || s === "..") {
      throw new VapError("INVALID_ARGUMENT", `template value ${src}.${path} is not a safe identifier`);
    }
    return s;
  });
}

export function templateHasPlaceholders(template: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(template);
}

/** Matches a URI against a template like "issue://tracker/issues/{id}"; returns captured params. */
export function matchUriTemplate(template: string, uri: string): Record<string, string> | null {
  const names: string[] = [];
  const pattern = template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{([A-Za-z0-9_]{1,64})\\?\}|\{([A-Za-z0-9_]{1,64})\}/g, (_m, a: string, b: string) => {
    names.push(a ?? b);
    return "([A-Za-z0-9._~-]{1,256})";
  });
  const m = new RegExp(`^${pattern}$`).exec(uri);
  if (!m) return null;
  const out: Record<string, string> = {};
  names.forEach((n, i) => {
    out[n] = m[i + 1];
  });
  if (Object.values(out).some((v) => v === "." || v === "..")) return null;
  return out;
}
