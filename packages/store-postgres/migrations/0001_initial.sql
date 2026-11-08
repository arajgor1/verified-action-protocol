-- VAP 0.1 journal schema. PostgreSQL is the only supported journal backend.
-- Applied by the migration identity only; the runtime identity has DML rights.

CREATE TABLE principals (
  subject     text PRIMARY KEY,
  roles       text[] NOT NULL CHECK (roles <@ ARRAY['agent','operator','approver','viewer']::text[]),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE grants (
  id                   text PRIMARY KEY,
  principal            text NOT NULL,
  revocation_revision  integer NOT NULL DEFAULT 0,
  revoked_at           timestamptz,
  expires_at           timestamptz NOT NULL,
  body                 jsonb NOT NULL,
  created_at           timestamptz NOT NULL
);
CREATE INDEX grants_principal_idx ON grants (principal);

CREATE TABLE tasks (
  id                 text PRIMARY KEY,
  owner              text NOT NULL,
  grant_id           text NOT NULL REFERENCES grants (id),
  contract_revision  integer NOT NULL CHECK (contract_revision >= 1),
  body               jsonb NOT NULL,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL
);
CREATE INDEX tasks_owner_idx ON tasks (owner);

-- Immutable contract revisions.
CREATE TABLE task_revisions (
  task_id            text NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  contract_revision  integer NOT NULL,
  body               jsonb NOT NULL,
  created_at         timestamptz NOT NULL,
  PRIMARY KEY (task_id, contract_revision)
);

-- Immutable plans: canonical payload, conditions, digest and expiry.
CREATE TABLE plans (
  id                 text PRIMARY KEY,
  task_id            text NOT NULL REFERENCES tasks (id),
  principal          text NOT NULL,
  action_id          text NOT NULL,
  digest             text NOT NULL,
  approval_required  boolean NOT NULL,
  expires_at         timestamptz NOT NULL,
  body               jsonb NOT NULL,
  created_at         timestamptz NOT NULL
);
CREATE INDEX plans_pending_idx ON plans (created_at DESC) WHERE approval_required;

CREATE TABLE approvals (
  id                        text PRIMARY KEY,
  plan_id                   text NOT NULL REFERENCES plans (id),
  plan_digest               text NOT NULL,
  decision                  text NOT NULL CHECK (decision IN ('approved', 'denied')),
  approver                  text NOT NULL,
  expires_at                timestamptz NOT NULL,
  consumed_by_operation_id  text,
  body                      jsonb NOT NULL,
  created_at                timestamptz NOT NULL
);
CREATE INDEX approvals_plan_idx ON approvals (plan_id);

CREATE TABLE operations (
  id                      text PRIMARY KEY,
  plan_id                 text NOT NULL UNIQUE REFERENCES plans (id),
  task_id                 text NOT NULL REFERENCES tasks (id),
  task_revision           integer NOT NULL,
  grant_id                text NOT NULL REFERENCES grants (id),
  action_id               text NOT NULL,
  principal               text NOT NULL,
  -- Keyed digest of (deployment, principal, action, request key): one logical operation per key.
  request_key_digest      text NOT NULL UNIQUE,
  request_digest          text NOT NULL,
  request_key_expired     boolean NOT NULL DEFAULT false,
  execution_status        text NOT NULL CHECK (execution_status IN ('queued','running','completed','failed','partial','unknown','cancelled')),
  verification_status     text NOT NULL CHECK (verification_status IN ('not_requested','pending','passed','failed','inconclusive')),
  recovery_status         text NOT NULL CHECK (recovery_status IN ('none','requested','running','succeeded','failed','unknown')),
  result_summary          jsonb,
  effects                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempts                integer NOT NULL DEFAULT 0,
  external_handle         text,
  cancel_requested        boolean NOT NULL DEFAULT false,
  recovers_operation_id   text REFERENCES operations (id) ON DELETE SET NULL,
  recovery_operation_ids  text[] NOT NULL DEFAULT '{}',
  error                   jsonb,
  reconcile_attempts      integer NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL,
  submitted_at            timestamptz,
  completed_at            timestamptz,
  -- Optimistic row revision, incremented on every update.
  row_revision            integer NOT NULL DEFAULT 1
);
CREATE INDEX operations_task_idx ON operations (task_id);
CREATE INDEX operations_principal_idx ON operations (principal, created_at DESC);
CREATE INDEX operations_grant_status_idx ON operations (grant_id, execution_status);
CREATE INDEX operations_status_idx ON operations (execution_status, updated_at);

-- Expired request keys stay visible so a reused key fails instead of creating a duplicate.
CREATE TABLE request_key_tombstones (
  request_key_digest  text PRIMARY KEY,
  operation_id        text NOT NULL,
  expired_at          timestamptz NOT NULL
);

CREATE TABLE attempts (
  operation_id        text NOT NULL REFERENCES operations (id) ON DELETE CASCADE,
  sequence            integer NOT NULL,
  worker_id           text NOT NULL,
  fence               bigint NOT NULL,
  dispatch_intent_at  timestamptz NOT NULL,
  submission          text CHECK (submission IN ('not_submitted','maybe_submitted','submitted')),
  finished_at         timestamptz,
  external_handle     text,
  outcome             text,
  PRIMARY KEY (operation_id, sequence)
);

-- Append-only operation journal.
CREATE TABLE events (
  operation_id  text NOT NULL REFERENCES operations (id) ON DELETE CASCADE,
  sequence      integer NOT NULL CHECK (sequence >= 1),
  type          text NOT NULL,
  actor         text NOT NULL,
  data          jsonb NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_id, sequence)
);

