import { createRuntime, loadConfig } from "@vap/api";
import type { Runtime } from "@vap/api";

/**
 * VAP worker entry points.
 *
 *   serve                     long-running loop: drain the outbox and sweep periodically
 *                             (ephemeral demo and single-VM profiles)
 *   run-operation <op_id>     one Cloud Run job execution keyed to an operation: dispatch it,
 *                             then drain follow-up work (verify/reconcile) for a bounded time
 *   sweep                     one-shot recovery sweep for Cloud Scheduler: requeue missed
 *                             outbox work, reconcile expired claims, expire keys, retention
 *
 * Worker infrastructure retries must be disabled for mutation jobs; VAP owns retries.
 */

const [, , command = "serve", arg] = process.argv;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function serve(rt: Runtime): Promise<void> {
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const pollMs = Number(process.env.VAP_WORKER_POLL_MS ?? 500);
  const sweepEveryMs = Number(process.env.VAP_SWEEP_INTERVAL_MS ?? 15_000);
  let lastSweep = 0;
  rt.log.info("worker serving", { worker_id: rt.workerId });
  while (!stopping) {
    try {
      if (Date.now() - lastSweep > sweepEveryMs) {
        const s = await rt.coordinator.sweep(rt.workerId);
        if (s.orphaned || s.stranded || s.keys_expired || s.purged) rt.log.info("sweep", { ...s });
        lastSweep = Date.now();
      }
      const n = await rt.coordinator.drainOutbox(rt.workerId, 25);
      if (n === 0) await sleep(pollMs);
    } catch (e) {
      rt.log.error("worker loop error", { error: (e as Error).message });
      await sleep(Math.min(5000, pollMs * 4));
    }
  }
  rt.log.info("worker stopping");
}

async function runOperation(rt: Runtime, operationId: string): Promise<void> {
  if (!/^op_[A-Za-z0-9_-]{8,64}$/.test(operationId)) throw new Error("run-operation requires an operation id");
  const summary = await rt.coordinator.dispatch(operationId, rt.workerId);
  rt.log.info("dispatch finished", { ...summary });
  const deadline = Date.now() + Number(process.env.VAP_JOB_DRAIN_MS ?? 60_000);
  while (Date.now() < deadline) {
    const n = await rt.coordinator.drainOutbox(rt.workerId, 10);
    if (n === 0) {
      const op = await rt.journal.transaction((tx) => tx.getOperation(operationId));
      const pending = await rt.journal.transaction((tx) => tx.hasPendingOutbox(operationId));
      if (!op || !pending) break;
      await sleep(1000);
    }
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.env, "worker");
  const rt = await createRuntime(cfg, { dispatchMode: "none" });
  try {
    if (command === "serve") await serve(rt);
    else if (command === "run-operation") await runOperation(rt, arg ?? "");
    else if (command === "sweep") {
      const s = await rt.coordinator.sweep(rt.workerId);
      const drained = await rt.coordinator.drainOutbox(rt.workerId, 100);
      rt.log.info("sweep complete", { ...s, drained });
    } else throw new Error(`unknown command ${command}`);
  } finally {
    await rt.close();
  }
}

main().catch((e: Error) => {
  process.stderr.write(JSON.stringify({ severity: "ERROR", message: e.message }) + "\n");
  process.exit(1);
});
