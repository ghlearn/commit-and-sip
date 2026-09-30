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

  const configured = await booth(t, { leaderboardUrl: "https://sip.example.com/board" });
  assert.equal((await configured.engine.open({ runId: "booth-1" })).leaderboardUrl, "https://sip.example.com/board");
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

test("the attendee picks a mascot and where it sits, and the name must match", async t => {
  const { engine } = await booth(t);
  await engine.open({ runId: "booth-1" });
  // Declaring a choice is honoured, not quietly overridden by what was typed.
  await assert.rejects(
    engine.dispatch("booth-1", "submit_name", { name: "Cold Brew Ducky", mascot: "mona" }),
    { code: "mascot_mismatch", status: 400 });
  await assert.rejects(
    engine.dispatch("booth-1", "submit_name", { name: "Cold Brew Ducky", placement: "start" }),
    { code: "placement_mismatch", status: 400 });
  await assert.rejects(
    engine.dispatch("booth-1", "submit_name", { name: "Cold Brew Ducky", placement: "sideways" }),
    { code: "invalid_choice", status: 400 });
  // A rejected choice costs them nothing; the run is untouched.
  assert.equal((await engine.get("booth-1")).phase, "naming");

  const served = await engine.dispatch("booth-1", "submit_name",
    { name: "Cold Brew Ducky", mascot: "ducky", placement: "end" });
  assert.equal(served.submission.placement, "end");
  assert.equal(served.phase, "served");
});

test("every placement is accepted and none of them is worth more", async t => {
  const placements = { "Mona Mocha": "start", "Iced Ducky Cup": "middle", "Morning Copilot": "end", "Monachino": "blend" };
  for (const [name, placement] of Object.entries(placements)) {
    const { engine } = await booth(t);
    await engine.open({ runId: "booth-1" });
    const served = await engine.dispatch("booth-1", "submit_name", { name, placement });
    assert.equal(served.submission.placement, placement);
    assert.ok(served.submission.score > 0 && served.submission.score <= 5000);
  }
});

test("completing hands the booth to the next attendee without erasing the menu", async t => {
  const { engine } = await booth(t);
  const start = await engine.open({ runId: "booth-1" });
  await assert.rejects(engine.dispatch("booth-1", "complete", {}),
    { code: "not_served", status: 409 }, "finishing early would leave no entry behind");

  await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonlight" });
  const done = await engine.dispatch("booth-1", "complete", {});
  assert.equal(done.phase, "complete");
  assert.ok(done.completedAt, "the finish time is recorded");
  assert.ok(done.standing, "they still see where they placed");

  // Completing is idempotent, so a double click cannot corrupt the run.
  assert.equal((await engine.dispatch("booth-1", "complete", {})).completedAt, done.completedAt);

  // The next attendee starts clean but inherits the menu built so far.
  const next = await engine.open({ runId: "booth-2" });
  assert.equal(next.phase, "naming");
  assert.notEqual(next.handle, start.handle);
  assert.ok(next.houseMenu.some(entry => entry.id === "mona-moonlight"), "the drink stays on the menu");
  assert.equal(next.leaderboard.length, 1, "and stays on the leaderboard");
  await assert.rejects(engine.dispatch("booth-2", "submit_name", { name: "Mona Moonlight" }),
    { code: "duplicate_drink", status: 409 }, "so it cannot be claimed twice");
});

test("a completed run cannot be reopened to invent a second drink", async t => {
  const { engine } = await booth(t);
  await engine.open({ runId: "booth-1" });
  await engine.dispatch("booth-1", "submit_name", { name: "Ducky Daybreak" });
  await engine.dispatch("booth-1", "complete", {});
  await assert.rejects(engine.dispatch("booth-1", "submit_name", { name: "Ducky Dusk" }),
    { code: "already_served", status: 409 });
  assert.equal((await engine.open({ runId: "booth-1" })).phase, "complete", "reopening shows the finished state");
});

