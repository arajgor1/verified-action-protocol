// Cloud demo (run by infra/gcp/cloudbuild.demo.yaml): a verified success, a lost reply that
// reconciles without duplication, and a partial batch, printed as receipts. Uses synthetic
// data only and removes every database it creates.
import "./cloud-guard.ts";
import type { Receipt } from "@vap/protocol";
import { key, ownerCheck, startHarness } from "../tests/helpers/harness.ts";

function show(title: string, r: Receipt): void {
  const line = "-".repeat(72);
  process.stdout.write(`\n${line}\n${title}\n${line}\n`);
  process.stdout.write(`operation ${r.operation_id}  outcome=${r.outcome}\n`);
  process.stdout.write(`execution=${r.execution_status} verification=${r.verification_status} recovery=${r.recovery_status} unresolved=${r.unresolved}\n`);
  for (const c of r.checks) process.stdout.write(`  check ${c.id}${c.item_index !== null ? `[${c.item_index}]` : ""}: ${c.result} (source ${c.source ?? "-"} version ${c.source_version ?? "null"})\n`);
  for (const e of r.effects) process.stdout.write(`  effect ${e.side_effect_id}${e.item_index !== null && e.item_index !== undefined ? `[${e.item_index}]` : ""}: ${e.status} ${e.resource_uri ?? ""}\n`);
  for (const u of r.unverified_effects) process.stdout.write(`  not verified: ${u}\n`);
  process.stdout.write(`  retry guidance: ${r.retry_guidance.disposition} - ${r.retry_guidance.explanation}\n`);
}

const h = await startHarness();
try {
  const grant = await h.grant();
  process.stdout.write(`VAP demo: API ${h.apiUrl}, fixture ${h.fixture.url}\n`);

  // 1. Verified success: reassign an issue under a native conditional write.
  const issue = await h.seedIssue("alice", "Login page times out");
  const task = await h.agent.openTask({ goal: `Reassign issue ${issue.id} to bob`, grant_id: grant.id, scope: { actions: ["issues.*"], resources: ["issue://issue-tracker/*"] }, required_checks: [ownerCheck("bob", `issue://issue-tracker/issues/${issue.id}`)] });
  const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issue.id, owner: "bob" } });
  process.stdout.write(`\nplan ${plan.id}: ${plan.preview.summary}\nconditions: ${JSON.stringify(plan.resource_conditions)}\n`);
  const k1 = key("demo");
  const first = await h.agent.execute(plan.id, k1);
  await h.drain();
  show("1. Reassign issue (verified success)", await h.agent.receipt(first.operation.id));
  const replay = await h.agent.execute(plan.id, k1);
  process.stdout.write(`  repeating the same request key returned the original operation: ${replay.replayed && replay.operation.id === first.operation.id}\n`);
  process.stdout.write(`  task verified complete: ${(await h.agent.taskOutcome(task.id)).verified_complete}\n`);

  // 2. Lost reply: the destination commits but the reply never arrives.
  const t2 = await h.agent.openTask({ goal: "Create an issue despite a dropped reply", grant_id: grant.id, scope: { actions: ["issues.*"], resources: ["issue://issue-tracker/*"] }, required_checks: [ownerCheck("carol")] });
  const p2 = await h.agent.prepare({ task_id: t2.id, action_id: "issues.create", arguments: { title: "Payment webhook retries", owner: "carol" } });
  await h.fault("lost_reply", { count: 1 });
  const second = await h.agent.execute(p2.id, key("demo"));
  await h.drain();
  show("2a. Lost reply, before reconciliation (unknown, never shown as success)", await h.agent.receipt(second.operation.id));
  const rec = await h.agent.reconcile(second.operation.id);
  await h.drain();
  show(`2b. After reconciliation (${rec.resolution})`, await h.agent.receipt(second.operation.id));
  const writes = await h.control(`/writes/${second.operation.id}`);
  process.stdout.write(`  destination writes for this request key: ${writes.writes} (no duplicate)\n`);

  // 3. Partial batch with compensation of exactly the identified effects.
  const t3 = await h.agent.openTask({ goal: "Create four issues", grant_id: grant.id, scope: { actions: ["issues.*"], resources: ["issue://issue-tracker/*"] }, required_checks: [{ ...ownerCheck("dave", "{effect.resource_uri}"), scope: "each_effect" }] });
  const p3 = await h.agent.prepare({ task_id: t3.id, action_id: "issues.batch_create", arguments: { items: [1, 2, 3, 4].map((i) => ({ title: `Batch item ${i}`, owner: "dave" })) } });
  await h.fault("partial_batch", { count: 1, fail_after: 2 });
  const third = await h.agent.execute(p3.id, key("demo"));
  await h.drain();
  show("3a. Batch partly applied", await h.agent.receipt(third.operation.id));
  const comp = await h.agent.recover(third.operation.id, "compensate", key("demo-rec"));
  await h.drain();
  show("3b. Original after compensation (history preserved)", await h.agent.receipt(third.operation.id));
  show("3c. Compensation operation", await h.agent.receipt(comp.recovery_operation!.id));
} finally {
  await h.close();
  process.stdout.write("\ncleanup: demo databases dropped; fixture and API stopped\n");
}
