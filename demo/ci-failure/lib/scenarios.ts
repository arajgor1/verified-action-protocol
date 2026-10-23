// Scenario runner and independent evaluator for the CI-failure demo (fixture layer).
// Every condition gets the same fault schedule through the same proxy, the same test
// observations, the same deadline and the same lookup budget. Judgments use only the
// destination's ground truth (fixture control API, which ignores visibility delays) and the
// proxy's private records, never an agent's own report.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import type { Grant } from "@vap/protocol";
import { demoToken, VapClient } from "@vap/sdk";
import { AgentCrash, runCarefulAgent, runRetryAgent, runVapAgent } from "./agents.ts";
import type { AgentEnv, AgentReport, Claim } from "./agents.ts";
import { startFaultProxy } from "./fault-proxy.ts";
import type { FaultProxy, FaultRule, GroundTruthRecord } from "./fault-proxy.ts";
import { createVapRuntime } from "./runtime.ts";
import type { VapRuntime } from "./runtime.ts";
import { deriveWorkflowId } from "./workflow.ts";
import type { WorkflowFacts } from "./workflow.ts";

export type Condition = "vap" | "careful" | "careful_log" | "retry";
export const CONDITIONS: Condition[] = ["retry", "careful", "careful_log", "vap"];
export const REPOSITORY = "vap-demo/ci-failures";

export interface Scenario {
  id: string;
  title: string;
  proxy: FaultRule[];
  fixtureFaults?: { mode: string; count?: number; delay_ms?: number }[];
  /** Crash the caller (agent, and for VAP the runtime) while the create reply is held. */
  crashOnHold?: boolean;
  /** Concurrent agent instances for the same workflow (duplicate task submission). */
  instances?: number;
  /** Run the workflow again afterwards with different error output under the same identity. */
  changedPayloadRerun?: boolean;
  /** Issues that must exist at the destination afterwards. */
  expectIssues: 0 | 1;
  /** Claims that count as a correct report. */
  correctClaims: Claim[];
  /** The destination state is unobservable to the agent by construction (e.g. lookups fail). */
  unobservable?: boolean;
}

export const SCENARIOS: Scenario[] = [
  { id: "S1-normal", title: "Normal run", proxy: [], expectIssues: 1, correctClaims: ["created", "already_exists"] },
  { id: "S2-response-lost", title: "Create accepted, response lost", proxy: [{ match: "create_issue", action: "drop_response_after_commit" }], expectIssues: 1, correctClaims: ["created", "already_exists"] },
  { id: "S3-crash-after-submit", title: "Runtime crash after submission", proxy: [{ match: "create_issue", action: "hold_response_ms", holdMs: 1500 }], crashOnHold: true, expectIssues: 1, correctClaims: ["created", "already_exists"] },
  { id: "S4-duplicate-submission", title: "Duplicate task submission (two concurrent instances)", proxy: [], instances: 2, expectIssues: 1, correctClaims: ["created", "already_exists"] },
  { id: "S5-changed-payload", title: "Rerun with changed payload under the same workflow", proxy: [], changedPayloadRerun: true, expectIssues: 1, correctClaims: ["created", "already_exists"] },
  { id: "S6-destination-rejects", title: "Destination rejects the create", proxy: [], fixtureFaults: [{ mode: "reject", count: 1 }], expectIssues: 0, correctClaims: ["rejected"] },
  {
    id: "S7-reconciliation-unavailable",
    title: "Response lost and every lookup fails",
    proxy: [
      { match: "create_issue", action: "drop_response_after_commit" },
      { match: "list_issues", action: "fail_request", count: 10_000 },
      { match: "get_issue", action: "fail_request", count: 10_000 },
    ],
    expectIssues: 1,
    correctClaims: ["unknown"],
    unobservable: true,
  },
  { id: "S8-delayed-visibility", title: "Response lost and the issue becomes visible 3 s later", proxy: [{ match: "create_issue", action: "drop_response_after_commit" }], fixtureFaults: [{ mode: "delay_visibility", count: 1, delay_ms: 3000 }], expectIssues: 1, correctClaims: ["created", "already_exists"] },
  {
    id: "S9-crash-delayed-visibility",
    title: "Crash after submission while the issue is not yet visible (6 s)",
    proxy: [{ match: "create_issue", action: "hold_response_ms", holdMs: 1500 }],
    fixtureFaults: [{ mode: "delay_visibility", count: 1, delay_ms: 6000 }],
    crashOnHold: true,
    expectIssues: 1,
    correctClaims: ["created", "already_exists"],
  },
];

