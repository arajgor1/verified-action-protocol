# ADR 0005: Adapters read, the core evaluates predicates

Status: accepted

The spec lists `verify(check, context) -> Evidence` on adapters. VAP splits it: the adapter's
`verify` performs one authoritative read and reports facts, source version, freshness relative
to the operation's version, and limitations; the coordinator evaluates the bounded declarative
predicate, polls until pass, definitive failure or deadline, applies freshness rules, projects
only predicate-referenced facts, stores artifacts and writes the Evidence record.

Reason: predicate semantics, freshness, "missing is never a pass", and stale-at-deadline means
inconclusive must be identical across adapters. Adapters cannot mark their own prose as proof.
