import assert from "node:assert/strict";
import { test } from "node:test";
import { containsSensitiveMaterial, expandTemplate, matchUriTemplate, redact, redactString, registerSensitiveValue, REDACTED } from "@verified-action-protocol/core";

const CANARY = "VAPCANARY-unit-3f9a";

test("secret-looking keys and values are redacted, including nested structures", () => {
  const out = redact({
    authorization: "Bearer abcdefghijklmnop",
    nested: { cookie: "a=b", note: `token is ${CANARY}`, list: ["ok", "Bearer zzzzzzzzzzzz"] },
    api_key: "x",
    password: "hunter2",
    safe: "hello",
  }) as Record<string, any>;
  assert.equal(out.authorization, REDACTED);
  assert.equal(out.nested.cookie, REDACTED);
  assert.equal(out.api_key, REDACTED);
  assert.equal(out.password, REDACTED);
  assert.equal(out.safe, "hello");
  assert.ok(!JSON.stringify(out).includes(CANARY));
  assert.ok(!JSON.stringify(out).includes("zzzzzzzzzzzz"));
});

test("well-known credential formats are scrubbed from free text", () => {
  // Samples are assembled at runtime so the repository never contains a literal that the
  // release-hygiene scanner (rightly) treats as a credential.
  const dash = "-----";
  const samples = [
    `${dash}BEGIN PRIVATE KEY${dash}\nMIIabc\n${dash}END PRIVATE KEY${dash}`,
    ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "c2lnbmF0dXJlLXZhbHVl"].join("."),
    "AKIA" + "ABCDEFGHIJKLMNOP",
    "ghp_" + "a".repeat(30),
  ];
  for (const s of samples) {
    const r = redactString(`prefix ${s} suffix`);
    assert.ok(r.includes(REDACTED), `expected redaction for ${s.slice(0, 8)}`);
    assert.ok(!containsSensitiveMaterial(r));
  }
});

test("registered runtime values are scrubbed wherever they appear", () => {
  registerSensitiveValue("operator-loaded-value-123");
  assert.equal(redactString("x operator-loaded-value-123 y"), `x ${REDACTED} y`);
  assert.ok(containsSensitiveMaterial("... operator-loaded-value-123 ..."));
});

test("redaction bounds size and depth", () => {
  const big = "a".repeat(10_000);
  assert.ok((redact(big, { maxStringLength: 100 }) as string).length < 200);
  let deep: any = { v: 1 };
  for (let i = 0; i < 20; i++) deep = { d: deep };
  assert.ok(JSON.stringify(redact(deep)).includes("[depth limit]"));
});

test("templates substitute only safe scalar tokens", () => {
  assert.equal(expandTemplate("issue://t/issues/{result.id}", { result: { id: "42" } }), "issue://t/issues/42");
  assert.equal(expandTemplate("/requests/{request.key}", { request: { key: "op_abc" } }), "/requests/op_abc");
  assert.throws(() => expandTemplate("/issues/{args.id}", { args: { id: "../admin" } }));
  assert.throws(() => expandTemplate("/issues/{args.id}", { args: { id: ".." } }));
  assert.throws(() => expandTemplate("/issues/{args.id}", { args: { id: "a/b" } }));
  assert.throws(() => expandTemplate("/issues/{args.id}", { args: {} }));
  assert.throws(() => expandTemplate("/issues/{args.id}", { args: { id: { toString: () => "x" } } }));
  assert.equal(expandTemplate("/x/{unknown.y}", {}), "/x/{unknown.y}", "unknown sources are not expanded");
});

test("URI templates capture parameters and reject traversal", () => {
  assert.deepEqual(matchUriTemplate("issue://t/issues/{id}", "issue://t/issues/1001"), { id: "1001" });
  assert.equal(matchUriTemplate("issue://t/issues/{id}", "issue://t/issues/1/../2"), null);
  assert.equal(matchUriTemplate("issue://t/issues/{id}", "issue://t/issues/.."), null);
  assert.equal(matchUriTemplate("issue://t/issues/{id}", "issue://other/issues/1"), null);
});
