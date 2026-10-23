// Conformance: lifecycle, idempotency, plans, verification and inspection (PR01-PR08, T01, T02).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { PROTOCOL_VERSION, schemaValidator, VapError } from "@vap/protocol";
import type { Grant } from "@vap/protocol";
import { AGENT, AGENT2, DIGEST_KEY, key, ownerCheck, startHarness } from "../helpers/harness.ts";
import type { Harness } from "../helpers/harness.ts";

const isCode = (code: string) => (e: unknown) => e instanceof VapError && e.code === code;
let h: Harness;
let grant: Grant;

before(async () => {
  h = await startHarness();
  grant = await h.grant();
});
after(async () => {
  await h?.close();
});

describe("PR02 discovery and observation", () => {
  test("actions list reports permission, approval need and blockers", async () => {
    const issue = await h.seedIssue();
    const task = await h.task(grant, [ownerCheck("bob", `issue://issue-tracker/issues/${issue.id}`)]);
    const actions = await h.agent.listActions(task.id);
    const byId = Object.fromEntries(actions.map((a) => [a.action.id, a]));
    assert.equal(byId["issues.update_owner"].permitted, true);
    assert.equal(byId["issues.update_owner"].requires_approval, false);
    assert.equal(byId["issues.create_and_notify"].requires_approval, true, "tier 3 always needs approval");
    const v = schemaValidator();
    for (const a of actions) assert.deepEqual(v.check("action", a.action), []);
  });

  test("observations carry source, version, freshness and unknowns; facts are bounded", async () => {
    const issue = await h.seedIssue("alice");
    const task = await h.task(grant, []);
    const o = await h.agent.observe({ task_id: task.id, resource_uri: `issue://issue-tracker/issues/${issue.id}` });
    assert.equal(o.source_version, "1");
    assert.equal(o.facts.owner, "alice");
    assert.ok(["fresh", "unknown", "cached"].includes(o.freshness));
    assert.ok(o.limits.bytes > 0 && o.limits.bytes <= o.limits.max_bytes);
    assert.equal(typeof o.limits.estimated_tokens, "number");
    await assert.rejects(h.agent.observe({ task_id: task.id, resource_uri: "issue://other-tracker/issues/1" }), isCode("FORBIDDEN"));
  });
});

describe("PR03 immutable, expiring plans", () => {
  test("plan freezes arguments, conditions, checks and policy revision under a keyed digest", async () => {
    const issue = await h.seedIssue("alice");
    const task = await h.task(grant, [ownerCheck("bob", `issue://issue-tracker/issues/${issue.id}`)]);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issue.id, owner: "bob" } });
    assert.equal(plan.status, "prepared");
    assert.match(plan.digest, /^hmac-sha256:[0-9a-f]{64}$/);
    assert.deepEqual(plan.resource_conditions, [{ resource_uri: `issue://issue-tracker/issues/${issue.id}`, expected_version: "1", enforcement: "native" }]);
    assert.equal(plan.required_checks.length, 1);
    assert.ok(Date.parse(plan.expires_at) - Date.parse(plan.created_at) <= 300_000);
    // Prepare is read-only: the destination did not change.
    const after = await h.control(`/authoritative/${issue.id}`);
    assert.equal(after.version, 1);
    // Different arguments produce a different plan and digest; plans cannot be edited.
    const other = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issue.id, owner: "carol" } });
    assert.notEqual(other.digest, plan.digest);
  });

  test("expired plans cannot execute", async () => {
    const issue = await h.seedIssue();
    const task = await h.task(grant, []);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issue.id, owner: "bob" } });
    // Plans are append-only (database trigger), so expiry is exercised with a coordinator whose clock runs 10 minutes ahead.
    await assert.rejects(h.journal.pool.query("UPDATE plans SET principal = principal WHERE id = $1", [plan.id]), /append-only/);
    const { Coordinator } = await import("@vap/core");
    const future = new Coordinator(h.journal, h.registry, { digestKey: DIGEST_KEY, deploymentId: "test", clock: () => Date.now() + 600_000 });
    await assert.rejects(future.submitOperation(AGENT, { protocol_version: PROTOCOL_VERSION, plan_id: plan.id, request_key: key() }), isCode("PLAN_EXPIRED"));
  });

  test("arguments outside the input schema are rejected", async () => {
    const task = await h.task(grant, []);
    await assert.rejects(h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: "1", owner: "bob", extra: 1 } }), isCode("INVALID_ARGUMENT"));
    await assert.rejects(h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: "../admin", owner: "bob" } }), isCode("INVALID_ARGUMENT"));
  });
});

