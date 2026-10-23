import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildRegistry, CliAdapter, isBlockedAddress, loadAdaptersConfig, parseOrigin, safeRequest, SafeRequestError, startEgressProxy } from "@vap/adapters";
import { loadConfig } from "@vap/api";
import { staticConformance } from "@vap/sdk";
import { CONFIG_PATH } from "../helpers/paths.ts";

test("blocked network ranges include metadata, loopback, private and mapped addresses", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "224.0.0.1"]) {
    assert.ok(isBlockedAddress(ip), ip);
  }
  for (const ip of ["8.8.8.8", "142.250.72.14", "2607:f8b0:4004:800::200e", "2002:808:808::1"]) assert.ok(!isBlockedAddress(ip), ip);
  // Embedded IPv4 in non-dotted notations, as produced by WHATWG URL normalization.
  for (const ip of ["::ffff:a9fe:a9fe", "::ffff:7f00:1", "::169.254.169.254", "::a9fe:a9fe", "2002:a9fe:a9fe::1", "64:ff9b::a9fe:a9fe", "0:0:0:0:0:ffff:10.0.0.1"]) {
    assert.ok(isBlockedAddress(ip), ip);
  }
  assert.equal(new URL("http://[::ffff:169.254.169.254]/").hostname, "[::ffff:a9fe:a9fe]");
  assert.ok(isBlockedAddress("::ffff:a9fe:a9fe"), "normalized URL form is blocked");
});

test("origins must be bare scheme://host[:port]", () => {
  assert.doesNotThrow(() => parseOrigin("https://api.example.com"));
  for (const bad of ["https://api.example.com/path", "https://u:p@api.example.com", "ftp://x.example.com", "https://x.example.com?q=1"]) assert.throws(() => parseOrigin(bad), bad);
});

test("private destinations are refused outside isolated test mode, before any submission", async () => {
  const server = http.createServer((_req, res) => res.end("{}"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(
      safeRequest({ origin: `http://127.0.0.1:${port}`, method: "POST", path: "/x", headers: {}, body: "{}", timeoutMs: 2000, maxResponseBytes: 1024, policy: { allowPrivateNetwork: true, isolatedTestMode: false } }),
      (e: unknown) => e instanceof SafeRequestError && e.submission === "not_submitted",
    );
    await assert.rejects(
      safeRequest({ origin: `http://localhost:${port}`, method: "GET", path: "/x", headers: {}, timeoutMs: 2000, maxResponseBytes: 1024, policy: { allowPrivateNetwork: false, isolatedTestMode: true } }),
      (e: unknown) => e instanceof SafeRequestError && e.submission === "not_submitted",
    );
    const ok = await safeRequest({ origin: `http://127.0.0.1:${port}`, method: "GET", path: "/x", headers: {}, timeoutMs: 2000, maxResponseBytes: 1024, policy: { allowPrivateNetwork: true, isolatedTestMode: true } });
    assert.equal(ok.status, 200);
  } finally {
    server.close();
  }
});

test("redirects are returned, never followed", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { location: "http://169.254.169.254/computeMetadata/v1/" });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const r = await safeRequest({ origin: `http://127.0.0.1:${port}`, method: "GET", path: "/", headers: {}, timeoutMs: 2000, maxResponseBytes: 1024, policy: { allowPrivateNetwork: true, isolatedTestMode: true } });
    assert.equal(r.status, 302);
  } finally {
    server.close();
  }
});

test("browser egress proxy forwards only the approved origin and refuses everything else", async () => {
  const target = http.createServer((req, res) => res.end(`ok ${req.url} host=${req.headers.host}`));
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  const port = (target.address() as { port: number }).port;
  const origin = new URL(`http://127.0.0.1:${port}`);
  const proxy = await startEgressProxy(origin, "127.0.0.1");
  const p = new URL(proxy.url);
  const viaProxy = (absUrl: string, method = "GET") =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = http.request({ host: p.hostname, port: p.port, method, path: absUrl }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      r.on("error", reject);
      r.end();
    });
  try {
    const ok = await viaProxy(`http://127.0.0.1:${port}/form?x=1`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, `ok /form?x=1 host=127.0.0.1:${port}`);
    assert.equal((await viaProxy("http://169.254.169.254/computeMetadata/v1/")).status, 403);
    assert.equal((await viaProxy(`http://127.0.0.1:${port + 1}/`)).status, 403, "other ports on the same host are refused");
    const tunnel = await new Promise<number>((resolve) => {
      const r = http.request({ host: p.hostname, port: p.port, method: "CONNECT", path: "example.com:443" });
      r.on("connect", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });
      r.on("response", (res) => resolve(res.statusCode ?? 0));
      r.on("error", () => resolve(-1));
      r.end();
    });
    assert.equal(tunnel, 403);
  } finally {
    await proxy.close();
    target.close();
  }
});

