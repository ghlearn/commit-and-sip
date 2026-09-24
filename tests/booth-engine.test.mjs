import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../.github/extensions/commit-and-sip/store.mjs";
import { BoothEngine } from "../.github/extensions/commit-and-sip/booth-engine.mjs";
import { loadCatalog } from "../.github/extensions/commit-and-sip/domain.mjs";
import { loadNameRules } from "../.github/extensions/commit-and-sip/services/coffee-name.mjs";

const catalog = await loadCatalog();
const rules = await loadNameRules();

async function booth(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "sip-booth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RunStore(directory);
  return { engine: new BoothEngine({ store, catalog, rules, ...options }), store };
}

test("an attendee gets a handle before inventing anything", async t => {
  const { engine } = await booth(t);
  const start = await engine.open({ runId: "booth-1" });
  assert.equal(start.phase, "naming");
  assert.match(start.handle, /^[a-z]+-[a-z]+-[a-z]+$/, "a memorable handle is shown from the start");
  assert.equal(start.submission, null);
  assert.deepEqual(start.leaderboard, []);
  assert.deepEqual(start.houseMenu.map(entry => entry.id).sort(),
    ["copilot-cortado", "ducky-cold-brew", "mona-latte"]);
  assert.ok(start.houseMenu.every(entry => entry.example), "only examples are on the menu at first");
  assert.deepEqual(start.mascots, ["mona", "ducky", "copilot"]);
});

test("reopening the same run keeps the same handle and never restarts it", async t => {
  const { engine } = await booth(t);
  const first = await engine.open({ runId: "booth-1" });
  const again = await engine.open({ runId: "booth-1" });
  assert.equal(again.handle, first.handle, "an attendee keeps the handle they wrote down");
  assert.equal(again.phase, "naming");
});

test("submitting a name scores it and puts it on the house menu", async t => {
  const { engine } = await booth(t);
  const start = await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonlight Mocha" });

  assert.equal(served.phase, "served");
  assert.equal(served.submission.name, "Mona Moonlight Mocha");
  assert.ok(served.submission.score >= 1 && served.submission.score <= 5000);
  assert.ok(served.submission.breakdown.length > 0, "the attendee can see why they scored what they did");
  assert.equal(served.houseMenu.length, 4);
  assert.equal(served.standing.rank, 1);
  assert.equal(served.standing.entries, 1);
  assert.equal(served.leaderboard[0].handle, start.handle);
  assert.match(served.statusMessage, /out of 5000/);
});

test("each attendee invents exactly one drink", async t => {
  const { engine } = await booth(t);
  await engine.open({ runId: "booth-1" });
  await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonlight Mocha" });
  await assert.rejects(engine.dispatch("booth-1", "submit_name", { name: "Ducky Dawn Drip" }),
    { code: "already_served", status: 409 });
});

test("a duplicate is refused without consuming the attendee's turn", async t => {
  const { engine } = await booth(t);
  await engine.open({ runId: "booth-1" });
  await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonlight Mocha" });
  await engine.open({ runId: "booth-2" });

  await assert.rejects(engine.dispatch("booth-2", "submit_name", { name: "mona moonlight mocha" }),
    { code: "duplicate_drink", status: 409 });
  // The second attendee must still be able to try again with another name.
  const retry = await engine.dispatch("booth-2", "submit_name", { name: "Ducky Dawn Drip" });
  assert.equal(retry.phase, "served");
  assert.equal(retry.submission.name, "Ducky Dawn Drip");

  const state = await engine.get("booth-2");
  assert.equal(state.houseMenu.length, 5, "only the accepted drink joined the menu");
});

test("an invalid name is refused with booth-readable guidance and no state change", async t => {
  const { engine } = await booth(t);
  await engine.open({ runId: "booth-1" });
  for (const [name, code] of [
    ["Morning Espresso", "invalid_name"],
    ["Mona <img src=x>", "invalid_name"],
    ["Mo", "invalid_name"],
    ["Mona Latte", "duplicate_drink"],
  ]) {
    await assert.rejects(engine.dispatch("booth-1", "submit_name", { name }), { code });
  }
  const state = await engine.get("booth-1");
  assert.equal(state.phase, "naming");
  assert.equal(state.submission, null);
  assert.equal(state.houseMenu.length, 3);
});

test("handles stay unique across attendees at the same booth", async t => {
  const { engine } = await booth(t);
  const handles = new Set();
  for (let index = 0; index < 25; index++) {
    handles.add((await engine.open({ runId: `booth-${index}` })).handle);
  }
  assert.equal(handles.size, 25, "two attendees must never share a leaderboard identity");
});

test("the booth never invents a leaderboard URL", async t => {
  const plain = await booth(t);
  assert.equal((await plain.engine.open({ runId: "booth-1" })).leaderboardUrl, null,
    "no QR or link is offered until staff configure an approved destination");

  const configured = await booth(t, { leaderboardUrl: "https://example.invalid/board" });
  assert.equal((await configured.engine.open({ runId: "booth-1" })).leaderboardUrl, "https://example.invalid/board");
});

test("booth runs and other exercise modes never collide on a run ID", async t => {
  const { engine, store } = await booth(t);
  await store.transaction(data => { data.runs["taken"] = { runId: "taken", mode: "rehearsal", phase: "order" }; });
  await assert.rejects(engine.open({ runId: "taken" }), { code: "run_conflict" });
  await assert.rejects(engine.get("taken"), { code: "run_conflict" });
  await assert.rejects(engine.get("missing"), { code: "run_missing", status: 404 });
});

test("unknown actions and malformed input are refused", async t => {
  const { engine } = await booth(t);
  await engine.open({ runId: "booth-1" });
  await assert.rejects(engine.dispatch("booth-1", "approve"), { code: "unknown_action", status: 400 });
  await assert.rejects(engine.dispatch("booth-1", "submit_name", { name: "Mona Mocha", extra: 1 }), { status: 400 });
  await assert.rejects(engine.open({ runId: "booth-1", mode: "booth" }), { status: 400 });
  await assert.rejects(engine.open({ runId: "" }), { code: "invalid_run", status: 400 });
});
