# ADR 0001: Adopt the closed v0.1 decisions

Status: accepted (2026-10-22)

One TypeScript monorepo; PostgreSQL as the only journal backend; one OCI image family; GCP as the
canonical tested cloud. No Rust, Redis, Kubernetes, plugin marketplace or second production
database. Real configurable HTTP, bounded browser and registered-command CLI adapters; no
semantic code editing, desktop automation, kernel tracing, hostile-code execution, domain packs
or multi-system transactions. An ordinary stdio MCP bridge with standard tools. Operation status
plus independent verification status instead of a success flag. Side effects classified
individually. Native support is provenance, not a conformance rank.

Consequences: the protocol stays language neutral through JSON Schema and HTTP; Modal is an
interface (`CloudExecutor`) only.
