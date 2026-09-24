import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCatalog } from "../.github/extensions/commit-and-sip/domain.mjs";
import { loadNameRules } from "../.github/extensions/commit-and-sip/services/coffee-name.mjs";
import { addDrink, leaderboard, seedMenu, standingFor } from "../.github/extensions/commit-and-sip/services/booth-menu.mjs";

const rules = await loadNameRules();
const catalog = await loadCatalog();
const add = (menu, rawName, runId, handle) => addDrink(menu, { rawName, rules, runId, handle, now: "2026-01-01T00:00:00.000Z" });

test("the menu seeds the three house examples, unscored", () => {
  const menu = seedMenu(catalog);
  assert.deepEqual(menu.map(entry => entry.id).sort(), ["copilot-cortado", "ducky-cold-brew", "mona-latte"]);
  for (const entry of menu) {
    assert.equal(entry.example, true);
    assert.equal(entry.score, undefined, "examples are never scored");
  }
  assert.deepEqual(leaderboard(menu), [], "examples never appear on the leaderboard");
});

test("an invented drink is scored and appended to the menu", () => {
  const menu = seedMenu(catalog);
  const entry = add(menu, "Mona Moonlight Mocha", "run-1", "brave-brewing-otter");
  assert.equal(entry.example, false);
  assert.equal(entry.id, "mona-moonlight-mocha");
  assert.equal(entry.handle, "brave-brewing-otter");
  assert.ok(entry.score >= 1 && entry.score <= 5000);
  assert.ok(Array.isArray(entry.breakdown) && entry.breakdown.length > 0, "the score stays explainable at the booth");
  assert.deepEqual(Object.keys(entry).sort(), [
    "artwork", "breakdown", "createdAt", "description", "example", "handle",
    "id", "mascot", "name", "placement", "price", "runId", "score", "serving"
  ]);
  assert.equal(menu.length, 4);
});

test("duplicates are refused by canonical ID, whatever the attendee typed", () => {
  const menu = seedMenu(catalog);
  add(menu, "Mona Moonlight Mocha", "run-1", "brave-brewing-otter");
  for (const repeat of ["Mona Moonlight Mocha", "mona moonlight mocha", "  MONA   moonlight  Mocha "]) {
    assert.throws(() => add(menu, repeat, "run-2", "keen-frothing-vole"),
      { code: "duplicate_drink", status: 409 });
  }
  assert.equal(menu.length, 4, "a refused duplicate never joins the menu");
});

test("clashing with a house example says so plainly", () => {
  const menu = seedMenu(catalog);
  let error;
  assert.throws(() => add(menu, "Mona Latte", "run-1", "brave-brewing-otter"), thrown => {
    error = thrown;
    return true;
  });
  assert.equal(error.code, "duplicate_drink");
  assert.match(error.message, /house examples/);
});

test("the leaderboard ranks by score and shares rank on ties", () => {
  const menu = seedMenu(catalog);
  add(menu, "Mona Moonlight Mocha", "run-1", "brave-brewing-otter");
  add(menu, "Ducky Dawn Drip", "run-2", "keen-frothing-vole");
  add(menu, "Mona Nebula", "run-3", "calm-pouring-heron");

  const board = leaderboard(menu);
  assert.equal(board.length, 3);
  // State the tie as an explicit precondition so a future rubric change fails
  // here with an obvious reason rather than somewhere downstream.
  assert.equal(board[0].score, board[1].score, "this fixture relies on the top two names tying");
  assert.notEqual(board[1].score, board[2].score);
  assert.deepEqual(board.map(row => row.rank), [1, 1, 3], "equal scores share rank and the next rank skips");

  const standing = standingFor(menu, "run-3");
  assert.equal(standing.entries, 3);
  assert.equal(standing.rank, 3);
  assert.equal(standingFor(menu, "unknown-run"), null);
});

test("a drink cannot be added without a run and handle to attribute it to", () => {
  const menu = seedMenu(catalog);
  assert.throws(() => addDrink(menu, { rawName: "Mona Mocha", rules, runId: "", handle: "h" }), { code: "invalid_run" });
  assert.throws(() => addDrink(menu, { rawName: "Mona Mocha", rules, runId: "r", handle: "" }), { code: "invalid_handle" });
  assert.throws(() => addDrink(null, { rawName: "Mona Mocha", rules, runId: "r", handle: "h" }), { code: "menu_invalid" });
  assert.equal(menu.length, 3, "no failed attempt leaves a partial entry");
});