describe("PR01 contract revisions", () => {
  test("changing checks creates a new revision and stales plans bound to the old one", async () => {
    const issue = await h.seedIssue();
    const task = await h.task(grant, [ownerCheck("bob", `issue://issue-tracker/issues/${issue.id}`)]);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issue.id, owner: "bob" } });
    const extra = { ...ownerCheck("bob", `issue://issue-tracker/issues/${issue.id}`), id: "status_open", predicate: { op: "eq" as const, path: "/status", value: "open" } };
    const revised = await h.agent.reviseTask(task.id, { expected_revision: 1, required_checks: [...task.required_checks, extra] });
    assert.equal(revised.contract_revision, 2);
    assert.equal(revised.required_checks.find((c) => c.id === "status_open")?.provenance, "agent", "agent-added checks are labeled");
    const stale = await h.agent.getPlan(plan.id);
    assert.equal(stale.status, "stale");
    await assert.rejects(h.agent.execute(plan.id, key()), isCode("STALE_PLAN"));
  });

  test("an agent cannot weaken or remove user checks", async () => {
    const task = await h.task(grant, [ownerCheck("bob", "issue://issue-tracker/issues/1")]);
    await assert.rejects(h.agent.reviseTask(task.id, { expected_revision: 1, required_checks: [] }), isCode("FORBIDDEN"));
    await assert.rejects(
      h.agent.reviseTask(task.id, { expected_revision: 1, required_checks: [{ ...task.required_checks[0], predicate: { op: "exists", path: "/owner" } }] }),
      isCode("FORBIDDEN"),
    );
    await assert.rejects(h.agent.reviseTask(task.id, { expected_revision: 5, assumptions: [] }), isCode("CONFLICT"));
  });
});

describe("PR04 request identity (T01, T02)", () => {
  test("T01: identical concurrent submissions create one logical operation and one destination write", async () => {
    const task = await h.task(grant, []);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.create", arguments: { title: "Concurrent create", owner: "dave" } });
    const k = key("t01");
    const results = await Promise.all(Array.from({ length: 8 }, () => h.agent.execute(plan.id, k)));
    const ids = new Set(results.map((r) => r.operation.id));
    assert.equal(ids.size, 1);
    assert.equal(results.filter((r) => !r.replayed).length, 1);
    await h.drain();
    const op = await h.agent.getOperation([...ids][0]);
    assert.equal(op.execution_status, "completed");
    const writes = await h.control(`/writes/${op.id}`);
    assert.equal(writes.writes, 1, "native destination deduplication: exactly one write");
    const replay = await h.agent.execute(plan.id, k);
    assert.equal(replay.operation.id, op.id);
    assert.equal(replay.replayed, true);
  });

  test("T02: the same key with a different plan conflicts and makes no destination call", async () => {
    const task = await h.task(grant, []);
    const p1 = await h.agent.prepare({ task_id: task.id, action_id: "issues.create", arguments: { title: "First plan", owner: "dave" } });
    const p2 = await h.agent.prepare({ task_id: task.id, action_id: "issues.create", arguments: { title: "Changed plan", owner: "dave" } });
    const k = key("t02");
    const first = await h.agent.execute(p1.id, k);
    await h.drain();
    const before = await h.control("/stats");
    await assert.rejects(h.agent.execute(p2.id, k), (e: unknown) => e instanceof VapError && e.code === "KEY_REUSE_CONFLICT" && e.operationId === first.operation.id);
    await h.drain();
    const after = await h.control("/stats");
    assert.equal(after.writes, before.writes);
  });

  test("keys are scoped per principal; a plan executes at most once", async () => {
    const task = await h.task(grant, []);
    const p = await h.agent.prepare({ task_id: task.id, action_id: "issues.create", arguments: { title: "Once only", owner: "erin" } });
    await h.agent.execute(p.id, key());
    await assert.rejects(h.agent.execute(p.id, key()), isCode("CONFLICT"));
    await assert.rejects(h.agent2.execute(p.id, key()), isCode("NOT_FOUND"));
  });
});

