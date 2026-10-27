import { createSign } from "node:crypto";
import { PROTOCOL_VERSION, sha256Digest, VapError } from "@verified-action-protocol/protocol";
import type { ActionDescriptor, Check, Effect, Operation, Plan, RecoveryMode } from "@verified-action-protocol/protocol";
import { containsSensitiveMaterial, matchUriTemplate, redactString, registerSensitiveValue } from "@verified-action-protocol/core";
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
import { parseOrigin, safeRequest, SafeRequestError } from "./net.js";
import type { NetworkPolicy, SafeResponse } from "./net.js";

/**
 * GitHub issues adapter for the "failed build -> one verified issue" workflow. It speaks the
 * GitHub REST API (and the fixture's compatible /gh subset). GitHub offers no request
 * deduplication and no sealed lookup, so the adapter:
 *  - writes a non-secret workflow marker (`<!-- vap-workflow-id: vapwf-... -->`) into the body;
 *  - after a lost reply, scans the repository's issues for that marker; a match is "applied",
 *    no match is "unknown" (never a definitive "not applied": the issue may not be visible yet);
 *  - declares retry_mode no_automatic_retry, so the core never resubmits on its own.
 * This narrows, but does not eliminate, duplicate risk: a create whose effect is invisible to
 * every lookup until after a human resolves the operation can still be duplicated by that human.
 */

export const WORKFLOW_ID_PATTERN = /^vapwf-[0-9a-f]{24}$/;
// The marker must be the first line of the body; a marker quoted elsewhere does not count.
const MARKER_RE = /^<!-- vap-workflow-id: (vapwf-[0-9a-f]{24}) -->\n/;
const ACTION_ID = "github.issues.create_ci_failure";
const BASE_VERSION = "0.1.0";
const MAX_ERROR_OUTPUT = 6000;

export type GithubAuthConfig =
  | { type: "none" }
  | { type: "bearer_env"; env: string }
  | { type: "github_app"; app_id_env: string; installation_id_env: string; private_key_env: string };

export interface GithubAdapterConfig {
  id: string;
  /** API base URL, e.g. https://api.github.com or http://127.0.0.1:8081/gh for the fixture. */
  api_base_url: string;
  /** "owner/repo". The adapter never touches any other repository. */
  repository: string;
  auth: GithubAuthConfig;
  /** Honoured only in isolated test mode (synthetic fixture). */
  allow_private_network?: boolean;
  timeout_ms?: number;
  /** Bounds the marker scan: pages of up to 100 issues, newest first. */
  lookup_max_pages?: number;
  /**
   * Issues not updated within this window before the operation are not scanned (GitHub's
   * "since" filters on update time, not creation time).
   */
  lookup_window_seconds?: number;
  /**
   * Login of the identity the adapter authenticates as (for a GitHub App, "<app-slug>[bot]").
   * Required: only issues authored by it can satisfy a lookup, and listings use creator=.
   */
  author_login: string;
  /**
   * Tolerated clock difference between the runtime and GitHub when checking that a candidate
   * issue was created after the operation was accepted (default 60 s).
   */
  clock_skew_seconds?: number;
}

/**
 * How the adapter knows the issue it reports. "observed_create_response": GitHub's reply to this
 * operation's create named the issue. "inferred_from_lookup": after a lost reply, an issue was
 * found in the expected repository, authored by the adapter's identity, carrying the workflow
 * marker and the planned title and body, created after the operation was accepted. That shows
 * the required issue exists; it does not prove this operation created it, because GitHub keeps
 * no request identifier and another actor using the same identity could file the same content.
 */
export type IssueOrigin = "observed_create_response" | "inferred_from_lookup";

export const ORIGIN_NOTE: Record<IssueOrigin, string> = {
  observed_create_response: "GitHub's response to this operation's create request named this issue",
  inferred_from_lookup:
    "found after a lost reply: expected repository, adapter identity, workflow marker, planned title and body, created after acceptance; creation by this operation is consistent with but not proven by that evidence",
};