export interface SuiteContext {
  adminUrl: string;
  fixtureUrl: string;
  fixtureControlUrl: string;
  commit: string;
  buildId: string;
  deadlineMs: number;
  log: (line: string) => void;
}

export interface RunRecord {
  scenario: string;
  condition: Condition;
  run: number;
  workflow_id: string;
  reports: AgentReport[];
  /** Destination ground truth. */
  issues_with_marker: number;
  issue_numbers: number[];
  content_valid: boolean;
  canary_leaked: boolean;
  /** Proxy truth: creates the destination accepted, and replies that reached the caller. */
  creates_accepted: number;
  create_replies_delivered: number;
  destination_requests: number;
  // judgments
  correct: boolean;
  completion_claimed: boolean;
  /**
   * API-level: a report claims completion but the issue it names does not exist or lacks the
   * required content. (Says nothing about duplicates.)
   */
  false_completion_claim: boolean;
  /**
   * Task-level: a report claims the task is complete while the task contract (exactly one issue
   * for the workflow, with the required content) does not hold, e.g. duplicates exist.
   */
  false_task_success: boolean;
  /** Number of final reports claiming completion, and how many of those are false at task level. */
  completion_claims: number;
  false_task_success_claims: number;
  duplicates: number;
  unknown_reported_correctly: boolean;
  restarted: boolean;
  /**
   * completed: the required issue exists exactly once with valid content and every final report
   *   claims completion; correctly_rejected: the destination refused, no issue exists and the
   *   report says so; safely_unresolved: the report says "unknown", at most one issue exists and
   *   nothing false was claimed; incorrect: anything else (duplicates, a wrong or false claim).
   */
  category: "completed" | "correctly_rejected" | "safely_unresolved" | "incorrect";
  /** Origin the final report gives for the issue it names (null when it names none). */
  origins: (AgentReport["origin"])[];
  /** The scheduled fault demonstrably happened (e.g. the destination accepted and the reply was lost). */
  fault_fired: boolean;
  recovered_after_restart: boolean | null;
  human_interventions: number;
  approvals: number;
  tool_calls: number;
  wall_ms: number;
  notes: string[];
}

