// CI-failure demonstration: a failed build becomes one verified GitHub issue, and the
// workflow resumes safely after a lost reply or a runtime crash. Layer A (deterministic
// fixture). Runs only in the cloud test container (needs PostgreSQL and built apps).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Grant, Operation, Plan } from "@verified-action-protocol/protocol";
import { renderIssue, sanitizeErrorOutput } from "@verified-action-protocol/adapters";
import type { CiFailureArgs } from "@verified-action-protocol/adapters";
import { issueArgsFrom, issueChecks } from "../../demo/ci-failure/lib/agents.ts";
import type { AgentEnv } from "../../demo/ci-failure/lib/agents.ts";
import { startFaultProxy } from "../../demo/ci-failure/lib/fault-proxy.ts";
import type { FaultProxy } from "../../demo/ci-failure/lib/fault-proxy.ts";
import { runTests } from "../../demo/ci-failure/lib/run-tests.ts";
import type { TestRun } from "../../demo/ci-failure/lib/run-tests.ts";
import { REPOSITORY, runScenario, SCENARIOS } from "../../demo/ci-failure/lib/scenarios.ts";
import type { SuiteContext } from "../../demo/ci-failure/lib/scenarios.ts";
import { ACTION_ID, deriveWorkflowId, requestKeyFor } from "../../demo/ci-failure/lib/workflow.ts";
import { adminUrl, key, sleep, startHarness } from "../helpers/harness.ts";
import type { Harness } from "../helpers/harness.ts";
import { recordScenario, writeReport } from "../helpers/report.ts";

const COMMIT = (process.env.COMMIT_SHA && /^[0-9a-f]{40}$/.test(process.env.COMMIT_SHA) ? process.env.COMMIT_SHA : "0123456789abcdef0123456789abcdef01234567");
const isCode = (code: string) => (e: unknown) => (e as { code?: string }).code === code;

let tests: TestRun;

before(async () => {
  tests = await runTests();
});

describe("observations: the sample project's failed build", () => {
  test("the TAP run reports exactly the deliberate failure, and its raw output carries the canary", () => {
    assert.equal(tests.failed, 1, JSON.stringify(tests));
    assert.equal(tests.passed, 2);
    assert.equal(tests.failures[0].name, "parses hours with minutes");
    assert.match(tests.failures[0].errorOutput, /VAPCANARY-ci-demo/);
    const clean = sanitizeErrorOutput(tests.failures[0].errorOutput);
    assert.doesNotMatch(clean, /VAPCANARY/);
    assert.match(clean, /5400/);
  });

  test("workflow identity is stable for the same facts and differs per build event", () => {
    const f = { repository: "vap-demo/sample-project", commit: COMMIT, buildEvent: "build-1" };
    assert.equal(deriveWorkflowId(f), deriveWorkflowId({ ...f }));
    assert.notEqual(deriveWorkflowId(f), deriveWorkflowId({ ...f, buildEvent: "build-2" }));
    assert.match(deriveWorkflowId(f), /^vapwf-[0-9a-f]{24}$/);
  });
});

