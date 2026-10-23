# Tutorial: wrap another issue tool with VAP

This walks through what the GitHub adapter (`packages/adapters/src/github-adapter.ts`) does, so
you can write the same thing for Jira, Linear, GitLab or an internal tracker. The hard part is
not creating an issue. It is knowing what happened when the create's reply never arrives.

## 1. Decide what "the same issue" means

Pick a logical identity every attempt can recompute from facts it already has. The demo uses
`deriveWorkflowId({ repository, commit, buildEvent, task })` (`demo/ci-failure/lib/workflow.ts`):
a SHA-256 over those facts, shortened to `vapwf-<24 hex>`. A restarted agent or runtime gets the
same value; nothing random goes into it. It is not secret, so it can be written to the issue.

Use it twice:

- as the VAP **request key** (`ci-issue:<workflow id>`), so the runtime returns the existing
  operation instead of starting another one;
- as a **marker in the destination**, so the adapter can find the issue later.

## 2. Find out what your destination can promise

| Question | GitHub issues | What it means for the adapter |
|---|---|---|
| Does it deduplicate requests by key? | No | `retry_mode: "no_automatic_retry"`; the core never resubmits on its own |
| Can you look a request up and seal it so late arrivals are rejected? | No | lookup can say "applied", never a definitive "not applied" |
| Can you find an object by something you wrote into it? | Yes (list and scan the body) | marker scan is the lookup |
| Are reads immediately consistent? | Reads by number usually are; listings lag | `state_source: "eventually_consistent_api"` |
| Can the effect be undone? | Issues can be closed, not deleted; notifications cannot be recalled | side effects `compensable` + `irreversible`, so tier 3 (human approval) |

If your tracker supports an idempotency key with sealed lookups, declare `destination_dedup`
and return definitive answers, and the core can safely resubmit after a confirmed non-apply.
Do not claim it if the API does not guarantee it.

## 3. Implement the adapter contract

The interface is in `packages/core/src/adapter.ts`. The parts that matter:

- **`prepare`**: validate and sanitize arguments (the demo strips ANSI, redacts secret-shaped
  values and bounds error output), check the target is inside the grant, and render a preview.
  The sanitized arguments become the immutable plan.
- **`execute`**: call `ctx.recheck()` right before the network call, then map the response:
  - 201 with a parseable body: `completed`, with an effect URI such as `github://owner/repo/issues/42`;
  - 4xx: `failed`, `submission: "submitted"` (the destination saw and refused it);
  - connect failure before sending: `failed`, `submission: "not_submitted"`;
  - reply lost after the connection, or 5xx: `unknown`, `submission: "maybe_submitted"`.
  Never turn "I did not get an answer" into "it did not happen".
- **`lookup`**: search the destination for the marker, and accept a candidate only if:
  - it is in the expected project or repository;
  - it was authored by the identity the adapter authenticates as;
  - it carries the planned content;
  - it was created after the operation was accepted.

  Found means `applied` (with `definitive: true`, plus the effect and result summary). Not found
  or lookup error means `unknown`, `definitive: false`.

  Report how you know: the demo sets `origin: inferred_from_lookup` here and
  `observed_create_response` when the create's own reply named the issue. A lookup shows that the
  required object exists; unless the destination records a request id, it does not prove that
  this operation created it, so say so. The core then keeps the operation unknown, retries the lookup
  up to `VAP_MAX_RECONCILE_ATTEMPTS`, and escalates to an operator. It never creates again.
- **`verify`**: read the saved object from the destination and return facts; the core evaluates
  the predicate. The demo reports `has_failing_test`, `has_commit_sha`, `has_repro_steps`,
  `has_error_output`, `secret_free` for the issue, and `matching_issue_count` for the workflow
  (a listing that does not yet show the known issue is reported as `stale`, not as a failure).

## 4. Register it

Add a config key and constructor call in `packages/adapters/src/config.ts` (see how `github` is
wired, including the `VAP_GITHUB_*` overrides), and an example config under `examples/config/`.
Credentials are referenced by environment variable name only; register their values with
`registerSensitiveValue` so they are scrubbed from every log and record.

## 5. Write the agent side

Resume by key before doing anything else (`demo/ci-failure/lib/agents.ts`, `runVapAgent`):

1. recompute the workflow id;
2. `client.findOperation(actionId, requestKey)`; if it exists, follow it;
3. otherwise open a task with the checks, prepare, get approval, execute with the key;
4. on `unknown`, call `reconcile` and stop with an honest "unknown" if it escalates.

## 6. Test it against faults, not just the happy path

Copy `tests/demo/ci-failure.test.ts`. Put the test-only fault proxy
(`demo/ci-failure/lib/fault-proxy.ts`) in front of your destination and cover at least: lost reply
after commit, delayed visibility, rejection, lookups unavailable, duplicate submission, changed
payload under the same key, and a runtime crash while the reply is in flight. Judge every run
from the destination's state and the proxy's private records, never from the agent's report.
