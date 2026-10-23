// Scripted agents for the CI-failure workflow. They are deterministic policies, not models:
//   vap        - condition C policy: files the issue through VAP and resumes by request key
//   careful    - no VAP, competent: marker in the body, scan before create, reconcile by scanning
//                after an ambiguous create, never retries a create blindly
//   retry      - no VAP, conventional: create, retry on network error or 5xx, trust a 2xx
// All three see the same test observations (runTests) and call the same destination through
// the same fault proxy. A model-driven comparison (benchmarks/ci-demo/model.ts) uses the same
// tools and evaluator.
import { open } from "node:fs/promises";
import path from "node:path";
import { redactString } from "@vap/core";
import { VapError } from "@vap/protocol";
import type { Check, Grant, Operation } from "@vap/protocol";
import { demoToken, VapClient } from "@vap/sdk";
import { runTests } from "./run-tests.ts";
import type { TestRun } from "./run-tests.ts";
import { ACTION_ID, deriveWorkflowId, requestKeyFor } from "./workflow.ts";
import type { WorkflowFacts } from "./workflow.ts";

export type Claim = "created" | "already_exists" | "rejected" | "unknown" | "no_failure" | "crashed";

export interface AgentReport {
  agent: string;
  claim: Claim;
  workflow_id: string | null;
  issue_number: number | null;
  issue_url: string | null;
  operation_id: string | null;
  detail: string;
  tool_calls: number;
  approvals: number;
  /** The agent stopped and asked a human to resolve an unknown outcome. */
  human_intervention_requested: boolean;
  /**
   * How the agent knows the issue it names: from the create's own response, inferred from a
   * lookup after an ambiguous create, or found before creating anything.
   */
  origin: "observed_create_response" | "inferred_from_lookup" | "pre_existing" | null;
}

export class AgentCrash extends Error {}

export interface AgentEnv {
  facts: WorkflowFacts;
  repository: string;
  deadlineMs: number;
  signal: AbortSignal;
  log: (line: string) => void;
  /** Overrides the observed test output (used by the changed-payload scenario). */
  mutateErrorOutput?: (s: string) => string;
  /**
   * This demo's approval policy, applied to every condition alike: one approval before each
   * planned create. The no-VAP conditions call it right before their first create; VAP gets
   * the equivalent plan-bound approval from its approver principal. Both are scripted and
   * instantaneous, so human approval latency is not part of any measured time.
   */
  approve?: () => Promise<void>;
}

