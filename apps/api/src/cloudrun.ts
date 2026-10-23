import { metadataAccessToken } from "@vap/core";
import type { CloudExecutor } from "@vap/core";

/**
 * GCP CloudExecutor: starts one Cloud Run job execution per accepted operation. A lost
 * launch acknowledgement is harmless because the outbox and the scheduled sweeper keep the
 * work, and a worker must win the operation claim before dispatch. Cloud Run job retries
 * must be disabled (max-retries 0) for mutation jobs: VAP owns retry decisions.
 */
export class CloudRunJobExecutor implements CloudExecutor {
  readonly name = "cloud-run-job";
  constructor(
    /** projects/PROJECT/locations/REGION/jobs/NAME */
    private readonly job: string,
    private readonly token: () => Promise<string> = metadataAccessToken,
  ) {
    if (!/^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/jobs\/[a-z0-9-]+$/.test(job)) {
      throw new Error("VAP_WORKER_JOB must look like projects/PROJECT/locations/REGION/jobs/NAME");
    }
  }

  async submit(operationId: string): Promise<{ execution_id: string } | null> {
    const res = await fetch(`https://run.googleapis.com/v2/${this.job}:run`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json" },
      body: JSON.stringify({ overrides: { containerOverrides: [{ args: ["apps/worker/dist/main.js", "run-operation", operationId] }], taskCount: 1 } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Cloud Run job launch failed with HTTP ${res.status}`);
    const body = (await res.json()) as { name?: string; metadata?: { name?: string } };
    return { execution_id: body.metadata?.name ?? body.name ?? "unknown" };
  }

  async status(executionId: string): Promise<"pending" | "running" | "succeeded" | "failed" | "unknown"> {
    const res = await fetch(`https://run.googleapis.com/v2/${executionId}`, { headers: { authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return "unknown";
    const b = (await res.json()) as { succeededCount?: number; failedCount?: number; runningCount?: number; completionTime?: string };
    if ((b.succeededCount ?? 0) > 0) return "succeeded";
    if ((b.failedCount ?? 0) > 0) return "failed";
    if ((b.runningCount ?? 0) > 0) return "running";
    return b.completionTime ? "unknown" : "pending";
  }

  async cancel(executionId: string): Promise<void> {
    await fetch(`https://run.googleapis.com/v2/${executionId}:cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
  }

  async collectArtifacts(): Promise<{ name: string; object_id: string }[]> {
    return [];
  }

  async cleanup(): Promise<void> {
    // Executions are retained by Cloud Run under its own retention policy.
  }
}
