# Benchmark methodology

Conformance establishes whether VAP keeps its promises. Benchmarks ask whether those
capabilities change outcomes. Passing conformance does not prove better agent performance, and a
benchmark result never excuses a broken invariant.

## Deterministic harness (`benchmarks/run.ts`)

Runs in the cloud test pipeline (`--suite all`) against real PostgreSQL and the fixture.

- **Conditions**: *baseline* (plain HTTP calls to the same destination, naive retry once on
  error, success = any 2xx) and *VAP* (task, prepare, execute, reconcile when unknown, verify,
  task outcome). Both get identical inputs and destination access.
- **Scenarios** (fixed order and fault timings): normal, lost reply, 5xx after commit, delayed
  visibility, validation rejection, concurrent independent edit, partial batch.
- **Ground truth** comes from the fixture's authoritative state (`/authoritative/{id}`, write
  logs), never from either condition's own report.
- **Metrics**: verified completion (reported success and ground truth), false success (reported
  success while ground truth fails), duplicate effects (extra version increments or records),
  wall time and API calls. Raw rows are published with the summary; repeats default to 5.
- **Performance**: 1000 operations through 10 concurrent clients; p50/p95 for acceptance and
  read latency (metadata path: API and journal). Destination time is reported separately as
  dispatch wall time. Hardware and Cloud Build id are recorded.

The concurrent-edit scenario is a real race: an external writer can change state after VAP has
verified. A VAP "false success" there is reported, not hidden: coordination cannot stop direct
external edits.

## Model benchmarks

`benchmarks/model/README.md` defines the interface for model-driven runs (same model, prompt
policy and budgets per condition, at least five repeats, a held-out set of fault timings, an
optional observability-only condition). No model was available for this release; the report
states `model_benchmark: not_run`. No improvement is claimed without measured evidence.

## Reporting rules

Publish numerators and denominators, run counts, exclusions and the exact configuration. Raw
data stays private or synthetic; the public report contains only safe aggregates and the
reproducible configuration. Default limits are product controls, not service-level objectives.
