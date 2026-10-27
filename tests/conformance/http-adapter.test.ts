// Conformance: HTTP adapter profiles (Core, Verified, Recoverable), custom configuration-only
// action, native vs best-effort concurrency (T06) and unsupported recovery.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { VapError } from "@verified-action-protocol/protocol";
import type { Grant } from "@verified-action-protocol/protocol";
import { recordProfile, writeReport } from "../helpers/report.ts";
import { key, ownerCheck, startHarness } from "../helpers/harness.ts";
import type { Harness } from "../helpers/harness.ts";

const isCode = (code: string) => (e: unknown) => e instanceof VapError && e.code === code;
let h: Harness;
let grant: Grant;

before(async () => {
  h = await startHarness({
    // Tutorial path: a new action registered purely through configuration.
    mutateConfig: (cfg) => {
      cfg.http![0].actions.push({
        id: "issues.set_status",
        title: "Set issue status",
        connector: "issue_tracker",
        method: "PATCH",
        path: "/issues/{args.issue_id}",
        input_schema: {
          type: "object",
          additionalProperties: false,
          required: ["issue_id", "status"],
          properties: { issue_id: { type: "string", pattern: "^[0-9]{1,18}$" }, status: { type: "string", enum: ["open", "in_progress", "closed"] } },
        },
        body_fields: ["status"],
        effect_scope: { resource_template: "issue://issue-tracker/issues/{args.issue_id}", description: "issue status" },
        side_effects: [{ id: "status_changed", description: "issue status updated", class: "remote_reversible", bounded: true }],
        conditional_write: { resource: "issue://issue-tracker/issues/{args.issue_id}", mode: "native", header: "If-Match" },
        request_key_header: "Idempotency-Key",
        lookup: { path: "/requests/{request.key}", query: { seal: "1" }, definitive_not_found: true, status_pointer: "/status", applied_values: ["applied"], rejected_values: ["rejected"], response_pointer: "/response/body" },
        response: { projection: ["/id", "/status", "/version"], effects: [{ side_effect_id: "status_changed", resource_template: "issue://issue-tracker/issues/{result.id}", version_pointer: "/version" }] },
      });
    },
  });
  grant = await h.grant();
});
after(async () => {
  await writeReport("http-adapter");
  await h?.close();
});

describe("Core and Verified profiles", () => {
  test("configuration-only custom action executes, records effects and verifies saved state", async () => {
    const issue = await h.seedIssue();
    const task = await h.task(grant, [{ ...ownerCheck("x", `issue://issue-tracker/issues/${issue.id}`), id: "status_is_in_progress", predicate: { op: "eq", path: "/status", value: "in_progress" } }]);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.set_status", arguments: { issue_id: issue.id, status: "in_progress" } });
    const { operation } = await h.agent.execute(plan.id, key());
    await h.drain();
    const op = await h.agent.getOperation(operation.id);
    assert.equal(op.outcome, "verified");
    assert.equal(op.effects[0].resource_uri, `issue://issue-tracker/issues/${issue.id}`);
    assert.equal(op.effects[0].source_version, "2");
    recordProfile("issues.set_status", "core", true);
    recordProfile("issues.set_status", "verified", true);
  });

  for (const action of ["issues.update_owner", "issues.create", "issues.batch_create", "issues.close"]) {
    test(`${action}: honest states and fresh evidence`, async () => {
      const issue = await h.seedIssue();
      const args: Record<string, Record<string, unknown>> = {
        "issues.update_owner": { issue_id: issue.id, owner: "bob" },
        "issues.create": { title: "Profile create", owner: "bob" },
        "issues.batch_create": { items: [{ title: "Batch one", owner: "bob" }, { title: "Batch two", owner: "bob" }] },
        "issues.close": { issue_ids: [issue.id] },
      };
      const checks: Record<string, Parameters<Harness["task"]>[1]> = {
        "issues.update_owner": [ownerCheck("bob", `issue://issue-tracker/issues/${issue.id}`)],
        "issues.create": [ownerCheck("bob")],
        "issues.batch_create": [{ ...ownerCheck("bob", "{effect.resource_uri}"), scope: "each_effect" }],
        "issues.close": [{ ...ownerCheck("x", "{effect.resource_uri}"), id: "closed", scope: "each_effect", predicate: { op: "eq", path: "/status", value: "closed" } }],
      };
      const task = await h.task(grant, checks[action]);
      const plan = await h.agent.prepare({ task_id: task.id, action_id: action, arguments: args[action] });
      const { operation } = await h.agent.execute(plan.id, key());
      await h.drain();
      const op = await h.agent.getOperation(operation.id);
      assert.equal(op.execution_status, "completed", JSON.stringify(op.error));
      assert.equal(op.verification_status, "passed");
      const evidence = await h.agent.evidence(op.id);
      assert.ok(evidence.length >= 1);
      assert.ok(evidence.filter((e) => e.item_index === null).every((e) => e.result === "pass"));
      recordProfile(action, "core", true);
      recordProfile(action, "verified", true);
    });
  }
});

