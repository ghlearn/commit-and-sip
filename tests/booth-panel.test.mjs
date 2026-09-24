import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  t.after(async () => { await served.close(); await rm(directory, { recursive: true, force: true }); });

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
  assert.equal(served.attendeeUrl, `https://sip.example.com/board?handle=${begun.handle}`);
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
  assert.equal(served.attendeeUrl, "https://sip.example.com/board?handle=" + served.handle,
    "the link itself is still offered");
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

test("no required control on the booth form defaults to an unselectable value", async () => {
  // A required <select> whose default option has an empty value fails
  // reportValidity(), which silently blocks every submit with no message.
  const html = await readFile(new URL("../.github/extensions/commit-and-sip/renderer/booth.html", import.meta.url), "utf8");
  const selects = html.match(/<select\b[^>]*>[\s\S]*?<\/select>/g) ?? [];
  assert.ok(selects.length >= 2, "the mascot and placement pickers are on the form");
  for (const select of selects) {
    if (!/\brequired\b/.test(select)) continue;
    assert.doesNotMatch(select, /<option value=""/,
      `a required select offers an empty default and would block submission: ${select.slice(0, 60)}`);
  }
  // The placement picker is explicitly optional, so it must not be required.
  assert.doesNotMatch(html.match(/<select id="pick-placement"[^>]*>/)[0], /\brequired\b/);
});

test("the optional pickers default to no claim at all", async () => {
  // A picker that defaults to a real mascot makes a claim the attendee never
  // chose, so a typed "Ducky Driftwood" is rejected for a mona they never
  // picked. Both pickers must start on an empty value.
  const html = await readFile(new URL("../.github/extensions/commit-and-sip/renderer/booth.html", import.meta.url), "utf8");
  for (const id of ["pick-mascot", "pick-placement"]) {
    const select = html.match(new RegExp(`<select id="${id}"[^>]*>[\\s\\S]*?</select>`))[0];
    assert.match(select, /<option value=""/, `${id} must offer an empty default`);
    assert.doesNotMatch(select, /\brequired\b/, `${id} is optional and must not be required`);
  }
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
