import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../.github/extensions/commit-and-sip/store.mjs";
import { RunEngine } from "../.github/extensions/commit-and-sip/engine.mjs";
import { loadCatalog } from "../.github/extensions/commit-and-sip/domain.mjs";

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "sip-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RunStore(directory);
  const engine = new RunEngine({ store, catalog: await loadCatalog(), ...options });
  return { engine, store };
}

async function review(engine, runId = "test-run", orderId) {
  const run = await engine.open({ runId, mode: "rehearsal", ...(orderId ? { orderId } : {}) });
  await engine.dispatch(runId, "start");
  for (const surface of ["summary", "changes", "checks"]) await engine.dispatch(runId, "view", { surface });
  await engine.dispatch(runId, "check_order", { price: run.order.price, serving: run.order.serving, scope: "one-drink" });
}

test("five-minute rehearsal separates review, approval and application; retries preserve one result", async t => {
  const { engine, store } = await fixture(t);
  const start = await engine.open({ runId: "test-run", mode: "rehearsal" });
  assert.equal(start.result, null);
  assert.equal("handle" in start, false);
  await assert.rejects(engine.dispatch("test-run", "approve"), { code: "assessment_required" });
  await assert.rejects(engine.dispatch("test-run", "complete"), { code: "menu_required" });
  await review(engine);
  const approved = await engine.dispatch("test-run", "approve");
  assert.equal(approved.phase, "approved");
  assert.deepEqual(approved.menu, []);
  assert.equal((await store.read()).runs["test-run"].handle, null);
  const complete = await engine.dispatch("test-run", "serve");
  assert.equal(complete.phase, "completed");
  assert.equal(complete.menu[0].id, "mona-latte");
  assert.match(complete.result.handle, /^[a-z]+-[a-z]+-[a-z]+/);
  assert.equal(complete.result.score, 1000);
  assert.equal(complete.result.rankAtCompletion, 1);
  assert.equal(complete.result.leaderboardUrl, null);
  const retry = await engine.dispatch("test-run", "complete");
  assert.deepEqual(retry.result, complete.result);
  assert.equal((await store.read()).results.length, 1);
});

test("all three catalog drinks complete using their own price and serving criteria", async t => {
  const { engine } = await fixture(t);
  const { orders } = await loadCatalog();
  for (const order of orders) {
    const runId = `catalog-${order.id}`;
    await review(engine, runId, order.id);
    await engine.dispatch(runId, "approve");
    const completed = await engine.dispatch(runId, "serve");
    assert.deepEqual(completed.menu, [order]);
    assert.equal(completed.result.score, 1000);
  }
});

test("factual checkpoint, sequence, hints and invalid input", async t => {
  const { engine } = await fixture(t);
  await engine.open({ runId: "test-run", mode: "rehearsal" });
  await engine.dispatch("test-run", "start");
  await assert.rejects(engine.dispatch("test-run", "view", { surface: "checks" }), { code: "view_sequence" });
  await review(engine);
  const wrong = await engine.dispatch("test-run", "check_order", { price: 5, serving: "hot", scope: "one-drink" });
  assert.equal(wrong.assessmentPassed, false);
  assert.match(wrong.statusMessage, /Needs attention/);
  await assert.rejects(engine.dispatch("test-run", "approve"), { code: "assessment_required" });
  await assert.rejects(engine.dispatch("test-run", "complete", { score: 99999 }), { code: "invalid_input" });
  await assert.rejects(engine.open({ runId: "../../escape", mode: "rehearsal" }), { code: "invalid_run" });
  assert.equal((await engine.dispatch("test-run", "hint")).hintCount, 1);
});

test("fresh engine and distinct panels rehydrate by domain run, not panel ID", async t => {
  const { engine, store } = await fixture(t);
  await review(engine);
  const reloaded = new RunEngine({ store: new RunStore(store.directory), catalog: await loadCatalog() });
  const restored = await reloaded.open({ runId: "test-run", mode: "rehearsal" });
  assert.equal(restored.assessmentPassed, true);
  assert.equal(restored.views.length, 3);
  await assert.rejects(reloaded.open({ runId: "test-run", mode: "live" }), { code: "run_conflict" });
});

test("concurrent completion reserves one durable result and unique handles", async t => {
  const { engine, store } = await fixture(t);
  await review(engine);
  await engine.dispatch("test-run", "approve");
  const results = await Promise.all([engine.dispatch("test-run", "serve"), engine.dispatch("test-run", "serve")]);
  assert.equal(results[0].result.handle, results[1].result.handle);
  assert.equal((await store.read()).results.length, 1);
  await review(engine, "test-two");
  await engine.dispatch("test-two", "approve");
  const other = await engine.dispatch("test-two", "serve");
  assert.notEqual(other.result.handle, results[0].result.handle);
  assert.equal(other.result.rankAtCompletion, 1);
});

