#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { VapError } from "@verified-action-protocol/protocol";
import type { Operation, Receipt } from "@verified-action-protocol/protocol";
import { VapClient } from "./client.js";
import { tokenFromEnv } from "./tokens.js";

/**
 * vap: inspection and cloud workflow commands.
 *
 *   vap doctor [--remote]
 *   vap task inspect <task_id> [--json]
 *   vap operation inspect <op_id> [--evidence] [--events] [--json]
 *   vap cloud demo
 *   vap cloud test --suite <unit|integration|browser|all> --commit <sha>
 *   vap cloud deploy --environment staging --image <digest>
 *   vap cloud cleanup --run <run_id>
 *   vap release check --commit <sha>
 *
 * Configuration (non-secret): VAP_URL, VAP_TOKEN_SOURCE, VAP_AUDIENCE, VAP_GCP_PROJECT,
 * VAP_GCP_REGION, or a vap.config.json file (see vap.config.example.json). Cloud commands
 * fail closed when the cloud executor is unavailable; they never fall back to local runs.
 */

interface FileConfig {
  endpoint?: string;
  audience?: string;
  gcp?: { project?: string; region?: string; evidence_bucket?: string };
  timeouts?: { request_ms?: number };
}

function loadFileConfig(): FileConfig {
  const p = process.env.VAP_CONFIG ?? "vap.config.json";
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf8")) as FileConfig;
}

function parseFlags(argv: string[]): { pos: string[]; flags: Record<string, string | true> } {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[k] = next;
        i++;
      } else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const out = (s: string) => process.stdout.write(s + "\n");
const fileCfg = loadFileConfig();

function client(): VapClient {
  const url = process.env.VAP_URL ?? fileCfg.endpoint;
  if (!url) throw new Error("set VAP_URL (or endpoint in vap.config.json)");
  if (!process.env.VAP_AUDIENCE && fileCfg.audience) process.env.VAP_AUDIENCE = fileCfg.audience;
  return new VapClient({ baseUrl: url, token: tokenFromEnv(), timeoutMs: fileCfg.timeouts?.request_ms ?? 60_000, userAgent: "vap-cli/0.1.0-rc.1" });
}

function gcp(): { project: string; region: string; evidenceBucket: string } {
  const project = process.env.VAP_GCP_PROJECT ?? fileCfg.gcp?.project;
  const region = process.env.VAP_GCP_REGION ?? fileCfg.gcp?.region;
  const evidenceBucket = process.env.VAP_EVIDENCE_BUCKET ?? fileCfg.gcp?.evidence_bucket;
  if (!project || project.startsWith("<") || !region || !evidenceBucket || evidenceBucket.startsWith("<")) {
    throw new Error("cloud commands need VAP_GCP_PROJECT, VAP_GCP_REGION and VAP_EVIDENCE_BUCKET from the operator's private configuration; refusing to fall back to local execution");
  }
  return { project, region, evidenceBucket };
}

