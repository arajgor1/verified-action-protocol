import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { buildRegistry, loadAdaptersConfig } from "@vap/adapters";
import { Coordinator, createLogger, GcsArtifactStore, InlineExecutor, metadataAccessToken, registerSensitiveValue } from "@vap/core";
import type { ArtifactStore, CloudExecutor, Logger } from "@vap/core";
import { assertSchemaCurrent, migrate, PgArtifactStore, PgJournal } from "@vap/store-postgres";
import { CloudRunJobExecutor } from "./cloudrun.js";
import type { RuntimeConfig } from "./config.js";

export interface Runtime {
  coordinator: Coordinator;
  journal: PgJournal;
  log: Logger;
  workerId: string;
  close(): Promise<void>;
}

export function newWorkerId(prefix = "wk"): string {
  return `${prefix}-${hostname().slice(0, 24)}-${process.pid}-${randomBytes(4).toString("hex")}`;
}

/** Wires journal, adapters, artifact store, executor and coordinator from configuration. */
export async function createRuntime(cfg: RuntimeConfig, opts: { dispatchMode?: RuntimeConfig["dispatchMode"]; log?: Logger } = {}): Promise<Runtime> {
  // Secrets are scrubbed from any later output and removed from this process's environment so
  // child processes and accidental dumps of process.env do not carry them. (The kernel's copy of
  // the initial environment remains readable to same-uid processes; see docs/limitations.md.)
  registerSensitiveValue(cfg.databaseUrl);
  registerSensitiveValue(cfg.digestKey);
  for (const k of ["VAP_DATABASE_URL", "VAP_DIGEST_KEY", "VAP_MIGRATION_DATABASE_URL"]) delete process.env[k];
  const log = opts.log ?? createLogger({ base: { service: "vap", env: cfg.env } });
  const journal = new PgJournal({ connectionString: cfg.databaseUrl });
  if (process.env.VAP_AUTO_MIGRATE === "1") {
    if (cfg.env === "production") throw new Error("VAP_AUTO_MIGRATE is not allowed in production; run migrations with the migration identity");
    await migrate(journal.pool);
  }
  await assertSchemaCurrent(journal.pool);
  if (cfg.enableBrowser) {
    log.warn("the browser adapter is experimental and outside the supported v0.1 scope; point it only at operator-trusted origins (docs/security/browser-image-assessment.md)");
  }
  const registry = buildRegistry(loadAdaptersConfig(cfg.adaptersConfigPath), { isolatedTestMode: cfg.isolatedTestMode, enableBrowser: cfg.enableBrowser });
  const artifacts: ArtifactStore = cfg.evidenceBucket ? new GcsArtifactStore(cfg.evidenceBucket, metadataAccessToken) : new PgArtifactStore(journal.pool);
  const mode = opts.dispatchMode ?? cfg.dispatchMode;
  const workerId = newWorkerId(mode === "inline" ? "api" : "wk");
  let coordinator: Coordinator | null = null;
  let executor: CloudExecutor | null = null;
  if (mode === "inline") {
    executor = new InlineExecutor(async () => {
      await coordinator?.drainOutbox(workerId, 25);
    });
  } else if (mode === "cloud-run-job") {
    executor = new CloudRunJobExecutor(cfg.workerJob!);
  }
  coordinator = new Coordinator(journal, registry, {
    digestKey: cfg.digestKey,
    deploymentId: cfg.deploymentId,
    log,
    executor,
    artifacts,
    claimLeaseMs: cfg.claimLeaseMs,
    maxReconcileAttempts: cfg.maxReconcileAttempts,
  });
  // Bootstrap subjects get roles only when they have none yet, so a later revocation by an
  // operator is not undone by a restart. A subject in both lists gets the union.
  const bootstrap = new Map<string, Set<"operator" | "viewer" | "approver">>();
  for (const s of cfg.bootstrapOperators) bootstrap.set(s, new Set<"operator" | "viewer" | "approver">([...(bootstrap.get(s) ?? []), "operator", "viewer"]));
  for (const s of cfg.bootstrapApprovers) bootstrap.set(s, new Set<"operator" | "viewer" | "approver">([...(bootstrap.get(s) ?? []), "approver"]));
  await journal.transaction(async (tx) => {
    for (const [s, roles] of bootstrap) await tx.insertPrincipalIfAbsent(s, [...roles]);
  });
  return {
    coordinator,
    journal,
    log,
    workerId,
    close: async () => {
      await registry.closeAll();
      await journal.close();
    },
  };
}
