// Conformance: registered-command CLI adapter. File result verification, bounded output,
// prompts never answered, child cleanup, timeouts (T11) and snapshot recovery.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { Grant } from "@verified-action-protocol/protocol";
import { recordProfile, writeReport } from "../helpers/report.ts";
import { key, sleep, startHarness } from "../helpers/harness.ts";
import type { Harness } from "../helpers/harness.ts";

let h: Harness;
let grant: Grant;
const linux = process.platform === "linux";

before(async () => {
  h = await startHarness();
  grant = await h.grant();
});
after(async () => {
  await writeReport("cli-adapter");
  await h?.close();
});

async function runRecipe(action: string, args: Record<string, unknown>, checks: Parameters<Harness["task"]>[1] = []) {
  const task = await h.task(grant, checks);
  const plan = await h.agent.prepare({ task_id: task.id, action_id: action, arguments: args });
  const { operation } = await h.agent.execute(plan.id, key());
  await h.drain();
  return { task, plan, op: await h.agent.waitForOperation(operation.id, { timeoutMs: 60_000 }) };
}

describe("registered commands", { skip: !linux && "process-group semantics are tested on Linux containers only" }, () => {
  test("edits a workspace file and verifies the persisted result", async () => {
    const content = "status: approved";
    const { op } = await runRecipe("cli.write_file", { path: "docs/notes.md", content }, [
      {
        id: "notes_updated",
        method: "read_back",
        verifier_id: "cli.file",
        target: "workspace://{result.workspace}/docs/notes.md",
        predicate: { op: "eq", path: "/content", value: content + "\n" },
        freshness: { max_age_seconds: 3600 },
        deadline_seconds: 5,
      },
    ]);
    assert.equal(op.outcome, "verified", JSON.stringify(op.error));
    assert.equal(op.result_summary?.exit_code, 0);
    assert.equal(op.result_summary?.parse_status, "parsed");
    const changed = op.effects.find((e) => e.resource_uri?.endsWith("/docs/notes.md"));
    assert.equal(changed?.detail, "modified");
    recordProfile("cli.write_file", "core", true);
    recordProfile("cli.write_file", "verified", true);
  });

  test("large output is bounded, counted and marked truncated", async () => {
    const { op } = await runRecipe("cli.big_output", { bytes: 2_000_000 });
    assert.equal(op.execution_status, "completed");
    assert.ok(String(op.result_summary?.stdout).length <= 70 * 1024);
    assert.ok((op.result_summary?.stdout_bytes_total as number) >= 2_000_000);
    assert.equal(op.result_summary?.output_truncated, true);
  });

  test("a confirmation prompt is detected and never answered", async () => {
    const { op } = await runRecipe("cli.wait_for_input", {});
    assert.equal(op.execution_status, "failed");
    assert.equal(op.result_summary?.input_status, "input_required");
    const ws = path.join(h.workspaceRoot, op.id);
    assert.equal(existsSync(path.join(ws, "approved-by-stdin.txt")), false, "VAP must never answer yes");
  });

  test("T11: a child that outlives its parent is terminated and the cleanup is checked", async () => {
    const { op } = await runRecipe("cli.spawn_child", {});
    assert.notEqual(op.result_summary?.cleanup, "survivors_remain");
    assert.ok(["terminated", "clean"].includes(String(op.result_summary?.cleanup)));
    const hb = path.join(h.workspaceRoot, op.id, "child-heartbeat.txt");
    const before = existsSync(hb) ? (await import("node:fs")).readFileSync(hb, "utf8") : null;
    await sleep(800);
    const afterHb = existsSync(hb) ? (await import("node:fs")).readFileSync(hb, "utf8") : null;
    assert.equal(afterHb, before, "the child no longer writes after cleanup");
  });

  test("T11: a timed-out process is terminated and reported as failed with observed effects", async () => {
    const { op } = await runRecipe("cli.sleep", { ms: 30_000 });
    assert.equal(op.execution_status, "failed");
    assert.equal(op.result_summary?.timed_out, true);
    assert.equal(op.error?.code, "LIMIT_EXCEEDED");
    assert.ok(op.effects.every((e) => e.status !== "unknown"));
  });

  test("a failure after a partial write reports the known effect, not 'no change'", async () => {
    const { op } = await runRecipe("cli.fail_after_write", {});
    assert.equal(op.execution_status, "failed");
    assert.ok(op.effects.some((e) => e.resource_uri?.endsWith("/partial.txt") && e.status === "applied"));
    assert.equal((await h.agent.receipt(op.id)).retry_guidance.disposition, "do_not_retry");
  });

  test("restore_snapshot recovery restores the isolated workspace and verifies the manifest", async () => {
    const { op } = await runRecipe("cli.write_file", { path: "README.txt", content: "overwritten" });
    assert.equal(op.execution_status, "completed");
    const rec = await h.agent.recover(op.id, "restore_snapshot", key("restore"));
    assert.ok(rec.recovery_operation);
    await h.drain();
    const recOp = await h.agent.waitForOperation(rec.recovery_operation!.id);
    assert.equal(recOp.outcome, "verified", JSON.stringify(recOp.error));
    const original = await h.agent.getOperation(op.id);
    assert.equal(original.recovery_status, "succeeded");
    const receipt = await h.agent.receipt(op.id);
    assert.ok(receipt.recovery.recovery_operation_ids.includes(recOp.id));
    recordProfile("cli.write_file", "recoverable", true);
  });

  test("traversal arguments are rejected before anything runs", async () => {
    const task = await h.task(grant, []);
    await assert.rejects(h.agent.prepare({ task_id: task.id, action_id: "cli.write_file", arguments: { path: "../escape.txt", content: "x" } }));
    await assert.rejects(h.agent.prepare({ task_id: task.id, action_id: "cli.write_file", arguments: { path: "/etc/passwd", content: "x" } }));
  });
});