describe("T06 concurrency", () => {
  test("native conditional write rejects a stale write after an independent edit", async () => {
    const issue = await h.seedIssue("alice");
    const task = await h.task(grant, []);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issue.id, owner: "bob" } });
    await h.control("/independent-edit", { id: issue.id, owner: "carol" });
    const { operation } = await h.agent.execute(plan.id, key());
    await h.drain();
    const op = await h.agent.getOperation(operation.id);
    assert.equal(op.execution_status, "failed");
    assert.equal(op.error?.code, "CONFLICT");
    assert.ok(op.effects.every((e) => e.status === "not_applied"));
    const state = await h.control(`/authoritative/${issue.id}`);
    assert.equal(state.owner, "carol", "the independent edit survives");
    assert.equal((await h.agent.receipt(op.id)).retry_guidance.disposition, "safe_to_retry");
  });

  test("native conditional write survives racing independent writers", async () => {
    const issue = await h.seedIssue("alice");
    const task = await h.task(grant, []);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issue.id, owner: "bob" } });
    const { operation } = await h.agent.execute(plan.id, key());
    await Promise.all([h.drain(), h.control("/independent-edit", { id: issue.id, owner: "carol" }), h.control("/independent-edit", { id: issue.id, owner: "dave" })]);
    const op = await h.agent.waitForOperation(operation.id);
    const state = await h.control(`/authoritative/${issue.id}`);
    if (op.execution_status === "completed") {
      // Our write happened before the independent writers: destination version advanced past ours.
      assert.ok(state.version >= 2);
    } else {
      assert.equal(op.error?.code, "CONFLICT");
      assert.notEqual(state.owner, "bob");
    }
  });

  test("best-effort mode detects a change seen at re-read but declares no protection", async () => {
    const issue = await h.seedIssue("alice");
    const task = await h.task(grant, []);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner_best_effort", arguments: { issue_id: issue.id, owner: "bob" } });
    assert.equal(plan.resource_conditions[0].enforcement, "best_effort");
    const action = (await h.agent.listActions(task.id)).find((a) => a.action.id === "issues.update_owner_best_effort")!;
    assert.equal(action.action.capabilities.concurrency_mode, "best_effort");
    await h.control("/independent-edit", { id: issue.id, owner: "carol" });
    const { operation } = await h.agent.execute(plan.id, key());
    await h.drain();
    const op = await h.agent.getOperation(operation.id);
    assert.equal(op.execution_status, "failed");
    assert.equal(op.error?.code, "STALE_PLAN");
  });
});

describe("Recoverable profile", () => {
  test("compensation is a separate operation with its own evidence; post-recovery state is verified", async () => {
    const issue = await h.seedIssue("alice");
    const task = await h.task(grant, [ownerCheck("bob", `issue://issue-tracker/issues/${issue.id}`)]);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issue.id, owner: "bob" } });
    const { operation } = await h.agent.execute(plan.id, key());
    await h.drain();
    const rec = await h.agent.recover(operation.id, "compensate", key("rec"));
    assert.ok(rec.recovery_operation, "tier-1 compensation runs under the existing grant");
    assert.equal(rec.recovery_plan.recovery_of, operation.id);
    await h.drain();
    const recOp = await h.agent.getOperation(rec.recovery_operation!.id);
    assert.equal(recOp.recovers_operation_id, operation.id);
    assert.equal(recOp.outcome, "verified");
    const original = await h.agent.getOperation(operation.id);
    assert.equal(original.recovery_status, "succeeded");
    assert.equal(original.execution_status, "completed", "original history is preserved");
    assert.deepEqual(original.recovery_operation_ids, [recOp.id]);
    assert.equal((await h.control(`/authoritative/${issue.id}`)).owner, "alice");
    recordProfile("issues.update_owner", "recoverable", true);
  });

  test("irreversible effects are reported as not covered by compensation", async () => {
    const task = await h.task(grant, [ownerCheck("bob")]);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.create_and_notify", arguments: { title: "Notify create", owner: "bob", notify: true } });
    assert.equal(plan.status, "awaiting_approval");
    await h.approver.decideApproval({ plan_id: plan.id, plan_digest: plan.digest, decision: "approved" });
    const { operation } = await h.agent.execute(plan.id, key());
    await h.drain();
    const receipt = await h.agent.receipt(operation.id);
    assert.ok(receipt.unverified_effects.some((u) => u.includes("external notification delivery")));
    const before = await h.control("/stats");
    const rec = await h.agent.recover(operation.id, "compensate", key("rec"));
    assert.equal(rec.recovery_plan.action_id, "issues.close");
    await h.drain();
    const original = await h.agent.getOperation(operation.id);
    assert.equal(original.recovery_status, "succeeded");
    const events = (await h.agent.events(operation.id)).events;
    const requested = events.find((e) => e.type === "recovery.requested");
    assert.deepEqual(requested?.data.uncovered_effects, ["external notification delivery cannot be recalled"]);
    const afterStats = await h.control("/stats");
    assert.equal(afterStats.notifications, before.notifications, "compensation does not pretend to recall the notification");
  });

  test("unsupported recovery returns CAPABILITY_UNAVAILABLE", async () => {
    const issue = await h.seedIssue();
    const task = await h.task(grant, []);
    const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.close", arguments: { issue_ids: [issue.id] } });
    const { operation } = await h.agent.execute(plan.id, key());
    await h.drain();
    await assert.rejects(h.agent.recover(operation.id, "compensate", key()), isCode("CAPABILITY_UNAVAILABLE"));
    recordProfile("issues.close", "recoverable", false);
  });
});
