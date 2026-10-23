# Model benchmark interface (not run)

This directory defines how a model-driven comparison is to be run. It was **not run** for v0.1
because no model runner was configured in the build environment.

A runner implements:

```ts
interface ModelRunner {
  model: string;                 // exact model id actually used
  run(task: { scenario: string; tools: "baseline" | "vap" | "observability_only"; budget: { max_steps: number; max_tokens: number } }):
    Promise<{ reported_success: boolean; steps: number; tokens_in: number; tokens_out: number; transcript_ref: string }>;
}
```

Rules:

- identical scenario inputs, destination access, model version, prompt policy and budgets per
  condition; the baseline gets the same underlying tools and information;
- `observability_only` exposes VAP's observations and receipts without durable coordination, to
  separate the value of richer data from the value of the journal;
- at least five repeats per scenario; a held-out set of fault timings not used during prompt
  development; record exclusions;
- ground truth from the fixture, as in `benchmarks/run.ts`;
- metrics: verified completion, false success, unintended effects, recovery success,
  intervention load (human decisions per task), overhead (wall time, calls, bytes, tokens),
  adapter effort;
- publish the model actually used, raw outcomes and uncertainty. Do not claim improvements
  without this data.
