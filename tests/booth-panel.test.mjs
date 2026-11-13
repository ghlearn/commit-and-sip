import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { RunStore } from "../.github/extensions/commit-and-sip/store.mjs";
import { BoothEngine } from "../.github/extensions/commit-and-sip/booth-engine.mjs";
import { BoothPanel } from "../.github/extensions/commit-and-sip/booth-panel.mjs";
import { startServer } from "../.github/extensions/commit-and-sip/server.mjs";
import { boothCanvasDefinition } from "../.github/extensions/commit-and-sip/canvas.mjs";
import { loadCatalog } from "../.github/extensions/commit-and-sip/domain.mjs";
import { loadNameRules } from "../.github/extensions/commit-and-sip/services/coffee-name.mjs";

const catalog = await loadCatalog();
const rules = await loadNameRules();

// Drives the panel through the same loopback HTTP surface the canvas renderer
// uses, so wiring faults show up here rather than at the booth.
async function station(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "sip-station-"));
  const store = new RunStore(directory);
  const engine = new BoothEngine({ store, catalog, rules, ...options });
  const panel = new BoothPanel(engine, { renderQr: async url => `data:image/png;base64,${Buffer.from(url).toString("base64")}` });
  const served = await startServer({ engine, panel, home: "booth.html" });
  t.after(async () => {
    await served.close();
    if (engine.publicationSweep) await engine.publicationSweep;
    await engine.drainPublications();
    await rm(directory, { recursive: true, force: true });
  });

  const base = new URL(served.url);
  const ticket = base.searchParams.get("ticket");
  const call = async (path, body) => {
    const response = await fetch(new URL(path, base.origin), {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${ticket}`, ...(body ? { "Content-Type": "application/json", Origin: base.origin } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    engine, served, origin: base.origin, ticket,
    state: () => call("/api/state"),
    act: (action, input = {}) => call("/api/action", { action, input })
  };
}

test("the booth screen is served and needs no run to show the house menu", async t => {
  const booth = await station(t);
  const page = await fetch(new URL("/", booth.origin));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<script src="\/booth\.js" defer><\/script>/, "the booth page is served, not the review launcher");
  assert.doesNotMatch(html, /pull request|Choose your order/i, "no pull-request review flow reaches the attendee");

  const { body } = await booth.state();
  assert.equal(body.phase, "idle");
  assert.equal(body.houseMenu.length, 3, "the examples are on the counter before anyone plays");
  assert.deepEqual(body.mascots, ["mona", "ducky", "copilot"]);
  assert.deepEqual(body.placements, ["start", "middle", "end", "blend"]);
  assert.equal(body.handle, undefined, "nobody has a handle until they begin");
});

test("an attendee runs the whole exercise through the canvas alone", async t => {
  const booth = await station(t, { leaderboardUrl: "https://sip.example.com/board" });

  const begun = (await booth.act("begin")).body;
  assert.equal(begun.phase, "naming");
  assert.match(begun.handle, /^[a-z]+-[a-z]+-[a-z]+$/, "they get a handle before inventing anything");
  assert.equal(begun.qrDataUrl, null, "nothing to scan yet");

  const refused = await booth.act("submit_name", { name: "Mona Latte" });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error.message, /house example/);
  assert.equal((await booth.state()).body.phase, "naming", "a refused name keeps them at the counter");

  const served = (await booth.act("submit_name",
    { name: "Ducky Dawn Drip", mascot: "ducky", placement: "start" })).body;
  assert.equal(served.phase, "served");
  assert.equal(served.submission.name, "Ducky Dawn Drip");
  assert.ok(served.submission.score > 0 && served.submission.score <= 5000);
  assert.equal(served.standing.rank, 1);
  assert.equal(served.attendeeUrl, "https://sip.example.com/board", "no reference yet, so no personal link");
  assert.match(served.qrDataUrl, /^data:image\/png;base64,/, "a real code is rendered for a real destination");

  const cleared = (await booth.act("complete")).body;
  assert.equal(cleared.phase, "idle", "completing clears the station for the next barista");
  assert.equal(cleared.justCompleted, begun.handle);
  assert.ok(cleared.houseMenu.some(drink => drink.id === "ducky-dawn-drip"), "their drink stays on the menu");
  assert.equal(cleared.leaderboard.length, 1);
  assert.equal(cleared.handle, undefined, "the next attendee inherits nothing personal");
});

test("the station serves one attendee at a time and hands over cleanly", async t => {
  const booth = await station(t);
  assert.equal((await booth.act("submit_name", { name: "Mona Mist" })).status, 409, "no order is open yet");
  assert.equal((await booth.act("complete")).status, 409);

  const first = (await booth.act("begin")).body;
  assert.equal((await booth.act("begin")).status, 409, "a second barista cannot jump the counter");

  await booth.act("submit_name", { name: "Mona Mist" });
  await booth.act("complete");

  const second = (await booth.act("begin")).body;
  assert.notEqual(second.handle, first.handle);
  assert.equal(second.phase, "naming");
  assert.equal((await booth.act("submit_name", { name: "mona   MIST" })).status, 409,
    "the previous attendee's drink cannot be claimed again, however it is typed");
});

test("without a configured leaderboard no destination or code is invented", async t => {
  const booth = await station(t);
  await booth.act("begin");
  const served = (await booth.act("submit_name", { name: "Copilot Crescent" })).body;
  assert.equal(served.attendeeUrl, null);
  assert.equal(served.qrDataUrl, null);
  assert.equal(served.leaderboardUrl, null);
});

test("the booth panel rejects unknown actions and malformed input", async t => {
  const booth = await station(t);
  await booth.act("begin");
  for (const [action, input] of [["approve", {}], ["serve", {}], ["view", { surface: "changes" }]]) {
    assert.equal((await booth.act(action, input)).status, 400, `${action} is not part of the booth exercise`);
  }
  assert.equal((await booth.act("submit_name", { name: "Mona Mist", extra: "x" })).status, 400);
  assert.equal((await booth.act("submit_name", {})).status, 400);
});

test("a missing QR encoder degrades to the plain link instead of a broken code", async t => {
  const directory = await mkdtemp(join(tmpdir(), "sip-noqr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const engine = new BoothEngine({
    store: new RunStore(directory), catalog, rules, leaderboardUrl: "https://sip.example.com/board"
  });
  const { renderQrDataUrl } = await import("../.github/extensions/commit-and-sip/services/qr.mjs");
  const panel = new BoothPanel(engine, {
    renderQr: url => renderQrDataUrl(url, () => Promise.reject(new Error("not installed")))
  });
  await panel.dispatch("begin", {});
  const served = await panel.dispatch("submit_name", { name: "Mona Meridian" });
  assert.equal(served.qrDataUrl, null, "no code is shown rather than a broken one");
  assert.equal(served.attendeeUrl, "https://sip.example.com/board",
    "the link itself is still offered");
});

// The fallback above is correct but invisible, so staff need it surfaced at
// start-up. Pin both directions: a booth that installed the encoder must not be
// warned, and one that skipped it must be.
test("a missing QR encoder is detectable so start-up can warn staff", async () => {
  const { qrEncoderAvailable } = await import("../.github/extensions/commit-and-sip/services/qr.mjs");
  assert.equal(await qrEncoderAvailable(() => Promise.reject(new Error("not installed"))), false,
    "a booth that skipped npm ci is reported as missing the encoder");
  assert.equal(await qrEncoderAvailable(), true,
    "this repository has the encoder installed, so no warning is owed");
});

// The canvas definition is what the App loads, so exercise it directly rather
// than trusting that the panel wiring underneath it is reached.
async function canvasFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "sip-canvas-booth-"));
  const engine = new BoothEngine({ store: new RunStore(directory), catalog, rules, ...options });
  const canvas = boothCanvasDefinition({ engine });
  const opened = new Set();
  t.after(async () => {
    for (const instanceId of opened) await canvas.onClose({ instanceId });
    await rm(directory, { recursive: true, force: true });
  });
  return {
    canvas,
    open: async (instanceId, input) => {
      opened.add(instanceId);
      return canvas.open({ instanceId, ...(input === undefined ? {} : { input }) });
    },
    action: (instanceId, name, input = {}) =>
      canvas.actions.find(entry => entry.name === name).handler({ instanceId, input })
  };
}

test("the canvas opens straight into the booth with no assignment to arrange", async t => {
  const fixture = await canvasFixture(t);
  const opened = await fixture.open("station-1");
  assert.match(opened.title, /Name a drink/);
  assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/\?ticket=[a-f0-9]{64}$/);

  assert.deepEqual(fixture.canvas.actions.map(action => action.name).sort(),
    ["begin", "complete", "refresh", "submit_name"], "only booth actions are exposed");
  await assert.rejects(fixture.open("station-2", { runId: "booth-1", mode: "rehearsal" }),
    { code: "invalid_input" }, "there is no run to assign; the booth mints its own");
});

test("the canvas drives a full attendee and reopens onto the same order", async t => {
  const fixture = await canvasFixture(t);
  await fixture.open("station-1");
  const begun = await fixture.action("station-1", "begin");
  assert.equal(begun.phase, "naming");

  const reopened = await fixture.open("station-1");
  assert.match(reopened.title, /Inventing/, "reopening mid-order returns the attendee to their own order");

  const served = await fixture.action("station-1", "submit_name", { name: "Mona Moonrise", placement: "start" });
  assert.equal(served.submission.name, "Mona Moonrise");
  assert.match((await fixture.open("station-1")).title, /Scored/);

  const cleared = await fixture.action("station-1", "complete");
  assert.equal(cleared.phase, "idle");
  assert.match((await fixture.open("station-1")).title, /Name a drink/);
});

test("canvas actions need an open panel and reject unsupported input", async t => {
  const fixture = await canvasFixture(t);
  await assert.rejects(fixture.action("never-opened", "begin"), { code: "panel_missing" });
  await fixture.open("station-1");
  await fixture.action("station-1", "begin");
  await assert.rejects(fixture.action("station-1", "submit_name", { name: "Mona Mist", placement: "sideways" }),
    { code: "invalid_choice" });
  await assert.rejects(fixture.action("station-1", "submit_name", { name: "Espresso Only" }),
    { code: "invalid_name" });
});

test("two stations at one booth share the menu but not the attendee", async t => {
  const fixture = await canvasFixture(t);
  await fixture.open("station-1");
  await fixture.open("station-2");
  const first = await fixture.action("station-1", "begin");
  const second = await fixture.action("station-2", "begin");
  assert.notEqual(first.handle, second.handle, "each station has its own barista");

  await fixture.action("station-1", "submit_name", { name: "Ducky Drift" });
  const view = await fixture.action("station-2", "refresh");
  assert.ok(view.houseMenu.some(drink => drink.id === "ducky-drift"), "but they build one shared menu");
  await assert.rejects(fixture.action("station-2", "submit_name", { name: "Ducky Drift" }),
    { code: "duplicate_drink" });
});

test("the booth form asks only for the name and says a mascot is required", async () => {
  // The station reads the mascot and its placement from the typed name, so
  // the attendee form offers no pickers that could make a claim they never
  // chose. The hint sits on the name field so assistive tech reads it too.
  const html = await readFile(new URL("../.github/extensions/commit-and-sip/renderer/booth.html", import.meta.url), "utf8");
  const form = html.match(/<form id="name-form"[\s\S]*?<\/form>/)[0];
  assert.doesNotMatch(form, /<select\b/, "the attendee form has no pickers");
  assert.doesNotMatch(html, /pick-mascot|pick-placement/);
  const hint = form.match(/<p id="mascot-hint">([\s\S]*?)<\/p>/);
  assert.ok(hint, "the name field carries the mascot hint");
  assert.equal(hint[1].replace(/<[^>]+>/g, ""),
    "Required: include a mascot: Copilot, Ducky, or Mona. Example: Monachino. Use more than one mascot name for bonus points.");
  assert.match(form, /<input id="pick-name"[^>]*aria-describedby="mascot-hint name-help"/);
  const script = await readFile(new URL("../.github/extensions/commit-and-sip/renderer/booth.js", import.meta.url), "utf8");
  assert.doesNotMatch(script, /pick-mascot|pick-placement/);
});

test("naming polls preserve typing, render background settlement, and ignore stale responses", async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: "", hidden: false, disabled: false, textContent: "", handlers: {},
      setAttribute() {}, replaceChildren() {}, append() {}, reset() { this.resetCount = (this.resetCount ?? 0) + 1; },
      reportValidity() { return true; }, addEventListener(type, handler) { this.handlers[type] = handler; },
    });
    return elements.get(id);
  };
  const naming = { phase: "naming", handle: "bright-brews-beans", houseMenu: [], houseMenuTotal: 0,
    leaderboard: [], leaderboardTotal: 0 };
  const served = { ...naming, phase: "served", submission: { name: "Mona Moonrise", score: 1234, breakdown: [] },
    sync: { state: "confirmed" }, standing: { rank: 1, entries: 1 } };
  const response = state => ({ ok: true, json: async () => state });
  let interval;
  let next = async () => response(naming);
  const source = await readFile(new URL("../.github/extensions/commit-and-sip/renderer/booth.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    document: { hidden: false, getElementById: element, createElement: () => element(Symbol()), createTextNode: () => ({}) },
    window: { location: { search: "?ticket=test" }, setInterval: callback => { interval = callback; } },
    fetch: (...args) => next(...args), URLSearchParams, AbortController, setTimeout, clearTimeout,
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  element("pick-name").value = "Mona still typing";
  let release;
  next = () => new Promise(resolve => { release = resolve; });
  interval();
  assert.equal(element("name-fields").disabled, false, "background polling does not interrupt typing");
  release(response(naming));
  await flush();
  assert.equal(element("pick-name").value, "Mona still typing");
  assert.equal(element("name-form").resetCount, undefined);
  const failed = (code, message) => ({ ok: false, status: 409, json: async () => ({ error: { code, message } }) });
  next = async () => failed("leaderboard_unreachable", "Connection lost. Try again.");
  await element("name-form").handlers.submit({ preventDefault() {} });
  assert.equal(element("name-problem").textContent, "Connection lost. Try again.");
  const refused = { ...naming, admissionFeedback: { code: "score_taken", message: "Tweak your name." } };
  next = async () => response(refused);
  interval();
  await flush();
  assert.equal(element("name-problem").hidden, true, "the stale connectivity error is cleared");
  assert.equal(element("name-board-feedback").hidden, false);
  assert.match(element("name-board-feedback").textContent, /Tweak your name/);
  assert.equal(element("pick-name").value, "Mona still typing");
  next = async () => failed("invalid_name", "Include a mascot.");
  await element("name-form").handlers.submit({ preventDefault() {} });
  next = async () => response(refused);
  interval();
  await flush();
  assert.equal(element("name-problem").hidden, false, "local validation remains visible");
  assert.equal(element("name-problem").textContent, "Include a mascot.");
  assert.equal(element("name-board-feedback").hidden, false, "the earlier refusal is also visible");
  next = async () => failed("duplicate_drink", "This name is already on the booth menu.");
  await element("name-form").handlers.submit({ preventDefault() {} });
  next = async () => response({ ...naming, admissionFeedback: { code: "duplicate_drink", message: "Another barista published this name." } });
  interval();
  await flush();
  assert.equal(element("name-problem").hidden, false, "a local error sharing the board code is still distinct");
  assert.equal(element("name-problem").textContent, "This name is already on the booth menu.");
  next = () => new Promise(resolve => { release = resolve; });
  interval();
  const releaseStale = release;
  next = async () => response(served);
  await element("name-form").handlers.submit({ preventDefault() {} });
  releaseStale(response(naming));
  await flush();
  assert.equal(element("view-served").hidden, false, "a stale naming poll cannot overwrite a completed submission");
  assert.equal(element("served-score").textContent, "1234");

  // A separate naming screen receives a settlement on its next background poll.
  next = async () => response(naming);
  await element("booth-retry").handlers.click();
  await flush();
  element("pick-name").value = "Ducky draft";
  next = async () => response(served);
  interval();
  await flush();
  assert.equal(element("view-served").hidden, false);
  assert.equal(element("served-name").textContent, "Mona Moonrise");
  assert.equal(element("pick-name").value, "Ducky draft");
  next = async () => response({ ...naming, phase: "idle" });
  interval();
  await flush();
  assert.equal(element("view-idle").hidden, false, "a served screen reconciles a later staff closure");
});

test("the naming state exposes a background refusal until a new attempt starts", async t => {
  let count = 0;
  const leaderboardClient = { async publish(sent) {
    count += 1;
    if (count === 1) throw new Error("timeout");
    if (count === 2) throw Object.assign(new Error("taken"), { code: "score_taken", status: 409 });
    return { ...sent, entries: 1, rank: 1 };
  } };
  const booth = await station(t, { leaderboardClient });
  await booth.act("begin");
  const timedOut = await booth.act("submit_name", { name: "Mona Moonrise" });
  assert.equal(timedOut.body.error.code, "leaderboard_unreachable");
  await booth.engine.retryPublications();
  const state = (await booth.state()).body;
  assert.equal(state.phase, "naming");
  assert.equal(state.admissionFeedback.code, "score_taken");
  assert.match(state.admissionFeedback.message, /Tweak your name/);
  const served = (await booth.act("submit_name", { name: "Ducky Dawn Drizzle" })).body;
  assert.equal(served.phase, "served");
  assert.equal(served.admissionFeedback, null);
});

test("the hint's example is a name the station accepts", async t => {
  const booth = await station(t);
  await booth.act("begin");
  const served = await booth.act("submit_name", { name: "Monachino" });
  assert.equal(served.status, 200);
  assert.equal(served.body.submission.name, "Monachino");
});

test("a removed drink never keeps congratulating the attendee", async () => {
  // The whole served view is written for success. After a takedown it is still
  // on screen, so every claim on it has to be re-checked against `removed`:
  // the heading, the standing, the QR, and the event receipt. A confirmed
  // receipt in particular survives removal, because this booth publishes to a
  // leaderboard service but cannot retract from one.
  const js = await readFile(new URL("../.github/extensions/commit-and-sip/renderer/booth.js", import.meta.url), "utf8");
  const served = js.slice(js.indexOf("function fillServed"), js.indexOf("function render"));
  assert.ok(served.length > 0, "the served renderer is where these claims are made");
  for (const claim of ["served-heading", "served-standing", "served-event"]) {
    const line = served.slice(served.indexOf(claim));
    assert.match(line.slice(0, 260), /state\.removed/,
      `${claim} still asserts success without checking whether the drink was removed`);
  }
  assert.match(served, /served-qr-removed"\)\.hidden = !state\.removed/);
  // "No leaderboard is deployed" and "your drink was taken down" are different
  // facts, and showing both at once tells the attendee neither.
  assert.match(served, /served-qr-none"\)\.hidden = Boolean\(state\.attendeeUrl\) \|\| Boolean\(state\.removed\)/);

  const html = await readFile(new URL("../.github/extensions/commit-and-sip/renderer/booth.html", import.meta.url), "utf8");
  assert.match(html, /id="served-qr-removed"[^>]*hidden/, "the removal notice starts hidden");
});

// Review found that closing an abandoned station moved the ledger but left this
// panel holding the old run, so the station refused every following attendee.
test("a station staff closed is ready for the next attendee", async t => {
  const booth = await station(t);
  const started = await booth.act("begin");
  assert.equal(started.status, 200);
  const { runId } = started.body;
  assert.ok(runId, "the panel reports which run is at the counter");

  await booth.engine.closeStation({ runId, closedBy: "Sam" });

  const idle = await booth.state();
  assert.equal(idle.status, 200);
  assert.equal(idle.body.phase, "idle", "the screen returns to the house menu on its own");

  const next = await booth.act("begin");
  assert.equal(next.status, 200, "and the next attendee can start");
  assert.notEqual(next.body.runId, runId, "as a new run, not the closed one");
});

for (const reopen of [false, true]) {
  for (const outcome of ["admitted", "timeout"]) {
    test(`a closed in-flight admission returns ${reopen ? "the next run" : "idle"} after ${outcome}`, async t => {
      let release;
      let entered;
      const started = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      t.after(() => release());
      let sends = 0;
      const leaderboardClient = { async publish(sent) {
        sends += 1;
        if (sends === 1) {
          entered();
          await gate;
          if (outcome === "timeout") throw new Error("timeout");
        }
        return { ...sent, entries: 1, rank: 1 };
      } };
      const booth = await station(t, { leaderboardClient });
      const first = (await booth.act("begin")).body;
      const inFlight = booth.act("submit_name", { name: "Mona Moonrise Mocha" });
      await started;
      await booth.engine.closeStation({ runId: first.runId, closedBy: "Sam" });
      const next = reopen ? (await booth.act("begin")).body : null;
      release();
      const result = await inFlight;
      assert.equal(result.status, 200);
      assert.equal(result.body.phase, reopen ? "naming" : "idle");
      if (reopen) {
        assert.equal(result.body.runId, next.runId, "the old answer cannot displace the next attendee");
        assert.equal((await booth.state()).body.runId, next.runId);
      } else {
        assert.equal((await booth.act("begin")).body.phase, "naming", "the station can start another order");
      }
    });
  }
}

test("a stale station read cannot clear a newly started attendee", async t => {
  const booth = await station(t);
  const first = (await booth.act("begin")).body;
  const original = booth.engine.get.bind(booth.engine);
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let delayed = false;
  booth.engine.get = async runId => {
    if (!delayed && runId === first.runId) {
      delayed = true;
      entered();
      await gate;
    }
    return original(runId);
  };
  const oldRead = booth.state();
  await started;
  await booth.engine.closeStation({ runId: first.runId, closedBy: "Sam" });
  const next = (await booth.act("begin")).body;
  release();
  assert.equal((await oldRead).body.runId, next.runId);
  assert.equal((await booth.state()).body.runId, next.runId);
});

test("a station whose event was archived recovers instead of failing", async t => {
  const booth = await station(t);
  const started = await booth.act("begin");
  await booth.act("submit_name", { name: "Mona Moonlight" });
  const { runId } = started.body;
  await booth.engine.closeStation({ runId, closedBy: "Sam" });
  await booth.engine.archiveAndWipe({ archivedBy: "Sam", confirm: "wipe" });

  // The run this panel remembers no longer exists anywhere.
  const idle = await booth.state();
  assert.equal(idle.status, 200, "refreshing must not fail with run_missing");
  assert.equal(idle.body.phase, "idle");

  const next = await booth.act("begin");
  assert.equal(next.status, 200, "the booth opens the next event without being reopened");
});
