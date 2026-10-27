import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalize, CanonicalJsonError, keyedDigest, newId, sha256Digest } from "@verified-action-protocol/protocol";

test("canonical JSON sorts keys by UTF-16 code units and drops whitespace", () => {
  assert.equal(canonicalize({ b: 1, a: [true, null, "x"], é: 2, Z: 3 }), '{"Z":3,"a":[true,null,"x"],"b":1,"é":2}');
  assert.equal(canonicalize({ nested: { y: 1, x: { b: 2, a: 1 } } }), '{"nested":{"x":{"a":1,"b":2},"y":1}}');
});

test("canonical JSON rejects non-finite numbers, negative zero, undefined and lone surrogates", () => {
  for (const bad of [NaN, Infinity, -Infinity, -0]) assert.throws(() => canonicalize({ v: bad }), CanonicalJsonError);
  assert.throws(() => canonicalize({ v: undefined }), CanonicalJsonError);
  assert.throws(() => canonicalize({ v: "\uD800" }), CanonicalJsonError);
  assert.throws(() => canonicalize({ v: () => 1 }), CanonicalJsonError);
  assert.throws(() => canonicalize({ v: new Date(0) }), CanonicalJsonError);
  assert.throws(() => canonicalize({ v: 10n }), CanonicalJsonError);
});

test("number formatting matches ECMAScript shortest round trip", () => {
  assert.equal(canonicalize([1, 1.5, 1e21, 0.1 + 0.2, -3]), "[1,1.5,1e+21,0.30000000000000004,-3]");
});

test("keyed digests depend on the key and are stable across key order", () => {
  const a = keyedDigest("k".repeat(32), { x: 1, y: [1, 2] });
  const b = keyedDigest("k".repeat(32), { y: [1, 2], x: 1 });
  const c = keyedDigest("j".repeat(32), { x: 1, y: [1, 2] });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^hmac-sha256:[0-9a-f]{64}$/);
  assert.match(sha256Digest({ a: 1 }), /^sha256:[0-9a-f]{64}$/);
});

test("ids are opaque, prefixed and unique", () => {
  const ids = new Set(Array.from({ length: 1000 }, () => newId("op")));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert.match(id, /^op_[A-Za-z0-9]{20}$/);
  assert.throws(() => newId("BAD"));
});
