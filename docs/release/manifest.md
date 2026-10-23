# Release manifest

| Item | Value |
|---|---|
| Tested runtime source commit | `b85d442db55e3c9cd183789641339d5a20ad6ecb` |
| Final documentation/source-tree commit | the commit that adds the "Manifest check" section below (documentation only) |
| Runtime image | `<registry>/vap/vap@sha256:6bac81edf14a6c247d324a5b666dfe06aba9d1dbf30198063707f8d8732a021a` |
| Worker-browser image | `<registry>/vap/vap-worker-browser@sha256:2eb3847db93149e1357fb390ec660d101e48f18e94e4c36331b517e7106e6291` |
| Gate evidence | [candidate-evidence.md](candidate-evidence.md) |

**How the diff is checked.** `bash scripts/vap-cloud.sh manifest --tested <sha> --images <digests>`
runs `scripts/release-manifest.mjs` in Cloud Build against a clone of the archive's full git
history. It fails unless:
- the tested commit is an ancestor of the final tree;
- every path changed after the tested commit is documentation (`docs/**` or `*.md`);
- every `scripts/vap-cloud.sh <command>` and every `infra/gcp/cloudbuild.*.yaml` named in the
  final documentation exists in the tested commit.

It records `release-manifest.json` with the full diff.

## Manifest check

Cloud Build `9303cae2-b370-4314-b889-07ecd0f2e845` checked tested commit `b85d442` against tree
`e888f1f`, and passed:
- the tested commit is an ancestor of the tree;
- 1 commit and 10 files changed after the tested commit, 0 of them outside documentation;
- 0 documented-command problems.

Files changed after the tested commit:

| Status | Path |
|---|---|
| M | docs/acceptance.md |
| M | docs/demo/ci-failure-results.md |
| M | docs/demo/evidence/ci-demo-receipt.json |
| M | docs/demo/evidence/ci-demo-transcript.md |
| M | docs/limitations.md |
| M | docs/process-deviations.md |
| M | docs/release/candidate-evidence.md |
| A | docs/release/clean-room-review.md |
| A | docs/release/manifest.md |
| A | docs/security/vulnerability-dispositions.md |

Documented dispatcher commands, all present in the tested commit: `cleanup`, `demo`, `deploy`,
`image-gate`, `lock`, `manifest`, `release`, `staging-rehearsal`, `test`, `tutorial`. The commit
that adds this section changes only this file; the operator re-runs the same check against the
final tree before tagging.
