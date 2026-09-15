import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../.github/extensions/commit-and-sip/store.mjs";
import { RunEngine } from "../.github/extensions/commit-and-sip/engine.mjs";
import { loadCatalog } from "../.github/extensions/commit-and-sip/domain.mjs";
import { startServer } from "../.github/extensions/commit-and-sip/server.mjs";

const catalog = await loadCatalog();

for (const order of catalog.orders) {
  test(`single-step ${order.id} rehearsal recovers and completes through the canvas transport without remote calls`, async t => {
    const directory = await mkdtemp(join(tmpdir(), "sip-exercise-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let remoteCalls = 0;
    const forbidden = new Proxy({}, { get() { remoteCalls++; throw new Error("Rehearsal called a remote adapter"); } });
    const engineFor = () => new RunEngine({
      store: new RunStore(directory), catalog, github: forbidden, completion: forbidden, viewEvidence: forbidden
    });
    let engine = engineFor();
    const runId = `flow-${order.id}`;
    await engine.open({ runId, mode: "rehearsal", orderId: order.id }, { requireNew: true });
    const connect = async () => {
      const panel = await startServer({ engine, runId });
      t.after(() => panel.close());
      const url = new URL(panel.url);
      const headers = { authorization: `Bearer ${url.searchParams.get("ticket")}`, origin: url.origin, "content-type": "application/json" };
      return {
        state: async () => (await fetch(`${url.origin}/api/state`, { headers })).json(),
        action: async (action, input = {}, status = 200) => {
          const response = await fetch(`${url.origin}/api/action`, { method: "POST", headers, body: JSON.stringify({ action, input }) });
          assert.equal(response.status, status);
          return response.json();
        },
        html: await (await fetch(panel.url)).text()
      };
    };
    let client = await connect();
    assert.match(client.html, /id="exercise-guide"/);
    assert.match(client.html, /href="#changes-heading"/);
    assert.match(client.html, /id="learning-summary"/);
    assert.match(client.html, /aria-label="Activities within Step 1"/);
    assert.doesNotMatch(client.html, /src="https?:/);
    const initial = await client.state();
    assert.equal(initial.phase, "order");
    assert.equal(initial.exercise.completion, null);
    assert.deepEqual(initial.views, []);
    await client.action("approve", {}, 409);
    await client.action("serve", {}, 409);
    await client.action("complete", {}, 409);
    const started = await client.action("start");
    assert.ok(started.issue.body.includes(order.name));
    await client.action("view", { surface: "checks" }, 409);
    await client.action("check_order", { price: order.price, serving: order.serving, scope: "one-drink" }, 409);
    for (const surface of ["summary", "changes", "checks"]) await client.action("view", { surface });
    const wrong = await client.action("check_order", { price: order.price + 1, serving: order.serving, scope: "one-drink" });
    assert.equal(wrong.assessmentPassed, false);
    assert.match(wrong.statusMessage, /price should be/);
    await client.action("approve", {}, 409);
    await client.action("hint");
    // A new engine and panel must recover the same saved assignment and failed attempt.
    engine = engineFor();
    client = await connect();
    const resumed = await client.state();
    assert.equal(resumed.assessmentAttempts, 1);
    assert.equal(resumed.hintCount, 1);
    assert.deepEqual(resumed.issue, started.issue);
    assert.equal(resumed.exercise.completion, null);
    const checked = await client.action("check_order", { price: order.price, serving: order.serving, scope: "one-drink" });
    assert.equal(checked.assessmentPassed, true);
    const approved = await client.action("approve");
    assert.equal(approved.phase, "approved");
    assert.deepEqual(approved.menu, []);
    assert.equal(approved.result, null);
    assert.equal(approved.exercise.completion, null);
    const completed = await client.action("serve");
    assert.equal(completed.phase, "completed");
    assert.deepEqual(completed.menu, [order]);
    assert.equal(completed.result.score, 1000);
    assert.equal(completed.result.rankAtCompletion, 1);
    assert.equal(completed.result.leaderboardUrl, null);
    assert.equal(completed.result.qrImageUrl, null);
    assert.match(completed.exercise.completion, /Step 1 complete/);
    assert.match(completed.exercise.completion, /Inspect, check, approve/);
    for (const action of ["complete", "serve", "refresh", "start"]) {
      assert.deepEqual((await client.action(action)).result, completed.result);
    }
    engine = engineFor();
    assert.deepEqual((await engine.open({ runId, mode: "rehearsal" })).result, completed.result);
    const fresh = await engine.open({ runId: `${runId}-next`, mode: "rehearsal", orderId: order.id }, { requireNew: true });
    assert.equal(fresh.phase, "order");
    assert.deepEqual(fresh.views, []);
    assert.equal(fresh.assessmentAttempts, 0);
    assert.equal(fresh.result, null);
    assert.equal(fresh.exercise.completion, null);
    const saved = await engine.store.read();
    assert.equal(saved.results.length, 1);
    assert.equal(Object.hasOwn(saved.runs[runId], "exercise"), false);
    assert.equal(saved.runs[runId].commentId, null);
    assert.equal(remoteCalls, 0);
  });
}
