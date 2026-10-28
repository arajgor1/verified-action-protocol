# Connect an application

This page takes the SDK from installation to one verified action, then shows how to put an
existing tool behind VAP. It assumes the quickstart runtime from the [README](../README.md) is
running (`docker compose -f examples/quickstart/compose.yaml up -d`).

## Run the example

```bash
docker compose -f examples/quickstart/compose.yaml run --rm connect
```

This starts a throwaway Node.js 24 container next to the runtime, installs
`@verified-action-protocol/sdk@0.1.0-rc.1` from npm and runs
[`examples/connect/index.mjs`](../examples/connect/index.mjs). Expected output (from the
fresh-environment check, identifiers differ per run):

```text
plan pln_…: Create an issue: POST /issues with fields [title, owner]. Remote behavior beyond the declared side effects is not simulated.
operation op_…: execution=queued verification=not_requested
operation op_…: execution=completed verification=passed outcome=verified
  check owner_matches: pass (source http.issue_tracker:readback, version 1)
  effect issue_created: applied issue://issue-tracker/issues/1004
  events: operation.accepted -> dispatch.intent -> dispatch.result -> verification.started -> verification.result
verified: the issue exists with the requested owner, confirmed by reading it back
```

The example runs in a container because the quickstart runtime uses **demo authentication**,
which the API accepts only on its own loopback interface. The `connect` service shares the API
container's network namespace. To call VAP from a process on your host or another machine, run a
deployment with OIDC authentication ([deployment-docker.md](deployment-docker.md)).

## What the example does

1. **An operator grants authority.** The `demo-operator` principal creates a grant that lets
   `demo-agent` run `issues.create` against the synthetic issue tracker, up to risk tier 2.
   Agents cannot create or widen grants.
2. **The agent opens a task with a check.** The task names what success means: read the new
   issue back and compare `/owner` with `erin`.
3. **The agent prepares a plan, then executes it under a request key.** Plans are immutable and
   single-use. Repeating `execute` with the same request key returns the original operation
   instead of acting twice.
4. **The application waits for an honest final state.** `execution_status` and
   `verification_status` are separate fields; `outcome` is derived from them for display.
   `verified` means every named check passed on fresh evidence. Anything else is reported as it
   is: `unknown` means "reconcile before any retry", never "probably fine".
5. **The receipt and events say what happened and how it was checked.**

Use it in your own project:

```bash
npm install @verified-action-protocol/sdk@0.1.0-rc.1
```

Node.js 24 is required. Release candidates are published under the `next` dist-tag, so name the
version. **Do not install `@vap/*`:** that npm scope belongs to an unrelated publisher.

## Authentication

| Token provider (from `@verified-action-protocol/sdk`) | Use |
|---|---|
| `demoToken("demo-agent")` | the quickstart only; refused by a production runtime |
| `staticToken(token)` | an OIDC ID token you obtained yourself |
| `gcloudIdentityToken(audience)` | a workstation signed in with `gcloud` (Google-issued ID tokens) |
| `gcpMetadataToken(audience)` | code running on Google Cloud with a service account |
| `tokenFromEnv()` | chooses from `VAP_TOKEN_SOURCE`, as the `vap` CLI does |

A deployment verifies the token's signature, issuer, audience, expiry and verified email claim,
then maps the email to roles that an operator assigns (`agent`, `operator`, `approver`, `viewer`).

## Wrap an existing tool

VAP does not call your code directly. It calls a destination through an adapter, which declares
the action's arguments, side effects, how to look up a request whose reply was lost, and how to
check the result. Three ways to put an existing tool behind it:

**Your tool has an HTTP API** (most cases). Declare the action in an adapters configuration file;
no code is needed. The [custom HTTP action tutorial](tutorial-custom-http-action.md) builds one
step by step: the input schema, the side effects and their class (which sets the risk tier),
conditional writes, the request-key header, and the `lookup` block that lets a lost reply be
reconciled without a duplicate write. Then give the runtime your file. In the quickstart, add to
both the `api` and `worker` services:

```yaml
    volumes:
      - ./my-adapters.json:/app/config/adapters.json:ro
    environment:
      VAP_ADAPTERS_CONFIG: /app/config/adapters.json
      VAP_CONNECTOR_MY_TOOL_ORIGIN: https://my-tool.example.com   # per connector name
```

Check a configuration before you deploy it with
[`examples/sdk/offline-check.mjs`](../examples/sdk/offline-check.mjs), which validates every
action descriptor and runs static conformance without a runtime ([sdk-example.md](sdk-example.md)).

**Your tool is a command-line program.** Register it as a CLI recipe: a fixed absolute executable,
an argument schema, a workspace, a timeout and output limits. VAP never starts a shell and never
answers prompts. Keep recipes to fixed programs; the security decision record forbids recipes that
run `mount`, `nsenter`, `blkid`, partition tools, `gzip` or `tar` on compressed archives, or
terminfo tools on untrusted input ([decision record](security/runtime-decision-record.md#deployment-restrictions-that-are-not-enforced-by-the-image)).
The recipes in [`examples/config/adapters.fixture.json`](../examples/config/adapters.fixture.json)
show the format.

**Your agent speaks MCP.** The stdio MCP bridge exposes VAP as ordinary tools (`vap_task_open`,
`vap_prepare`, `vap_execute`, `vap_verify`, `vap_reconcile`, ...); see [mcp.md](mcp.md). The
actions behind those tools are still the ones your adapters configuration declares.

Writing a new adapter type in code (the adapter SDK's `defineAction`) needs a runtime build that
includes it; the published image contains only the HTTP and registered-command adapters.
