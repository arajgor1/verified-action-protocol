# Known limitations (v0.1)

These are design boundaries or open items, not bugs to hide.

## By design

- No universal undo and no exactly-once remote side effects. Deduplication holds only where the
  destination supports request keys; VAP never claims more.
- No multi-system atomic transactions. A session is a working context, not a transaction.
- No prompt-injection immunity. Observations are untrusted data; scope is enforced outside the
  model, which limits but does not eliminate misuse.
- Verification runs in the VAP runtime process. It is a distinct read of persisted state, not
  organizational or cryptographic independence. Remote attestation is future work.
- Preview fidelity is `estimate` for HTTP, `none` for browser recipes and `estimate` for CLI
  recipes; only workspace snapshot restoration is `exact`.
- Best-effort concurrency (read then unconditional write) can be interleaved by another writer.
- The browser adapter runs reviewed recipes only. DOM identities are not stable across
  navigations. Requests are linked explicitly only through the operation's client action id;
  everything else is labeled temporal inference.
- The CLI adapter is trusted reviewed code with a scrubbed environment and workspace containment;
  it is not a hostile-code sandbox. Input prompts are detected and never answered. File diffs
  show workspace changes, not kernel, process or network effects. Snapshots live in the worker
  container and are lost with it.
- CLI child processes run with the worker's uid in the worker container. Runtime secrets are
  removed from `process.env` and registered for redaction, but the kernel's copy of the initial
  environment stays readable to same-uid processes and the metadata server is reachable. Only
  register recipes that do not execute workspace or agent-supplied content, and prefer a
  separate low-privilege worker job for CLI recipes. A uid/network sandbox is future work.
- API-triggered verification runs synchronously only for checks with deadlines up to 20 s;
  longer checks are queued to a worker and the response shows `pending`. A handler is not
  aborted when the client disconnects.
- OIDC callers must present a verified email claim (Google ID tokens with `format=full` or
  `--include-email`); the lowercased email is the principal.
- Evidence written by the test pipeline comes from code under test running as the build
  identity; release decisions must rely on Cloud Build's own records and provenance.
- Single organization, multiple principals. Multi-tenant SaaS is deferred.
- Retention purges resolved operations after 30 days; backups follow the database's own
  retention, so deletion from backups is not immediate.

## Open for this release candidate

- **Cloud evidence is partial.** Unit, integration, browser, demo and release gates have Cloud
  Build evidence ([acceptance.md](acceptance.md)); the staging deployment rehearsal and the
  clean-room review have not run.
- **Lockfile provenance.** The committed `package-lock.json` was resolved with
  `npm install --package-lock-only --ignore-scripts` (metadata only: no packages installed, no
  scripts run). Re-resolve it in the cloud with `bash scripts/vap-cloud.sh lock` if you prefer
  the lockfile itself to come from a cloud run.
- **MCP compatibility** is claimed only for `@modelcontextprotocol/sdk` 1.32.1's client over
  stdio, as exercised by `tests/mcp`, once that test has run. No hosted agent client is claimed.
  A remote MCP HTTP endpoint and its OAuth lifecycle are deferred.
- **Model benchmarks** are not run; the deterministic harness has run three times
  (docs/benchmark-results.md). Its concurrent-edit scenario did not exercise the race in practice.
- **Names**: the "VAP" name is provisional. The npm packages are named
  `@verified-action-protocol/*` and are not published; the owner has not yet confirmed ownership
  of that npm scope. The similarly named `@vap` scope belongs to an unrelated publisher.
- **Modal executor** is not implemented; only the `CloudExecutor` interface exists.

## GitHub issues adapter and the CI-failure demo

- **No exactly-once issue creation.** GitHub has no request deduplication and no sealed lookup.
  VAP never resubmits automatically and only resolves a lost reply when it finds an issue
  identical to the plan's rendering, so it narrows duplicate risk; it does not remove it. If an
  issue stays invisible to every lookup until an operator resolves the operation as "not
  applied", that operator can still cause a duplicate.
- **Lookup scans a bounded window**: up to `lookup_max_pages` pages of 100 issues, filtered by
  `since` (update time) and, when `author_login` is set, by creator. A flooded or very busy
  repository can push the issue out of the window; the operation then stays unknown.
- **Origin after a lost reply is inferred, not proven.** A lookup accepts only an issue in the
  expected repository, authored by the adapter's authenticated identity, carrying the workflow
  marker and the planned title and body, and created after the operation was accepted (within
  `clock_skew_seconds`). That establishes that the required issue exists. It does not prove this
  operation created it: GitHub keeps no request id, so another actor using the same app identity
  could file identical content. Such results carry `origin: inferred_from_lookup` with a "not
  proven" note in the receipt and evidence; only a create whose own reply named the issue is
  `observed_create_response`.
- **An issue from another account, or created before the operation, never resolves it**, even if
  identical (tested). It does make the uniqueness check fail, so the operation reports verification
  failed instead of verified: a denial of service, not a false success.
- **Workflow ids are guessable by design** (derived from repository, commit, build event and
  task) so that any attempt can recompute them. Principals that share one app identity also share
  attribution: the adapter cannot tell their issues apart.
- **Sanitization is pattern-based.** Error output is scrubbed of known secret shapes, ANSI and
  control characters; a secret with no recognizable shape can still reach the issue.
- **The reconcile budget is shared** by the worker's automatic reconciles and an agent's manual
  calls (`VAP_MAX_RECONCILE_ATTEMPTS`, default 5; 8 in the demo). Reaching it escalates to an
  operator; a later successful lookup still resolves the operation.
- **Approval per issue is this demo's policy.** The action declares irreversible watcher
  notifications, which makes it tier 3, and VAP requires plan-bound approval for tier-3 plans.
  Other actions (tier 2 and below, or preauthorized in a grant) need none. The comparison applies
  one scripted, instantaneous approval per planned create to every condition, so human approval
  latency is not measured anywhere.
- **Unfixed OS-package CVEs** remain in both images (12 runtime, 42 worker-browser HIGH/CRITICAL,
  none with an available fix); see docs/security/vulnerability-dispositions.md. Use the browser
  adapter only with trusted origins.
- **Staging rehearsal scope.** The ephemeral rehearsal uses a rehearsal-local OIDC issuer.
  The managed deployment mints Google-signed tokens for a dedicated `vap-smoke` identity, which
  needs only `iam.serviceAccounts.getOpenIdToken` on that account; it has not run and awaits
  owner authorization (docs/release/managed-staging-plan.md).
- **The browser adapter and worker-browser image are experimental**, outside the supported v0.1
  scope (docs/security/browser-image-assessment.md).
- **Real-GitHub runs** put a loopback fault proxy in front of `api.github.com`, which requires
  isolated test mode while real credentials are loaded. Never use that configuration outside a
  dedicated test build.
