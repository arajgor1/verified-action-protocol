// Security negative tests: authentication, cross-principal access and ID guessing, grant
// elevation, request limits, SSRF/redirect/traversal (T16) and secret canaries (T15).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { VapError } from "@verified-action-protocol/protocol";
import type { Grant } from "@verified-action-protocol/protocol";
import { recordScenario, writeReport } from "../helpers/report.ts";
import { key, ownerCheck, startHarness } from "../helpers/harness.ts";
import type { Harness } from "../helpers/harness.ts";

const isCode = (code: string) => (e: unknown) => e instanceof VapError && e.code === code;
const CANARY = "VAPCANARY-sec-7d1e2f";
const logLines: string[] = [];
let h: Harness;
let grant: Grant;

before(async () => {
  h = await startHarness({
    logSink: (l) => logLines.push(l),
    env: { ISSUE_TRACKER_TOKEN: CANARY },
    mutateConfig: (cfg) => {
      // The connector injects a credential; it must never surface anywhere.
      cfg.http![0].connectors.issue_tracker.auth = { type: "bearer_env", env: "ISSUE_TRACKER_TOKEN" };
      cfg.http![0].connectors.metadata_probe = { origin: "http://169.254.169.254", allow_private_network: false, auth: { type: "none" } };
      cfg.http![0].actions.push({
        id: "issues.ssrf_probe",
        title: "Probe that must be blocked",
        connector: "metadata_probe",
        method: "POST",
        path: "/computeMetadata/v1/x",
        input_schema: { type: "object", additionalProperties: false, properties: {} },
        body_fields: [],
        effect_scope: { resource_template: "issue://issue-tracker/issues/probe", description: "none" },
        side_effects: [{ id: "probe", description: "probe", class: "remote_reversible", bounded: true }],
        response: { projection: [], effects: [{ side_effect_id: "probe" }] },
      });
    },
  });
  grant = await h.grant();
});
after(async () => {
  await writeReport("security");
  await h?.close();
});

async function raw(path: string, init: RequestInit = {}) {
  return fetch(h.apiUrl + path, init);
}

describe("authentication and authorization", () => {
  test("unauthenticated and unknown principals are rejected; identity headers are ignored", async () => {
    assert.equal((await raw("/v1/info")).status, 401);
    assert.equal((await raw("/v1/info", { headers: { authorization: "Bearer demo:not-a-principal" } })).status, 401);
    const spoof = await raw("/v1/info", { headers: { "x-goog-authenticated-user-email": "demo-operator", "x-forwarded-user": "demo-operator" } });
    assert.equal(spoof.status, 401);
    assert.equal((await raw("/healthz")).status, 200);
    const ready = await raw("/readyz");
    const body = await ready.text();
    assert.ok(!/postgres|password|vapj_/i.test(body), "readiness reveals no infrastructure details");
  });

  test("agents cannot reach operator endpoints or elevate grants", async () => {
    await assert.rejects(h.agent.createGrant({ principal: "demo-agent", allowed_actions: ["*"], allowed_targets: ["issue://*"], risk_ceiling: 3, expires_at: new Date(Date.now() + 1e6).toISOString() }), isCode("FORBIDDEN"));
    await assert.rejects(h.agent.revokeGrant(grant.id), isCode("FORBIDDEN"));
    await assert.rejects(h.agent.setPrincipalRoles("demo-agent", ["operator"]), isCode("FORBIDDEN"));
    await assert.rejects(h.agent.sweep(), isCode("FORBIDDEN"));
    await assert.rejects(h.agent.pendingApprovals(), isCode("FORBIDDEN"));
    const metrics = await raw("/metrics", { headers: { authorization: "Bearer demo:demo-agent" } });
    assert.equal(metrics.status, 403);
  });

  test("a task cannot widen its grant, and another principal's grant is invisible", async () => {
    await assert.rejects(h.agent.openTask({ goal: "wide", grant_id: grant.id, scope: { actions: ["*"], resources: ["issue://*"] }, required_checks: [] }), isCode("FORBIDDEN"));
    await assert.rejects(h.agent2.openTask({ goal: "steal", grant_id: grant.id, scope: { actions: ["issues.create"], resources: ["issue://issue-tracker/*"] }, required_checks: [] }), isCode("NOT_FOUND"));
  });

  test("ID guessing returns NOT_FOUND for every resource kind", async () => {
    for (const p of ["/v1/tasks/tsk_AAAAAAAAAAAAAAAAAAAA", "/v1/operations/op_AAAAAAAAAAAAAAAAAAAA", "/v1/operations/op_AAAAAAAAAAAAAAAAAAAA/events", "/v1/plans/pln_AAAAAAAAAAAAAAAAAAAA", "/v1/evidence/evd_AAAAAAAAAAAAAAAAAAAA/artifact", "/v1/grants/grt_AAAAAAAAAAAAAAAAAAAA"]) {
      const r = await raw(p, { headers: { authorization: "Bearer demo:demo-agent-2" } });
      assert.equal(r.status, 404, p);
    }
  });

  test("principal fields in bodies are rejected rather than trusted", async () => {
    const r = await raw("/v1/tasks", {
      method: "POST",
      headers: { authorization: "Bearer demo:demo-agent", "content-type": "application/json" },
      body: JSON.stringify({ protocol_version: "0.1", goal: "x", grant_id: grant.id, owner: "demo-operator", scope: { actions: [], resources: [] }, required_checks: [] }),
    });
    assert.equal(r.status, 400);
    const b = (await r.json()) as { error: { code: string } };
    assert.equal(b.error.code, "INVALID_ARGUMENT");
  });
});

