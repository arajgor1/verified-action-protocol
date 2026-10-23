# Governance

VAP is an independent open source project. It is not a foundation project, standards body,
certification program or official extension of any other protocol. Those claims will not be
made unless an actual governance structure exists.

## Roles

- **Maintainers** merge changes, cut releases and own the security process. The initial
  maintainer is the project owner. `.github/CODEOWNERS` names placeholder teams
  (`@vap-maintainers`, `@vap-security`) that must be created, or replaced with real accounts,
  when the repository is published.
- **Reviewers** review in their area. Authorization, idempotency, reconciliation, migration and
  release code require a reviewer other than the implementer.
- **Contributors** propose changes under the DCO.

## Decisions

Routine implementation choices are recorded as ADRs in `docs/adr/`. Protocol changes that alter
interpretation require a version change, a migration plan, updated schemas and examples, and
maintainer approval. Mandatory gates in `docs/acceptance.md` cannot be weakened by an ADR.

## Releases

A release candidate is COMPLETE only when acceptance gates A1 to A10 pass for its exact commit
with cloud evidence. Publication (repository visibility, packages, announcements) is a separate
owner decision.
