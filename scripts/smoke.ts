// Remote smoke and rehearsal checks against a deployed environment (run inside Cloud Build by
// infra/gcp/cloudbuild.deploy.yaml). Reads a short-lived identity token from a file the
// pipeline creates; the token is never printed.
//
//   node scripts/smoke.ts basic
//   node scripts/smoke.ts start            -> prints an operation id
//   node scripts/smoke.ts status <op_id>   -> one read of state and events, no waiting
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
  // The managed deployment aims owner-keyed fixture faults (FIXTURE_OWNER_FAULTS) at one
  // operation through its owner argument, and widens the check deadline beyond the fault's
  // visibility delay so verification is still in progress when the interruption happens.
  const owner = process.env.VAP_SMOKE_OWNER ?? "bob";
  const deadline = Number(process.env.VAP_SMOKE_CHECK_DEADLINE ?? 30);
  const task = await client.openTask({
    goal: "staging smoke: reassign an issue",
    grant_id: grant.id,
    scope: { actions: ["issues.update_owner"], resources: ["issue://issue-tracker/*"] },
    required_checks: [{ id: "owner_matches", method: "read_back", verifier_id: "http.readback", target: `issue://issue-tracker/issues/${issueId}`, predicate: { op: "eq", path: "/owner", value: owner }, freshness: { max_age_seconds: 3600 }, deadline_seconds: deadline }],
  });
  const plan = await client.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issueId, owner } });
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
} else if (cmd === "status" && arg) {
  // One read of the operation's current state and events, without waiting.
  const op = await client.getOperation(arg);
  const events = await client.events(op.id, 0, 200);
  process.stdout.write(JSON.stringify({ id: op.id, execution: op.execution_status, verification: op.verification_status, attempts: op.attempts, events: events.events.map((e) => ({ type: e.type, at: e.at, actor: e.actor })) }) + "\n");
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
  // Optional stricter expectations for a specific disruption (managed deployment):
  //   resumed:    verification was interrupted and resumed; one submission, verified
  //   reconciled: the reply was lost; reconciliation resolved it with one submission, verified
  const expect = process.env.VAP_SMOKE_EXPECT;
  const count = (t: string) => events.events.filter((e) => e.type === t).length;
  if (expect === "resumed" && !(op.outcome === "verified" && op.attempts === 1 && count("verification.started") >= 2)) {
    throw new Error(`expected a verified operation with one submission and resumed verification; got ${op.outcome}, ${op.attempts} attempts, ${count("verification.started")} verification.started`);
  }
  // With the interruption time: verification started before it, started again after it, and its
  // first result came after it (the interrupted verification never finished).
  const interruptedAt = process.env.VAP_SMOKE_INTERRUPTED_AT;
  if (expect === "resumed" && interruptedAt) {
    const t = Date.parse(interruptedAt);
    const at = (type: string) => events.events.filter((e) => e.type === type).map((e) => Date.parse(e.at));
    const started = at("verification.started");
    const firstResult = Math.min(...at("verification.result"));
    if (!(started.some((s) => s < t) && started.some((s) => s > t) && firstResult > t)) {
      throw new Error(`verification was not interrupted and resumed around ${interruptedAt}: started ${started.map((s) => new Date(s).toISOString()).join(", ")}, first result ${Number.isFinite(firstResult) ? new Date(firstResult).toISOString() : "none"}`);
    }
    log(`verification interrupted at ${interruptedAt} and resumed: started ${started.map((s) => new Date(s).toISOString()).join(", ")}; first result ${new Date(firstResult).toISOString()}`);
  }
  if (expect === "reconciled" && !(op.outcome === "verified" && op.attempts === 1 && count("reconcile.result") >= 1)) {
    throw new Error(`expected a verified operation resolved by reconciliation with one submission; got ${op.outcome}, ${op.attempts} attempts, ${count("reconcile.result")} reconcile.result`);
  }
} else {
  throw new Error("usage: smoke.ts basic | start | status <op_id> | check <op_id>");
}
