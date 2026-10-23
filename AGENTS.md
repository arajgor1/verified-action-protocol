# Notes for coding agents working in this repository

- **Execution boundary.** Do not install dependencies, compile, run tests, start Docker or run
  browsers on a developer workstation. Submit work with `bash scripts/vap-cloud.sh test --suite all`
  (or `vap cloud test`). Never fall back to local execution when the cloud is unavailable;
  report the gate as BLOCKED. Scripts, tests, benchmarks and demos import `scripts/cloud-guard.ts`
  and refuse to start without `VAP_CLOUD_EXECUTION=1` (set only by the cloud pipelines); never
  set it on a workstation. Not even `--help`: see docs/process-deviations.md.
- **Secrets.** Never search for, open, copy or reference credential files, tokens or
  owner-specific identifiers. Do not add placeholder variables that point at private files.
  Owner values (project, region, buckets) come from the operator's environment at dispatch time.
- **Honesty.** Never mark a gate passed without cloud evidence (build id, commit, image digest,
  checksums). Never fabricate deployments, package URLs or benchmark numbers.
- **Invariants to preserve** (tests enforce them):
  - execution_status and verification_status are separate; `verified` requires every bound check
    to pass on non-stale evidence;
  - a durable dispatch intent precedes every destination call; an expired claim reconciles,
    never resubmits blindly; a stale fence cannot write;
  - identical request keys return the original operation; a reused key with a different plan
    conflicts; plans are immutable and single-use;
  - approvals bind the exact digest, are single-use and never self-issued;
  - recovery is a separate operation with its own evidence; cancellation is never rollback.
- **Where things are.** Protocol: `packages/protocol`. Lifecycle: `packages/core/src/coordinator.ts`.
  Journal: `packages/store-postgres`. Adapters: `packages/adapters`. Gate status:
  `docs/acceptance.md`. Continuation state: `docs/continuation.md`.