describe("Layer A contract: GitHub adapter through VAP (in-process runtime)", () => {
  let h: Harness;
  let proxy: FaultProxy;
  let grant: Grant;
  let seq = 0;

  before(async () => {
    proxy = await startFaultProxy({ upstream: "http://127.0.0.1:9/gh" });
    h = await startHarness({
      coordinator: { maxReconcileAttempts: 4 },
      mutateConfig: (cfg) => {
        cfg.github = { id: "github.issues", api_base_url: proxy.url, repository: REPOSITORY, auth: { type: "none" }, allow_private_network: true, lookup_max_pages: 3, author_login: "vap-demo-bot", clock_skew_seconds: 1 };
      },
    });
    proxy.setUpstream(`${h.fixture.url}/gh`);
    grant = await h.grant({ allowed_actions: [ACTION_ID], allowed_targets: [`github://${REPOSITORY}/*`], preauthorized_actions: [] });
  });
  after(async () => {
    await writeReport("ci-demo");
    await h?.close();
    await proxy?.close();
  });

  const env = (label: string): AgentEnv => ({ facts: { repository: "vap-demo/sample-project", commit: COMMIT, buildEvent: `contract-${label}-${++seq}` }, repository: REPOSITORY, deadlineMs: Date.now() + 30_000, signal: new AbortController().signal, log: () => {} });

  async function preparePlan(label: string, mutate?: (s: string) => string): Promise<{ plan: Plan; wf: string; reqKey: string }> {
    const e = env(label);
    const wf = deriveWorkflowId(e.facts);
    const args = issueArgsFrom(tests, { ...e, mutateErrorOutput: mutate }, wf);
    const task = await h.agent.openTask({ goal: `file CI issue ${label}`, grant_id: grant.id, scope: { actions: [ACTION_ID], resources: [`github://${REPOSITORY}/*`] }, required_checks: issueChecks(REPOSITORY, wf) });
    const plan = await h.agent.prepare({ task_id: task.id, action_id: ACTION_ID, arguments: args as unknown as Record<string, unknown> });
    return { plan, wf, reqKey: requestKeyFor(wf) };
  }

  async function approve(plan: Plan): Promise<void> {
    await h.approver.decideApproval({ plan_id: plan.id, plan_digest: plan.digest, decision: "approved" });
  }

  async function settle(id: string): Promise<Operation> {
    await h.drain();
    return h.agent.waitForOperation(id, { timeoutMs: 40_000 });
  }

  async function truth(wf: string): Promise<{ count: number; issues: { number: number; body: string }[] }> {
    return h.control(`/gh/ground-truth?marker=${wf}`);
  }

  test("normal: tier-3 plan needs approval; the issue is created, read back and verified against saved destination state", async () => {
    await h.control("/gh/faults", { mode: "clear" });
    const { plan, wf, reqKey } = await preparePlan("normal");
    assert.equal(plan.risk_tier, 3);
    assert.equal(plan.status, "awaiting_approval");
    await assert.rejects(h.agent.execute(plan.id, reqKey), isCode("APPROVAL_REQUIRED"));
    await approve(plan);
    const { operation } = await h.agent.execute(plan.id, reqKey);
    const op = await settle(operation.id);
    assert.equal(op.execution_status, "completed");
    assert.equal(op.verification_status, "passed", JSON.stringify(await h.agent.evidence(op.id)));
    assert.equal(op.outcome, "verified");
    const t = await truth(wf);
    assert.equal(t.count, 1);
    assert.equal(op.result_summary?.number, t.issues[0].number);
    assert.equal(op.result_summary?.origin, "observed_create_response");
    assert.doesNotMatch(t.issues[0].body, /VAPCANARY/);
    // The dispatch intent is durable before the mutation reaches the destination.
    const events = (await h.agent.events(op.id, 0, 100)).events;
    const intent = events.find((e) => e.type === "dispatch.intent");
    const create = proxy.groundTruth().find((r) => r.kind === "create_issue" && r.workflow_id === wf);
    assert.ok(intent && create);
    assert.ok(Date.parse(intent.at) <= Date.parse(create.at), "intent recorded before the create was sent");
    assert.ok(events.findIndex((e) => e.type === "dispatch.intent") < events.findIndex((e) => e.type === "dispatch.result"));
    recordScenario("CI-normal", true);
  });

  test("verification reads the destination, not the journal: editing the saved issue makes re-verification fail", async () => {
    await h.control("/gh/faults", { mode: "clear" });
    const { plan, wf, reqKey } = await preparePlan("tamper");
    await approve(plan);
    const { operation } = await h.agent.execute(plan.id, reqKey);
    const op = await settle(operation.id);
    assert.equal(op.verification_status, "passed");
    // Someone edits the issue at the destination and removes the commit SHA.
    await h.fixture.pool.query("UPDATE fx_gh_issues SET body = replace(body, $1, 'REMOVED') WHERE body LIKE $2", [COMMIT, `%${wf}%`]);
    const v = await h.agent.verify(op.id, ["issue.content"]);
    const ev = v.evidence.find((e) => e.check_id === "issue.content" && e.item_index === null);
    assert.equal(ev?.result, "fail", JSON.stringify(ev));
    assert.equal(v.operation.verification_status, "failed");
    recordScenario("CI-destination-state-separate", true);
  });

  test("response lost after the create committed: outcome is unknown, reconciliation finds the issue, no second create", async () => {
    await h.control("/gh/faults", { mode: "clear" });
    proxy.setSchedule([{ match: "create_issue", action: "drop_response_after_commit" }]);
    const { plan, wf, reqKey } = await preparePlan("lost");
    await approve(plan);
    const { operation } = await h.agent.execute(plan.id, reqKey);
    await h.drain();
    const unknown = await h.agent.getOperation(operation.id);
    assert.equal(unknown.execution_status, "unknown");
    assert.equal((await h.agent.receipt(operation.id)).retry_guidance.disposition, "reconcile_first");
    const r = await h.agent.reconcile(operation.id);
    assert.equal(r.resolution, "found_applied");
    const op = await settle(operation.id);
    assert.equal(op.verification_status, "passed");
    assert.equal(op.result_summary?.origin, "inferred_from_lookup", "a lost reply never yields proven authorship");
    const content = (await h.agent.evidence(op.id)).find((e) => e.check_id === "issue.content" && e.item_index === null);
    assert.ok(content?.limitations.some((l) => /not proven/.test(l)));
    assert.equal(op.attempts, 1);
    assert.equal(proxy.createCount(wf), 1);
    assert.equal((await truth(wf)).count, 1);
    recordScenario("CI-response-lost", true);
  });

  test("duplicate submission: the same plan and key return the existing operation", async () => {
    await h.control("/gh/faults", { mode: "clear" });
    proxy.setSchedule([]);
    const { plan, wf, reqKey } = await preparePlan("dup");
    await approve(plan);
    const [a, b] = await Promise.all([h.agent.execute(plan.id, reqKey), h.agent.execute(plan.id, reqKey)]);
    assert.equal(a.operation.id, b.operation.id);
    assert.equal([a.replayed, b.replayed].filter(Boolean).length, 1);
    const found = await h.agent.findOperation(ACTION_ID, reqKey);
    assert.equal(found?.id, a.operation.id);
    assert.equal(await h.agent2.findOperation(ACTION_ID, reqKey), null, "another principal cannot see it");
    await settle(a.operation.id);
    assert.equal(proxy.createCount(wf), 1);
    recordScenario("CI-duplicate-submission", true);
  });

  test("changed payload under the same key is rejected before any destination call", async () => {
    await h.control("/gh/faults", { mode: "clear" });
    const first = await preparePlan("changed");
    await approve(first.plan);
    const { operation } = await h.agent.execute(first.plan.id, first.reqKey);
    await settle(operation.id);
    const creates = proxy.groundTruth().filter((r) => r.kind === "create_issue").length;
    const task = await h.agent.getTask((await h.agent.getOperation(operation.id)).task_id);
    const changedArgs = { ...(first.plan.canonical_arguments as Record<string, unknown>), error_output: "different output" };
    const second = await h.agent.prepare({ task_id: task.id, action_id: ACTION_ID, arguments: changedArgs });
    await approve(second);
    await assert.rejects(h.agent.execute(second.id, first.reqKey), isCode("KEY_REUSE_CONFLICT"));
    await h.drain();
    assert.equal(proxy.groundTruth().filter((r) => r.kind === "create_issue").length, creates, "no destination call");
    assert.equal((await truth(first.wf)).count, 1);
    recordScenario("CI-changed-payload", true);
  });

  test("destination rejection: failed, never reconciled into success, no issue", async () => {
    await h.control("/gh/faults", { mode: "reject", count: 1 });
    const { plan, wf, reqKey } = await preparePlan("reject");
    await approve(plan);
    const { operation } = await h.agent.execute(plan.id, reqKey);
    const op = await settle(operation.id);
    assert.equal(op.execution_status, "failed");
    assert.equal(op.error?.code, "INVALID_ARGUMENT");
    assert.equal((await truth(wf)).count, 0);
    recordScenario("CI-destination-rejects", true);
  });

  test("reconciliation unavailable: stays unknown, escalates to an operator, never creates blindly", async () => {
    await h.control("/gh/faults", { mode: "clear" });
    proxy.setSchedule([
      { match: "create_issue", action: "drop_response_after_commit" },
      { match: "list_issues", action: "fail_request", count: 1000 },
    ]);
    const { plan, wf, reqKey } = await preparePlan("unavail");
    await approve(plan);
    const { operation } = await h.agent.execute(plan.id, reqKey);
    await h.drain();
    const resolutions: string[] = [];
    for (let i = 0; i < 4; i++) resolutions.push((await h.agent.reconcile(operation.id)).resolution);
    assert.deepEqual(resolutions, ["still_unknown", "still_unknown", "still_unknown", "operator_resolution_required"]);
    const op = await h.agent.getOperation(operation.id);
    assert.equal(op.execution_status, "unknown");
    assert.equal(op.outcome, "unknown");
    assert.equal(op.attempts, 1);
    assert.equal(proxy.createCount(wf), 1, "exactly the one original create");
    assert.equal((await truth(wf)).count, 1, "the issue exists although VAP cannot see it");
    proxy.setSchedule([]);
    recordScenario("CI-reconciliation-unavailable", true);
  });

  test("a planted issue that quotes the workflow marker never resolves the operation", async () => {
    await h.control("/gh/faults", { mode: "clear" });
    const { plan, wf, reqKey } = await preparePlan("spoof");
    // Someone else files an issue that starts with the same marker but is not what the plan renders.
    await fetch(`${h.fixture.url}/gh/repos/${REPOSITORY}/issues`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "[CI failure] planted", body: `<!-- vap-workflow-id: ${wf} -->
not the real report` }) });
    // The real create never reaches GitHub, and the runtime cannot know that (503 = unknown).
    proxy.setSchedule([{ match: "create_issue", action: "fail_request" }]);
    await approve(plan);
    const { operation } = await h.agent.execute(plan.id, reqKey);
    await h.drain();
    assert.equal((await h.agent.getOperation(operation.id)).execution_status, "unknown");
    const r = await h.agent.reconcile(operation.id);
    assert.equal(r.resolution, "still_unknown");
    assert.equal(r.observations[0]?.foreign_marker_matches, 1);
    assert.equal(proxy.createCount(wf), 0);
    proxy.setSchedule([]);
    recordScenario("CI-spoofed-marker", true);
  });

  async function plant(plan: Plan, author: string): Promise<void> {
    const { title, body } = renderIssue(plan.canonical_arguments as unknown as CiFailureArgs);
    const r = await h.control("/gh/plant", { repository: REPOSITORY, title, body, author });
    assert.ok(r.number, JSON.stringify(r));
  }

  test("attribution: another actor's identical issue with the same marker never resolves the operation", async () => {
    await h.control("/gh/faults", { mode: "clear" });
    const { plan, wf, reqKey } = await preparePlan("other-actor");
    await approve(plan);
    // The operation's own create never reaches GitHub; the runtime cannot know that.
    proxy.setSchedule([{ match: "create_issue", action: "fail_request" }]);
    const { operation } = await h.agent.execute(plan.id, reqKey);
    await h.drain();
    // Another account files exactly the planned title and body, marker included.
    await plant(plan, "someone-else");
    const r = await h.agent.reconcile(operation.id);
    assert.equal(r.resolution, "still_unknown");
    // The lookup lists only issues created by the adapter's identity (creator=), so the other
    // account's copy is never even a candidate.
    assert.equal(r.observations[0]?.matches, 0);
    assert.equal(r.observations[0]?.foreign_marker_matches, 0);
    assert.equal(proxy.createCount(wf), 0);
    const t = await truth(wf);
    assert.equal(t.count, 1, "the identical issue exists...");
    assert.equal((t.issues[0] as { author?: string }).author, "someone-else", "...but it was filed by another account");
    assert.equal((await h.agent.getOperation(operation.id)).execution_status, "unknown");
    proxy.setSchedule([]);
    recordScenario("CI-attribution-other-actor", true);
  });

  test("attribution: an identical issue from the same identity that predates the operation is not taken as its result", async () => {
    await h.control("/gh/faults", { mode: "clear" });
    const { plan, wf, reqKey } = await preparePlan("predates");
    await plant(plan, "vap-demo-bot");
    await sleep(1500); // beyond the configured 1 s clock-skew tolerance
    await approve(plan);
    proxy.setSchedule([{ match: "create_issue", action: "fail_request" }]);
    const { operation } = await h.agent.execute(plan.id, reqKey);
    await h.drain();
    const r = await h.agent.reconcile(operation.id);
    assert.equal(r.resolution, "still_unknown");
    assert.equal((r.observations[0]?.rejected as Record<string, number>).created_before_operation, 1);
    assert.equal(proxy.createCount(wf), 0);
    proxy.setSchedule([]);
    recordScenario("CI-attribution-predates", true);
  });

  test("attribution: same identity and content after acceptance resolves existence but reports origin as inferred, not proven", async () => {
    await h.control("/gh/faults", { mode: "clear" });
    const { plan, wf, reqKey } = await preparePlan("same-identity");
    await approve(plan);
    proxy.setSchedule([{ match: "create_issue", action: "fail_request" }]);
    const { operation } = await h.agent.execute(plan.id, reqKey);
    await h.drain();
    // A different actor holding the same app identity files the planned issue (indistinguishable
    // from this operation's own create at GitHub). The issue exists; authorship is not provable.
    await plant(plan, "vap-demo-bot");
    const r = await h.agent.reconcile(operation.id);
    assert.equal(r.resolution, "found_applied");
    const op = await settle(operation.id);
    assert.equal(op.verification_status, "passed");
    assert.equal(op.result_summary?.origin, "inferred_from_lookup");
    assert.match(String(op.result_summary?.origin_note), /not proven/);
    assert.equal(proxy.createCount(wf), 0, "this operation's create never reached GitHub, which is exactly why origin stays inferred");
    proxy.setSchedule([]);
    recordScenario("CI-attribution-same-identity", true);
  });

  test("delayed visibility: not found yet is not failure; a later reconcile finds the issue", async () => {
    await h.control("/gh/faults", { mode: "delay_visibility", count: 1, delay_ms: 2500 });
    proxy.setSchedule([{ match: "create_issue", action: "drop_response_after_commit" }]);
    const { plan, wf, reqKey } = await preparePlan("delay");
    await approve(plan);
    const { operation } = await h.agent.execute(plan.id, reqKey);
    await h.drain();
    const first = await h.agent.reconcile(operation.id);
    assert.equal(first.resolution, "still_unknown");
    assert.equal(first.operation.execution_status, "unknown");
    await sleep(3000);
    const second = await h.agent.reconcile(operation.id);
    assert.equal(second.resolution, "found_applied");
    const op = await settle(operation.id);
    assert.equal(op.verification_status, "passed");
    assert.equal(proxy.createCount(wf), 1);
    recordScenario("CI-delayed-visibility", true);
  });
});

