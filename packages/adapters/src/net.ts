import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { VapError } from "@verified-action-protocol/protocol";
import type { SubmissionCertainty } from "@verified-action-protocol/core";

/**
 * SSRF controls for operator-registered HTTP destinations:
 *  - only registered origins; callers never supply URLs, header names or credentials;
 *  - every resolved address is checked at connect time (defeats DNS rebinding);
 *  - loopback, private, link-local (including the metadata service), CGNAT, multicast and
 *    reserved ranges are blocked unless the connector explicitly allows a private
 *    synthetic fixture AND the runtime runs in isolated test mode;
 *  - redirects are never followed;
 *  - response bodies are size-capped.
 */

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata", "metadata.google.internal", "metadata.goog", "instance-data"]);

/**
 * True for addresses VAP must never connect to (outside isolated test mode). Accepts IP
 * literals only; hostnames are checked after resolution (guardedLookup), so a non-IP input is
 * treated as blocked. IPv6 is normalized first, so embedded IPv4 forms in any notation
 * (::ffff:a9fe:a9fe, ::169.254.169.254, 6to4, NAT64) are judged by the embedded address.
 */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedV4(ip);
  if (net.isIPv6(ip)) {
    const h = expandIPv6(ip.replace(/^\[|\]$/g, "").split("%")[0]);
    if (!h) return true;
    const v4 = (a: number, b: number) => `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
    const zeros = (n: number) => h.slice(0, n).every((x) => x === 0);
    if (zeros(8)) return true; // ::
    if (zeros(7) && h[7] === 1) return true; // ::1
    if (zeros(5) && h[5] === 0xffff) return isBlockedV4(v4(h[6], h[7])); // IPv4-mapped
    if (zeros(6)) return true; // IPv4-compatible ::/96 (deprecated; never legitimate)
    if (h[0] === 0x0064 && h[1] === 0xff9b) return true; // NAT64 can reach private IPv4
    if (h[0] === 0x2002) return isBlockedV4(v4(h[1], h[2])); // 6to4 embeds an IPv4 address
    if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((h[0] & 0xff00) === 0xff00) return true; // multicast
    if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
    return false;
  }
  return true;
}

/** Expands an IPv6 literal (including a trailing dotted IPv4 part) into eight 16-bit groups. */
export function expandIPv6(addr: string): number[] | null {
  let s = addr.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    if (!net.isIPv4(dotted[1])) return null;
    const [a, b, c, d] = dotted[1].split(".").map(Number);
    s = s.slice(0, -dotted[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  return groups;
}

function isBlockedV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 and 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

export interface NetworkPolicy {
  /** Honoured only when isolatedTestMode is true. */
  allowPrivateNetwork: boolean;
  isolatedTestMode: boolean;
}

export function privateAllowed(p: NetworkPolicy): boolean {
  return p.allowPrivateNetwork && p.isolatedTestMode;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

function guardedLookup(policy: NetworkPolicy) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase()) && !privateAllowed(policy)) {
      callback(blockedError(hostname), "", 4);
      return;
    }
    dns.lookup(hostname, { all: true, family: options.family ?? 0 }, (err, addresses) => {
      if (err) return callback(err, "", 4);
      const list = addresses as dns.LookupAddress[];
      const allowed = privateAllowed(policy) ? list : list.filter((a) => !isBlockedAddress(a.address));
      if (allowed.length === 0) return callback(blockedError(hostname), "", 4);
      if (options.all) return callback(null, allowed);
      return callback(null, allowed[0].address, allowed[0].family);
    });
  };
}

function blockedError(host: string): NodeJS.ErrnoException {
  const e = new Error(`destination ${host} resolves only to blocked network ranges`) as NodeJS.ErrnoException;
  e.code = "EVAPBLOCKED";
  return e;
}

export interface SafeRequest {
  origin: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
  policy: NetworkPolicy;
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
  truncated: boolean;
}

export class SafeRequestError extends Error {
  constructor(
    message: string,
    readonly submission: SubmissionCertainty,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Validates an operator-configured origin. Throws on anything but scheme://host[:port]. */
export function parseOrigin(origin: string): URL {
  const u = new URL(origin);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`origin ${origin} must be http(s)`);
  if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) throw new Error(`origin ${origin} must not contain a path, query, fragment or credentials`);
  return u;
}

/**
 * Performs one HTTP request to a registered origin. Reports whether the request could have
 * reached the destination: errors before a connection is established are not_submitted;
 * errors afterwards (including a reply lost after the destination committed) are
 * maybe_submitted. HTTP failure alone never proves an effect did not occur.
 */
export function safeRequest(req: SafeRequest): Promise<SafeResponse> {
  const origin = parseOrigin(req.origin);
  if (!req.path.startsWith("/") || req.path.startsWith("//") || /[\s#]/.test(req.path)) {
    return Promise.reject(new SafeRequestError("invalid request path", "not_submitted", "EVAPPATH"));
  }
  const host = origin.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isBlockedAddress(host) && !privateAllowed(req.policy)) {
    return Promise.reject(new SafeRequestError(`destination ${host} is in a blocked network range`, "not_submitted", "EVAPBLOCKED"));
  }
  const lib = origin.protocol === "https:" ? https : http;
  return new Promise<SafeResponse>((resolve, reject) => {
    let connected = false;
    let settled = false;
    const fail = (e: Error & { code?: string }) => {
      if (settled) return;
      settled = true;
      const blocked = e.code === "EVAPBLOCKED";
      reject(new SafeRequestError(e.message, connected && !blocked ? "maybe_submitted" : "not_submitted", e.code ?? "EUNKNOWN"));
    };
    const r = lib.request(
      {
        protocol: origin.protocol,
        hostname: host,
        port: origin.port || undefined,
        method: req.method,
        path: req.path,
        headers: { ...req.headers, ...(req.body !== undefined ? { "content-length": String(Buffer.byteLength(req.body)) } : {}) },
        lookup: guardedLookup(req.policy) as unknown as typeof dns.lookup,
        signal: req.signal,
        timeout: req.timeoutMs,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on("data", (c: Buffer) => {
          if (truncated) return;
          size += c.length;
          if (size > req.maxResponseBytes) {
            truncated = true;
            chunks.push(c.subarray(0, Math.max(0, req.maxResponseBytes - (size - c.length))));
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        const finish = () => {
          if (settled) return;
          settled = true;
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = null;
          if (!truncated && /json/i.test(String(res.headers["content-type"] ?? ""))) {
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
          }
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") headers[k] = v;
          resolve({ status: res.statusCode ?? 0, headers, text, json, truncated });
        };
        res.on("end", finish);
        res.on("close", () => (truncated ? finish() : !res.complete ? fail(Object.assign(new Error("response aborted before completion"), { code: "ECONNRESET" })) : finish()));
        res.on("error", (e) => fail(e));
      },
    );
    r.on("socket", (s) => {
      const markConnected = () => {
        connected = true;
      };
      if ((s as net.Socket).connecting === false && !s.destroyed) connected = true;
      s.once("connect", markConnected);
      s.once("secureConnect", markConnected);
    });
    r.on("timeout", () => r.destroy(Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" })));
    r.on("error", (e) => fail(e));
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });
}