test("the QR destination is only offered once staff configure a real one", async t => {
  const { engine } = await booth(t);
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Meridian" });
  assert.equal(served.attendeeUrl, null, "no destination is deployed, so none is invented");
  assert.equal(served.leaderboardUrl, null);

  const live = await booth(t, { leaderboardUrl: "https://sip.example.com/board" });
  const open = await live.engine.open({ runId: "booth-2" });
  assert.equal(open.attendeeUrl, null, "there is nothing to scan before they have played");
  const entry = await live.engine.dispatch("booth-2", "submit_name", { name: "Copilot Comet" });
  assert.equal(entry.attendeeUrl, `https://sip.example.com/board?handle=${open.handle}&drink=copilot-comet`,
    "the drink ID pins the lookup, so a phrase another booth also used cannot mislead the phone");

  for (const bad of ["not-a-url", "http://sip.example.com/board", "https://localhost/board"]) {
    assert.throws(() => new BoothEngine({ store: null, catalog, rules, leaderboardUrl: bad }),
      { code: "invalid_leaderboard_url" }, `${bad} must not become something attendees are told to scan`);
  }
});

test("staff can take a drink down, and the name does not come straight back", async t => {
  const { engine } = await booth(t);
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Regrettable" });
  assert.equal(served.submission.id, "mona-regrettable");
  assert.ok(served.leaderboard.some(row => row.name === "Mona Regrettable"));

  const record = await engine.removeDrink({
    id: "mona-regrettable", removedBy: "booth lead", reason: "reported at the counter",
  });
  assert.equal(record.name, "Mona Regrettable");
  assert.equal(record.handle, served.handle, "the audit record keeps who entered it");
  assert.ok(Date.parse(record.removedAt), "and when it was taken down");

  const after = await engine.house();
  assert.ok(!after.houseMenu.some(drink => drink.id === "mona-regrettable"), "it leaves the published menu");
  assert.deepEqual(after.leaderboard, [], "and the standings it was ranked in");

  // The point of a tombstone: the next person cannot simply retype it.
  await engine.open({ runId: "booth-2" });
  await assert.rejects(() => engine.dispatch("booth-2", "submit_name", { name: "mona   REGRETTABLE " }),
    { code: "unavailable_drink" }, "normalization must not be a way back in");
  const fresh = await engine.dispatch("booth-2", "submit_name", { name: "Mona Meridian" });
  assert.equal(fresh.submission.name, "Mona Meridian", "unrelated names are unaffected");
});

test("a removed drink tells the attendee the truth rather than a pending rank", async t => {
  const { engine } = await booth(t, { leaderboardUrl: "https://sip.example.com/board" });
  const open = await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Ducky Regrettable" });
  assert.equal(served.removed, null);
  assert.equal(served.attendeeUrl, `https://sip.example.com/board?handle=${open.handle}&drink=ducky-regrettable`);

  await engine.removeDrink({ id: "ducky-regrettable", removedBy: "booth lead", reason: "reported" });
  const view = await engine.get("booth-1");
  assert.ok(view.removed, "the run says plainly that it was taken down");
  assert.equal(view.standing, null);
  assert.equal(view.attendeeUrl, null, "no QR to a leaderboard place that no longer exists");
  assert.equal(view.removed.at, (await engine.store.read()).removals[0].removedAt);
  assert.ok(!("removedBy" in view.removed) && !("reason" in view.removed),
    "who decided and why stays off the attendee screen");
});

test("takedown is staff-only and always accountable", async t => {
  const { engine } = await booth(t);
  await engine.open({ runId: "booth-1" });
  await engine.dispatch("booth-1", "submit_name", { name: "Copilot Regrettable" });

  // The attendee-facing surface must not reach it.
  await assert.rejects(() => engine.dispatch("booth-1", "remove_drink", { id: "copilot-regrettable" }),
    { code: "unknown_action" }, "the canvas queue cannot delete a rival's entry");

  for (const bad of [
    { id: "copilot-regrettable", removedBy: "", reason: "reported" },
    { id: "copilot-regrettable", removedBy: "booth lead", reason: "  " },
  ]) {
    await assert.rejects(() => engine.removeDrink(bad), { code: "invalid_removal" },
      "an unattributed or unexplained removal is not recorded");
  }
  await assert.rejects(() => engine.removeDrink({ id: "mona-latte", removedBy: "lead", reason: "x" }),
    { code: "example_drink" }, "house examples are configuration, not moderation");
  await assert.rejects(() => engine.removeDrink({ id: "never-existed", removedBy: "lead", reason: "x" }),
    { code: "drink_missing" });
  assert.deepEqual((await engine.store.read()).removals, [], "nothing was logged for a refused removal");
});

