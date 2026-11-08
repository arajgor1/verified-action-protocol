# Governance

VAP is an independent open source project. It is not a foundation project, standards body,
certification program or official extension of any other protocol. Those claims will not be
made unless an actual governance structure exists.

## Roles

- **Maintainers** merge changes, cut releases and own the security process. The maintainer is
  Aaditya Rajgor (GitHub [@arajgor1](https://github.com/arajgor1)).
- **Reviewers** review in their area. Authorization, idempotency, reconciliation, migration and
  release code require a reviewer other than the implementer.
- **Contributors** propose changes under the DCO.

## Decisions

Routine implementation choices are recorded as ADRs in `docs/adr/`. Protocol changes that alter
interpretation require a version change, a migration plan, updated schemas and examples, and
maintainer approval. An ADR cannot weaken the invariants in CONTRIBUTING.md or the security
model in SECURITY.md.

## Releases

A maintainer cuts a release when the full cloud test suite, the release pipeline (image scans,
SBOM, license inventory, checksums) and the quickstart check pass on the release commit.
