# ADR 0004: Sealed destination lookups and per-attempt destination keys

Status: accepted

A lookup that returns "not found" proves nothing on its own: the original request may still be
in flight. Reconciliation therefore uses a sealing lookup (`GET /requests/{key}?seal=1`) that
atomically records the key as sealed when absent, so any later arrival of the original request
is rejected. Only then is "not found" definitive.

Because the original key is sealed, a resubmission cannot reuse it. Attempt 1 uses the operation
id as the destination key; later attempts use `<operation id>.a<n>`. Reconciliation always looks
up the key of the latest attempt. Resubmission happens only in the worker's automatic path, for
actions whose destination deduplicates by key, within the attempt budget, and only while the plan
and grant are still valid. The API reconcile endpoint never resubmits.

Consequence: destination write logs show at most one applied write per logical operation even
when a key is sealed and a fresh attempt runs.
