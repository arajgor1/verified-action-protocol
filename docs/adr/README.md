# Architecture decision records

| ADR | Decision |
|---|---|
| [0001](0001-closed-decisions.md) | Adopt the specification's closed v0.1 decisions |
| [0002](0002-separate-status-dimensions.md) | Separate execution, verification and recovery status; derive outcome |
| [0003](0003-hand-maintained-types.md) | Hand-maintained TypeScript types checked against schemas (deviation from "generate types") |
| [0004](0004-sealed-lookup-and-fresh-keys.md) | Sealed destination lookups and per-attempt destination keys |
| [0005](0005-coordinator-owns-predicates.md) | Adapters read; the core evaluates predicates (split of `verify`) |
| [0006](0006-node-http-no-framework.md) | `node:http` gateway without a web framework |
| [0007](0007-workstation-control-only.md) | Workstation as control interface; lockfile resolved metadata-only |
| [0008](0008-request-key-retention.md) | Request-key retention, tombstones and purge |
