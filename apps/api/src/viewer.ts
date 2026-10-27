import { VapError } from "@verified-action-protocol/protocol";
import type { Operation, Receipt } from "@verified-action-protocol/protocol";
import type { Coordinator, Principal } from "@verified-action-protocol/core";

/**
 * Lightweight read-only operation viewer. It applies the same authorization as the API
 * (every read goes through the coordinator with the caller's principal) and shows checks
 * and uncertainty prominently. It has no write controls and runs no client script.
 */

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const OUTCOME_CLASS: Record<string, string> = {
  verified: "ok",
  completed_unverified: "warn",
  verification_failed: "bad",
  partially_applied: "warn",
  failed: "bad",
  cancelled: "muted",
  unknown: "unknown",
  requested: "muted",
  submitted: "muted",
};

const badge = (text: string, cls: string) => `<span class="b ${cls}">${esc(text)}</span>`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--mut:#6e6e73;--line:#e5e5ea;--ok:#1b7f3b;--warn:#a05a00;--bad:#b42318;--unk:#5b21b6}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#f2f2f7;--mut:#a1a1a6;--line:#2c2c2e;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--unk:#c4b5fd}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:0;padding:16px;max-width:1100px}
a{color:inherit}h1{font-size:20px;margin:8px 0 16px}h2{font-size:15px;margin:24px 0 8px}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top;white-space:nowrap}
th{color:var(--mut);font-weight:500}.b{display:inline-block;padding:1px 8px;border-radius:10px;border:1px solid currentColor;font-size:12px}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.unknown{color:var(--unk);font-weight:700}.muted{color:var(--mut)}
.alert{border:2px solid var(--unk);color:var(--unk);padding:10px 12px;border-radius:8px;margin:12px 0}
code{font-family:ui-monospace,monospace;font-size:12px}.mut{color:var(--mut)}
</style></head><body><p class="mut"><a href="/viewer">VAP operations</a> · read-only</p>${body}</body></html>`;
}

function opRow(o: Operation): string {
  return `<tr><td><a href="/viewer/operations/${esc(o.id)}"><code>${esc(o.id)}</code></a></td><td><code>${esc(o.action_id)}</code></td><td>${badge(o.outcome, OUTCOME_CLASS[o.outcome] ?? "muted")}</td><td>${esc(o.execution_status)}</td><td>${esc(o.verification_status)}</td><td>${esc(o.recovery_status)}</td><td class="mut">${esc(o.created_at)}</td></tr>`;
}

const OPS_HEAD = "<tr><th>Operation</th><th>Action</th><th>Outcome</th><th>Execution</th><th>Verification</th><th>Recovery</th><th>Created</th></tr>";

export async function renderViewer(c: Coordinator, p: Principal, url: URL): Promise<string> {
  const path = url.pathname;
  let m = /^\/viewer\/operations\/(op_[A-Za-z0-9_-]{8,64})$/.exec(path);
  if (m) return renderOperation(c, p, m[1]);
  m = /^\/viewer\/tasks\/(tsk_[A-Za-z0-9_-]{8,64})$/.exec(path);
  if (m) return renderTask(c, p, m[1]);
  if (path !== "/viewer" && path !== "/viewer/") throw new VapError("NOT_FOUND", "no such page");
  const unknown = await c.listOperations(p, { status: ["unknown"], limit: 50 });
  const recent = await c.listOperations(p, { limit: 50 });
  const alert = unknown.length > 0 ? `<div class="alert">${unknown.length} operation(s) have an <b>unknown</b> outcome. Their effects are not established; reconcile before any retry.</div>` : "";
  return page(
    "VAP operations",
    `<h1>Operations</h1>${alert}${unknown.length ? `<h2>Unknown outcomes</h2><table>${OPS_HEAD}${unknown.map(opRow).join("")}</table>` : ""}<h2>Recent</h2><table>${OPS_HEAD}${recent.map(opRow).join("") || '<tr><td colspan="7" class="mut">No operations visible to you.</td></tr>'}</table>`,
  );
}

async function renderOperation(c: Coordinator, p: Principal, id: string): Promise<string> {
  const op = await c.getOperation(p, id);
  const r: Receipt = await c.receipt(p, id);
  const events = await c.listEvents(p, id, 0, 200);
  const alert =
    op.outcome === "unknown"
      ? `<div class="alert">Outcome <b>unknown</b>: submission or effects cannot be established. ${esc(r.retry_guidance.explanation)}</div>`
      : op.outcome === "completed_unverified"
        ? `<div class="alert">Execution completed but verification has <b>not passed</b> (${esc(op.verification_status)}). This is not a verified success.</div>`
        : "";
  const checks = r.checks
    .map((k) => `<tr><td><code>${esc(k.id)}</code>${k.item_index !== null ? ` <span class="mut">item ${k.item_index}</span>` : ""}</td><td>${badge(k.result, k.result === "pass" ? "ok" : k.result === "fail" ? "bad" : k.result === "missing" ? "unknown" : "warn")}</td><td>${esc(k.method ?? "")}</td><td>${esc(k.source ?? "")}</td><td>${esc(k.source_version ?? "null")}</td><td class="mut">${esc(k.observed_at ?? "")}</td><td><code>${esc(k.evidence_id ?? "")}</code></td></tr>`)
    .join("");
  const effects = r.effects
    .map((e) => `<tr><td><code>${esc(e.side_effect_id)}</code></td><td>${e.item_index ?? ""}</td><td>${badge(e.status, e.status === "applied" ? "ok" : e.status === "unknown" ? "unknown" : "muted")}</td><td><code>${esc(e.resource_uri ?? "")}</code></td><td>${esc(e.source_version ?? "null")}</td><td class="mut">${esc(e.detail ?? "")}</td></tr>`)
    .join("");
  const evs = events.events.map((e) => `<tr><td>${e.sequence}</td><td><code>${esc(e.type)}</code></td><td class="mut">${esc(e.at)}</td><td>${esc(e.actor)}</td><td><code>${esc(JSON.stringify(e.data).slice(0, 300))}</code></td></tr>`).join("");
  return page(
    `Operation ${id}`,
    `<h1>Operation <code>${esc(id)}</code></h1>${alert}
