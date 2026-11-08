#!/usr/bin/env node
// Writes a sanitized evidence record for a cloud run: build id, commit, command, suite,
// per-artifact checksums and the aggregated test results. It fails (exit 1) when any report in
// the directory shows a failure, even if the step that produced it did not.
import "./cloud-guard.ts";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2] ?? "reports";
const files = readdirSync(dir).filter((f) => statSync(path.join(dir, f)).isFile() && f !== "evidence.json");
const artifacts = files.sort().map((f) => ({
  name: f,
  bytes: statSync(path.join(dir, f)).size,
  sha256: createHash("sha256").update(readFileSync(path.join(dir, f))).digest("hex"),
}));
// Aggregate every test and gate report in the directory. Reaching this step is not enough:
// a step can only be trusted to have failed the build if its exit status propagated, so the
// record is computed from the reports themselves and a failure makes this step fail too.
const failures = [];
const totals = { tests: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0 };
for (const f of files) {
  const text = readFileSync(path.join(dir, f), "utf8");
  if (f.endsWith(".log")) {
    for (const m of text.matchAll(/^ℹ (tests|pass|fail|skipped|cancelled) (\d+)$/gm)) totals[m[1]] += Number(m[2]);
    for (const m of text.matchAll(/^ℹ (fail|cancelled) (\d+)$/gm)) if (Number(m[2]) > 0) failures.push(`${f}: ${m[1]} ${m[2]}`);
    if (/^(release hygiene FAILED|NOT ACHIEVED)/m.test(text)) failures.push(`${f}: gate reported failure`);
  } else if (f.endsWith(".json")) {
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      continue;
    }
    if (f.startsWith("conformance-") && Array.isArray(j.scenarios)) for (const sc of j.scenarios) if (sc.passed === false) failures.push(`${f}: scenario ${sc.id} failed`);
    if (f.startsWith("scenarios-") && typeof j.failures === "number" && j.failures > 0) failures.push(`${f}: ${j.failures} scenario run(s) outside their expected category`);
    if (f === "ci-demo-receipt.json" && j.steps && Object.values(j.steps).some((v) => v !== true)) failures.push(`${f}: demo sequence incomplete`);
  } else if (f === "ci-demo-transcript.md" && text.includes("NOT ACHIEVED")) failures.push(`${f}: demo sequence not achieved`);
}
const record = {
  schema: "vap-evidence-index/0.1",
  cloud_provider: "gcp",
  cloud_run_id: process.env.BUILD_ID ?? null,
  run_id: process.env.VAP_RUN_ID ?? null,
  commit_sha: process.env.COMMIT_SHA ?? null,
  command: `vap cloud test --suite ${process.env.VAP_SUITE ?? "all"} --commit ${process.env.COMMIT_SHA ?? "?"}`,
  image_digest: process.env.VAP_IMAGE_DIGEST ?? null,
  result: failures.length === 0 ? "pass" : "fail",
  test_totals: totals,
  failures,
  finished_at: new Date().toISOString(),
  artifacts,
  reviewer_role: null,
  reviewed_at: null,
  limitations: ["recorded by the pipeline; engineering review fields are filled by the reviewing role"],
};
writeFileSync(path.join(dir, "evidence.json"), JSON.stringify(record, null, 2));
process.stdout.write(JSON.stringify({ evidence: "written", artifacts: artifacts.length, result: record.result, test_totals: totals, failures }) + "\n");
if (failures.length > 0) process.exit(1);
