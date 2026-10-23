# QA / correctness review (independent, read-only), 2026-10-22

Reviewer: an independent review subagent (same model family as the implementer). Method: code
reading for compile errors and invariant violations; nothing was compiled or executed, so this is
not a substitute for the cloud test gates.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | Blocker | `HTTP_CONFIG_SCHEMA.actions.items` listed `required` keys without `properties`; Ajv strict mode (strictRequired) would throw, breaking every HTTP adapter, runtime startup and integration test | **Fixed.** Required keys declared in `properties` |
| 2 | High | Concurrent identical submissions: key lookup ran before the grant lock, so waiters hit "plan already executed" (CONFLICT) instead of a replay; concurrent approval consumption surfaced as APPROVAL_REQUIRED | **Fixed.** Grant row locked first; same key and plan found by plan lookup replays; lost approval-consumption race retries the transaction |
| 3 | High | `recover()` not idempotent per request key; could start a second compensation while an earlier recovery was unresolved; reset `unknown` to `requested` | **Fixed.** Same key returns the original recovery; refuses (OUTCOME_UNKNOWN) while an earlier recovery is queued, running or unknown; recovery status only moves from none/failed to requested |
| 4 | Medium | Worker reconcile path without claim heartbeat; resubmit transaction not fenced | **Fixed.** Heartbeat for every claim holder; resubmit transaction checks `holdsClaim` |
| 5 | Medium | Viewers could run reconcile and verify (reconcile seals destination keys) | **Fixed.** Owner or operator required (also security finding 6) |
| 6 | Medium | Request-key digest includes the action id, so reusing a key across actions creates a second operation | **Kept, documented.** The specification scopes request keys to deployment, principal and action; docs/protocol/overview.md states this |
| 7 | Medium | T10b could intermittently fail when revocation lands before the recheck | **Fixed.** Test accepts `cancelled` when every effect is `not_applied` |
| L1 | Low | `aggregateVerification` reported `inconclusive` for pass + missing (pending human check) | **Fixed.** Returns `pending` unless a check failed or was inconclusive |
| L2 | Low | 2xx with no recognizable item results reported `completed` with no effects | **Fixed.** Reported as `unknown` |
| L3 | Low | Destination `rejected` treated as definitive not-applied and resubmitted automatically | **Fixed.** `destination_rejected` stops automatic resubmission; the operation fails with effects not applied |
| L4 | Low | Outbox leases never extended | **Fixed.** Leases are heartbeated while an item is processed |
| L5 | Low | `createApiServer` captures the coordinator once, so the harness restart getter does not reach the API | **Kept.** Restart tests use the new coordinator directly; both share the journal |
| L6 | Low | Fixture advisory lock acquired and released on possibly different pool connections | **Fixed.** Single client |
| L7 | Low | `bench` and `schemas:check` scripts pointed at missing files | **Fixed.** `bench` runs `benchmarks/run.ts`; `schemas:check` removed (covered by unit tests) |
| L8 | Low | Re-dispatch of any final operation with an error reports `denied` | **Kept** (cosmetic, internal summary only) |
