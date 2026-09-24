import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../.github/extensions/commit-and-sip/store.mjs";
import { BoothEngine } from "../.github/extensions/commit-and-sip/booth-engine.mjs";
import { AdminPanel } from "../.github/extensions/commit-and-sip/admin-panel.mjs";
import { loadCatalog } from "../.github/extensions/commit-and-sip/domain.mjs";
import { loadNameRules } from "../.github/extensions/commit-and-sip/services/coffee-name.mjs";
import {
  archiveMatches, artifactName, emptyLedger, eventSummary, exportPayload,
} from "../.github/extensions/commit-and-sip/services/event-archive.mjs";

const catalog = await loadCatalog();
const rules = await loadNameRules();

async function booth(t) {
  const directory = await mkdtemp(join(tmpdir(), "sip-admin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RunStore(directory);
  return { directory, engine: new BoothEngine({ store, catalog, rules }), store };
}

// One finished attendee is the smallest event that is worth archiving.
async function attendee(engine, runId, name) {
  await engine.open({ runId });
  const served = await engine.dispatch(runId, "submit_name", { name });
  await engine.dispatch(runId, "complete", {});
  return served;
}

test("an event summary counts what a wipe would destroy", async t => {
  const { engine, store } = await booth(t);
  await attendee(engine, "booth-1", "Mona Moonlight");
  await engine.open({ runId: "booth-2" });
  const summary = eventSummary(await store.read());
  assert.equal(summary.invented, 1);
  assert.equal(summary.attendees, 2);
  assert.equal(summary.completed, 1);
  assert.equal(summary.active.length, 1, "the unfinished run is still the station's business");
  assert.equal(summary.examples, 3, "house examples are counted apart from invented drinks");
});

test("exporting results changes nothing and keeps the removal trail", async t => {
  const { engine, store } = await booth(t);
  const served = await attendee(engine, "booth-1", "Ducky Dawn");
  await attendee(engine, "booth-2", "Copilot Comet");
  await engine.removeDrink({ id: served.submission.id, reason: "offensive in another language", removedBy: "Sam" });

  const before = await store.read();
  const { path } = await engine.exportResults({ exportedBy: "Sam" });
  assert.deepEqual(await store.read(), before, "an export is read-only");

  const written = JSON.parse(await readFile(path, "utf8"));
  assert.equal(written.exportedBy, "Sam");
  assert.deepEqual(written.drinks.map(drink => drink.name), ["Copilot Comet"]);
  assert.equal(written.removals.length, 1, "a removed drink is still recorded, because the wipe would erase it");
  assert.equal(written.removals[0].reason, "offensive in another language");
  assert.ok(written.drinks.every(drink => drink.handle), "results are attributable to a barista");
});

test("an export refuses to overwrite an earlier file", async t => {
  const { engine, store } = await booth(t);
  await attendee(engine, "booth-1", "Mona Moonlight");
  const now = "2026-02-01T10:00:00.000Z";
  await engine.exportResults({ exportedBy: "Sam", now });
  await assert.rejects(() => engine.exportResults({ exportedBy: "Alex", now }),
    error => error.code === "artifact_exists");
  assert.deepEqual(await store.listArtifacts(), [artifactName("results", now)],
    "the first file survives rather than being silently replaced");
});

test("archive and wipe records the event, then resets the booth", async t => {
  const { engine, store } = await booth(t);
  const served = await attendee(engine, "booth-1", "Mona Moonlight");
  await attendee(engine, "booth-2", "Ducky Dawn");
  await engine.removeDrink({ id: served.submission.id, reason: "duplicate of a 2024 name", removedBy: "Sam" });

  const result = await engine.archiveAndWipe({ archivedBy: "Sam", confirm: "wipe" });
  assert.equal(result.summary.attendees, 2);

  const archive = JSON.parse(await readFile(result.archive, "utf8"));
  assert.equal(archive.kind, "commit-and-sip-archive");
  assert.equal(archive.archivedBy, "Sam");
  assert.equal(Object.keys(archive.ledger.runs).length, 2, "the archive holds the whole ledger, not a projection");
  assert.equal(archive.summary.removals, 1);

  const after = await store.read();
  assert.deepEqual(after.runs, {}, "the next event does not inherit attendees");
  const overview = await engine.adminOverview();
  assert.deepEqual(overview.houseMenu.filter(entry => !entry.example), [],
    "event two opens with an empty menu");
  assert.deepEqual(overview.removals, [], "and with no earlier removals on it");
});

test("a wiped booth can serve the same name again", async t => {
  const { engine } = await booth(t);
  await attendee(engine, "booth-1", "Mona Moonlight");
  await engine.archiveAndWipe({ archivedBy: "Sam", confirm: "wipe" });
  const next = await attendee(engine, "booth-9", "Mona Moonlight");
  assert.equal(next.submission.name, "Mona Moonlight",
    "name reservations belong to the event that was archived, not to the machine");
});

test("nothing is wiped without the typed confirmation", async t => {
  const { engine, store } = await booth(t);
  await attendee(engine, "booth-1", "Mona Moonlight");
  const before = await store.read();
  await assert.rejects(() => engine.archiveAndWipe({ archivedBy: "Sam", confirm: "WIPE" }),
    error => error.code === "confirmation_required");
  await assert.rejects(() => engine.archiveAndWipe({ archivedBy: "Sam" }),
    error => error.code === "confirmation_required");
  assert.deepEqual(await store.read(), before);
  assert.deepEqual(await store.listArtifacts(), [], "a refused wipe writes no archive either");
});

test("an attendee still at the counter blocks the wipe", async t => {
  const { engine, store } = await booth(t);
  await attendee(engine, "booth-1", "Mona Moonlight");
  await engine.open({ runId: "booth-2" });
  await assert.rejects(() => engine.archiveAndWipe({ archivedBy: "Sam", confirm: "wipe" }),
    error => error.code === "station_active");
  assert.equal(Object.keys((await store.read()).runs).length, 2, "nothing was changed");

  await engine.closeStation({ runId: "booth-2", closedBy: "Sam" });
  const result = await engine.archiveAndWipe({ archivedBy: "Sam", confirm: "wipe" });
  assert.ok(result.archive, "once the station is closed the reset goes ahead");
});

test("an attendee who walks away mid-order can still be cleared", async t => {
  const { engine, store } = await booth(t);
  await engine.open({ runId: "booth-1" });
  // Hand-over needs a served drink, so without this the station could never be
  // closed and the event could never be archived.
  await assert.rejects(() => engine.dispatch("booth-1", "complete", {}),
    error => error.code === "not_served");
  const closed = await engine.closeStation({ runId: "booth-1", closedBy: "Sam" });
  assert.equal(closed.served, false);
  assert.equal(eventSummary(await store.read()).active.length, 0);
});

test("closing a station is not a takedown", async t => {
  const { engine, store } = await booth(t);
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonlight" });
  const closed = await engine.closeStation({ runId: "booth-1", closedBy: "Sam" });
  assert.equal(closed.served, true);
  const data = await store.read();
  assert.ok(data.menu.some(entry => entry.id === served.submission.id),
    "the drink they already served stays on the house menu");
  assert.deepEqual(data.removals ?? [], [], "and it is not recorded as removed");
  assert.equal(data.runs["booth-1"].closedBy, "Sam", "who closed it is recorded");
});

test("closing a station names whoever did it and refuses the impossible", async t => {
  const { engine } = await booth(t);
  await attendee(engine, "booth-1", "Mona Moonlight");
  await assert.rejects(() => engine.closeStation({ runId: "booth-1", closedBy: "Sam" }),
    error => error.code === "already_complete");
  await engine.open({ runId: "booth-2" });
  await assert.rejects(() => engine.closeStation({ runId: "booth-2", closedBy: " " }),
    error => error.code === "invalid_close");
  await assert.rejects(() => engine.closeStation({ runId: "nope", closedBy: "Sam" }),
    error => error.code === "run_missing");
});

test("an empty booth is not archived", async t => {
  const { engine, store } = await booth(t);
  await assert.rejects(() => engine.archiveAndWipe({ archivedBy: "Sam", confirm: "wipe" }),
    error => error.code === "nothing_to_archive");
  assert.deepEqual(await store.listArtifacts(), []);
});

test("an archive that does not read back leaves the ledger alone", async t => {
  const { engine, store } = await booth(t);
  await attendee(engine, "booth-1", "Mona Moonlight");
  const before = await store.read();
  // Storage that accepts a write and returns something else is exactly the
  // failure the read-back exists to catch.
  store.readArtifact = async () => ({ kind: "commit-and-sip-archive", ledger: emptyLedger() });
  await assert.rejects(() => engine.archiveAndWipe({ archivedBy: "Sam", confirm: "wipe" }),
    error => error.code === "archive_unverified");
  assert.deepEqual(await store.read(), before, "the event survives a bad archive");
});

test("the comparison rejects an archive that lost records", async t => {
  const { engine, store } = await booth(t);
  await attendee(engine, "booth-1", "Mona Moonlight");
  const data = await store.read();
  assert.equal(archiveMatches({ kind: "commit-and-sip-archive", ledger: data }, data), true);
  assert.equal(archiveMatches({ kind: "commit-and-sip-archive", ledger: emptyLedger() }, data), false);
  assert.equal(archiveMatches({ kind: "commit-and-sip-results", ledger: data }, data), false);
  assert.equal(archiveMatches(null, data), false);
});

test("staff operations name whoever ran them", async t => {
  const { engine } = await booth(t);
  await attendee(engine, "booth-1", "Mona Moonlight");
  await assert.rejects(() => engine.exportResults({ exportedBy: "   " }),
    error => error.code === "invalid_export");
  await assert.rejects(() => engine.archiveAndWipe({ archivedBy: "", confirm: "wipe" }),
    error => error.code === "invalid_archive");
});

test("the overview carries the moderation warning staff would otherwise miss", async t => {
  const { engine } = await booth(t);
  const overview = await engine.adminOverview();
  assert.equal(typeof overview.blocklist.ready, "boolean");
  assert.ok(overview.dataDirectory, "staff are told where the data actually lives");
  assert.deepEqual(overview.archives, []);
});

test("the staff panel refuses an action the attendee panel owns, and the reverse", async t => {
  const { engine } = await booth(t);
  const panel = new AdminPanel(engine);
  await assert.rejects(() => panel.dispatch("submit_name", { name: "Mona Moonlight" }),
    error => error.code === "unknown_action");
  // The whole reason the dashboard is a second canvas: the attendee screen must
  // not be able to reach a destructive operation under any action name.
  await engine.open({ runId: "booth-1" });
  await assert.rejects(() => engine.dispatch("booth-1", "archive_and_wipe", { archivedBy: "Sam", confirm: "wipe" }),
    error => error.code === "unknown_action");
  await assert.rejects(() => engine.dispatch("booth-1", "export_results", { exportedBy: "Sam" }),
    error => error.code === "unknown_action");
  await assert.rejects(() => engine.dispatch("booth-1", "remove_drink", { id: "x", reason: "y", removedBy: "Sam" }),
    error => error.code === "unknown_action");
  await assert.rejects(() => engine.dispatch("booth-1", "close_station", { runId: "booth-1", closedBy: "Sam" }),
    error => error.code === "unknown_action");
});

test("a second archive cannot start while the first is running", async t => {
  const { engine } = await booth(t);
  await attendee(engine, "booth-1", "Mona Moonlight");
  const panel = new AdminPanel(engine);
  const input = { archivedBy: "Sam", confirm: "wipe" };
  const [first, second] = await Promise.allSettled([
    panel.dispatch("archive_and_wipe", input),
    panel.dispatch("archive_and_wipe", input),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.equal(second.reason.code, "admin_busy");
});

test("the panel reports what a wipe took with it", async t => {
  const { engine } = await booth(t);
  await attendee(engine, "booth-1", "Mona Moonlight");
  const panel = new AdminPanel(engine);
  const state = await panel.dispatch("archive_and_wipe", { archivedBy: "Sam", confirm: "wipe" });
  assert.equal(state.notice.kind, "wiped");
  assert.equal(state.notice.was.invented, 1, "staff are told what is now only in that file");
  assert.ok(state.notice.archive.endsWith(".json"));
  assert.equal(state.summary.invented, 0, "and shown the booth is already reset");
});

test("an export payload insists on a name even with an empty ledger", () => {
  assert.throws(() => exportPayload(emptyLedger(), {}), error => error.code === "invalid_export");
  const payload = exportPayload(emptyLedger(), { exportedBy: "Sam" });
  assert.deepEqual(payload.drinks, []);
  assert.equal(payload.summary.invented, 0);
});

test("artifact names are safe on every filesystem staff might use", () => {
  const name = artifactName("event", "2026-02-01T10:00:00.000Z");
  assert.equal(name, "event-2026-02-01T10-00-00-000Z.json");
  assert.ok(!name.includes(":"), "colons are not valid in filenames everywhere");
});
