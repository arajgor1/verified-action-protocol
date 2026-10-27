# MCP bridge

`apps/mcp` is an ordinary stdio MCP server built with the official TypeScript SDK
(`@modelcontextprotocol/sdk` 1.32.1, low-level `Server` with `tools` capability). It maps
standard tool calls onto the VAP HTTP API through `@verified-action-protocol/sdk`'s client. It defines no new
protocol methods and no undocumented capabilities; VAP capabilities are discovered through the
`vap_info` tool.

## Tools

| Tool | API | Notes |
|---|---|---|
| `vap_info` | `GET /v1/info` | includes the SDK's latest protocol revision |
| `vap_task_open` | `POST /v1/tasks` | |
| `vap_observe` | `POST /v1/observations` | read-only hint |
| `vap_actions_list` | `GET /v1/actions` | read-only hint |
| `vap_prepare` | `POST /v1/plans` | |
| `vap_execute` | `POST /v1/operations` | idempotent per request key; `replayed` in the result |
| `vap_operation_get` | `GET /v1/operations/{id}` or `/receipt` | |
| `vap_operation_find` | `POST /v1/operations/lookup` | finds your own operation by action and request key; call it after a restart before preparing anything new |
| `vap_verify` | `POST /v1/operations/{id}/verify` | |
| `vap_reconcile` | `POST /v1/operations/{id}/reconcile` | |
| `vap_recover` | `POST /v1/operations/{id}/recover` | |
| `vap_cancel` | `POST /v1/operations/{id}/cancel` | never rollback |
| `vap_events_list` | `GET /v1/operations/{id}/events` | |
| `vap_task_outcome` | `GET /v1/tasks/{id}/outcome` | additional read-only helper |

Results carry `structuredContent` (the API object) and a concise text rendering. Errors return
`isError: true` with `{ error: { code, message, retry_disposition, ... } }`.

Operator-only endpoints (grants, approvals, principals, resolution, sweep) are not tools: an agent
can see that a plan awaits approval but cannot approve it or supply an approver identity.

## Running

```bash
VAP_URL=https://<api> VAP_TOKEN_SOURCE=gcp-metadata VAP_AUDIENCE=https://<api> node apps/mcp/dist/main.js
```

Run it inside the authorized cloud development environment so it obtains identity from workload
identity. `VAP_TOKEN_SOURCE=gcloud` uses the operator's own short-lived login for development.

## Compatibility claims

Compatibility is claimed only for client and SDK combinations actually tested. The tested
combination is recorded by `tests/mcp/mcp.test.ts` (official SDK `Client` over
`StdioClientTransport`, SDK 1.32.1, the SDK's `LATEST_PROTOCOL_VERSION`) in the conformance
report. Tested so far: `@modelcontextprotocol/sdk` 1.32.1 `Client` over stdio, protocol revision
`2025-11-25` (Cloud Build `09824d5d`). No other client is claimed. Direct remote MCP
over HTTP with OAuth is deferred; hosted agent clients that only speak remote MCP cannot connect
to this stdio bridge directly.