test("runtime refuses demo authentication in production or on a public listener", () => {
  const base = { VAP_DATABASE_URL: "postgres://x/y", VAP_DIGEST_KEY: "k".repeat(40) };
  assert.throws(() => loadConfig({ ...base, VAP_ENV: "production", VAP_AUTH_MODE: "demo", VAP_HOST: "127.0.0.1" }), /production/);
  assert.throws(() => loadConfig({ ...base, VAP_ENV: "development", VAP_AUTH_MODE: "demo", VAP_HOST: "0.0.0.0" }), /loopback/);
  assert.throws(() => loadConfig({ ...base, VAP_ENV: "development", VAP_AUTH_MODE: "demo", VAP_HOST: "127.0.0.1", K_SERVICE: "vap-api" }), /Cloud Run/);
  assert.throws(() => loadConfig({ ...base, VAP_ENV: "production", VAP_AUTH_MODE: "oidc" }), /AUDIENCE/);
  assert.throws(() => loadConfig({ VAP_DATABASE_URL: "postgres://x/y", VAP_ENV: "production", VAP_AUTH_MODE: "oidc", VAP_OIDC_AUDIENCE: "a" }), /DIGEST_KEY/);
  assert.throws(() => loadConfig({ ...base, VAP_ENV: "production", VAP_OIDC_AUDIENCE: "a", VAP_ISOLATED_TEST_MODE: "1" }), /isolated/);
  assert.doesNotThrow(() => loadConfig({ ...base, VAP_ENV: "development", VAP_AUTH_MODE: "demo", VAP_HOST: "127.0.0.1" }));
});

test("CLI workspace containment rejects traversal, symlinks and absolute paths", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vap-unit-"));
  const ws = path.join(root, "op_aaaaaaaaaaaaaaaaaaaa");
  mkdirSync(path.join(ws, "docs"), { recursive: true });
  writeFileSync(path.join(ws, "docs/a.txt"), "x");
  const outside = path.join(root, "outside.txt");
  writeFileSync(outside, "secret");
  let symlinked = true;
  try {
    symlinkSync(outside, path.join(ws, "link.txt"));
  } catch {
    symlinked = false; // platforms without symlink permission
  }
  const a = new CliAdapter({ id: "cli.t", version: "0.1.0", workspace_root: root, recipes: [] });
  assert.ok((await a.containedPath(ws, "docs/a.txt", true)).endsWith("a.txt"));
  await assert.rejects(a.containedPath(ws, "../outside.txt", false));
  await assert.rejects(a.containedPath(ws, "docs/../../outside.txt", false));
  await assert.rejects(a.containedPath(ws, path.resolve(outside), false));
  if (symlinked) await assert.rejects(a.containedPath(ws, "link.txt", true));
});

test("the reference configuration builds a registry whose adapters pass static conformance", async () => {
  const cfg = loadAdaptersConfig(CONFIG_PATH, { VAP_WORKSPACE_ROOT: mkdtempSync(path.join(tmpdir(), "vap-ws-")) });
  const registry = buildRegistry(cfg, { isolatedTestMode: true, enableBrowser: true });
  assert.match(registry.policyRevision, /^pol_[0-9a-f]{32}$/);
  for (const t of registry.adapters()) {
    const findings = (await staticConformance(t)).filter((f) => f.severity === "error");
    assert.deepEqual(findings, [], t.id);
  }
  const ids = registry.listActions().map((a) => a.descriptor.id);
  for (const id of ["issues.create", "issues.update_owner", "issues.batch_create", "cli.write_file", "cli.restore_snapshot", "browser.issues.create_via_form"]) assert.ok(ids.includes(id), id);
  const tiers = Object.fromEntries(registry.listActions().map((a) => [a.descriptor.id, a.descriptor.risk_tier]));
  assert.equal(tiers["issues.update_owner"], 1);
  assert.equal(tiers["issues.create"], 2);
  assert.equal(tiers["issues.create_and_notify"], 3);
});