<p>${badge(op.outcome, OUTCOME_CLASS[op.outcome] ?? "muted")} &nbsp; execution <b>${esc(op.execution_status)}</b> · verification <b>${esc(op.verification_status)}</b> · recovery <b>${esc(op.recovery_status)}</b></p>
<p class="mut">action <code>${esc(op.action_id)}</code> · task <a href="/viewer/tasks/${esc(op.task_id)}"><code>${esc(op.task_id)}</code></a> · plan <code>${esc(op.plan_id)}</code> · attempts ${op.attempts}${op.recovers_operation_id ? ` · recovers <a href="/viewer/operations/${esc(op.recovers_operation_id)}"><code>${esc(op.recovers_operation_id)}</code></a>` : ""}</p>
<p><b>Retry guidance:</b> ${esc(r.retry_guidance.disposition)} — ${esc(r.retry_guidance.explanation)}</p>
<h2>Checks</h2><table><tr><th>Check</th><th>Result</th><th>Method</th><th>Source</th><th>Source version</th><th>Observed</th><th>Evidence</th></tr>${checks || '<tr><td colspan="7" class="mut">No checks bound to this plan.</td></tr>'}</table>
<h2>Effects</h2><table><tr><th>Side effect</th><th>Item</th><th>Status</th><th>Resource</th><th>Version</th><th>Detail</th></tr>${effects || '<tr><td colspan="6" class="mut">No effects recorded.</td></tr>'}</table>
<h2>Not verified</h2>${r.unverified_effects.length ? `<ul>${r.unverified_effects.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>` : '<p class="mut">Every recorded effect has passing evidence.</p>'}
<h2>Recovery</h2><p>modes: ${esc(r.recovery.modes.join(", ") || "none")} · available: ${r.recovery.available ? "yes" : "no"} ${r.recovery.recovery_operation_ids.map((x) => `· <a href="/viewer/operations/${esc(x)}"><code>${esc(x)}</code></a>`).join(" ")}</p>
<h2>Journal events</h2><table><tr><th>#</th><th>Type</th><th>At</th><th>Actor</th><th>Data</th></tr>${evs}</table>`,
  );
}

async function renderTask(c: Coordinator, p: Principal, id: string): Promise<string> {
  const t = await c.getTask(p, id);
  const o = await c.taskOutcome(p, id);
  const ops = await c.listOperations(p, { task_id: id, limit: 100 });
  return page(
    `Task ${id}`,
    `<h1>Task <code>${esc(id)}</code> <span class="mut">rev ${t.contract_revision}</span></h1>
<p>${esc(t.goal)}</p>
<p>${o.verified_complete ? badge("verified complete", "ok") : badge("not verified complete", "warn")}</p>
${o.reasons.length ? `<ul>${o.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
<h2>Required checks</h2><table><tr><th>Check</th><th>Status</th><th>Operation</th><th>Observed</th></tr>${o.checks.map((k) => `<tr><td><code>${esc(k.check_id)}</code></td><td>${badge(k.status, k.status === "pass" ? "ok" : k.status === "fail" ? "bad" : k.status === "missing" ? "unknown" : "warn")}</td><td>${k.operation_id ? `<a href="/viewer/operations/${esc(k.operation_id)}"><code>${esc(k.operation_id)}</code></a>` : ""}</td><td class="mut">${esc(k.observed_at ?? "")}</td></tr>`).join("")}</table>
<h2>Operations</h2><table>${OPS_HEAD}${ops.map(opRow).join("")}</table>`,
  );
}
