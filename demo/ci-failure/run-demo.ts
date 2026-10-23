// Executable demo: an agent turns a failed build into one verified GitHub issue and resumes
// safely after the create's response is lost and the runtime crashes. Fixture layer.
//
//   node demo/ci-failure/run-demo.ts [--out reports]
//
// Writes ci-demo-transcript.md (sanitized) and ci-demo-receipt.json. Exits non-zero unless the
// real run achieves the whole sequence; nothing in the transcript is scripted text standing in
// for an observation.
import "../../scripts/cloud-guard.ts";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import type { Operation } from "@vap/protocol";
import { demoToken, VapClient } from "@vap/sdk";
import { adminUrl, startHarness } from "../../tests/helpers/harness.ts";
import { issueArgsFrom, issueChecks } from "./lib/agents.ts";
import type { AgentEnv } from "./lib/agents.ts";
import { startFaultProxy } from "./lib/fault-proxy.ts";
import { runTests } from "./lib/run-tests.ts";
import { createVapRuntime } from "./lib/runtime.ts";
import { destinationTruth, issueContentValid, REPOSITORY } from "./lib/scenarios.ts";
import { ACTION_ID, deriveWorkflowId, requestKeyFor } from "./lib/workflow.ts";

const args = process.argv.slice(2);
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : (process.env.VAP_REPORT_DIR ?? "reports");
const COMMIT = process.env.COMMIT_SHA && /^[0-9a-f]{40}$/.test(process.env.COMMIT_SHA) ? process.env.COMMIT_SHA : "0123456789abcdef0123456789abcdef01234567";
const BUILD = process.env.BUILD_ID ?? `local-${Date.now()}`;