CREATE TABLE evidence (
  id             text PRIMARY KEY,
  operation_id   text NOT NULL REFERENCES operations (id) ON DELETE CASCADE,
  task_id        text NOT NULL,
  task_revision  integer NOT NULL,
  check_id       text NOT NULL,
  item_index     integer,
  result         text NOT NULL CHECK (result IN ('pass','fail','inconclusive')),
  observed_at    timestamptz NOT NULL,
  body           jsonb NOT NULL,
  created_at     timestamptz NOT NULL
);
CREATE INDEX evidence_operation_idx ON evidence (operation_id);
CREATE INDEX evidence_task_idx ON evidence (task_id, task_revision);

-- Dispatch/reconcile/verify work committed in the same transaction as state changes.
CREATE TABLE outbox (
  id                bigserial PRIMARY KEY,
  kind              text NOT NULL CHECK (kind IN ('dispatch','reconcile','verify')),
  operation_id      text NOT NULL REFERENCES operations (id) ON DELETE CASCADE,
  available_at      timestamptz NOT NULL DEFAULT now(),
  attempts          integer NOT NULL DEFAULT 0,
  leased_by         text,
  lease_expires_at  timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_due_idx ON outbox (available_at, id) WHERE completed_at IS NULL;
CREATE INDEX outbox_operation_idx ON outbox (operation_id) WHERE completed_at IS NULL;

-- Leases with monotonically increasing fencing tokens. Rows are kept after release so the
-- fence never decreases for an operation.
CREATE TABLE worker_claims (
  operation_id      text PRIMARY KEY REFERENCES operations (id) ON DELETE CASCADE,
  worker_id         text NOT NULL,
  fence             bigint NOT NULL CHECK (fence >= 1),
  lease_expires_at  timestamptz NOT NULL,
  heartbeat_at      timestamptz NOT NULL
);

-- Bounded inline artifact store used when no private bucket is configured.
CREATE TABLE artifacts (
  object_id   text PRIMARY KEY,
  digest      text NOT NULL,
  media_type  text NOT NULL,
  bytes       integer NOT NULL CHECK (bytes <= 1048576),
  content     text NOT NULL,
  labels      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Immutability guards: these tables are append-only for the application.
CREATE FUNCTION vap_forbid_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER plans_immutable BEFORE UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION vap_forbid_update();
CREATE TRIGGER task_revisions_immutable BEFORE UPDATE ON task_revisions FOR EACH ROW EXECUTE FUNCTION vap_forbid_update();
CREATE TRIGGER events_immutable BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION vap_forbid_update();
CREATE TRIGGER evidence_immutable BEFORE UPDATE ON evidence FOR EACH ROW EXECUTE FUNCTION vap_forbid_update();

-- Approvals may change exactly once: recording the consuming operation.
CREATE FUNCTION vap_approval_consume_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.consumed_by_operation_id IS NOT NULL
     OR NEW.consumed_by_operation_id IS NULL
     OR NEW.id <> OLD.id OR NEW.plan_id <> OLD.plan_id OR NEW.plan_digest <> OLD.plan_digest
     OR NEW.decision <> OLD.decision OR NEW.approver <> OLD.approver OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'approvals are single-use and otherwise immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER approvals_consume_only BEFORE UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION vap_approval_consume_only();

-- Fences never move backwards.
CREATE FUNCTION vap_fence_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.fence < OLD.fence THEN
    RAISE EXCEPTION 'fencing token must not decrease' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER worker_claims_fence_monotonic BEFORE UPDATE ON worker_claims FOR EACH ROW EXECUTE FUNCTION vap_fence_monotonic();
