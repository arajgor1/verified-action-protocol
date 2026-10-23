// Browser adapter (Playwright Chromium in the pinned worker image): validation failure then
// corrected submission, saved-state readback, explicit vs inferred attribution (T12),
// delayed completion, and the same task through the HTTP adapter and the browser recipe.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Grant } from "@vap/protocol";
import { recordProfile, recordScenario, writeReport } from "../helpers/report.ts";
import { key, ownerCheck, startHarness } from "../helpers/harness.ts";
import type { Harness } from "../helpers/harness.ts";

let h: Harness;
let grant: Grant;

before(async () => {
  h = await startHarness({ enableBrowser: true });
  grant = await h.grant();
});
after(async () => {
  await writeReport("browser");
  await h?.close();
});

async function viaBrowser(args: Record<string, unknown>, checks = [ownerCheck("bob")]) {
  const task = await h.task(grant, checks);
  const plan = await h.agent.prepare({ task_id: task.id, action_id: "browser.issues.create_via_form", arguments: args });
  const { operation } = await h.agent.execute(plan.id, key("br"));
  await h.drain();
  return { task, op: await h.agent.waitForOperation(operation.id, { timeoutMs: 60_000 }) };
}

describe("browser recipe", () => {
  test("captures a linked validation rejection, then the corrected submission verifies by readback", async () => {
    const first = await viaBrowser({ title: "x", owner: "bob" });
    assert.equal(first.op.execution_status, "failed");
    assert.equal(first.op.error?.code, "INVALID_ARGUMENT", JSON.stringify(first.op.error));
    const fields = (first.op.error?.details as { field_errors?: { field: string }[] }).field_errors ?? [];
    assert.ok(fields.some((f) => f.field === "title"), "the named field is reported");
    assert.ok(first.op.effects.every((e) => e.status === "not_applied"));
    const events = (await h.agent.events(first.op.id)).events.find((e) => e.type === "dispatch.result")!;
    const net = (events.data.diagnostics as { network_events: { path: string; linkage: string; status: number }[] }).network_events;
    assert.ok(net.some((n) => n.path === "/api/form-submit" && n.linkage === "explicit" && n.status === 422), "explicitly linked rejection");

    const second = await viaBrowser({ title: "Corrected title", owner: "bob" });
    assert.equal(second.op.outcome, "verified", JSON.stringify(second.op.error));
    const evidence = await h.agent.evidence(second.op.id);
    assert.ok(evidence.some((e) => e.verifier_id === "http.readback" && e.result === "pass"), "independent saved-state readback through the API");
    recordProfile("browser.issues.create_via_form", "core", true);
    recordProfile("browser.issues.create_via_form", "verified", true);
  });

  test("T12: unrelated background traffic is never attributed to the action", async () => {
    const { op } = await viaBrowser({ title: "Attribution check", owner: "bob" });
    const result = (await h.agent.events(op.id)).events.find((e) => e.type === "dispatch.result")!;
    const net = (result.data.diagnostics as { network_events: { path: string; linkage: string }[] }).network_events;
    const noise = net.filter((n) => n.path === "/noise");
    assert.ok(noise.length > 0, `background polling was observed; captured: ${JSON.stringify(net.map((n) => [n.path, (n as { status?: number }).status, n.linkage]))}`);
    assert.ok(noise.every((n) => n.linkage !== "explicit"), "noise is never explicitly linked");
    const explicit = net.filter((n) => n.linkage === "explicit");
    assert.ok(explicit.every((n) => n.path === "/api/form-submit"));
    recordScenario("T12", true);
  });

  test("delayed visibility: completion is observed by predicate and verification waits for the version", async () => {
    await h.fault("delay_visibility", { count: 1, delay_ms: 2000 });
    const { op } = await viaBrowser({ title: "Delayed record", owner: "bob" }, [ownerCheck("bob", "issue://issue-tracker/issues/{result.id}", { deadline_seconds: 15 })]);
    assert.equal(op.execution_status, "completed", JSON.stringify(op.error));
    assert.equal(op.verification_status, "passed");
  });

  test("the same task runs through the HTTP adapter and the browser recipe with the same verified result", async () => {
    const task = await h.task(grant, [ownerCheck("carol")]);
    const httpPlan = await h.agent.prepare({ task_id: task.id, action_id: "issues.create", arguments: { title: "Same task", owner: "carol" } });
    const browserPlan = await h.agent.prepare({ task_id: task.id, action_id: "browser.issues.create_via_form", arguments: { title: "Same task", owner: "carol" } });
    const a = await h.agent.execute(httpPlan.id, key());
    const b = await h.agent.execute(browserPlan.id, key());
    await h.drain();
    const opA = await h.agent.waitForOperation(a.operation.id, { timeoutMs: 60_000 });
    const opB = await h.agent.waitForOperation(b.operation.id, { timeoutMs: 60_000 });
    assert.equal(opA.outcome, "verified");
    assert.equal(opB.outcome, "verified", JSON.stringify(opB.error));
    assert.equal((await h.agent.taskOutcome(task.id)).verified_complete, true);
  });

  test("observe returns accessible structure for an allowlisted page only", async () => {
    const task = await h.task(grant, []);
    const o = await h.agent.observe({ task_id: task.id, resource_uri: "browser://issue-tracker/form" });
    assert.equal(o.facts.title, "New issue");
    await assert.rejects(h.agent.observe({ task_id: task.id, resource_uri: "browser://issue-tracker/issues/1/view" }));
  });
});