describe("request limits and validation", () => {
  test("oversized, malformed, wrongly typed and wrong-version bodies are rejected", async () => {
    const auth = { authorization: "Bearer demo:demo-agent", "content-type": "application/json" };
    assert.equal((await raw("/v1/tasks", { method: "POST", headers: auth, body: JSON.stringify({ pad: "x".repeat(300 * 1024) }) })).status, 413);
    assert.equal((await raw("/v1/tasks", { method: "POST", headers: auth, body: "{not json" })).status, 400);
    assert.equal((await raw("/v1/tasks", { method: "POST", headers: { authorization: auth.authorization, "content-type": "text/plain" }, body: "{}" })).status, 415);
    const v = await raw("/v1/tasks", { method: "POST", headers: auth, body: JSON.stringify({ protocol_version: "9.0" }) });
    assert.equal(((await v.json()) as { error: { code: string } }).error.code, "UNSUPPORTED_PROTOCOL_VERSION");
  });
});

describe("T16 SSRF, redirects, traversal and unregistered resources", () => {
  test("a connector pointing at the metadata service is blocked before submission", async () => {
    const task = await h.task(grant, []);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.ssrf_probe", arguments: {} });
    const { operation } = await h.agent.execute(plan.id, key());
    await h.drain();
    const op = await h.agent.getOperation(operation.id);
    assert.equal(op.execution_status, "failed");
    assert.equal(op.error?.code, "DESTINATION_UNAVAILABLE");
    assert.ok(op.effects.every((e) => e.status === "not_applied"));
    recordScenario("T16-ssrf", true);
  });

  test("resource URIs are not fetch URLs and traversal never reaches a destination", async () => {
    const task = await h.task(grant, []);
    await assert.rejects(h.agent.observe({ task_id: task.id, resource_uri: "http://169.254.169.254/computeMetadata/v1/" }), isCode("FORBIDDEN"));
    await assert.rejects(h.agent.observe({ task_id: task.id, resource_uri: "issue://issue-tracker/issues/../../admin" }));
    await assert.rejects(h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: "1/../../x", owner: "bob" } }), isCode("INVALID_ARGUMENT"));
    await assert.rejects(h.agent.prepare({ task_id: task.id, action_id: "cli.write_file", arguments: { path: "../../etc/cron.d/x", content: "x" } }), isCode("INVALID_ARGUMENT"));
    recordScenario("T16-traversal", true);
  });
});

