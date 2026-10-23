// Remote smoke and rehearsal checks against a deployed environment (run inside Cloud Build by
// infra/gcp/cloudbuild.deploy.yaml). Reads a short-lived identity token from a file the
// pipeline creates; the token is never printed.
//
//   node scripts/smoke.ts basic
//   node scripts/smoke.ts start            -> prints an operation id
//   node scripts/smoke.ts check <op_id>    -> waits for an honest final state
import "./cloud-guard.ts";
import { readFileSync } from "node:fs";
import { VapClient } from "@vap/sdk";
import { VapError } from "@vap/protocol";
import type { Operation } from "@vap/protocol";

const url = process.env.VAP_URL;
const fixture = process.env.VAP_FIXTURE_URL;
const tokenFile = process.env.VAP_TOKEN_FILE ?? "/workspace/.vap-token";
if (!url || !fixture) throw new Error("VAP_URL and VAP_FIXTURE_URL are required");
const client = new VapClient({ baseUrl: url, token: async () => readFileSync(tokenFile, "utf8").trim(), timeoutMs: 60_000 });
const [cmd, arg] = process.argv.slice(2);
const log = (m: string) => process.stderr.write(m + "\n");

async function seedIssue(): Promise<string> {
  const res = await fetch(`${fixture}/issues`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: `Smoke ${new Date().toISOString()}`, owner: "alice" }) });
  if (!res.ok) throw new Error(`fixture seed failed: HTTP ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function startOperation(): Promise<Operation> {
  const subject = process.env.VAP_SMOKE_SUBJECT;
  if (!subject) throw new Error("VAP_SMOKE_SUBJECT (the pipeline service account email) is required");
  await client.setPrincipalRoles(subject, ["operator", "viewer", "agent"]);
  const grant = await client.createGrant({ principal: subject, allowed_actions: ["issues.*"], allowed_targets: ["issue://issue-tracker/*"], risk_ceiling: 1, expires_at: new Date(Date.now() + 3600_000).toISOString() });
  const issueId = await seedIssue();
  const task = await client.openTask({
    goal: "staging smoke: reassign an issue",
    grant_id: grant.id,
    scope: { actions: ["issues.update_owner"], resources: ["issue://issue-tracker/*"] },
    required_checks: [{ id: "owner_matches", method: "read_back", verifier_id: "http.readback", target: `issue://issue-tracker/issues/${issueId}`, predicate: { op: "eq", path: "/owner", value: "bob" }, freshness: { max_age_seconds: 3600 }, deadline_seconds: 30 }],
  });
  const plan = await client.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issueId, owner: "bob" } });
  // Rehearsal only: arm a fixture fault after the issue is seeded and the plan prepared, so the
  // disruption hits this operation's write (VAP_SMOKE_FIXTURE_CONTROL is the fixture's control
  // listener, reachable only inside the rehearsal network).
  const control = process.env.VAP_SMOKE_FIXTURE_CONTROL;
  const fault = process.env.VAP_SMOKE_FAULT;
  if (control && fault) {
    const r = await fetch(`${control}/faults`, { method: "POST", headers: { "content-type": "application/json" }, body: fault });
    if (!r.ok) throw new Error(`arming fixture fault failed: HTTP ${r.status}`);
    log(`armed fixture fault ${fault}`);
  }
  return (await client.execute(plan.id, `smoke-${Date.now()}`)).operation;
}

async function waitFinal(id: string): Promise<Operation> {
  return client.waitForOperation(id, { timeoutMs: 600_000, until: (o) => !["queued", "running"].includes(o.execution_status) && o.verification_status !== "pending" });
}

if (cmd === "basic") {
  const info = await client.info();
  log(`protocol ${info.protocol_version}, auth ${info.auth_mode}, build ${info.build.commit ?? "?"}`);
  if (info.auth_mode !== "oidc") throw new Error("staging must run OIDC authentication");
  const unauth = await fetch(`${url}/v1/info`);
  if (unauth.status !== 401 && unauth.status !== 403) throw new Error(`unauthenticated request returned ${unauth.status}`);
  const op = await waitFinal((await startOperation()).id);
  const receipt = await client.receipt(op.id);
  log(JSON.stringify(receipt));
  if (op.outcome !== "verified") throw new Error(`expected a verified operation, got ${op.outcome}`);
  process.stdout.write(op.id + "\n");
} else if (cmd === "start") {
  process.stdout.write((await startOperation()).id + "\n");
} else if (cmd === "check" && arg) {
  const op = await waitFinal(arg);
  const events = await client.events(op.id, 0, 200);
  log(JSON.stringify({ outcome: op.outcome, execution: op.execution_status, verification: op.verification_status, attempts: op.attempts, events: events.events.map((e) => e.type) }));
  if (op.execution_status === "unknown") {
    log("operation is unknown after the disruption; this is the honest state and requires reconciliation or operator resolution");
  } else if (op.outcome !== "verified") {
    throw new VapError("INTERNAL", `unexpected final state ${op.outcome}`);
  }
  if (op.attempts > 1 && !events.events.some((e) => e.type === "reconcile.result")) throw new Error("a resubmission happened without reconciliation");
} else {
  throw new Error("usage: smoke.ts basic | start | check <op_id>");
}