function run(cmd: string, args: string[], opts: { capture?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (opts.capture) {
      execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => (err ? reject(new Error(`${cmd} failed: ${stderr.trim().slice(0, 500)}`)) : resolve(stdout)));
      return;
    }
    const child = spawn(cmd, args, { stdio: "inherit", windowsHide: true });
    child.on("error", (e) => reject(new Error(`${cmd} could not start: ${e.message}`)));
    child.on("close", (code) => (code === 0 ? resolve("") : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

function badge(o: Operation | Receipt): string {
  const map: Record<string, string> = { verified: "VERIFIED", unknown: "UNKNOWN - reconcile before retry", completed_unverified: "COMPLETED, NOT VERIFIED", verification_failed: "VERIFICATION FAILED", partially_applied: "PARTIALLY APPLIED" };
  return map[o.outcome] ?? o.outcome.toUpperCase();
}

async function operationInspect(id: string, flags: Record<string, string | true>): Promise<void> {
  const c = client();
  const r = await c.receipt(id);
  const evidence = flags.evidence ? await c.evidence(id) : null;
  const events = flags.events ? (await c.events(id, 0, 200)).events : null;
  if (flags.json) {
    out(JSON.stringify({ receipt: r, evidence, events }, null, 2));
    return;
  }
  out(`operation ${r.operation_id}  [${badge(r)}]`);
  out(`  action ${r.action_id}   task ${r.task_id}`);
  out(`  execution=${r.execution_status}  verification=${r.verification_status}  recovery=${r.recovery_status}  unresolved=${r.unresolved}`);
  out(`  retry: ${r.retry_guidance.disposition} - ${r.retry_guidance.explanation}`);
  out("  checks:");
  for (const k of r.checks) out(`    ${k.id}${k.item_index !== null ? `[${k.item_index}]` : ""}: ${k.result}  source=${k.source ?? "-"} version=${k.source_version ?? "null"} evidence=${k.evidence_id ?? "-"}`);
  if (r.checks.length === 0) out("    (none bound)");
  out("  effects:");
  for (const e of r.effects) out(`    ${e.side_effect_id}${e.item_index !== null && e.item_index !== undefined ? `[${e.item_index}]` : ""}: ${e.status} ${e.resource_uri ?? ""} ${e.detail ?? ""}`);
  if (r.unverified_effects.length) {
    out("  not verified:");
    for (const u of r.unverified_effects) out(`    - ${u}`);
  }
  if (evidence) {
    out("  evidence:");
    for (const e of evidence) out(`    ${e.id} ${e.check_id}${e.item_index !== null ? `[${e.item_index}]` : ""} ${e.result} ${e.method} freshness=${e.freshness} independence=${e.independence}${e.limitations.length ? `\n      limitations: ${e.limitations.join("; ")}` : ""}`);
  }
  if (events) {
    out("  events:");
    for (const e of events) out(`    #${e.sequence} ${e.at} ${e.type} by ${e.actor}`);
  }
}

async function taskInspect(id: string, flags: Record<string, string | true>): Promise<void> {
  const c = client();
  const t = await c.getTask(id);
  const o = await c.taskOutcome(id);
  const ops = await c.listOperations({ task_id: id, limit: 100 });
  if (flags.json) {
    out(JSON.stringify({ task: t, outcome: o, operations: ops }, null, 2));
    return;
  }
  out(`task ${t.id} rev ${t.contract_revision}  [${o.verified_complete ? "VERIFIED COMPLETE" : "NOT VERIFIED COMPLETE"}]`);
  out(`  goal: ${t.goal}`);
  for (const k of o.checks) out(`  check ${k.check_id}: ${k.status}${k.operation_id ? ` (op ${k.operation_id})` : ""}`);
  for (const r of o.reasons) out(`  - ${r}`);
  out("  operations:");
  for (const op of ops) out(`    ${op.id} ${op.action_id} [${badge(op)}]`);
}

async function doctor(flags: Record<string, string | true>): Promise<void> {
  const major = Number(process.versions.node.split(".")[0]);
  out(`node ${process.versions.node} ${major === 24 ? "ok" : "(expected Node 24 LTS)"}`);
  out(`VAP_URL ${process.env.VAP_URL || fileCfg.endpoint ? "set" : "not set"}`);
  out(`token source ${process.env.VAP_TOKEN_SOURCE ?? "gcloud (default)"}`);
  let gcloudOk = false;
  try {
    await run("gcloud", ["--version"], { capture: true });
    gcloudOk = true;
  } catch {
    /* reported below */
  }
  out(`gcloud ${gcloudOk ? "available" : "not found"}`);
  const proj = process.env.VAP_GCP_PROJECT ?? fileCfg.gcp?.project;
  out(`cloud project ${proj && !proj.startsWith("<") ? "configured" : "not configured (cloud gates blocked)"}`);
  if (flags.remote) {
    const info = await client().info();
    out(`remote protocol ${info.protocol_version} api ${info.api_version} auth ${info.auth_mode} build ${info.build.version} ${info.build.commit ?? ""}`);
    for (const a of info.adapters) {
      out(`  adapter ${a.id}@${a.version} (${a.provenance})`);
      for (const act of a.actions) out(`    ${act.id} tier ${act.risk_tier} profiles ${act.declared_profiles.join(",")} concurrency=${act.capabilities.concurrency_mode} retry=${act.capabilities.retry_mode}`);
    }
  }
}

function runId(): string {
  return `r${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Builds the source archive of an exact commit with git (never the working tree, never a home
 * directory). No repository code runs locally: the first Cloud Build step validates the archive
 * against the release allowlist and secret scanners. With history, a git bundle of all refs is
 * included so the release pipeline can scan the entire history in the cloud.
 */
async function sourceArchive(commit: string, withHistory = false): Promise<string> {
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error("--commit must be a git commit SHA");
  const dir = path.resolve("release-out");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `source-${commit.slice(0, 12)}.tar.gz`);
  const extra: string[] = [];
  if (withHistory) {
    await run("git", ["bundle", "create", "history.bundle", "--all"]);
    extra.push("--add-file=history.bundle");
  }
  await run("git", ["archive", "--format=tar.gz", ...extra, "-o", file, commit]);
  if (withHistory) await run("git", ["rm", "--cached", "--quiet", "--ignore-unmatch", "history.bundle"]).catch(() => {});
  return file;
}

async function cloudBuild(config: string, substitutions: Record<string, string>, source: string): Promise<string> {
  const { project, region, evidenceBucket } = gcp();
  const subs = Object.entries({ ...substitutions, _EVIDENCE_BUCKET: evidenceBucket }).map(([k, v]) => `${k}=${v}`).join(",");
  const id = (await run("gcloud", ["builds", "submit", source, `--project=${project}`, `--region=${region}`, `--config=${config}`, `--substitutions=${subs}`, "--async", "--format=value(id)"], { capture: true })).trim();
  out(`submitted Cloud Build ${id}; streaming logs`);
  await run("gcloud", ["builds", "log", id, `--project=${project}`, `--region=${region}`, "--stream"]).catch(() => {});
  const desc = JSON.parse(await run("gcloud", ["builds", "describe", id, `--project=${project}`, `--region=${region}`, "--format=json"], { capture: true })) as {
    id: string;
    status: string;
    startTime?: string;
    finishTime?: string;
    results?: { images?: { name: string; digest: string }[] };
  };
  const evidence = {
    cloud_provider: "gcp",
    cloud_run_id: desc.id,
    status: desc.status,
    config,
    substitutions,
    started_at: desc.startTime ?? null,
    finished_at: desc.finishTime ?? null,
    images: desc.results?.images ?? [],
  };
  mkdirSync("release-out/evidence", { recursive: true });
  writeFileSync(`release-out/evidence/${desc.id}.json`, JSON.stringify(evidence, null, 2));
  out(`build ${desc.id} finished: ${desc.status}`);
  if (desc.status !== "SUCCESS") throw new Error(`Cloud Build ${desc.id} ended with ${desc.status}`);
  return desc.id;
}

async function main(): Promise<void> {
  const { pos, flags } = parseFlags(process.argv.slice(2));
  const [a, b, c] = pos;
  if (a === "doctor") return doctor(flags);
  if (a === "task" && b === "inspect" && c) return taskInspect(c, flags);
  if (a === "operation" && b === "inspect" && c) return operationInspect(c, flags);
  if (a === "cloud" && b === "demo") {
    const commit = (await run("git", ["rev-parse", "HEAD"], { capture: true })).trim();
    await cloudBuild("infra/gcp/cloudbuild.demo.yaml", { _RUN_ID: runId(), _COMMIT_SHA: commit }, await sourceArchive(commit));
    return;
  }
  if (a === "cloud" && b === "test") {
    const commit = String(flags.commit ?? "");
    const suite = String(flags.suite ?? "all");
    if (!["unit", "integration", "browser", "all"].includes(suite)) throw new Error("--suite must be unit, integration, browser or all");
    await cloudBuild("infra/gcp/cloudbuild.test.yaml", { _RUN_ID: runId(), _COMMIT_SHA: commit, _SUITE: suite }, await sourceArchive(commit));
    return;
  }
  if (a === "cloud" && b === "deploy") {
    const env = String(flags.environment ?? "");
    const image = String(flags.image ?? "");
    if (env !== "staging") throw new Error("only --environment staging is supported by this release");
    if (!/@sha256:[0-9a-f]{64}$/.test(image)) throw new Error("--image must be an immutable digest reference (...@sha256:...)");
    const commit = (await run("git", ["rev-parse", "HEAD"], { capture: true })).trim();
    await cloudBuild("infra/gcp/cloudbuild.deploy.yaml", { _RUN_ID: runId(), _IMAGE: image, _ENVIRONMENT: env }, await sourceArchive(commit));
    return;
  }
  if (a === "cloud" && b === "cleanup") {
    const id = String(flags.run ?? "");
    if (!/^r[0-9a-z]{6,40}$/.test(id)) throw new Error("--run must be a VAP run id");
    const commit = (await run("git", ["rev-parse", "HEAD"], { capture: true })).trim();
    await cloudBuild("infra/gcp/cloudbuild.cleanup.yaml", { _RUN_ID: id }, await sourceArchive(commit));
    return;
  }
  if (a === "release" && b === "check") {
    const commit = String(flags.commit ?? "");
    await cloudBuild("infra/gcp/cloudbuild.release.yaml", { _RUN_ID: runId(), _COMMIT_SHA: commit }, await sourceArchive(commit, true));
    return;
  }
  out("usage: vap doctor [--remote] | task inspect <id> | operation inspect <id> [--evidence] [--events] | cloud demo | cloud test --suite <s> --commit <sha> | cloud deploy --environment staging --image <digest> | cloud cleanup --run <id> | release check --commit <sha>");
  process.exitCode = 2;
}

main().catch((e: unknown) => {
  if (e instanceof VapError) process.stderr.write(`error ${e.code}: ${e.message} (retry: ${e.retryDisposition})\n`);
  else process.stderr.write(`error: ${(e as Error).message}\n`);
  process.exitCode = 1;
});
