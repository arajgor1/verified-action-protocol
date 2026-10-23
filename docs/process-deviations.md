# Process deviations

Departures from the execution specification, recorded as they happened. A deviation does not
by itself invalidate cloud evidence gathered before or after it; each entry says what it affected.

## 2026-10-22: local invocation of the hygiene script

- **What happened:** while committing docs at `b560899`, the coding agent ran
  `node scripts/release-hygiene.mjs --help` on the developer workstation before `git add`. The
  script has no `--help` mode, so it scanned the working tree in its default mode. Its output was
  discarded and no file was changed. This breaks the rule that workstations are only a control
  interface.
- **Effect on evidence:** none. No gate, test or benchmark result came from that invocation. The
  hygiene gate for that commit ran in Cloud Build (`84f04bc5`), where it failed on a file outside
  the release allowlist; the fix `71323f2` passed it in `a3b2da8f`. The earlier cloud results stay
  valid and were not rerun because of this deviation.
- **Prevention:** every project script, test command, benchmark and demo entry point now imports
  `scripts/cloud-guard.ts`. It refuses to start unless `VAP_CLOUD_EXECUTION=1`, which only the
  pipelines in `infra/gcp/cloudbuild.*.yaml` set. The npm test scripts load the guard with
  `--import`, and `AGENTS.md` states the rule. The guard prevents accidents; it is not a security
  control, because anyone can set the variable.

## 2026-10-22: demo pipeline step could mask a failing test

- **What happened:** in `infra/gcp/cloudbuild.test.yaml` the `demo` step ran
  `set -o pipefail` without `set -e`. When the test command failed, the step still went on to the
  demo script and the comparison, and reported success if those passed. Run `5a865ed5` on
  `5939dd8` reported success although 1 of 24 demo tests failed. The failing test was an
  assertion error in the test itself, not a behaviour regression; see the candidate evidence
  index.
- **Effect on evidence:** demo1 (`91f4cd67`) and demo2 (`4c0994e0`) were checked by their test
  counts, and all their tests passed (21/21 in demo2). Run `5a865ed5` does not count as a passing
  gate.
- **Prevention:** every multi-command pipeline step now uses `set -eo pipefail`.
  `scripts/evidence.mjs` aggregates every test summary and gate report and fails the build on any
  failure, even if the producing step exited 0. `scripts/check-exit-propagation.sh` runs negative
  controls in every test build: a deliberately failing test through `node --test`, `npm run`,
  `tee` pipelines and a multi-command step, a failing report through the aggregator, a failing
  process through `tee`, and the cloud guard. The image gate adds `docker run`. A unit test checks
  that multi-command pipeline steps use `-e`. All passed on candidate `b85d442` (`8446aedb`,
  `c9bba95d`).

## 2026-10-23: release artifacts overwritten in the evidence location

- **What happened:** release `e820cdd2` (publication candidate `c4c06bb`) wrote sanitized copies
  of eight generated artifacts to `reports/public/` (SBOMs, scan reports, vulnerability
  inventories, license inventory). Cloud Build uploads artifact files into one flat location, so
  each copy replaced its private original. `SHA256SUMS` still listed the originals' hashes, so
  private verification of those eight files was broken for that run. The images and their SLSA
  provenance were unaffected.
- **Effect on evidence:** release `e820cdd2` and the gates that depend on its images are not used
  as release evidence. The candidate was re-exported (`5df8873`) and validated again in full.
- **Prevention:** sanitized copies are named `public-<file>`. `SHA256SUMS` records base names and
  the step fails if base names collide. The final release `9fea3c08` was checked: all 25
  artifacts verify against the uploaded set, the private originals still contain the owner
  identifiers they need, and the public copies contain none.
