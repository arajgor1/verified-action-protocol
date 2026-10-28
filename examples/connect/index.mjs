// Minimal VAP application: one action from request to verified receipt.
//
// It talks to the quickstart runtime (examples/quickstart/compose.yaml) with demo
// authentication. Against a real deployment, replace demoToken(...) with an OIDC token
// provider (see docs/connect.md) and use the actions your deployment registers.
import { VapClient, demoToken } from "@verified-action-protocol/sdk";

const url = process.env.VAP_URL ?? "http://127.0.0.1:8080";
const agent = new VapClient({ baseUrl: url, token: demoToken("demo-agent") });
const operator = new VapClient({ baseUrl: url, token: demoToken("demo-operator") });

// An operator decides what the agent may do. Agents cannot create or widen grants.
const grant = await operator.createGrant({
  principal: "demo-agent",
  allowed_actions: ["issues.create"],
  allowed_targets: ["issue://issue-tracker/*"],
  risk_ceiling: 1,
  preauthorized_actions: ["issues.create"],
  expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
});

// 1. Open a task and name the check that defines success: read the issue back and compare.
const task = await agent.openTask({
  goal: "File an issue for the flaky checkout test, owned by erin",
  grant_id: grant.id,
  scope: { actions: ["issues.create"], resources: ["issue://issue-tracker/*"] },
  required_checks: [{
    id: "owner_matches",
    method: "read_back",
    verifier_id: "http.readback",
    target: "issue://issue-tracker/issues/{result.id}",
    predicate: { op: "eq", path: "/owner", value: "erin" },
    freshness: { max_age_seconds: 300 },
    deadline_seconds: 10,
  }],
});

// 2. Prepare an immutable plan, then execute it under a request key you keep. Retrying with
//    the same key returns the original operation instead of acting twice.
const plan = await agent.prepare({ task_id: task.id, action_id: "issues.create", arguments: { title: "Flaky checkout test", owner: "erin" } });
console.log(`plan ${plan.id}: ${plan.preview.summary}`);
const requestKey = `connect-${Date.now()}`;
const { operation } = await agent.execute(plan.id, requestKey);
console.log(`operation ${operation.id}: execution=${operation.execution_status} verification=${operation.verification_status}`);

// 3. Wait for an honest final state. Execution and verification are separate fields.
const done = await agent.waitForOperation(operation.id, { timeoutMs: 60_000 });
console.log(`operation ${done.id}: execution=${done.execution_status} verification=${done.verification_status} outcome=${done.outcome}`);

// 4. The receipt and evidence say what happened and how it was checked.
const receipt = await agent.receipt(done.id);
for (const c of receipt.checks) console.log(`  check ${c.id}: ${c.result} (source ${c.source}, version ${c.source_version})`);
for (const e of receipt.effects) console.log(`  effect ${e.side_effect_id}: ${e.status} ${e.resource_uri ?? ""}`);
const events = await agent.events(done.id);
console.log(`  events: ${events.events.map((e) => e.type).join(" -> ")}`);

if (done.outcome !== "verified") {
  // Anything else is reported as it is: unknown means reconcile before retrying.
  console.log(`not verified; retry guidance: ${receipt.retry_guidance.disposition}`);
  process.exit(1);
}
console.log("verified: the issue exists with the requested owner, confirmed by reading it back");