describe("Layer A end to end: real runtime processes, crash and restart", () => {
  let h: Harness;
  let ctx: SuiteContext;
  before(async () => {
    // The harness provides the fixture (with controls); the runtime runs as child processes.
    h = await startHarness();
    ctx = { adminUrl: adminUrl(), fixtureUrl: h.fixture.url, fixtureControlUrl: h.fixture.controlUrl!, commit: COMMIT, buildId: `test-${Date.now()}`, deadlineMs: 45_000, log: (l) => process.stdout.write(`# ${l}\n`) };
  });
  after(async () => {
    await h?.close();
  });

  for (const s of SCENARIOS) {
    test(`${s.id}: ${s.title} (VAP agent)`, { timeout: 120_000 }, async () => {
      const r = await runScenario(ctx, s, "vap", 1, tests.failures[0].name);
      process.stdout.write(`# ${JSON.stringify({ scenario: r.scenario, correct: r.correct, claims: r.reports.map((x) => x.claim), issues: r.issues_with_marker, creates: r.creates_accepted, restarted: r.restarted })}\n`);
      assert.equal(r.correct, true, JSON.stringify(r, null, 2));
      assert.equal(r.duplicates, 0);
      assert.equal(r.false_completion_claim, false);
      assert.equal(r.false_task_success, false);
      assert.equal(r.canary_leaked, false);
      assert.equal(r.fault_fired, true, "the scheduled fault must actually happen");
      assert.equal(r.category, s.correctClaims.includes("unknown") ? "safely_unresolved" : s.correctClaims.includes("rejected") ? "correctly_rejected" : "completed");
      // A lost or interrupted reply can only ever yield an inferred origin.
      if (s.proxy.some((x) => x.match === "create_issue")) assert.ok(r.origins.every((o) => o === null || o === "inferred_from_lookup"), JSON.stringify(r.origins));
      if (s.id === "S1-normal") assert.deepEqual(r.origins, ["observed_create_response"]);
      if (s.proxy.some((x) => x.match === "create_issue")) assert.equal(r.create_replies_delivered, 0, "the create's reply never reached the caller");
      if (s.crashOnHold) assert.equal(r.recovered_after_restart, true);
      recordScenario(`CI-e2e-${s.id}`, r.correct);
    });
  }

  test("grant request key for an unrelated principal is not addressable", { timeout: 5_000 }, async () => {
    assert.equal(await h.agent.findOperation(ACTION_ID, key("none")), null);
  });
});