/** Lookups an agent may spend on an ambiguous create before reporting "unknown" (same as VAP_MAX_RECONCILE_ATTEMPTS). */
export const LOOKUP_BUDGET = 8;
/** Backoff between lookups, shared by every condition: 0.5 s doubling to 4 s. */
export const nextLookupDelay = (d: number) => Math.min(d * 2, 4000);

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new AgentCrash("crashed"));
    const onAbort = () => {
      clearTimeout(t);
      reject(new AgentCrash("crashed"));
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

function checkAlive(signal: AbortSignal): void {
  if (signal.aborted) throw new AgentCrash("crashed");
}

export interface IssueArgs {
  workflow_id: string;
  failing_test: string;
  commit_sha: string;
  repro_steps: string[];
  error_output: string;
  build_ref: string;
}

/** Turns one observed test failure into issue arguments. Agents sanitize before sending. */
export function issueArgsFrom(run: TestRun, env: AgentEnv, workflowId: string): IssueArgs {
  const f = run.failures[0];
  const raw = env.mutateErrorOutput ? env.mutateErrorOutput(f.errorOutput) : f.errorOutput;
  return {
    workflow_id: workflowId,
    failing_test: f.name,
    commit_sha: env.facts.commit,
    repro_steps: [`git checkout ${env.facts.commit}`, "cd demo/ci-failure/sample-project", run.command, `observe the failure of "${f.name}"`],
    error_output: redactString(raw, 6000),
    build_ref: env.facts.buildEvent,
  };
}

const span = (s: string) => "`" + s.replace(/[\r\n]+/g, " ").replace(/`/g, "'") + "`";

export function renderForGithub(a: IssueArgs): { title: string; body: string } {
  // Same layout the VAP adapter renders, so destination content is comparable across conditions.
  const title = `[CI failure] ${a.failing_test} @ ${a.commit_sha.slice(0, 12)}`.slice(0, 256);
  const body = [
    `<!-- vap-workflow-id: ${a.workflow_id} -->`,
    `## Failing test`,
    span(a.failing_test),
    ``,
    `## Commit`,
    span(a.commit_sha),
    ``,
    `## Build`,
    span(a.build_ref),
    ``,
    `## Reproduction steps`,
    a.repro_steps.map((s, i) => `${i + 1}. ${span(s)}`).join("\n"),
    ``,
    `## Error output (sanitized)`,
    "```text",
    a.error_output.replace(/```/g, "ˋˋˋ"),
    "```",
    ``,
    `_Filed by an agent without VAP. Workflow id: ${a.workflow_id}._`,
  ].join("\n");
  return { title, body };
}

function report(agent: string, claim: Claim, o: Partial<AgentReport> & { tool_calls: number }): AgentReport {
  return { agent, claim, workflow_id: null, issue_number: null, issue_url: null, operation_id: null, detail: "", approvals: 0, human_intervention_requested: false, origin: null, ...o };
}

// ------------------------------------------------------------------------------ VAP agent

export interface VapAgentDeps {
  apiUrl: string;
  grant: Grant;
  /** Stand-in for the human approver of tier-3 plans: approves CI-failure issue plans only. */
  approve: boolean;
}

export function issueChecks(repository: string, workflowId: string): Check[] {
  const checks: Check[] = [
    {
      id: "issue.content",
      description: "the saved issue carries the workflow marker, failing test, commit, reproduction steps and sanitized error output, and no secret",
      method: "read_back",
      verifier_id: "github.readback",
      target: `github://${repository}/issues/{result.number}`,
      predicate: {
        op: "all",
        predicates: [
          { op: "eq", path: "/exists", value: true },
          { op: "eq", path: "/workflow_id", value: workflowId },
          { op: "eq", path: "/body_matches_plan", value: true },
          { op: "eq", path: "/title_matches_plan", value: true },
          { op: "eq", path: "/has_failing_test", value: true },
          { op: "eq", path: "/has_commit_sha", value: true },
          { op: "eq", path: "/has_repro_steps", value: true },
          { op: "eq", path: "/has_error_output", value: true },
          { op: "eq", path: "/no_sensitive_material", value: true },
        ],
      },
      freshness: { max_age_seconds: 60 },
      deadline_seconds: 20,
      provenance: "agent",
    },
    {
      id: "issue.unique",
      description: `exactly one issue in ${repository} carries workflow marker ${workflowId}`,
      method: "read_back",
      verifier_id: "github.readback",
      target: `github://${repository}/workflows/${workflowId}`,
      predicate: { op: "eq", path: "/matching_issue_count", value: 1 },
      freshness: { max_age_seconds: 60 },
      deadline_seconds: 20,
      provenance: "agent",
    },
  ];
  return checks;
}

export async function runVapAgent(env: AgentEnv, deps: VapAgentDeps): Promise<AgentReport> {
  let calls = 0;
  let approvals = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    checkAlive(env.signal);
    calls++;
    return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([env.signal, init.signal]) : env.signal });
  };
  const agent = new VapClient({ baseUrl: deps.apiUrl, token: demoToken("demo-agent"), fetchImpl });
  const approver = new VapClient({ baseUrl: deps.apiUrl, token: demoToken("demo-approver"), fetchImpl });

  checkAlive(env.signal);
  calls++;
  const run = await runTests();
  env.log(`tests: ${run.passed} passed, ${run.failed} failed (exit ${run.exitCode})`);
  if (run.failed === 0) return report("vap", "no_failure", { tool_calls: calls, detail: "all tests passed" });
  const wf = deriveWorkflowId(env.facts);
  const key = requestKeyFor(wf);
  const args = issueArgsFrom(run, env, wf);
  env.log(`workflow ${wf}: failing test "${args.failing_test}"`);

  let op = await agent.findOperation(ACTION_ID, key);
  if (op) env.log(`resuming existing operation ${op.id} (${op.execution_status}) found by request key`);
  else {
    const task = await agent.openTask({
      goal: `File one GitHub issue for the failing test "${args.failing_test}" at ${args.commit_sha.slice(0, 12)} and verify it`,
      grant_id: deps.grant.id,
      scope: { actions: [ACTION_ID], resources: [`github://${env.repository}/*`] },
      required_checks: issueChecks(env.repository, wf),
    });
    const plan = await agent.prepare({ task_id: task.id, action_id: ACTION_ID, arguments: args as unknown as Record<string, unknown> });
    env.log(`plan ${plan.id}: ${plan.status}${plan.approval.required ? " (tier 3: human approval required)" : ""}`);
    if (plan.status === "awaiting_approval") {
      if (!deps.approve) return report("vap", "unknown", { workflow_id: wf, tool_calls: calls, detail: "plan awaits human approval", human_intervention_requested: true });
      await approver.decideApproval({ plan_id: plan.id, plan_digest: plan.digest, decision: "approved", note: "CI-failure issue plan approved for the demo repository" });
      approvals++;
      env.log("approval recorded by the approver principal");
    }
    try {
      const r = await agent.execute(plan.id, key);
      op = r.operation;
      env.log(`operation ${op.id} accepted${r.replayed ? " (replayed)" : ""}`);
    } catch (e) {
      if (e instanceof VapError && (e.code === "KEY_REUSE_CONFLICT" || e.code === "OUTCOME_UNKNOWN")) {
        // Another submission under this workflow's key exists (or our own reply was lost): follow it.
        op = await agent.findOperation(ACTION_ID, key);
        if (!op) throw e;
        env.log(`request key already used (${e.code}); following existing operation ${op.id}`);
      } else throw e;
    }
  }

  let delay = 250;
  let lookupDelay = 500;
  for (;;) {
    checkAlive(env.signal);
    const cur: Operation = await agent.getOperation(op!.id);
    const base = { workflow_id: wf, operation_id: cur.id, tool_calls: calls, approvals };
    const issue = { issue_number: typeof cur.result_summary?.number === "number" ? (cur.result_summary.number as number) : null, issue_url: typeof cur.result_summary?.html_url === "string" ? (cur.result_summary.html_url as string) : null };
    if (cur.execution_status === "completed") {
      if (cur.verification_status === "passed") {
        env.log(`verified: issue #${issue.issue_number} (${cur.outcome})`);
        const o = cur.result_summary?.origin;
        const origin = o === "observed_create_response" || o === "inferred_from_lookup" ? o : null;
        return report("vap", "created", { ...base, ...issue, tool_calls: calls, origin, detail: `outcome ${cur.outcome}; origin ${origin ?? "unreported"}` });
      }
      if (cur.verification_status === "failed") return report("vap", "unknown", { ...base, ...issue, tool_calls: calls, detail: "issue exists but verification failed" });
      if (cur.verification_status === "inconclusive") {
        env.log("verification inconclusive; re-running checks");
        const v = await agent.verify(cur.id);
        if (v.operation.verification_status === "passed") continue;
        if (Date.now() > env.deadlineMs) return report("vap", "unknown", { ...base, ...issue, tool_calls: calls, detail: "issue created; verification still inconclusive" });
      }
    } else if (cur.execution_status === "failed" || cur.execution_status === "cancelled") {
      env.log(`destination outcome: ${cur.execution_status} (${cur.error?.code ?? "no code"})`);
      return report("vap", "rejected", { ...base, tool_calls: calls, detail: cur.error?.message ?? cur.execution_status });
    } else if (cur.execution_status === "unknown") {
      env.log(`outcome unknown after attempt ${cur.attempts}; reconciling before any further mutation`);
      const r = await agent.reconcile(cur.id);
      env.log(`reconcile: ${r.resolution}`);
      if (r.resolution === "operator_resolution_required") {
        return report("vap", "unknown", { ...base, tool_calls: calls, detail: "outcome unknown; destination lookup could not establish it; operator resolution requested", human_intervention_requested: true });
      }
    }
    if (Date.now() > env.deadlineMs) return report("vap", "unknown", { ...base, ...issue, tool_calls: calls, detail: `deadline reached with execution ${cur.execution_status}, verification ${cur.verification_status}` });
    if (cur.execution_status === "unknown") {
      // Reconcile on the same backoff the no-VAP agents use for their scans.
      await sleep(lookupDelay, env.signal);
      lookupDelay = nextLookupDelay(lookupDelay);
    } else {
      await sleep(delay, env.signal);
      delay = Math.min(delay * 2, 1000);
    }
  }
}

