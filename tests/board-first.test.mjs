// With an event leaderboard, a booth serves a drink only once the board has
// admitted it, and the board refuses a score another active drink holds. These
// cover the booth side of that contract against the real service, including
// the lost replies, retries, and races the attendee never sees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../leaderboard-service/app.mjs";
import { MemoryStore } from "../leaderboard-service/store.mjs";
import { BoothEngine } from "../.github/extensions/commit-and-sip/booth-engine.mjs";
import { loadCatalog } from "../.github/extensions/commit-and-sip/domain.mjs";
import { RunStore } from "../.github/extensions/commit-and-sip/store.mjs";
import { loadNameRules } from "../.github/extensions/commit-and-sip/services/coffee-name.mjs";
import { createLeaderboardClient } from "../.github/extensions/commit-and-sip/services/leaderboard-client.mjs";
import { validateBlocklist } from "../.github/extensions/commit-and-sip/services/moderation.mjs";
import { scoreCoffeeName } from "../.github/extensions/commit-and-sip/services/name-score.mjs";
import { WIPE_CONFIRMATION } from "../.github/extensions/commit-and-sip/services/event-archive.mjs";

const BOOTH_KEY = "b".repeat(24) + "-booth-key-for-tests";
const STAFF_KEY = "s".repeat(24) + "-staff-key-for-tests";
const reviewed = validateBlocklist({
  review: { placeholder: false, reviewedAt: "2026-01-01", reviewedBy: "test" },
  entries: [{ match: "substring", term: "zzqq" }],
});
const rules = { ...(await loadNameRules()), blocklist: reviewed };
const catalog = await loadCatalog();
const words = JSON.parse(await readFile(new URL("../booth/handle-words.json", import.meta.url), "utf8"));

// The same words in another order: different drinks, the same score.
const TIED = ["Mona Velvet Mocha", "Mona Mocha Velvet"];

async function service(t) {
  const store = new MemoryStore();
  const app = createApp({ boothKey: BOOTH_KEY, reservationKey: "r".repeat(40), rules, staffKey: STAFF_KEY, store, words });
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { store, url: `http://127.0.0.1:${server.address().port}` };
}

