# Continuation state

Resumable handoff for the next session. Contains no secrets or operator values.

- **State**: IN_PROGRESS. Implementation complete for v0.1 scope; nothing compiled or tested yet.
- **Branch**: `main` of a new local repository (no remote configured).
- **Blocked on**: authorization to run Cloud Build in the owner's GCP project from the coding
  session (operator-private project, region, evidence bucket and spend ceiling).
- **Next actions, in order**:
  1. Commit the tree; run `bash scripts/vap-cloud.sh test --suite unit` to get the first compile
     and unit results; fix failures.
  2. `--suite integration`, then `--suite browser`, then `--suite all`; fix failures; record build ids.
  3. Three fresh `--suite all` runs on the release commit (gate policy).
  4. `bash scripts/vap-cloud.sh release --commit <sha>`: image digests, SBOM, scans, packages.
  5. `bash infra/gcp/bootstrap.sh` (operator), then `bash scripts/vap-cloud.sh deploy --image <digest>`.
  6. Update `docs/acceptance.md` with evidence; QA and security sign-off on behavior.
  7. Clean-room run of quickstart and tutorial by a reviewer (A8).
- **Unresolved operations**: none (no deployment exists).
- **Review findings**: see `docs/reviews/`.
