// Owner-keyed fixture faults (FIXTURE_OWNER_FAULTS), used by the managed staging deployment to
// aim a disruption at one operation on a horizontally scaled fixture.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { parseOwnerFaults, startFixture } from "@verified-action-protocol/fixture-issue-tracker";
import type { FixtureHandle } from "@verified-action-protocol/fixture-issue-tracker";
import { createDatabase, sleep } from "../helpers/harness.ts";

let db: Awaited<ReturnType<typeof createDatabase>>;
let fx: FixtureHandle;

before(async () => {
  db = await createDatabase("vapo");
  fx = await startFixture({
    databaseUrl: db.url,
    port: 0,
    testControls: true,
    ownerFaults: parseOwnerFaults('{"carol":{"delay_visibility_ms":1500},"dave":{"lost_reply":true}}', true),
  });
});
after(async () => {
  await fx?.close();
  await db?.drop();
});

async function seed(): Promise<string> {
  const r = await fetch(`${fx.url}/issues`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Owner fault", owner: "alice" }) });
  assert.equal(r.status, 201);
  return ((await r.json()) as { id: string }).id;
}
const owner = async (id: string) => ((await (await fetch(`${fx.url}/issues/${id}`)).json()) as { owner: string }).owner;
const patch = (id: string, o: string, key: string) =>
  fetch(`${fx.url}/issues/${id}`, { method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ owner: o }) });

describe("owner-keyed fixture faults", () => {
  test("an update to a delayed owner commits but stays invisible for the configured time", async () => {
    const id = await seed();
    const r = await patch(id, "carol", "of-delay-1");
    assert.equal(r.status, 200);
    assert.equal(await owner(id), "alice", "the new version must not be visible yet");
    await sleep(2000);
    assert.equal(await owner(id), "carol");
  });

  test("an update to a lost-reply owner commits and the reply is dropped; a replay is answered", async () => {
    const id = await seed();
    await assert.rejects(patch(id, "dave", "of-lost-1"), "the reply must be dropped");
    assert.equal(await owner(id), "dave", "the write must have committed");
    const lookup = await fetch(`${fx.url}/requests/of-lost-1`);
    assert.equal(lookup.status, 200, "the request key records the committed write");
    const replay = await patch(id, "dave", "of-lost-1");
    assert.equal(replay.status, 200, "a replay of the same key is answered, not dropped again");
  });

  test("other owners are unaffected", async () => {
    const id = await seed();
    assert.equal((await patch(id, "bob", "of-none-1")).status, 200);
    assert.equal(await owner(id), "bob");
  });

  test("configuration is refused without test controls or when malformed", () => {
    assert.equal(parseOwnerFaults(undefined, false), undefined);
    assert.throws(() => parseOwnerFaults('{"carol":{"lost_reply":true}}', false), /requires FIXTURE_TEST_CONTROLS/);
    assert.throws(() => parseOwnerFaults('{"mallory":{"lost_reply":true}}', true), /unknown owner/);
    assert.throws(() => parseOwnerFaults('{"carol":{"delay_visibility_ms":-1}}', true), /0-600000/);
    assert.throws(() => parseOwnerFaults('{"carol":{"explode":true}}', true), /unknown fields/);
    assert.throws(() => parseOwnerFaults("[]", true), /JSON object/);
  });
});
