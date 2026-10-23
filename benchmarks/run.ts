// Deterministic benchmark harness (spec section 20). Runs only in the cloud test container
// with PostgreSQL. Separates correctness from performance; no model is involved here.
//
//   node benchmarks/run.ts [--repeats 5] [--out benchmark-results]
//
// Part A compares a baseline client (plain HTTP calls with a naive retry on error, success =
// any 2xx) against the VAP path (prepare/execute/reconcile/verify) on identical fixture
// scenarios with fixed fault timings. Ground truth comes from the fixture's authoritative
// state, never from either client's own report.
// Part B measures metadata-path latency (p50/p95) with 10 concurrent clients and a
// 1000-operation journal run. Destination time is reported separately.
// Part C is the model benchmark interface; it reports "not_run" unless a model runner is configured.
import "../scripts/cloud-guard.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { key, ownerCheck, startHarness } from "../tests/helpers/harness.ts";
import type { Harness } from "../tests/helpers/harness.ts";

const args = process.argv.slice(2);
const flag = (name: string, d: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const REPEATS = Number(flag("repeats", "5"));
const OUT = flag("out", process.env.VAP_REPORT_DIR ?? "benchmark-results");

interface Scenario {
  id: string;
  fault: { mode: string; [k: string]: unknown } | null;
  kind: "update_owner" | "batch";
}

const SCENARIOS: Scenario[] = [
  { id: "S1-normal", fault: null, kind: "update_owner" },
  { id: "S2-lost-reply", fault: { mode: "lost_reply", count: 1 }, kind: "update_owner" },
  { id: "S3-5xx-after-commit", fault: { mode: "server_error_after_commit", count: 1 }, kind: "update_owner" },
  { id: "S4-delayed-visibility", fault: { mode: "delay_visibility", count: 1, delay_ms: 1500 }, kind: "update_owner" },
  { id: "S5-validation-reject", fault: { mode: "reject_validation", count: 1 }, kind: "update_owner" },
  { id: "S6-concurrent-edit", fault: null, kind: "update_owner" },
  { id: "S7-partial-batch", fault: { mode: "partial_batch", count: 1, fail_after: 2 }, kind: "batch" },
];

interface RunResult {
  scenario: string;
  condition: "baseline" | "vap";
  repeat: number;
  reported_success: boolean;
  ground_truth_ok: boolean;
  false_success: boolean;
  duplicate_effects: number;
  unintended_effects: number;
  wall_ms: number;
  api_calls: number;
  note: string;
}

async function baselineUpdateOwner(h: Harness, issueId: string, owner: string): Promise<{ ok: boolean; calls: number }> {
  let calls = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    calls++;
    try {
      const res = await fetch(`${h.fixture.url}/issues/${issueId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner }), signal: AbortSignal.timeout(5000) });
      if (res.ok) return { ok: true, calls };
      if (res.status < 500) return { ok: false, calls };
    } catch {
      // naive client: retry once on any transport error
    }
  }
  return { ok: false, calls };
}

async function baselineBatch(h: Harness, items: { title: string; owner: string }[]): Promise<{ ok: boolean; calls: number }> {
  const res = await fetch(`${h.fixture.url}/issues/batch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) });
  return { ok: res.ok, calls: 1 };
}

async function vapUpdateOwner(h: Harness, grantId: string, issueId: string, owner: string): Promise<{ ok: boolean; calls: number; note: string }> {
  let calls = 0;
  const task = await h.agent.openTask({ goal: "bench", grant_id: grantId, scope: { actions: ["issues.*"], resources: ["issue://issue-tracker/*"] }, required_checks: [ownerCheck(owner, `issue://issue-tracker/issues/${issueId}`, { deadline_seconds: 10 })] });
  calls++;
  const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.update_owner", arguments: { issue_id: issueId, owner } });
  calls++;
  const { operation } = await h.agent.execute(plan.id, key("bench"));
  calls++;
  await h.drain();
  let op = await h.agent.getOperation(operation.id);
  calls++;
  if (op.execution_status === "unknown") {
    await h.agent.reconcile(op.id);
    calls++;
    await h.drain();
    op = await h.agent.getOperation(op.id);
    calls++;
  }
  const outcome = await h.agent.taskOutcome(task.id);
  calls++;
  return { ok: outcome.verified_complete, calls, note: `${op.execution_status}/${op.verification_status}` };
}

