import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as P from "@verified-action-protocol/protocol";
import { loadSchemas, schemaValidator } from "@verified-action-protocol/protocol";
import type { SchemaName } from "@verified-action-protocol/protocol";
import { ROOT } from "../helpers/paths.ts";

const schemas = loadSchemas();
const common = schemas["common.schema.json"].$defs as Record<string, { enum?: string[] }>;

test("TypeScript enums match the JSON Schema enums exactly (no drift)", () => {
  const pairs: [string, readonly string[]][] = [
    ["execution_status", P.EXECUTION_STATUSES],
    ["verification_status", P.VERIFICATION_STATUSES],
    ["recovery_status", P.RECOVERY_STATUSES],
    ["plan_status", P.PLAN_STATUSES],
    ["outcome", P.OUTCOMES],
    ["side_effect_class", P.SIDE_EFFECT_CLASSES],
    ["check_method", P.CHECK_METHODS],
    ["check_result", P.CHECK_RESULTS],
    ["preview_fidelity", P.PREVIEW_FIDELITIES],
    ["effect_status", P.EFFECT_STATUSES],
    ["recovery_mode", P.RECOVERY_MODES],
    ["retry_disposition", P.RETRY_DISPOSITIONS],
    ["error_code", P.ERROR_CODES],
  ];
  for (const [def, values] of pairs) assert.deepEqual(common[def].enum, [...values], def);
  const eventEnum = ((schemas["event.schema.json"].properties as Record<string, { enum?: string[] }>).type).enum;
  assert.deepEqual(eventEnum, [...P.EVENT_TYPES]);
  const predicateOps = ((common.predicate as unknown as { properties: { op: { enum: string[] } } }).properties.op.enum);
  assert.deepEqual(predicateOps, [...P.PREDICATE_OPS]);
});

test("every schema compiles under strict mode with a pinned draft", () => {
  for (const [file, s] of Object.entries(schemas)) {
    assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema", file);
    assert.match(String(s.$id), /^https:\/\/schemas\.vap\.invalid\/0\.1\//, file);
  }
  const v = schemaValidator();
  for (const name of ["task", "observation", "action", "plan", "operation", "evidence", "grant", "approval", "event"] as SchemaName[]) {
    assert.ok(Array.isArray(v.check(name, {})), name);
  }
});

test("every protocol example validates against the schema its file name declares", () => {
  const dir = path.join(ROOT, "packages/protocol/examples");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 12, "examples for every canonical object and key messages");
  const v = schemaValidator();
  for (const f of files) {
    const data = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    const kind = f.split(".")[0];
    const name = (kind.startsWith("messages_") ? `messages#${kind.slice("messages_".length)}` : kind) as SchemaName;
    const invalid = f.includes(".invalid-");
    const issues = v.check(name, data);
    if (invalid) assert.ok(issues.length > 0, `${f} is a negative example and must fail`);
    else assert.deepEqual(issues, [], `${f}: ${JSON.stringify(issues)}`);
  }
});

test("requests reject unknown and identity fields", () => {
  const v = schemaValidator();
  const ok = { protocol_version: "0.1", plan_id: "pln_aaaaaaaaaaaaaaaaaaaa", request_key: "key-00000001" };
  assert.deepEqual(v.check("messages#operation_create_request", ok), []);
  assert.ok(v.check("messages#operation_create_request", { ...ok, principal: "admin" }).length > 0);
  assert.ok(v.check("messages#approval_create_request", { protocol_version: "0.1", plan_id: ok.plan_id, plan_digest: "hmac-sha256:" + "0".repeat(64), decision: "approved", approver: "me" }).length > 0);
  assert.ok(v.check("messages#operation_create_request", { ...ok, protocol_version: "1.0" }).length > 0);
});

test("unsupported protocol versions produce a compatibility error", () => {
  assert.throws(() => P.assertProtocolVersion({ protocol_version: "1.0" }), (e: unknown) => e instanceof P.VapError && e.code === "UNSUPPORTED_PROTOCOL_VERSION");
  assert.doesNotThrow(() => P.assertProtocolVersion({ protocol_version: "0.1" }));
});
