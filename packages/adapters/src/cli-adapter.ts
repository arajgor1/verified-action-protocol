import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PROTOCOL_VERSION, sha256Digest, VapError } from "@verified-action-protocol/protocol";
import type { ActionDescriptor, Check, Effect, Operation, Plan, RecoveryMode, SideEffect } from "@verified-action-protocol/protocol";
import { redactString } from "@verified-action-protocol/core";
import type {
  Adapter,
  AdapterContext,
  AdapterResult,
  ExecuteContext,
  LookupResult,
  ObserveQuery,
  ObserveResult,
  PrepareResult,
  RecoveryPlanSpec,
  VerifyContext,
  VerifyObservation,
} from "@verified-action-protocol/core";

export type CliArgSpec =
  | { literal: string }
  | { param: string; type: "relative_path"; description?: string }
  | { param: string; type: "string"; max_length?: number; pattern?: string; description?: string; allow_leading_dash?: boolean }
  | { param: string; type: "integer"; minimum?: number; maximum?: number; description?: string };

export interface CliRecipe {
  id: string;
  title: string;
  description?: string;
  /** Absolute path registered by the operator, or "node" for the runtime's own Node binary. */
  executable: string;
  /** Optional script passed as the first argument (absolute after config loading), e.g. a fixture .mjs file. */
  script?: string;
  args: CliArgSpec[];
  timeout_ms?: number;
  max_output_bytes?: number;
  output_parser?: "text" | "json_lines";
  /** Explicit fixture markers that confirm the program is waiting for input. */
  input_markers?: string[];
  side_effects?: SideEffect[];
  plan_ttl_seconds?: number;
}

export interface CliAdapterConfig {
  id: string;
  version: string;
  /** Root under which one directory per operation is created. */
  workspace_root: string;
  /** Optional seed directory copied into each new workspace. */
  template_dir?: string;
  recipes: CliRecipe[];
}

const MAX_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const OP_ID = /^op_[A-Za-z0-9_-]{8,64}$/;
const SUSPECTED_INPUT = /(\[y\/n\]|\(y\/n\)|password\s*:|passphrase|press enter|continue\?|are you sure)/i;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const RESTORE_ACTION = "cli.restore_snapshot";

const WORKSPACE_EFFECT: SideEffect = {
  id: "workspace_files",
  description: "files changed inside the operation's isolated workspace directory",
  class: "local_reversible",
  bounded: true,
};

/** Bounded per-stream capture: keeps the first N bytes and counts the rest. */
class BoundedBuffer {
  private chunks: Buffer[] = [];
  private kept = 0;
  total = 0;
  private tail = "";
  constructor(private readonly max: number) {}
  push(c: Buffer): void {
    this.total += c.length;
    if (this.kept < this.max) {
      const take = c.subarray(0, this.max - this.kept);
      this.chunks.push(take);
      this.kept += take.length;
    }
    this.tail = (this.tail + c.toString("utf8")).slice(-512);
  }
  get truncated(): boolean {
    return this.total > this.kept;
  }
  get recent(): string {
    return this.tail;
  }
  text(): string {
    return redactString(Buffer.concat(this.chunks).toString("utf8").replace(ANSI, ""), this.max);
  }
}

interface ManifestEntry {
  size: number;
  sha256: string;
}
type Manifest = Record<string, ManifestEntry>;

/**
 * Registered-command CLI adapter (spec section 12). Executes only operator-registered
 * recipes with typed arguments through direct process spawning (no shell), inside a
 * per-operation workspace with a scrubbed environment. It is trusted reviewed code, not a
 * hostile-code sandbox, and never answers an input prompt.
 */
export class CliAdapter implements Adapter {
  readonly id: string;
  readonly version: string;
  readonly provenance = "built_in" as const;
  private readonly root: string;
  private readonly descriptors: ActionDescriptor[];

  constructor(private readonly config: CliAdapterConfig) {
    if (!path.isAbsolute(config.workspace_root)) throw new Error("workspace_root must be absolute");
    for (const r of config.recipes) {
      if (r.executable !== "node" && !path.isAbsolute(r.executable)) throw new Error(`recipe ${r.id}: executable must be absolute or "node"`);
      if (r.script !== undefined && !path.isAbsolute(r.script)) throw new Error(`recipe ${r.id}: script must be absolute`);
      if ((r.timeout_ms ?? DEFAULT_TIMEOUT_MS) > MAX_TIMEOUT_MS) throw new Error(`recipe ${r.id}: timeout exceeds the 15 minute operator maximum`);
    }
    this.id = config.id;
    this.version = `${config.version}+cfg.${sha256Digest(config).slice(7, 19)}`;
    this.root = path.resolve(config.workspace_root);
    this.descriptors = [...config.recipes.map((r) => this.describe(r)), this.restoreDescriptor()];
  }