async function vapBatch(h: Harness, grantId: string, items: { title: string; owner: string }[]): Promise<{ ok: boolean; calls: number; note: string }> {
  const task = await h.agent.openTask({ goal: "bench batch", grant_id: grantId, scope: { actions: ["issues.*"], resources: ["issue://issue-tracker/*"] }, required_checks: [{ ...ownerCheck("bob", "{effect.resource_uri}"), scope: "each_effect" }] });
  const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.batch_create", arguments: { items } });
  const { operation } = await h.agent.execute(plan.id, key("bench"));
  await h.drain();
  const op = await h.agent.getOperation(operation.id);
  const outcome = await h.agent.taskOutcome(task.id);
  return { ok: outcome.verified_complete, calls: 5, note: `${op.execution_status}/${op.verification_status}` };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main(): Promise<void> {
  const h = await startHarness();
  const grant = await h.grant({ preauthorized_actions: ["issues.*"] });
  const results: RunResult[] = [];
  try {
    for (let r = 0; r < REPEATS; r++) {
      for (const s of SCENARIOS) {
        for (const condition of ["baseline", "vap"] as const) {
          await h.control("/faults", { mode: "clear" });
          const t0 = Date.now();
          let reported = false;
          let calls = 0;
          let note = "";
          let truthOk = false;
          let duplicates = 0;
          let unintended = 0;
          if (s.kind === "update_owner") {
            const issue = await h.seedIssue("alice");
            if (s.fault) await h.control("/faults", s.fault);
            if (s.id === "S6-concurrent-edit") {
              const edit = h.control("/independent-edit", { id: issue.id, owner: "carol" });
              if (condition === "baseline") ({ ok: reported, calls } = await baselineUpdateOwner(h, issue.id, "bob"));
              else ({ ok: reported, calls, note } = await vapUpdateOwner(h, grant.id, issue.id, "bob"));
              await edit;
            } else if (condition === "baseline") ({ ok: reported, calls } = await baselineUpdateOwner(h, issue.id, "bob"));
            else ({ ok: reported, calls, note } = await vapUpdateOwner(h, grant.id, issue.id, "bob"));
            await new Promise((res) => setTimeout(res, s.id === "S4-delayed-visibility" ? 1600 : 50));
            const truth = await h.control(`/authoritative/${issue.id}`);
            truthOk = truth.owner === "bob";
            // Each logical update should advance the version once; more means a duplicate write.
            const expectedVersion = s.id === "S6-concurrent-edit" ? 3 : 2;
            duplicates = Math.max(0, truth.version - expectedVersion);
          } else {
            const items = [1, 2, 3, 4].map((i) => ({ title: `Bench batch ${r}-${i}`, owner: "bob" }));
            const before = await h.control("/stats");
            if (s.fault) await h.control("/faults", s.fault);
            if (condition === "baseline") ({ ok: reported, calls } = await baselineBatch(h, items));
            else ({ ok: reported, calls, note } = await vapBatch(h, grant.id, items));
            const after = await h.control("/stats");
            const created = after.issues - before.issues;
            truthOk = created === 4;
            unintended = 0;
            duplicates = Math.max(0, created - 4);
          }
          results.push({
            scenario: s.id,
            condition,
            repeat: r,
            reported_success: reported,
            ground_truth_ok: truthOk,
            false_success: reported && !truthOk,
            duplicate_effects: duplicates,
            unintended_effects: unintended,
            wall_ms: Date.now() - t0,
            api_calls: calls,
            note,
          });
        }
      }
    }

    // Part B: metadata-path latency with 10 concurrent clients, and a 1000-operation journal run.
    await h.control("/faults", { mode: "clear" });
    const task = await h.agent.openTask({ goal: "perf", grant_id: grant.id, scope: { actions: ["issues.*"], resources: ["issue://issue-tracker/*"] }, required_checks: [] });
    const accept: number[] = [];
    const read: number[] = [];
    const opIds: string[] = [];
    const TOTAL = 1000;
    const CONCURRENCY = 10;
    let next = 0;
    const journalStart = Date.now();
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (next < TOTAL) {
          const i = next++;
          const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.create", arguments: { title: `Perf ${i}`, owner: "bob" } });
          let t = performance.now();
          const { operation } = await h.agent.execute(plan.id, key("perf"));
          accept.push(performance.now() - t);
          opIds.push(operation.id);
          t = performance.now();
          await h.agent.getOperation(operation.id);
          read.push(performance.now() - t);
        }
      }),
    );
    const journalAcceptMs = Date.now() - journalStart;
    const dispatchStart = Date.now();
    await h.drain(1000);
    const dispatchMs = Date.now() - dispatchStart;
    const statuses = await h.journal.pool.query("SELECT execution_status, count(*)::int AS n FROM operations WHERE task_id = $1 GROUP BY 1", [task.id]);
    accept.sort((a, b) => a - b);
    read.sort((a, b) => a - b);

    const summary = SCENARIOS.map((s) => {
      const rows = (c: "baseline" | "vap") => results.filter((r) => r.scenario === s.id && r.condition === c);
      const agg = (c: "baseline" | "vap") => {
        const rs = rows(c);
        return {
          runs: rs.length,
          verified_completion: `${rs.filter((r) => r.ground_truth_ok && r.reported_success).length}/${rs.length}`,
          false_success: `${rs.filter((r) => r.false_success).length}/${rs.length}`,
          duplicate_effects: rs.reduce((n, r) => n + r.duplicate_effects, 0),
          mean_wall_ms: Math.round(rs.reduce((n, r) => n + r.wall_ms, 0) / Math.max(1, rs.length)),
          mean_api_calls: +(rs.reduce((n, r) => n + r.api_calls, 0) / Math.max(1, rs.length)).toFixed(1),
        };
      };
      return { scenario: s.id, baseline: agg("baseline"), vap: agg("vap") };
    });

    const report = {
      generated_at: new Date().toISOString(),
      environment: { node: process.version, cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model ?? "unknown", memory_gb: Math.round(os.totalmem() / 2 ** 30), cloud_build_id: process.env.BUILD_ID ?? null, commit: process.env.COMMIT_SHA ?? null },
      repeats: REPEATS,
      fixture_seed: "fixed scenario order, fixed fault timings (see SCENARIOS)",
      correctness: { summary, raw: results },
      performance: {
        concurrency: CONCURRENCY,
        operations: TOTAL,
        accept_latency_ms: { p50: +pct(accept, 50).toFixed(2), p95: +pct(accept, 95).toFixed(2) },
        read_latency_ms: { p50: +pct(read, 50).toFixed(2), p95: +pct(read, 95).toFixed(2) },
        journal_accept_wall_ms: journalAcceptMs,
        dispatch_and_destination_wall_ms: dispatchMs,
        final_statuses: statuses.rows,
        note: "Accept and read latencies are metadata paths (API + journal); destination time is reported separately as dispatch wall time. Bounded defaults are product controls, not SLOs.",
      },
      model_benchmark: { status: "not_run", reason: "no model runner configured in this environment; see benchmarks/model/README.md for the runnable interface" },
    };
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, "benchmark-report.json"), JSON.stringify(report, null, 2));
    const md = [
      "# VAP deterministic benchmark",
      "",
      `Generated ${report.generated_at}; ${REPEATS} repeats; Node ${process.version}; ${report.environment.cpus} vCPU (${report.environment.cpu_model}); Cloud Build ${report.environment.cloud_build_id ?? "n/a"}.`,
      "",
      "| Scenario | Baseline verified | Baseline false success | Baseline duplicates | VAP verified | VAP false success | VAP duplicates |",
      "|---|---|---|---|---|---|---|",
      ...summary.map((s) => `| ${s.scenario} | ${s.baseline.verified_completion} | ${s.baseline.false_success} | ${s.baseline.duplicate_effects} | ${s.vap.verified_completion} | ${s.vap.false_success} | ${s.vap.duplicate_effects} |`),
      "",
      `Metadata path (10 concurrent clients, 1000 operations): accept p50 ${report.performance.accept_latency_ms.p50} ms, p95 ${report.performance.accept_latency_ms.p95} ms; read p50 ${report.performance.read_latency_ms.p50} ms, p95 ${report.performance.read_latency_ms.p95} ms. Dispatch including destination: ${dispatchMs} ms for ${TOTAL} operations.`,
      "",
      "Model benchmark: not run (no model runner configured).",
      "",
    ].join("\n");
    writeFileSync(path.join(OUT, "benchmark-report.md"), md);
    process.stdout.write(md + "\n");
  } finally {
    await h.close();
  }
}

main().catch((e) => {
  process.stderr.write(`benchmark failed: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
