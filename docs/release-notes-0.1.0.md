# VAP 0.1.0 release notes (draft, not published)

> Draft for the owner. Publication, repository visibility, package names and any forum post are
> owner decisions and have not happened. Every claim below must be checked against the cloud
> evidence index before publishing; at the time of writing no cloud run has been recorded.

## What it is

VAP is an open source execution layer that lets agents prepare actions, run them under explicit
permissions, inspect durable operation records, verify named outcomes against saved state, and
reconcile uncertainty before retrying. It keeps requested, submitted, completed, verified,
partially applied and unknown outcomes apart.

## Highlights

- Versioned protocol (0.1, experimental): JSON Schemas, method contracts, error codes with
  retry dispositions, executable examples.
- Durable runtime on PostgreSQL: immutable plans, request-key idempotency, plan-bound approvals,
  outbox dispatch with fenced claims, reconciliation with sealed lookups, verification with
  freshness, recovery as separate operations.
- Adapters: declarative HTTP (register an action with configuration only), Playwright browser
  recipes, registered-command CLI.
- Agent integration: TypeScript client and a stdio MCP bridge with ordinary tools.
- GCP deployment: Cloud Run API and jobs, Cloud SQL, Cloud Scheduler sweeper, private evidence;
  all builds and tests in Cloud Build.

## Try it

`bash scripts/vap-cloud.sh demo` runs the fixture demo in your own GCP project (Cloud Build only;
no persistent resources).

## Limitations

No exactly-once remote effects, universal undo, prompt-injection immunity or compliance claims.
Same-process verification is not independent attestation. MCP compatibility is limited to the
tested SDK client over stdio. Model benchmarks were not run. See docs/limitations.md.

## Contributing

Issues and pull requests are welcome; see CONTRIBUTING.md. Adapter proposals should state the
capability vector and how each guarantee is tested.