const t0 = Date.now();
const lines: string[] = [];
const say = (who: string, msg: string) => {
  const l = `[+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${who.padEnd(9)} ${msg}`;
  lines.push(l);
  process.stdout.write(l + "\n");
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const steps: Record<string, boolean> = {};
const mark = (k: string, ok: boolean) => (steps[k] = ok);

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const h = await startHarness();
  const proxy = await startFaultProxy({ upstream: `${h.fixture.url}/gh`, schedule: [{ match: "create_issue", action: "drop_response_after_commit" }] });
  // The new issue stays invisible to reads for 4 s, so the first reconciliation cannot see it.
  await h.control("/gh/faults", { mode: "delay_visibility", count: 1, delay_ms: 4000 });
  const name = `vapdemo_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const dbUrl = new URL(adminUrl());
  dbUrl.pathname = `/${name}`;
  const runtime = await createVapRuntime({ databaseUrl: dbUrl.toString(), digestKey: randomBytes(24).toString("hex"), githubApiBaseUrl: proxy.url, githubRepository: REPOSITORY });
  let receipt: unknown = null;
  let op: Operation | null = null;
  try {
    say("runtime", "starting VAP API and worker processes");
    await runtime.start();
    mark("start", true);
    const operator = new VapClient({ baseUrl: runtime.apiUrl, token: demoToken("demo-operator") });
    const grant = await operator.createGrant({
      principal: "demo-agent",
      allowed_actions: [ACTION_ID],
      allowed_targets: [`github://${REPOSITORY}/*`],
      risk_ceiling: 3,
      preauthorized_actions: [],
      limits: { max_operations: 5, max_items_per_operation: 1, max_concurrent_operations: 2 },
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    say("operator", `grant ${grant.id}: demo-agent may file CI-failure issues in ${REPOSITORY} (tier 3 needs approval)`);

    let agent = new VapClient({ baseUrl: runtime.apiUrl, token: demoToken("demo-agent") });
    const approver = new VapClient({ baseUrl: runtime.apiUrl, token: demoToken("demo-approver") });
    const tests = await runTests();
    say("agent", `ran "${tests.command}" in the sample project: ${tests.passed} passed, ${tests.failed} failed`);
    const facts = { repository: "vap-demo/sample-project", commit: COMMIT, buildEvent: `${BUILD}/demo` };
    const wf = deriveWorkflowId(facts);
    const key = requestKeyFor(wf);
    const env: AgentEnv = { facts, repository: REPOSITORY, deadlineMs: Date.now() + 60_000, signal: new AbortController().signal, log: () => {} };
    const issueArgs = issueArgsFrom(tests, env, wf);
    say("agent", `failing test "${issueArgs.failing_test}"; workflow id ${wf} (derived from repository, commit, build event, task)`);
    const task = await agent.openTask({ goal: `File one GitHub issue for "${issueArgs.failing_test}" and verify it`, grant_id: grant.id, scope: { actions: [ACTION_ID], resources: [`github://${REPOSITORY}/*`] }, required_checks: issueChecks(REPOSITORY, wf) });
    const plan = await agent.prepare({ task_id: task.id, action_id: ACTION_ID, arguments: issueArgs as unknown as Record<string, unknown> });
    say("agent", `plan ${plan.id} prepared: ${plan.preview.summary}`);
    await approver.decideApproval({ plan_id: plan.id, plan_digest: plan.digest, decision: "approved", note: "demo approval" });
    say("approver", `approved plan ${plan.id} (digest-bound, single use)`);
    const ex = await agent.execute(plan.id, key);
    op = ex.operation;
    say("agent", `operation ${op.id} accepted under request key ${key}; dispatch intent is journaled before the create is sent`);

    for (let i = 0; i < 100 && ["queued", "running"].includes(op.execution_status); i++) {
      await sleep(100);
      op = await agent.getOperation(op.id);
    }
    const rc = await agent.receipt(op.id);
    say("agent", `runtime reports execution=${op.execution_status}, outcome=${op.outcome}; error ${op.error?.code ?? "none"}: ${op.error?.message ?? ""}`);
    say("agent", `retry guidance: ${rc.retry_guidance.disposition} - ${rc.retry_guidance.explanation}`);
    mark("uncertainty_reported", op.execution_status === "unknown" && rc.retry_guidance.disposition === "reconcile_first");
    let r1 = await agent.reconcile(op.id);
    for (let i = 0; i < 10 && r1.resolution === "in_progress"; i++) {
      say("agent", "reconcile: in_progress (the worker holds the operation); waiting");
      await sleep(300);
      r1 = await agent.reconcile(op.id);
    }
    say("agent", `reconcile: ${r1.resolution} (${JSON.stringify(r1.observations[0] ?? {})})`);
    say("agent", "no matching issue is visible yet; absence is not proof, so the agent does not create again");
    mark("no_blind_retry_while_invisible", r1.resolution === "still_unknown");

    say("runtime", "CRASH: SIGKILL to the API and worker processes; the agent process is discarded too");
    await runtime.crash();
    await sleep(500);
    await runtime.start();
    say("runtime", "restarted from the same journal database");
    agent = new VapClient({ baseUrl: runtime.apiUrl, token: demoToken("demo-agent") });
    const resumed = await agent.findOperation(ACTION_ID, requestKeyFor(deriveWorkflowId(facts)));
    say("agent", `new agent instance recomputed workflow ${deriveWorkflowId(facts)} and found operation ${resumed?.id ?? "none"} by request key (${resumed?.execution_status})`);
    mark("resumed_same_operation", resumed?.id === op.id);

    let found = false;
    for (let i = 0; i < 30 && !found; i++) {
      const cur = await agent.getOperation(op.id);
      if (cur.execution_status === "completed") {
        found = true;
        say("agent", `operation already resolved by the worker's reconciliation: issue #${cur.result_summary?.number}`);
        break;
      }
      const r = await agent.reconcile(op.id);
      say("agent", `reconcile: ${r.resolution}`);
      if (r.resolution === "found_applied") found = true;
      else await sleep(1000);
    }
    mark("reconciliation_found_issue", found);
    op = await agent.waitForOperation(op.id, { timeoutMs: 40_000 });
    const evidence = await agent.evidence(op.id);
    for (const e of evidence.filter((x) => x.item_index === null)) say("verifier", `${e.check_id}: ${e.result} from ${e.source} (facts ${JSON.stringify(e.observed_facts)})`);
    say("agent", `final: execution=${op.execution_status}, verification=${op.verification_status}, outcome=${op.outcome}, attempts=${op.attempts}, issue ${op.result_summary?.html_url}`);
    mark("content_verified", op.verification_status === "passed");
    receipt = await agent.receipt(op.id);
  } finally {
    await runtime.stop().catch(() => {});
    await proxy.close();
  }

  // Evaluator, after the run: destination ground truth and the proxy's private records.
  const wf = deriveWorkflowId({ repository: "vap-demo/sample-project", commit: COMMIT, buildEvent: `${BUILD}/demo` });
  const truth = await destinationTruth({ adminUrl: "", fixtureUrl: h.fixture.url, fixtureControlUrl: h.fixture.controlUrl!, commit: COMMIT, buildId: BUILD, deadlineMs: 0, log: () => {} }, wf);
  const gt = proxy.groundTruth().filter((r) => r.kind === "create_issue");
  say("evaluator", `destination ground truth: ${truth.count} issue(s) carry ${wf}: ${truth.issues.map((i) => `#${i.number}`).join(", ")}`);
  say("evaluator", `fault-proxy records: ${gt.length} create request(s); destination answered ${gt.map((r) => r.upstream_status).join(",")}; replies delivered to the runtime: ${gt.filter((r) => r.delivered_to_client).length}`);
  const valid = truth.issues.length === 1 && issueContentValid(truth.issues[0].body, wf, COMMIT, "parses hours with minutes");
  say("evaluator", `content valid (marker, test, commit, steps, sanitized output, no canary): ${valid}`);
  mark("create_accepted_response_lost", gt.length === 1 && gt[0].upstream_status === 201 && !gt[0].delivered_to_client);
  mark("one_matching_issue", truth.count === 1 && valid);
  await h.close();
  const dropper = new pg.Client({ connectionString: adminUrl() });
  await dropper.connect();
  await dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await dropper.end();

  const achieved = Object.values(steps).every(Boolean) && Object.keys(steps).length === 8;
  const md = [
    `# CI-failure demo transcript (fixture layer)`,
    ``,
    `Build ${BUILD}, commit ${COMMIT.slice(0, 12)}. Generated by \`node demo/ci-failure/run-demo.ts\`; every line is an observation from this run. The issue tracker is the synthetic GitHub-compatible fixture; URLs under fixture-github.invalid are not real.`,
    ``,
    "```text",
    ...lines,
    "```",
    ``,
    `## Sequence achieved`,
    ``,
    ...Object.entries(steps).map(([k, v]) => `- ${v ? "[x]" : "[ ]"} ${k}`),
    ``,
    achieved ? "All steps were observed in this run." : "NOT ACHIEVED: at least one step was not observed. Do not present this run as the demo.",
  ];
  writeFileSync(path.join(OUT, "ci-demo-transcript.md"), md.join("\n") + "\n");
  writeFileSync(path.join(OUT, "ci-demo-receipt.json"), JSON.stringify({ steps, receipt, operation: op }, null, 2));
  if (!achieved) process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`demo failed: ${(e as Error).stack}\n`);
  process.exit(1);
});
