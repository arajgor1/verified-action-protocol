import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * Canonical JSON encoding used for every VAP digest.
 *
 * Rules (documented in docs/protocol/canonical-json.md):
 *  - Object keys are sorted by UTF-16 code unit order (as in RFC 8785 / JCS).
 *  - No insignificant whitespace.
 *  - Numbers use the ECMAScript shortest round-trip form; NaN, Infinity and -0 are rejected
 *    (-0 is normalised to 0 by JSON, so it is rejected to avoid silent digest collisions).
 *  - Strings use JSON escaping; lone surrogates are rejected.
 *  - undefined, functions, symbols and bigint are rejected rather than silently dropped.
 */
export function canonicalize(value: unknown): string {
  return encode(value, 0);
}

const MAX_DEPTH = 64;

function encode(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new CanonicalJsonError("value nests deeper than 64 levels");
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError("non-finite numbers are not permitted");
      if (Object.is(value, -0)) throw new CanonicalJsonError("negative zero is not permitted");
      return JSON.stringify(value);
    case "string":
      if (hasLoneSurrogate(value)) throw new CanonicalJsonError("strings must be well-formed UTF-16");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return "[" + value.map((v) => encode(v, depth + 1)).join(",") + "]";
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError("only plain objects can be canonicalized");
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort(compareUtf16);
      const parts: string[] = [];
      for (const key of keys) {
        const v = obj[key];
        if (v === undefined) throw new CanonicalJsonError(`property ${JSON.stringify(key)} is undefined`);
        if (hasLoneSurrogate(key)) throw new CanonicalJsonError("keys must be well-formed UTF-16");
        parts.push(JSON.stringify(key) + ":" + encode(v, depth + 1));
      }
      return "{" + parts.join(",") + "}";
    }
    default:
      throw new CanonicalJsonError(`values of type ${typeof value} cannot be canonicalized`);
  }
}

function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function hasLoneSurrogate(s: string): boolean {
  return LONE_SURROGATE.test(s);
}

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

/** Unkeyed SHA-256 of canonical JSON. Use only for non-secret content such as evidence artifacts. */
export function sha256Digest(value: unknown): string {
  return "sha256:" + createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

export function sha256Bytes(data: string | Uint8Array): string {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

/**
 * Keyed digest (HMAC-SHA256) of canonical JSON. Used for plan digests and request-key
 * digests so that low-entropy or secret-bearing arguments cannot be confirmed by
 * brute force from a published fingerprint.
 */
export function keyedDigest(key: Uint8Array | string, value: unknown): string {
  return "hmac-sha256:" + createHmac("sha256", key).update(canonicalize(value), "utf8").digest("hex");
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Opaque identifier: `<prefix>_<20 random base62 chars>` (about 119 bits). */
export function newId(prefix: string): string {
  if (!/^[a-z]{2,8}$/.test(prefix)) throw new Error(`invalid id prefix ${prefix}`);
  const bytes = randomBytes(20);
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % 62];
  return `${prefix}_${out}`;
}

/** UTC ISO 8601 timestamp with millisecond precision. */
export function nowIso(clock: () => number = Date.now): string {
  return new Date(clock()).toISOString();
}