export interface GithubAdapterOptions {
  isolatedTestMode?: boolean;
  env?: Record<string, string | undefined>;
}

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
  user?: { login?: string } | null;
  repository_url?: string;
}

export interface CiFailureArgs {
  workflow_id: string;
  failing_test: string;
  commit_sha: string;
  repro_steps: string[];
  error_output: string;
  build_ref: string;
}

/** Removes ANSI escapes, secret-looking values and fence breakers; bounds the length. */
export function sanitizeErrorOutput(raw: string): string {
  const noAnsi = stripControls(raw.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)?/g, "").replace(/\r\n?/g, "\n"));
  const scrubbed = redactString(noAnsi, MAX_ERROR_OUTPUT).replace(/```/g, "ˋˋˋ");
  return scrubbed.replace(/[^\S\n]+$/gm, "").trim();
}

/** Removes C0/C1 control characters (except newline and tab) and bidirectional overrides. */
export function stripControls(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

/** One line of untrusted text rendered as an inline code span: no newlines, mentions or HTML take effect. */
function codeSpan(s: string): string {
  return "`" + stripControls(s).replace(/[\r\n]+/g, " ").replace(/`/g, "'") + "`";
}

export function renderIssue(a: CiFailureArgs): { title: string; body: string } {
  const title = stripControls(`[CI failure] ${a.failing_test} @ ${a.commit_sha.slice(0, 12)}`).replace(/[\r\n]+/g, " ").slice(0, 256);
  const steps = a.repro_steps.map((s, i) => `${i + 1}. ${codeSpan(s)}`).join("\n");
  const body = [
    `<!-- vap-workflow-id: ${a.workflow_id} -->`,
    `## Failing test`,
    codeSpan(a.failing_test),
    ``,
    `## Commit`,
    codeSpan(a.commit_sha),
    ``,
    `## Build`,
    codeSpan(a.build_ref),
    ``,
    `## Reproduction steps`,
    steps,
    ``,
    `## Error output (sanitized)`,
    "```text",
    a.error_output,
    "```",
    ``,
    `_Filed by an agent through VAP. Workflow id: ${a.workflow_id}._`,
  ].join("\n");
  return { title, body };
}

export function parseRepository(r: string): { owner: string; repo: string } {
  const m = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(r);
  if (!m) throw new Error(`repository ${r} must be owner/repo`);
  return { owner: m[1], repo: m[2] };
}

