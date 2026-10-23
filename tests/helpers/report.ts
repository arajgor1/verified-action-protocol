// Collects per-action profile results and writes them for the published conformance report.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type Profile = "core" | "verified" | "recoverable";
const results = new Map<string, Partial<Record<Profile, boolean>>>();
const scenarios: { id: string; passed: boolean; note?: string }[] = [];

export function recordProfile(actionId: string, profile: Profile, passed: boolean): void {
  const r = results.get(actionId) ?? {};
  r[profile] = (r[profile] ?? true) && passed;
  results.set(actionId, r);
}

export function recordScenario(id: string, passed: boolean, note?: string): void {
  scenarios.push({ id, passed, note });
}

export async function writeReport(name: string): Promise<void> {
  const dir = process.env.VAP_REPORT_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `conformance-${name}.json`),
    JSON.stringify({ suite: name, generated_at: new Date().toISOString(), profiles: Object.fromEntries(results), scenarios }, null, 2),
  );
}