  private inputSchema(r: CliRecipe): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const a of r.args) {
      if ("literal" in a) continue;
      required.push(a.param);
      if (a.type === "relative_path") {
        properties[a.param] = { type: "string", minLength: 1, maxLength: 512, pattern: "^(?!-)(?!/)(?!.*(^|/)\\.\\.?(/|$))[A-Za-z0-9._/-]+$", description: a.description ?? "path relative to the operation workspace" };
      } else if (a.type === "string") {
        properties[a.param] = { type: "string", maxLength: a.max_length ?? 4096, ...(a.pattern ? { pattern: a.pattern } : {}), ...(a.description ? { description: a.description } : {}) };
      } else {
        properties[a.param] = { type: "integer", ...(a.minimum !== undefined ? { minimum: a.minimum } : {}), ...(a.maximum !== undefined ? { maximum: a.maximum } : {}) };
      }
    }
    return { type: "object", additionalProperties: false, required, properties };
  }

  private describe(r: CliRecipe): ActionDescriptor {
    const sideEffects = r.side_effects ?? [WORKSPACE_EFFECT];
    const d: ActionDescriptor = {
      protocol_version: PROTOCOL_VERSION,
      id: r.id,
      title: r.title,
      adapter: { id: this.id, version: this.version },
      input_schema: this.inputSchema(r),
      effect_scope: { resource_template: "workspace://{result.workspace}/", description: "the operation's isolated workspace directory" },
      preconditions: ["executable and argument structure are fixed by the operator-registered recipe"],
      side_effects: sideEffects,
      risk_tier: 1,
      capabilities: {
        state_source: "filesystem",
        concurrency_mode: "none",
        preview_fidelity: "estimate",
        retry_mode: "no_automatic_retry",
        recovery_modes: ["restore_snapshot"],
        verification_methods: ["read_back"],
        attribution_mode: "process_identity",
        execution_isolation: "workspace_directory",
      },
      verifier_ids: ["cli.file", "cli.manifest"],
      recovery_modes: [{ mode: "restore_snapshot", action_id: RESTORE_ACTION, description: "restore the isolated workspace to its pre-operation snapshot; does not reverse effects outside the workspace" }],
      plan_ttl_seconds: r.plan_ttl_seconds ?? 300,
      extensions: { "vap.execution_timeout_ms": Math.min(r.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS) + 5000 },
    };
    if (r.description) d.description = r.description;
    return d;
  }

  private restoreDescriptor(): ActionDescriptor {
    return {
      protocol_version: PROTOCOL_VERSION,
      id: RESTORE_ACTION,
      title: "Restore a workspace snapshot",
      description: "Restores an operation's isolated workspace to the snapshot taken before it ran. Only valid for isolated workspaces with no concurrent external writers.",
      adapter: { id: this.id, version: this.version },
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["source_operation_id"],
        properties: { source_operation_id: { type: "string", pattern: "^op_[A-Za-z0-9_-]{8,64}$" } },
      },
      effect_scope: { resource_template: "workspace://{args.source_operation_id}/", description: "the source operation's workspace" },
      preconditions: ["a pre-operation snapshot exists for the source operation"],
      side_effects: [WORKSPACE_EFFECT],
      risk_tier: 1,
      capabilities: {
        state_source: "filesystem",
        concurrency_mode: "none",
        preview_fidelity: "exact",
        retry_mode: "no_automatic_retry",
        recovery_modes: [],
        verification_methods: ["read_back"],
        attribution_mode: "process_identity",
        execution_isolation: "workspace_directory",
      },
      verifier_ids: ["cli.manifest"],
      recovery_modes: [],
      plan_ttl_seconds: 300,
    };
  }

  manifest(): ActionDescriptor[] {
    return this.descriptors;
  }
  resourcePrefixes(): string[] {
    return ["workspace://"];
  }
  verifierIds(): string[] {
    return ["cli.file", "cli.manifest"];
  }

  private recipe(id: string): CliRecipe {
    const r = this.config.recipes.find((x) => x.id === id);
    if (!r) throw new VapError("NOT_FOUND", `recipe ${id} is not registered`);
    return r;
  }

  private workspaceDir(operationId: string): string {
    if (!OP_ID.test(operationId)) throw new VapError("INVALID_ARGUMENT", "invalid workspace id");
    return path.join(this.root, operationId);
  }

  private snapshotDir(operationId: string): string {
    if (!OP_ID.test(operationId)) throw new VapError("INVALID_ARGUMENT", "invalid workspace id");
    return path.join(this.root, ".snapshots", operationId);
  }

  /** Resolves a workspace-relative path, rejecting traversal, symlinks and special files. */
  async containedPath(workspace: string, rel: string, mustExist: boolean): Promise<string> {
    // A leading "-" would be parsed as an option by the registered program, not as a path.
    if (rel.includes("\0") || rel.startsWith("-") || path.isAbsolute(rel) || rel.split(/[\\/]/).some((s) => s === ".." || s === ".")) {
      throw new VapError("FORBIDDEN", "path escapes the workspace");
    }
    const realRoot = await realpath(workspace);
    const full = path.resolve(realRoot, rel);
    if (full !== realRoot && !full.startsWith(realRoot + path.sep)) throw new VapError("FORBIDDEN", "path escapes the workspace");
    // Every existing component must be a real directory or regular file, never a symlink.
    let cur = realRoot;
    for (const seg of path.relative(realRoot, full).split(path.sep).filter(Boolean)) {
      cur = path.join(cur, seg);
      let st;
      try {
        st = await lstat(cur);
      } catch {
        if (mustExist) throw new VapError("NOT_FOUND", "path does not exist in the workspace");
        break;
      }
      if (st.isSymbolicLink()) throw new VapError("FORBIDDEN", "symlinks are not permitted in workspace paths");
      if (!st.isFile() && !st.isDirectory()) throw new VapError("FORBIDDEN", "device and special files are not permitted");
    }
    return full;
  }

  private async manifestOf(dir: string): Promise<Manifest> {
    const out: Manifest = {};
    const walk = async (d: string, prefix: string, depth: number): Promise<void> => {
      if (depth > 16) return;
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (rel === ".tmp") continue;
        const full = path.join(d, e.name);
        if (e.isSymbolicLink()) {
          out[rel] = { size: -1, sha256: "symlink-not-followed" };
        } else if (e.isDirectory()) {
          await walk(full, rel, depth + 1);
        } else if (e.isFile()) {
          const buf = await readFile(full);
          out[rel] = { size: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
        }
        if (Object.keys(out).length > 5000) return;
      }
    };
    await walk(dir, "", 0);
    return out;
  }

  private diff(operationId: string, before: Manifest, after: Manifest): Effect[] {
    const effects: Effect[] = [];
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const k of keys) {
      const b = before[k];
      const a = after[k];
      if (b && a && b.sha256 === a.sha256) continue;
      effects.push({
        side_effect_id: WORKSPACE_EFFECT.id,
        item_index: null,
        resource_uri: `workspace://${operationId}/${k}`,
        status: "applied",
        source_version: a ? a.sha256.slice(0, 16) : "deleted",
        detail: !b ? "added" : !a ? "deleted" : "modified",
      });
    }
    return effects.slice(0, 1000);
  }

  async observe(q: ObserveQuery, _ctx: AdapterContext): Promise<ObserveResult> {
    const { opId, rel } = this.parseUri(q.resource_uri);
    const ws = this.workspaceDir(opId);
    if (!rel) {
      const m = await this.manifestOf(ws);
      return { source: "cli.manifest", source_version: sha256Digest(m).slice(7, 23), freshness: "fresh", facts: { files: m }, unknowns: [], completeness: "complete" };
    }
    const facts = await this.fileFacts(ws, rel, 16 * 1024);
    return { source: "cli.file", source_version: (facts.sha256 as string | undefined)?.slice(0, 16) ?? null, freshness: "fresh", facts, unknowns: [], completeness: "complete" };
  }

  private parseUri(uri: string): { opId: string; rel: string } {
    const m = /^workspace:\/\/(op_[A-Za-z0-9_-]{8,64})\/(.*)$/.exec(uri);
    if (!m) throw new VapError("NOT_FOUND", "not a workspace resource");
    return { opId: m[1], rel: m[2] };
  }

  private async fileFacts(ws: string, rel: string, maxContent: number): Promise<Record<string, unknown>> {
    let full: string;
    try {
      full = await this.containedPath(ws, rel, true);
    } catch (e) {
      if (e instanceof VapError && e.code === "NOT_FOUND") return { exists: false, path: rel };
      throw e;
    }
    const st = await stat(full);
    if (!st.isFile()) return { exists: true, path: rel, type: "directory" };
    const buf = await readFile(full);
    const text = buf.length <= maxContent && !buf.includes(0) ? buf.toString("utf8") : null;
    return {
      exists: true,
      path: rel,
      type: "file",
      size: buf.length,
      sha256: createHash("sha256").update(buf).digest("hex"),
      content: text === null ? null : redactString(text, maxContent),
      line_count: text === null ? null : text.split("\n").length,
    };
  }

  async prepare(action: ActionDescriptor, args: Record<string, unknown>, _ctx: AdapterContext): Promise<PrepareResult> {
    const canonical = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
    if (action.id === RESTORE_ACTION) {
      const src = String(canonical.source_operation_id);
      try {
        await stat(this.snapshotDir(src));
      } catch {
        throw new VapError("CAPABILITY_UNAVAILABLE", "no snapshot exists for that operation in this worker's workspace store");
      }
      return {
        canonical_arguments: canonical,
        resource_conditions: [],
        preview: { fidelity: "exact", summary: `Restore workspace ${src} to its pre-operation snapshot.`, effects: [{ side_effect_id: WORKSPACE_EFFECT.id, class: "local_reversible", description: WORKSPACE_EFFECT.description, item_count: null }] },
        affected_resources: [`workspace://${src}/`],
        item_count: null,
      };
    }
    const r = this.recipe(action.id);
    const argv = this.argv(r, canonical);
    return {
      canonical_arguments: canonical,
      resource_conditions: [],
      preview: {
        fidelity: "estimate",
        summary: `Run registered recipe ${r.id}: ${r.executable === "node" ? "node" : path.basename(r.executable)} ${argv.map((a) => JSON.stringify(a)).join(" ")} in a fresh isolated workspace (timeout ${Math.min(r.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)} ms). File changes are observed; other process effects are not.`,
        effects: (r.side_effects ?? [WORKSPACE_EFFECT]).map((s) => ({ side_effect_id: s.id, class: s.class, description: s.description, item_count: null })),
      },
      affected_resources: ["workspace://*"],
      item_count: null,
    };
  }

  private argv(r: CliRecipe, args: Record<string, unknown>): string[] {
    const typed = r.args.map((a) => {
      if ("literal" in a) return a.literal;
      const v = args[a.param];
      if (a.type === "integer") {
        if (typeof v !== "number" || !Number.isInteger(v)) throw new VapError("INVALID_ARGUMENT", `${a.param} must be an integer`);
        return String(v);
      }
      if (typeof v !== "string") throw new VapError("INVALID_ARGUMENT", `${a.param} must be a string`);
      if (v.includes("\0")) throw new VapError("INVALID_ARGUMENT", `${a.param} contains NUL`);
      // Option injection: values must not look like options unless the recipe opts in (and then
      // the recipe should place a literal "--" before them).
      if (v.startsWith("-") && (a.type === "relative_path" || !a.allow_leading_dash)) {
        throw new VapError("INVALID_ARGUMENT", `${a.param} must not start with "-"`);
      }
      return v;
    });
    return r.script ? [r.script, ...typed] : typed;
  }

  private async initWorkspace(operationId: string): Promise<string> {
    const ws = this.workspaceDir(operationId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let fresh = false;
    try {
      await stat(ws);
    } catch {
      fresh = true;
    }
    if (fresh) {
      if (this.config.template_dir) await cp(this.config.template_dir, ws, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: false });
      else await mkdir(ws, { recursive: true, mode: 0o700 });
    }
    await mkdir(path.join(ws, ".tmp"), { recursive: true, mode: 0o700 });
    return ws;
  }

  async execute(plan: Plan, ctx: ExecuteContext): Promise<AdapterResult> {
    if (plan.action_id === RESTORE_ACTION) return this.executeRestore(plan, ctx);
    const r = this.recipe(plan.action_id);
    const ws = await this.initWorkspace(ctx.operationId);
    // Validate every path argument against the real workspace before running anything.
    for (const a of r.args) {
      if (!("literal" in a) && a.type === "relative_path") await this.containedPath(ws, String(plan.canonical_arguments[a.param]), false);
    }
    const argv = this.argv(r, plan.canonical_arguments);
    const before = await this.manifestOf(ws);
    const snap = this.snapshotDir(ctx.operationId);
    await rm(snap, { recursive: true, force: true });
    await mkdir(path.dirname(snap), { recursive: true, mode: 0o700 });
    await cp(ws, snap, { recursive: true, dereference: false, verbatimSymlinks: true });

    await ctx.recheck();
    const run = await this.runProcess(r, argv, ws, ctx.signal);
    const after = await this.manifestOf(ws);
    const effects = this.diff(ctx.operationId, before, after);
    const summary: Record<string, unknown> = {
      workspace: ctx.operationId,
      exit_code: run.exitCode,
      signal: run.signal,
      timed_out: run.timedOut,
      aborted: run.aborted,
      input_status: run.inputStatus,
      stdout: run.stdout.text(),
      stderr: run.stderr.text(),
      stdout_bytes_total: run.stdout.total,
      stderr_bytes_total: run.stderr.total,
      output_truncated: run.stdout.truncated || run.stderr.truncated,
      parse_status: run.parseStatus,
      parsed: run.parsed,
      cleanup: run.cleanup,
      files_changed: effects.length,
    };
    const diagnostics = { cleanup: run.cleanup, timed_out: run.timedOut, input_status: run.inputStatus, limitation: "file diffs show observed workspace changes only, not kernel, process or network side effects" };
    if (run.spawnError) {
      return { outcome: "failed", submission: "not_submitted", effects: [], result_summary: summary, external_handle: null, diagnostics, error: new VapError("CAPABILITY_UNAVAILABLE", `registered executable could not be started: ${run.spawnError}`).toBody() };
    }
    if (run.cleanup === "survivors_remain") {
      return {
        outcome: "unknown",
        submission: "submitted",
        effects: [...effects, { side_effect_id: WORKSPACE_EFFECT.id, item_index: null, resource_uri: null, status: "unknown", source_version: null, detail: "processes survived termination and may still change the workspace" }],
        result_summary: summary,
        external_handle: `pgid:${run.pid ?? "?"}`,
        diagnostics,
        error: new VapError("OUTCOME_UNKNOWN", "child processes survived termination; effects are not established. This is an incident.").toBody(),
      };
    }
    const ok = run.exitCode === 0 && !run.timedOut && run.inputStatus === "none" && !run.aborted;
    if (ok) return { outcome: "completed", submission: "submitted", effects, result_summary: summary, external_handle: `pid:${run.pid}`, diagnostics };
    const reason = run.timedOut
      ? "process exceeded its timeout and was terminated"
      : run.inputStatus !== "none"
        ? `process requested input (${run.inputStatus}); VAP never answers prompts`
        : run.aborted
          ? "process was terminated by cancellation"
          : `process exited with code ${run.exitCode}${run.signal ? ` (signal ${run.signal})` : ""}`;
    return {
      outcome: "failed",
      submission: "submitted",
      effects: effects.length > 0 ? effects : [{ side_effect_id: WORKSPACE_EFFECT.id, item_index: null, resource_uri: null, status: "not_applied", source_version: null, detail: "no workspace file changed" }],
      result_summary: summary,
      external_handle: `pid:${run.pid}`,
      diagnostics,
      error: new VapError(run.timedOut ? "LIMIT_EXCEEDED" : "INVALID_ARGUMENT", reason, { retry: "do_not_retry" }).toBody(),
    };
  }

  private runProcess(r: CliRecipe, argv: string[], cwd: string, signal: AbortSignal) {
    const timeout = Math.min(r.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxOut = r.max_output_bytes ?? DEFAULT_OUTPUT_BYTES;
    const stdout = new BoundedBuffer(maxOut);
    const stderr = new BoundedBuffer(maxOut);
    const exe = r.executable === "node" ? process.execPath : r.executable;
    return new Promise<{
      exitCode: number | null;
      signal: string | null;
      timedOut: boolean;
      aborted: boolean;
      inputStatus: "none" | "input_required" | "suspected_input_required";
      stdout: BoundedBuffer;
      stderr: BoundedBuffer;
      parseStatus: "parsed" | "unparsed" | "not_applicable";
      parsed: unknown[] | null;
      cleanup: "clean" | "terminated" | "survivors_remain";
      pid: number | undefined;
      spawnError: string | null;
    }>((resolve) => {
      let timedOut = false;
      let aborted = false;
      let inputStatus: "none" | "input_required" | "suspected_input_required" = "none";
      let terminated = false;
      const child = spawn(exe, argv, {
        cwd,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: cwd, TMPDIR: path.join(cwd, ".tmp"), LANG: "C.UTF-8" },
        // A new process group so the whole tree can be signalled and checked afterwards.
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
      const pid = child.pid;
      const killGroup = (sig: NodeJS.Signals) => {
        if (pid === undefined) return;
        try {
          process.kill(-pid, sig);
        } catch {
          try {
            child.kill(sig);
          } catch {
            /* already gone */
          }
        }
      };
      const terminate = () => {
        if (terminated) return;
        terminated = true;
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), 2000).unref();
      };
      const detectInput = () => {
        if (inputStatus !== "none") return;
        const recent = stdout.recent + "\n" + stderr.recent;
        if ((r.input_markers ?? ["VAP_INPUT_REQUIRED"]).some((m) => recent.includes(m))) inputStatus = "input_required";
        else if (SUSPECTED_INPUT.test(recent.slice(-200))) inputStatus = "suspected_input_required";
        if (inputStatus !== "none") terminate();
      };
      child.stdout.on("data", (c: Buffer) => {
        stdout.push(c);
        detectInput();
      });
      child.stderr.on("data", (c: Buffer) => {
        stderr.push(c);
        detectInput();
      });
      // stdin stays open and is never written: prompts are detected, not answered.
      child.stdin.on("error", () => {});
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeout);
      const onAbort = () => {
        aborted = true;
        terminate();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      let spawnError: string | null = null;
      child.on("error", (e) => {
        spawnError = (e as NodeJS.ErrnoException).code ?? "spawn failed";
      });
      child.on("close", async (code, sig) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        child.stdin.destroy();
        // Children that outlived the parent are still in the process group.
        let cleanup: "clean" | "terminated" | "survivors_remain" = terminated ? "terminated" : "clean";
        if (pid !== undefined && groupAlive(pid)) {
          killGroup("SIGTERM");
          await delay(500);
          if (groupAlive(pid)) {
            killGroup("SIGKILL");
            await delay(500);
          }
          cleanup = groupAlive(pid) ? "survivors_remain" : "terminated";
        }
        let parseStatus: "parsed" | "unparsed" | "not_applicable" = "not_applicable";
        let parsed: unknown[] | null = null;
        if (r.output_parser === "json_lines") {
          try {
            parsed = stdout
              .text()
              .split("\n")
              .filter((l) => l.trim())
              .slice(0, 200)
              .map((l) => JSON.parse(l) as unknown);
            parseStatus = stdout.truncated ? "unparsed" : "parsed";
            if (stdout.truncated) parsed = null;
          } catch {
            parseStatus = "unparsed";
            parsed = null;
          }
        }
        resolve({ exitCode: code, signal: sig, timedOut, aborted, inputStatus, stdout, stderr, parseStatus, parsed, cleanup, pid, spawnError });
      });
    });
  }

  private async executeRestore(plan: Plan, ctx: ExecuteContext): Promise<AdapterResult> {
    const src = String(plan.canonical_arguments.source_operation_id);
    const ws = this.workspaceDir(src);
    const snap = this.snapshotDir(src);
    try {
      await stat(snap);
    } catch {
      return { outcome: "failed", submission: "not_submitted", effects: [], result_summary: null, external_handle: null, error: new VapError("CAPABILITY_UNAVAILABLE", "snapshot is no longer available").toBody() };
    }
    const before = await this.manifestOf(ws);
    await ctx.recheck();
    await rm(ws, { recursive: true, force: true });
    await cp(snap, ws, { recursive: true, dereference: false, verbatimSymlinks: true });
    const after = await this.manifestOf(ws);
    const effects = this.diff(src, before, after);
    return {
      outcome: "completed",
      submission: "submitted",
      effects: effects.length > 0 ? effects : [{ side_effect_id: WORKSPACE_EFFECT.id, item_index: null, resource_uri: `workspace://${src}/`, status: "not_applied", source_version: null, detail: "workspace already matched the snapshot" }],
      result_summary: { workspace: src, restored_files: effects.length, manifest_digest: sha256Digest(after) },
      external_handle: `restore:${src}`,
    };
  }

  async lookup(operation: Operation, _plan: Plan, _ctx: AdapterContext): Promise<LookupResult> {
    // A local process cannot be looked up after its worker died; report what the workspace
    // shows, but never claim a definitive answer.
    const observations: Record<string, unknown>[] = [];
    try {
      const before = await this.manifestOf(this.snapshotDir(operation.id));
      const after = await this.manifestOf(this.workspaceDir(operation.id));
      observations.push({ observed_workspace_changes: this.diff(operation.id, before, after).length });
    } catch {
      observations.push({ note: "workspace is not available on this worker" });
    }
    return { status: "unknown", definitive: false, effects: [], result_summary: null, external_handle: null, observations };
  }

  async verify(check: Check, ctx: VerifyContext): Promise<VerifyObservation> {
    const { opId, rel } = this.parseUri(ctx.target);
    const ws = this.workspaceDir(opId);
    if (check.verifier_id === "cli.manifest") {
      const m = await this.manifestOf(ws);
      return {
        facts: { manifest_digest: sha256Digest(m), file_count: Object.keys(m).length, files: Object.fromEntries(Object.entries(m).slice(0, 200).map(([k, v]) => [k, v.sha256.slice(0, 16)])) },
        source: "cli.manifest",
        source_version: sha256Digest(m).slice(7, 23),
        freshness: "fresh",
        method: "read_back",
        limitations: ["manifest covers files inside the workspace only"],
      };
    }
    if (check.verifier_id !== "cli.file") throw new VapError("CAPABILITY_UNAVAILABLE", `verifier ${check.verifier_id} is not provided by ${this.id}`);
    const facts = await this.fileFacts(ws, rel, 64 * 1024);
    const version = typeof facts.sha256 === "string" ? facts.sha256.slice(0, 16) : null;
    return {
      facts,
      source: "cli.file",
      source_version: version,
      freshness: ctx.expectedVersion === null || ctx.expectedVersion === version ? "fresh" : "unknown",
      method: "read_back",
      limitations: ["reads the persisted file from the workspace; does not observe process or network effects"],
    };
  }

  async recover(operation: Operation, _plan: Plan, strategy: RecoveryMode, _ctx: AdapterContext): Promise<RecoveryPlanSpec> {
    if (strategy !== "restore_snapshot") throw new VapError("CAPABILITY_UNAVAILABLE", "only restore_snapshot is supported for CLI recipes");
    const snapManifest = await this.manifestOf(this.snapshotDir(operation.id)).catch(() => null);
    if (!snapManifest) throw new VapError("CAPABILITY_UNAVAILABLE", "no snapshot is available for this operation");
    return {
      action_id: RESTORE_ACTION,
      arguments: { source_operation_id: operation.id },
      covered_effects: operation.effects.filter((e) => e.status === "applied"),
      uncovered_effects: ["effects outside the isolated workspace (processes, network, external services) are not reversed by snapshot restoration"],
      checks: [
        {
          id: "workspace_matches_snapshot",
          description: "workspace manifest equals the pre-operation snapshot",
          method: "read_back",
          verifier_id: "cli.manifest",
          target: `workspace://${operation.id}/`,
          predicate: { op: "eq", path: "/manifest_digest", value: sha256Digest(snapManifest) },
          freshness: { max_age_seconds: 3600 },
          deadline_seconds: 10,
        },
      ],
    };
  }
}

/**
 * True while any non-zombie process remains in the group. On Linux /proc is consulted so
 * that exited-but-unreaped children (common when Node runs as PID 1 without an init) are
 * not mistaken for survivors; elsewhere a signal-0 probe is used.
 */
function groupAlive(pgid: number): boolean {
  try {
    let found = false;
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let stat: string;
      try {
        stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      } catch {
        continue;
      }
      // Fields after the parenthesised command name: state ppid pgrp ...
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(rest[2]) === pgid && rest[0] !== "Z" && rest[0] !== "X") {
        found = true;
        break;
      }
    }
    return found;
  } catch {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

