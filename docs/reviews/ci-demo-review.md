# CI-failure demo: security and QA reviews

The two reviewers worked independently and only read code. They reviewed commit `eece904` plus the uncommitted work in progress at the time. All fixes landed in `08cad5c` and were re-run in Cloud Build `4c0994e0` (pass).

## Security

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | High | A third party could plant an issue containing the workflow marker, and reconciliation would accept it as the created issue. | Lookup accepts only an issue whose title and body equal the plan's rendering. The marker is anchored to the first line of the body. When `author_login` is configured, listings use `creator=` and the author is checked. The new test "a planted issue that quotes the workflow marker never resolves the operation" covers this. |
| 2 | Medium | The read-back checks were substring matches and could pass for a copied issue. | Added `body_matches_plan` and `title_matches_plan`. Field checks are now scoped to their own section. |
| 3 | Medium | Markdown and mention injection through `failing_test`, `build_ref` and the repro steps; control and bidi characters survived sanitization. | Single-line schema patterns for those fields; untrusted text rendered as code spans; C0/C1 control characters, OSC sequences and bidi characters stripped. |
| 4 | Medium-low | Credentials could be sent over plain HTTP outside test mode. | Plain `http` is now refused unless the destination is private *and* the runtime is in isolated test mode. The real-GitHub demo's use of isolated test mode is documented in `limitations.md`. |
| 5 | Low | A failed token exchange was reported as a create that may have been submitted. | Credentials are obtained before the create; a failure is reported as `not_submitted`. |
| 6 | Low | The scan window used update time, and the scan could be flooded. | The comment is corrected and the `creator=` filter added; the remaining risk is documented. |
| 7 | Low | A manual reconcile could leave an operation unknown with nothing scheduled. | A manual reconcile now always leaves a scheduled reconcile behind. |
| 8 | Low | A Cloud Build substitution was interpolated into the step that holds secrets; cleanup could close every issue carrying a marker. | The value is passed as a validated environment variable; `--close` now requires `--only`; the installation id is validated. |
| — | Info | The normalized form of the private key was not registered for redaction. | Both forms are now registered. |

Confirmed OK by the reviewer:
- the lookup-by-key endpoint does not disclose other principals' operations, because the key digest includes the principal;
- the fault proxy has no control surface and never ships;
- fixture controls are reachable only on the control listener.

## QA

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | Medium | The VAP agent reconciled faster than the careful agent scanned. On top of that, the sweeper and a leased dispatch item both queued reconcile chains, so the shared budget could run out during delayed visibility. | Every condition now uses the same deadline, an 8-lookup budget and 0.5–4 s backoff. The sweeper skips operations that already have a pending item. |
| 2 | Medium | The end-to-end tests did not prove that the fault actually fired. | Each run now records `fault_fired`, and the tests assert it plus "zero create replies delivered" for lost-reply and crash scenarios. All 180 benchmark runs had `fault_fired` true. |
| 3 | Medium | The canary metric cannot tell conditions apart, because every agent redacts known shapes. | Disclosed in the results; sanitization being pattern-based is listed as a limitation. |
| 4 | Fairness | There was no careful baseline with a durable intent record. The careful agent's deadline was capped differently. | Added the `careful_log` condition (it scored 45/45, the same as VAP). Deadlines are now equal. The scripted approver and the AbortSignal-based agent crash are disclosed. |
| 5 | Low | False completion was judged across every issue carrying the marker, not just the claimed one. | Now judged on the claimed issue's content only. |
| 6 | Low | `kill()` had no timeout; a listener leaked in `sleep`. | Kills fall back to SIGKILL after 5 s; the abort listener is removed. |
| 7 | Low | The TAP output contained `duration_ms` and absolute paths, so observations differed between runs. | Both are stripped. A comment explains why the child process's environment is minimal. |

The reviewer confirmed:
- crashes trigger after the destination commits;
- VAP's runtime is genuinely killed with SIGKILL and resumes through `findOperation`;
- a concurrent second submission follows the first operation.
