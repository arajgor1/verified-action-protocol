import { PROTOCOL_VERSION, sha256Digest, VapError } from "@vap/protocol";
import type { ActionDescriptor, Check, Effect, Operation, Plan, RecoveryMode } from "@vap/protocol";
import { expandTemplate, redactString } from "@vap/core";
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
} from "@vap/core";
import type { Browser, BrowserContext, Page, Request, Response } from "playwright";
import dns from "node:dns";
import net from "node:net";
import { startEgressProxy } from "./egress-proxy.js";
import type { EgressProxy } from "./egress-proxy.js";
import { isBlockedAddress, parseOrigin, privateAllowed, safeRequest } from "./net.js";
import type { NetworkPolicy } from "./net.js";

/**
 * Reviewed browser recipes. v0.1 exposes no arbitrary page.evaluate, script injection,
 * downloads or navigation outside the operator-approved origin.
 */
export interface BrowserFormRecipe {
  id: string;
  title: string;
  kind: "issue_form_submit";
  form_path: string;
  /** Destination idempotency lookup, e.g. "/requests/{request.key}?seal=1". */
  lookup_path: string;
  resource_template: string;
  timeout_ms?: number;
  verifier_ids: string[];
}

export interface BrowserAdapterConfig {
  id: string;
  version: string;
  origin: string;
  /** Resource prefix for observe, e.g. "browser://issue-tracker/". */
  resource_prefix: string;
  /** Page paths observe may load. */
  observable_paths: string[];
  allow_private_network?: boolean;
  recipes: BrowserFormRecipe[];
}

export interface BrowserAdapterOptions {
  isolatedTestMode?: boolean;
  /** Override for tests; defaults to launching Playwright Chromium headless. */
  launch?: () => Promise<Browser>;
}

interface NetEvent {
  method: string;
  path: string;
  status: number | null;
  t_ms: number;
  action_header: string | null;
  echo_header: string | null;
  linkage: "explicit" | "temporal_inference" | "unrelated";
}

export class BrowserAdapter implements Adapter {
  readonly id: string;
  readonly version: string;
  readonly provenance = "built_in" as const;
  private browser: Browser | null = null;
  private egress: EgressProxy | null = null;
  private readonly origin: URL;
  private readonly descriptors: ActionDescriptor[];

  constructor(
    private readonly config: BrowserAdapterConfig,
    private readonly opts: BrowserAdapterOptions = {},
  ) {
    this.origin = parseOrigin(config.origin);
    this.id = config.id;
    this.version = `${config.version}+cfg.${sha256Digest(config).slice(7, 19)}`;
    this.descriptors = config.recipes.map((r) => this.describe(r));
  }

  private policy(): NetworkPolicy {
    return { allowPrivateNetwork: this.config.allow_private_network === true, isolatedTestMode: this.opts.isolatedTestMode === true };
  }

  private describe(r: BrowserFormRecipe): ActionDescriptor {
    return {
      protocol_version: PROTOCOL_VERSION,
      id: r.id,
      title: r.title,
      description: "Reviewed browser recipe: fills and submits the fixture issue form in an isolated browser context, then waits for an operation-specific completion predicate.",
      adapter: { id: this.id, version: this.version },
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["title", "owner"],
        properties: {
          title: { type: "string", maxLength: 200 },
          owner: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,31}$" },
          priority: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
      effect_scope: { resource_template: r.resource_template, description: "one issue record created through the web form" },
      preconditions: ["the operator-approved origin serves the reviewed form"],
      side_effects: [
        { id: "issue_created", description: "issue record created through the web form", class: "compensable", bounded: true },
      ],
      risk_tier: 2,
      capabilities: {
        state_source: "dom",
        concurrency_mode: "none",
        preview_fidelity: "none",
        retry_mode: "destination_dedup",
        recovery_modes: [],
        verification_methods: ["read_back"],
        attribution_mode: "explicit_request_id",
        execution_isolation: "browser_context",
      },
      verifier_ids: r.verifier_ids,
      recovery_modes: [],
      plan_ttl_seconds: 300,
      extensions: { "vap.execution_timeout_ms": (r.timeout_ms ?? 30_000) + 15_000 },
    };
  }

