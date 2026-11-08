# Outcomes: requested, submitted, completed, verified, partially applied, unknown

VAP never collapses an action's result into one success flag. Every operation carries three
independent dimensions, and a derived `outcome` for display.

## Dimensions

| Field | Values | Owned by |
|---|---|---|
| `execution_status` | `queued`, `running`, `completed`, `failed`, `partial`, `unknown`, `cancelled` | dispatch and reconciliation |
| `verification_status` | `not_requested`, `pending`, `passed`, `failed`, `inconclusive` | verifier, from named checks |
| `recovery_status` | `none`, `requested`, `running`, `succeeded`, `failed`, `unknown` | linked recovery operations |

Plans have their own status: `prepared`, `awaiting_approval`, `denied`, `expired`, `stale`.
An operation exists only after a request is **durably accepted**.

## Execution status meaning

| Status | Meaning | Permitted next |
|---|---|---|
| `queued` | Recorded, not yet submitted. | `running`, `cancelled`, `failed` (denied at dispatch revalidation) |
| `running` | A durable dispatch intent exists; submission may have occurred. | `completed`, `failed`, `partial`, `unknown` |
| `completed` | Adapter execution finished. Verification may still fail or be inconclusive. | (verification and recovery only) |
| `failed` | Failure established, with an explicit effect summary (often `not_applied`). | — |
| `partial` | A known subset of intended effects occurred; per-item effects listed. | — |
| `unknown` | Submission or effects cannot be established. Reconcile before any retry. | `completed`, `partial`, `failed` via reconciliation or operator resolution |
| `cancelled` | No further execution; recorded only when effects are known (normally none). | — |

## Derived outcome

| execution_status | verification_status | outcome |
|---|---|---|
| queued | any | **requested** |
| running | any | **submitted** |
| completed | passed | **verified** |
| completed | failed | **verification_failed** |
| completed | not_requested, pending, inconclusive | **completed_unverified** |
| partial | any | **partially_applied** |
| failed | any | **failed** |
| cancelled | any | **cancelled** |
| unknown | any | **unknown** |

`verified` requires that every check bound to the plan passed. Missing evidence is never a pass.
A plan with no checks can reach `completed_unverified` but never `verified`.

## Task-level completion

`GET /v1/tasks/{id}/outcome` reports `verified_complete: true` only when every required check of
the **current contract revision** has passing evidence within its `freshness.max_age_seconds`,
and no operation of the task is unresolved (`queued`, `running`, `unknown`) or has an
unresolved recovery. Evidence from an older revision does not count.

## Retry guidance

Every receipt includes `retry_guidance.disposition`:

| Disposition | When |
|---|---|
| `retry_with_same_key` | queued; resend the same request key, never prepare a duplicate |
| `do_not_retry` | running, completed, partial, or failed after some effects applied |
| `reconcile_first` | unknown, or any effect unknown |
| `safe_to_retry` | failed or cancelled with every effect `not_applied`; prepare a new plan and key |

HTTP failure alone never proves that a submitted effect did not occur; transport errors on
mutations surface as `OUTCOME_UNKNOWN` in the client.