export class GithubAdapter implements Adapter {
  readonly id: string;
  readonly version: string;
  readonly provenance = "built_in" as const;
  private readonly origin: string;
  private readonly prefix: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly env: Record<string, string | undefined>;
  private readonly descriptor: ActionDescriptor;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: GithubAdapterConfig,
    private readonly opts: GithubAdapterOptions = {},
  ) {
    const u = new URL(config.api_base_url);
    if (u.search || u.hash || u.username || u.password) throw new Error("api_base_url must not contain a query, fragment or credentials");
    this.origin = parseOrigin(`${u.protocol}//${u.host}`).origin;
    // Credentials never travel over plain HTTP, except to a private synthetic destination in
    // isolated test mode (the fixture, or the test-only fault proxy on loopback).
    if (u.protocol !== "https:" && !(config.allow_private_network === true && opts.isolatedTestMode === true)) {
      throw new Error("api_base_url must use https outside isolated test mode");
    }
    this.prefix = u.pathname.replace(/\/+$/, "");
    const r = parseRepository(config.repository);
    this.owner = r.owner;
    this.repo = r.repo;
    if (typeof config.author_login !== "string" || !/^[A-Za-z0-9[\]_-]{1,60}$/.test(config.author_login)) {
      throw new Error("author_login (the identity the adapter authenticates as) is required");
    }
    this.env = opts.env ?? process.env;
    this.id = config.id;
    this.version = `${BASE_VERSION}+cfg.${sha256Digest({ ...config }).slice(7, 19)}`;
    const a = config.auth;
    if (a.type === "bearer_env") registerSensitiveValue(this.env[a.env]);
    if (a.type === "github_app") {
      registerSensitiveValue(this.env[a.private_key_env]);
      registerSensitiveValue(this.env[a.private_key_env]?.replace(/\\n/g, "\n"));
    }
    this.descriptor = this.describe();
  }

  private get repoUri(): string {
    return `github://${this.owner}/${this.repo}/`;
  }

  private describe(): ActionDescriptor {
    return {
      protocol_version: PROTOCOL_VERSION,
      id: ACTION_ID,
      title: "File one GitHub issue for a failed CI test",
      description:
        "Creates an issue with the failing test, commit, reproduction steps and sanitized error output. The body carries a non-secret workflow marker used to find the issue after a lost reply.",
      adapter: { id: this.id, version: this.version },
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["workflow_id", "failing_test", "commit_sha", "repro_steps", "error_output", "build_ref"],
        properties: {
          workflow_id: { type: "string", pattern: "^vapwf-[0-9a-f]{24}$" },
          failing_test: { type: "string", minLength: 1, maxLength: 300, pattern: "^[^\\r\\n]+$" },
          commit_sha: { type: "string", pattern: "^[0-9a-f]{7,40}$" },
          repro_steps: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1, maxLength: 500, pattern: "^[^\\r\\n]+$" } },
          error_output: { type: "string", maxLength: 65536 },
          build_ref: { type: "string", minLength: 1, maxLength: 200, pattern: "^[^\\r\\n]+$" },
        },
      },
      effect_scope: { resource_template: `github://${this.owner}/${this.repo}/issues/{result.number}`, description: `one new issue in ${this.config.repository}` },
      preconditions: [],
      side_effects: [
        { id: "issue_created", description: "a new issue exists in the repository (can be closed, not deleted, by the app)", class: "compensable", bounded: true },
        { id: "watcher_notifications", description: "GitHub may notify repository watchers; notifications cannot be recalled", class: "irreversible", bounded: true },
      ],
      risk_tier: 3,
      capabilities: {
        // Issue reads by number are usually immediate, but listings (the marker scan) lag.
        state_source: "eventually_consistent_api",
        concurrency_mode: "none",
        preview_fidelity: "exact",
        retry_mode: "no_automatic_retry",
        recovery_modes: [],
        verification_methods: ["read_back"],
        attribution_mode: "explicit_request_id",
        execution_isolation: "none",
      },
      verifier_ids: ["github.readback"],
      recovery_modes: [],
      plan_ttl_seconds: 900,
      limits: { max_items: 1 },
    };
  }

  manifest(): ActionDescriptor[] {
    return [this.descriptor];
  }

  resourcePrefixes(): string[] {
    return [this.repoUri];
  }

  verifierIds(): string[] {
    return ["github.readback"];
  }

  // ------------------------------------------------------------------ transport and auth

  private policy(): NetworkPolicy {
    return { allowPrivateNetwork: this.config.allow_private_network === true, isolatedTestMode: this.opts.isolatedTestMode === true };
  }

  private async authHeader(signal: AbortSignal): Promise<Record<string, string>> {
    const a = this.config.auth;
    if (a.type === "none") return {};
    if (a.type === "bearer_env") {
      const v = this.env[a.env];
      if (!v) throw new VapError("UNAVAILABLE", "GitHub credential is not configured in this deployment");
      return { authorization: `Bearer ${v}` };
    }
    if (this.token && this.token.expiresAt - Date.now() > 5 * 60_000) return { authorization: `Bearer ${this.token.value}` };
    const appId = this.env[a.app_id_env];
    const installation = this.env[a.installation_id_env];
    const key = this.env[a.private_key_env];
    if (!appId || !installation || !key || !/^\d{1,20}$/.test(installation)) throw new VapError("UNAVAILABLE", "GitHub App credentials are not configured in this deployment");
    const jwt = appJwt(appId, key);
    registerSensitiveValue(jwt);
    const res = await this.raw("POST", `/app/installations/${installation}/access_tokens`, undefined, { authorization: `Bearer ${jwt}` }, signal);
    const body = res.json as { token?: unknown; expires_at?: unknown } | null;
    if (res.status !== 201 || typeof body?.token !== "string") throw new VapError("UNAVAILABLE", `GitHub App token exchange failed (HTTP ${res.status})`);
    registerSensitiveValue(body.token);
    this.token = { value: body.token, expiresAt: typeof body.expires_at === "string" ? Date.parse(body.expires_at) : Date.now() + 30 * 60_000 };
    return { authorization: `Bearer ${this.token.value}` };
  }

  private raw(method: string, path: string, body: unknown, headers: Record<string, string>, signal: AbortSignal): Promise<SafeResponse> {
    return safeRequest({
      origin: this.origin,
      method,
      path: this.prefix + path,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "vap-github-adapter/0.1",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: this.config.timeout_ms ?? 15_000,
      maxResponseBytes: 2 * 1024 * 1024,
      signal,
      policy: this.policy(),
    });
  }

  private async send(method: string, path: string, body: unknown, signal: AbortSignal): Promise<SafeResponse> {
    return this.raw(method, path, body, await this.authHeader(signal), signal);
  }

  private issuesPath(): string {
    return `/repos/${this.owner}/${this.repo}/issues`;
  }

  private issueUri(n: number): string {
    return `${this.repoUri}issues/${n}`;
  }

  // ------------------------------------------------------------------ reads

  private async readIssue(n: number, signal: AbortSignal): Promise<{ status: number; issue: GhIssue | null }> {
    let res: SafeResponse;
    try {
      res = await this.send("GET", `${this.issuesPath()}/${n}`, undefined, signal);
    } catch (e) {
      if (e instanceof SafeRequestError) throw new VapError("DESTINATION_UNAVAILABLE", `issue read failed: ${e.message}`);
      throw e;
    }
    if (res.status === 404 || res.status === 410) return { status: res.status, issue: null };
    if (res.status !== 200 || res.json === null) throw new VapError("DESTINATION_UNAVAILABLE", `issue read returned HTTP ${res.status}`);
    return { status: 200, issue: res.json as GhIssue };
  }

  /**
   * Scans recent issues (newest first, bounded) for the workflow marker. Returns every match
   * so duplicates are visible, plus how much was scanned.
   */
  async findByMarker(workflowId: string, sinceIso: string | null, signal: AbortSignal): Promise<{ matches: GhIssue[]; scanned: number; pages: number; complete: boolean }> {
    if (!WORKFLOW_ID_PATTERN.test(workflowId)) throw new VapError("INVALID_ARGUMENT", "workflow id has an unexpected format");
    const maxPages = this.config.lookup_max_pages ?? 5;
    const matches: GhIssue[] = [];
    let scanned = 0;
    for (let page = 1; page <= maxPages; page++) {
      const q = new URLSearchParams({ state: "all", sort: "created", direction: "desc", per_page: "100", page: String(page) });
      if (sinceIso) q.set("since", sinceIso);
      if (this.config.author_login) q.set("creator", this.config.author_login);
      let res: SafeResponse;
      try {
        res = await this.send("GET", `${this.issuesPath()}?${q.toString()}`, undefined, signal);
      } catch (e) {
        if (e instanceof SafeRequestError) throw new VapError("DESTINATION_UNAVAILABLE", `issue listing failed: ${e.message}`);
        throw e;
      }
      if (res.status !== 200 || !Array.isArray(res.json)) throw new VapError("DESTINATION_UNAVAILABLE", `issue listing returned HTTP ${res.status}`);
      const list = res.json as GhIssue[];
      for (const i of list) {
        if (i.pull_request) continue;
        scanned++;
        const m = MARKER_RE.exec(i.body ?? "");
        if (m && m[1] === workflowId) matches.push(i);
      }
      if (list.length < 100) return { matches: matches.sort((a, b) => a.number - b.number), scanned, pages: page, complete: true };
    }
    return { matches: matches.sort((a, b) => a.number - b.number), scanned, pages: maxPages, complete: false };
  }

  private sinceFor(op: Operation | null): string | null {
    if (!op) return null;
    const window = (this.config.lookup_window_seconds ?? 3600) * 1000;
    return new Date(Date.parse(op.created_at) - window).toISOString();
  }

  private parseTarget(uri: string): { kind: "issue"; number: number } | { kind: "workflow"; workflowId: string } {
    const i = matchUriTemplate(`${this.repoUri}issues/{number}`, uri);
    if (i && /^\d{1,9}$/.test(i.number)) return { kind: "issue", number: Number(i.number) };
    const w = matchUriTemplate(`${this.repoUri}workflows/{workflow_id}`, uri);
    if (w && WORKFLOW_ID_PATTERN.test(w.workflow_id)) return { kind: "workflow", workflowId: w.workflow_id };
    throw new VapError("NOT_FOUND", "resource URI is not an issue or workflow of the configured repository");
  }

  async observe(q: ObserveQuery, ctx: AdapterContext): Promise<ObserveResult> {
    const t = this.parseTarget(q.resource_uri);
    if (t.kind === "issue") {
      const r = await this.readIssue(t.number, ctx.signal);
      if (!r.issue) return { source: `${this.id}:readback`, source_version: null, freshness: "unknown", facts: { exists: false }, unknowns: ["a missing issue may not be visible yet"], completeness: "complete" };
      return { source: `${this.id}:readback`, source_version: r.issue.updated_at, freshness: "fresh", facts: { exists: true, ...issueFacts(r.issue, this.config.repository) }, unknowns: [], completeness: "complete" };
    }
    const f = await this.findByMarker(t.workflowId, null, ctx.signal);
    return {
      source: `${this.id}:marker-scan`,
      source_version: null,
      freshness: "unknown",
      facts: { matching_issue_count: f.matches.length, issue_numbers: f.matches.map((m) => m.number), scanned: f.scanned },
      unknowns: f.complete ? ["recently created issues may not be listed yet"] : ["scan stopped at the page limit", "recently created issues may not be listed yet"],
      completeness: f.complete ? "complete" : "truncated",
    };
  }

  // ------------------------------------------------------------------ prepare and execute

  async prepare(action: ActionDescriptor, args: Record<string, unknown>, ctx: AdapterContext): Promise<PrepareResult> {
    if (action.id !== ACTION_ID) throw new VapError("NOT_FOUND", `action ${action.id} is not provided by ${this.id}`);
    const a = args as unknown as CiFailureArgs;
    const canonical: CiFailureArgs = {
      workflow_id: a.workflow_id,
      failing_test: redactString(a.failing_test, 300),
      commit_sha: a.commit_sha,
      repro_steps: a.repro_steps.map((s) => redactString(s, 500)),
      error_output: sanitizeErrorOutput(a.error_output),
      build_ref: redactString(a.build_ref, 200),
    };
    const affected = [`${this.repoUri}issues/*`, `${this.repoUri}workflows/${canonical.workflow_id}`];
    for (const uri of affected) {
      if (!ctx.allowedTargets.some((p) => (p.endsWith("*") ? uri.startsWith(p.slice(0, -1)) : p === uri))) throw new VapError("FORBIDDEN", "repository is outside the grant");
    }
    const { title, body } = renderIssue(canonical);
    return {
      canonical_arguments: canonical as unknown as Record<string, unknown>,
      resource_conditions: [],
      preview: {
        fidelity: "exact",
        summary: `Create one issue in ${this.config.repository} titled "${title}" (body ${body.length} characters, digest ${sha256Digest(body).slice(0, 19)}, workflow marker ${canonical.workflow_id}). Watchers may be notified.`,
        effects: this.descriptor.side_effects.map((s) => ({ side_effect_id: s.id, class: s.class, description: s.description, item_count: 1 })),
      },
      affected_resources: affected,
      item_count: 1,
    };
  }

  private effectFor(status: Effect["status"], issue: GhIssue | null, detail: string | null): Effect[] {
    return [{ side_effect_id: "issue_created", item_index: null, resource_uri: issue ? this.issueUri(issue.number) : null, status, source_version: issue?.updated_at ?? null, detail }];
  }

  private summary(issue: GhIssue, workflowId: string, origin: IssueOrigin): Record<string, unknown> {
    return { number: issue.number, html_url: issue.html_url, title: issue.title, workflow_id: workflowId, repository: this.config.repository, origin, origin_note: ORIGIN_NOTE[origin] };
  }

  async execute(plan: Plan, ctx: ExecuteContext): Promise<AdapterResult> {
    const args = plan.canonical_arguments as unknown as CiFailureArgs;
    const { title, body } = renderIssue(args);
    // Credentials first, outside the create's error handling: a failed token exchange means the
    // create was never sent (not_submitted), not that it may have been.
    let auth: Record<string, string>;
    try {
      auth = await this.authHeader(ctx.signal);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "credential exchange failed";
      return { outcome: "failed", submission: "not_submitted", effects: this.effectFor("not_applied", null, "credentials unavailable; the create was not sent"), result_summary: null, external_handle: null, error: new VapError("UNAVAILABLE", `GitHub credentials unavailable: ${msg}`).toBody() };
    }
    await ctx.recheck();
    let res: SafeResponse;
    try {
      res = await this.raw("POST", this.issuesPath(), { title, body }, auth, ctx.signal);
    } catch (e) {
      if (e instanceof SafeRequestError) {
        if (e.submission === "not_submitted") {
          return { outcome: "failed", submission: "not_submitted", effects: this.effectFor("not_applied", null, "request never reached GitHub"), result_summary: null, external_handle: null, diagnostics: { network_error: e.code }, error: new VapError("DESTINATION_UNAVAILABLE", `request was not delivered: ${e.message}`).toBody() };
        }
        return { outcome: "unknown", submission: "maybe_submitted", effects: this.effectFor("unknown", null, "reply lost after the request may have been delivered"), result_summary: null, external_handle: args.workflow_id, diagnostics: { network_error: e.code }, error: new VapError("OUTCOME_UNKNOWN", `reply lost: ${e.message}`).toBody() };
      }
      throw e;
    }
    const diag = { http_status: res.status };
    if (res.status === 201 && res.json && typeof (res.json as GhIssue).number === "number") {
      const issue = res.json as GhIssue;
      return { outcome: "completed", submission: "submitted", effects: this.effectFor("applied", issue, null), result_summary: this.summary(issue, args.workflow_id, "observed_create_response"), external_handle: issue.html_url, diagnostics: diag };
    }
    if (res.status >= 400 && res.status < 500) {
      const errs = Array.isArray((res.json as { errors?: unknown })?.errors) ? ((res.json as { errors: { field?: unknown; code?: unknown }[] }).errors.slice(0, 10).map((x) => ({ field: typeof x.field === "string" ? x.field : null, code: typeof x.code === "string" ? x.code : null }))) : [];
      return {
        outcome: "failed",
        submission: "submitted",
        effects: this.effectFor("not_applied", null, `GitHub rejected the request with HTTP ${res.status}`),
        result_summary: null,
        external_handle: null,
        diagnostics: { ...diag, field_errors: errs },
        error: new VapError("INVALID_ARGUMENT", `GitHub rejected the request (HTTP ${res.status})`, { details: { field_errors: errs } }).toBody(),
      };
    }
    return { outcome: "unknown", submission: "submitted", effects: this.effectFor("unknown", null, `GitHub returned HTTP ${res.status}`), result_summary: null, external_handle: args.workflow_id, diagnostics: diag, error: new VapError("OUTCOME_UNKNOWN", `GitHub returned HTTP ${res.status}; the issue may exist`).toBody() };
  }

  async lookup(operation: Operation, plan: Plan, ctx: AdapterContext): Promise<LookupResult> {
    const args = plan.canonical_arguments as unknown as CiFailureArgs;
    let f: Awaited<ReturnType<GithubAdapter["findByMarker"]>>;
    try {
      f = await this.findByMarker(args.workflow_id, this.sinceFor(operation), ctx.signal);
    } catch (e) {
      const msg = e instanceof VapError ? `${e.code}: ${e.message}` : "marker scan failed";
      return { status: "unknown", definitive: false, effects: [], result_summary: null, external_handle: null, observations: [{ lookup_error: msg }] };
    }
    // A candidate must be in the expected repository, authored by the adapter's identity, carry
    // the planned title and body (marker on the first line) and be created after the operation
    // was accepted. Anything else that quotes the marker never resolves the operation.
    const expected = renderIssue(args);
    const notBefore = Date.parse(operation.created_at) - (this.config.clock_skew_seconds ?? 60) * 1000;
    const tally = { other_repository: 0, other_author: 0, different_content: 0, created_before_operation: 0 };
    const own = f.matches.filter((m) => {
      const why = this.rejectReason(m, expected, notBefore);
      if (why) tally[why]++;
      return why === null;
    });
    const obs = { marker: args.workflow_id, matches: own.length, foreign_marker_matches: f.matches.length - own.length, rejected: tally, scanned: f.scanned, pages: f.pages, scan_complete: f.complete };
    f = { ...f, matches: own };
    if (f.matches.length === 0) {
      // GitHub has no sealed lookup: absence now does not prove the create never happened.
      return { status: "unknown", definitive: false, effects: [], result_summary: null, external_handle: null, observations: [{ ...obs, note: "no matching issue visible; absence is not proof of non-creation" }] };
    }
    const first = f.matches[0];
    return {
      status: "applied",
      definitive: true,
      effects: this.effectFor("applied", first, `origin inferred, not proven${f.matches.length > 1 ? `; ${f.matches.length} qualifying issues carry this workflow marker` : ""}`),
      result_summary: { ...this.summary(first, args.workflow_id, "inferred_from_lookup"), matching_issue_count: f.matches.length },
      external_handle: first.html_url,
      observations: [{ ...obs, issue_numbers: f.matches.map((m) => m.number) }],
    };
  }

  private inRepository(i: GhIssue): boolean {
    const u = (i.repository_url ?? "").toLowerCase();
    return u.endsWith(`/repos/${this.owner}/${this.repo}`.toLowerCase());
  }

  private rejectReason(i: GhIssue, expected: { title: string; body: string }, notBeforeMs: number): "other_repository" | "other_author" | "different_content" | "created_before_operation" | null {
    if (!this.inRepository(i)) return "other_repository";
    if (i.user?.login !== this.config.author_login) return "other_author";
    if (i.title !== expected.title || normalizeBody(i.body) !== normalizeBody(expected.body)) return "different_content";
    if (!(Date.parse(i.created_at) >= notBeforeMs)) return "created_before_operation";
    return null;
  }

  // ------------------------------------------------------------------ verification

  async verify(check: Check, ctx: VerifyContext): Promise<VerifyObservation> {
    if (check.verifier_id !== "github.readback") throw new VapError("CAPABILITY_UNAVAILABLE", `verifier ${check.verifier_id} is not provided by ${this.id}`);
    if (check.method !== "read_back") throw new VapError("CAPABILITY_UNAVAILABLE", "github.readback only performs read_back checks");
    const t = this.parseTarget(ctx.target);
    const args = ctx.plan.canonical_arguments as unknown as CiFailureArgs;
    if (t.kind === "issue") {
      const r = await this.readIssue(t.number, ctx.signal);
      if (!r.issue) {
        return { facts: { exists: false }, source: `${this.id}:readback`, source_version: null, freshness: "unknown", method: "read_back", limitations: ["issue not readable yet; absence is not proof"], artifact: null };
      }
      const origin = (ctx.operation.result_summary?.origin as IssueOrigin | undefined) ?? null;
      const facts = {
        exists: true,
        ...issueFacts(r.issue, this.config.repository),
        ...contentFacts(r.issue, args),
        in_expected_repository: this.inRepository(r.issue),
        authored_by_adapter_identity: r.issue.user?.login === this.config.author_login,
        // Existence of the required issue is checked above; whether this operation created it is
        // reported separately and never upgraded from "inferred" to proven.
        origin,
        creation_by_this_operation: origin === "observed_create_response" ? "observed" : origin === "inferred_from_lookup" ? "inferred_not_proven" : "unknown",
      };
      return {
        facts,
        source: `${this.id}:readback`,
        source_version: r.issue.updated_at,
        freshness: "fresh",
        method: "read_back",
        limitations: ["content checks compare the saved issue with the plan's sanitized arguments", ...(origin === "inferred_from_lookup" ? [ORIGIN_NOTE.inferred_from_lookup] : [])],
        artifact: { content: JSON.stringify({ target: ctx.target, number: r.issue.number, html_url: r.issue.html_url, title: r.issue.title, facts }), media_type: "application/json" },
      };
    }
    const f = await this.findByMarker(t.workflowId, this.sinceFor(ctx.operation), ctx.signal);
    const known = typeof ctx.operation.result_summary?.number === "number" ? (ctx.operation.result_summary.number as number) : null;
    const seen = known !== null && f.matches.some((m) => m.number === known);
    const limitations = ["counts issues visible to the listing API carrying this workflow marker"];
    if (!f.complete) limitations.push("scan stopped at the page limit");
    return {
      facts: { matching_issue_count: f.matches.length, issue_numbers: f.matches.map((m) => m.number), scanned: f.scanned },
      source: `${this.id}:marker-scan`,
      source_version: null,
      // A listing that does not yet show the issue the operation created is stale, not a failure.
      freshness: known === null ? "unknown" : seen ? "fresh" : "stale",
      method: "read_back",
      limitations,
      artifact: { content: JSON.stringify({ target: ctx.target, matching: f.matches.map((m) => ({ number: m.number, html_url: m.html_url })), scanned: f.scanned }), media_type: "application/json" },
    };
  }

  async recover(_operation: Operation, _plan: Plan, strategy: RecoveryMode, _ctx: AdapterContext): Promise<RecoveryPlanSpec> {
    throw new VapError("CAPABILITY_UNAVAILABLE", `${ACTION_ID} declares no ${strategy} recovery; close test issues with the documented cleanup procedure`);
  }
}

