// Runs the real VAP runtime (API process + worker process, built from apps/*/dist) as child
// processes against one journal database, so the demo can crash it (SIGKILL) and restart it.
// Demo authentication is loopback-only; the runtime refuses it anywhere else.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/**
 * Where the runtime's compiled apps and example configs come from. Defaults to this source tree;
 * the image gate sets VAP_DEMO_RUNTIME_ROOT=/app to run the API and worker shipped in a release
 * image instead (infra/gcp/cloudbuild.image-gate.yaml).
 */
export const RUNTIME_ROOT = process.env.VAP_DEMO_RUNTIME_ROOT ?? REPO_ROOT;
export const CI_DEMO_CONFIG = path.join(RUNTIME_ROOT, "examples/config/adapters.ci-demo.json");

export interface RuntimeOptions {
  databaseUrl: string;
  digestKey: string;
  /** GitHub API base URL the adapter uses (normally the fault proxy). */
  githubApiBaseUrl: string;
  githubRepository: string;
  /** Extra environment for both processes (e.g. GitHub App variable names for the real layer). */
  env?: Record<string, string>;
  log?: (line: string) => void;
}

export interface VapRuntime {
  apiUrl: string;
  start(): Promise<void>;
  /** Abrupt crash of both processes (no graceful shutdown, no journal flush beyond commits). */
  crash(): Promise<void>;
  stop(): Promise<void>;
  restarts: number;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

export async function createVapRuntime(o: RuntimeOptions): Promise<VapRuntime> {
  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  let api: ChildProcess | null = null;
  let worker: ChildProcess | null = null;
  const env = (): Record<string, string> => ({
    PATH: process.env.PATH ?? "",
    NODE_ENV: "test",
    VAP_ENV: "test",
    VAP_AUTH_MODE: "demo",
    VAP_HOST: "127.0.0.1",
    VAP_PORT: String(port),
    VAP_DATABASE_URL: o.databaseUrl,
    VAP_DIGEST_KEY: o.digestKey,
    VAP_DEPLOYMENT_ID: "ci-demo",
    VAP_ADAPTERS_CONFIG: CI_DEMO_CONFIG,
    VAP_ISOLATED_TEST_MODE: "1",
    VAP_DISPATCH_MODE: "none",
    VAP_AUTO_MIGRATE: "1",
    VAP_GITHUB_API_BASE_URL: o.githubApiBaseUrl,
    VAP_GITHUB_REPOSITORY: o.githubRepository,
    VAP_CLAIM_LEASE_MS: "3000",
    VAP_MAX_RECONCILE_ATTEMPTS: "8",
    VAP_WORKER_POLL_MS: "100",
    VAP_SWEEP_INTERVAL_MS: "1000",
    VAP_LOG_LEVEL: "warn",
    ...(o.env ?? {}),
  });
  const spawnNode = (name: string, args: string[]) => {
    const c = spawn(process.execPath, args, { cwd: RUNTIME_ROOT, env: env(), stdio: ["ignore", "pipe", "pipe"] });
    const forward = (b: Buffer) => {
      for (const line of b.toString("utf8").split("\n")) if (line.trim()) o.log?.(`[${name}] ${line}`);
    };
    c.stdout?.on("data", forward);
    c.stderr?.on("data", forward);
    return c;
  };
  const waitHealthy = async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const r = await fetch(`${apiUrl}/readyz`, { signal: AbortSignal.timeout(1000) });
        if (r.ok) return;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error("VAP API did not become ready");
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const kill = async (c: ChildProcess | null, signal: NodeJS.Signals) => {
    if (!c || c.exitCode !== null || c.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => c.kill("SIGKILL"), 5000);
      c.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
      c.kill(signal);
    });
  };
  const rt: VapRuntime = {
    apiUrl,
    restarts: 0,
    async start() {
      api = spawnNode("api", ["apps/api/dist/main.js"]);
      await waitHealthy();
      worker = spawnNode("worker", ["apps/worker/dist/main.js", "serve"]);
    },
    async crash() {
      await Promise.all([kill(api, "SIGKILL"), kill(worker, "SIGKILL")]);
      api = worker = null;
      rt.restarts++;
    },
    async stop() {
      await Promise.all([kill(api, "SIGTERM"), kill(worker, "SIGTERM")]);
      api = worker = null;
    },
  };
  return rt;
}
