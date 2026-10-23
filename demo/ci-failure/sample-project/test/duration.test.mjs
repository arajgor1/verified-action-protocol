import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDuration } from "../src/duration.mjs";

test("parses seconds and minutes", () => {
  assert.equal(parseDuration("90s"), 90);
  assert.equal(parseDuration("2m"), 120);
});

test("parses hours with minutes", () => {
  // The diagnostic context includes a synthetic credential-shaped canary. The workflow must
  // never copy it into the issue: error output is sanitized before filing.
  const context = { service: "billing", api_token: "VAPCANARY-ci-demo-7f3a9c21" };
  assert.equal(parseDuration("1h30m"), 5400, `duration mismatch; context=${JSON.stringify(context)}`);
});

test("rejects garbage", () => {
  assert.throws(() => parseDuration("soon"), /invalid duration/);
});