describe("PR05/PR06/PR08 durable state, verification and inspection", () => {
  test("operation state survives a coordinator restart and verifies from observed state", async () => {
    const issue = await h.seedIssue("alice");
    const task = await h.task(grant, [ownerCheck("bob", `issue://issue-tracker/issues/${issue.id}`)]);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issue.id, owner: "bob" } });
    const { operation } = await h.agent.execute(plan.id, key());
    assert.equal(operation.execution_status, "queued");
    assert.equal(operation.outcome, "requested");
    const fresh = await h.restartCoordinator();
    await fresh.drainOutbox("restarted-worker", 50);
    await h.drain();
    const op = await fresh.getOperation(AGENT, operation.id);
    assert.equal(op.execution_status, "completed");
    assert.equal(op.verification_status, "passed");
    assert.equal(op.outcome, "verified");
    const receipt = await h.agent.receipt(op.id);
    assert.equal(receipt.checks[0].result, "pass");
    assert.equal(receipt.checks[0].source_version, "2");
    assert.equal(receipt.retry_guidance.disposition, "do_not_retry");
    const outcome = await h.agent.taskOutcome(task.id);
    assert.equal(outcome.verified_complete, true);
    const events = await h.agent.events(op.id);
    const types = events.events.map((e) => e.type);
    for (const t of ["operation.accepted", "dispatch.intent", "dispatch.result", "verification.started", "verification.result"]) assert.ok(types.includes(t as never), t);
    assert.deepEqual(events.events.map((e) => e.sequence), events.events.map((_e, i) => i + 1), "monotonic sequence");
    const evidence = await h.agent.evidence(op.id);
    assert.ok(evidence.every((e) => e.independence === "same_process" && e.limitations.length > 0));
  });

  test("PR06: a failed required check prevents verified completion even though execution completed", async () => {
    const issue = await h.seedIssue("alice");
    const task = await h.task(grant, [ownerCheck("carol", `issue://issue-tracker/issues/${issue.id}`)]);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issue.id, owner: "bob" } });
    const { operation } = await h.agent.execute(plan.id, key());
    await h.drain();
    const op = await h.agent.getOperation(operation.id);
    assert.equal(op.execution_status, "completed");
    assert.equal(op.verification_status, "failed");
    assert.equal(op.outcome, "verification_failed");
    assert.equal((await h.agent.taskOutcome(task.id)).verified_complete, false);
  });

  test("operations without checks are completed but never verified", async () => {
    const issue = await h.seedIssue();
    const task = await h.task(grant, []);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issue.id, owner: "erin" } });
    const { operation } = await h.agent.execute(plan.id, key());
    await h.drain();
    const op = await h.agent.getOperation(operation.id);
    assert.equal(op.outcome, "completed_unverified");
    assert.equal(op.verification_status, "not_requested");
  });

  test("API payloads validate against the published schemas", async () => {
    const info = await h.agent.info();
    assert.deepEqual(schemaValidator().check("messages#info", info), []);
    assert.equal(info.protocol_version, "0.1");
  });
});

describe("PR08 evidence access follows the originating grant", () => {
  test("another principal cannot read the task, operation, receipt, evidence or events", async () => {
    const issue = await h.seedIssue();
    const task = await h.task(grant, [ownerCheck("bob", `issue://issue-tracker/issues/${issue.id}`)]);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issue.id, owner: "bob" } });
    const { operation } = await h.agent.execute(plan.id, key());
    await h.drain();
    for (const call of [
      () => h.agent2.getTask(task.id),
      () => h.agent2.getOperation(operation.id),
      () => h.agent2.receipt(operation.id),
      () => h.agent2.evidence(operation.id),
      () => h.agent2.events(operation.id),
      () => h.agent2.getPlan(plan.id),
      () => h.agent2.taskOutcome(task.id),
    ]) {
      await assert.rejects(call(), isCode("NOT_FOUND"));
    }
    void AGENT2;
    // An operator (viewer role) can inspect.
    assert.equal((await h.operator.receipt(operation.id)).operation_id, operation.id);
  });
});
