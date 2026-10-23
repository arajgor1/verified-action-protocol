# Threat model

Scope: a single-organization VAP deployment with multiple authenticated principals (agents,
operators, approvers, viewers), registered adapters and destinations. Draft owned by the security
reviewer role; findings and verdicts are recorded in docs/reviews/.

| Threat | Control | Test |
|---|---|---|
| Prompt injection / confused deputy | Observations are untrusted data; action and target scope enforced outside the model by grants and task scope; agents cannot create or widen grants; risk tiers and approvals | `tests/security/security.test.ts` (grant elevation, scope widening), `tests/unit/predicate-policy.test.ts` |
| Approval replay or self-approval | Approval binds the exact keyed plan digest, is single-use and expiring; approver from authentication and must differ from the executing principal; DB trigger allows only the consume transition | `tests/faults/faults.test.ts` T09 |
| Changed arguments after approval | Any change produces a new plan and digest; approval does not transfer; plans are immutable (DB trigger) | T09, lifecycle PR03 |
| Request replay and duplicates | Keyed request-key digest, unique constraint, request digest bound to the plan, single-use plans, tombstones | T01, T02, PR04 |
| SSRF and exfiltration | Registered origins only; connect-time DNS checks against blocked ranges (loopback, private, link-local and metadata, CGNAT, multicast, mapped IPv6); IP literal checks; redirects never followed; size caps; resource URIs are not URLs | `tests/unit/net-config-cli.test.ts`, security T16 |
| Path and command injection | Argument arrays without a shell; typed recipe parameters; workspace containment with symlink and special-file rejection; scrubbed environment; URI-safe template values | unit CLI containment, conformance CLI, security T16 |
| Resource exhaustion | 256 KiB body cap, in-flight cap, per-principal rate limit, observation and output caps, deadlines, bounded queries and outbox leases | security limits test, CLI big output |
| Cross-principal access and id guessing | Every read authorized through the coordinator; foreign or unknown ids return NOT_FOUND; evidence follows the originating grant | lifecycle PR08, security id-guessing |
| Identity spoofing | OIDC signature, issuer, audience and expiry verification; identity headers and body principals ignored; demo mode refuses production, Cloud Run and non-loopback | security auth tests, unit config tests |
| Secret leakage | Field allowlists and redaction before persistence and logging; registered connector credentials scrubbed; canary tests across API views, logs and journal tables; release hygiene on tree, archive and full history; image history check | security T15, release pipeline |
| Stale worker writes | Monotonic fencing tokens (DB trigger); state changes require the live claim | T17 |
| Untrusted pull request code | No privileged PR workflows; maintainer dispatch to a low-privilege test project with keyless federation; trusted build config from the default branch | `.github/workflows/cloud-test.yml` |
| Supply chain | Exact dependency versions, frozen lockfile, `--ignore-scripts`, digest-pinned base images and actions, SBOM, license inventory, image vulnerability and secret scans | release pipeline |

## Residual risks

- A compromised operator or approver identity can authorize harmful actions within its role.
- Destinations that do not support conditional writes or request keys leave race windows and
  unknown outcomes that only an operator can resolve.
- The CLI adapter is not a sandbox; recipes must be reviewed like code.
- Redaction is pattern- and allowlist-based; novel secret formats in free text can slip through.
  Field allowlists are the primary control.
- No prompt-injection immunity and no regulatory compliance claim.
