// T14: restoring a journal backup with unresolved submissions never replays them.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { Coordinator } from "@verified-action-protocol/core";
import { PROTOCOL_VERSION } from "@verified-action-protocol/protocol";
import { PgJournal } from "@verified-action-protocol/store-postgres";
import { recordScenario, writeReport } from "../helpers/report.ts";
import { adminUrl, AGENT, DIGEST_KEY, key, ownerCheck, sleep, startHarness } from "../helpers/harness.ts";
import type { Harness } from "../helpers/harness.ts";

let h: Harness;
let restored: PgJournal | null = null;
let restoredName: string | null = null;

before(async () => {
  h = await startHarness();
});
after(async () => {
  await writeReport("restore");
  await restored?.close().catch(() => {});
  if (restoredName) {
    const a = new pg.Client({ connectionString: adminUrl() });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${restoredName} WITH (FORCE)`);
    await a.end();
  }
  await h?.close();
});

test("T14: unresolved submissions stay unknown after restore, keys survive, and reconciliation does not resubmit", async () => {
  const grant = await h.grant();
  const task = await h.task(grant, [ownerCheck("bob")]);
  const plan = await h.agent.prepare({ task_id: task.id, action_id: "issues.create", arguments: { title: "T14", owner: "bob" } });
  const k = key("t14");
  await h.fault("lost_reply", { count: 1 });
  const { operation } = await h.agent.execute(plan.id, k);
  await h.drain();
  assert.equal((await h.agent.getOperation(operation.id)).execution_status, "unknown");

  // "Backup": clone the journal database while no connections are open (restore drill).
  await h.journal.close();
  restoredName = `${h.journalDb.name}_restored`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${restoredName} TEMPLATE ${h.journalDb.name}`);
  await admin.end();
  const u = new URL(adminUrl());
  u.pathname = `/${restoredName}`;
  restored = new PgJournal({ connectionString: u.toString() });
  const c = new Coordinator(restored, h.registry, { digestKey: DIGEST_KEY, deploymentId: "test" });

  const op = await c.getOperation(AGENT, operation.id);
  assert.equal(op.execution_status, "unknown", "uncertainty survives the restore");
  const replay = await c.submitOperation(AGENT, { protocol_version: PROTOCOL_VERSION, plan_id: plan.id, request_key: k });
  assert.equal(replay.replayed, true, "request key survives the restore");
  assert.equal(replay.operation.id, operation.id);

  const sweep = await c.sweep("restore-sweeper");
  assert.equal(sweep.stranded, 0, "nothing is re-dispatched");
  await sleep(1200);
  for (let i = 0; i < 5; i++) await c.drainOutbox("restore-worker", 50);
  const after = await c.getOperation(AGENT, operation.id);
  assert.equal(after.execution_status, "completed", "reconciled through lookup");
  assert.equal(after.attempts, 1, "no automatic resubmission");
  assert.equal((await h.control(`/writes/${operation.id}`)).writes, 1);
  recordScenario("T14", true);
});
