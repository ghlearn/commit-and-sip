import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../.github/extensions/commit-and-sip/store.mjs";
import { BoothEngine } from "../.github/extensions/commit-and-sip/booth-engine.mjs";
import { loadCatalog } from "../.github/extensions/commit-and-sip/domain.mjs";
import { loadNameRules } from "../.github/extensions/commit-and-sip/services/coffee-name.mjs";
import {
  submissionFor, syncView, validateLeaderboardClient, validateReceipt
} from "../.github/extensions/commit-and-sip/services/leaderboard.mjs";

const catalog = await loadCatalog();
const rules = await loadNameRules();

async function booth(leaderboardClient = null) {
  const directory = await mkdtemp(join(tmpdir(), "sip-board-"));
  const engine = new BoothEngine({ store: new RunStore(directory), catalog, rules, leaderboardClient });
  return { directory, engine };
}

async function serve(engine, runId = "board-run") {
  await engine.open({ runId });
  return engine.dispatch(runId, "submit_name", { name: "Mona Moonrise" });
}

test("a receipt is rejected unless it is about the entry that was sent", () => {
  const submission = { handle: "cheerful-cup", id: "mona-moonrise", name: "Mona Moonrise", score: 2050 };
  assert.deepEqual(validateReceipt({ ...submission, rank: 3, entries: 9 }, submission),
    { entries: 9, handle: "cheerful-cup", rank: 3, score: 2050 });
  const rejects = (receipt, code) => assert.throws(() => validateReceipt(receipt, submission), { code });
  // A service answering about someone else must never rank this attendee.
  rejects({ ...submission, handle: "other-handle", rank: 1 }, "receipt_mismatch");
  rejects({ ...submission, name: "Ducky Dawn", rank: 1 }, "receipt_mismatch");
  rejects({ ...submission, score: 4999, rank: 1 }, "receipt_mismatch");
  rejects({ ...submission, rank: 0 }, "invalid_receipt");
  rejects({ ...submission, rank: 1.5 }, "invalid_receipt");
  rejects({ ...submission, rank: 5, entries: 2 }, "invalid_receipt");
  rejects(null, "invalid_receipt");
});

test("a submission carries the anonymous handle and nothing identifying", () => {
  const entry = { handle: "cheerful-cup", id: "mona-moonrise", name: "Mona Moonrise", score: 2050, runId: "secret-run", breakdown: {} };
  assert.deepEqual(submissionFor(entry), { handle: "cheerful-cup", id: "mona-moonrise", name: "Mona Moonrise", score: 2050 });
  assert.throws(() => submissionFor({ ...entry, score: 0 }), { code: "invalid_submission" });
  assert.throws(() => submissionFor({ ...entry, handle: "" }), { code: "invalid_submission" });
});

test("the view never implies an event rank the service has not confirmed", () => {
  assert.equal(syncView(null).state, "disabled");
  assert.equal(syncView({ state: "disabled" }).eventRank, null);
  for (const state of ["pending", "failed"]) {
    const view = syncView({ state, attempts: 1 });
    assert.equal(view.eventRank, null, `${state} must not claim a rank`);
    assert.match(view.message, /still being confirmed/);
  }
  const confirmed = syncView({ state: "confirmed", receipt: { rank: 2, entries: 8 } });
  assert.equal(confirmed.eventRank, 2);
});

test("a client must expose publish", () => {
  assert.equal(validateLeaderboardClient(null), null);
  assert.throws(() => validateLeaderboardClient({}), { code: "invalid_leaderboard_client" });
  assert.throws(() => new BoothEngine({ store: {}, catalog, rules, leaderboardClient: { publish: 1 } }),
    { code: "invalid_leaderboard_client" });
});

test("with no client configured the booth reports no event standing at all", async () => {
  const { directory, engine } = await booth();
  try {
    const served = await serve(engine);
    assert.equal(served.sync.state, "disabled");
    assert.equal(served.sync.eventRank, null);
    assert.equal(served.sync.message, null);
    // The local standing is still a fact the booth owns.
    assert.equal(served.standing.rank, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a confirmed receipt is recorded and shown as the event rank", async () => {
  const sent = [];
  const { directory, engine } = await booth({
    publish: async submission => { sent.push(submission); return { ...submission, rank: 4, entries: 12 }; }
  });
  try {
    await serve(engine);
    await engine.publish("board-run");
    const state = await engine.get("board-run");
    assert.equal(state.sync.state, "confirmed");
    assert.equal(state.sync.eventRank, 4);
    assert.equal(state.sync.entries, 12);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].name, "Mona Moonrise");
    // A confirmed entry is not resubmitted.
    await engine.publish("board-run");
    assert.equal(sent.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failing service never costs the attendee their drink or score", async () => {
  const { directory, engine } = await booth({
    publish: async () => { throw new Error("leaderboard unreachable"); }
  });
  try {
    const served = await serve(engine);
    // Serving itself must succeed: the entry is durable before any network call.
    assert.equal(served.phase, "served");
    assert.equal(served.submission.score > 0, true);
    await engine.publish("board-run");
    const state = await engine.get("board-run");
    assert.equal(state.sync.state, "failed");
    assert.equal(state.sync.eventRank, null);
    assert.equal(state.houseMenu.some(item => item.name === "Mona Moonrise"), true);
    assert.equal(state.leaderboard[0].name, "Mona Moonrise");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a mismatched receipt is treated as a failure, not as a rank", async () => {
  const { directory, engine } = await booth({
    publish: async submission => ({ ...submission, handle: "someone-else", rank: 1 })
  });
  try {
    await serve(engine);
    await engine.publish("board-run");
    const state = await engine.get("board-run");
    assert.equal(state.sync.state, "failed");
    assert.equal(state.sync.eventRank, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a refresh retries a failed submission and can still confirm it", async () => {
  let fail = true;
  const { directory, engine } = await booth({
    publish: async submission => {
      if (fail) { fail = false; throw new Error("temporary outage"); }
      return { ...submission, rank: 1, entries: 1 };
    }
  });
  try {
    await serve(engine);
    await engine.publish("board-run");
    assert.equal((await engine.get("board-run")).sync.state, "failed");
    const refreshed = await engine.dispatch("board-run", "refresh", {});
    assert.equal(refreshed.sync.state, "confirmed");
    assert.equal(refreshed.sync.eventRank, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publishing is skipped for a run that has not served", async () => {
  let called = 0;
  const { directory, engine } = await booth({ publish: async () => { called += 1; return {}; } });
  try {
    await engine.open({ runId: "board-run" });
    await engine.publish("board-run");
    await engine.publish("no-such-run");
    assert.equal(called, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
