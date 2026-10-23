# Deterministic benchmark results (v0.1 candidate, commit 90b45ee)

Methodology: [benchmark-methodology.md](benchmark-methodology.md). Three independent Cloud Build
runs (`0655e173`, `bf06b3fe`, `3e5cea0b`), each with 5 repeats per scenario and condition, on
`E2_HIGHCPU_8` (8 vCPU AMD EPYC 7B12), Node 24.21.0, PostgreSQL 17.6 in the build network. Ground
truth comes from the fixture's authoritative state and write log. **No model was involved; the
model benchmark was not run.** Raw rows are in each run's `benchmark-report.json` in the private
evidence location.

## Correctness (identical in all three runs)

| Scenario | Baseline: verified / false success / duplicate writes | VAP: verified / false success / duplicate writes |
|---|---|---|
| S1 normal | 5/5 · 0/5 · 0 | 5/5 · 0/5 · 0 |
| S2 lost reply after commit | 5/5 · 0/5 · **5** | 5/5 · 0/5 · 0 |
| S3 5xx after commit | 5/5 · 0/5 · **5** | 5/5 · 0/5 · 0 |
| S4 delayed visibility | 5/5 · 0/5 · 0 | 5/5 · 0/5 · 0 |
| S5 validation rejection | 0/5 · 0/5 · 0 | 0/5 · 0/5 · 0 |
| S6 concurrent independent edit | 5/5 · 0/5 · 0 | 5/5 · 0/5 · 0 |
| S7 partial batch (2 of 4 applied) | 0/5 · **5/5** · 0 | 0/5 · 0/5 · 0 |

Reading the table:

- In S2 and S3 the baseline's naive retry reached the right end state but wrote twice every time
  (5 of 5). VAP reconciled through the destination's request-key lookup and wrote once.
- In S7 the baseline reported success for every partially applied batch (a 207 is a 2xx). VAP
  reported `partially_applied`, never success.
- S5 is an expected failure for both: the destination rejects the request, and neither condition
  claims success.
- Caveat on S6: the concurrent edit landed before preparation in every repeat, so this harness did
  not actually exercise the race. Native conditional-write protection against racing writers is
  covered by the T06 conformance tests, not by this benchmark row.
- Duplicate writes are counted as extra destination version increments. A repeated owner update
  leaves the same final value, but in a real system it can repeat notifications or audit
  entries.

## Performance (metadata path)

10 concurrent clients, 1000 operations per run (prepare, then accept and read latency measured):

| Run | Accept p50 / p95 (ms) | Read p50 / p95 (ms) | Dispatch incl. destination, 1000 ops |
|---|---|---|---|
| `0655e173` | 49.6 / 56.8 | 2.1 / 3.1 | 5.7 s |
| `bf06b3fe` | 56.7 / 64.2 | 2.4 / 3.3 | 5.8 s |
| `3e5cea0b` | 60.2 / 71.0 | 3.1 / 4.0 | 6.3 s |

All 3000 operations ended `completed`. Acceptance latency includes the keyed-digest computation,
grant locking, approval and limit checks, and the transactional insert of the operation, first
event and outbox row. These are measurements on one build machine type with a co-located
database, not service-level objectives.