  manifest(): ActionDescriptor[] {
    return this.descriptors;
  }
  resourcePrefixes(): string[] {
    return [this.config.resource_prefix];
  }
  verifierIds(): string[] {
    return ["browser.page_readback"];
  }

  /**
   * Resolves and checks the approved origin once. Returns the IP Chromium must use for the
   * origin hostname (pinned with --host-resolver-rules, which defeats DNS rebinding), or null
   * for IP-literal origins. Blocked ranges are refused unless the connector allows a private
   * synthetic fixture in isolated test mode.
   */
  private async checkedOriginAddress(): Promise<string | null> {
    const host = this.origin.hostname.replace(/^\[|\]$/g, "");
    const allowPrivate = privateAllowed(this.policy());
    if (net.isIP(host)) {
      if (isBlockedAddress(host) && !allowPrivate) throw new VapError("FORBIDDEN", "browser origin is in a blocked network range");
      return null;
    }
    const addrs = await dns.promises.lookup(host, { all: true });
    const ok = addrs.find((a) => allowPrivate || !isBlockedAddress(a.address));
    if (!ok) throw new VapError("FORBIDDEN", "browser origin resolves only to blocked network ranges");
    return ok.address;
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    if (this.opts.launch) this.browser = await this.opts.launch();
    else {
      const pinned = await this.checkedOriginAddress();
      const host = this.origin.hostname.replace(/^\[|\]$/g, "");
      // All traffic goes through the egress proxy, which reaches only the approved origin at the
      // address checked above. "<-loopback>" keeps Chromium from bypassing the proxy for loopback.
      this.egress = await startEgressProxy(this.origin, pinned ?? host);
      const { chromium } = await import("playwright");
      this.browser = await chromium.launch({ headless: true, proxy: { server: this.egress.url, bypass: "<-loopback>" } });
    }
    return this.browser;
  }

