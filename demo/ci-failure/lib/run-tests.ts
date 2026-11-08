// Runs the sample project's test suite (node --test, TAP reporter) and extracts failures.
// Every condition in the comparison uses this same tool, so all agents see identical
// observations of the failed build.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SAMPLE_PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../sample-project");

export interface TestFailure {
  name: string;
  /** Raw (unsanitized) diagnostic block from the reporter. */
  errorOutput: string;
}

export interface TestRun {
  exitCode: number | null;
  passed: number;
  failed: number;
  failures: TestFailure[];
  command: string;
  durationMs: number;
}

export function runTests(cwd: string = SAMPLE_PROJECT): Promise<TestRun> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    // Deliberately minimal environment: inheriting NODE_TEST_CONTEXT from an enclosing node --test
    // would switch the child to the v8-serialized reporter and hide every failure.
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap"], { cwd, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      if (out.length < 512 * 1024) out += c.toString("utf8");
    });
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) => {
      // Deterministic observations: no timings, paths relative to the project.
      const r = parseTap(out.split(cwd).join("."));
      resolve({ ...r, exitCode: code, command: "node --test --test-reporter=tap", durationMs: Date.now() - started });
    });
  });
}

/** Minimal TAP 13/14 parser for node:test output: top-level "not ok" lines and their YAML blocks. */
export function parseTap(text: string): { passed: number; failed: number; failures: TestFailure[] } {
  const lines = text.split(/\r?\n/);
  const failures: TestFailure[] = [];
  let passed = 0;
  let failed = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(not ok|ok) \d+ - (.*)$/.exec(lines[i]);
    if (!m) continue;
    const name = m[2].replace(/\s+#.*$/, "").trim();
    if (m[1] === "ok") {
      passed++;
      continue;
    }
    failed++;
    const block: string[] = [];
    if (/^\s+---\s*$/.test(lines[i + 1] ?? "")) {
      for (let j = i + 2; j < lines.length && !/^\s+\.\.\.\s*$/.test(lines[j]); j++) if (!/^\s*duration_ms:/.test(lines[j])) block.push(lines[j].replace(/^ {2}/, ""));
    }
    failures.push({ name, errorOutput: block.join("\n").trim() });
  }
  return { passed, failed, failures };
}