async function booth(t, leaderboardClient = null) {
  const directory = await mkdtemp(join(tmpdir(), "sip-first-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return new BoothEngine({ catalog, leaderboardClient, rules, store: new RunStore(directory) });
}

const clientFor = url => createLeaderboardClient({ boothKey: BOOTH_KEY, staffKey: STAFF_KEY, url });
const boardOf = async url => (await fetch(`${url}/api/board`)).json();

test("the tied names really tie, so these tests prove a refusal and not a typo", () => {
  const [a, b] = TIED.map(name => scoreCoffeeName(name, rules).score);
  assert.equal(a, b);
});

test("a score another booth's drink holds keeps this attendee naming, and a tweak lands", async t => {
  const { url } = await service(t);
  const boothA = await booth(t, clientFor(url));
  const boothB = await booth(t, clientFor(url));
  await boothA.open({ runId: "a-1" });
  const first = await boothA.dispatch("a-1", "submit_name", { name: TIED[0] });
  assert.equal(first.phase, "served");
  assert.equal(first.sync.state, "confirmed", "served only with the board's receipt");

  await boothB.open({ runId: "b-1" });
  await assert.rejects(boothB.dispatch("b-1", "submit_name", { name: TIED[1] }), error => {
    assert.equal(error.code, "score_taken");
    assert.equal(error.status, 409);
    assert.match(error.message, /Tweak your name/);
    return true;
  });
  const waiting = await boothB.get("b-1");
  assert.equal(waiting.phase, "naming", "the attendee is still on the naming screen");
  assert.match(waiting.statusMessage, /Tweak your name/);
  assert.equal(waiting.houseMenu.some(item => item.name === TIED[1]), false, "nothing was served");

  const tweaked = await boothB.dispatch("b-1", "submit_name", { name: `${TIED[1]}s` });
  assert.equal(tweaked.phase, "served");
  assert.deepEqual((await boardOf(url)).entries.map(row => row.name).sort(), [TIED[0], `${TIED[1]}s`].sort());
});

test("two booths racing for one score serve exactly one drink", async t => {
  const { url } = await service(t);
  const booths = await Promise.all([booth(t, clientFor(url)), booth(t, clientFor(url))]);
  await Promise.all(booths.map((engine, index) => engine.open({ runId: `race-${index}` })));
  const results = await Promise.allSettled(booths.map((engine, index) =>
    engine.dispatch(`race-${index}`, "submit_name", { name: TIED[index] })));
  assert.deepEqual(results.map(result => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "score_taken");
  const served = await Promise.all(booths.map((engine, index) => engine.get(`race-${index}`)));
  assert.deepEqual(served.map(view => view.phase).sort(), ["naming", "served"]);
  assert.equal((await boardOf(url)).total, 1);
});

test("a taken-down drink frees its score for the next attendee", async t => {
  const { url } = await service(t);
  const engine = await booth(t, clientFor(url));
  await engine.open({ runId: "r-1" });
  const first = await engine.dispatch("r-1", "submit_name", { name: TIED[0] });
  await engine.removeDrink({ id: first.submission.id, reason: "test", removedBy: "lead" });
  await engine.open({ runId: "r-2" });
  assert.equal((await engine.dispatch("r-2", "submit_name", { name: TIED[1] })).phase, "served");
});

test("an admission whose reply was lost is served once when the attendee tries again", async t => {
  const { url } = await service(t);
  const real = clientFor(url);
  let loseReply = true;
  const sent = [];
  const client = {
    ...real,
    async publish(submission) {
      sent.push(submission.token);
      const receipt = await real.publish(submission);          // the board admits it...
      if (loseReply) { loseReply = false; throw new Error("socket hang up"); }   // ...and the answer is lost
      return receipt;
    },
  };
  const engine = await booth(t, client);
  await engine.open({ runId: "r-1" });
  await assert.rejects(engine.dispatch("r-1", "submit_name", { name: "Mona Moonrise Mocha" }),
    { code: "leaderboard_unreachable", status: 503, message: /Try again in a moment/ });
  assert.equal((await engine.get("r-1")).phase, "naming", "not served on a guess");
  assert.equal((await boardOf(url)).total, 1, "though the board did take it");

  const served = await engine.dispatch("r-1", "submit_name", { name: "Mona Moonrise Mocha" });
  assert.equal(served.phase, "served");
  assert.equal(served.sync.state, "confirmed");
  assert.deepEqual(sent, [sent[0], sent[0]], "the retry resent the same publication");
  assert.equal((await boardOf(url)).total, 1, "and the board counted it once");
  assert.equal(served.houseMenu.filter(item => item.name === "Mona Moonrise Mocha").length, 1);
  await assert.rejects(engine.dispatch("r-1", "submit_name", { name: "Mona Moonrise Mocha" }), { code: "already_served" });
});

test("an earlier name the board took is the attendee's drink, even if they typed a new one", async t => {
  const { url } = await service(t);
  const real = clientFor(url);
  let loseReply = true;
  const client = { ...real, async publish(submission) {
    const receipt = await real.publish(submission);
    if (loseReply) { loseReply = false; throw new Error("timeout"); }
    return receipt;
  } };
  const engine = await booth(t, client);
  await engine.open({ runId: "r-1" });
  await assert.rejects(engine.dispatch("r-1", "submit_name", { name: "Mona Moonrise Mocha" }), { code: "leaderboard_unreachable" });
  const served = await engine.dispatch("r-1", "submit_name", { name: "Ducky Dawn Drizzle" });
  assert.equal(served.submission.name, "Mona Moonrise Mocha", "the board holds the earlier name, so that is what is served");
  assert.match(served.statusMessage, /Your earlier name, Mona Moonrise Mocha, reached the event leaderboard/);
  assert.deepEqual((await boardOf(url)).entries.map(row => row.name), ["Mona Moonrise Mocha"]);
});

test("a proxy's 4xx to a resend keeps the admission in doubt, so the attendee never gets two drinks", async t => {
  const { url } = await service(t);
  const real = clientFor(url);
  const sent = [];
  const client = { ...real, async publish(submission) {
    sent.push(submission.name);
    if (sent.length === 1) { await real.publish(submission); throw new Error("timeout"); }   // landed, answer lost
    if (sent.length === 2) throw Object.assign(new Error("Too many requests"), { status: 429 });
    return real.publish(submission);
  } };
  const engine = await booth(t, client);
  await engine.open({ runId: "r-1" });
  await assert.rejects(engine.dispatch("r-1", "submit_name", { name: TIED[0] }), { code: "leaderboard_unreachable" });
  await assert.rejects(engine.dispatch("r-1", "submit_name", { name: "Mona Latte Lagoon" }),
    { code: "leaderboard_unreachable", status: 503 }, "a 429 on a resend proves nothing about the first send");
  assert.equal((await engine.get("r-1")).phase, "naming");
  assert.equal((await engine.store.read()).runs["r-1"].admission.entry.name, TIED[0], "the admission is still in the ledger");

  const served = await engine.dispatch("r-1", "submit_name", { name: "Mona Latte Lagoon" });
  assert.equal(served.submission.name, TIED[0], "the drink the board already holds is the attendee's drink");
  assert.deepEqual(sent, [TIED[0], TIED[0], TIED[0]]);
  assert.deepEqual((await boardOf(url)).entries.map(row => row.name), [TIED[0]], "one drink on the board, not two");
});

test("a 4xx to the first send of a new admission is a refusal, not a doubt", async t => {
  const client = { async publish() { throw Object.assign(new Error("Too many requests"), { status: 429 }); } };
  const engine = await booth(t, client);
  await engine.open({ runId: "r-1" });
  await assert.rejects(engine.dispatch("r-1", "submit_name", { name: "Mona Moonrise Mocha" }),
    { code: "leaderboard_refused", status: 502 });
  assert.equal((await engine.get("r-1")).phase, "naming");
  assert.equal((await engine.store.read()).runs["r-1"].admission, undefined, "nothing can be on the board, so nothing is kept");
});

test("an earlier name the board refuses frees the attendee's new name", async t => {
  const sent = [];
  const client = { async publish(submission) {
    sent.push(submission.name);
    if (sent.length === 1) throw new Error("timeout");
    if (sent.length === 2) throw Object.assign(new Error("taken"), { code: "score_taken", status: 409 });
    return { ...submission, entries: 1, rank: 1 };
  } };
  const engine = await booth(t, client);
  await engine.open({ runId: "r-1" });
  await assert.rejects(engine.dispatch("r-1", "submit_name", { name: "Mona Moonrise Mocha" }), { code: "leaderboard_unreachable" });
  const served = await engine.dispatch("r-1", "submit_name", { name: "Ducky Dawn Drizzle" });
  assert.deepEqual(sent, ["Mona Moonrise Mocha", "Mona Moonrise Mocha", "Ducky Dawn Drizzle"]);
  assert.equal(served.submission.name, "Ducky Dawn Drizzle");
});

test("a rebuilding board is not a refusal: nothing is served and the attempt is kept", async t => {
  const client = { async publish() { throw Object.assign(new Error("rebuilding"), { code: "board_rebuilding", status: 503 }); } };
  const engine = await booth(t, client);
  await engine.open({ runId: "r-1" });
  await assert.rejects(engine.dispatch("r-1", "submit_name", { name: "Mona Moonrise Mocha" }), { code: "leaderboard_unreachable" });
  const run = (await engine.store.read()).runs["r-1"];
  assert.equal(run.phase, "naming");
  assert.ok(run.admission, "resent, never forgotten, until the board answers");
});

test("the event cannot be wiped while an admission is still in doubt", async t => {
  let online = false;
  const client = { async publish(submission) {
    if (!online) throw new Error("offline");
    return { ...submission, entries: 1, rank: 1 };
  } };
  const engine = await booth(t, client);
  await engine.open({ runId: "r-1" });
  await assert.rejects(engine.dispatch("r-1", "submit_name", { name: "Mona Moonrise Mocha" }), { code: "leaderboard_unreachable" });
  await engine.closeStation({ runId: "r-1", closedBy: "lead" });
  await assert.rejects(engine.archiveAndWipe({ archivedBy: "lead", confirm: WIPE_CONFIRMATION }), { code: "admissions_unsettled" });
  assert.ok((await engine.store.read()).runs["r-1"].admission, "nothing was changed");
  online = true;
  assert.ok((await engine.archiveAndWipe({ archivedBy: "lead", confirm: WIPE_CONFIRMATION })).archive,
    "the wipe settles the admission first, then proceeds");
});

test("a standalone booth refuses a score its own menu already holds", async t => {
  const engine = await booth(t);
  await engine.open({ runId: "r-1" });
  const first = await engine.dispatch("r-1", "submit_name", { name: TIED[0] });
  assert.equal(first.sync.state, "disabled");
  await engine.open({ runId: "r-2" });
  await assert.rejects(engine.dispatch("r-2", "submit_name", { name: TIED[1] }),
    { code: "score_taken", message: /Tweak your name/ });
  assert.equal((await engine.get("r-2")).phase, "naming");
  await engine.removeDrink({ id: first.submission.id, reason: "test", removedBy: "lead" });
  assert.equal((await engine.dispatch("r-2", "submit_name", { name: TIED[1] })).phase, "served",
    "a takedown frees the score");
});