// ------------------------------------------------------------------------ GitHub client

export interface GhIssue {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  pull_request?: unknown;
}

class GithubTool {
  calls = 0;
  private readonly base: string;
  private readonly repository: string;
  private readonly signal: AbortSignal;
  constructor(base: string, repository: string, signal: AbortSignal) {
    this.base = base;
    this.repository = repository;
    this.signal = signal;
  }
  private async req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown } | { error: string }> {
    checkAlive(this.signal);
    this.calls++;
    try {
      const r = await fetch(`${this.base}/repos/${this.repository}${path}`, {
        method,
        headers: { accept: "application/vnd.github+json", ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(15_000)]),
      });
      const text = await r.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: r.status, json };
    } catch (e) {
      checkAlive(this.signal);
      return { error: (e as Error).message };
    }
  }
  create(title: string, body: string) {
    return this.req("POST", "/issues", { title, body });
  }
  get(n: number) {
    return this.req("GET", `/issues/${n}`);
  }
  async scan(workflowId: string): Promise<GhIssue[] | null> {
    const r = await this.req("GET", "/issues?state=all&sort=created&direction=desc&per_page=100&page=1");
    if ("error" in r || r.status !== 200 || !Array.isArray(r.json)) return null;
    return (r.json as GhIssue[]).filter((i) => !i.pull_request && (i.body ?? "").includes(`<!-- vap-workflow-id: ${workflowId} -->`));
  }
}