  /** Fresh isolated context: no downloads, no service workers, no WebSockets, requests outside the origin aborted. */
  private async newContext(): Promise<BrowserContext> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", bypassCSP: false, javaScriptEnabled: true });
    const origin = this.origin.origin;
    await context.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if (u.origin !== origin) return route.abort("blockedbyclient");
      return route.continue();
    });
    await context.routeWebSocket(/.*/, (ws) => {
      void ws.close({ code: 1008, reason: "websockets are not permitted by VAP browser recipes" });
    });
    return context;
  }

  private recipe(id: string): BrowserFormRecipe {
    const r = this.config.recipes.find((x) => x.id === id);
    if (!r) throw new VapError("NOT_FOUND", `browser recipe ${id} is not registered`);
    return r;
  }

  async observe(q: ObserveQuery, ctx: AdapterContext): Promise<ObserveResult> {
    if (!q.resource_uri.startsWith(this.config.resource_prefix)) throw new VapError("NOT_FOUND", "not a browser resource");
    // Only allowlisted paths, and never caller-supplied query strings or fragments.
    const p = "/" + q.resource_uri.slice(this.config.resource_prefix.length).split(/[?#]/)[0];
    if (!this.config.observable_paths.includes(p)) throw new VapError("FORBIDDEN", "page is not in the observable allowlist");
    let context: BrowserContext;
    try {
      context = await this.newContext();
    } catch (e) {
      throw e instanceof VapError ? e : new VapError("DESTINATION_UNAVAILABLE", `browser could not start: ${redactString(String((e as Error).message ?? e), 300)}`);
    }
    try {
      const page = await context.newPage();
      await page.goto(this.origin.origin + p, { waitUntil: "domcontentloaded", timeout: Math.max(1000, ctx.deadline - Date.now()) }).catch((e: Error) => {
        throw new VapError("DESTINATION_UNAVAILABLE", `page load failed: ${redactString(e.message, 300)}`);
      });
      const title = await page.title();
      const headings = await page.getByRole("heading").allInnerTexts();
      const fields = await page.locator("input, select, textarea, button").evaluateAll((els) =>
        els.slice(0, 50).map((e) => ({ tag: e.tagName.toLowerCase(), id: e.id || null, name: e.getAttribute("name"), label: e.getAttribute("aria-label") ?? (e as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? null })),
      );
      return {
        source: `${this.id}:dom`,
        source_version: null,
        freshness: "fresh",
        facts: { title: redactString(title, 200), headings: headings.slice(0, 20).map((h) => redactString(h, 200)), fields },
        unknowns: ["DOM element identities are not stable across navigations; re-observe after navigation"],
        completeness: "partial",
      };
    } finally {
      await context.close();
    }
  }

  async prepare(action: ActionDescriptor, args: Record<string, unknown>, _ctx: AdapterContext): Promise<PrepareResult> {
    const r = this.recipe(action.id);
    const canonical = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
    return {
      canonical_arguments: canonical,
      resource_conditions: [],
      preview: {
        fidelity: "none",
        summary: `Open ${r.form_path} on the approved origin, fill title and owner${canonical.priority ? " and priority" : ""}, submit, and wait for the operation-specific result marker. Browser previews cannot simulate the destination.`,
        effects: action.side_effects.map((s) => ({ side_effect_id: s.id, class: s.class, description: s.description, item_count: 1 })),
      },
      affected_resources: [r.resource_template.slice(0, r.resource_template.indexOf("{")) + "*"],
      item_count: 1,
    };
  }

  async execute(plan: Plan, ctx: ExecuteContext): Promise<AdapterResult> {
    const r = this.recipe(plan.action_id);
    const args = plan.canonical_arguments as { title: string; owner: string; priority?: string };
    const actionId = ctx.destinationKey;
    const events: NetEvent[] = [];
    const consoleErrors: string[] = [];
    const t0 = Date.now();
    let submitAt = Number.POSITIVE_INFINITY;
    let doneAt = Number.POSITIVE_INFINITY;
    let submitted = false;
    const context = await this.newContext();
    try {
      const page: Page = await context.newPage();
      page.on("console", (m) => {
        if (m.type() === "error" && consoleErrors.length < 20) consoleErrors.push(redactString(m.text(), 300));
      });
      const record = async (req: Request, res: Response | null) => {
        if (events.length >= 200) return;
        const u = new URL(req.url());
        const actionHeader = (await req.headerValue("x-client-action-id").catch(() => null)) ?? null;
        const echo = res ? ((await res.headerValue("x-fixture-request-id").catch(() => null)) ?? null) : null;
        events.push({ method: req.method(), path: u.pathname, status: res ? res.status() : null, t_ms: Date.now() - t0, action_header: actionHeader, echo_header: echo, linkage: "unrelated" });
      };
      // Record on response headers, not requestfinished: the latter waits for the body, which a
      // page that never reads it (e.g. fire-and-forget polling) may never complete.
      page.on("response", (res) => {
        record(res.request(), res).catch(() => {});
      });
      page.on("requestfailed", (req) => {
        record(req, null).catch(() => {});
      });

      const timeout = r.timeout_ms ?? 30_000;
      await page.goto(`${this.origin.origin}${r.form_path}?client_action_id=${encodeURIComponent(actionId)}`, { waitUntil: "domcontentloaded", timeout });
      // Handles are re-resolved after navigation; prefer fixture element ids and accessible roles.
      await page.locator("#title").fill(args.title);
      await page.locator("#owner").selectOption(args.owner);
      if (args.priority) await page.locator("#priority").selectOption(args.priority);
      await ctx.recheck();
      submitAt = Date.now() - t0;
      submitted = true;
      await page.getByRole("button", { name: "Create issue" }).click();
      // Operation-specific completion predicate, not a fixed delay or network idleness.
      const marker = page.locator(`[data-vap-result][data-client-action-id="${actionId}"]`);
      await marker.waitFor({ state: "attached", timeout });
      doneAt = Date.now() - t0;
      const status = await marker.getAttribute("data-status");
      const issueId = await marker.getAttribute("data-issue-id");
      const version = await marker.getAttribute("data-version");
      const fieldErrors = await page.locator("[data-field-error]").evaluateAll((els) => els.slice(0, 20).map((e) => ({ field: e.getAttribute("data-field-error"), message: (e.textContent ?? "").slice(0, 200) })));
      await page.waitForTimeout(150);
      const linked = this.link(events, actionId, submitAt, doneAt);
      const explicitSubmit = linked.find((e) => e.linkage === "explicit" && e.method === "POST");
      const diagnostics = { network_events: linked.slice(0, 50), console_errors: consoleErrors, dom: { status, field_errors: fieldErrors }, attribution_note: "explicit = request/response carried this operation's client action id; temporal_inference = only overlapped in time" };
      if (status === "created" && issueId) {
        const effects: Effect[] = [
          { side_effect_id: "issue_created", item_index: null, resource_uri: expandTemplate(r.resource_template, { result: { id: issueId } }), status: "applied", source_version: version, detail: explicitSubmit ? `linked request ${explicitSubmit.method} ${explicitSubmit.path} -> ${explicitSubmit.status}` : "no explicitly linked network event captured" },
        ];
        return { outcome: "completed", submission: "submitted", effects, result_summary: { id: issueId, version, status: "created" }, external_handle: actionId, diagnostics };
      }
      if (status === "rejected") {
        return {
          outcome: "failed",
          submission: "submitted",
          effects: [{ side_effect_id: "issue_created", item_index: null, resource_uri: null, status: "not_applied", source_version: null, detail: "form submission rejected by the destination" }],
          result_summary: { status: "rejected", field_errors: fieldErrors },
          external_handle: actionId,
          diagnostics,
          error: new VapError("INVALID_ARGUMENT", "the destination rejected the form", { details: { field_errors: fieldErrors.map((f) => ({ field: f.field })) } }).toBody(),
        };
      }
      return { outcome: "unknown", submission: "maybe_submitted", effects: [{ side_effect_id: "issue_created", item_index: null, resource_uri: null, status: "unknown", source_version: null, detail: `unexpected result marker ${status}` }], result_summary: null, external_handle: actionId, diagnostics };
    } catch (e) {
      const diagnostics = { network_events: this.link(events, actionId, submitAt, doneAt).slice(0, 50), console_errors: consoleErrors, error: redactString(String((e as Error).message ?? e), 300) };
      if (!submitted) {
        if (e instanceof VapError || (e as Error)?.constructor?.name === "RecheckDenied") throw e;
        return { outcome: "failed", submission: "not_submitted", effects: [{ side_effect_id: "issue_created", item_index: null, resource_uri: null, status: "not_applied", source_version: null, detail: "failed before submission" }], result_summary: null, external_handle: null, diagnostics, error: new VapError("DESTINATION_UNAVAILABLE", `browser recipe failed before submitting the form: ${diagnostics.error}`).toBody() };
      }
      return { outcome: "unknown", submission: "maybe_submitted", effects: [{ side_effect_id: "issue_created", item_index: null, resource_uri: null, status: "unknown", source_version: null, detail: "completion predicate not observed before the deadline" }], result_summary: null, external_handle: actionId, diagnostics, error: new VapError("OUTCOME_UNKNOWN", "form was submitted but completion was not observed; reconcile").toBody() };
    } finally {
      // Cookies and storage are private to the context and discarded here.
      await context.close().catch(() => {});
    }
  }

  /** Explicit linkage needs the operation's id on the request or response; overlap alone is labeled inference. */
  private link(events: NetEvent[], actionId: string, submitAt: number, doneAt: number): NetEvent[] {
    return events.map((e) => {
      if (e.action_header === actionId || e.echo_header === actionId) return { ...e, linkage: "explicit" as const };
      if (e.t_ms >= submitAt && e.t_ms <= doneAt) return { ...e, linkage: "temporal_inference" as const };
      return { ...e, linkage: "unrelated" as const };
    });
  }

  async lookup(operation: Operation, plan: Plan, ctx: AdapterContext): Promise<LookupResult> {
    const r = this.recipe(plan.action_id);
    const destKey = ctx.destinationKey ?? operation.id;
    const path = expandTemplate(r.lookup_path.split("?")[0], { request: { key: destKey } }) + (r.lookup_path.includes("?") ? "?" + r.lookup_path.split("?")[1] : "");
    try {
      const res = await safeRequest({ origin: this.origin.origin, method: "GET", path, headers: { accept: "application/json" }, timeoutMs: 10_000, maxResponseBytes: 256 * 1024, signal: ctx.signal, policy: this.policy() });
      if (res.status === 404) return { status: "not_applied", definitive: true, effects: [], result_summary: null, external_handle: operation.id, observations: [{ lookup_http_status: 404, sealed: true }] };
      const body = res.json as { status?: string; response?: { id?: string; version?: number } } | null;
      if (res.status === 200 && body?.status === "applied" && body.response?.id) {
        const id = String(body.response.id);
        return {
          status: "applied",
          definitive: true,
          effects: [{ side_effect_id: "issue_created", item_index: null, resource_uri: expandTemplate(r.resource_template, { result: { id } }), status: "applied", source_version: body.response.version !== undefined ? String(body.response.version) : null, detail: "found by destination request-key lookup" }],
          result_summary: { id, version: body.response.version ?? null, status: "created" },
          external_handle: operation.id,
          observations: [{ lookup_http_status: 200 }],
        };
      }
      if (res.status === 200 && body?.status === "rejected") {
        return { status: "not_applied", definitive: true, destination_rejected: true, effects: [], result_summary: null, external_handle: operation.id, observations: [{ lookup_http_status: 200, destination_status: "rejected" }] };
      }
      return { status: "unknown", definitive: false, effects: [], result_summary: null, external_handle: null, observations: [{ lookup_http_status: res.status }] };
    } catch (e) {
      return { status: "unknown", definitive: false, effects: [], result_summary: null, external_handle: null, observations: [{ lookup_error: (e as Error).message }] };
    }
  }

  async verify(check: Check, ctx: VerifyContext): Promise<VerifyObservation> {
    if (check.verifier_id !== "browser.page_readback") throw new VapError("CAPABILITY_UNAVAILABLE", `verifier ${check.verifier_id} is not provided by ${this.id}`);
    const m = /^issue:\/\/issue-tracker\/issues\/([A-Za-z0-9_-]{1,64})$/.exec(ctx.target);
    if (!m) throw new VapError("CAPABILITY_UNAVAILABLE", "browser.page_readback only reads issue view pages");
    const context = await this.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${this.origin.origin}/issues/${m[1]}/view`, { waitUntil: "domcontentloaded", timeout: Math.max(1000, ctx.deadline - Date.now()) });
      const view = page.locator("[data-issue-view]");
      if ((await view.count()) === 0) return { facts: { exists: false }, source: `${this.id}:page`, source_version: null, freshness: "unknown", method: "read_back", limitations: ["record view page did not render an issue"] };
      const facts = {
        exists: true,
        id: await view.getAttribute("data-id"),
        title: await view.getAttribute("data-title"),
        owner: await view.getAttribute("data-owner"),
        status: await view.getAttribute("data-status"),
        version: Number(await view.getAttribute("data-version")),
      };
      const v = String(facts.version);
      const fresh = ctx.expectedVersion === null ? "unknown" : Number(v) >= Number(ctx.expectedVersion) ? "fresh" : "stale";
      return { facts, source: `${this.id}:page`, source_version: v, freshness: fresh, method: "read_back", limitations: ["reads the server-rendered record view; same application as the write path"] };
    } finally {
      await context.close().catch(() => {});
    }
  }

  async recover(_operation: Operation, _plan: Plan, _strategy: RecoveryMode, _ctx: AdapterContext): Promise<RecoveryPlanSpec> {
    throw new VapError("CAPABILITY_UNAVAILABLE", "browser recipes declare no recovery in v0.1; use the HTTP adapter's compensating action");
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = null;
    await this.egress?.close().catch(() => {});
    this.egress = null;
  }
}
