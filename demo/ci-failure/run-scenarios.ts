// Runs every CI-failure scenario for one condition and fails unless each run lands in its
// expected category. Used by the image gate to exercise the API and worker from a release image
// (VAP_DEMO_RUNTIME_ROOT=/app).
//
//   node demo/ci-failure/run-scenarios.ts [--condition vap] [--repeats 1] [--out reports]
import "../../scripts/cloud-guard.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { adminUrl, startHarness } from "../../tests/helpers/harness.ts";
import { runTests } from "./lib/run-tests.ts";
import { runScenario, SCENARIOS } from "./lib/scenarios.ts";
import type { Condition, RunRecord } from "./lib/scenarios.ts";
import { RUNTIME_ROOT } from "./lib/runtime.ts";

const args = process.argv.slice(2);
const opt = (n: string, d: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const CONDITION = opt("condition", "vap") as Condition;
const REPEATS = Number(opt("repeats", "1"));
const OUT = opt("out", process.env.VAP_REPORT_DIR ?? "reports");
const COMMIT = process.env.COMMIT_SHA && /^[0-9a-f]{40}$/.test(process.env.COMMIT_SHA) ? process.env.COMMIT_SHA : "0123456789abcdef0123456789abcdef01234567";

const expected = (s: (typeof SCENARIOS)[number]) => (s.correctClaims.includes("unknown") ? "safely_unresolved" : s.correctClaims.includes("rejected") ? "correctly_rejected" : "completed");

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const tests = await runTests();
  const h = await startHarness();
  const records: RunRecord[] = [];
  try {
    for (const s of SCENARIOS) {
      for (let run = 1; run <= REPEATS; run++) {
        const r = await runScenario(
          { adminUrl: adminUrl(), fixtureUrl: h.fixture.url, fixtureControlUrl: h.fixture.controlUrl!, commit: COMMIT, buildId: process.env.BUILD_ID ?? `manual-${Date.now()}`, deadlineMs: 45_000, log: (l) => process.stdout.write(`${l}\n`) },
          s,
          CONDITION,
          run,
          tests.failures[0].name,
        );
        records.push(r);
        process.stdout.write(`RESULT ${JSON.stringify({ scenario: r.scenario, run, category: r.category, expected: expected(s), fault_fired: r.fault_fired, issues: r.issues_with_marker, origins: r.origins })}\n`);
      }
    }
  } finally {
    await h.close();
  }
  const failures = records.filter((r) => r.category !== expected(SCENARIOS.find((s) => s.id === r.scenario)!) || !r.fault_fired || r.duplicates > 0 || r.false_completion_claim || r.false_task_success);
  writeFileSync(
    path.join(OUT, `scenarios-${CONDITION}.json`),
    JSON.stringify({ condition: CONDITION, runtime_root: RUNTIME_ROOT, commit: COMMIT, build_id: process.env.BUILD_ID ?? null, image: process.env.VAP_GATE_IMAGE ?? null, runs: records.length, failures: failures.length, records }, null, 2),
  );
  process.stdout.write(`scenarios ${CONDITION}: ${records.length - failures.length}/${records.length} in their expected category (runtime from ${RUNTIME_ROOT})\n`);
  if (failures.length > 0) process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`scenario run failed: ${(e as Error).stack}\n`);
  process.exit(1);
});
