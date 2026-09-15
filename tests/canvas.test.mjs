import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunStore } from "../.github/extensions/commit-and-sip/store.mjs";
import { RunEngine } from "../.github/extensions/commit-and-sip/engine.mjs";
import { loadCatalog } from "../.github/extensions/commit-and-sip/domain.mjs";
import { canvasDefinition } from "../.github/extensions/commit-and-sip/canvas.mjs";
import { PanelRun } from "../.github/extensions/commit-and-sip/panel.mjs";

const catalog = await loadCatalog();
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "sip-canvas-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const engine = new RunEngine({ store: new RunStore(directory), catalog });
  const canvas = canvasDefinition({ engine });
  const opened = new Set();
  t.after(async () => { for (const instanceId of opened) await canvas.onClose({ instanceId }); });
  return {
    engine, canvas,
    open: async (instanceId, input) => {
      opened.add(instanceId);
      return canvas.open({ instanceId, ...(input === undefined ? {} : { input }) });
    },
    action: (instanceId, actionName, input = {}) => canvas.actions.find(action => action.name === actionName).handler({ instanceId, input })
  };
}
const selection = (runId, orderId = "mona-latte") => ({ operation: "new", runId, mode: "rehearsal", orderId });
const resume = runId => ({ operation: "resume", runId, mode: "rehearsal" });

function client(entry) {
  const url = new URL(entry.url);
  const headers = { authorization: `Bearer ${url.searchParams.get("ticket")}`, "content-type": "application/json", origin: url.origin };
  return {
    state: async () => (await fetch(`${url.origin}/api/state`, { headers })).json(),
    html: async () => (await fetch(entry.url)).text(),
    send: (action, input = {}, extra = {}) => fetch(`${url.origin}/api/action`, {
      method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify({ action, input })
    })
  };
}

test("the canvas declaration accepts an empty object or complete assignment, not partial defaults", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.canvas.inputSchema.oneOf[0], { maxProperties: 0 });
  assert.deepEqual(f.canvas.inputSchema.oneOf[1].required, ["runId", "mode"]);
  assert.equal(f.canvas.inputSchema.oneOf[1].additionalProperties, false);
  assert.equal(f.canvas.inputSchema.required, undefined);
  for (const [index, input] of [undefined, {}].entries()) {
    const view = await f.open(`empty-${index}`, input);
    assert.match(view.title, /Choose an order/);
    const c = client(view);
    assert.match(await c.html(), /Choose your order/);
    const state = await c.state();
    assert.equal(state.phase, "setup");
    assert.equal(state.mode, null);
    assert.deepEqual(state.orders, catalog.orders.map(({ id, name }) => ({ id, name })));
    assert.equal((await f.action(`empty-${index}`, "refresh")).suggestedRunId, state.suggestedRunId);
    await assert.rejects(f.action(`empty-${index}`, "approve"), { code: "selection_required" });
  }
  assert.deepEqual((await f.engine.store.read()).runs, {});
  for (const input of [null, [], { mode: "rehearsal" }, { runId: "partial" }, { orderId: "mona-latte" },
    { mode: "invalid", runId: "bad" }, { runId: "../bad", mode: "rehearsal" }, { unexpected: true },
    { runId: "bad-order", mode: "rehearsal", orderId: "unknown" }]) {
    await assert.rejects(f.open("invalid", input));
  }
  assert.deepEqual((await f.engine.store.read()).runs, {});
});

test("setup selection binds UI and SDK actions to one run without starting review automatically", async t => {
  const f = await fixture(t);
  const entry = await f.open("picker");
  const c = client(entry);
  const response = await c.send("select_run", selection("chosen"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).phase, "order");
  assert.match(await c.html(), /id="exercise-guide"/);
  assert.equal((await f.action("picker", "refresh")).runId, "chosen");
  assert.equal((await f.action("picker", "start")).phase, "reviewing");
  await assert.rejects(f.action("picker", "approve"), { code: "assessment_required" });
  assert.equal((await f.open("picker", {})).url, entry.url);
  assert.equal((await f.open("picker", { runId: "chosen", mode: "rehearsal" })).url, entry.url);
  assert.equal((await c.send("select_run", selection("chosen"))).status, 200, "retry the same selection after a lost response");
  assert.equal((await c.send("select_run", selection("other"))).status, 409);
  assert.equal((await c.send("select_run", selection("chosen", "ducky-cold-brew"))).status, 409);
  await assert.rejects(f.open("picker", { runId: "unwanted", mode: "rehearsal" }), { code: "panel_conflict" });
  assert.deepEqual(Object.keys((await f.engine.store.read()).runs), ["chosen"], "conflicting open cannot create an orphan run");
});

