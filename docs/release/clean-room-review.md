# Clean-room review

**Method.** Two reviewers with no prior context, each a separate agent instance given only the
public onboarding docs (README.md, docs/quickstart.md, docs/tutorial-custom-http-action.md),
wrote down every command a newcomer would type and every gap they would hit. They executed
nothing. Their runbooks were then executed exactly, from a fresh `git clone`, in fresh Cloud
Build environments. Each finding was fixed in documentation or implementation, and the affected
steps were run again.

Limitations: the reviewers are agents, not people. The runs used the operator's existing project,
permissions and evidence bucket, so the one-time project setup (APIs, IAM grants, bucket
creation) was reviewed on paper but not executed from a blank project.

## Round 1 (docs at `5595fef`)

**Reviewer findings and resolution:**

| # | Finding | Resolution |
|---|---|---|
| 1 | The tutorial could not be executed as written: it needed a deployed API, a token, a way to send the requests, and a way to load the custom configuration | New `bash scripts/vap-cloud.sh tutorial [--config <file>]` runs the tutorial's requests against an ephemeral runtime loaded with the committed configuration. New `examples/config/adapters.tutorial.json`. Tutorial rewritten |
| 2 | The README required `bootstrap.sh` first; the quickstart never mentioned it | Bootstrap is now stated to be needed only for the optional durable deployment |
| 3 | No IAM roles, APIs to enable, bucket creation, region or tool versions | Quickstart §0 now covers each of these, with commands |
| 4 | Windows was not addressed | Git Bash or WSL is stated |
| 5 | No clone step; the run is from a commit | Clone step added. The docs now state that the cloud runs the committed tree, and the tutorial command refuses configurations that are not committed |
| 6 | Plan and operation request bodies were incomplete (no `task_id`, no field names); a fixed issue id and an expiring date | Full bodies; the seeded issue id; a relative expiry |
| 7 | Inspect, viewer and MCP commands needed a deployment or a local build | Moved under optional deployment; the README says where the bridge and CLI run |
| 8 | The README status banner was out of date ("no run recorded"), and the demo output was illustrative | Status updated; the excerpt is from a recorded run |
| 9 | Suite names were not enumerated; no guidance on build logs or run ids | Suites table; where outputs and logs appear |
| 10 | `lock` was listed as a required step | Moved to a maintainers section |

**Execution of the runbook as written** (fresh clone of `5595fef`):

| Command | Result | Resolution |
|---|---|---|
| `bash scripts/vap-cloud.sh demo` | **FAILED before any step ran**: Cloud Build rejected the `_COMMIT_SHA` substitution, because the demo pipeline never referenced it. The command had never been run | Pipeline fixed. A new unit test checks that every substitution the dispatcher passes is declared and referenced |
| `bash scripts/vap-cloud.sh test --suite integration` | passed (`e9f7ea81`) | none needed |
| Log streaming in the dispatcher | **printed nothing**: the pipelines log only to Cloud Logging, which `gcloud builds log --stream` cannot read | see round 2 |

## Round 2 (docs and dispatcher at `49885af`, then `35431e1`)

**Execution:**

| Command | Result | Resolution |
|---|---|---|
| `bash scripts/vap-cloud.sh demo` | passed (`07c5faae`, 0.8 min) | none needed |
| `bash scripts/vap-cloud.sh tutorial` | passed (`3bf07f47`): the custom action was verified from saved state, the task was verified complete and the request-key replay returned the same operation | none needed |
| Live log streaming via `gcloud beta builds log --stream` | **printed nothing**: it needs the `grpcio` Python module | The dispatcher now polls status and prints the full log from Cloud Logging when the build ends. The quickstart lists the `beta` component |
| Durations in the quickstart | the first draft had guessed durations, all too long | Replaced with recorded durations |

**Second reviewer**, on the updated docs, found no in-document blockers. Its remaining real
prerequisites are outside the docs: the repository URL (not yet published), a billed GCP project,
and someone able to grant IAM roles. It also found:

| # | Finding | Resolution |
|---|---|---|
| 1 | The tutorial's `git commit` step fails with "nothing to commit" on an unedited clone | The run comes first; commit only after an edit; the git identity is mentioned |
| 2 | The duration table seemed contradictory (`all` 4.1 min but `demo` 12.6 min) | Clarified: only the `demo` suite runs the 180-run comparison |
| 3 | No grant commands; the build service account was ambiguous | Commands added, including `gcloud builds get-default-service-account` |
| 4 | Missing permissions to enable APIs, create buckets and read reports; region semantics | Added |
| 5 | "Nothing from this repository is executed" contradicted running `vap-cloud.sh` | Reworded: the dispatcher is the only repository file that runs locally |
| 6 | `--commit` default, local `release-out/`, and fault-test numbering | Documented |

## Final execution on the release candidate

The runbook was executed again from a fresh clone of candidate `b85d442`:
- `demo`: PASS, `d97cf09a`;
- `tutorial`: PASS, `6fe6bfcb`. The custom action was verified from saved state, the task was
  verified complete, and the request-key replay returned the same operation;
- `test --suite integration`: PASS, `874d389f`, 122 tests.

The full suite, demo suite, release, image gate and staging rehearsal were also submitted from a
fresh clone with the documented dispatcher ([candidate-evidence.md](candidate-evidence.md)).
