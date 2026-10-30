import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCatalog } from "../.github/extensions/commit-and-sip/domain.mjs";
import { loadNameRules } from "../.github/extensions/commit-and-sip/services/coffee-name.mjs";
import { addDrink, leaderboard, prepareDrink, seedMenu, standingFor } from "../.github/extensions/commit-and-sip/services/booth-menu.mjs";

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

// Staff procedure depends on this split. A duplicate is already visible on the
// menu, so naming it leaks nothing. A blocklist hit and a staff takedown must
// stay indistinguishable, or the generic wording identifies a blocklist hit by
// elimination and the counter starts guessing aloud what somebody else typed.
test("a removed drink is refused in the same words as a blocklist hit, and a duplicate is not", () => {
  const menu = seedMenu(catalog);
  const invented = add(menu, "Mona Moonlight Mocha", "run-1", "brave-brewing-otter");
  const message = fn => {
    try { fn(); } catch (error) { return error.message; }
    throw new Error("the name was accepted when it should have been refused");
  };

  const removed = message(() => addDrink(menu, {
    rawName: "Ducky Daybreak", rules, runId: "run-2", handle: "keen-frothing-vole",
    now: "2026-01-01T00:00:00.000Z", removedIds: ["ducky-daybreak"]
  }));
  // A fixture term, never the shipped list: replacing the placeholder must not
  // oblige a reviewer to paste moderation terms into the suite to keep it green.
  const blockedRules = {
    ...rules,
    blocklist: { review: { placeholder: true }, entries: [{ term: "zzqq", match: "substring" }] }
  };
  const blocked = message(() => addDrink(menu, {
    rawName: "Mona zzqq", rules: blockedRules, runId: "run-3", handle: "swift-steaming-hare",
    now: "2026-01-01T00:00:00.000Z"
  }));
  const duplicate = message(() => add(menu, "Mona Moonlight Mocha", "run-4", "glad-pouring-stoat"));

  assert.equal(removed, blocked,
    "a takedown and a blocklist hit must be worded identically, or one is identifiable by elimination");
  assert.ok(!/removed|takedown|staff|blocklist|blocked/i.test(removed),
    "and the shared wording must not hint at why");
  assert.match(duplicate, new RegExp(invented.name),
    "a duplicate names the drink, which is already on the menu in front of them");
  assert.notEqual(duplicate, removed);
});

test("the leaderboard ranks by score and gives a tie to the drink served first", () => {
  const menu = seedMenu(catalog);
  const at = (rawName, runId, handle, now) => addDrink(menu, { rawName, rules, runId, handle, now });
  // Served in the opposite order to the names' alphabetical and ID order, so
  // only the time can put the first-served drink on top.
  // Word order swapped: two different drinks with one score, as a menu kept
  // from before scores had to be unique could hold.
  at("Mona Velvet Mocha", "run-1", "brave-brewing-otter", "2026-01-01T09:00:00.000Z");
  at("Mona Mocha Velvet", "run-2", "keen-frothing-vole", "2026-01-01T09:05:00.000Z");
  at("Mona Nebula", "run-3", "calm-pouring-heron", "2026-01-01T09:10:00.000Z");

  const board = leaderboard(menu);
  assert.equal(board.length, 3);
  // State the tie as an explicit precondition so a future rubric change fails
  // here with an obvious reason rather than somewhere downstream.
  assert.equal(board[0].score, board[1].score, "this fixture relies on the top two names tying");
  assert.notEqual(board[1].score, board[2].score);
  assert.deepEqual(board.map(row => row.name), ["Mona Velvet Mocha", "Mona Mocha Velvet", "Mona Nebula"],
    "the tied drink served first ranks above the one served later");
  assert.deepEqual(board.map(row => row.rank), [1, 2, 3], "no two drinks share a place");

  const standing = standingFor(menu, "run-2");
  assert.equal(standing.entries, 3);
  assert.equal(standing.rank, 2);
  assert.equal(standingFor(menu, "unknown-run"), null);
});

