# CI-failure demo: results (fixture layer)

**Source:** publication candidate `61ed3b2`, Cloud Build `a54bbc0a-45b8-413d-8dad-dbaffe86c1d9`
(suite `demo`): 5 runs per scenario per condition, 180 runs in total, on Node 24.21.0 with 8 vCPUs.
Raw records are kept in the private evidence bucket. The evidence index is
[../release/candidate-evidence.md](../release/candidate-evidence.md).

## Definitions and denominators

Every run is judged from two sources only: the fixture's ground truth (it ignores visibility
delays and records each issue's author) and the fault proxy's private records. An agent's own
report never counts as evidence.

**The task contract:** after the workflow, exactly one issue exists for it, with the required
content. That means the workflow marker, failing test, commit, reproduction steps and sanitized
output, and no secret.

| Measure | A run (or report) is counted when | Denominator |
|---|---|---|
| **Completed** | the task contract holds, and every final report claims completion and names that issue | completable runs: scenarios S1–S5, S8, S9, where an issue can be created and observed (7 × 5 = 35 per condition) |
| **Correctly rejected** | the destination refused the create, no issue exists, and the report says "rejected" | rejection runs: S6 (5 per condition) |
| **Safely unresolved** | the report says "unknown", at most one issue exists, and nothing false was claimed. This is a safe stop, **not** a completion | all runs (45 per condition). It is the correct outcome only in S7, where every lookup fails by construction |
| **Incorrect** | anything else | all runs (45) |
| **Duplicate effects** | more than one issue carries the workflow marker | all runs (45); "extra issues" counts every issue beyond the first |
| **False task success** | a report claims the task is complete while the task contract does not hold (for example, duplicates exist) | per run: runs with at least one completion claim; per report: all completion reports (S4 and S5 produce two reports per run) |
| **API-level success claim** | the issue a completion report names exists with the required content. This says nothing about duplicates, and an API call succeeding is **not** task completion | reported as the count of completion reports where this fails |
| **Origin** of a completed issue | *observed*: the create's own response named it; *inferred*: found by a lookup after an ambiguous create, not proven; *pre-existing*: found before creating anything | final reports in completed runs |

The four outcome categories are exclusive and add up to 45 runs per condition.

**Corrections to earlier versions of this page:**
- **"Exactly one correct issue in all 45 runs" was wrong.** S7 runs are safely unresolved, not
  completed, and S6 must leave no issue.
- **The "false success claims" column only checked API-level success.** It asked whether the
  named issue exists. It therefore reported 0 false claims for the retry client, which in fact
  claimed success while creating duplicates. Measured against the task contract, those are false
  task successes. Recounting from the retained records of the previous candidate's run
  (`e85838d0`) gives the same pattern as the table below: retry 35/40 runs, careful 10/35,
  careful_log 0/35, VAP 0/35.

## Summary (scripted policies, not models)

| Condition | Completed | Correctly rejected | Safely unresolved | Incorrect | Workflows with duplicates (extra issues) | False task success: runs | False task success: reports | API-level claim failures | Origin observed / inferred / pre-existing |
|---|---|---|---|---|---|---|---|---|---|
| retry | 5/35 | 5/5 | 0/45 | 35/45 | 35/45 (35) | **35/40** | 45/50 | 0 | 5 / 0 / 0 |
| careful | 28/35 | 5/5 | 5/45 | 7/45 | 7/45 (7) | **7/35** | 9/45 | 0 | 13 / 10 / 13 |
| careful_log | 35/35 | 5/5 | 5/45 | 0/45 | 0/45 (0) | 0/35 | 0/45 | 0 | 15 / 19 / 11 |
| vap | 35/35 | 5/5 | 5/45 | 0/45 | 0/45 (0) | 0/35 | 0/45 | 0 | 25 / 20 / 0 |

- **Retry client:** every API call it reported as successful really did create the issue it named,
  but in 35 of the 40 runs where it claimed the task was done, the contract did not hold because a
  duplicate existed.
- **Careful client:** varies with timing when two instances run at once (S4). It completed 3 of 5
  S4 runs here, 3 of 5 in `4c378343`, 2 of 5 in `2738a3f9`, 0 of 5 in `e85838d0` and 2 of 5 in
  `4c0994e0`. Every other outcome count matches the previous candidate's run (`4c378343`); only
  the careful_log origin split (15 / 20 / 10 there) and the timings vary between runs.
- **VAP origins:** every VAP completion after a lost or interrupted reply (S2, S3, S8, S9: 20
  reports) has an *inferred*, not proven, origin.

## Per scenario (out of 5 runs each)

Each cell reads completed / correctly rejected / safely unresolved / incorrect, plus any extra
issues.