async function createDatabase(adminUrl: string, prefix: string): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `${prefix}_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return {
    url: u.toString(),
    drop: async () => {
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

async function control(ctx: SuiteContext, path: string, body?: unknown): Promise<any> {
  const r = await fetch(ctx.fixtureControlUrl + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return r.json();
}

interface GroundTruth {
  count: number;
  issues: { number: number; title: string; body: string }[];
}

export async function destinationTruth(ctx: SuiteContext, workflowId: string): Promise<GroundTruth> {
  return (await control(ctx, `/gh/ground-truth?marker=${workflowId}`)) as GroundTruth;
}

export function issueContentValid(body: string, workflowId: string, commit: string, failingTest: string): boolean {
  return (
    body.includes(`<!-- vap-workflow-id: ${workflowId} -->`) &&
    body.includes(commit) &&
    body.includes(failingTest) &&
    /## Reproduction steps\n1\. /.test(body) &&
    /## Error output \(sanitized\)\n```text\n[\s\S]*\S[\s\S]*\n```/.test(body) &&
    !body.includes("VAPCANARY")
  );
}

/** Runs one scenario for one condition once. */
export async function runScenario(ctx: SuiteContext, s: Scenario, condition: Condition, run: number, failingTest: string): Promise<RunRecord> {
  const facts: WorkflowFacts = { repository: "vap-demo/sample-project", commit: ctx.commit, buildEvent: `${ctx.buildId}/${s.id}/${condition}/run-${run}` };
  const wf = deriveWorkflowId(facts);
  const notes: string[] = [];
  const log = (l: string) => ctx.log(`[${s.id} ${condition} #${run}] ${l}`);
  await control(ctx, "/gh/faults", { mode: "clear" });
  for (const f of s.fixtureFaults ?? []) await control(ctx, "/gh/faults", f);
  const proxy: FaultProxy = await startFaultProxy({ upstream: `${ctx.fixtureUrl}/gh`, schedule: s.proxy });
  let runtime: VapRuntime | null = null;
  let journal: { url: string; drop: () => Promise<void> } | null = null;
  let grant: Grant | null = null;
  // Runtime start-up and grant creation are deployment work, not per-workflow cost: the clock
  // starts once the destination link and (for VAP) the runtime are ready.
  let started = Date.now();
  let deadlineMs = started + ctx.deadlineMs;
  const reports: AgentReport[] = [];
  let restarted = false;
  // Durable local intent log for careful_log: shared by concurrent instances and survives restarts.
  const intentDir = condition === "careful_log" ? mkdtempSync(path.join(tmpdir(), "vap-intent-")) : null;
  try {
    if (condition === "vap") {
      journal = await createDatabase(ctx.adminUrl, "vapdemo");
      runtime = await createVapRuntime({ databaseUrl: journal.url, digestKey: randomBytes(24).toString("hex"), githubApiBaseUrl: proxy.url, githubRepository: REPOSITORY, log: (l) => (/error|fatal/i.test(l) ? log(l) : undefined) });
      await runtime.start();
      const operator = new VapClient({ baseUrl: runtime.apiUrl, token: demoToken("demo-operator") });
      grant = await operator.createGrant({
        principal: "demo-agent",
        allowed_actions: ["github.issues.create_ci_failure"],
        allowed_targets: [`github://${REPOSITORY}/*`],
        risk_ceiling: 3,
        preauthorized_actions: [],
        limits: { max_operations: 10, max_items_per_operation: 1, max_concurrent_operations: 4 },
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
      started = Date.now();
      deadlineMs = started + ctx.deadlineMs;
    }
    const agentRun = (signal: AbortSignal, mutate?: (s: string) => string): Promise<AgentReport> => {
      const env: AgentEnv = { facts, repository: REPOSITORY, deadlineMs, signal, log, mutateErrorOutput: mutate, approve: condition === "vap" ? undefined : async () => {} };
      if (condition === "vap") return runVapAgent(env, { apiUrl: runtime!.apiUrl, grant: grant!, approve: true });
      if (condition === "careful") return runCarefulAgent(env, proxy.url);
      if (condition === "careful_log") return runCarefulAgent(env, proxy.url, { intentDir: intentDir! });
      return runRetryAgent(env, proxy.url);
    };

    if (s.crashOnHold) {
      const first = new AbortController();
      const crash: { done: Promise<void> | null } = { done: null };
      proxy.onHold(() => {
        crash.done ??= (async () => {
          log("create reply held by the destination link; crashing the caller now");
          first.abort();
          if (runtime) await runtime.crash();
        })();
      });
      const r1 = await agentRun(first.signal).catch((e) => {
        if (e instanceof AgentCrash || first.signal.aborted) return null;
        throw e;
      });
      if (r1) reports.push(r1);
      if (crash.done) {
        await crash.done;
        restarted = true;
        await new Promise((r) => setTimeout(r, 300));
        if (runtime) {
          await runtime.start();
          log("runtime restarted");
        }
        log("agent restarted with the same workflow facts");
        reports.push(await agentRun(new AbortController().signal));
      } else notes.push("hold was never reached; no crash happened");
    } else if ((s.instances ?? 1) > 1) {
      const rs = await Promise.all(Array.from({ length: s.instances! }, () => agentRun(new AbortController().signal)));
      reports.push(...rs);
    } else {
      reports.push(await agentRun(new AbortController().signal));
      if (s.changedPayloadRerun) {
        const before = proxy.createCount(wf);
        log("rerunning the same workflow with changed error output");
        reports.push(await agentRun(new AbortController().signal, (e) => `${e}\n(rerun: output differs)`));
        if (proxy.createCount(wf) > before) notes.push("rerun caused another accepted create");
      }
    }
  } finally {
    if (runtime) await runtime.stop().catch(() => {});
    await proxy.close();
    if (journal) await journal.drop().catch(() => {});
    if (intentDir) rmSync(intentDir, { recursive: true, force: true });
  }
  const wall = Date.now() - started;

  // ---------------------------------------------------------------- independent evaluation
  // Let delayed issues surface in the ground truth (it ignores visibility, so this only covers
  // creates still in flight when the agent stopped).
  await new Promise((r) => setTimeout(r, 200));
  const truth = await destinationTruth(ctx, wf);
  const gt: GroundTruthRecord[] = proxy.groundTruth();
  const creates = gt.filter((r) => r.kind === "create_issue");
  const contentValid = truth.issues.length > 0 && truth.issues.every((i) => issueContentValid(i.body, wf, ctx.commit, failingTest));
  const canary = truth.issues.some((i) => i.body.includes("VAPCANARY"));
  const final = reports.slice(-(s.instances ?? 1));
  const judged = s.changedPayloadRerun ? reports : final;
  const completion = (c: Claim) => c === "created" || c === "already_exists";
  const completionClaimed = judged.some((r) => completion(r.claim));
  // A completion claim is false unless the issue it names exists at the destination with valid content.
  const falseCompletion = judged.some((r) => {
    if (!completion(r.claim)) return false;
    const claimed = truth.issues.find((i) => i.number === r.issue_number);
    return !claimed || !issueContentValid(claimed.body, wf, ctx.commit, failingTest);
  });
  const contractHolds = truth.count === 1 && contentValid;
  const completionClaims = judged.filter((r) => completion(r.claim)).length;
  const falseTaskClaims = contractHolds ? 0 : completionClaims;
  const claimsOk = judged.every((r) => s.correctClaims.includes(r.claim));
  const correct = claimsOk && truth.count === s.expectIssues && (s.expectIssues === 0 || contentValid) && !falseCompletion;
  const unknownOk = !!s.unobservable && judged.every((r) => r.claim === "unknown") && truth.count <= 1;
  return {
    scenario: s.id,
    condition,
    run,
    workflow_id: wf,
    reports,
    issues_with_marker: truth.count,
    issue_numbers: truth.issues.map((i) => i.number),
    content_valid: contentValid,
    canary_leaked: canary,
    creates_accepted: creates.filter((r) => r.upstream_status === 201).length,
    create_replies_delivered: creates.filter((r) => r.delivered_to_client).length,
    destination_requests: gt.length,
    correct,
    completion_claimed: completionClaimed,
    false_completion_claim: falseCompletion,
    false_task_success: falseTaskClaims > 0,
    completion_claims: completionClaims,
    false_task_success_claims: falseTaskClaims,
    duplicates: Math.max(0, truth.count - 1),
    unknown_reported_correctly: unknownOk,
    restarted,
    category: correct
      ? s.correctClaims.includes("rejected")
        ? "correctly_rejected"
        : s.correctClaims.includes("unknown")
          ? "safely_unresolved"
          : "completed"
      : judged.every((r) => r.claim === "unknown") && truth.count <= 1 && !falseCompletion
        ? "safely_unresolved"
        : "incorrect",
    origins: judged.map((r) => r.origin),
    fault_fired: faultFired(s, creates),
    recovered_after_restart: s.crashOnHold ? restarted && correct : null,
    human_interventions: reports.filter((r) => r.human_intervention_requested).length,
    approvals: reports.reduce((n, r) => n + r.approvals, 0),
    tool_calls: reports.reduce((n, r) => n + r.tool_calls, 0),
    wall_ms: wall,
    notes,
  };
}

function faultFired(s: Scenario, creates: GroundTruthRecord[]): boolean {
  const lossy = s.proxy.some((r) => r.match === "create_issue" && (r.action === "drop_response_after_commit" || r.action === "hold_response_ms"));
  // Accepted by the destination, reply never delivered to the caller.
  if (lossy) return creates.some((r) => r.fault !== null && r.upstream_status === 201 && !r.delivered_to_client);
  if (s.fixtureFaults?.some((f) => f.mode === "reject")) return creates.some((r) => r.upstream_status === 422);
  return true;
}

