# Contributing to VAP

Thank you for helping. VAP is an experimental 0.1 protocol and reference runtime; correctness
of its outcome reporting matters more than feature count.

## Ground rules

- **Cloud-only builds and tests.** Dependency installation, compilation, tests, browser runs and
  benchmarks for any gate run in cloud containers (`bash scripts/vap-cloud.sh test`). A laptop run
  never satisfies a gate. Scripts fail closed when the cloud executor is unavailable.
- **Never commit credentials** or owner-specific configuration: no tokens, keys, private
  project identifiers, paths to credential files or placeholder variables that point at them.
  `scripts/release-hygiene.mjs` runs as the first step of every cloud build.
- **Honest states.** A change must never make an unknown or partial outcome look like success,
  turn missing evidence into a pass, or replace a real adapter with a mock in a gate test.
- **Small, reviewable pull requests.** Schema and lifecycle changes need a short design note
  (`docs/adr/`) reviewed before dependent code changes.

## Developer Certificate of Origin

All commits must be signed off (`git commit -s`), certifying the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): you wrote the change
or have the right to submit it under the project license.

## Workflow

1. Open an issue (bug, adapter proposal or spec change templates).
2. Branch, change, add tests. Conformance, fault and security tests live in `tests/`.
3. Push and open a pull request. Fork pull requests show `vap/cloud-tests` as pending until a
   maintainer dispatches the exact SHA to the low-privilege test project
   (`.github/workflows/cloud-test.yml`). Untrusted pull request code never runs with privileges.
4. Review: authorization, idempotency, reconciliation, migration and release code needs a
   reviewer other than the implementer (see GOVERNANCE.md).

## Adapters

Adapters are trusted, reviewed code compiled into the image, or declarative HTTP mappings
installed by an operator. Every capability an action declares must be backed by a test; an
unproven guarantee is declared `unavailable`, not claimed. Run `staticConformance` from
`@verified-action-protocol/sdk` and add runtime profile tests (Core, Verified, Recoverable) under `tests/conformance`.

## Style

TypeScript, ES modules, strict mode. Match the surrounding code. Keep comments for intent and
invariants. JSON Schema is the source of truth for wire objects; update the schema, the
TypeScript shapes and the examples together (the drift test enforces enum parity).
