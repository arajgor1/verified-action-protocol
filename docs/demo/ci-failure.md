# Demo: a failed build becomes one verified GitHub issue, and the agent resumes safely after a lost reply or a crash

An agent runs a project's tests in the cloud. When a test fails, it files a GitHub issue with
the failing test, the commit SHA, reproduction steps and sanitized error output. It then checks
that the issue exists and says what it should.

The interesting part is what happens when the agent loses confirmation of the create. Either
the reply never comes back, or the process running the agent dies mid-request. If the agent
simply retries, you get two issues. If it gives up, it may report a failure that never happened.

**Question:** when an agent loses confirmation of an external action, does VAP help it work out
what happened and continue correctly, and what does that cost?

**What the runs show** (numbers in [ci-failure-results.md](ci-failure-results.md)):

- **The VAP agent never duplicated an issue and never claimed a success that wasn't backed by the
  saved issue.**
  - In every scenario where the issue could be created and observed, it completed the workflow.
  - When the destination refused the create, it reported a rejection.
  - When the destination could not be inspected at all, it stopped and reported "unknown" instead
    of guessing. That is safely unresolved, not completed.
- **A careful agent without VAP that keeps its own durable intent log produced the same outcomes.**
  The reliability comes from a discipline any client can implement: record the intent before the
  mutation, resume by a stable key, reconcile instead of retrying. VAP is not uniquely capable here.
- **VAP's contribution is reusable execution infrastructure.** It implements that discipline once,
  behind one consistent contract, for every agent and integration:
  - request-key replay and resume-by-key;
  - explicit execution, verification and recovery states;
  - reconciliation with escalation;
  - read-back verification evidence against the destination;
  - plan-bound approvals;
  - an append-only event history and receipts.
  The cost is runtime infrastructure (PostgreSQL, API, worker) and a few hundred milliseconds of
  extra latency per action in this setup.

## Why a careful client can match it, and what VAP adds anyway

A custom client can be made as safe as VAP for this workflow. The logged baseline does it with a
file on local disk. A production client could use a shared database or a lock service for
durability and coordination across hosts. Nothing about the problem requires VAP.

What VAP changes is who builds and maintains that machinery, and how consistently:

| Concern | Custom client | VAP |
|---|---|---|
| Durable intent, idempotent resume | each integration designs its own store, keys and recovery | built in, same semantics for every action (`request_key`, `POST /v1/operations/lookup`) |
| Unknown outcomes | each client decides when to retry, scan or give up | one state machine: `unknown` → reconcile, with a budget → operator resolution; never a blind resubmit |
| Verification | ad hoc read-back, if any | declared checks evaluated against the destination, stored as evidence |
| Approvals | separate system | plan-bound, digest-bound, single-use approvals tied to risk tiers |
| Audit | logs, if kept | append-only events, receipts, retry guidance |
| Integration effort | per tool, per agent | one adapter per destination (this one is about 650 lines) reused by any agent through the SDK, REST or MCP |

## What you see in the demo

The transcript [evidence/ci-demo-transcript.md](evidence/ci-demo-transcript.md) comes from a
real Cloud Build run. The sequence:
1. The tests run and one fails.
2. The plan is approved.
3. The operation is accepted and its intent journaled before the create is sent.
4. GitHub accepts the create, but the reply is lost.
5. The runtime reports `unknown` with `reconcile_first` guidance.
6. A lookup finds nothing yet, so the agent does not create again.
7. The runtime is killed with SIGKILL and restarted.
8. A new agent instance recomputes the workflow id and finds the same operation by key.
9. Reconciliation finds the issue, and both read-back checks pass.
10. The evaluator confirms exactly one matching issue.

The script exits non-zero unless every step is actually observed.

## How it works

1. **One logical identity.** The workflow id is a hash of the repository, commit, build event and
   task. Any attempt can recompute it, so a restarted agent never starts a new logical task. It is
   used as the VAP request key and as a non-secret marker on the issue's first line.
2. **Intent before mutation.** VAP journals the operation and a dispatch intent before the GitHub
   call. After a crash, the sweeper sees an expired claim and reconciles instead of resubmitting.
3. **Unknown means unknown.** A lost reply or a 5xx leaves the operation `unknown`. The adapter's
   lookup accepts only an issue that meets all of these:
   - it is in the expected repository;
   - it was authored by the adapter's authenticated identity (the GitHub App bot);
   - it carries the workflow marker and exactly the planned title and body;
   - it was created after the operation was accepted.

   Anything else keeps the operation `unknown`. GitHub cannot prove a create never happened, so
   the adapter never declares "not applied", and VAP never creates again by itself. When the
   lookup budget runs out, an operator is asked.
4. **Existence is separate from origin.** Read-back checks establish that the required issue
   exists with the required content, and that it is the only one. Origin is reported separately:
   - `observed_create_response` when GitHub's reply to this operation named the issue;
   - `inferred_from_lookup` after a lost reply.

   Inferred means consistent with this operation, **not proven**. GitHub keeps no request id, and
   another actor using the same app identity could file the same content. VAP reports that
   uncertainty and does not claim authorship.
5. **Approvals are a policy, not a constant.** In this demo the action declares watcher
   notifications, which cannot be recalled, as a side effect. That puts it in risk tier 3, and VAP
   requires a plan-bound human approval for every tier-3 plan. Actions with reversible effects
   (tier 2 and below) can be preauthorized in a grant and need no per-operation approval.

   The comparison applies the same policy to every condition: one approval before each planned
   create. All approvals are scripted and instantaneous, so **human approval latency is excluded
   from every measurement**.

Adapter internals, and how to wrap another tracker the same way:
[tutorial-wrap-issue-tool.md](tutorial-wrap-issue-tool.md).

## Run it

Everything runs in Cloud Build. Project scripts refuse to start anywhere else.

```bash
bash scripts/vap-cloud.sh test --suite demo
```

That command runs, in order:
- the demo tests: contract tests including attribution, plus all nine scenarios end to end with
  real runtime processes;
- the demo script, which writes the transcript and receipt;
- the comparison harness: four conditions, 5 runs each.

To check a release image, run the same sequence and scenarios against the API and worker shipped
in that exact digest:

```bash
bash scripts/vap-cloud.sh image-gate --image <region>-docker.pkg.dev/<project>/vap/vap@sha256:<digest>
```

Created resources and cleanup: [ci-failure-cleanup.md](ci-failure-cleanup.md). Real GitHub
(blocked until the owner provides a repository, credentials, limits and authorization):
[real-github-setup.md](real-github-setup.md).

## Limitations

- **Duplicates are less likely, not impossible.** GitHub cannot deduplicate creates, so exactly-once
  creation is not guaranteed.
- **Origin after a lost reply is inferred, not proven.**
- **Lookups scan a bounded window.** Flooding the repository can keep an operation unknown.
- **A planted copy cannot fake success, but it can block verification.** An issue from another
  account that quotes the marker never resolves an operation, but it makes the uniqueness check
  fail.
- **Sanitization is pattern-based.**
- **Approvals are scripted.** Human latency is not measured.
- **The comparison uses scripted policies.** The model-driven comparison has not been run.

More: [../limitations.md](../limitations.md#github-issues-adapter-and-the-ci-failure-demo).
Evidence for the release candidate: [../release/candidate-evidence.md](../release/candidate-evidence.md).
