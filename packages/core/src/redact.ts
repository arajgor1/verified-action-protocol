/**
 * Redaction applied before persistence and before logging. Default posture is
 * allowlist-and-truncate: callers project the fields they need, and this module removes
 * anything that still looks secret-bearing. It is a control, not a guarantee.
 */

export const REDACTED = "[REDACTED]";

const SECRET_KEY = /(authorization|proxy-authorization|cookie|set-cookie|passw(or)?d|passphrase|secret|token|api[-_]?key|private[-_]?key|credential|session[-_]?id|x-api-key|signature)/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bhf_[A-Za-z0-9]{20,}/g,
  /\bya29\.[A-Za-z0-9._-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bVAPCANARY-[A-Za-z0-9-]{4,}/g, // synthetic canaries used by the leakage tests
];

const registeredValues = new Set<string>();

/**
 * Registers an exact runtime value (for example a connector credential loaded from the
 * operator's secret facility) so that any later appearance is scrubbed.
 */
export function registerSensitiveValue(value: string | undefined | null): void {
  if (value && value.length >= 6) registeredValues.add(value);
}

export function clearRegisteredSensitiveValues(): void {
  registeredValues.clear();
}

export function redactString(s: string, maxLength = 2048): string {
  let out = s;
  for (const v of registeredValues) {
    if (out.includes(v)) out = out.split(v).join(REDACTED);
  }
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, REDACTED);
  if (out.length > maxLength) out = out.slice(0, maxLength) + `…[truncated ${out.length - maxLength} chars]`;
  return out;
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

export interface RedactOptions {
  maxDepth?: number;
  maxStringLength?: number;
  maxArrayItems?: number;
  maxKeys?: number;
}

/** Deep copy with secret-looking keys and values replaced and sizes bounded. */
export function redact(value: unknown, opts: RedactOptions = {}, depth = 0): unknown {
  const maxDepth = opts.maxDepth ?? 8;
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return redactString(value, opts.maxStringLength ?? 2048);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return null;
  if (depth >= maxDepth) return "[depth limit]";
  if (Array.isArray(value)) {
    const max = opts.maxArrayItems ?? 200;
    const items = value.slice(0, max).map((v) => redact(v, opts, depth + 1));
    if (value.length > max) items.push(`[${value.length - max} more items]`);
    return items;
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message, opts.maxStringLength ?? 2048) };
  }
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (n++ >= (opts.maxKeys ?? 200)) {
      out["[truncated]"] = true;
      break;
    }
    out[k] = isSecretKey(k) ? REDACTED : redact(v, opts, depth + 1);
  }
  return out;
}

/** Keeps only the named top-level keys (field allowlist), then redacts. */
export function allowlist(value: Record<string, unknown> | null | undefined, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!value) return out;
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(value, f)) out[f] = value[f];
  }
  return redact(out) as Record<string, unknown>;
}

/** Returns true when the serialized form still contains secret-looking material. */
export function containsSensitiveMaterial(serialized: string): boolean {
  for (const v of registeredValues) if (serialized.includes(v)) return true;
  return SECRET_VALUE_PATTERNS.some((re) => {
    re.lastIndex = 0;
    const hit = re.test(serialized);
    re.lastIndex = 0;
    return hit;
  });
}
