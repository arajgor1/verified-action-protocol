# Canonical JSON and digests

Digests are computed over a canonical JSON encoding (`canonicalize` in `@vap/protocol`):

- object keys sorted by UTF-16 code unit order (as in RFC 8785 / JCS);
- no insignificant whitespace;
- numbers in the ECMAScript shortest round-trip form; `NaN`, `±Infinity` and `-0` are rejected;
- strings with JSON escaping; lone surrogates are rejected;
- `undefined`, functions, symbols, `bigint`, dates and non-plain objects are rejected rather than
  silently dropped; nesting is limited to 64 levels.

For well-formed input this is compatible with JCS.

## Digest kinds

| Prefix | Use | Why |
|---|---|---|
| `hmac-sha256:` | plan digests, request-key digests | keyed with the deployment secret `VAP_DIGEST_KEY`, so low-entropy or secret-bearing arguments cannot be confirmed by brute force from a published fingerprint |
| `sha256:` | evidence artifacts, schema bundles | content addressing of non-secret, already-redacted bytes |

A plan digest covers: deployment, plan id, task id and revision, action and adapter version,
principal, grant id and revocation revision, canonical arguments, resource conditions, preview,
risk tier, bound checks, policy revision, expiry, recovery linkage, frozen adapter data,
affected resources and item count. Approvals bind this digest, so changing any of these values
produces a different plan that the approval does not cover.

Rotating `VAP_DIGEST_KEY` invalidates in-flight request-key replay: rotate only after the retry
window has passed, or accept that repeats after rotation are new keys.
