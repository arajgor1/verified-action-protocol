// MCP client smoke test: the official SDK client drives the stdio bridge, which calls the
// VAP API with a demo principal. Records the SDK's protocol revision for the compatibility matrix.
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { Grant } from "@verified-action-protocol/protocol";
import { recordScenario, writeReport } from "../helpers/report.ts";
import { key, ownerCheck, ROOT, startHarness } from "../helpers/harness.ts";
import type { Harness } from "../helpers/harness.ts";

let h: Harness;
let grant: Grant;
let client: Client;

before(async () => {
  h = await startHarness();
  grant = await h.grant();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "apps/mcp/dist/main.js")],
    env: { PATH: process.env.PATH ?? "", VAP_URL: h.apiUrl, VAP_TOKEN_SOURCE: "demo:demo-agent" },
    stderr: "pipe",
  });
  client = new Client({ name: "vap-conformance-client", version: "0.1.0" });
  await client.connect(transport);
});
after(async () => {
  await writeReport("mcp");
  await client?.close();
  await h?.close();
});

type ToolResult = { structuredContent?: Record<string, any>; content: { type: string; text?: string }[]; isError?: boolean };
const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;

test("the bridge lists ordinary VAP tools and no operator tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const n of ["vap_actions_list", "vap_cancel", "vap_events_list", "vap_execute", "vap_info", "vap_observe", "vap_operation_get", "vap_prepare", "vap_reconcile", "vap_recover", "vap_task_open", "vap_verify"]) {
    assert.ok(names.includes(n), n);
  }
  assert.ok(!names.some((n) => /grant|approv|principal|resolve|sweep/.test(n)), "operator surface is not exposed");
  const info = await call("vap_info");
  assert.equal(info.structuredContent?.protocol_version, "0.1");
  assert.equal(info.structuredContent?.mcp.sdk_latest_protocol, LATEST_PROTOCOL_VERSION);
  recordScenario(`mcp-sdk-1.32.1-protocol-${LATEST_PROTOCOL_VERSION}`, true);
});

test("an agent completes and verifies a task through MCP tools with structured results", async () => {
  const issue = await h.seedIssue("alice");
  const task = await call("vap_task_open", {
    goal: "Reassign through MCP",
    grant_id: grant.id,
    scope: { actions: ["issues.*"], resources: ["issue://issue-tracker/*"] },
    required_checks: [ownerCheck("bob", `issue://issue-tracker/issues/${issue.id}`)],
  });
  assert.ok(!task.isError, JSON.stringify(task.content));
  const taskId = task.structuredContent!.id as string;
  const plan = await call("vap_prepare", { task_id: taskId, action_id: "issues.update_owner", arguments: { issue_id: issue.id, owner: "bob" } });
  const planId = plan.structuredContent!.id as string;
  const k = key("mcp");
  const exec = await call("vap_execute", { plan_id: planId, request_key: k });
  const opId = exec.structuredContent!.id as string;
  assert.equal(exec.structuredContent!.replayed, false);
  const replay = await call("vap_execute", { plan_id: planId, request_key: k });
  assert.equal(replay.structuredContent!.id, opId);
  assert.equal(replay.structuredContent!.replayed, true);
  await h.drain();
  const op = await call("vap_operation_get", { operation_id: opId, include_receipt: true });
  assert.equal(op.structuredContent!.outcome, "verified");
  assert.match(op.content[0].text ?? "", /outcome=verified/);
  const outcome = await call("vap_task_outcome", { task_id: taskId });
  assert.equal(outcome.structuredContent!.verified_complete, true);
  const events = await call("vap_events_list", { operation_id: opId });
  assert.ok((events.structuredContent!.events as unknown[]).length >= 4);
});

test("errors are returned as tool errors with code and retry disposition", async () => {
  const r = await call("vap_operation_get", { operation_id: "op_AAAAAAAAAAAAAAAAAAAA" });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent!.error.code, "NOT_FOUND");
  assert.match(r.content[0].text ?? "", /NOT_FOUND/);
});