function issueFacts(i: GhIssue, repository: string): Record<string, unknown> {
  const m = MARKER_RE.exec(i.body ?? "");
  return { repository, number: i.number, title: i.title, state: i.state, html_url: i.html_url, workflow_id: m ? m[1] : null };
}

function normalizeBody(b: string | null | undefined): string {
  return (b ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
}

function contentFacts(i: GhIssue, a: CiFailureArgs): Record<string, unknown> {
  const body = normalizeBody(i.body);
  const expected = renderIssue(a);
  const section = (h: string) => {
    const start = body.indexOf(`\n## ${h}\n`);
    if (start < 0) return "";
    const rest = body.slice(start + h.length + 5);
    const next = rest.search(/\n## /);
    return next < 0 ? rest : rest.slice(0, next);
  };
  return {
    // Exact comparison with what the plan renders; the per-field facts explain a mismatch.
    body_matches_plan: body === normalizeBody(expected.body),
    title_matches_plan: i.title === expected.title,
    has_failing_test: section("Failing test").includes(a.failing_test.replace(/`/g, "'")),
    has_commit_sha: section("Commit").includes(a.commit_sha),
    has_repro_steps: a.repro_steps.every((s) => section("Reproduction steps").includes(s.replace(/`/g, "'"))),
    has_error_output: a.error_output.length === 0 ? true : section("Error output (sanitized)").includes(a.error_output),
    // Named without "secret"/"token" so evidence redaction keeps the value readable.
    no_sensitive_material: !containsSensitiveMaterial(body),
  };
}

function b64url(s: string | Buffer): string {
  return Buffer.from(s).toString("base64url");
}

/** RS256 JWT for GitHub App authentication (10-minute maximum lifetime, 60 s clock skew). */
export function appJwt(appId: string, privateKeyPem: string, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${payload}`);
  return `${head}.${payload}.${b64url(signer.sign(privateKeyPem.replace(/\\n/g, "\n")))}`;
}
