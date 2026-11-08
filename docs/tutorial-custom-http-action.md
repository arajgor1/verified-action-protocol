# Tutorial: register a custom HTTP action through configuration

Goal: add an action that sets an issue's status on the synthetic issue tracker, run it, and
check from saved state that it worked. No core code changes. Everything runs in Cloud Build; do
the [quickstart](quickstart.md) section "0. Before you start" first.

## 1. The configuration file

`examples/config/adapters.tutorial.json` is a copy of the fixture configuration
(`examples/config/adapters.fixture.json`) with one extra entry in `http[0].actions`: the custom
action below. To build your own action, edit that file, or copy it and point the run at your
copy with `--config`.

```json
{
  "id": "issues.set_status",
  "title": "Set issue status",
  "connector": "issue_tracker",
  "method": "PATCH",
  "path": "/issues/{args.issue_id}",
  "input_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["issue_id", "status"],
    "properties": {
      "issue_id": { "type": "string", "pattern": "^[0-9]{1,18}$" },
      "status": { "type": "string", "enum": ["open", "in_progress", "closed"] }
    }
  },
  "body_fields": ["status"],
  "effect_scope": { "resource_template": "issue://issue-tracker/issues/{args.issue_id}", "description": "issue status" },
  "side_effects": [{ "id": "status_changed", "description": "issue status updated", "class": "remote_reversible", "bounded": true }],
  "conditional_write": { "resource": "issue://issue-tracker/issues/{args.issue_id}", "mode": "native", "header": "If-Match" },
  "request_key_header": "Idempotency-Key",
  "lookup": {
    "path": "/requests/{request.key}", "query": { "seal": "1" }, "definitive_not_found": true,
    "status_pointer": "/status", "applied_values": ["applied"], "rejected_values": ["rejected"],
    "response_pointer": "/response/body"
  },
  "response": {
    "projection": ["/id", "/status", "/version"],
    "effects": [{ "side_effect_id": "status_changed", "resource_template": "issue://issue-tracker/issues/{result.id}", "version_pointer": "/version" }]
  }
}
```

What each part does:

- **`path` and `body_fields`** are data. The only substitution is `{args.issue_id}`, restricted to
  URI-safe tokens. Callers never supply URLs, headers or credentials.
- **`side_effects`** sets the risk tier. `remote_reversible` is tier 1, so the action runs under a
  grant without plan-bound approval.
- **`conditional_write`** with `mode: native` reads the version at prepare time and sends it in
  `If-Match`. The destination rejects a stale write, and the plan records `enforcement: native`.
- **`request_key_header` and `lookup`** give the destination a stable per-operation key and a
  sealed lookup, so a lost reply reconciles without duplication.
- **`response.effects`** turns the reply into recorded effects that carry the destination's
  version. Verification later uses that version to judge read freshness.

The adapter version includes a digest of this configuration, so editing it stales any plans
prepared under the old mapping. The connector origin
(`issue_tracker.origin`) is overridden at run time with `VAP_CONNECTOR_ISSUE_TRACKER_ORIGIN`.
Credentials, if a real destination needs any, come from the deployment's secret facility through
`"auth": { "type": "bearer_env", "env": "<VARIABLE NAME>" }` and never appear in the file.

## 2. Run it in the cloud

The file works as shipped, so you can run it straight away:

```bash
bash scripts/vap-cloud.sh tutorial
```

If you edited the file or made your own, commit it first. The cloud runs the committed tree, and
the command refuses to start when the configuration file is not in the commit. `git commit -s`
needs your git identity (`git config user.name` and `user.email`):

```bash
git add examples/config/<your-file>.json && git commit -s -m "Try my action"
bash scripts/vap-cloud.sh tutorial --config examples/config/<your-file>.json
```

`--config` takes any repository-relative `.json` path in the commit. The build:
- starts a disposable PostgreSQL, the synthetic issue tracker, and a VAP API and worker loaded
  with your configuration;
- seeds one issue;
- sends the requests listed in section 3, using demo identities (`demo-operator` and
  `demo-agent`) that exist only inside the build;
- checks the outcome.

The transcript is in the build log and in
`gs://$VAP_EVIDENCE_BUCKET/tutorial/<run id>/tutorial-transcript.md`. The build fails unless the
action is verified from saved state.

## 3. The requests

These are the exact API calls the run makes. Against your own deployment
([deployment-gcp.md](deployment-gcp.md)) you would send them with any HTTP client. You would
then need an identity token for an identity the deployment accepts
(`Authorization: Bearer <token>`), and `<agent subject>` would be that identity's email.

An operator issues a grant through the operator endpoint, which is never exposed as an agent
tool:

```json
POST /v1/operator/grants
{ "protocol_version": "0.1", "principal": "<agent subject>", "allowed_actions": ["issues.*"],
  "allowed_targets": ["issue://issue-tracker/*"], "risk_ceiling": 1,
  "expires_at": "<an RFC 3339 time, for example one hour from now>" }
```

The agent opens a task with a saved-state check. `<issue id>` is the seeded issue's id:

```json
POST /v1/tasks
{ "protocol_version": "0.1", "goal": "Move issue <issue id> to in_progress", "grant_id": "<grant id from the response>",
  "scope": { "actions": ["issues.set_status"], "resources": ["issue://issue-tracker/issues/*"] },
  "required_checks": [{
    "id": "status_is_in_progress", "method": "read_back", "verifier_id": "http.readback",
    "target": "issue://issue-tracker/issues/<issue id>",
    "predicate": { "op": "eq", "path": "/status", "value": "in_progress" },
    "freshness": { "max_age_seconds": 3600 }, "deadline_seconds": 10 }] }
```

It prepares a plan, then submits it with a request key it keeps:

```json
POST /v1/plans
{ "protocol_version": "0.1", "task_id": "<task id>", "action_id": "issues.set_status",
  "arguments": { "issue_id": "<issue id>", "status": "in_progress" } }

POST /v1/operations
{ "protocol_version": "0.1", "plan_id": "<plan id>", "request_key": "set-<issue id>-in-progress-1" }
```

## 4. What you should see

- `GET /v1/operations/<operation id>/receipt` shows `execution_status: completed`, then
  `verification_status: passed` once the readback check has run, and the derived outcome
  `verified`.
- `GET /v1/tasks/<task id>/outcome` reports `verified_complete: true`.
- Sending the same `POST /v1/operations` again returns the same operation with the header
  `idempotent-replay: true`.
- If the reply had been lost, the receipt would show `unknown` with `reconcile_first`.
  `POST /v1/operations/<operation id>/reconcile` resolves it through the sealed lookup.

## 5. Use it in a deployment

For a durable deployment ([deployment-gcp.md](deployment-gcp.md)), put your configuration under
`examples/config/` and rebuild the image (`bash scripts/vap-cloud.sh release`). Alternatively,
mount the file and set `VAP_ADAPTERS_CONFIG` on the API and worker services. Set the connector
origin with `VAP_CONNECTOR_ISSUE_TRACKER_ORIGIN`. The repository's conformance suite registers
the same action (`bash scripts/vap-cloud.sh test --suite integration`, test "configuration-only
custom action").
