// VAP quickstart demo (examples/quickstart/compose.yaml): a verified success, a dropped response
// that is reconciled without a duplicate write, and a partly applied batch that is compensated.
// Runs against the API over demo authentication and uses synthetic data only.
import { VapClient, demoToken } from "@verified-action-protocol/sdk";

const url = process.env.VAP_URL ?? "http://127.0.0.1:8080";
const fixture = process.env.FIXTURE_URL ?? "http://fixture:8081";
const control = process.env.FIXTURE_CONTROL_URL ?? "http://fixture:8082";
const operator = new VapClient({ baseUrl: url, token: demoToken("demo-operator") });
const agent = new VapClient({ baseUrl: url, token: demoToken("demo-agent") });
const out = (s = "") => process.stdout.write(s + "\n");
const key = (label) => `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

async function post(base, path, body) {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${path}: HTTP ${res.status}`);
  return res.json();
}
const ownerCheck = (owner, target = "issue://issue-tracker/issues/{result.id}") => ({
  id: "owner_matches",
  method: "read_back",
  verifier_id: "http.readback",
  target,
  predicate: { op: "eq", path: "/owner", value: owner },
  freshness: { max_age_seconds: 3600 },
  deadline_seconds: 10,
});
const scope = { actions: ["issues.*"], resources: ["issue://issue-tracker/*"] };
const settled = (o) => !["queued", "running"].includes(o.execution_status) && o.verification_status !== "pending";

async function show(title, id) {
  const r = await agent.receipt(id);
  out(`\n${"-".repeat(72)}\n${title}\n${"-".repeat(72)}`);
  out(`operation ${r.operation_id}  outcome=${r.outcome}`);
  out(`execution=${r.execution_status} verification=${r.verification_status} recovery=${r.recovery_status} unresolved=${r.unresolved}`);
  for (const c of r.checks) out(`  check ${c.id}${c.item_index !== null ? `[${c.item_index}]` : ""}: ${c.result} (source ${c.source ?? "-"} version ${c.source_version ?? "null"})`);
  for (const e of r.effects) out(`  effect ${e.side_effect_id}${e.item_index != null ? `[${e.item_index}]` : ""}: ${e.status} ${e.resource_uri ?? ""}`);
  for (const u of r.unverified_effects) out(`  not verified: ${u}`);
  out(`  retry guidance: ${r.retry_guidance.disposition} - ${r.retry_guidance.explanation}`);
  return r;
}

const info = await agent.info();
out(`VAP ${info.build.version} (build ${info.build.commit ?? "unknown"}), protocol ${info.protocol_version}, auth ${info.auth_mode}`);
const grant = await operator.createGrant({
  principal: "demo-agent",
  allowed_actions: ["issues.*"],
  allowed_targets: ["issue://issue-tracker/*"],
  risk_ceiling: 3,
  preauthorized_actions: ["issues.create", "issues.batch_create"],
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
});
out(`operator granted demo-agent issues.* on the synthetic issue tracker (grant ${grant.id})`);

// 1. Verified success: reassign an issue under a native conditional write.
const issue = await post(fixture, "/issues", { title: "Login page times out", owner: "alice" });
const t1 = await agent.openTask({ goal: `Reassign issue ${issue.id} to bob`, grant_id: grant.id, scope, required_checks: [ownerCheck("bob", `issue://issue-tracker/issues/${issue.id}`)] });
const p1 = await agent.prepare({ task_id: t1.id, action_id: "issues.update_owner", arguments: { issue_id: issue.id, owner: "bob" } });
out(`\nplan ${p1.id}: ${p1.preview.summary}`);
const k1 = key("demo");
const first = await agent.execute(p1.id, k1);
await agent.waitForOperation(first.operation.id, { until: settled });
await show("1. Reassign issue (verified success)", first.operation.id);
const replay = await agent.execute(p1.id, k1);
out(`  repeating the same request key returned the original operation: ${replay.replayed && replay.operation.id === first.operation.id}`);

// 2. Dropped response: the destination commits the write, but the reply never arrives.
const t2 = await agent.openTask({ goal: "Create an issue despite a dropped reply", grant_id: grant.id, scope, required_checks: [ownerCheck("carol")] });
const p2 = await agent.prepare({ task_id: t2.id, action_id: "issues.create", arguments: { title: "Payment webhook retries", owner: "carol" } });
await post(control, "/faults", { mode: "lost_reply", count: 1 });
const second = await agent.execute(p2.id, key("demo"));
await agent.waitForOperation(second.operation.id, { until: settled });
const lost = await show("2a. Dropped response, before reconciliation (unknown, never shown as success)", second.operation.id);
const rec = await agent.reconcile(second.operation.id);
await agent.waitForOperation(second.operation.id, { until: settled });
const recovered = await show(`2b. After reconciliation (${rec.resolution})`, second.operation.id);
const writes = await (await fetch(`${control}/writes/${encodeURIComponent(second.operation.id)}`)).json();
out(`  destination writes for this request: ${writes.writes} (no duplicate)`);
out("  evidence:");
for (const e of await agent.evidence(second.operation.id)) {
  out(`    ${e.id} check=${e.check_id} result=${e.result} source=${e.source} version=${e.source_version ?? "null"} freshness=${e.freshness} independence=${e.independence} observed_at=${e.observed_at}`);
}
const events = await agent.events(second.operation.id, 0, 100);
out(`  events: ${events.events.map((e) => e.type).join(" -> ")}`);

// 3. Partial batch: two of four items apply; compensation closes exactly those two.
const t3 = await agent.openTask({ goal: "Create four issues", grant_id: grant.id, scope, required_checks: [{ ...ownerCheck("dave", "{effect.resource_uri}"), scope: "each_effect" }] });
const p3 = await agent.prepare({ task_id: t3.id, action_id: "issues.batch_create", arguments: { items: [1, 2, 3, 4].map((i) => ({ title: `Batch item ${i}`, owner: "dave" })) } });
await post(control, "/faults", { mode: "partial_batch", count: 1, fail_after: 2 });
const third = await agent.execute(p3.id, key("demo"));
await agent.waitForOperation(third.operation.id, { until: settled });
await show("3a. Batch partly applied", third.operation.id);
const comp = await agent.recover(third.operation.id, "compensate", key("demo-rec"));
await agent.waitForOperation(comp.recovery_operation.id, { until: settled });
await show("3b. Original after compensation (history preserved)", third.operation.id);
await show("3c. Compensation operation", comp.recovery_operation.id);

const ok = lost.outcome === "unknown" && recovered.outcome === "verified" && writes.writes === 1;
out(`\nsummary: dropped response ${ok ? "reconciled to verified with exactly one destination write" : "NOT resolved as expected"}`);
out("remove everything with: docker compose -f examples/quickstart/compose.yaml down -v");
process.exit(ok ? 0 : 1);