test("live is fail-closed without configuration or native evidence", async t => {
  const basic = await fixture(t);
  await assert.rejects(basic.engine.open({ runId: "live-run", mode: "live" }), { code: "live_unconfigured" });
  const config = {
    mode: "live", repo: "ghlearn/commit-and-sip",
    runs: { "live-run": { issueNumber: 1, prNumber: 2, reviewer: "booth", headSha: "a".repeat(40), orderId: "mona-latte" } }
  };
  const live = await fixture(t, { config, github: {} });
  await live.engine.open({ runId: "live-run", mode: "live" });
  await assert.rejects(live.engine.dispatch("live-run", "view", { surface: "summary" }), { code: "native_views_unavailable" });
  assert.equal((await live.store.read()).results.length, 0);
});

test("prototype property names are ordinary isolated run IDs, not inherited records", async t => {
  const { engine } = await fixture(t);
  await assert.rejects(engine.get("constructor"), { code: "run_missing" });
  assert.equal((await engine.open({ runId: "constructor", mode: "rehearsal" })).phase, "order");
});

test("live integration requires distinct verified approval and merged menu; pending results preserve handle", async t => {
  const headSha = "a".repeat(40);
  const identity = { runId: "live-001", repo: "ghlearn/commit-and-sip", prNumber: 2, headSha };
  let approved = false;
  let merged = false;
  let unavailable = true;
  let submissions = 0;
  const catalog = await loadCatalog();
  const config = {
    mode: "live", repo: identity.repo,
    runs: { "live-001": { issueNumber: 1, prNumber: 2, reviewer: "reviewer", headSha, orderId: "mona-latte" } }
  };
  const { engine, store } = await fixture(t, {
    config,
    viewEvidence: { read: async () => ({ ...identity, surfaces: ["summary", "changes", "checks"] }) },
    github: {
      readIssue: async () => ({ number: 1, title: "Order Up", body: "Order instructions" }),
      inspectPullRequest: async () => ({
        headSha, checksPassed: true, approved, approvedForAttempt: approved, merged,
        mergeCommitSha: merged ? "b".repeat(40) : null,
        menu: [catalog.orders[0]], files: [], checks: [], summary: "Actual PR"
      }),
      approve: async () => { approved = true; }
    },
    completion: { finish: async run => {
      submissions++;
      if (unavailable) throw new Error("Completion endpoint unavailable");
      return { runId: run.runId, handle: run.handle, score: 1000, rankAtCompletion: 1 };
    } }
  });
  await engine.open({ runId: identity.runId, mode: "live" });
  await engine.dispatch(identity.runId, "start");
  await engine.dispatch(identity.runId, "check_order", { price: 5.5, serving: "hot", scope: "one-drink" });
  const approval = await engine.dispatch(identity.runId, "approve");
  assert.equal(approval.phase, "approved");
  assert.deepEqual(approval.menu, []);
  await assert.rejects(engine.dispatch(identity.runId, "serve"), { code: "merge_pending" });
  assert.equal((await store.read()).runs[identity.runId].handle, null);
  merged = true;
  await assert.rejects(engine.dispatch(identity.runId, "serve"), /endpoint unavailable/);
  const pending = (await store.read()).runs[identity.runId];
  assert.equal(pending.phase, "served");
  assert.equal(pending.menu[0].id, "mona-latte");
  assert.ok(pending.handle);
  unavailable = false;
  const complete = await engine.dispatch(identity.runId, "complete");
  assert.equal(complete.result.handle, pending.handle);
  assert.equal(complete.phase, "completed");
  assert.equal(submissions, 2);
  assert.equal((await store.read()).results.length, 0, "live result never enters local rehearsal rankings");
});


test("hints are limited to pre-serving phases through the engine, including SDK callers", async t => {
  const { engine, store } = await fixture(t);
  await engine.open({ runId: "hint-run", mode: "rehearsal" });
  for (const mode of ["rehearsal", "live"]) {
    for (const phase of ["order", "reviewing", "approved", "served", "completed"]) {
      await store.transaction(data => {
        Object.assign(data.runs["hint-run"], { mode, phase, hintCount: 2,
          statusMessage: "Saved phase status", menu: phase === "served" || phase === "completed" ? [engine.catalog.orders[0]] : [],
          result: phase === "completed" ? { handle: "brisk-brews-coffee", score: 1000 } : null });
      });
      const before = await store.read();
      if (["served", "completed"].includes(phase)) {
        await assert.rejects(engine.dispatch("hint-run", "hint"), { code: "wrong_phase" });
        assert.deepEqual(await store.read(), before, `${mode} ${phase} must not mutate saved state`);
        const restarted = new RunEngine({ store: new RunStore(store.directory), catalog: engine.catalog });
        assert.equal((await restarted.dispatch("hint-run", "refresh")).statusMessage, "Saved phase status");
      } else {
        const state = await engine.dispatch("hint-run", "hint");
        assert.equal(state.hintCount, 3);
        assert.match(state.statusMessage, /Hints never reduce your score/);
      }
    }
  }
});
