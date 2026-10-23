# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately using the repository host's private
vulnerability reporting ("Report a vulnerability" under the Security tab) once the repository
is published. Do not open a public issue and do not include real credentials in reports. We aim
to acknowledge reports within five business days.

If you believe a secret was exposed in this repository, its history or a release artifact,
report it the same way. Exposure is handled as an incident: containment, operator-directed
credential rotation, and history rewriting where needed before any further release.

## Supported versions

| Version | Status |
|---|---|
| 0.1.x | experimental; security fixes on the latest patch only |

## Security model (summary)

- Authentication: Cloud Run IAM plus in-application verification of OIDC ID tokens (issuer,
  audience, expiry, signature). Identity headers and principal fields in bodies are ignored.
- Authorization: operator-issued grants (action patterns, target patterns, risk ceiling,
  limits, expiry, revocation). Tasks can narrow a grant, never widen it. Every read is
  authorized; unknown or foreign ids return NOT_FOUND.
- Approvals: bound to the exact plan digest, single-use, expiring, approver identity from
  authentication, self-approval denied.
- Destinations: operator-registered origins only; DNS and redirect checks; metadata, loopback
  and private ranges blocked outside isolated test mode.
- CLI: registered recipes with typed arguments, argument arrays, workspace containment,
  scrubbed environment. Not a hostile-code sandbox.
- Evidence and logs: redacted before persistence and serialization; private artifact storage.
- Demo authentication refuses to start in production, on Cloud Run or on a non-loopback port.

No prompt-injection immunity or regulatory compliance is claimed. Secret scanning is a release
gate, not a guarantee. Details: [docs/security/threat-model.md](docs/security/threat-model.md).