describe("workspace ownership", { skip: process.platform !== "linux" && "CLI runs on Linux containers" }, () => {
  test("another principal can neither observe, verify against nor restore someone else's workspace", async () => {
    const task = await h.task(grant, []);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "cli.write_file", arguments: { path: "docs/notes.md", content: "mine" } });
    const { operation } = await h.agent.execute(plan.id, key());
    await h.drain();
    const g2 = await h.grant({ principal: "demo-agent-2" });
    const t2 = await h.agent2.openTask({ goal: "probe", grant_id: g2.id, scope: { actions: ["cli.*"], resources: ["workspace://*"] }, required_checks: [] });
    await assert.rejects(h.agent2.observe({ task_id: t2.id, resource_uri: `workspace://${operation.id}/docs/notes.md` }), isCode("NOT_FOUND"));
    await assert.rejects(h.agent2.prepare({ task_id: t2.id, action_id: "cli.restore_snapshot", arguments: { source_operation_id: operation.id } }), isCode("NOT_FOUND"));
    // The owner still can.
    const own = await h.agent.observe({ task_id: task.id, resource_uri: `workspace://${operation.id}/docs/notes.md` });
    assert.equal(own.facts.exists, true);
  });

  test("viewers cannot trigger destination reads or journal changes", async () => {
    const issue = await h.seedIssue();
    const task = await h.task(grant, []);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issue.id, owner: "bob" } });
    const { operation } = await h.agent.execute(plan.id, key());
    await h.drain();
    const viewer = h.client("demo-viewer");
    await assert.rejects(viewer.observe({ task_id: task.id, resource_uri: `issue://issue-tracker/issues/${issue.id}` }), isCode("FORBIDDEN"));
    await assert.rejects(viewer.verify(operation.id), isCode("FORBIDDEN"));
    await assert.rejects(viewer.reconcile(operation.id), isCode("FORBIDDEN"));
    assert.equal((await viewer.receipt(operation.id)).operation_id, operation.id, "reads are still allowed");
  });

  test("option-like CLI arguments are rejected", async () => {
    const task = await h.task(grant, []);
    await assert.rejects(h.agent.prepare({ task_id: task.id, action_id: "cli.write_file", arguments: { path: "-o/tmp/x", content: "x" } }), isCode("INVALID_ARGUMENT"));
  });
});

describe("T15 secret canaries", () => {
  test("credentials and canaries never appear in logs, evidence, receipts, events, errors or the journal", async () => {
    const issue = await h.seedIssue("alice");
    const task = await h.task(grant, [ownerCheck("bob", `issue://issue-tracker/issues/${issue.id}`)]);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issue.id, owner: "bob" } });
    const { operation } = await h.agent.execute(plan.id, key());
    await h.drain();
    assert.equal((await h.agent.getOperation(operation.id)).outcome, "verified");
    // Canaries printed by a failing command on stdout and stderr (output and error messages).
    const t2 = await h.task(grant, []);
    const p2 = await h.agent.prepare({ task_id: t2.id, action_id: "cli.print_canary", arguments: {} });
    const { operation: cliOp } = await h.agent.execute(p2.id, key());
    await h.drain();
    const views = JSON.stringify([
      await h.agent.receipt(operation.id),
      await h.agent.evidence(operation.id),
      await h.agent.events(operation.id),
      await h.agent.getOperation(cliOp.id),
      await h.agent.receipt(cliOp.id),
      await h.agent.events(cliOp.id),
      await h.operator.listOperations({ limit: 200 }),
    ]);
    const canaries = [CANARY, "VAPCANARY-cli-out-5a6b7c8d", "VAPCANARY-cli-err-1a2b3c4d"];
    for (const c of canaries) {
      assert.ok(!views.includes(c), `API views leak ${c}`);
      assert.ok(!logLines.join("\n").includes(c), `structured logs leak ${c}`);
    }
    assert.match(views, /\[REDACTED\]/, "redaction markers show where output was scrubbed");
    const dump = await h.journal.pool.query(
      "SELECT string_agg(t::text, '') AS s FROM (SELECT row_to_json(o)::text AS t FROM operations o UNION ALL SELECT row_to_json(e)::text FROM events e UNION ALL SELECT row_to_json(v)::text FROM evidence v UNION ALL SELECT row_to_json(p)::text FROM plans p UNION ALL SELECT content FROM artifacts) x",
    );
    for (const c of canaries) assert.ok(!String(dump.rows[0].s ?? "").includes(c), `journal leaks ${c}`);
    recordScenario("T15", true);
  });
});
