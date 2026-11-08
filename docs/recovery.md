# Reconciliation, cancellation and recovery

## Reconciliation (unknown and orphaned operations)

An operation becomes `unknown` when submission may have happened but the result was not
established: a lost reply, a timeout after connecting, a destination 5xx, an adapter error after
the pre-submission recheck, surviving child processes, or a worker that died after recording
`dispatch.intent`.

`POST /v1/operations/{id}/reconcile` (and the worker, automatically, with backoff) asks the
adapter's `lookup`:

| Lookup answer | Result |
|---|---|
| applied / partial (by destination request key) | `completed` / `partial`; verification queued |
| not applied, **definitive** (sealed lookup) | worker with a destination-dedup contract: new attempt with a fresh destination key; API reconcile: `failed`, all effects `not_applied` |
| not found but not definitive, error, or no lookup | stays `unknown`; after the retry budget an `operator.resolution_required` event |

The sealed lookup (`GET /requests/{key}?seal=1` on the fixture) records the key as sealed when
it is absent, so the original request can never land later. That is what makes "not found"
definitive and lets a resubmission use a fresh key without risking a duplicate.

An operator can record an out-of-band determination with
`POST /v1/operator/operations/{id}/resolve`; the prior `unknown` history stays in the journal.

## Cancellation

`POST /v1/operations/{id}/cancel` on a queued operation cancels it with no effects. On a running
operation it sets `cancel_requested`; the worker aborts at the next safe point (the adapter's
signal), records what it knows, and reconciles. Cancellation never implies rollback; effects that
already happened remain and are listed. A process that refuses termination is reported as
`unknown` with `survivors_remain`, which is an incident, not a success.

Revoking a grant stops new dispatches (queued operations are denied at revalidation), stales
prepared plans, and requests cancellation of running operations with a
`grant.revoked_after_dispatch` event.

## Recovery

`POST /v1/operations/{id}/recover` with a declared `strategy`:

1. Requires established effects (unknown operations must be reconciled first).
2. The adapter derives a recovery plan: compensating action, arguments built only from recorded
   effects and frozen prior state, effects it covers, effects it cannot cover, and post-recovery
   checks.
3. The recovery plan is prepared under the **current** grant and task scope (fresh
   authorization). If its tier needs approval it waits, like any plan.
4. The recovery runs as a **separate operation** with its own journal, evidence and receipt,
   linked by `recovers_operation_id`.
5. The original's `recovery_status` follows the recovery operation: `requested` → `running` →
   `succeeded` (completed and verified) / `failed` / `unknown`. The original's execution status
   and history never change.

| Action | Strategy | Covers | Does not cover |
|---|---|---|---|
| `issues.update_owner` | compensate: set owner back to the value frozen at preparation | owner change | changes by others in between (the compensating write is itself conditional) |
| `issues.create`, `issues.batch_create` | compensate: close exactly the issues the operation created | created records (closed, not deleted) | — |
| `issues.create_and_notify` | compensate: close the issue | the record | external notification delivery (irreversible) |
| `cli.*` recipes | restore_snapshot of the isolated workspace | workspace files | process, network or external effects |
| `issues.close`, browser recipes | none | — | recovery returns CAPABILITY_UNAVAILABLE |

Partial batches compensate only the items recorded as applied. Unknown items are never
"compensated" blindly.
