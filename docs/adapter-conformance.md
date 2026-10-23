# Adapter SDK and conformance

## Interface

```ts
manifest(): ActionDescriptor[]
observe(query, ctx): Promise<ObserveResult>
prepare(action, args, ctx): Promise<PrepareResult>          // read-only
execute(plan, ctx): Promise<AdapterResult>                  // call ctx.recheck() right before submitting
lookup(operation, plan, ctx): Promise<LookupResult>         // reconciliation
verify(check, ctx): Promise<VerifyObservation>              // one authoritative read; the core evaluates the predicate
recover(operation, plan, strategy, ctx): Promise<RecoveryPlanSpec>
```

Unsupported methods throw `CAPABILITY_UNAVAILABLE` with a safe explanation (`BaseAdapter` in
`@vap/sdk` does this by default). The context carries authorized targets, a deadline, an abort
signal, the operation id and the destination key, never deployment-admin credentials.

Contract details adapters must honor:

- `execute` reports `submission`: `not_submitted` is a definitive claim. Call `ctx.recheck()`
  immediately before the first byte that could reach the destination; an exception thrown after
  that call is treated as a possible submission (`unknown`).
- Effects are reported per side effect and, for batches, per item, with destination versions.
- `verify` returns facts, source, source version, freshness relative to `ctx.expectedVersion`,
  and limitations. It must perform a real read of persisted state, never echo the request.
- `recover` returns arguments derived only from recorded effects or frozen prior state, the
  effects it covers, the ones it cannot, and post-recovery checks.

## Capability vector

Per action: `state_source`, `concurrency_mode`, `preview_fidelity`, `retry_mode`,
`recovery_modes`, `verification_methods`, `attribution_mode`, `execution_isolation`. Values are
machine-readable; `unavailable` is valid. There is no linear maturity score.

## Profiles

| Profile | Demonstrates | Tests |
|---|---|---|
| Core | journaling and honest states: invalid arguments rejected, unknown preserved, key conflicts, expired plans, version conflicts, redaction | `tests/conformance/*`, `tests/faults/*` |
| Verified | declared checks evaluated on fresh evidence; stale or missing evidence blocks completion | conformance and T07/T13 |
| Recoverable | the declared strategy's post-recovery state is verified, including what cannot be reversed | conformance recovery tests, T08, T18 |

Native or external is provenance (`built_in` / `operator_configured`), not a profile. The
conformance report (`reports/conformance-*.json` from the cloud test pipeline) lists exactly
which profiles each action passed. `/v1/info` shows only *declared* profiles.

`staticConformance(adapter)` in `@vap/sdk` checks descriptors without a destination: schema
validity, tier versus side effects, capability coherence, recovery declarations, and the
`CAPABILITY_UNAVAILABLE` behavior of unsupported methods.

## Loading and supply chain

Adapters are statically registered in the image or installed by the operator as declarative HTTP
configuration. Nothing is downloaded from manifests; a manifest cannot grant permissions. HTTP
mappings are data. Code adapters are trusted application code: review, pinned dependencies and a
new build.