| Scenario | Expected outcome | retry | careful | careful_log | vap |
|---|---|---|---|---|---|
| S1 normal | completed | 5/0/0/0 | 5/0/0/0 | 5/0/0/0 | 5/0/0/0 |
| S2 create accepted, response lost | completed | 0/0/0/5, +5 | 5/0/0/0 | 5/0/0/0 | 5/0/0/0 |
| S3 crash while the reply is in flight | completed | 0/0/0/5, +5 | 5/0/0/0 | 5/0/0/0 | 5/0/0/0 |
| S4 two concurrent instances | completed | 0/0/0/5, +5 | 3/0/0/2, +2 | 5/0/0/0 | 5/0/0/0 |
| S5 rerun with changed payload | completed | 0/0/0/5, +5 | 5/0/0/0 | 5/0/0/0 | 5/0/0/0 |
| S6 destination rejects | correctly rejected | 0/5/0/0 | 0/5/0/0 | 0/5/0/0 | 0/5/0/0 |
| S7 response lost, every lookup fails | safely unresolved | 0/0/0/5, +5 | 0/0/5/0 | 0/0/5/0 | 0/0/5/0 |
| S8 response lost, visible after 3 s | completed | 0/0/0/5, +5 | 5/0/0/0 | 5/0/0/0 | 5/0/0/0 |
| S9 crash, issue invisible for 6 s | completed | 0/0/0/5, +5 | 0/0/0/5, +5 | 5/0/0/0 | 5/0/0/0 |

The scheduled fault demonstrably fired in all 180 runs.

## Attribution tests (all passed on publication candidate `61ed3b2`)

| Test | Outcome |
|---|---|
| Another account files an issue with the same marker and exactly the planned title and body, after the operation was accepted, while the operation's own create never reached GitHub | operation stays `unknown`; the lookup (restricted to the adapter's identity) has 0 candidates; ground truth shows the identical issue exists, filed by `someone-else` |
| The adapter's own identity filed an identical issue before the operation was accepted | operation stays `unknown`; the candidate is rejected as `created_before_operation` |
| An identical issue from the same identity appears after acceptance, while the operation's own create never reached GitHub | existence is resolved (`found_applied`, verification passed), and origin is reported as `inferred_from_lookup` with "not proven". This case shows exactly why origin cannot be proven: the issue really came from someone else using the same identity |
| A planted issue that quotes the marker with different content | operation stays `unknown` (`different_content`) |
| Normal create / lost reply (end to end) | origin `observed_create_response` / `inferred_from_lookup` respectively |

## Reading the results

- **Losing confirmation breaks naive clients.** Every lost reply, crash or rerun produced a
  duplicate under the retry policy.
- **A careful client fixes most cases, but not all of them.** It still duplicates with concurrent
  instances (S4) and after a restart while the issue is not yet visible (S9). Both cases need a
  durable record of the attempt, written before the request.
- **A careful client with its own durable intent log matched VAP in every category.** The outcome
  comes from the discipline, not from VAP. The logged baseline uses a local file; a custom client
  could provide the same durability and coordination across hosts with a shared database or lock
  service.
- **VAP's contribution is reuse.** One implementation of that discipline sits behind consistent
  contracts:
  - request keys and resume-by-key;
  - explicit `unknown` handling with reconciliation and escalation;
  - read-back verification evidence;
  - existence reported separately from origin;
  - plan-bound approvals;
  - an append-only audit trail.

  Every agent and integration uses it through the SDK, REST or MCP, instead of each client
  building, testing and maintaining its own.

## Cost

- **Normal path (S1):** median 703 ms for VAP against 179–195 ms for the no-VAP policies, timed
  after runtime start-up. VAP made 9 tool calls (API calls plus the test run) against 4. The extra
  time covers the plan, durable journal writes, and two read-back checks (content and uniqueness)
  that the other policies do not run.
- **Approvals:** the policy is the same for every condition: one scripted, instantaneous approval
  per planned create. The counts differ because the policies make different numbers of create
  attempts: retry 55, careful 42, careful_log 35, VAP 40 across 45 runs. **Human approval latency
  is excluded from every measured time.** Whether an action needs approval at all is set by its
  declared side effects and the grant, not fixed by VAP: this action is tier 3 because watcher
  notifications cannot be recalled.
- **Crash recovery:** VAP waits for the dead worker's claim to expire (a 3 s lease in the demo;
  the default is 30 s), which is why S3 takes about 4.3 s.
- **S7:** VAP escalates after about 12.4 s; the careful policies stop after about 24 s, when their
  8-lookup budget runs out.
- **Infrastructure:** PostgreSQL plus the API and worker processes.

## Not run

- **Model-driven comparison:** BLOCKED. It needs model access and a spending ceiling.
- **Real GitHub:** BLOCKED. It needs the owner's repository, a GitHub App, resource limits and
  authorization. See [real-github-setup.md](real-github-setup.md).
