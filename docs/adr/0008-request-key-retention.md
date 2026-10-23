# ADR 0008: Request-key retention, tombstones and purge

Status: accepted

Request keys of resolved operations stay replayable for 7 days (configurable). The sweeper then
marks them expired and writes a tombstone; reusing the key returns REQUEST_KEY_EXPIRED instead of
creating a duplicate logical operation. Keys of unresolved operations never expire. Operation
metadata and evidence are purged after 30 days only when resolved and when their key has
expired; tombstones remain. Backups include operations, tombstones and migrations; restore
drills (T14) verify that unresolved submissions stay unknown and are reconciled, not replayed.
