/**
 * CloudExecutor (spec section 14). The API calls submit() after durably accepting work;
 * it is a latency optimisation only. Durable work never depends on it: the outbox plus
 * the scheduled sweeper recover anything a lost submit() leaves behind, and duplicate
 * starts are harmless because a worker must obtain the operation claim before dispatch.
 */
export interface CloudExecutor {
  readonly name: string;
  submit(operationId: string): Promise<{ execution_id: string } | null>;
  status(executionId: string): Promise<"pending" | "running" | "succeeded" | "failed" | "unknown">;
  cancel(executionId: string): Promise<void>;
  collectArtifacts(executionId: string): Promise<{ name: string; object_id: string }[]>;
  cleanup(executionId: string): Promise<void>;
}

/** Runs dispatch in the same process (ephemeral demo and test profile). */
export class InlineExecutor implements CloudExecutor {
  readonly name = "inline";
  private seq = 0;
  constructor(private readonly drain: (operationId: string) => Promise<void>) {}

  async submit(operationId: string): Promise<{ execution_id: string }> {
    const id = `inline-${++this.seq}`;
    setImmediate(() => {
      this.drain(operationId).catch(() => {
        // The outbox and sweeper retain the work; errors are logged by the drain loop.
      });
    });
    return { execution_id: id };
  }
  async status(): Promise<"unknown"> {
    return "unknown";
  }
  async cancel(): Promise<void> {}
  async collectArtifacts(): Promise<{ name: string; object_id: string }[]> {
    return [];
  }
  async cleanup(): Promise<void> {}
}

/** Disables immediate dispatch; a separately running worker drains the outbox. */
export class NoopExecutor implements CloudExecutor {
  readonly name = "none";
  async submit(): Promise<null> {
    return null;
  }
  async status(): Promise<"unknown"> {
    return "unknown";
  }
  async cancel(): Promise<void> {}
  async collectArtifacts(): Promise<{ name: string; object_id: string }[]> {
    return [];
  }
  async cleanup(): Promise<void> {}
}