test("a tie in score and time still ranks the same however the menu is stored", () => {
  const menu = seedMenu(catalog);
  // `add` stamps every drink with the same instant, so only the ID separates these two.
  const first = add(menu, "Mona Velvet Mocha", "run-1", "brave-brewing-otter");
  const second = add(menu, "Mona Mocha Velvet", "run-2", "keen-frothing-vole");
  assert.equal(first.score, second.score, "this fixture relies on the two names tying");
  // An ID that would sort first, so only the missing time can put it last.
  menu.push({ ...first, createdAt: undefined, handle: "calm-pouring-heron", id: "aaa-undated", name: "Undated Drink", runId: "run-3" });

  const board = leaderboard(menu);
  assert.deepEqual(board.map(row => row.rank), [1, 2, 3]);
  assert.deepEqual(board.map(row => row.name), ["Mona Mocha Velvet", "Mona Velvet Mocha", "Undated Drink"],
    "the same instant falls back to the drink ID, and a row with no time comes last");
  assert.deepEqual(leaderboard([...menu].reverse()), board, "storage order never changes the board");
});

test("a standalone menu refuses a score another drink holds, until a takedown frees it", () => {
  const menu = seedMenu(catalog);
  const unique = (rawName, runId, handle) => addDrink(menu, { rawName, rules, runId, handle, uniqueScore: true,
    now: "2026-01-01T00:00:00.000Z" });
  const first = unique("Mona Velvet Mocha", "run-1", "brave-brewing-otter");
  let error;
  assert.throws(() => unique("Mona Mocha Velvet", "run-2", "keen-frothing-vole"), thrown => { error = thrown; return true; });
  assert.deepEqual([error.code, error.status], ["score_taken", 409]);
  assert.match(error.message, /Tweak your name/, "the attendee is told what to do next");
  assert.equal(menu.length, 4, "a refused drink never joins the menu");
  // House examples carry no score, so they never block one.
  assert.ok(unique("Mona Moonrise Mocha", "run-3", "calm-pouring-heron"));
  // Preparing checks everything and builds the entry, but adds nothing.
  const prepared = prepareDrink(menu, { rawName: "Ducky Dawn Drizzle", rules, runId: "run-4", handle: "glad-pouring-stoat", uniqueScore: true });
  assert.equal(prepared.id, "ducky-dawn-drizzle");
  assert.equal(menu.length, 5);
  assert.throws(() => prepareDrink(menu, { rawName: "Mona Mocha Velvet", rules, runId: "run-2", handle: "keen-frothing-vole", uniqueScore: true }),
    { code: "score_taken" });
  menu.splice(menu.indexOf(first), 1);
  assert.equal(unique("Mona Mocha Velvet", "run-2", "keen-frothing-vole").score, first.score, "a removed drink frees its score");
});

test("a drink cannot be added without a run and handle to attribute it to", () => {
  const menu = seedMenu(catalog);
  assert.throws(() => addDrink(menu, { rawName: "Mona Mocha", rules, runId: "", handle: "h" }), { code: "invalid_run" });
  assert.throws(() => addDrink(menu, { rawName: "Mona Mocha", rules, runId: "r", handle: "" }), { code: "invalid_handle" });
  assert.throws(() => addDrink(null, { rawName: "Mona Mocha", rules, runId: "r", handle: "h" }), { code: "menu_invalid" });
  assert.equal(menu.length, 3, "no failed attempt leaves a partial entry");
});

// Attendees name the drink; whether it is served hot or cold is not part of
// the name, so the menu never tacks it on after one.
test("the booth menu shows a drink's name without its serving", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../.github/extensions/commit-and-sip/renderer/booth.js", import.meta.url), "utf8");
  const fill = source.slice(source.indexOf("function fillMenu"), source.indexOf("const board = $(\"leaderboard\")"));
  assert.ok(fill.includes("house example"), "found the menu renderer");
  assert.doesNotMatch(fill, /serving/, "the menu line carries no serving");
});