test("setup resume cannot create missing runs, overwrite existing ones, or turn live into rehearsal", async t => {
  const f = await fixture(t);
  await f.engine.open({ runId: "saved", mode: "rehearsal", orderId: "ducky-cold-brew" });
  await f.engine.dispatch("saved", "start");
  await f.engine.dispatch("saved", "view", { surface: "summary" });
  const c = client(await f.open("resume"));
  assert.equal((await c.send("select_run", resume("missing"))).status, 404);
  assert.equal((await c.send("select_run", selection("saved"))).status, 409);
  assert.equal((await c.state()).phase, "setup");
  await f.engine.store.transaction(data => { data.runs.live = { ...data.runs.saved, runId: "live", mode: "live" }; });
  assert.equal((await c.send("select_run", resume("live"))).status, 409);
  const result = await (await c.send("select_run", resume("saved"))).json();
  assert.equal(result.order.id, "ducky-cold-brew");
  assert.deepEqual(result.views, ["summary"]);
  assert.equal(result.phase, "reviewing");
  const saved = await f.engine.store.read();
  assert.equal(saved.runs.live.mode, "live");
  assert.equal(Object.hasOwn(saved.runs, "missing"), false);
  assert.equal(saved.results.length, 0);
});

test("selection rejects cross-origin requests, invalid operations, extra fields, and live requests", async t => {
  const f = await fixture(t);
  const c = client(await f.open("invalid-selection"));
  for (const input of [null, {}, { ...selection("new"), mode: "live" }, { ...selection("new"), operation: "reset" },
    { ...selection("new"), runId: "../escape" }, selection("new", "unknown"), { ...resume("new"), orderId: "mona-latte" },
    { ...selection("new"), score: 1000 }]) {
    assert.equal((await c.send("select_run", input)).status, 400);
  }
  assert.equal((await c.send("select_run", selection("new"), { origin: "https://evil.example" })).status, 403);
  assert.equal((await c.send("select_run", selection("new"), { authorization: "Bearer invalid" })).status, 401);
  assert.deepEqual((await f.engine.store.read()).runs, {});
});

test("complete direct opens keep their existing contract and live remains fail-closed", async t => {
  const f = await fixture(t);
  const input = { runId: "direct", mode: "rehearsal", orderId: "copilot-cortado" };
  const c = client(await f.open("direct-panel", input));
  assert.equal((await c.state()).runId, "direct");
  assert.match(await c.html(), /id="exercise-guide"/);
  await assert.rejects(f.open("bad-live", { runId: "live", mode: "live" }), { code: "live_unconfigured" });
  assert.equal(Object.hasOwn((await f.engine.store.read()).runs, "live"), false);
  const reopened = client(await f.open("different-panel", input));
  assert.equal((await reopened.state()).runId, "direct");
});

test("provider restart returns unassigned opens to setup; explicit resume preserves the durable run", async t => {
  const f = await fixture(t);
  await f.open("old-panel");
  await f.action("old-panel", "select_run", selection("durable"));
  await f.action("old-panel", "start");
  await f.canvas.onClose({ instanceId: "old-panel" });
  const restored = canvasDefinition({ engine: new RunEngine({ store: new RunStore(f.engine.store.directory), catalog }) });
  t.after(() => restored.onClose({ instanceId: "rehydrated-panel" }));
  const entry = await restored.open({ instanceId: "rehydrated-panel", input: {} });
  assert.equal((await client(entry).state()).phase, "setup");
  const selected = await restored.actions.find(action => action.name === "select_run").handler({ instanceId: "rehydrated-panel", input: resume("durable") });
  assert.equal(selected.phase, "reviewing");
  assert.deepEqual(Object.keys((await f.engine.store.read()).runs), ["durable"]);
});

test("overlapping selections cannot create two runs behind one panel", async t => {
  const f = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const panel = new PanelRun({
    catalog, open: async (...args) => { await gate; return f.engine.open(...args); },
    get: runId => f.engine.get(runId)
  });
  const first = panel.dispatch("select_run", selection("first"));
  await assert.rejects(panel.dispatch("select_run", selection("second")), { code: "selection_busy" });
  release();
  assert.equal((await first).runId, "first");
  assert.deepEqual(Object.keys((await f.engine.store.read()).runs), ["first"]);
});
