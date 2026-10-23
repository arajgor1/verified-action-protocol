# Architecture and trust boundaries

```
agent ──MCP stdio──▶ apps/mcp ──HTTPS + OIDC──▶ apps/api (gateway, viewer)
                                                   │  Coordinator (packages/core)
                                                   │  policy · plans · lifecycle · verification
                                                   ▼
                                   PostgreSQL journal (packages/store-postgres)
                         tasks · plans · approvals · operations · attempts · events · evidence
                                   outbox · worker_claims · request_key_tombstones
                                                   │ outbox
                                                   ▼
                        apps/worker (Cloud Run job per operation; sweeper on a schedule)
                                                   │ registered adapters only
                        ┌──────────────────────────┼─────────────────────────┐
                        ▼                          ▼                         ▼
                 HTTP adapter               browser adapter             CLI adapter
           (registered origins)     (Playwright, isolated context)  (argument arrays, workspace)
                        │                          │                         │
                        ▼                          ▼                         ▼
                destination API            approved web origin       registered commands
```

## Components

| Component | Owns | Must not |
|---|---|---|
| Gateway (`apps/api`) | OIDC verification, role mapping, body limits, schema validation in and out, rate limits, viewer | trust identity headers or body principals; execute commands |
| Coordinator (`packages/core`) | tasks, plans, acceptance, dispatch, reconciliation, verification, recovery, cancellation | hold a database transaction across an external call; treat a timeout as proof of no effect |
| Policy (`policy.ts`) | grant evaluation, tiers, scope narrowing, approval requirement | accept elevation from agents or application content |
| Journal (`store-postgres`) | durable records, unique request keys, append-only events/evidence, immutable plans, outbox, fences | pretend its transaction covers external systems |
| Worker (`apps/worker`) | claims, dispatch intent, adapter calls, result recording, sweeps | hold deployment-admin rights; load remote plugins |
| Verifier (core + adapter `verify`) | reads, bounded predicate evaluation, freshness, evidence | turn an agent summary into proof |
| Artifact store | redacted evidence bundles by digest | expose public links |
| MCP bridge | ordinary tools over the client | bypass the API |

## Control flow

1. **Task** under an operator grant: scope can only narrow the grant; required checks fixed per revision.
2. **Observe / discover**: authorized reads through registered adapters.
3. **Prepare** (read-only): validate arguments, read resource versions, evaluate grant and task
   scope for the affected resources, enforce item caps, freeze checks, policy revision and grant
   revocation revision, compute the keyed digest, set expiry (default 5 minutes).
4. **Approve** (tier 2 unless preauthorized, tier 3 always): an approver, not the executing
   principal, decides on the exact digest.
5. **Execute**: one transaction checks the request key, revalidates the plan and grant, consumes
   the approval, inserts the operation, appends `operation.accepted` and an outbox record.
6. **Dispatch**: a worker wins the operation claim (monotonic fence), revalidates, durably records
   `dispatch.intent`, rechecks claim and authorization, then calls the adapter outside any
   transaction, and records the result under the fence.
7. **Verify**: named checks read persisted state and produce evidence; the operation's
   verification status is aggregated from the latest evidence per check.
8. **Reconcile** unknown or orphaned operations through destination lookup; resubmit only after a
   sealed, definitive "not found" under a deduplication contract, with a fresh destination key.
9. **Recover** through a declared strategy as a separate plan and operation.

## Trust boundaries

- Adapters and verifiers are reviewed code in the pinned image, or declarative HTTP mappings
  installed by the operator. Nothing is loaded from manifests or callers.
- The CLI adapter accepts registered programs and typed arguments only. It is not a sandbox for
  hostile code.
- VAP coordination cannot stop a human or another client from changing a destination directly.
  Native conditional writes protect supported writes; best-effort mode says so.

## Deployment profiles

| Profile | Shape |
|---|---|
| Ephemeral cloud demo | one Cloud Build: disposable PostgreSQL container, fixture, API and inline dispatch |
| Test pipeline | Cloud Build with PostgreSQL service container; each test file gets fresh databases |
| Durable (GCP) | Cloud Run API (IAM-protected) → Cloud Run worker job per operation (max retries 0), Cloud Scheduler → sweeper job, Cloud SQL PostgreSQL, private evidence bucket, Artifact Registry |

Container-local files are temporary and never the journal. The CLI adapter's workspaces live in
the worker container; a lost container means snapshot recovery is unavailable for that
operation, and reconciliation reports `unknown`.
