// TEST-ONLY fault injector for the CI-failure demo. Never shipped: it lives outside the
// packages that images and npm packages are built from (see .dockerignore and the release
// allowlist), and nothing in the runtime references it.
//
// It sits between a client (the VAP GitHub adapter, or a no-VAP agent) and the issues API
// (the fixture's /gh subset or https://api.github.com) and applies a fixed schedule:
//   drop_response_after_commit  forward the create, receive the destination's acceptance,
//                               then close the client connection without replying
//   hold_response_ms            forward, receive, wait N ms, then reply (lets a test crash the
//                               caller while the reply is in flight; the reply is then lost)
//   fail_request                answer 503 without forwarding (e.g. make listing unavailable)
// The private ground truth (what the destination actually answered) is available only through
// this in-process object, for the evaluator after a run. It has no HTTP control surface, so
// agents and the runtime cannot read or steer it. Authorization headers and bodies are never
// recorded; only the status, issue number/URL and the non-secret workflow marker are kept.
import http from "node:http";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";

export type RequestKind = "create_issue" | "list_issues" | "get_issue" | "other";
export type FaultAction = "drop_response_after_commit" | "hold_response_ms" | "fail_request";

export interface FaultRule {
  match: RequestKind;
  action: FaultAction;
  /** How many matching requests the rule applies to (default 1). */
  count?: number;
  holdMs?: number;
}

export interface GroundTruthRecord {
  seq: number;
  kind: RequestKind;
  forwarded: boolean;
  upstream_status: number | null;
  fault: FaultAction | null;
  delivered_to_client: boolean;
  workflow_id: string | null;
  issue_number: number | null;
  html_url: string | null;
  at: string;
}

const MARKER = /vapwf-[0-9a-f]{24}/;
const HOP = new Set(["connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);

function classify(method: string, path: string): RequestKind {
  const p = path.split("?")[0];
  if (/\/repos\/[^/]+\/[^/]+\/issues$/.test(p)) return method === "POST" ? "create_issue" : method === "GET" ? "list_issues" : "other";
  if (method === "GET" && /\/repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(p)) return "get_issue";
  return "other";
}

export interface FaultProxy {
  url: string;
  /** Hit once per armed hold, when the held reply starts waiting (so a test can crash the caller). */
  onHold(cb: () => void): void;
  setSchedule(rules: FaultRule[]): void;
  /** Points the proxy at another upstream (used when the destination starts after the proxy). */
  setUpstream(url: string): void;
  groundTruth(): GroundTruthRecord[];
  createCount(workflowId?: string): number;
  close(): Promise<void>;
}

export async function startFaultProxy(opts: { upstream: string; schedule?: FaultRule[] }): Promise<FaultProxy> {
  let upstream = new URL(opts.upstream);
  let basePath = upstream.pathname.replace(/\/+$/, "");
  let lib = upstream.protocol === "https:" ? https : http;
  let rules: (FaultRule & { remaining: number })[] = [];
  const truth: GroundTruthRecord[] = [];
  const holdListeners: (() => void)[] = [];
  let seq = 0;

  const setSchedule = (r: FaultRule[]) => {
    rules = r.map((x) => ({ ...x, remaining: x.count ?? 1 }));
  };
  setSchedule(opts.schedule ?? []);

  const takeRule = (kind: RequestKind) => {
    const r = rules.find((x) => x.match === kind && x.remaining > 0);
    if (r) r.remaining--;
    return r ?? null;
  };

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const method = req.method ?? "GET";
      const path = req.url ?? "/";
      const kind = classify(method, path);
      const body = Buffer.concat(chunks);
      const rule = takeRule(kind);
      const rec: GroundTruthRecord = {
        seq: ++seq,
        kind,
        forwarded: false,
        upstream_status: null,
        fault: rule?.action ?? null,
        delivered_to_client: false,
        workflow_id: kind === "create_issue" ? (MARKER.exec(body.toString("utf8"))?.[0] ?? null) : null,
        issue_number: null,
        html_url: null,
        at: new Date().toISOString(),
      };
      truth.push(rec);
      if (rule?.action === "fail_request") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Service Unavailable (injected)" }));
        rec.delivered_to_client = true;
        return;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !HOP.has(k)) headers[k] = v;
      headers.host = upstream.host;
      if (body.length > 0) headers["content-length"] = String(body.length);
      const up = lib.request(
        { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || undefined, method, path: basePath + path, headers, agent: false, timeout: 30_000 },
        (ur) => {
          const parts: Buffer[] = [];
          ur.on("data", (c: Buffer) => parts.push(c));
          ur.on("end", () => {
            rec.forwarded = true;
            rec.upstream_status = ur.statusCode ?? 0;
            const text = Buffer.concat(parts);
            if (kind === "create_issue" && rec.upstream_status === 201) {
              try {
                const j = JSON.parse(text.toString("utf8")) as { number?: number; html_url?: string };
                rec.issue_number = typeof j.number === "number" ? j.number : null;
                rec.html_url = typeof j.html_url === "string" ? j.html_url : null;
              } catch {
                /* recorded as forwarded without details */
              }
            }
            const reply = () => {
              if (res.destroyed || req.socket.destroyed) return;
              const out: Record<string, string> = {};
              for (const [k, v] of Object.entries(ur.headers)) if (typeof v === "string" && !HOP.has(k)) out[k] = v;
              out["content-length"] = String(text.length);
              res.writeHead(ur.statusCode ?? 502, out);
              res.end(text);
              rec.delivered_to_client = true;
            };
            if (rule?.action === "drop_response_after_commit") {
              req.socket.destroy();
              return;
            }
            if (rule?.action === "hold_response_ms") {
              for (const cb of holdListeners) cb();
              setTimeout(reply, rule.holdMs ?? 2000);
              return;
            }
            reply();
          });
        },
      );
      up.on("timeout", () => up.destroy(new Error("upstream timeout")));
      up.on("error", () => {
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "Bad Gateway (proxy could not reach upstream)" }));
        }
      });
      up.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    onHold: (cb) => holdListeners.push(cb),
    setSchedule,
    setUpstream: (u: string) => {
      upstream = new URL(u);
      basePath = upstream.pathname.replace(/\/+$/, "");
      lib = upstream.protocol === "https:" ? https : http;
    },
    groundTruth: () => truth.map((r) => ({ ...r })),
    createCount: (wf) => truth.filter((r) => r.kind === "create_issue" && r.forwarded && r.upstream_status === 201 && (wf === undefined || r.workflow_id === wf)).length,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
