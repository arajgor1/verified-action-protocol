import type { Coordinator } from "@vap/core";

/**
 * Prometheus-style text metrics. Operation counts by execution and verification status,
 * unknown-outcome age, reconcile backlog, live claims, outbox queue age, authorization
 * denials and request latency. No labels carry identifiers or request content.
 */
export class Metrics {
  authDenials = 0;
  authorizationDenials = 0;
  private readonly requests = new Map<string, { count: number; totalMs: number }>();

  observeRequest(route: string, status: number, ms: number): void {
    const key = `${route}|${Math.floor(status / 100)}xx`;
    const m = this.requests.get(key) ?? { count: 0, totalMs: 0 };
    m.count++;
    m.totalMs += ms;
    this.requests.set(key, m);
  }

  async render(c: Coordinator): Promise<string> {
    const lines: string[] = [];
    const pool = (c.journal as unknown as { pool?: { query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> } }).pool;
    if (pool) {
      const byStatus = await pool.query("SELECT execution_status, verification_status, count(*)::int AS n FROM operations GROUP BY 1, 2");
      lines.push("# TYPE vap_operations gauge");
      for (const r of byStatus.rows) lines.push(`vap_operations{execution_status="${r.execution_status}",verification_status="${r.verification_status}"} ${r.n}`);
      const unknown = await pool.query("SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(updated_at)), 0)::float AS age, count(*)::int AS n FROM operations WHERE execution_status = 'unknown'");
      lines.push("# TYPE vap_unknown_outcome_oldest_seconds gauge", `vap_unknown_outcome_oldest_seconds ${unknown.rows[0].age}`);
      lines.push("# TYPE vap_unknown_outcomes gauge", `vap_unknown_outcomes ${unknown.rows[0].n}`);
      const outbox = await pool.query("SELECT kind, count(*)::int AS n, COALESCE(EXTRACT(EPOCH FROM now() - min(available_at)), 0)::float AS age FROM outbox WHERE completed_at IS NULL GROUP BY kind");
      lines.push("# TYPE vap_outbox_pending gauge", "# TYPE vap_outbox_oldest_seconds gauge");
      for (const r of outbox.rows) lines.push(`vap_outbox_pending{kind="${r.kind}"} ${r.n}`, `vap_outbox_oldest_seconds{kind="${r.kind}"} ${r.age}`);
      const claims = await pool.query("SELECT count(*)::int AS n FROM worker_claims WHERE lease_expires_at > now()");
      lines.push("# TYPE vap_worker_claims_live gauge", `vap_worker_claims_live ${claims.rows[0].n}`);
      const recov = await pool.query("SELECT count(*)::int AS n FROM operations WHERE recovery_status IN ('failed','unknown')");
      lines.push("# TYPE vap_recovery_failed_or_unknown gauge", `vap_recovery_failed_or_unknown ${recov.rows[0].n}`);
    }
    lines.push("# TYPE vap_authentication_denials_total counter", `vap_authentication_denials_total ${this.authDenials}`);
    lines.push("# TYPE vap_authorization_denials_total counter", `vap_authorization_denials_total ${this.authorizationDenials}`);
    lines.push("# TYPE vap_http_requests_total counter", "# TYPE vap_http_request_duration_ms_sum counter");
    for (const [key, m] of this.requests) {
      const [route, cls] = key.split("|");
      const r = route.replace(/[^a-z0-9/_-]/gi, "_").slice(0, 80);
      lines.push(`vap_http_requests_total{route="${r}",class="${cls}"} ${m.count}`, `vap_http_request_duration_ms_sum{route="${r}",class="${cls}"} ${m.totalMs}`);
    }
    return lines.join("\n") + "\n";
  }
}