test("the staff takedown command refuses to act on a half-given instruction", async () => {
  const { parseArguments } = await import("../scripts/remove-drink.mjs");
  assert.deepEqual(parseArguments(["--id", "mona-x", "--by", "lead", "--reason", "reported"]),
    { by: "lead", id: "mona-x", list: false, reason: "reported", retry: false });
  assert.equal(parseArguments(["--list"]).list, true);
  assert.equal(parseArguments(["--retry"]).retry, true, "retrying takedowns needs no drink ID");
  for (const argv of [
    [], ["--id", "mona-x"], ["--id", "mona-x", "--by", "lead"],
    ["--id", "mona-x", "--reason", "reported"],
    // A flag swallowing the next flag as its value is how "--by --reason x"
    // silently attributes a removal to "--reason".
    ["--id", "mona-x", "--by", "--reason", "reported"],
    ["--wat", "1"],
  ]) {
    assert.throws(() => parseArguments(argv), /needs a value|Usage|Unknown option/);
  }
});

// A booth day appends one drink per attendee. These cover the windowing that
// keeps the attendee screen readable, and the three things it must not break:
// each attendee's true rank, the staff view, and seeing your own drink.
async function serveMany(engine, count) {
  const names = [];
  for (let index = 0; index < count; index += 1) {
    const runId = `booth-many-${index}`;
    await engine.open({ runId });
    const name = `Mona Brew ${index + 1}`;
    await engine.dispatch(runId, "submit_name", { name });
    await engine.dispatch(runId, "complete", {});
    names.push(name);
  }
  return names;
}

test("the attendee menu and leaderboard stay readable on a long booth day", async t => {
  const { engine } = await booth(t);
  await serveMany(engine, 20);
  const house = await engine.house();

  const invented = house.houseMenu.filter(entry => !entry.example);
  assert.equal(invented.length, 12, "the menu window holds, it does not grow with every attendee");
  assert.equal(house.houseMenuTotal, 20, "but the screen can still say how many were really invented");
  assert.equal(house.leaderboard.length, 10, "and the leaderboard is a top ten, not all of them");
  assert.equal(house.leaderboardTotal, 20);
  assert.ok(house.houseMenu.some(entry => entry.example), "the worked examples are never windowed out");
});

test("an attendee outside the shown top ten is still ranked against everyone", async t => {
  const { engine } = await booth(t);
  await serveMany(engine, 20);
  const state = await engine.open({ runId: "booth-many-19" });

  assert.equal(state.standing.entries, 20,
    "standing counts the whole booth, not the ten rows the board happens to show");
  assert.ok(state.standing.rank >= 1 && state.standing.rank <= 20);
  assert.equal(state.leaderboard.length, 10, "even though the board beside it is windowed");
});

test("booth staff still see every drink they may need to take down", async t => {
  const { engine } = await booth(t);
  const names = await serveMany(engine, 20);
  const overview = await engine.adminOverview();

  const invented = overview.houseMenu.filter(entry => !entry.example);
  assert.equal(invented.length, 20, "a windowed attendee screen must not hide a drink from moderation");
  assert.equal(overview.leaderboard.length, 20);
  assert.ok(names.every(name => invented.some(entry => entry.name === name)));
});

test("an attendee can see the drink they just invented on the house menu", async t => {
  const { engine } = await booth(t);
  await serveMany(engine, 20);
  await engine.open({ runId: "booth-last" });
  const served = await engine.dispatch("booth-last", "submit_name", { name: "Ducky Nightcap" });

  const invented = served.houseMenu.filter(entry => !entry.example);
  assert.equal(invented[0].name, "Ducky Nightcap",
    "the newest drink leads the menu, so the person who just named it sees it without scrolling");
});