function contentOk(i: GhIssue, a: IssueArgs): boolean {
  const b = i.body ?? "";
  return b.includes(a.workflow_id) && b.includes(a.commit_sha) && b.includes(a.failing_test.replace(/`/g, "'")) && a.repro_steps.every((s) => b.includes(s));
}

// ----------------------------------------------------------------- careful agent (no VAP)

export interface CarefulOptions {
  /**
   * Directory for a local, durable intent log (the "careful + intent log" condition). Before
   * creating, the agent atomically records its intent (exclusive create + fsync); an agent that
   * finds an existing intent never creates again and only looks for the issue.
   */
  intentDir?: string;
}

export async function runCarefulAgent(env: AgentEnv, githubBase: string, opts: CarefulOptions = {}): Promise<AgentReport> {
  const name = opts.intentDir ? "careful_log" : "careful";
  const gh = new GithubTool(githubBase, env.repository, env.signal);
  checkAlive(env.signal);
  const run = await runTests();
  const calls = () => gh.calls + 1;
  if (run.failed === 0) return report(name, "no_failure", { tool_calls: calls(), detail: "all tests passed" });
  const wf = deriveWorkflowId(env.facts);
  const args = issueArgsFrom(run, env, wf);
  const { title, body } = renderForGithub(args);
  env.log(`workflow ${wf}: scanning for an existing issue before creating`);
  const existing = await gh.scan(wf);
  if (existing && existing.length > 0) {
    const i = existing[0];
    return report(name, "already_exists", { workflow_id: wf, issue_number: i.number, issue_url: i.html_url, tool_calls: calls(), origin: "pre_existing", detail: `found ${existing.length} existing issue(s) with the marker` });
  }
  let approvals = 0;
  const scanUntilFound = async (why: string): Promise<AgentReport> => {
    let delay = 500;
    for (let i = 0; i < LOOKUP_BUDGET && Date.now() < env.deadlineMs; i++) {
      await sleep(delay, env.signal);
      delay = nextLookupDelay(delay);
      const found = await gh.scan(wf);
      if (found && found.length > 0) {
        const f = found[0];
        return report(name, "created", { workflow_id: wf, issue_number: f.number, issue_url: f.html_url, tool_calls: calls(), approvals, origin: "inferred_from_lookup", detail: `found after ${why} (${found.length} match(es))` });
      }
    }
    return report(name, "unknown", { workflow_id: wf, tool_calls: calls(), approvals, detail: `${why}; no matching issue visible after ${LOOKUP_BUDGET} lookups; not creating`, human_intervention_requested: true });
  };
  if (opts.intentDir) {
    try {
      const fh = await open(path.join(opts.intentDir, `${wf}.intent`), "wx");
      await fh.writeFile(JSON.stringify({ workflow_id: wf, at: new Date().toISOString() }));
      await fh.sync();
      await fh.close();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      env.log("intent already recorded by an earlier or concurrent attempt; looking for the issue instead of creating");
      return scanUntilFound("an earlier create attempt");
    }
  }
  if (env.approve) {
    await env.approve();
    approvals++;
  }
  const r = await gh.create(title, body);
  if (!("error" in r) && r.status === 201) {
    const n = (r.json as GhIssue).number;
    const back = await gh.get(n);
    const ok = !("error" in back) && back.status === 200 && contentOk(back.json as GhIssue, args);
    return report(name, ok ? "created" : "unknown", { workflow_id: wf, issue_number: n, issue_url: (r.json as GhIssue).html_url, tool_calls: calls(), approvals, origin: "observed_create_response", detail: ok ? "created and read back" : "created; readback did not confirm content" });
  }
  if (!("error" in r) && r.status >= 400 && r.status < 500) {
    return report(name, "rejected", { workflow_id: wf, tool_calls: calls(), approvals, detail: `GitHub rejected the create (HTTP ${r.status})` });
  }
  env.log(`create outcome ambiguous (${"error" in r ? r.error : `HTTP ${r.status}`}); scanning for the marker instead of retrying`);
  return scanUntilFound("an ambiguous create");
}

// --------------------------------------------------------------- retry agent (no VAP)

export async function runRetryAgent(env: AgentEnv, githubBase: string): Promise<AgentReport> {
  const gh = new GithubTool(githubBase, env.repository, env.signal);
  checkAlive(env.signal);
  const run = await runTests();
  const calls = () => gh.calls + 1;
  if (run.failed === 0) return report("retry", "no_failure", { tool_calls: calls(), detail: "all tests passed" });
  const wf = deriveWorkflowId(env.facts);
  const args = issueArgsFrom(run, env, wf);
  const { title, body } = renderForGithub(args);
  let approvals = 0;
  if (env.approve) {
    await env.approve();
    approvals++;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await gh.create(title, body);
    if (!("error" in r) && r.status === 201) {
      const i = r.json as GhIssue;
      return report("retry", "created", { workflow_id: wf, issue_number: i.number, issue_url: i.html_url, tool_calls: calls(), approvals, origin: "observed_create_response", detail: `created on attempt ${attempt}` });
    }
    if (!("error" in r) && r.status >= 400 && r.status < 500) return report("retry", "rejected", { workflow_id: wf, tool_calls: calls(), approvals, detail: `HTTP ${r.status}` });
    env.log(`attempt ${attempt} failed (${"error" in r ? r.error : `HTTP ${r.status}`}); retrying`);
    await sleep(500 * attempt, env.signal);
  }
  return report("retry", "unknown", { workflow_id: wf, tool_calls: calls(), approvals, detail: "gave up after 3 attempts" });
}
