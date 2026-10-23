# ADR 0002: Separate status dimensions and a derived outcome

Status: accepted

Operations carry `execution_status`, `verification_status` and `recovery_status` as independent
fields. A derived `outcome` (requested, submitted, completed_unverified, verified,
verification_failed, partially_applied, failed, cancelled, unknown) exists only for display and
retry guidance; it is computed by one function (`deriveOutcome`) and never stored.

Reason: the goal requires requested, submitted, completed, verified, partially applied and
unknown to be explicit and inspectable. Storing a single status invites "completed" to be read
as success. The derivation table is documented and unit-tested so `verified` can only mean
completed with every bound check passing.
