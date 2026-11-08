// CI-failure comparison harness (fixture layer). Runs every scenario for every scripted
// condition N times with identical fault schedules, deadlines and lookup budgets, then judges
// each run from destination ground truth and the fault proxy's private records.
//
//   node benchmarks/ci-demo/run.ts [--repeats 5] [--out reports]
//
// Conditions here are deterministic policies (see demo/ci-failure/lib/agents.ts), not models.
// The model-driven A/B/C comparison is benchmarks/ci-demo/model.ts.
import "../../scripts/cloud-guard.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTests } from "../../demo/ci-failure/lib/run-tests.ts";
import { CONDITIONS, runScenario, SCENARIOS } from "../../demo/ci-failure/lib/scenarios.ts";
import type { Condition, RunRecord, SuiteContext } from "../../demo/ci-failure/lib/scenarios.ts";
import { adminUrl, startHarness } from "../../tests/helpers/harness.ts";

const args = process.argv.slice(2);
const flag = (name: string, d: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const REPEATS = Number(flag("repeats", "5"));
const OUT = flag("out", process.env.VAP_REPORT_DIR ?? "benchmark-results");
const COMMIT = process.env.COMMIT_SHA && /^[0-9a-f]{40}$/.test(process.env.COMMIT_SHA) ? process.env.COMMIT_SHA : "0123456789abcdef0123456789abcdef01234567";

const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const frac = (n: number, d: number) => `${n}/${d}`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const tests = await runTests();
  if (tests.failed !== 1) throw new Error(`sample project should have exactly one failing test, saw ${tests.failed}`);
  const h = await startHarness();
  const ctx: SuiteContext = {
    adminUrl: adminUrl(),
    fixtureUrl: h.fixture.url,
    fixtureControlUrl: h.fixture.controlUrl!,
    commit: COMMIT,
    buildId: process.env.BUILD_ID ?? `local-${Date.now()}`,
    deadlineMs: 45_000,
    log: (l) => process.stdout.write(`${l}\n`),
  };
  const records: RunRecord[] = [];
  try {
    for (const s of SCENARIOS) {
      for (let run = 1; run <= REPEATS; run++) {
        // Interleave conditions within each repeat so drift affects all conditions alike.
        for (const c of CONDITIONS) {
          const r = await runScenario(ctx, s, c, run, tests.failures[0].name);
          records.push(r);
          process.stdout.write(`RESULT ${JSON.stringify({ scenario: r.scenario, condition: r.condition, run: r.run, correct: r.correct, claims: r.reports.map((x) => x.claim), issues: r.issues_with_marker, creates: r.creates_accepted, wall_ms: r.wall_ms })}\n`);
        }
      }
    }
  } finally {
    await h.close();
  }

  // ------------------------------------------------------------------ aggregation
  const by = (c: Condition, scenario?: string) => records.filter((r) => r.condition === c && (scenario === undefined || r.scenario === scenario));
  const summary = CONDITIONS.map((c) => {
    const rs = by(c);
    const crash = rs.filter((r) => r.recovered_after_restart !== null);
    const unobservable = rs.filter((r) => SCENARIOS.find((s) => s.id === r.scenario)?.unobservable);
    const normal = by(c, "S1-normal");
    const kind = (r: RunRecord) => SCENARIOS.find((s) => s.id === r.scenario)!;
    // Denominators: completable = scenarios where the issue can be created and observed;
    // rejection = the destination refuses; unobservable = every lookup fails by construction.
    const completable = rs.filter((r) => kind(r).expectIssues === 1 && !kind(r).unobservable);
    const rejection = rs.filter((r) => kind(r).correctClaims.includes("rejected"));
    const completions = rs.flatMap((r) => (r.category === "completed" ? r.origins : []));
    return {
      condition: c,
      runs: rs.length,
      completable_runs: completable.length,
      completed: completable.filter((r) => r.category === "completed").length,
      rejection_runs: rejection.length,
      correctly_rejected: rejection.filter((r) => r.category === "correctly_rejected").length,
      safely_unresolved: rs.filter((r) => r.category === "safely_unresolved").length,
      safely_unresolved_in_unobservable: unobservable.filter((r) => r.category === "safely_unresolved").length,
      incorrect: rs.filter((r) => r.category === "incorrect").length,
      origin_observed: completions.filter((o) => o === "observed_create_response").length,
      origin_inferred: completions.filter((o) => o === "inferred_from_lookup").length,
      origin_pre_existing: completions.filter((o) => o === "pre_existing").length,
      correct: rs.filter((r) => r.correct).length,
      workflows_with_duplicates: rs.filter((r) => r.duplicates > 0).length,
      duplicate_issues: rs.reduce((n, r) => n + r.duplicates, 0),
      false_completion_claims: rs.filter((r) => r.false_completion_claim).length,
      runs_with_false_task_success: rs.filter((r) => r.false_task_success).length,
      completion_claim_reports: rs.reduce((n, r) => n + r.completion_claims, 0),
      false_task_success_claims: rs.reduce((n, r) => n + r.false_task_success_claims, 0),
      completion_claims: rs.filter((r) => r.completion_claimed).length,
      restart_runs: crash.length,
      recovered_after_restart: crash.filter((r) => r.recovered_after_restart).length,
      unobservable_runs: unobservable.length,
      unknown_reported_correctly: unobservable.filter((r) => r.unknown_reported_correctly).length,
      human_interventions: rs.reduce((n, r) => n + r.human_interventions, 0),
      approvals: rs.reduce((n, r) => n + r.approvals, 0),
      canary_leaks: rs.filter((r) => r.canary_leaked).length,
      tool_calls_median: pct(rs.map((r) => r.tool_calls), 50),
      wall_ms_p50: pct(rs.map((r) => r.wall_ms), 50),
      wall_ms_p95: pct(rs.map((r) => r.wall_ms), 95),
      normal_wall_ms_p50: pct(normal.map((r) => r.wall_ms), 50),
      normal_tool_calls_p50: pct(normal.map((r) => r.tool_calls), 50),
      tokens: "not applicable (scripted policies; no model)",
    };
  });
  const perScenario = SCENARIOS.map((s) => ({
    scenario: s.id,
    title: s.title,
    conditions: Object.fromEntries(
      CONDITIONS.map((c) => {
        const rs = by(c, s.id);
        const n = (k: RunRecord["category"]) => rs.filter((r) => r.category === k).length;
        return [c, { runs: rs.length, completed: n("completed"), correctly_rejected: n("correctly_rejected"), safely_unresolved: n("safely_unresolved"), incorrect: n("incorrect"), correct: frac(rs.filter((r) => r.correct).length, rs.length), duplicates: rs.reduce((n, r) => n + r.duplicates, 0), false_completion: rs.filter((r) => r.false_completion_claim).length, claims: [...new Set(rs.flatMap((r) => r.reports.map((x) => x.claim)))], wall_ms_p50: pct(rs.map((r) => r.wall_ms), 50) }];
      }),
    ),
  }));
  const vapNormal = summary.find((x) => x.condition === "vap")!;
  const carefulNormal = summary.find((x) => x.condition === "careful")!;
  const result = {
    generated_at: new Date().toISOString(),
    build_id: process.env.BUILD_ID ?? null,
    commit: COMMIT,
    repeats: REPEATS,
    environment: { node: process.version, platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length },
    method: "Each scenario runs for each condition with the same fault schedule (test-only fault proxy plus fixture faults), test observations, 45 s deadline and an 8-lookup budget. Judgments use the fixture's ground truth (ignores visibility delays) and the proxy's private records. Conditions are deterministic policies, not models.",
    overhead: {
      note: "VAP overhead in the normal scenario, against the careful no-VAP policy. Every condition takes one scripted, instantaneous approval per planned create (this demo's policy), so approval latency is excluded everywhere. The VAP figure includes the plan, durable journal writes and two read-back checks; the careful policy reads back once and keeps no journal.",
      vap_normal_wall_ms_p50: vapNormal.normal_wall_ms_p50,
      careful_normal_wall_ms_p50: carefulNormal.normal_wall_ms_p50,
      vap_normal_tool_calls_p50: vapNormal.normal_tool_calls_p50,
      careful_normal_tool_calls_p50: carefulNormal.normal_tool_calls_p50,
      vap_runtime_startup_excluded: true,
    },
    summary,
    per_scenario: perScenario,
    records,
  };
  writeFileSync(path.join(OUT, "ci-demo-results.json"), JSON.stringify(result, null, 2));

  const md: string[] = [];
  md.push(`# CI-failure demo: comparison results (fixture layer)`, ``, `Build ${result.build_id ?? "n/a"}, commit ${COMMIT.slice(0, 12)}, ${REPEATS} runs per scenario per condition. Scripted policies, not models.`, ``);
  md.push(`| Condition | Completed (of completable) | Correctly rejected | Safely unresolved | Incorrect | Workflows with duplicates | Extra issues | False task success: runs (of runs with a completion claim) | False task success: reports (of completion reports) | Named issue missing/invalid (API-level) | Recovered after restart | Origin observed / inferred / pre-existing | Approvals | Tool calls p50 | Wall p50 ms | Wall p95 ms |`);
  md.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const x of summary) {
    md.push(`| ${x.condition} | ${frac(x.completed, x.completable_runs)} | ${frac(x.correctly_rejected, x.rejection_runs)} | ${frac(x.safely_unresolved, x.runs)} | ${frac(x.incorrect, x.runs)} | ${frac(x.workflows_with_duplicates, x.runs)} | ${x.duplicate_issues} | ${frac(x.runs_with_false_task_success, x.completion_claims)} | ${frac(x.false_task_success_claims, x.completion_claim_reports)} | ${x.false_completion_claims} | ${frac(x.recovered_after_restart, x.restart_runs)} | ${x.origin_observed} / ${x.origin_inferred} / ${x.origin_pre_existing} | ${x.approvals} | ${x.tool_calls_median} | ${x.wall_ms_p50} | ${x.wall_ms_p95} |`);
  }
  md.push(``, `## Per scenario: completed / correctly rejected / safely unresolved / incorrect (of ${REPEATS}), extra issues`, ``, `| Scenario | ${CONDITIONS.join(" | ")} |`, `|---|${CONDITIONS.map(() => "---").join("|")}|`);
  for (const p of perScenario) md.push(`| ${p.scenario} | ${CONDITIONS.map((c) => { const v = p.conditions[c]; return `${v.completed}/${v.correctly_rejected}/${v.safely_unresolved}/${v.incorrect}${v.duplicates ? `, +${v.duplicates}` : ""}`; }).join(" | ")} |`);
  writeFileSync(path.join(OUT, "ci-demo-results.md"), md.join("\n") + "\n");
  process.stdout.write(md.join("\n") + "\n");
}

main().catch((e) => {
  process.stderr.write(`ci-demo benchmark failed: ${(e as Error).stack}\n`);
  process.exit(1);
});
