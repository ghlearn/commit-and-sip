import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTENT_SECURITY_POLICY, createApp, handleIsCurated } from "../leaderboard-service/app.mjs";
import { ConflictError, FileStore, MemoryStore, reservationKey } from "../leaderboard-service/store.mjs";
import { BoothEngine } from "../.github/extensions/commit-and-sip/booth-engine.mjs";
import { AdminPanel } from "../.github/extensions/commit-and-sip/admin-panel.mjs";
import { loadCatalog } from "../.github/extensions/commit-and-sip/domain.mjs";
import { RunStore } from "../.github/extensions/commit-and-sip/store.mjs";
import { loadNameRules } from "../.github/extensions/commit-and-sip/services/coffee-name.mjs";
import { leaderboard } from "../.github/extensions/commit-and-sip/services/booth-menu.mjs";
import { createLeaderboardClient, leaderboardClientFromConfig, validateLeaderboardApi }
  from "../.github/extensions/commit-and-sip/services/leaderboard-client.mjs";
import { newPublicationToken, publicRef, submissionFor, tokenHashOf, validateReceipt } from "../.github/extensions/commit-and-sip/services/leaderboard.mjs";
import { validateBlocklist } from "../.github/extensions/commit-and-sip/services/moderation.mjs";
import { scoreCoffeeName } from "../.github/extensions/commit-and-sip/services/name-score.mjs";

// Shaped placeholders only, never real moderation terms (see moderation tests).
const BOOTH_KEY = "b".repeat(24) + "-booth-key-for-tests";
const STAFF_KEY = "s".repeat(24) + "-staff-key-for-tests";
const RESERVATION_KEY = "r".repeat(40);
const reviewed = validateBlocklist({
  review: { placeholder: false, reviewedAt: "2026-01-01", reviewedBy: "test" },
  entries: [{ match: "substring", term: "zzqq" }],
});
const rules = { ...(await loadNameRules()), blocklist: reviewed };
const catalog = await loadCatalog();
const words = JSON.parse(await readFile(new URL("../booth/handle-words.json", import.meta.url), "utf8"));
const HANDLE = `${words.adjectives[0]}-${words.verbs[0]}-${words.nouns[0]}`;
const OTHER_HANDLE = `${words.adjectives[1]}-${words.verbs[1]}-${words.nouns[1]}`;

async function service(t, { store = new MemoryStore(), serviceRules = rules } = {}) {
  const app = createApp({ boothKey: BOOTH_KEY, reservationKey: RESERVATION_KEY, rules: serviceRules, staffKey: STAFF_KEY, store, words });
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { store, url: `http://127.0.0.1:${server.address().port}` };
}

// Each call is a distinct publication, with its own token. Reusing the
// returned object is what a booth retry looks like.
function submission(name, handle = HANDLE) {
  const scored = scoreCoffeeName(name, rules);
  return { handle, id: scored.id, name: scored.name, score: scored.score, token: newPublicationToken() };
}

function post(url, body, key = BOOTH_KEY, headers = {}) {
  return fetch(`${url}/api/entries`, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers },
    method: "POST",
  });
}

// Retraction carries the ID in the body of a fixed route, so it never lands
// in a web-server log line.
const del = (url, id, key = STAFF_KEY) => fetch(`${url}/api/retractions`, {
  body: JSON.stringify({ id }),
  headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
  method: "POST",
});

const board = async (url, query = "") => (await fetch(`${url}/api/board${query}`)).json();

// --- The contract -----------------------------------------------------------

test("the service's real receipt passes the booth's own receipt check", async t => {
  const { url } = await service(t);
  const sent = submission("Mona Moonrise Mocha");
  const response = await post(url, sent);
  assert.equal(response.status, 201);
  // Not a mock agreeing with itself: this is the check the booth runs before
  // it will show an attendee an event rank.
  const receipt = validateReceipt(await response.json(), sent);
  assert.deepEqual({ entries: receipt.entries, rank: receipt.rank }, { entries: 1, rank: 1 });
});

test("a booth publishes, the board shows it, and a takedown clears it", async t => {
  const { url } = await service(t);
  const directory = await mkdtemp(join(tmpdir(), "sip-lb-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const store = new RunStore(directory);
  const client = createLeaderboardClient({ boothKey: BOOTH_KEY, staffKey: STAFF_KEY, url });
  const engine = new BoothEngine({ catalog, leaderboardClient: client, rules, store });

  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Ducky Dawn Drizzle" });
  await engine.publish("booth-1");
  const sync = (await store.read()).runs["booth-1"].sync;
  assert.equal(sync.state, "confirmed", `publish should be confirmed, got ${sync.state}: ${sync.reason ?? ""}`);
  assert.equal(sync.receipt.rank, 1);
  assert.deepEqual((await board(url)).entries.map(row => row.name), [served.submission.name]);

  const record = await engine.removeDrink({ id: served.submission.id, reason: "test", removedBy: "lead" });
  assert.equal(record.published, "retracted");
  assert.equal((await board(url)).total, 0, "a takedown must reach the public board");
  assert.equal((await store.read()).removals[0].published, "retracted", "the outcome is recorded for staff");

  // The usual case: staff catch a name before it ever syncs. The service has
  // nothing to delete, and that is a clean outcome, not a failure to retry.
  await engine.open({ runId: "booth-2" });
  const unsynced = await engine.dispatch("booth-2", "submit_name", { name: "Copilot Cinder Crema" });
  const early = await engine.removeDrink({ id: unsynced.submission.id, reason: "test", removedBy: "lead" });
  assert.equal(early.published, "absent");
  assert.deepEqual(await engine.retryRetractions(), [], "an absent entry is not queued for retry");
});

// --- Who may do what --------------------------------------------------------

test("reading is open, but writing needs the right key for the right action", async t => {
  const { url } = await service(t);
  const sent = submission("Copilot Cinder Crema");
  assert.equal((await fetch(`${url}/api/board`)).status, 200, "anyone may read");
  assert.equal((await post(url, sent, null)).status, 401, "no key, no submission");
  assert.equal((await post(url, sent, "x".repeat(40))).status, 401, "a wrong key is refused");
  assert.equal((await post(url, sent, STAFF_KEY)).status, 401, "the staff key cannot publish");
  assert.equal((await post(url, sent)).status, 201);
  assert.equal((await del(url, sent.id, null)).status, 401);
  assert.equal((await del(url, sent.id, BOOTH_KEY)).status, 401, "a booth key cannot delete entries");
  assert.equal((await del(url, sent.id)).status, 204);
  const again = await del(url, sent.id);
  assert.equal(again.status, 200, "a second retraction reports it is already gone, in the service's own words");
  assert.deepEqual(await again.json(), { retraction: "absent" });
});

test("a leaked booth key still cannot post what the booth would not", async t => {
  const { url } = await service(t);
  const honest = submission("Mona Moonrise Mocha");
  const cases = [
    [{ ...honest, score: 5000 }, "score_mismatch", "an inflated score"],
    [{ ...honest, id: "other-id" }, "score_mismatch", "an ID that does not belong to the name"],
    // Built by hand: the helper scores with the same blocklist and would refuse it.
    [{ ...honest, id: "mona-zzqq-mocha", name: "Mona Zzqq Mocha", score: 3000 }, "rejected_name", "a name the blocklist refuses"],
    [{ ...honest, id: "mona-latte", name: "Mona Latte", score: 3000 }, "rejected_name", "a house example"],
    [{ ...honest, name: "Mona <b>Mocha</b>" }, "rejected_name", "markup in the name"],
    [{ ...honest, handle: "mallory-was-here" }, "invalid_handle", "a handle not built from the word lists"],
    [{ ...honest, handle: `${HANDLE}-<script>` }, "invalid_handle", "a handle carrying markup"],
  ];
  for (const [body, code, label] of cases) {
    const response = await post(url, body);
    assert.equal(response.status, 422, label);
    assert.equal((await response.json()).error, code, label);
  }
  assert.equal((await board(url)).total, 0, "nothing refused reached the board");
});

test("requests that are not a clean submission are refused before scoring", async t => {
  const { url } = await service(t);
  const honest = submission("Mona Moonrise Mocha");
  assert.equal((await post(url, { ...honest, runId: "x" })).status, 400, "no fields beyond the contract");
  assert.equal((await post(url, "{not json")).status, 400);
  assert.equal((await post(url, honest, BOOTH_KEY, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post(url, { ...honest, name: "m".repeat(4000) })).status, 413);
  assert.equal((await fetch(`${url}/api/entries/abc`, { method: "POST" })).status, 404);
  assert.equal((await del(url, "Bad..ID")).status, 400);
});

// --- Reservations ------------------------------------------------------------

test("a name taken down at one booth cannot be published from another", async t => {
  const { url } = await service(t);
  const first = submission("Mona Moonrise Mocha");
  assert.equal((await post(url, first)).status, 201);
  assert.equal((await del(url, first.id)).status, 204);
  // A different attendee at a different booth types the same name.
  const retyped = await post(url, submission("Mona Moonrise Mocha", OTHER_HANDLE));
  assert.equal(retyped.status, 409);
  assert.deepEqual(await retyped.json(), { error: "unavailable_drink", message: "That name is not available." },
    "worded exactly as the booth words a blocklist hit");
  assert.equal((await post(url, first)).status, 409, "nor can the original booth put it back");
  assert.equal((await board(url)).total, 0);
});

test("a name caught before it synced is still reserved everywhere", async t => {
  const { url } = await service(t);
  const early = submission("Ducky Dawn Drizzle");
  assert.deepEqual(await (await del(url, early.id)).json(), { retraction: "absent" }, "nothing was on the board");
  assert.equal((await post(url, submission("Ducky Dawn Drizzle", OTHER_HANDLE))).status, 409,
    "but the name is reserved all the same");
});

test("the stored board keeps no readable trace of a removed name", async t => {
  const directory = await tempDirectory(t);
  const key = await reservationKey(directory);
  const store = await openStore({ directory });
  const app = createApp({ boothKey: BOOTH_KEY, reservationKey: key, rules, staffKey: STAFF_KEY, store, words });
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;

  const removed = submission("Mona Moonrise Mocha");
  await post(url, removed);
  await post(url, submission("Ducky Dawn Drizzle"));
  await del(url, removed.id);
  const saved = await readFile(join(directory, "default.json"), "utf8");
  for (const trace of [removed.id, removed.name, "moonrise", "Moonrise"]) {
    assert.ok(!saved.includes(trace), `the stored board must not contain "${trace}"`);
  }
  assert.ok(saved.includes("Ducky Dawn Drizzle"), "the published drink is stored as shown");
  assert.equal(JSON.parse(saved).reserved.length, 1);
  assert.match(JSON.parse(saved).reserved[0], /^[0-9a-f]{64}$/, "only a keyed fingerprint is kept");
  // A plain hash of the ID would be reversible by hashing candidate names, so
  // the fingerprint must depend on the service's secret, not only on the name.

  for (const guess of [removed.id, removed.name, removed.id.toUpperCase()]) {
    assert.notEqual(JSON.parse(saved).reserved[0], createHash("sha256").update(guess).digest("hex"),
      "the fingerprint cannot be recomputed from the name alone");
  }
});

test("the reservation key is created once, kept private, and reused", async t => {
  const { stat } = await import("node:fs/promises");
  const directory = await tempDirectory(t);
  const key = await reservationKey(directory);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(await reservationKey(directory), key, "a restart must not change it, or every reservation is lost");
  assert.equal((await stat(join(directory, "reservation.key"))).mode & 0o777, 0o600);
  assert.notEqual(await reservationKey(await tempDirectory(t)), key);
});

// --- Idempotency and ranking ------------------------------------------------

test("a retried submission is a success, but a clashing name is not", async t => {
  const { url } = await service(t);
  const sent = submission("Mona Moonrise Mocha");
  const first = await post(url, sent);
  const again = await post(url, sent);
  assert.equal(first.status, 201);
  assert.equal(again.status, 200, "a booth retrying after a network blip must not see an error");
  assert.deepEqual(await again.json(), await first.json());
  const rival = await post(url, submission("Mona Moonrise Mocha", OTHER_HANDLE));
  assert.equal(rival.status, 409, "another booth's attendee must not overwrite the first entry");
  assert.equal((await rival.json()).error, "duplicate_drink");
  assert.equal((await board(url)).entries[0].handle, HANDLE);
});

test("equal scores share a rank exactly as they do at the booth", async t => {
  const { url, store } = await service(t);
  const candidates = ["Mocha", "Latte", "Crema", "Brew", "Roast", "Drip", "Chai", "Frappe"].flatMap(coffee =>
    ["Moonrise", "Sunset", "Velvet", "Ember", "Harbor", "Meadow"].map(word => `Mona ${word} ${coffee}`));
  const byScore = new Map();
  for (const name of candidates) {
    const { score } = scoreCoffeeName(name, rules);
    byScore.set(score, [...(byScore.get(score) ?? []), name]);
  }
  // A tie with something strictly above it, so the tied pair's shared rank is
  // 2 and cannot be satisfied by an accident of ordering.
  const top = Math.max(...byScore.keys());
  const [tiedScore, tied] = [...byScore.entries()].find(([score, names]) => names.length >= 2 && score < top) ?? [];
  assert.ok(tied, "the candidate list should contain a tie below the top score");
  const higher = [...byScore.entries()].find(([score]) => score > tiedScore);
  // And one below it. Dense ranking (1, 2, 2, 3) agrees with the booth's
  // competition ranking (1, 2, 2, 4) until something sits under a tie.
  const lower = [...byScore.entries()].find(([score]) => score < tiedScore);
  assert.ok(lower, "the candidate list should contain a score below the tie");

  const handles = [HANDLE, OTHER_HANDLE, `${words.adjectives[2]}-${words.verbs[2]}-${words.nouns[2]}`,
    `${words.adjectives[3]}-${words.verbs[3]}-${words.nouns[3]}`];
  const sent = [tied[0], tied[1], higher[1][0], lower[1][0]].map((name, index) => submission(name, handles[index]));
  for (const body of sent) assert.equal((await post(url, body)).status, 201);
  // Receipts are read after every entry has landed. A receipt issued while an
  // entry was still alone on the board would say rank 1 whatever the rule is.
  const receipts = [];
  for (const body of sent) receipts.push(await (await post(url, body)).json());
  assert.equal(receipts[0].rank, receipts[1].rank, "a tie is one rank, not two");
  assert.equal(receipts[0].rank, 2, "both tied drinks sit one place below the higher score");
  assert.equal(receipts[2].rank, 1);
  assert.equal(receipts[3].rank, 4, "the next drink after a two-way tie at 2 is 4th, as at the booth");
  const expected = leaderboard(await store.list());
  assert.deepEqual((await board(url)).entries, expected.map(({ handle, name, rank, score }) => ({ handle, name, rank, score })),
    "the public board ranks exactly as the booth's own leaderboard()");
});

test("the board shows a window, the true total, and an attendee's own place", async t => {
  const { url, store } = await service(t);
  let mine;
  for (let index = 0; index < 25; index += 1) {
    const { token, ...entry } = submission(`Mona Test ${index} Mocha`);
    await store.create({ ...entry, createdAt: "2026-01-01T00:00:00Z", tokenHash: tokenHashOf(token) });
    if (index === 24) mine = { ref: publicRef(tokenHashOf(token)), name: entry.name };
  }
  const full = await board(url);
  assert.equal(full.entries.length, 20);
  assert.equal(full.total, 25);
  assert.ok(!Number.isNaN(Date.parse(full.asOf)), "the board says when it was read");
  assert.deepEqual(Object.keys(full.entries[0]).sort(), ["handle", "name", "rank", "score"],
    "no ID, timestamp, or anything else beyond what the board shows");
  const you = (await board(url, `?handle=${HANDLE}&ref=${mine.ref}`)).you;
  assert.deepEqual([you.handle, you.name], [HANDLE, mine.name], "found by its reference, even outside the top 20");
  assert.ok(you.rank > 0);
  assert.equal((await board(url, `?handle=${OTHER_HANDLE}&ref=${mine.ref}`)).you, null, "the wrong handle does not match");
  assert.equal((await board(url, "?handle=<script>")).you, null);
});

// --- The page ---------------------------------------------------------------

test("the page ships with a strict policy and nothing it would have to relax it for", async t => {
  const { url } = await service(t);
  const page = await fetch(`${url}/`);
  assert.equal(page.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
  assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'(;|$)/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  const html = await page.text();
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, "no inline script");
  assert.doesNotMatch(html, /<style|\sstyle=/i, "no inline style");
  for (const path of ["/board.js", "/board.css", "/fonts/MonaSansVF.woff2", "/fonts/OFL.txt"]) {
    assert.equal((await fetch(`${url}${path}`)).status, 200, `${path} is served`);
  }
  assert.equal((await fetch(`${url}/api/board`)).headers.get("cache-control"), "no-store");
  assert.equal((await fetch(`${url}/../booth/local-config.json`)).status, 404, "only listed files are served");
});

test("HEAD answers like GET, because the QR generator checks the destination with HEAD", async t => {
  const { url } = await service(t);
  // verifyPublicUrl (services/public-url.mjs) sends an unauthenticated HEAD
  // and refuses to encode a destination that does not answer it. This was
  // found against the live deployment, where HEAD / returned 404.
  const page = await fetch(`${url}/`, { method: "HEAD" });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
  assert.equal(await page.text(), "", "a HEAD response carries no body");
  const api = await fetch(`${url}/api/board`, { method: "HEAD" });
  assert.equal(api.status, 200);
  assert.equal(await api.text(), "");
  assert.equal((await fetch(`${url}/healthz`, { method: "HEAD" })).status, 200);
  assert.equal((await fetch(`${url}/api/entries/x`, { method: "HEAD" })).status, 404, "HEAD never reaches a write route");
});

test("the page never parses attendee text as HTML and carries no mascot art", async () => {
  const script = await readFile(new URL("../leaderboard-service/public/board.js", import.meta.url), "utf8");
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  // The mascot is not cleared for publication (see .github/images/README.md),
  // and this page is public. Adding it belongs to brand sign-off, not here.
  for (const file of ["index.html", "board.css", "board.js"]) {
    const text = await readFile(new URL(`../leaderboard-service/public/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /mona\.png|\.png|\.svg|<img/i, `${file} must not carry artwork`);
  }
});

// --- Startup and health -----------------------------------------------------

test("the service refuses to start with weak or shared keys", () => {
  const base = { reservationKey: RESERVATION_KEY, rules, store: new MemoryStore(), words };
  assert.throws(() => createApp({ ...base, boothKey: "short", staffKey: STAFF_KEY }), /at least 32/);
  assert.throws(() => createApp({ ...base, boothKey: BOOTH_KEY, staffKey: undefined }), /at least 32/);
  assert.throws(() => createApp({ ...base, boothKey: BOOTH_KEY, staffKey: BOOTH_KEY }), /must differ/);
  assert.throws(() => createApp({ ...base, boothKey: BOOTH_KEY, reservationKey: "", staffKey: STAFF_KEY }), /reservation key/);
});

test("health reports whether moderation is still the placeholder", async t => {
  const placeholder = { ...rules, blocklist: (await loadNameRules()).blocklist };
  const shipped = await service(t, { serviceRules: placeholder });
  assert.deepEqual(await (await fetch(`${shipped.url}/healthz`)).json(), { moderation: "placeholder", ok: true });
  const approved = await service(t);
  assert.equal((await (await fetch(`${approved.url}/healthz`)).json()).moderation, "reviewed");
});

test("curated handles are recognised, including the collision suffix", () => {
  assert.ok(handleIsCurated(HANDLE, words));
  assert.ok(handleIsCurated(`${HANDLE}-0a1b2c3d`, words));
  assert.ok(!handleIsCurated(`${HANDLE}-zzzzzzzz`, words));
  assert.ok(!handleIsCurated("sneaky", words));
  assert.ok(!handleIsCurated(null, words));
});

// --- The file store ---------------------------------------------------------

async function tempDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "sip-board-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

// A board the service creates from nothing starts closed, for rebuilds (see
// review round 36). Tests about everything else open it, as staff would.
const openStore = async options => {
  const store = await FileStore.open(options);
  if ((await store.state()).closed) await store.openBoard();
  return store;
};

// The platform these tests run on, for the POSIX permission checks, which run
// the platform's own tools (ls, chmod) rather than a stand-in.
const POSIX = process.platform;
// A reservation as the service stores it: a 64-hex HMAC-SHA256 fingerprint.
const fp = label => createHash("sha256").update(label).digest("hex");
// Each row its own handle, as the service guarantees: the phrase plus a suffix from the ID.
const entry = (id, score = 1000) => ({ createdAt: "2026-01-01T00:00:00Z", handle: `${HANDLE}-${fp(id).slice(0, 8)}`, id, name: id, score });

test("the file store survives a restart and never overwrites on create", async t => {
  const directory = await tempDirectory(t);
  const store = await openStore({ directory, event: "event-2026" });
  await store.create(entry("mona-a"));
  await store.create(entry("mona-b"));
  await assert.rejects(() => store.create(entry("mona-a", 9)), ConflictError);
  assert.equal(await store.retract("mona-b", fp("b")), true);
  assert.equal(await store.retract("mona-b", fp("b")), false);
  assert.equal(await store.isReserved(fp("b")), true);
  const reopened = await openStore({ directory, event: "event-2026" });
  assert.deepEqual(await reopened.list(), [entry("mona-a")], "what was written is what comes back");
  assert.equal(await reopened.isReserved(fp("b")), true, "a reservation survives a restart");
  assert.deepEqual(await (await openStore({ directory, event: "other" })).list(), [],
    "a new EVENT_ID starts a new board");
});

test("concurrent writes are serialised and none is lost", async t => {
  const directory = await tempDirectory(t);
  const store = await openStore({ directory });
  const ids = Array.from({ length: 30 }, (_, index) => `mona-${index}`);
  await Promise.all(ids.map(id => store.create(entry(id))));
  await Promise.all(ids.slice(0, 10).map(id => store.retract(id, fp(id))));
  const reopened = await openStore({ directory });
  assert.deepEqual((await reopened.list()).map(item => item.id).sort(), ids.slice(10).sort());
  assert.equal((await Promise.all(ids.slice(0, 10).map(id => reopened.isReserved(fp(id))))).every(Boolean), true);
});

test("an unreadable board is left alone and the service refuses to start", async t => {
  const directory = await tempDirectory(t);
  const file = join(directory, "default.json");
  await writeFile(file, "{ torn");
  await assert.rejects(() => openStore({ directory }), /not a readable board/);
  assert.equal(await readFile(file, "utf8"), "{ torn", "starting empty would overwrite it on the next submission");
});

test("the event ID cannot walk out of the data directory", async t => {
  const directory = await tempDirectory(t);
  for (const event of ["../escape", "a/b", "UPPER", "", "x".repeat(64)]) {
    await assert.rejects(() => openStore({ directory, event }), /EVENT_ID/, JSON.stringify(event));
  }
});

// --- Takedown reaching the public board -------------------------------------

async function engineWith(t, client) {
  const directory = await mkdtemp(join(tmpdir(), "sip-lb-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const store = new RunStore(directory);
  return { engine: new BoothEngine({ catalog, leaderboardClient: client, rules, store }), store };
}

test("a takedown during an in-flight publish still leaves the board clean", async t => {
  let release;
  let onWire;
  const gate = new Promise(resolve => { release = resolve; });
  const inFlight = new Promise(resolve => { onWire = resolve; });
  const retracted = [];
  const client = {
    async publish(sent) {
      onWire();
      await gate;
      return { ...sent, entries: 1, rank: 1 };
    },
    async retract(id) { retracted.push(id); return "retracted"; },
  };
  const { engine } = await engineWith(t, client);
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  const publishing = engine.publish("booth-1");
  // Wait until the submission is genuinely on the wire. Removing any earlier
  // would make publish() find no entry and return, and the test would prove
  // nothing about the race.
  await inFlight;
  // Staff act while the submission is still on the wire. Their retraction
  // finds nothing, and then the submission lands.
  await engine.removeDrink({ id: served.submission.id, reason: "test", removedBy: "lead" });
  release();
  await publishing;
  assert.deepEqual(retracted, [served.submission.id, served.submission.id],
    "the late receipt proves the entry landed, so it is retracted again");
});

test("a takedown that cannot reach the board is recorded and retried", async t => {
  let up = false;
  const client = {
    async publish(sent) { return { ...sent, entries: 1, rank: 1 }; },
    async retract() { if (!up) throw new Error("offline"); return "retracted"; },
  };
  const { engine, store } = await engineWith(t, client);
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  const record = await engine.removeDrink({ id: served.submission.id, reason: "test", removedBy: "lead" });
  assert.equal(record.published, "failed", "a failed retraction must not read as done");
  assert.ok(!(await store.read()).menu.some(entry => entry.id === served.submission.id),
    "the local takedown never depends on the network");
  up = true;
  assert.deepEqual(await engine.retryRetractions(), [{ id: served.submission.id, published: "retracted" }]);
  assert.deepEqual(await engine.retryRetractions(), [], "nothing is retried once it has landed");
});

test("the staff dashboard reports a missed takedown and retries it on refresh", async t => {
  let up = false;
  const client = {
    async publish(sent) { return { ...sent, entries: 1, rank: 1 }; },
    async retract() { if (!up) throw new Error("offline"); return "retracted"; },
  };
  const { engine } = await engineWith(t, client);
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  const panel = new AdminPanel(engine);
  const removed = await panel.dispatch("remove_drink", { id: served.submission.id, reason: "test", removedBy: "lead" });
  assert.equal(removed.notice.published, "failed", "the dashboard must not say a missed takedown is done");
  up = true;
  const refreshed = await panel.dispatch("refresh", {});
  assert.equal(refreshed.removals.find(record => record.id === served.submission.id).published, "retracted",
    "refresh is where a missed takedown is retried");
});

test("a booth rebuilds its part of a lost board, including drinks served before it was configured", async t => {
  const directory = await tempDirectory(t);
  const runs = new RunStore(directory);
  const offline = new BoothEngine({ catalog, rules, store: runs });
  for (const [runId, name] of [["booth-1", "Mona Moonrise Mocha"], ["booth-2", "Ducky Dawn Drizzle"], ["booth-3", "Copilot Cinder Crema"]]) {
    await offline.open({ runId });
    await offline.dispatch(runId, "submit_name", { name });
  }
  await offline.removeDrink({ id: "copilot-cinder-crema", reason: "test", removedBy: "lead" });
  assert.equal((await runs.read()).runs["booth-1"].sync.state, "disabled", "served while unconfigured");

  const first = await service(t);
  const online = new BoothEngine({ catalog, rules, store: runs,
    leaderboardClient: createLeaderboardClient({ boothKey: BOOTH_KEY, staffKey: STAFF_KEY, url: first.url }) });
  const { drinks: results } = await online.republishAll();
  assert.deepEqual(results.map(result => result.state), ["confirmed", "confirmed"]);
  assert.deepEqual((await board(first.url)).entries.map(row => row.name).sort(), ["Ducky Dawn Drizzle", "Mona Moonrise Mocha"],
    "a removed drink is never republished");
  assert.equal((await online.republishAll()).drinks.every(result => result.state === "confirmed"), true, "running it twice is harmless");

  // The service loses everything. The booth still has the authoritative copy.
  const replacement = await service(t);
  // Without the staff key the takedown cannot be reserved again, so nothing is sent.
  const boothOnly = new BoothEngine({ catalog, rules, store: runs,
    leaderboardClient: createLeaderboardClient({ boothKey: BOOTH_KEY, url: replacement.url }) });
  assert.equal((await boothOnly.republishAll()).blocked, true);
  assert.equal((await board(replacement.url)).total, 0);
  const rebuilt = new BoothEngine({ catalog, rules, store: runs,
    leaderboardClient: createLeaderboardClient({ boothKey: BOOTH_KEY, staffKey: STAFF_KEY, url: replacement.url }) });
  await rebuilt.republishAll();
  assert.equal((await board(replacement.url)).total, 2);
});

test("a booth without a staff key says the takedown did not reach the board", async t => {
  const client = createLeaderboardClient({ boothKey: BOOTH_KEY, url: "https://leaderboard.example.org" });
  assert.equal(client.retract, undefined);
  const { engine } = await engineWith(t, client);
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  const record = await engine.removeDrink({ id: served.submission.id, reason: "test", removedBy: "lead" });
  assert.equal(record.published, "not-configured");
});

// --- Booth configuration ----------------------------------------------------

test("the booth only publishes to a public HTTPS service with real keys", () => {
  const good = { boothKey: BOOTH_KEY, staffKey: STAFF_KEY, url: "https://commit-and-sip.azurewebsites.net" };
  assert.deepEqual(validateLeaderboardApi(good), good);
  assert.deepEqual(validateLeaderboardApi({ boothKey: BOOTH_KEY, url: good.url }).staffKey, undefined,
    "a booth may be configured to publish without being able to delete");
  for (const [bad, label] of [
    [{ ...good, url: "http://commit-and-sip.azurewebsites.net" }, "plain HTTP"],
    [{ ...good, url: "https://127.0.0.1" }, "loopback"],
    [{ ...good, url: "https://10.0.0.5" }, "a private address"],
    [{ ...good, boothKey: "short" }, "a short booth key"],
    [{ ...good, staffKey: "short" }, "a short staff key"],
    [{ ...good, staffKey: BOOTH_KEY }, "one key for both roles"],
    [{ ...good, extra: 1 }, "an unknown setting"],
  ]) {
    assert.throws(() => validateLeaderboardApi(bad), { code: "invalid_config" }, label);
  }
  assert.equal(leaderboardClientFromConfig({}), null, "no leaderboardApi, no client");
  assert.throws(() => leaderboardClientFromConfig({ leaderboardApi: { ...good, url: "https://localhost" } }),
    { code: "invalid_config" }, "the production client applies the same validation");
});

test("a booth submission is exactly what the service accepts", () => {
  const entry = { handle: HANDLE, id: "mona-moonrise-mocha", name: "Mona Moonrise Mocha", runId: "r", score: 1 };
  assert.deepEqual(Object.keys(submissionFor(entry, newPublicationToken())).sort(), ["handle", "id", "name", "score", "token"],
    "the booth sends the five fields the service's shape check requires, and no run ID");
  assert.throws(() => submissionFor(entry), { code: "invalid_submission" }, "never without its publication token");
});

// --- Packaging --------------------------------------------------------------

test("the deploy package carries what the service reads and never the staff secrets", async () => {
  const { NEVER_PACKAGE, packageManifest } = await import("../scripts/package-leaderboard.mjs");
  const manifest = await packageManifest();
  for (const required of [
    "leaderboard-service/server.mjs", "leaderboard-service/app.mjs", "leaderboard-service/store.mjs",
    "leaderboard-service/public/index.html", "leaderboard-service/public/board.js", "leaderboard-service/public/board.css",
    ".github/extensions/commit-and-sip/services/name-score.mjs", ".github/extensions/commit-and-sip/services/moderation.mjs",
    ".github/extensions/commit-and-sip/services/booth-menu.mjs", ".github/extensions/commit-and-sip/domain.mjs",
    "booth/name-rules.json", "booth/blocked-terms.json", "booth/handle-words.json",
    ".github/extensions/commit-and-sip/renderer/fonts/MonaSansVF.woff2",
    ".github/extensions/commit-and-sip/renderer/fonts/OFL.txt",
  ]) {
    assert.ok(manifest.includes(required), `${required} must be packaged`);
  }
  // The staff config holds both API keys. It is referenced by a shared module
  // the service imports, so a graph walk would find it without this guard.
  assert.deepEqual(NEVER_PACKAGE, ["booth/local-config.json"]);
  assert.ok(!manifest.some(file => file.includes("local-config")), "the staff secrets are never packaged");
  assert.ok(!manifest.some(file => file.endsWith("mona.png")), "unapproved mascot art is not published");
  assert.ok(!manifest.some(file => file.includes("extension.mjs") || file.includes("canvas")),
    "the canvas extension itself is not deployed");
});

// --- Configuring a booth ----------------------------------------------------

test("configuring keeps one set of keys, keeps them private, and never sets the QR", async t => {
  const { configure, parseArguments } = await import("../scripts/configure-leaderboard.mjs");
  const { stat } = await import("node:fs/promises");
  const directory = await tempDirectory(t);
  const configFile = join(directory, "local-config.json");
  const parametersFile = join(directory, "dist", "secure.parameters.json");
  const url = "https://commit-and-sip-leaderboard.azurewebsites.net";

  const first = await configure({ configFile, parametersFile, url });
  assert.deepEqual(first.generated, ["boothKey", "staffKey"]);
  const saved = JSON.parse(await readFile(configFile, "utf8"));
  assert.match(saved.leaderboardApi.boothKey, /^[0-9a-f]{64}$/);
  assert.notEqual(saved.leaderboardApi.boothKey, saved.leaderboardApi.staffKey);
  assert.equal(saved.leaderboardUrl, undefined, "the attendee QR waits for moderation and brand review");
  const parameters = JSON.parse(await readFile(parametersFile, "utf8")).parameters;
  assert.deepEqual([parameters.boothKey.value, parameters.staffKey.value],
    [saved.leaderboardApi.boothKey, saved.leaderboardApi.staffKey], "the deployment uses the booth's own keys");
  for (const file of [configFile, parametersFile]) {
    assert.equal((await stat(file)).mode & 0o777, 0o600, `${file} is readable by this user only`);
  }

  // Re-running must not rotate the keys out from under a deployed service.
  const again = await configure({ configFile, parametersFile, url });
  assert.deepEqual(again.generated, []);
  assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")).leaderboardApi, saved.leaderboardApi);

  // A booth machine that should publish but not delete: never with a booth key
  // of its own, which the deployed service would refuse, but with the deployed one.
  await assert.rejects(() => configure({ configFile: join(directory, "booth.json"), staff: false, url }),
    /must use the deployed keys.*Nothing was written/);
  await assert.rejects(() => readFile(join(directory, "booth.json")), { code: "ENOENT" });
  const boothOnly = await configure({ configFile: join(directory, "booth.json"), from: configFile, staff: false, url });
  assert.equal(boothOnly.next.leaderboardApi.boothKey, saved.leaderboardApi.boothKey);
  assert.equal(boothOnly.next.leaderboardApi.staffKey, undefined);
  // Promoted to a staff machine: never by minting a staff key, which the
  // service would refuse. It copies the deployed keys from a staff machine.
  await assert.rejects(() => configure({ configFile: join(directory, "booth.json"), url }), /would not match the deployed service/);
  const promoted = await configure({ configFile: join(directory, "booth.json"), from: configFile, url });
  assert.deepEqual(promoted.generated, []);
  assert.equal(promoted.next.leaderboardApi.staffKey, saved.leaderboardApi.staffKey, "the staff key the service already accepts");

  // Other staff settings survive, and an existing QR is left exactly as it was.
  await writeFile(join(directory, "kept.json"), JSON.stringify({ leaderboardUrl: "https://example.org/board" }));
  const kept = await configure({ configFile: join(directory, "kept.json"), url });
  assert.equal(kept.next.leaderboardUrl, "https://example.org/board");

  await assert.rejects(() => configure({ configFile, url: "http://insecure.example.org" }), { code: "invalid_config" });
  assert.throws(() => parseArguments([]), /Usage/);
  assert.deepEqual(parseArguments(["--url", url, "--no-staff-key"]), { from: null, parameters: false, staff: false, url });
  assert.equal(parseArguments(["--url", url, "--from", "/tmp/staff.json"]).from, "/tmp/staff.json");
  assert.throws(() => parseArguments(["--url", url, "--from"]), /--from needs a value/);
});

test("the infrastructure keeps secrets out of the repository and one writer on the board", async () => {
  const main = await readFile(new URL("../infra/main.bicep", import.meta.url), "utf8");
  const app = await readFile(new URL("../infra/modules/app.bicep", import.meta.url), "utf8");
  const parameters = await readFile(new URL("../infra/main.parameters.json", import.meta.url), "utf8");
  for (const name of ["boothKey", "staffKey"]) {
    assert.match(main, new RegExp(`@secure\\(\\)\\s*\\n(?:@[^\\n]*\\n)*param ${name} string`), `${name} is a secure parameter`);
    assert.doesNotMatch(parameters, new RegExp(name), `${name} is never in the committed parameters`);
  }
  assert.match(app, /capacity: 1\b/, "one instance is all a booth needs");
  // Defence in depth only: it covers recycling within one VM. The store's lock
  // and version check are what keep a second instance from losing writes.
  assert.match(app, /WEBSITE_DISABLE_OVERLAPPED_RECYCLING', value: '1'/, "overlapped recycling stays off");
  assert.match(app, /alwaysOn: true/);
  assert.match(app, /httpsOnly: true/);
  assert.match(app, /remoteDebuggingEnabled: false/);
  assert.match(app, /clientCertEnabled: false/, "phones scanning a public board hold no client certificate");
  assert.match(app, /name: 'scm'\s*\n\s*properties: \{\s*\n\s*allow: false/, "no basic-auth deployment credentials");
  assert.doesNotMatch(main + app, /storageAccounts|roleAssignments/, "the plan needs neither storage keys nor a role grant");
  assert.match(main, /data_classification: 'public'/);
  const ignored = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(ignored, /^dist\/$/m, "the secure deployment parameters are written under an ignored directory");
  assert.match(ignored, /^booth\/local-config\.json$/m);
});

// --- Review round 1 ----------------------------------------------------------

test("a takedown queued behind another write still stops a concurrent submission", async t => {
  // The write queue is held shut so the retraction is still pending when the
  // submission arrives. Checking the reservation outside the queue would see
  // "not reserved" and write the entry after the retraction lands.
  const directory = await tempDirectory(t);
  let open;
  const gate = new Promise(resolve => { open = resolve; });
  // Resolves once the nth write has entered the queue. The test waits on these
  // events rather than on elapsed time, so a slow machine cannot reorder them.
  let queued = 0;
  const waiting = [];
  const whenQueued = count => new Promise(resolve => waiting.push({ count, resolve }));
  class GatedStore extends FileStore {
    serialise(change) {
      queued += 1;
      for (const waiter of waiting.filter(item => item.count <= queued)) waiter.resolve();
      return super.serialise(async () => { await gate; return change(); });
    }
  }
  const store = Object.setPrototypeOf(await openStore({ directory }), GatedStore.prototype);
  const app = createApp({ boothKey: BOOTH_KEY, reservationKey: RESERVATION_KEY, rules, staffKey: STAFF_KEY, store, words });
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;

  const sent = submission("Mona Moonrise Mocha");
  const firstQueued = whenQueued(1);
  const retraction = del(url, sent.id);
  await firstQueued;                         // the retraction is in the queue, not yet applied
  const secondQueued = whenQueued(2);
  const publication = post(url, submission("Mona Moonrise Mocha", OTHER_HANDLE));
  await secondQueued;                        // and the submission is queued behind it
  open();
  assert.deepEqual(await (await retraction).json(), { retraction: "absent" });
  const published = await publication;
  assert.equal(published.status, 409, "the submission must see the reservation queued ahead of it");
  assert.equal((await published.json()).error, "unavailable_drink");
  assert.equal((await board(url)).total, 0);
});

test("a failed write leaves memory exactly as it was on disk", async t => {
  const directory = await tempDirectory(t);
  const store = await openStore({ directory });
  await store.create(entry("mona-kept"));
  // The disk refuses the write after the change has been applied in memory,
  // which is the moment a rollback has to happen.
  let full = true;
  const persist = store.persist.bind(store);
  store.persist = text => (full ? Promise.reject(Object.assign(new Error("disk full"), { code: "ENOSPC" })) : persist(text));
  await assert.rejects(() => store.admit(entry("mona-lost"), { fingerprint: "fp", handles: [OTHER_HANDLE] }), { code: "ENOSPC" });
  await assert.rejects(() => store.retract("mona-kept", fp("kept")), { code: "ENOSPC" });
  const inMemory = await MemoryStore.prototype.list.call(store);
  assert.deepEqual(inMemory.map(item => item.id), ["mona-kept"], "the failed admission is not left in memory");
  assert.equal(await MemoryStore.prototype.isReserved.call(store, fp("kept")), false, "nor the failed reservation");
  assert.deepEqual((await store.list()).map(item => item.id), ["mona-kept"], "and the board served is what the disk holds");
  // Once the disk recovers, a retry is a fresh admission, not a false "already there".
  full = false;
  assert.equal((await store.admit(entry("mona-lost"), { fingerprint: "fp", handles: [OTHER_HANDLE] })).created, true);
  assert.deepEqual((await (await openStore({ directory })).list()).map(item => item.id).sort(), ["mona-kept", "mona-lost"]);
});

test("two booths that issued the same handle each get a distinct place on the board", async t => {
  const { url } = await service(t);
  const { canonicalHandle } = await import("../.github/extensions/commit-and-sip/services/leaderboard.mjs");
  const first = submission("Mona Moonrise Mocha", HANDLE);
  const second = submission("Ducky Dawn Drizzle", HANDLE);   // same phrase, another booth
  const firstReceipt = await (await post(url, first)).json();
  const secondResponse = await post(url, second);
  assert.equal(secondResponse.status, 201);
  const secondReceipt = await secondResponse.json();
  assert.equal(firstReceipt.handle, HANDLE, "the first keeps the phrase");
  assert.equal(secondReceipt.handle, canonicalHandle(HANDLE, second.id), "the second gets the deterministic suffix");
  assert.equal(validateReceipt(secondReceipt, second).handle, secondReceipt.handle, "and the booth accepts exactly that");
  assert.throws(() => validateReceipt({ ...secondReceipt, handle: `${HANDLE}-00000000` }, second),
    { code: "receipt_mismatch" }, "but no other suffix");
  // A retry lands on the same canonical handle rather than a clash.
  const retried = await post(url, second);
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).handle, secondReceipt.handle);

  const handles = (await board(url)).entries.map(row => row.handle);
  assert.equal(new Set(handles).size, handles.length, "no two rows share a handle");
  // Each phone finds its own drink, including a QR scanned before confirmation
  // that still carries the phrase the booth issued.
  const refOf = sent => publicRef(tokenHashOf(sent.token));
  assert.equal((await board(url, `?handle=${HANDLE}&ref=${refOf(first)}`)).you.name, first.name);
  assert.equal((await board(url, `?handle=${HANDLE}&ref=${refOf(second)}`)).you.name, second.name);
  assert.equal((await board(url, `?handle=${secondReceipt.handle}&ref=${refOf(second)}`)).you.name, second.name);
  assert.equal((await board(url, `?handle=${HANDLE}&ref=0000000000000000`)).you, null);
  assert.equal((await board(url, `?handle=${HANDLE}`)).you, null, "a handle alone identifies nobody");
});

test("the attendee is told when the board shows them under a different handle", async () => {
  const { syncView, canonicalHandle } = await import("../.github/extensions/commit-and-sip/services/leaderboard.mjs");
  const receipt = { entries: 2, handle: canonicalHandle(HANDLE, "mona-x"), rank: 1, score: 1 };
  assert.match(syncView({ receipt, state: "confirmed" }, HANDLE).message, new RegExp(`shows you as ${receipt.handle}`));
  assert.doesNotMatch(syncView({ receipt: { ...receipt, handle: HANDLE }, state: "confirmed" }, HANDLE).message, /shows you as/);
});

test("the store never lets two entries share a handle, even under the suffix", async () => {
  const { HandleTakenError } = await import("../leaderboard-service/store.mjs");
  const store = new MemoryStore();
  await store.admit(entry("mona-a"), { fingerprint: "a", handles: ["h", "h-1"] });
  assert.equal((await store.admit(entry("mona-b"), { fingerprint: "b", handles: ["h", "h-1"] })).entry.handle, "h-1");
  await assert.rejects(() => store.admit(entry("mona-c"), { fingerprint: "c", handles: ["h", "h-1"] }), HandleTakenError);
});

test("the board highlights only the attendee's own row, not every row sharing a phrase", async () => {
  const script = await readFile(new URL("../leaderboard-service/public/board.js", import.meta.url), "utf8");
  assert.doesNotMatch(script, /entry\.handle === handle\b/, "matching on the handle parameter alone highlights strangers");
  assert.match(script, /board\.you/);
});

test("a takedown with no recorded outcome, or made before a staff key existed, is retried", async t => {
  let canRetract = false;
  const client = { async publish(sent) { return { ...sent, entries: 1, rank: 1 }; } };
  const { engine, store } = await engineWith(t, client);
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  const record = await engine.removeDrink({ id: served.submission.id, reason: "test", removedBy: "lead" });
  assert.equal(record.published, "not-configured");

  // A booth that cannot retract has nothing to try and must not rewrite the
  // ledger on every dashboard refresh.
  const transactions = [];
  const original = store.transaction.bind(store);
  store.transaction = change => { transactions.push(1); return original(change); };
  assert.deepEqual(await engine.retryRetractions(), []);
  assert.equal(transactions.length, 0);

  // A staff key is added later.
  client.retract = async () => { if (!canRetract) throw new Error("offline"); return "retracted"; };
  canRetract = true;
  assert.deepEqual(await engine.retryRetractions(), [{ id: served.submission.id, published: "retracted" }]);

  // The process stopped after the local removal, before recording anything.
  await engine.open({ runId: "booth-2" });
  const second = await engine.dispatch("booth-2", "submit_name", { name: "Ducky Dawn Drizzle" });
  await original(data => {
    data.menu.splice(data.menu.findIndex(item => item.id === second.submission.id), 1);
    data.removals.push({ handle: second.handle, id: second.submission.id, name: second.submission.name,
      reason: "test", removedAt: "2026-01-01T00:00:00Z", removedBy: "lead" });
  });
  assert.deepEqual(await engine.retryRetractions(), [{ id: second.submission.id, published: "retracted" }],
    "a removal whose outcome was never recorded is still owed a retraction");
  assert.deepEqual(await engine.retryRetractions(), [], "settled takedowns are not retried");
});

test("rebuilding a lost board restores its reservations before any drink", async t => {
  const first = await service(t);
  const directory = await tempDirectory(t);
  const runs = new RunStore(directory);
  const boothClient = url => createLeaderboardClient({ boothKey: BOOTH_KEY, staffKey: STAFF_KEY, url });
  const engine = new BoothEngine({ catalog, rules, store: runs, leaderboardClient: boothClient(first.url) });
  await engine.open({ runId: "booth-1" });
  const kept = await engine.dispatch("booth-1", "submit_name", { name: "Ducky Dawn Drizzle" });
  await engine.publish("booth-1");
  await engine.open({ runId: "booth-2" });
  const removed = await engine.dispatch("booth-2", "submit_name", { name: "Mona Moonrise Mocha" });
  await engine.publish("booth-2");
  await engine.removeDrink({ id: removed.submission.id, reason: "test", removedBy: "lead" });

  // The service loses everything, reservations included.
  const replacement = await service(t);
  const rebuilt = new BoothEngine({ catalog, rules, store: runs, leaderboardClient: boothClient(replacement.url) });
  const { drinks, removals } = await rebuilt.republishAll();
  assert.deepEqual(removals, [{ id: removed.submission.id, published: "absent" }]);
  assert.deepEqual(drinks.map(result => result.name), [kept.submission.name]);
  const retyped = await post(replacement.url, submission("Mona Moonrise Mocha", OTHER_HANDLE));
  assert.equal(retyped.status, 409, "a name taken down before the loss is still refused after the rebuild");
  assert.equal((await rebuilt.store.read()).removals[0].published, "absent",
    "the record now says what the replay found on the current board, and it is settled");

  // A booth without a staff key cannot restore reservations, and says so.
  const boothOnly = new BoothEngine({ catalog, rules, store: runs,
    leaderboardClient: createLeaderboardClient({ boothKey: BOOTH_KEY, url: replacement.url }) });
  const unreserved = await boothOnly.republishAll();
  assert.deepEqual(unreserved.removals, [{ id: removed.submission.id, published: "not-configured" }]);
  assert.equal(unreserved.blocked, true, "a rebuild that cannot reserve takedowns sends no drink");
  assert.deepEqual(unreserved.drinks, []);
});

// --- Review round 2 ----------------------------------------------------------

test("a different attendee with the same handle and the same name is not mistaken for a retry", async t => {
  const { url } = await service(t);
  const first = submission("Mona Moonrise Mocha", HANDLE);
  const lookalike = submission("Mona Moonrise Mocha", HANDLE);    // another booth, another attendee
  assert.notEqual(first.token, lookalike.token);
  assert.equal((await post(url, first)).status, 201);
  const clash = await post(url, lookalike);
  assert.equal(clash.status, 409, "public fields match, but it is not the same publication");
  assert.equal((await clash.json()).error, "duplicate_drink");
  assert.equal((await post(url, first)).status, 200, "a genuine retry still succeeds");
  const { token, ...noToken } = first;
  assert.equal((await post(url, noToken)).status, 400, "no token, no submission");
  assert.equal((await post(url, { ...first, token: "not-a-token" })).status, 400);
});

test("the token is saved before the first send and reused on every retry", async t => {
  const sent = [];
  let attempt = 0;
  let engine;
  const client = {
    async publish(submission) {
      const saved = (await engine.store.read()).runs["booth-1"].sync.token;
      sent.push({ saved, token: submission.token });
      attempt += 1;
      if (attempt === 1) throw new Error("network dropped the response");
      return { ...submission, entries: 1, rank: 1 };
    },
  };
  ({ engine } = await engineWith(t, client));
  await engine.open({ runId: "booth-1" });
  await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  await engine.publish("booth-1");
  await engine.publish("booth-1");
  assert.equal(sent[0].saved, sent[0].token, "persisted before it left the booth");
  assert.equal(sent[1].token, sent[0].token, "the retry is the same publication");
  assert.equal((await engine.store.read()).runs["booth-1"].sync.state, "confirmed");
});

test("the stored board keeps only a hash of the publication token", async t => {
  const directory = await tempDirectory(t);
  const store = await openStore({ directory });
  const app = createApp({ boothKey: BOOTH_KEY, reservationKey: RESERVATION_KEY, rules, staffKey: STAFF_KEY, store, words });
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const sent = submission("Mona Moonrise Mocha");
  await post(`http://127.0.0.1:${server.address().port}`, sent);
  const saved = await readFile(join(directory, "default.json"), "utf8");
  assert.ok(!saved.includes(sent.token), "the raw token is never stored");
  assert.match(JSON.parse(saved).entries[0].tokenHash, /^[0-9a-f]{64}$/);
  const row = (await board(`http://127.0.0.1:${server.address().port}`)).entries[0];
  assert.deepEqual(Object.keys(row).sort(), ["handle", "name", "rank", "score"], "and never shows it");
});

test("the staff secrets are excluded whatever the platform's path separator", async () => {
  const { isNeverPackaged } = await import("../scripts/package-leaderboard.mjs");
  const path = await import("node:path");
  const windows = { paths: path.win32, root: "C:\\repo" };
  assert.equal(isNeverPackaged("C:\\repo\\booth\\local-config.json", windows), true);
  assert.equal(isNeverPackaged("C:\\repo\\booth\\..\\booth\\local-config.json", windows), true);
  assert.equal(isNeverPackaged("C:\\repo\\booth\\name-rules.json", windows), false);
  const posix = { paths: path.posix, root: "/repo" };
  assert.equal(isNeverPackaged("/repo/booth/local-config.json", posix), true);
  assert.equal(isNeverPackaged("/repo/booth/name-rules.json", posix), false);
});

test("a stalled network cannot pile up polls on the monitor", async () => {
  const script = await readFile(new URL("../leaderboard-service/public/board.js", import.meta.url), "utf8");
  assert.match(script, /AbortSignal\.timeout\(REQUEST_TIMEOUT_MS\)/, "every poll is bounded");
  assert.doesNotMatch(script, /setInterval\(refresh/, "a fixed interval keeps starting polls while earlier ones hang");
  assert.match(script, /setTimeout\(refresh, REFRESH_MS\)/, "the next poll is scheduled once this one settles");
});

test("screen readers hear transitions, not a clock every ten seconds", async () => {
  const html = await readFile(new URL("../leaderboard-service/public/index.html", import.meta.url), "utf8");
  const live = [...html.matchAll(/<[^>]+(?:aria-live|role="(?:status|alert|log)")[^>]*>/g)].map(match => match[0]);
  assert.deepEqual(live, ['<p id="announce" class="visually-hidden" aria-live="polite">'],
    "one live region, fed only by announce()");
  const script = await readFile(new URL("../leaderboard-service/public/board.js", import.meta.url), "utf8");
  assert.match(script, /if \(message === announced\) return;/, "a repeated message is not re-announced");
  assert.doesNotMatch(script, /announce\(`Updated/, "the routine timestamp is never announced");
});

// --- Review round 3 ----------------------------------------------------------

test("a refusal retrying cannot change is recorded as final and never resent", async t => {
  const { url } = await service(t);
  const { failedSync, syncView } = await import("../.github/extensions/commit-and-sip/services/leaderboard.mjs");
  assert.equal(failedSync({ attempts: 0 }, Object.assign(new Error("x"), { code: "duplicate_drink" })).state, "rejected");
  assert.equal(failedSync({ attempts: 0 }, Object.assign(new Error("x"), { code: "unavailable_drink" })).state, "rejected");
  assert.equal(failedSync({ attempts: 0 }, new Error("timeout")).state, "failed", "a transport failure stays retryable");
  assert.match(syncView({ state: "rejected" }).message, /did not accept this name/);

  // Booth A publishes first. Booth B's attendee drew the same handle and name.
  const directoryA = await tempDirectory(t);
  const directoryB = await tempDirectory(t);
  const client = serviceUrl => createLeaderboardClient({ boothKey: BOOTH_KEY, staffKey: STAFF_KEY, url: serviceUrl });
  const boothA = new BoothEngine({ catalog, rules, store: new RunStore(directoryA), leaderboardClient: client(url) });
  const boothB = new BoothEngine({ catalog, rules, store: new RunStore(directoryB), leaderboardClient: client(url) });
  const a = await boothA.open({ runId: "a-1" });
  await boothA.dispatch("a-1", "submit_name", { name: "Mona Moonrise Mocha" });
  await boothA.publish("a-1");
  await boothB.open({ runId: "b-1" });
  await boothB.store.transaction(data => { data.runs["b-1"].handle = a.handle; });   // the shared phrase
  await boothB.dispatch("b-1", "submit_name", { name: "Mona Moonrise Mocha" });
  await boothB.publish("b-1");
  const bSync = (await boothB.store.read()).runs["b-1"].sync;
  assert.deepEqual([bSync.state, bSync.code], ["rejected", "duplicate_drink"]);

  // Refreshing does not keep hammering the service with a refusal.
  let calls = 0;
  const counting = { ...client(url), async publish(submission) { calls += 1; return client(url).publish(submission); } };
  const boothBAgain = new BoothEngine({ catalog, rules, store: boothB.store, leaderboardClient: counting });
  await boothBAgain.dispatch("b-1", "refresh", {});
  assert.equal(calls, 0);

  // The service loses everything, and the losing booth happens to rebuild first.
  const lost = await service(t);
  const rebuildB = new BoothEngine({ catalog, rules, store: boothB.store, leaderboardClient: client(lost.url) });
  const rebuildA = new BoothEngine({ catalog, rules, store: boothA.store, leaderboardClient: client(lost.url) });
  assert.deepEqual((await rebuildB.republishAll()).drinks.map(result => result.state), ["rejected"],
    "the refused drink is held back, not resent");
  assert.deepEqual((await rebuildA.republishAll()).drinks.map(result => result.state), ["confirmed"]);
  const aToken = (await boothA.store.read()).runs["a-1"].sync.token;
  const owner = (await board(lost.url, `?handle=${a.handle}&ref=${publicRef(tokenHashOf(aToken))}`)).you;
  assert.equal(owner.handle, a.handle, "the attendee who legitimately held the name still holds it");
});

test("a read never sees a write that has not reached the disk", async t => {
  const directory = await tempDirectory(t);
  let land;
  const landed = new Promise(resolve => { land = resolve; });
  // The change is applied to memory, then held before the file is written.
  class SlowDisk extends FileStore {
    serialise(change) { return super.serialise(async () => { const result = await change(); await landed; return result; }); }
  }
  const store = Object.setPrototypeOf(await openStore({ directory }), SlowDisk.prototype);
  const admitting = store.admit(entry("mona-pending"), { fingerprint: "fp", handles: [HANDLE] });
  const pending = Symbol("pending");
  const tick = () => new Promise(resolve => setImmediate(() => resolve(pending)));
  assert.equal(await Promise.race([store.list(), tick()]), pending, "list waits for the write in progress");
  assert.equal(await Promise.race([store.get("mona-pending"), tick()]), pending);
  assert.equal(await Promise.race([store.isReserved("fp"), tick()]), pending);

  // The write then fails. The entry must never have been visible.
  store.persist = () => Promise.reject(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
  const reading = store.list();
  land();
  await assert.rejects(admitting, { code: "ENOSPC" });
  assert.deepEqual(await reading, [], "the entry that failed to persist was never shown");
});

test("retrying on a booth without a staff key does not claim nothing is waiting", async t => {
  const { retryReport } = await import("../scripts/remove-drink.mjs");
  const boothOnly = createLeaderboardClient({ boothKey: BOOTH_KEY, url: "https://leaderboard.example.org" });
  const { engine } = await engineWith(t, boothOnly);
  assert.deepEqual(await retryReport(engine), { exitCode: 0, text: "No takedowns are waiting to reach the public leaderboard.\n" });
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  await engine.removeDrink({ id: served.submission.id, reason: "test", removedBy: "lead" });
  const report = await retryReport(engine);
  assert.equal(report.exitCode, 1, "an outstanding public takedown is not a success");
  assert.match(report.text, new RegExp(`${served.submission.id}\\tNOT off the public leaderboard`));
  assert.match(report.text, /copy the deployed keys to this machine .*--from/, "the fix names this machine, which holds the removal");
  assert.doesNotMatch(report.text, /No takedowns are waiting/);
});

test("the highlighted row keeps every text colour above 4.5:1", async () => {
  const css = await readFile(new URL("../leaderboard-service/public/board.css", import.meta.url), "utf8");
  const token = name => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(css)[1];
  const luminance = hex => {
    const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
      .map(value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
  };
  assert.ok(contrast(token("accent-ink"), token("board")) < 4.5, "the green ink on the highlight is too faint, as reported");
  assert.match(css, /tr\.mine th, tr\.mine \.handle \{ color: var\(--text\); \}/, "so the highlighted row uses the text colour");
  assert.ok(contrast(token("text"), token("board")) >= 4.5);
});

// --- Review round 4 ----------------------------------------------------------
// Two FileStores on one directory stand in for two App Service instances on
// one /home share: separate processes, separate memory, one file.

test("two instances writing one board never lose each other's entries", async t => {
  const directory = await tempDirectory(t);
  const [a, b] = await Promise.all([openStore({ directory }), openStore({ directory })]);
  const ids = Array.from({ length: 24 }, (_, index) => `mona-${index}`);
  await Promise.all(ids.map((id, index) => (index % 2 ? a : b)
    .admit(entry(id), { fingerprint: fp(id), handles: [`${HANDLE}-${String(index).padStart(8, "0")}`] })));
  const fresh = await openStore({ directory });
  assert.deepEqual((await fresh.list()).map(item => item.id).sort(), [...ids].sort(), "every write from both instances survived");
  assert.equal((await a.list()).length, 24, "each instance reads what the other wrote");
  assert.equal((await b.get("mona-1")).id, "mona-1");
});

test("a takedown on one instance stops a submission arriving at the other", async t => {
  const directory = await tempDirectory(t);
  const [a, b] = await Promise.all([openStore({ directory }), openStore({ directory })]);
  await a.retract("mona-moonrise-mocha", fp("moonrise"));
  const { ReservedError } = await import("../leaderboard-service/store.mjs");
  await assert.rejects(() => b.admit(entry("mona-moonrise-mocha"), { fingerprint: fp("moonrise"), handles: [HANDLE] }), ReservedError);
  assert.equal(await b.isReserved(fp("moonrise")), true);
});

test("a lock left by a dead instance is taken over; a live one is waited for", async t => {
  const directory = await tempDirectory(t);
  const lock = join(directory, "default.json.lock");
  const store = await openStore({ directory, lockTimeoutMs: 150, staleLockMs: 1_000 });

  const live = JSON.stringify({ at: Date.now() + 60_000, owner: "live-instance" });
  await writeFile(lock, live);
  await assert.rejects(() => store.create(entry("mona-waited")), { code: "board_locked" });
  assert.equal(await readFile(lock, "utf8"), live, "another instance's live lock is never broken");

  await writeFile(lock, JSON.stringify({ at: Date.now() - 60_000, owner: "dead-instance" }));
  await store.create(entry("mona-after-crash"));
  assert.deepEqual((await store.list()).map(item => item.id), ["mona-after-crash"], "a dead instance's lock does not block the board");
  const { access } = await import("node:fs/promises");
  await assert.rejects(() => access(lock), { code: "ENOENT" }, "and the lock is released afterwards");
});

test("a holder whose lease was taken over cannot commit over the new holder", async t => {
  const directory = await tempDirectory(t);
  const lock = join(directory, "default.json.lock");
  const [a, b] = await Promise.all([openStore({ directory, staleLockMs: 60 }), openStore({ directory, staleLockMs: 60 })]);
  // A stalls long enough to lose its lease: no renewal while it is frozen.
  a.renewLease = () => async () => {};
  // The exact interleaving from the review: A has passed its version check
  // and is about to rename when B takes over the stale lease and commits.
  let stalled = false;
  const persist = a.persist.bind(a);
  a.persist = async (text, owner) => {
    if (!stalled) {
      stalled = true;
      // A's lease, unrenewed while A was frozen, is now past its time.
      const lease = JSON.parse(await readFile(lock, "utf8"));
      await writeFile(lock, JSON.stringify({ ...lease, at: Date.now() - 60_000 }));
      await b.create(entry("mona-from-b"));
    }
    return persist(text, owner);
  };
  await a.create(entry("mona-from-a"));
  const fresh = await openStore({ directory });
  assert.deepEqual((await fresh.list()).map(item => item.id).sort(), ["mona-from-a", "mona-from-b"],
    "A found it no longer held the lease, did not rename, and retried from disk");
});

test("a live holder renews its lease, so a slow write is never taken over", async t => {
  const directory = await tempDirectory(t);
  const [a, b] = await Promise.all([
    openStore({ directory, staleLockMs: 90 }),
    openStore({ directory, lockTimeoutMs: 250, staleLockMs: 90 }),
  ]);
  let started;
  const inside = new Promise(resolve => { started = resolve; });
  const slow = a.serialise(async () => {
    started();
    await new Promise(resolve => setTimeout(resolve, 450));   // five times the stale period
    await MemoryStore.prototype.create.call(a, entry("mona-slow"));
  });
  await inside;
  await assert.rejects(() => b.create(entry("mona-impatient")), { code: "board_locked" },
    "the other instance waits for a lease that is being renewed");
  await slow;
  assert.deepEqual((await (await openStore({ directory })).list()).map(item => item.id), ["mona-slow"]);
});

test("the event cannot be wiped while a takedown is still owed to the public board", async t => {
  const { WIPE_CONFIRMATION } = await import("../.github/extensions/commit-and-sip/services/event-archive.mjs");
  let online = false;
  const client = {
    async publish(sent) { return { ...sent, entries: 1, rank: 1 }; },
    async retract() { if (!online) throw new Error("offline"); return "retracted"; },
  };
  const { engine, store } = await engineWith(t, client);
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  await engine.publish("booth-1");
  await engine.dispatch("booth-1", "complete", {});
  const removed = await engine.removeDrink({ id: served.submission.id, reason: "test", removedBy: "lead" });
  assert.deepEqual([removed.published, removed.owed], ["failed", true]);

  const before = JSON.stringify(await store.read());
  await assert.rejects(() => engine.archiveAndWipe({ archivedBy: "lead", confirm: WIPE_CONFIRMATION }),
    { code: "takedowns_owed" }, "wiping would destroy the only record the retry scans");
  assert.equal(JSON.stringify(await store.read()), before, "nothing was changed");

  online = true;
  const wiped = await engine.archiveAndWipe({ archivedBy: "lead", confirm: WIPE_CONFIRMATION });
  assert.ok(wiped.archive, "once the takedown lands, the wipe retries it and proceeds");
  assert.deepEqual((await store.read()).removals ?? [], [], "the wiped ledger starts without removals");
});

test("a drink that was never published owes no public takedown", async t => {
  const { WIPE_CONFIRMATION } = await import("../.github/extensions/commit-and-sip/services/event-archive.mjs");
  const { engine } = await engineWith(t, null);   // this booth never publishes
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  await engine.dispatch("booth-1", "complete", {});
  const removed = await engine.removeDrink({ id: served.submission.id, reason: "test", removedBy: "lead" });
  assert.deepEqual([removed.published, removed.owed], ["not-configured", false],
    "no false alarm: it was never on the public board");
  assert.deepEqual(await engine.owedPublicTakedowns(), []);
  assert.ok((await engine.archiveAndWipe({ archivedBy: "lead", confirm: WIPE_CONFIRMATION })).archive,
    "and it does not block the end of the event");
});

test("a direct removal that may leave a drink public is reported as unfinished", async t => {
  const boothOnly = { async publish(sent) { return { ...sent, entries: 1, rank: 1 }; } };
  const { engine } = await engineWith(t, boothOnly);
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  await engine.publish("booth-1");
  const removed = await engine.removeDrink({ id: served.submission.id, reason: "test", removedBy: "lead" });
  assert.deepEqual([removed.published, removed.owed], ["not-configured", true],
    "the script exits non-zero on `owed`, so automation cannot read this as done");
  const { removalReport } = await import("../scripts/remove-drink.mjs");
  const report = removalReport(removed);
  assert.equal(report.exitCode, 1);
  assert.match(report.text, /NOT off the public leaderboard/);
});

test("two writers that ever overlap cannot trample each other's temporary file", async t => {
  // The lock normally prevents this; the unique temporary name is the defence
  // for the moment it does not (a lease judged stale while its holder still
  // writes). Every overlapping write must land whole.
  const directory = await tempDirectory(t);
  const [a, b] = await Promise.all([openStore({ directory }), openStore({ directory })]);
  const writes = Array.from({ length: 40 }, (_, index) =>
    (index % 2 ? a : b).persist(`${JSON.stringify({ entries: [], reserved: [], version: index })}\n`));
  const outcomes = await Promise.allSettled(writes);
  assert.deepEqual(outcomes.filter(outcome => outcome.status === "rejected").map(outcome => outcome.reason.code), [],
    "no overlapping write failed");
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(directory, "default.json"), "utf8")), "and the board is whole");
});


// --- Review round 5 ----------------------------------------------------------

test("a removed name never appears in a request path the web server logs", async t => {
  const { url } = await service(t);
  const sent = submission("Mona Moonrise Mocha");
  await post(url, sent);
  assert.equal((await fetch(`${url}/api/entries/${sent.id}`, { method: "DELETE",
    headers: { Authorization: `Bearer ${STAFF_KEY}` } })).status, 404, "the old path-based route is gone");
  assert.equal((await del(url, sent.id)).status, 204);
  assert.equal((await fetch(`${url}/api/retractions`, { method: "POST", body: JSON.stringify({ id: sent.id, extra: 1 }),
    headers: { Authorization: `Bearer ${STAFF_KEY}`, "Content-Type": "application/json" } })).status, 400, "exactly { id }");
  const client = await readFile(new URL("../.github/extensions/commit-and-sip/services/leaderboard-client.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(client, /api\/entries\/\$\{/, "the client never puts a drink ID in a URL");
});

test("a refused publication gets no QR code that would open someone else's row", async t => {
  const refusing = {
    async publish() { throw Object.assign(new Error("clash"), { code: "duplicate_drink" }); },
  };
  const directory = await tempDirectory(t);
  const engine = new BoothEngine({ catalog, rules, store: new RunStore(directory),
    leaderboardClient: refusing, leaderboardUrl: "https://sip.example.com/board" });
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  assert.ok(served.attendeeUrl, "before the refusal a link is offered");
  await engine.publish("booth-1");
  const view = await engine.get("booth-1");
  assert.equal(view.sync.state, "rejected");
  assert.equal(view.attendeeUrl, null, "the name belongs to someone else on the board");
});

test("the configure report says which keys were kept, made, or removed", async t => {
  const { configure } = await import("../scripts/configure-leaderboard.mjs");
  const directory = await tempDirectory(t);
  const configFile = join(directory, "local-config.json");
  const url = "https://commit-and-sip-leaderboard.azurewebsites.net";
  await configure({ configFile, url });
  const demoted = await configure({ configFile, staff: false, url });
  assert.deepEqual([demoted.generated, demoted.removed], [[], ["staffKey"]],
    "a copied staff config on a publish-only booth reports the staff key as removed, not kept");
  const source = await readFile(new URL("../scripts/configure-leaderboard.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Kept the existing leaderboard keys/, "no blanket claim that every key was kept");
});

test("no staff guidance sends anyone to another machine to finish this booth's takedowns", async () => {
  for (const file of ["../scripts/republish-leaderboard.mjs", "../scripts/remove-drink.mjs",
    "../.github/extensions/commit-and-sip/renderer/admin.js", "../booth/RUNBOOK.md"]) {
    const text = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(text, /(?:Run this|take it down|Remove it there) (?:on|from) (?:a|another) staff machine/i, file);
    assert.doesNotMatch(text, /remove it there separately/i, file);
  }
});

test("renewing a lease never refreshes a lease someone else now holds", async t => {
  const directory = await tempDirectory(t);
  const store = await openStore({ directory, staleLockMs: 60 });   // beats every 20ms
  const lock = join(directory, "default.json.lock");
  const successor = JSON.stringify({ at: Date.now() - 60_000, owner: "someone-else" });
  await writeFile(lock, successor);
  const stop = store.renewLease("mine");
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(await readFile(lock, "utf8"), successor, "renewal never writes the lock, so it cannot touch another lease");
  assert.ok(Date.now() - await store.lastSeen(JSON.parse(successor)) > 30_000,
    "a lease this instance does not hold is left to go stale, so a dead holder cannot be kept alive");
  assert.ok(Date.now() - await store.lastSeen({ at: 0, owner: "mine" }) < 1_000, "its own heartbeat is kept fresh");
  await stop();
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith(".beat")), [], "a finished holder leaves no heartbeat");
});

// --- Review round 6 ----------------------------------------------------------

test("a takedown queued behind an admission cannot turn its receipt into a 500", async t => {
  const directory = await tempDirectory(t);
  const store = await openStore({ directory });
  // Hold the admission at the disk write, and queue a retraction behind it.
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let atDisk;
  const reachedDisk = new Promise(resolve => { atDisk = resolve; });
  const persist = store.persist.bind(store);
  let first = true;
  store.persist = async (text, owner) => {
    if (first) { first = false; atDisk(); await held; }
    return persist(text, owner);
  };
  const app = createApp({ boothKey: BOOTH_KEY, reservationKey: RESERVATION_KEY, rules, staffKey: STAFF_KEY, store, words });
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;

  const sent = submission("Mona Moonrise Mocha");
  const publication = post(url, sent);
  await reachedDisk;
  const retraction = del(url, sent.id);          // queued behind the admission
  release();
  const response = await publication;
  assert.equal(response.status, 201, "the admission succeeded, so its receipt must not fail");
  assert.equal(validateReceipt(await response.json(), sent).rank, 1, "ranked from the board as it stood at admission");
  assert.equal((await retraction).status, 204);
  assert.equal((await board(url)).total, 0, "and the takedown still happened");
});


// --- Review round 7 ----------------------------------------------------------

test("taking over a stale lease never removes the live lease that replaced it", async t => {
  const directory = await tempDirectory(t);
  const store = await openStore({ directory, staleLockMs: 60 });
  const lock = join(directory, "default.json.lock");
  // Judged stale from one read...
  const stale = JSON.stringify({ at: Date.now() - 60_000, owner: "dead" });
  // ...but by the time the takeover acts, a live successor holds the lock.
  const successor = JSON.stringify({ at: Date.now(), owner: "successor" });
  await writeFile(lock, successor);
  await store.takeOver({ at: Date.now() - 60_000, owner: "dead", text: stale });
  assert.equal(await readFile(lock, "utf8"), successor, "the successor's live lease is put back exactly");
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual((await readdir(directory)).filter(name => /\.(aside|stale)$/.test(name)), [], "nothing is left aside");

  // The lease that really was judged stale is removed.
  await writeFile(lock, stale);
  await store.takeOver({ at: Date.now() - 60_000, owner: "dead", text: stale });
  await assert.rejects(() => readFile(lock, "utf8"), { code: "ENOENT" });
});

test("a half-written lease is waited on while its creator may still be writing", async t => {
  const directory = await tempDirectory(t);
  const store = await openStore({ directory, lockTimeoutMs: 120, staleLockMs: 5_000 });
  const lease = '{"at":';
  await writeFile(join(directory, "default.json.lock"), lease);
  await assert.rejects(() => store.create(entry("mona-x")), { code: "board_locked" });
  assert.equal(await readFile(join(directory, "default.json.lock"), "utf8"), lease, "not taken over yet");
});


test("a present but malformed leaderboardApi is an error, not a quiet opt-out", () => {
  for (const value of [null, false, 0, "", []]) {
    assert.throws(() => leaderboardClientFromConfig({ leaderboardApi: value }), { code: "invalid_config" }, JSON.stringify(value));
  }
  assert.equal(leaderboardClientFromConfig({}), null, "only an absent setting means unconfigured");
});

test("promoting a booth to staff copies the deployed keys and never mints a new one", async t => {
  const { configure } = await import("../scripts/configure-leaderboard.mjs");
  const directory = await tempDirectory(t);
  const url = "https://commit-and-sip-leaderboard.azurewebsites.net";
  const staffMachine = join(directory, "staff.json");
  const deployed = (await configure({ configFile: staffMachine, url })).next.leaderboardApi;

  // A booth machine set up from the staff machine's config, publish-only.
  const booth = join(directory, "booth.json");
  const setUp = await configure({ configFile: booth, from: staffMachine, staff: false, url });
  assert.deepEqual([setUp.generated, setUp.next.leaderboardApi.boothKey], [[], deployed.boothKey]);
  assert.equal(setUp.next.leaderboardApi.staffKey, undefined);

  // Promotion without a source is refused: the key it would mint is useless.
  let minted = 0;
  await assert.rejects(() => configure({ configFile: booth, key: () => { minted += 1; return "x".repeat(64); }, url }),
    /lock out every other staff machine/);
  assert.equal(minted, 0);
  assert.equal(JSON.parse(await readFile(booth, "utf8")).leaderboardApi.staffKey, undefined, "and nothing was written");

  const promoted = await configure({ configFile: booth, from: staffMachine, url });
  assert.deepEqual(promoted.copied, ["staffKey"]);
  assert.equal(promoted.next.leaderboardApi.staffKey, deployed.staffKey);
  await assert.rejects(() => configure({ configFile: join(directory, "other.json"), from: booth.replace("booth", "missing"), url }),
    /does not exist/);
});


test("a lock is never left behind by a renewal that was in flight at release", async t => {
  // Renewals every 10ms, writes that each span several of them, and nothing
  // holding the lock afterwards: a renewal that finished after the release
  // would recreate a lease nobody holds.
  const directory = await tempDirectory(t);
  const store = await openStore({ directory, staleLockMs: 30 });
  for (let index = 0; index < 25; index += 1) {
    await store.serialise(async () => {
      await new Promise(resolve => setTimeout(resolve, 12 + (index % 4) * 3));
      await MemoryStore.prototype.create.call(store, entry(`mona-${index}`));
    });
    await assert.rejects(() => readFile(join(directory, "default.json.lock"), "utf8"), { code: "ENOENT" },
      `no lease survives release ${index}`);
  }
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual((await readdir(directory)).filter(name => /\.(aside|renew|tmp|stale)$/.test(name)), [], "and no temporary files");
});


test("a write that landed is not reported as failed because its lock could not be released", async t => {
  const directory = await tempDirectory(t);
  const store = await openStore({ directory });
  store.releaseLock = () => Promise.reject(Object.assign(new Error("share hiccup"), { code: "EIO" }));
  const admitted = await store.admit(entry("mona-landed"), { fingerprint: "fp", handles: [HANDLE] });
  assert.equal(admitted.created, true, "the lease expires on its own; the write stands");
  assert.deepEqual((await (await openStore({ directory })).list()).map(item => item.id), ["mona-landed"]);
});


// --- Review round 8 ----------------------------------------------------------

test("the attendee's link finds their row without spelling out the drink's name", async t => {
  const { url } = await service(t);
  const directory = await tempDirectory(t);
  const engine = new BoothEngine({ catalog, rules, store: new RunStore(directory), leaderboardUrl: "https://sip.example.com/board",
    leaderboardClient: createLeaderboardClient({ boothKey: BOOTH_KEY, url }) });
  await engine.open({ runId: "booth-1" });
  await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  await engine.publish("booth-1");
  const link = new URL((await engine.get("booth-1")).attendeeUrl);
  assert.doesNotMatch(link.href, /moonrise|mocha/i, "nothing name-derived reaches a URL that gets logged");
  assert.deepEqual([...link.searchParams.keys()].sort(), ["handle", "ref"]);
  assert.match(link.searchParams.get("ref"), /^[0-9a-f]{16}$/);
  const you = (await board(url, link.search)).you;
  assert.equal(you.name, "Mona Moonrise Mocha", "and it still finds their own drink");
  const script = await readFile(new URL("../leaderboard-service/public/board.js", import.meta.url), "utf8");
  assert.doesNotMatch(script, /params\.get\("drink"\)|&drink=/, "the page never forwards a drink ID");
});

test("an API URL with a path is refused, and routes always resolve from the origin", async () => {
  const good = { boothKey: BOOTH_KEY, staffKey: STAFF_KEY, url: "https://commit-and-sip-leaderboard.azurewebsites.net" };
  assert.ok(validateLeaderboardApi({ ...good, url: `${good.url}/` }));
  for (const url of [`${good.url}/board`, `${good.url}/api`, `${good.url}/?x=1`]) {
    assert.throws(() => validateLeaderboardApi({ ...good, url }), { code: "invalid_config" }, url);
  }
  const seen = [];
  const client = createLeaderboardClient({ ...good, url: `${good.url}/board`,
    fetchImpl: async target => { seen.push(new URL(target).pathname); return { json: async () => ({}), ok: true, status: 204 }; } });
  await client.publish({});
  await client.retract("x");
  assert.deepEqual(seen, ["/api/entries", "/api/retractions"], "never /board/api/...");
});

test("a failing lease renewal never becomes an unhandled rejection", async t => {
  const directory = await tempDirectory(t);
  const store = await openStore({ directory, staleLockMs: 30 });   // renews every 10ms
  const unhandled = [];
  const listener = reason => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  t.after(() => process.off("unhandledRejection", listener));
  store.readLease = () => Promise.reject(Object.assign(new Error("share hiccup"), { code: "EIO" }));
  const stop = store.renewLease("mine");
  await new Promise(resolve => setTimeout(resolve, 80));
  await stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(unhandled, [], "a transient filesystem error must not be able to stop the service");
});


// --- Review round 9 ----------------------------------------------------------

test("a renewal interleaved with a takeover cannot overwrite the successor", async t => {
  // The reviewed interleaving: the old holder reads its own lease, a successor
  // takes over, and only then does the old holder's renewal act.
  const directory = await tempDirectory(t);
  const [old, successor] = await Promise.all([
    openStore({ directory, staleLockMs: 60 }), openStore({ directory, staleLockMs: 60 })]);
  const lock = join(directory, "default.json.lock");
  const oldLease = JSON.stringify({ at: Date.now() - 60_000, owner: "old" });
  await writeFile(lock, oldLease);
  assert.equal((await old.readLease()).owner, "old", "the old holder has read its own lease");
  await successor.takeOver({ at: Date.now() - 60_000, owner: "old", text: oldLease });
  await successor.acquireLock();
  const successorLease = await readFile(lock, "utf8");
  assert.equal(await old.renewOnce("old"), true, "the old holder's renewal runs");
  assert.equal(await readFile(lock, "utf8"), successorLease, "and the successor's lease is untouched");
  await assert.rejects(() => old.assertOwner("old"), { code: "lock_lost" }, "so the old holder cannot commit");
});

test("a live holder's heartbeat keeps its lease even when the lease itself is old", async t => {
  const directory = await tempDirectory(t);
  const store = await openStore({ directory, lockTimeoutMs: 150, staleLockMs: 60 });
  const lease = JSON.stringify({ at: Date.now() - 60_000, owner: "busy" });
  await writeFile(join(directory, "default.json.lock"), lease);
  await writeFile(join(directory, "default.json.lock.busy.beat"), String(Date.now() + 60_000));
  await assert.rejects(() => store.create(entry("mona-x")), { code: "board_locked" });
  assert.equal(await readFile(join(directory, "default.json.lock"), "utf8"), lease);
});


test("releasing never deletes a lease that a successor now holds", async t => {
  const directory = await tempDirectory(t);
  const store = await openStore({ directory });
  const lock = join(directory, "default.json.lock");
  const mine = JSON.stringify({ at: Date.now(), owner: "mine" });
  const successor = JSON.stringify({ at: Date.now(), owner: "successor" });
  // The holder reads its own lease; by the time it acts, a successor holds it.
  await writeFile(lock, successor);
  store.readLease = async () => ({ at: Date.now(), owner: "mine", text: mine });
  await store.releaseLock("mine");
  assert.equal(await readFile(lock, "utf8"), successor, "the successor's lease survives the old holder's release");
});

test("putting a lease back never overwrites one created in the meantime", async t => {
  const directory = await tempDirectory(t);
  const store = await openStore({ directory });
  const lock = join(directory, "default.json.lock");
  const third = JSON.stringify({ at: Date.now(), owner: "third" });
  await writeFile(lock, third);
  await store.restoreLease(JSON.stringify({ at: Date.now(), owner: "moved-aside" }));
  assert.equal(await readFile(lock, "utf8"), third, "the newer lease stands");
});


// --- Review round 10 ---------------------------------------------------------

test("a second instance starting at once waits for the whole reservation key", async t => {
  const directory = await tempDirectory(t);
  const file = join(directory, "reservation.key");
  const complete = "a".repeat(64);
  // The first instance has created the file but not yet written its contents.
  await writeFile(file, "");
  setTimeout(() => writeFile(file, "a".repeat(20)), 30);           // partly written
  setTimeout(() => writeFile(file, `${complete}\n`), 80);         // complete
  assert.equal(await reservationKey(directory), complete, "never an empty or partial key");
});

test("a reservation key that never completes is an error, not a new key", async t => {
  const directory = await tempDirectory(t);
  const file = join(directory, "reservation.key");
  await writeFile(file, "abc123");
  await assert.rejects(() => reservationKey(directory, { waitMs: 100 }), /does not hold a complete reservation key/);
  assert.equal(await readFile(file, "utf8"), "abc123", "the file is left for someone to restore, not replaced");
});

test("the docs describe personal board links as handle and ref together", async () => {
  const design = await readFile(new URL("../docs/leaderboard-service.md", import.meta.url), "utf8");
  const plan = await readFile(new URL("../.azure/deployment-plan.md", import.meta.url), "utf8");
  assert.match(design, /\?handle=…&ref=…/);
  assert.match(plan, /GET \/api\/board\[\?handle=&ref=\]/);
  for (const text of [design, plan]) {
    assert.doesNotMatch(text, /With `\?handle=` it also shows|`GET \/api\/board\[\?handle=\]`/, "no handle-only personal link");
  }
});

test("an instance that loses the race to create the key waits for the winner's whole key", async t => {
  // Deterministic version of two instances starting together: the loser has
  // already seen no key, and the winner has created the file but not yet
  // written it, when the loser's exclusive create fails.
  const directory = await tempDirectory(t);
  const file = join(directory, "reservation.key");
  const complete = "b".repeat(64);
  let created;
  const winnerCreated = new Promise(resolve => { created = resolve; });
  const winner = reservationKey(directory, {
    create: async path => {
      await writeFile(path, "", { flag: "wx" });                     // the file exists, still empty
      created();
      await new Promise(resolve => setTimeout(resolve, 60));
      await writeFile(path, `${complete}\n`);
    },
  });
  const loser = reservationKey(directory, {
    create: async (path, text) => { await winnerCreated; return writeFile(path, text, { flag: "wx" }); },
  });
  const [, lost] = await Promise.all([winner, loser]);
  assert.equal(lost, complete, "the loser used the winner's complete key, not an empty read");
  assert.equal((await readFile(file, "utf8")).trim(), complete);
});

// --- Review round 11 ---------------------------------------------------------

test("API keys are never written into an existing readable config file", async t => {
  const { configure } = await import("../scripts/configure-leaderboard.mjs");
  const { chmod, link, stat } = await import("node:fs/promises");
  const directory = await tempDirectory(t);
  const configFile = join(directory, "local-config.json");
  // An older, URL-only config, readable by everyone.
  await writeFile(configFile, JSON.stringify({ leaderboardUrl: "https://example.org/board" }));
  await chmod(configFile, 0o644);
  // A second name for that same file: whatever is written into it, we see.
  const observer = join(directory, "observer.json");
  await link(configFile, observer);

  const { next } = await configure({ configFile, url: "https://commit-and-sip-leaderboard.azurewebsites.net" });
  const exposed = await readFile(observer, "utf8");
  assert.ok(!exposed.includes(next.leaderboardApi.boothKey) && !exposed.includes(next.leaderboardApi.staffKey),
    "the readable file never held a key: the private one replaced it");
  assert.equal((await stat(configFile)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(configFile, "utf8")).leaderboardUrl, "https://example.org/board", "and nothing was lost");
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith(".tmp")), []);
});

test("the health check fails when the board cannot be read", async t => {
  const store = new MemoryStore();
  const { url } = await service(t, { store });
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  store.list = () => Promise.reject(Object.assign(new Error("share unavailable"), { code: "EIO" }));
  const unhealthy = await fetch(`${url}/healthz`);
  assert.equal(unhealthy.status, 503, "App Service must see the instance as unhealthy");
  assert.deepEqual(await unhealthy.json(), { moderation: "reviewed", ok: false, store: "unreadable" });
});

test("container stdout and stderr are kept, which on Linux is the httpLogs setting", async () => {
  const app = await readFile(new URL("../infra/modules/app.bicep", import.meta.url), "utf8");
  assert.match(app, /httpLogs: \{\s*fileSystem: \{\s*enabled: true/);
  assert.match(app, /--docker-container-logging filesystem` writes exactly httpLogs\.fileSystem/,
    "the reason is recorded where the next reader will look");
});

// --- Review round 12 ---------------------------------------------------------

test("a board with duplicate or missing entry IDs is refused, not silently shrunk", async t => {
  for (const [label, entries] of [
    ["duplicate IDs", [entry("mona-a"), { ...entry("mona-a"), handle: OTHER_HANDLE }]],
    ["a missing ID", [{ ...entry("mona-a"), id: undefined }]],
    ["an ID that could not be stored", [{ ...entry("mona-a"), id: "../escape" }]],
  ]) {
    const directory = await tempDirectory(t);
    const file = join(directory, "default.json");
    const text = JSON.stringify({ entries, reserved: [], version: 3 });
    await writeFile(file, text);
    await assert.rejects(() => openStore({ directory }), /is not a readable board/, label);
    assert.equal(await readFile(file, "utf8"), text, `${label}: the file is left exactly as found`);
  }
});

test("a lost reservation key fails closed while the board holds reservations", async t => {
  const { keyIdOf, openReservationKey } = await import("../leaderboard-service/store.mjs");
  const directory = await tempDirectory(t);
  const store = await openStore({ directory });
  const key = await openReservationKey(directory, store);
  await store.retract("mona-gone", fp("gone"));
  assert.equal(JSON.parse(await readFile(join(directory, "default.json"), "utf8")).keyId, keyIdOf(key),
    "the board records which key its reservations use");

  await rm(join(directory, "reservation.key"));
  const restarted = await openStore({ directory });
  await assert.rejects(() => openReservationKey(directory, restarted), /reservation\.key is missing, but .* holds 1 reserved name/);
  await assert.rejects(() => readFile(join(directory, "reservation.key")), { code: "ENOENT" }, "and no replacement key was minted");

  await writeFile(join(directory, "reservation.key"), `${"c".repeat(64)}\n`);
  const reopened = await openStore({ directory });
  await assert.rejects(() => openReservationKey(directory, reopened), /different reservation key/);

  const fresh = await tempDirectory(t);
  assert.match(await openReservationKey(fresh, await openStore({ directory: fresh })), /^[0-9a-f]{64}$/,
    "a board with no reservations may start with a new key");
});

test("a static file that cannot be read gets a clean 500, not a half-sent 200", async t => {
  const { url } = await service(t);
  const { rename: move } = await import("node:fs/promises");
  const css = new URL("../leaderboard-service/public/board.css", import.meta.url);
  const aside = new URL("../leaderboard-service/public/board.css.aside-for-test", import.meta.url);
  await move(css, aside);
  t.after(() => move(aside, css));
  const response = await fetch(`${url}/board.css`);
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, "server_error");
  assert.equal((await fetch(`${url}/healthz`)).status, 200, "and the server is still answering");
});

test("on Windows the key file is restricted with an owner-only ACL before any key is in it", async t => {
  const { configure } = await import("../scripts/configure-leaderboard.mjs");
  const directory = await tempDirectory(t);
  const configFile = join(directory, "local-config.json");
  const calls = [];
  const run = async (command, args) => calls.push({ args, command, contentAtCall: await readFile(args[0], "utf8") });
  const access = { env: { USERDOMAIN: "CORP", USERNAME: "barista" }, platform: "win32", run };
  const { next } = await configure({ access, configFile, url: "https://commit-and-sip-leaderboard.azurewebsites.net" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "icacls");
  assert.deepEqual(calls[0].args.slice(1), ["/inheritance:r", "/grant:r", "CORP\\barista:F"]);
  assert.equal(calls[0].contentAtCall, "", "the ACL is applied while the file is still empty");
  assert.ok(JSON.parse(await readFile(configFile, "utf8")).leaderboardApi.boothKey === next.leaderboardApi.boothKey);

  // If the ACL cannot be applied, no key is written anywhere.
  const failing = { ...access, run: async () => { throw new Error("icacls failed"); } };
  const other = join(directory, "other.json");
  await assert.rejects(() => configure({ access: failing, configFile: other, url: "https://commit-and-sip-leaderboard.azurewebsites.net" }), /icacls failed/);
  await assert.rejects(() => readFile(other, "utf8"), { code: "ENOENT" });
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith(".tmp")), [], "no half-written key file is left");
  await assert.rejects(() => configure({ access: { ...access, env: {} }, configFile: other,
    url: "https://commit-and-sip-leaderboard.azurewebsites.net" }), /Cannot tell which Windows user/);
});

// --- Review round 13 ---------------------------------------------------------

function gate() {
  let open;
  const opened = new Promise(resolve => { open = resolve; });
  return { open, opened };
}

test("a late failure from an earlier retraction cannot undo one that landed", async t => {
  const first = gate();
  let calls = 0;
  const client = {
    async publish(sent) { return { ...sent, entries: 1, rank: 1 }; },
    async retract() {
      calls += 1;
      if (calls === 1) { await first.opened; throw new Error("timed out"); }   // the earlier, slow attempt
      return "retracted";
    },
  };
  const { engine, store } = await engineWith(t, client);
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  const slow = engine.removeDrink({ id: served.submission.id, reason: "test", removedBy: "lead" });
  while (calls < 1) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await engine.retryRetractions(), [{ id: served.submission.id, published: "retracted" }]);
  first.open();
  const record = await slow;
  assert.equal((await store.read()).removals[0].published, "retracted", "the settled outcome stands");
  assert.deepEqual([record.published, record.owed], ["retracted", false], "and the caller is told what is recorded");
  assert.deepEqual(await engine.owedPublicTakedowns(), []);
});

test("a late failure from an earlier publish cannot undo a confirmation", async t => {
  const first = gate();
  let calls = 0;
  const client = {
    async publish(sent) {
      calls += 1;
      if (calls === 1) { await first.opened; throw new Error("timed out"); }
      return { ...sent, entries: 1, rank: 1 };
    },
  };
  const { engine, store } = await engineWith(t, client);
  await engine.open({ runId: "booth-1" });
  await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  const slow = engine.publish("booth-1");
  while (calls < 1) await new Promise(resolve => setImmediate(resolve));
  await engine.publish("booth-1", { again: true });
  assert.equal((await store.read()).runs["booth-1"].sync.state, "confirmed");
  first.open();
  await slow;
  assert.equal((await store.read()).runs["booth-1"].sync.state, "confirmed", "the late failure does not downgrade it");
});

test("the booth screen's refresh retries a publication that failed", async t => {
  const { BoothPanel } = await import("../.github/extensions/commit-and-sip/booth-panel.mjs");
  let online = false;
  const client = { async publish(sent) { if (!online) throw new Error("offline"); return { ...sent, entries: 1, rank: 1 }; } };
  const { engine } = await engineWith(t, client);
  const panel = new BoothPanel(engine, { renderQr: async () => null });
  panel.engine.lastPublicationSweep = Date.now();                     // keep the background sweep out of this test
  await panel.dispatch("begin", {});
  await panel.dispatch("submit_name", { name: "Mona Moonrise Mocha" });
  await panel.backgroundPublish;
  assert.equal((await panel.get()).sync.state, "failed");
  online = true;
  const refreshed = await panel.dispatch("refresh", {});
  assert.equal(refreshed.sync.state, "confirmed", "refresh on the real panel reaches the retry");
});

test("a failed publication is still retried after the attendee has handed over", async t => {
  const { BoothPanel } = await import("../.github/extensions/commit-and-sip/booth-panel.mjs");
  const { AdminPanel } = await import("../.github/extensions/commit-and-sip/admin-panel.mjs");
  let online = false;
  const client = { async publish(sent) { if (!online) throw new Error("offline"); return { ...sent, entries: 1, rank: 1 }; } };
  const { engine, store } = await engineWith(t, client);
  const panel = new BoothPanel(engine, { renderQr: async () => null });
  panel.engine.lastPublicationSweep = Date.now();
  await panel.dispatch("begin", {});
  await panel.dispatch("submit_name", { name: "Mona Moonrise Mocha" });
  await panel.backgroundPublish;
  const runId = panel.runId;
  await panel.dispatch("complete", {});
  assert.equal((await store.read()).runs[runId].sync.state, "failed");
  online = true;

  // The idle screen's own poll starts the retry once the sweep interval passes.
  panel.engine.lastPublicationSweep = 0;
  await panel.get();
  // Wait only for a sweep the poll itself started. Starting one here would
  // make the test pass whether or not the poll did anything.
  assert.ok(engine.publicationSweep, "the idle poll started a retry");
  await engine.publicationSweep;
  assert.equal((await store.read()).runs[runId].sync.state, "confirmed", "no screen was showing it, and it still landed");

  // And staff refresh does the same for anything still owed.
  const { engine: other, store: otherStore } = await engineWith(t, client);
  online = false;
  await other.open({ runId: "r" });
  await other.dispatch("r", "submit_name", { name: "Ducky Dawn Drizzle" });
  await other.publish("r");
  online = true;
  await new AdminPanel(other).dispatch("refresh", {});
  assert.equal((await otherStore.read()).runs.r.sync.state, "confirmed");
});

test("the idle poll starts at most one retry sweep per interval", async t => {
  const { BoothPanel } = await import("../.github/extensions/commit-and-sip/booth-panel.mjs");
  let sweeps = 0;
  const engine = { house: async () => ({}), retryPublications: async () => { sweeps += 1; } };
  const panel = new BoothPanel(engine, { renderQr: async () => null });
  panel.sweepInBackground(1_000_000);
  panel.sweepInBackground(1_000_000 + 10_000);
  panel.sweepInBackground(1_000_000 + 29_999);
  panel.sweepInBackground(1_000_000 + 30_000);
  assert.equal(sweeps, 2, "the network is not hit on every five-second poll");
});


// --- Review round 14 ---------------------------------------------------------

test("a lease left half-written by a dead creator is taken over, not waited on forever", async t => {
  const directory = await tempDirectory(t);
  const lock = join(directory, "default.json.lock");
  for (const partial of ["", '{"at":17', "{"]) {
    await writeFile(lock, partial);
    const store = await openStore({ directory, lockTimeoutMs: 2_000, staleLockMs: 80 });
    await store.create(entry(`mona-${partial.length}`));
    await assert.rejects(() => readFile(lock, "utf8"), { code: "ENOENT" }, `${JSON.stringify(partial)} was cleared`);
  }
  assert.equal((await (await openStore({ directory })).list()).length, 3, "and the board works again");
});

test("a half-written lease that its creator then completes is never taken over", async t => {
  const directory = await tempDirectory(t);
  const store = await openStore({ directory, staleLockMs: 60 });
  const partial = '{"at":';
  const complete = JSON.stringify({ at: Date.now(), owner: "creator" });
  store.malformed = { lastObserved: Date.now(), since: Date.now() - 60_000, text: partial };   // watched long enough
  await writeFile(join(directory, "default.json.lock"), complete);                            // but it completed
  await store.takeOver({ at: Infinity, owner: null, text: partial });
  assert.equal(await readFile(join(directory, "default.json.lock"), "utf8"), complete, "the exact-text swap keeps it");
});

test("the watch on a malformed lease restarts after any gap, so a new creator is not mistaken for a dead one", async t => {
  const directory = await tempDirectory(t);
  const store = await openStore({ directory, staleLockMs: 60 });
  const lease = { at: Infinity, owner: null, text: "" };
  const t0 = 1_000_000;
  assert.equal(await store.seenAlive(lease, t0), t0);
  assert.equal(await store.seenAlive(lease, t0 + 40), t0, "watched continuously: the clock runs");
  assert.equal(await store.seenAlive(lease, t0 + 40 + 1_000), t0 + 1_040, "after a gap the same text is a new sighting");
  assert.equal(await store.seenAlive({ ...lease, text: "{" }, t0 + 1_050), t0 + 1_050, "and different text restarts it too");
});

test("a rebuild whose resend fails is reported as failed, even for a drink confirmed before", async t => {
  let online = true;
  const client = { async publish(sent) { if (!online) throw new Error("replacement unreachable"); return { ...sent, entries: 1, rank: 1 }; } };
  const { engine, store } = await engineWith(t, client);
  await engine.open({ runId: "booth-1" });
  await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  await engine.publish("booth-1");
  assert.equal((await store.read()).runs["booth-1"].sync.state, "confirmed");
  online = false;
  const { drinks } = await engine.republishAll();
  assert.deepEqual(drinks.map(result => result.state), ["failed"], "nothing reached the replacement service");
  assert.match(drinks[0].reason, /replacement unreachable/);
  assert.equal((await store.read()).runs["booth-1"].sync.state, "confirmed", "the record keeps the earlier confirmation");
});

test("the dashboard flags an interrupted removal, including one this booth never sent", async t => {
  const boothOnly = { async publish(sent) { return { ...sent, entries: 1, rank: 1 }; } };
  const { engine, store } = await engineWith(t, boothOnly);
  await engine.open({ runId: "booth-1" });
  const published = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  await engine.publish("booth-1");
  await engine.dispatch("booth-1", "complete", {});
  await engine.open({ runId: "booth-2" });
  const unpublished = await engine.dispatch("booth-2", "submit_name", { name: "Ducky Dawn Drizzle" });
  await store.transaction(data => { data.runs["booth-2"].sync = { attempts: 0, state: "disabled" }; });
  await engine.dispatch("booth-2", "complete", {});
  // Both removals interrupted before any outcome was recorded.
  await store.transaction(data => {
    for (const drink of [published, unpublished]) {
      data.menu.splice(data.menu.findIndex(item => item.id === drink.submission.id), 1);
      data.removals.push({ id: drink.submission.id, name: drink.submission.name, reason: "test",
        removedAt: "2026-01-01T00:00:00Z", removedBy: "lead", runId: drink.runId });
    }
  });
  const { removals } = await engine.adminOverview();
  assert.deepEqual(removals.map(record => [record.id, record.published, record.owed]), [
    [published.submission.id, undefined, true],
    // This booth publishes, so another booth may hold the same ID on the board.
    [unpublished.submission.id, undefined, true],
  ]);
  const renderer = await readFile(new URL("../.github/extensions/commit-and-sip/renderer/admin.js", import.meta.url), "utf8");
  assert.match(renderer, /return PUBLIC_BOARD\[published\] \?\? PUBLIC_BOARD\.unrecorded;/, "a missing outcome is shown as unresolved");
  assert.match(renderer, /if \(!owed\) return "";/, "and a drink that was never public raises no alarm");
});


// --- Review round 15 ---------------------------------------------------------

test("serving a drink never waits on the leaderboard service", async t => {
  const { BoothPanel } = await import("../.github/extensions/commit-and-sip/booth-panel.mjs");
  const stalled = gate();
  let sends = 0;
  const onWire = gate();
  const client = { async publish(sent) { sends += 1; onWire.open(); await stalled.opened; return { ...sent, entries: 1, rank: 1 }; } };
  const { engine } = await engineWith(t, client);
  // Count publish requests and the attempts actually started, and know when
  // the sweep has made its request.
  let requests = 0;
  let attempts = 0;
  const secondRequest = gate();
  const publish = engine.publish.bind(engine);
  engine.publish = (...args) => { requests += 1; if (requests === 2) secondRequest.open(); return publish(...args); };
  const publishOnce = engine.publishOnce.bind(engine);
  engine.publishOnce = (...args) => { attempts += 1; return publishOnce(...args); };
  const panel = new BoothPanel(engine, { renderQr: async () => null });
  panel.engine.lastPublicationSweep = 0;                                   // let the poll's sweep run too
  await panel.dispatch("begin", {});
  const served = await panel.dispatch("submit_name", { name: "Mona Moonrise Mocha" });
  assert.equal(served.phase, "served", "the attendee's answer came back while the service is still silent");
  assert.equal(served.sync.state, "pending");
  const polled = await panel.get();                      // the screen's poll, which also starts a sweep
  assert.equal(polled.sync.state, "pending");
  const sweep = engine.publicationSweep;
  assert.ok(sweep, "the poll started a sweep");
  await secondRequest.opened;                             // the sweep has asked to publish this run
  await onWire.opened;                                    // and the first attempt is on the wire
  assert.equal(attempts, 1, "the sweep joined the publish already in flight rather than starting another");
  assert.equal(sends, 1, "so the drink was sent once");
  stalled.open();
  await Promise.all([sweep, panel.backgroundPublish]);
  assert.equal((await panel.get()).sync.state, "confirmed");
});

test("the attendee's link is personal from the first screen, before any send", async t => {
  const stalled = gate();
  const client = { async publish(sent) { await stalled.opened; return { ...sent, entries: 1, rank: 1 }; } };
  const directory = await tempDirectory(t);
  const store = new RunStore(directory);
  const engine = new BoothEngine({ catalog, rules, store, leaderboardClient: client, leaderboardUrl: "https://sip.example.com/board" });
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  const token = (await store.read()).runs["booth-1"].sync.token;
  assert.match(token, /^[0-9a-f]{32}$/, "minted and saved with the served drink");
  assert.equal(new URL(served.attendeeUrl).searchParams.get("ref"), publicRef(tokenHashOf(token)));
  stalled.open();
});

test("the served screen keeps polling while its drink is being confirmed", async () => {
  const script = await readFile(new URL("../.github/extensions/commit-and-sip/renderer/booth.js", import.meta.url), "utf8");
  assert.match(script, /confirming = state\.phase === "served" && \["pending", "failed"\]\.includes\(state\.sync\?\.state\)/,
    "a failed publish is still retryable, so the screen keeps checking; confirmed and rejected are final");
  assert.match(script, /phase === "idle" \|\| confirming\)\) void load\(false\)/);
});

test("the template accepts exactly the event IDs the service can start with", async t => {
  const main = await readFile(new URL("../infra/main.bicep", import.meta.url), "utf8");
  const allowed = /var eventIdAllowed = '([^']+)'/.exec(main)[1];
  assert.match(main, /fail\('eventId may contain only/);
  assert.match(main, /eventId: checkedEventId/, "the checked value is what reaches the app");
  const directory = await tempDirectory(t);
  for (let code = 32; code < 127; code += 1) {
    const character = String.fromCharCode(code);
    let starts = true;
    try { await openStore({ directory, event: `a${character}` }); } catch { starts = false; }
    assert.equal(allowed.includes(character), starts, `template and service disagree about ${JSON.stringify(character)}`);
  }
  const committed = JSON.parse(await readFile(new URL("../infra/main.parameters.json", import.meta.url), "utf8")).parameters.eventId.value;
  assert.match(committed, /^[a-z0-9-]{1,63}$/);
});


// --- Review round 16 ---------------------------------------------------------

test("the event cannot be wiped while a publish is on the wire", async t => {
  const { WIPE_CONFIRMATION } = await import("../.github/extensions/commit-and-sip/services/event-archive.mjs");
  // The reviewed sequence: hold the publish, remove the drink, complete, wipe,
  // then let the publish land.
  const held = gate();
  const onWire = gate();
  const retracted = [];
  const client = {
    async publish(sent) { onWire.open(); await held.opened; return { ...sent, entries: 1, rank: 1 }; },
    async retract(id) { retracted.push(id); return retracted.length === 1 ? "absent" : "retracted"; },
  };
  const { engine, store } = await engineWith(t, client);
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  const publishing = engine.publish("booth-1");
  await onWire.opened;                                    // the send has left, past its claim
  await engine.removeDrink({ id: served.submission.id, reason: "test", removedBy: "lead" });
  await engine.dispatch("booth-1", "complete", {});
  const wiping = engine.archiveAndWipe({ archivedBy: "lead", confirm: WIPE_CONFIRMATION });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok((await store.read()).runs["booth-1"], "the wipe is waiting for the publish, not racing it");
  held.open();
  await publishing;
  assert.ok((await wiping).archive);
  assert.deepEqual(retracted, [served.submission.id, served.submission.id],
    "the late landing was noticed while its run still existed, and taken down again");
});

test("a wipe refuses if a publish starts after the drain", async t => {
  const { WIPE_CONFIRMATION } = await import("../.github/extensions/commit-and-sip/services/event-archive.mjs");
  const { engine } = await engineWith(t, null);
  await engine.open({ runId: "booth-1" });
  await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  await engine.dispatch("booth-1", "complete", {});
  const never = new Promise(() => {});
  engine.drainPublications = async () => { engine.inFlight = new Set([never]); };   // one starts just after
  await assert.rejects(() => engine.archiveAndWipe({ archivedBy: "lead", confirm: WIPE_CONFIRMATION }),
    { code: "publications_in_flight" });
});

test("a publish whose response was lost is still followed by a second retraction", async t => {
  const held = gate();
  const onWire = gate();
  const retracted = [];
  const client = {
    // The service stores the drink, but the answer never arrives.
    async publish() { onWire.open(); await held.opened; throw new Error("socket hang up"); },
    async retract(id) { retracted.push(id); return retracted.length === 1 ? "absent" : "retracted"; },
  };
  const { engine, store } = await engineWith(t, client);
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  const publishing = engine.publish("booth-1");
  await onWire.opened;                                    // the send has left, past its claim
  await engine.removeDrink({ id: served.submission.id, reason: "test", removedBy: "lead" });
  held.open();
  await publishing;
  assert.equal(retracted.length, 2, "a failed response is not proof the drink did not land");
  assert.equal((await store.read()).removals[0].published, "retracted");
});

test("by default a write waits long enough to recover a lock a crashed creator left half-written", async t => {
  const directory = await tempDirectory(t);
  await writeFile(join(directory, "default.json.lock"), '{"at":');
  const store = await openStore({ directory, staleLockMs: 150 });   // lockTimeoutMs left to its default
  assert.ok(store.lockTimeoutMs > store.staleLockMs, "a waiter outlasts the stale interval");
  await store.create(entry("mona-recovered"));
  assert.deepEqual((await store.list()).map(item => item.id), ["mona-recovered"]);
  const production = await openStore({ directory: await tempDirectory(t) });
  assert.ok(production.lockTimeoutMs > production.staleLockMs, "and so do the production defaults");
});

test("a forced resend on the wire also holds off the wipe", async t => {
  const { WIPE_CONFIRMATION } = await import("../.github/extensions/commit-and-sip/services/event-archive.mjs");
  const held = gate();
  let calls = 0;
  const client = {
    async publish(sent) { calls += 1; if (calls > 1) await held.opened; return { ...sent, entries: 1, rank: 1 }; },
    async retract() { return "retracted"; },
  };
  const { engine, store } = await engineWith(t, client);
  await engine.open({ runId: "booth-1" });
  await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  await engine.publish("booth-1");
  await engine.dispatch("booth-1", "complete", {});
  const rebuilding = engine.republishAll();                 // a rebuild's forced resend, held on the wire
  while (calls < 2) await new Promise(resolve => setImmediate(resolve));
  const wiping = engine.archiveAndWipe({ archivedBy: "lead", confirm: WIPE_CONFIRMATION });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok((await store.read()).runs["booth-1"], "the wipe waits for the forced resend too");
  held.open();
  await rebuilding;
  assert.ok((await wiping).archive);
});

// --- Review round 17 ---------------------------------------------------------

test("only the service's own answer settles a takedown as absent", async t => {
  const answer = (status, body, type = "application/json") => async () => new Response(
    typeof body === "string" ? body : JSON.stringify(body), { headers: { "Content-Type": type }, status });
  const clientFor = fetchImpl => createLeaderboardClient({ boothKey: BOOTH_KEY, fetchImpl, staffKey: STAFF_KEY,
    url: "https://sip.example.com" });
  // The build deployed today has no /api/retractions, and its router answers
  // exactly like this. A stopped app's front end answers 404 in HTML.
  for (const impostor of [answer(404, { error: "not_found" }), answer(404, "<h1>Not found</h1>", "text/html"),
    answer(200, "<html>portal</html>", "text/html"), answer(200, { ok: true })]) {
    await assert.rejects(() => clientFor(impostor).retract("mona-moonrise-mocha"),
      "an answer that is not the service's does not prove the entry is gone");
  }
  const { engine } = await engineWith(t, clientFor(answer(404, { error: "not_found" })));
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  await engine.drainPublications();
  await engine.store.transaction(data => { data.runs["booth-1"].sync = { state: "confirmed" }; });
  const removal = await engine.removeDrink({ id: served.submission.id, reason: "test", removedBy: "lead" });
  assert.equal(removal.published, "failed", "a missing route is a failure, retried later");
  assert.equal(removal.owed, true, "and staff are still warned the drink may be public");

  // The real service's answer for an ID it never held is absent, and reserves it.
  const { url } = await service(t);
  const real = createLeaderboardClient({ boothKey: BOOTH_KEY, staffKey: STAFF_KEY, url });
  assert.equal(await real.retract(served.submission.id), "absent");
  assert.equal((await post(url, submission("Mona Moonrise Mocha", OTHER_HANDLE))).status, 409);
});

test("a rebuild sends no drink until every takedown is reserved again", async t => {
  const lost = await service(t);
  const replacement = await service(t);
  const to = url => createLeaderboardClient({ boothKey: BOOTH_KEY, staffKey: STAFF_KEY, url });
  let target = to(lost.url);
  let reachable = true;
  const client = { publish: sent => target.publish(sent),
    retract: id => (reachable ? target.retract(id) : Promise.reject(new Error("unreachable"))) };
  const { engine } = await engineWith(t, client);
  await engine.open({ runId: "booth-1" });
  await engine.dispatch("booth-1", "submit_name", { name: "Ducky Dawn Drizzle" });
  await engine.dispatch("booth-1", "complete", {});
  await engine.open({ runId: "booth-2" });
  const removed = await engine.dispatch("booth-2", "submit_name", { name: "Mona Moonrise Mocha" });
  await engine.dispatch("booth-2", "complete", {});
  await engine.drainPublications();
  const removal = await engine.removeDrink({ id: removed.submission.id, reason: "test", removedBy: "lead" });
  assert.ok(["retracted", "absent"].includes(removal.published), "settled on the board that is about to be lost");

  // The board is lost, and the takedown replay cannot reach its replacement.
  target = to(replacement.url);
  reachable = false;
  const blocked = await engine.republishAll();
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.removals, [{ failure: { code: null, status: null }, id: removed.submission.id, published: "failed" }]);
  assert.deepEqual(blocked.drinks, [], "no drink is sent while a removed name is unreserved");
  assert.equal((await board(replacement.url)).total, 0, "and none reached the replacement board");

  reachable = true;
  const rebuilt = await engine.republishAll();
  assert.equal(rebuilt.blocked, false);
  assert.deepEqual(rebuilt.removals, [{ id: removed.submission.id, published: "absent" }]);
  assert.deepEqual(rebuilt.drinks.map(result => result.state), ["confirmed"]);
  assert.equal((await post(replacement.url, submission("Mona Moonrise Mocha", OTHER_HANDLE))).status, 409);
});

// --- Review round 18 ---------------------------------------------------------

async function servedAndHandedOver(engine, runId = "booth-1") {
  await engine.open({ runId });
  const served = await engine.dispatch(runId, "submit_name", { name: "Mona Moonrise Mocha" });
  await engine.dispatch(runId, "complete", {});
  return served;
}

test("a retry that starts during the archive never sends a drink the wipe is about to erase", async t => {
  const { WIPE_CONFIRMATION } = await import("../.github/extensions/commit-and-sip/services/event-archive.mjs");
  let sends = 0;
  const client = { async publish(sent) { sends += 1; if (sends === 1) throw new Error("unreachable"); return { ...sent, entries: 1, rank: 1 }; } };
  const { engine, store } = await engineWith(t, client);
  await servedAndHandedOver(engine);
  await engine.publish("booth-1");
  assert.equal((await store.read()).runs["booth-1"].sync.state, "failed", "owed a retry");

  // The reviewed sequence: the idle poll's sweep starts while the archive is
  // being written. Reads do not wait on the ledger lock.
  let sweep;
  const write = store.writePendingArtifact.bind(store);
  store.writePendingArtifact = async (...args) => {
    sweep = engine.retryPublications();
    await new Promise(resolve => setTimeout(resolve, 100));   // time enough for an unclaimed send to leave
    return write(...args);
  };
  assert.ok((await engine.archiveAndWipe({ archivedBy: "lead", confirm: WIPE_CONFIRMATION })).archive);
  await sweep;
  assert.equal(sends, 1, "the send found its run gone at its claim, and never left");
});

test("a send claimed by another process on this ledger holds off the wipe", async t => {
  const { WIPE_CONFIRMATION } = await import("../.github/extensions/commit-and-sip/services/event-archive.mjs");
  const directory = await tempDirectory(t);
  const held = gate();
  const onWire = gate();
  const client = { async publish(sent) { onWire.open(); await held.opened; return { ...sent, entries: 1, rank: 1 }; } };
  const dashboard = new BoothEngine({ catalog, leaderboardClient: client, rules, store: new RunStore(directory) });
  const republish = new BoothEngine({ catalog, leaderboardClient: client, rules, store: new RunStore(directory) });
  await servedAndHandedOver(dashboard);
  const sending = republish.publish("booth-1", { again: true });
  await onWire.opened;
  assert.equal(dashboard.inFlight?.size ?? 0, 0, "nothing in this engine knows about that send");
  await assert.rejects(() => dashboard.archiveAndWipe({ archivedBy: "lead", confirm: WIPE_CONFIRMATION }),
    { code: "publications_in_flight" });
  held.open();
  await sending;
  assert.equal((await dashboard.store.read()).runs["booth-1"].sync.sending, undefined, "the claim is released");
  assert.ok((await dashboard.archiveAndWipe({ archivedBy: "lead", confirm: WIPE_CONFIRMATION })).archive);
});

test("a claim left behind by a crash stops blocking the wipe on its own", async t => {
  const { WIPE_CONFIRMATION } = await import("../.github/extensions/commit-and-sip/services/event-archive.mjs");
  const { engine, store } = await engineWith(t, { async publish(sent) { return { ...sent, entries: 1, rank: 1 }; } });
  await servedAndHandedOver(engine);
  await store.transaction(data => {
    data.runs["booth-1"].sync = { ...data.runs["booth-1"].sync, sending: { crashed: new Date(Date.now() - 61_000).toISOString() } };
  });
  assert.ok((await engine.archiveAndWipe({ archivedBy: "lead", confirm: WIPE_CONFIRMATION })).archive);
});

test("a stored row missing any served field is refused, and the health check says so", async t => {
  const { id: _id, ...noId } = entry("mona-a");
  const cases = [["no ID", noId]];
  for (const field of ["handle", "name", "score", "createdAt"]) {
    const { [field]: _gone, ...row } = entry("mona-a");
    cases.push([`no ${field}`, row]);
  }
  cases.push(
    ["a score that is text", { ...entry("mona-a"), score: "1000" }],
    ["a negative score", { ...entry("mona-a"), score: -1 }],
    ["a score below the rubric's floor", { ...entry("mona-a"), score: 0 }],
    ["a score above the rubric's ceiling", { ...entry("mona-a"), score: 5001 }],
    ["an empty name", { ...entry("mona-a"), name: " " }],
    ["a handle that is not one", { ...entry("mona-a"), handle: "<b>x</b>" }],
    ["a date that is not one", { ...entry("mona-a"), createdAt: "yesterday" }],
    ["a malformed tokenHash", { ...entry("mona-a"), tokenHash: "abc" }],
    ["a row that is not an object", "mona-a"],
  );
  for (const [label, row] of cases) {
    const directory = await tempDirectory(t);
    const file = join(directory, "default.json");
    const text = JSON.stringify({ entries: [row], reserved: [], version: 3 });
    await writeFile(file, text);
    await assert.rejects(() => openStore({ directory }), /is not a readable board/, label);
    assert.equal(await readFile(file, "utf8"), text, `${label}: the file is left exactly as found`);
  }

  // A row written before publication tokens has no tokenHash, and still loads.
  const directory = await tempDirectory(t);
  await writeFile(join(directory, "default.json"), JSON.stringify({ entries: [entry("mona-a")], reserved: [], version: 1 }));
  const store = await openStore({ directory });
  const { url } = await service(t, { store });
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  assert.equal((await board(url)).entries[0].score, 1000);

  // Corrupted underneath a running instance: the health check fails closed.
  await writeFile(join(directory, "default.json"), JSON.stringify({ entries: [{ id: "mona-a" }], reserved: [], version: 2 }));
  assert.equal((await fetch(`${url}/healthz`)).status, 503);
  assert.equal((await fetch(`${url}/api/board`)).status >= 500, true, "and the board is not served in pieces");
});

// --- Review round 19 ---------------------------------------------------------

test("the rubric's own score bounds load", async t => {
  for (const score of [1, 5000]) {
    const directory = await tempDirectory(t);
    await writeFile(join(directory, "default.json"), JSON.stringify({ entries: [entry("mona-a", score)], reserved: [], version: 1 }));
    assert.equal((await (await openStore({ directory })).list())[0].score, score);
  }
});

test("an instance left holding a replaced reservation key can no longer write", async t => {
  const { keyIdOf, openReservationKey } = await import("../leaderboard-service/store.mjs");
  const directory = await tempDirectory(t);
  // Instance A starts, and binds the (empty) board to its key before serving.
  const a = await openStore({ directory });
  const keyA = await openReservationKey(directory, a);
  assert.equal(JSON.parse(await readFile(join(directory, "default.json"), "utf8")).keyId, keyIdOf(keyA),
    "bound on disk at start-up, not at the first write");

  // The key file disappears while nothing is reserved; instance B mints a new one.
  await rm(join(directory, "reservation.key"));
  const b = await openStore({ directory });
  const keyB = await openReservationKey(directory, b);
  assert.notEqual(keyIdOf(keyB), keyIdOf(keyA));

  // A's takedown would be fingerprinted with a key B cannot match. Refused.
  const serviceA = await service(t, { store: a });
  const refused = await del(serviceA.url, "mona-moonrise-mocha");
  assert.equal(refused.status, 503);
  assert.equal((await refused.json()).error, "reservation_key_mismatch");
  assert.deepEqual([...(await b.snapshot()).reserved], [], "nothing was recorded under the old key");
  const health = await fetch(`${serviceA.url}/healthz`);
  assert.equal(health.status, 503, "so App Service recycles A onto the key the board uses");
  assert.equal((await health.json()).store, "reservation_key_mismatch");

  // B, on the bound key, is healthy and writes normally.
  const serviceB = await service(t, { store: b });
  assert.equal((await fetch(`${serviceB.url}/healthz`)).status, 200);
  assert.equal((await del(serviceB.url, "mona-moonrise-mocha")).status, 200);
});

test("binding the key survives a write that had to be retried", async t => {
  const { ConcurrentWriteError, keyIdOf, openReservationKey } = await import("../leaderboard-service/store.mjs");
  const directory = await tempDirectory(t);
  // A board bound to a key that is gone, with nothing reserved: rebinding is allowed.
  await writeFile(join(directory, "default.json"), JSON.stringify({ entries: [], keyId: "0".repeat(16), reserved: [], version: 1 }));
  const store = await openStore({ directory });
  const persist = store.persist.bind(store);
  let calls = 0;
  store.persist = (...args) => { calls += 1; return calls === 1 ? Promise.reject(new ConcurrentWriteError()) : persist(...args); };
  const key = await openReservationKey(directory, store);
  assert.equal(calls, 2, "the first write was refused and retried");
  assert.equal(JSON.parse(await readFile(join(directory, "default.json"), "utf8")).keyId, keyIdOf(key));
});

// --- Review round 20 ---------------------------------------------------------

test("a reservation that is not a fingerprint is refused, never loaded as a no-op", async t => {
  for (const [label, board] of [
    ["a readable drink ID", { entries: [], reserved: ["mona-moonrise-mocha"], version: 1 }],
    ["a truncated fingerprint", { entries: [], reserved: [fp("x").slice(0, 63)], version: 1 }],
    ["an upper-case fingerprint", { entries: [], reserved: [fp("x").toUpperCase()], version: 1 }],
    ["a key binding that is not one", { entries: [], keyId: 12, reserved: [fp("x")], version: 1 }],
    ["a key binding of the wrong length", { entries: [], keyId: "abc", reserved: [fp("x")], version: 1 }],
  ]) {
    const directory = await tempDirectory(t);
    const file = join(directory, "default.json");
    const text = JSON.stringify(board);
    await writeFile(file, text);
    await assert.rejects(() => openStore({ directory }), /is not a readable board/, label);
    assert.equal(await readFile(file, "utf8"), text, `${label}: the file is left exactly as found`);
  }
  // And one is never written in the first place.
  const store = await openStore({ directory: await tempDirectory(t) });
  await assert.rejects(() => store.retract("mona-a", "mona-a"), TypeError);
  await assert.rejects(() => new MemoryStore().retract("mona-a", "fp-a"), TypeError);
  assert.equal(await store.retract("mona-a", fp("mona-a")), false, "a real fingerprint is accepted");
});

// --- Review round 21 ---------------------------------------------------------

test("a takedown answered while its drink was still being sent stays owed across a crash", async t => {
  const onWire = gate();
  const answers = [];
  const client = {
    async publish() { onWire.open(); return new Promise(() => {}); },     // the process dies mid-send
    async retract() { answers.push("absent"); return "absent"; },
  };
  const { engine, store } = await engineWith(t, client);
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  void engine.publish("booth-1");
  await onWire.opened;
  const removal = await engine.removeDrink({ id: served.submission.id, reason: "test", removedBy: "lead" });
  assert.equal(removal.published, "in-doubt", "the service said absent, but the send could still land after");
  assert.equal(removal.owed, true, "so staff are told it may be public");

  // Restart. The dead send's claim is still in the ledger and still live.
  const restarted = new BoothEngine({ catalog, leaderboardClient: client, rules, store: new RunStore(store.directory) });
  await restarted.retryRetractions();
  assert.equal((await restarted.owedPublicTakedowns()).length, 1, "not settled while that send could still land");
  await assert.rejects(() => restarted.archiveAndWipe({ archivedBy: "lead", confirm: "wipe" }), /./);

  // Once the claim has expired, no send can still land, and a retry settles it.
  await store.transaction(data => {
    const sending = data.runs["booth-1"].sync.sending;
    for (const key of Object.keys(sending)) sending[key] = new Date(Date.now() - 61_000).toISOString();
  });
  await restarted.retryRetractions();
  assert.deepEqual(await restarted.owedPublicTakedowns(), []);
  assert.equal((await store.read()).removals[0].published, "absent");
});

test("a retraction that left before a send ended does not settle the takedown", async t => {
  const publishHeld = gate();
  const onWire = gate();
  const firstRetraction = gate();
  const firstAsked = gate();
  let calls = 0;
  const client = {
    async publish(sent) { onWire.open(); await publishHeld.opened; return { ...sent, entries: 1, rank: 1 }; },
    async retract() {
      calls += 1;
      if (calls === 1) { firstAsked.open(); await firstRetraction.opened; return "absent"; }   // answered before the send landed
      throw new Error("process stopped");                                                     // the follow-up never lands
    },
  };
  const { engine, store } = await engineWith(t, client);
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  const publishing = engine.publish("booth-1");
  await onWire.opened;
  const removing = engine.removeDrink({ id: served.submission.id, reason: "test", removedBy: "lead" });
  await firstAsked.opened;
  publishHeld.open();                  // the send lands and ends; its follow-up retraction fails
  await publishing;
  firstRetraction.open();              // the first answer arrives last
  const removal = await removing;
  assert.notEqual(removal.published, "absent", "an answer from before the send landed says nothing about after");
  assert.equal(removal.owed, true);
  assert.equal((await store.read()).runs["booth-1"].sync.sendsEnded, 1);
});

test("a saved attendee link survives a rebuild that reverses who holds the plain handle", async t => {
  const { canonicalHandle } = await import("../.github/extensions/commit-and-sip/services/leaderboard.mjs");
  const { url } = await service(t);
  // Originally A held HANDLE and B was given its canonical form. The rebuild
  // replays B's booth first, so now B holds the plain handle.
  const b = submission("Ducky Dawn Drizzle", HANDLE);
  const a = submission("Mona Moonrise Mocha", HANDLE);
  assert.equal((await post(url, b)).status, 201);
  assert.equal((await post(url, a)).status, 201);
  const saved = new URLSearchParams({ handle: canonicalHandle(HANDLE, b.id), ref: publicRef(tokenHashOf(b.token)) });
  assert.equal((await board(url, `?${saved}`)).you?.name, "Ducky Dawn Drizzle");
  // The reference still decides whose row it is: A's reference finds A, never B,
  // and a reference nobody holds finds nobody.
  const other = new URLSearchParams({ handle: canonicalHandle(HANDLE, b.id), ref: publicRef(tokenHashOf(a.token)) });
  assert.equal((await board(url, `?${other}`)).you?.name, "Mona Moonrise Mocha");
  const unknown = new URLSearchParams({ handle: canonicalHandle(HANDLE, b.id), ref: publicRef(fp("nobody")) });
  assert.equal((await board(url, `?${unknown}`)).you, null);
});

test("a send that outlives its claim still reopens a takedown that settled meanwhile", async t => {
  const publishHeld = gate();
  const onWire = gate();
  let calls = 0;
  const client = {
    async publish(sent) { onWire.open(); await publishHeld.opened; return { ...sent, entries: 1, rank: 1 }; },
    async retract() { calls += 1; if (calls === 1) return "absent"; throw new Error("process stopped"); },
  };
  const { engine, store } = await engineWith(t, client);
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  const publishing = engine.publish("booth-1");
  await onWire.opened;
  // A send slow enough that its claim has expired.
  await store.transaction(data => {
    const sending = data.runs["booth-1"].sync.sending;
    for (const key of Object.keys(sending)) sending[key] = new Date(Date.now() - 61_000).toISOString();
  });
  assert.equal((await engine.removeDrink({ id: served.submission.id, reason: "test", removedBy: "lead" })).published, "absent");
  publishHeld.open();                  // it lands after all, and its follow-up retraction fails
  await publishing;
  assert.notEqual((await store.read()).removals[0].published, "absent", "the landing reopened the takedown");
  assert.equal((await engine.owedPublicTakedowns()).length, 1);
});

// --- Review round 22 ---------------------------------------------------------

test("keys are copied only from an owner-only file, and the operator is told to delete it", async t => {
  const { chmod } = await import("node:fs/promises");
  const { configure, report } = await import("../scripts/configure-leaderboard.mjs");
  const directory = await tempDirectory(t);
  const url = "https://commit-and-sip-leaderboard.azurewebsites.net";
  const staffMachine = join(directory, "staff.json");
  await configure({ configFile: staffMachine, url });
  const copy = join(directory, "transferred.json");
  await writeFile(copy, await readFile(staffMachine, "utf8"), { mode: 0o644 });
  await chmod(copy, 0o644);                                  // what a copy tool commonly leaves
  const booth = join(directory, "booth.json");
  await assert.rejects(() => configure({ configFile: booth, from: copy, url, access: { platform: POSIX } }),
    /can be read by other users.*chmod 600/);
  await assert.rejects(() => readFile(booth), { code: "ENOENT" }, "and nothing was written");
  await chmod(copy, 0o600);
  const done = await configure({ configFile: booth, from: copy, url, access: { platform: POSIX } });
  assert.deepEqual(done.copied, ["boothKey", "staffKey"]);
  assert.match(report({ ...done, from: copy, parametersFile: null, staff: true }), new RegExp(`Delete ${copy} now`));
  assert.doesNotMatch(report({ ...done, copied: [], from: null, parametersFile: null, staff: true }), /Delete .* now: it is a second copy/);
});

test("a config that is valid JSON but not an object is reported, not a crash", async t => {
  const { configure } = await import("../scripts/configure-leaderboard.mjs");
  const url = "https://commit-and-sip-leaderboard.azurewebsites.net";
  for (const [label, text] of [["null", "null"], ["an array", "[]"], ["a string", "\"x\""],
    ["a null leaderboardApi", "{\"leaderboardApi\":null}"], ["a text leaderboardApi", "{\"leaderboardApi\":\"x\"}"]]) {
    const directory = await tempDirectory(t);
    const target = join(directory, "booth.json");
    await writeFile(target, text, { mode: 0o600 });
    await assert.rejects(() => configure({ configFile: target, url }), { code: "invalid_config" }, `${label} as the target`);
    assert.equal(await readFile(target, "utf8"), text, `${label}: left as found`);
    const source = join(directory, "source.json");
    await writeFile(source, text, { mode: 0o600 });
    await assert.rejects(() => configure({ configFile: join(directory, "other.json"), from: source, url }),
      { code: "invalid_config" }, `${label} as the source`);
  }
});

test("a board field that is present must be well formed, even if older boards lack it", async t => {
  for (const [label, board] of [
    ["reserved: null", { entries: [], reserved: null, version: 1 }],
    ["reserved as text", { entries: [], reserved: fp("x"), version: 1 }],
    ["keyId: null", { entries: [], keyId: null, reserved: [], version: 1 }],
    ["version as text", { entries: [], reserved: [], version: "3" }],
    ["a negative version", { entries: [], reserved: [], version: -1 }],
  ]) {
    const directory = await tempDirectory(t);
    const file = join(directory, "default.json");
    const text = JSON.stringify(board);
    await writeFile(file, text);
    await assert.rejects(() => openStore({ directory }), /is not a readable board/, label);
    assert.equal(await readFile(file, "utf8"), text, `${label}: the file is left exactly as found`);
  }
  // Exactly what the build deployed today writes: no version, no keyId.
  const directory = await tempDirectory(t);
  await writeFile(join(directory, "default.json"), JSON.stringify({ entries: [entry("mona-a")], reserved: [fp("gone")] }));
  const store = await openStore({ directory });
  assert.equal(await store.isReserved(fp("gone")), true);
  assert.equal((await store.list()).length, 1);
});

// --- Review round 23 ---------------------------------------------------------

test("a rebuild refused for good replaces the lost board's confirmation, and is never resent", async t => {
  let sends = 0;
  const client = {
    async publish(sent) {
      sends += 1;
      if (sends === 1) return { ...sent, entries: 1, rank: 1 };          // confirmed on the board that was lost
      // The replacement board gave the name to another attendee first.
      throw Object.assign(new Error("The leaderboard submission failed: 409 duplicate_drink."), { code: "duplicate_drink", status: 409 });
    },
  };
  const { engine, store } = await engineWith(t, client);
  await engine.open({ runId: "booth-1" });
  await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  await engine.publish("booth-1");
  assert.equal((await store.read()).runs["booth-1"].sync.state, "confirmed");

  const { drinks } = await engine.republishAll();
  assert.deepEqual(drinks.map(result => result.state), ["rejected"]);
  const sync = (await store.read()).runs["booth-1"].sync;
  assert.equal(sync.state, "rejected", "the current service's final answer wins over the lost board's");
  assert.equal(sync.code, "duplicate_drink");
  assert.equal(sync.receipt, undefined, "no rank from the lost board survives");
  assert.equal((await engine.get("booth-1")).sync.eventRank ?? null, null);

  const again = await engine.republishAll();
  assert.equal(sends, 2, "a later rebuild does not resend it");
  assert.deepEqual(again.drinks.map(result => result.state), ["rejected"]);

  // A transient failure during a rebuild still leaves a confirmation alone.
  const transient = { async publish(sent) { if (transient.down) throw new Error("socket hang up"); return { ...sent, entries: 1, rank: 1 }; } };
  const other = await engineWith(t, transient);
  await other.engine.open({ runId: "booth-1" });
  await other.engine.dispatch("booth-1", "submit_name", { name: "Ducky Dawn Drizzle" });
  await other.engine.publish("booth-1");
  transient.down = true;
  await other.engine.republishAll();
  assert.equal((await other.store.read()).runs["booth-1"].sync.state, "confirmed");
});

test("every takedown outcome has words in the remove command, and none prints undefined", async () => {
  const { PUBLIC_BOARD, publicBoardText } = await import("../scripts/remove-drink.mjs");
  for (const outcome of ["retracted", "absent", "failed", "not-configured", "in-doubt"]) {
    assert.ok(Object.hasOwn(PUBLIC_BOARD, outcome), `${outcome} has its own text`);
  }
  assert.match(publicBoardText("in-doubt"), /may still be on the public leaderboard.*--retry/);
  for (const outcome of [undefined, null, "something-new"]) {
    const text = publicBoardText(outcome);
    assert.doesNotMatch(text, /undefined/);
    assert.match(text, /--retry/);
  }
});

// --- Review round 24 ---------------------------------------------------------

test("the staff config is loaded only while its keys are readable by its owner alone", async t => {
  const { chmod } = await import("node:fs/promises");
  const { loadStaffConfig } = await import("../.github/extensions/commit-and-sip/domain.mjs");
  const directory = await tempDirectory(t);
  const file = join(directory, "local-config.json");
  const withKeys = { leaderboardApi: { boothKey: "b".repeat(64), staffKey: "s".repeat(64), url: "https://example.org" } };
  await writeFile(file, JSON.stringify(withKeys));
  await chmod(file, 0o644);                                   // restored from a backup, or copied in
  await assert.rejects(() => loadStaffConfig(file, { platform: POSIX }), { code: "config_exposed" });
  await assert.rejects(() => loadStaffConfig(file, { platform: POSIX }), /chmod 600.*rotate/);
  await chmod(file, 0o640);                                   // group-readable only is still other users
  await assert.rejects(() => loadStaffConfig(file, { platform: POSIX }), { code: "config_exposed" });
  await chmod(file, 0o600);
  assert.equal((await loadStaffConfig(file, { platform: POSIX })).leaderboardApi.boothKey, "b".repeat(64));

  // No keys, nothing to expose; and on Windows the ACL decides, not the mode.
  await writeFile(file, JSON.stringify({ leaderboardUrl: "https://example.org/board" }));
  await chmod(file, 0o644);
  assert.equal((await loadStaffConfig(file, { platform: POSIX })).leaderboardUrl, "https://example.org/board");
  await writeFile(file, JSON.stringify(withKeys));
  await chmod(file, 0o644);
  const ownerOnly = async () => ({ stdout: JSON.stringify({ aces: [{ sid: "S-1-5-21-1-2-3-1001", type: "Allow" }], me: "S-1-5-21-1-2-3-1001" }) });
  assert.ok((await loadStaffConfig(file, { platform: "win32", run: ownerOnly })).leaderboardApi);
});

test("the takedown command refuses mixed modes and repeated flags", async () => {
  const { parseArguments } = await import("../scripts/remove-drink.mjs");
  for (const argv of [
    ["--retry", "--id", "mona-x", "--by", "lead", "--reason", "reported"],   // would have retried and removed nothing
    ["--list", "--id", "mona-x", "--by", "lead", "--reason", "reported"],
    ["--list", "--retry"],
    ["--retry", "--by", "lead"],
  ]) {
    assert.throws(() => parseArguments(argv), /Choose one of --list, --retry, or a removal/, argv.join(" "));
  }
  assert.throws(() => parseArguments(["--id", "a", "--id", "b", "--by", "lead", "--reason", "x"]), /--id was given twice/);
  assert.throws(() => parseArguments(["--retry", "--retry"]), /given twice/);
  assert.equal(parseArguments(["--retry"]).retry, true);
  assert.equal(parseArguments(["--id", "a", "--by", "lead", "--reason", "x"]).id, "a");
});

// --- Review round 25 ---------------------------------------------------------

test("only the service's own reservation proves a removed ID is not public", async t => {
  const { WIPE_CONFIRMATION } = await import("../.github/extensions/commit-and-sip/services/event-archive.mjs");
  const setUp = async (client, sync) => {
    const { engine, store } = await engineWith(t, client);
    await engine.open({ runId: "booth-1" });
    const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
    await engine.dispatch("booth-1", "complete", {});
    await store.transaction(data => { data.runs["booth-1"].sync = { attempts: 1, ...sync }; });
    const removal = await engine.removeDrink({ id: served.submission.id, reason: "test", removedBy: "lead" });
    return { engine, removal };
  };
  const boothOnly = { async publish(sent) { return { ...sent, entries: 1, rank: 1 }; } };   // publishes, cannot retract

  // Another booth's entry holds this ID: the takedown is owed, and the wipe waits.
  const duplicate = await setUp(boothOnly, { code: "duplicate_drink", state: "rejected" });
  assert.equal(duplicate.removal.owed, true);
  assert.equal((await duplicate.engine.owedPublicTakedowns()).length, 1);
  await assert.rejects(() => duplicate.engine.archiveAndWipe({ archivedBy: "lead", confirm: WIPE_CONFIRMATION }),
    { code: "takedowns_owed" });

  // The service already reserves the ID: nothing is owed.
  const reserved = await setUp(boothOnly, { code: "unavailable_drink", state: "rejected" });
  assert.equal(reserved.removal.owed, false);

  // A booth that does not publish owes nothing for a drink it never sent...
  const offline = await setUp(null, { state: "disabled" });
  assert.equal(offline.removal.owed, false);
  // ...but still owes one it did send before its configuration was removed.
  const sentEarlier = await setUp(null, { state: "confirmed", receipt: {} });
  assert.equal(sentEarlier.removal.owed, true);
});

test("an instance bound to a key cannot write or stay healthy once the board's binding is gone", async t => {
  const { openReservationKey } = await import("../leaderboard-service/store.mjs");
  const directory = await tempDirectory(t);
  const store = await openStore({ directory });
  await openReservationKey(directory, store);
  const { url } = await service(t, { store });
  // The binding disappears from disk (a restored or hand-edited board).
  const file = join(directory, "default.json");
  const { keyId: _gone, ...unbound } = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify(unbound));
  const refused = await del(url, "mona-moonrise-mocha");
  assert.equal(refused.status, 503, "writing would bind the board back to a key that may be obsolete");
  assert.equal(JSON.parse(await readFile(file, "utf8")).keyId, undefined, "and nothing was written");
  assert.equal((await fetch(`${url}/healthz`)).status, 503);

  // A restart binds it again, and the instance is healthy.
  const restarted = await openStore({ directory });
  await openReservationKey(directory, restarted);
  const fresh = await service(t, { store: restarted });
  assert.equal((await fetch(`${fresh.url}/healthz`)).status, 200);
});

// --- Review round 26 ---------------------------------------------------------

test("on Windows the key file's ACL decides, and anything unverifiable fails closed", async t => {
  const { readableByOthers, loadStaffConfig } = await import("../.github/extensions/commit-and-sip/domain.mjs");
  const directory = await tempDirectory(t);
  const file = join(directory, "local-config.json");
  await writeFile(file, JSON.stringify({ leaderboardApi: { boothKey: "b".repeat(64), staffKey: "s".repeat(64), url: "https://example.org" } }));
  const ME = "S-1-5-21-1-2-3-1001";
  const calls = [];
  const acl = answer => async (command, args, options) => {
    calls.push({ args, command, options });
    if (answer instanceof Error) throw answer;
    return { stdout: typeof answer === "string" ? answer : JSON.stringify(answer) };
  };
  const exposed = answer => readableByOthers(file, { env: {}, platform: "win32", run: acl(answer) });

  assert.equal(await exposed({ aces: [{ sid: ME, type: "Allow" }], me: ME }), false, "what restrictToOwner leaves");
  assert.equal(await exposed({ aces: [{ sid: ME, type: "Allow" }, { sid: "S-1-5-18", type: "Allow" },
    { sid: "S-1-5-32-544", type: "Allow" }], me: ME }), false, "SYSTEM and Administrators can read anything anyway");
  assert.equal(await exposed({ aces: { sid: ME, type: "Allow" }, me: ME }), false, "a single ACE serialised as an object");
  assert.equal(await exposed({ aces: [{ sid: ME, type: "Allow" }, { sid: "S-1-5-32-545", type: "Deny" }], me: ME }), false,
    "a deny for others exposes nothing");
  for (const [label, answer] of [
    ["the Users group can read it", { aces: [{ sid: ME, type: "Allow" }, { sid: "S-1-5-32-545", type: "Allow" }], me: ME }],
    ["Everyone can read it", { aces: [{ sid: "S-1-1-0", type: "Allow" }], me: ME }],
    ["PowerShell could not run", new Error("spawn powershell.exe ENOENT")],
    ["the answer is not JSON", "Access is denied."],
    ["no identity came back", { aces: [{ sid: ME, type: "Allow" }] }],
    ["no ACEs came back", { aces: [], me: ME }],
    ["an ACE of an unknown kind", { aces: [{ sid: ME, type: "Audit" }], me: ME }],
  ]) {
    assert.equal(await exposed(answer), true, label);
  }
  // The path reaches PowerShell only through the environment, never the script.
  const last = calls.at(-1);
  assert.equal(last.command, "powershell.exe");
  const { realpath } = await import("node:fs/promises");
  assert.equal(last.options.env.SIP_ACL_FILE, await realpath(file), "the resolved file, the one actually read");
  assert.ok(!last.args.join(" ").includes(file) && !last.args.join(" ").includes(await realpath(file)), "a file name cannot change what runs");

  await assert.rejects(() => loadStaffConfig(file, { platform: "win32", run: acl(new Error("no PowerShell")) }),
    { code: "config_exposed" });
  await assert.rejects(() => loadStaffConfig(file, { platform: "win32", run: acl(new Error("no PowerShell")) }), /icacls/);
});

test("packaging names the archiver it needs up front, and Windows uses the tar it ships with", async t => {
  const { archiveCommand, assertArchiver } = await import("../scripts/package-leaderboard.mjs");
  assert.deepEqual(archiveCommand("win32", "out.zip", ["leaderboard-service", "package.json"]),
    ["tar", ["-a", "-c", "-f", "out.zip", "leaderboard-service", "package.json"]]);
  assert.deepEqual(archiveCommand("linux", "out.zip", ["package.json"]), ["zip", ["-qr", "out.zip", "package.json"]]);
  const missing = () => { throw Object.assign(new Error("spawn zip ENOENT"), { code: "ENOENT" }); };
  assert.throws(() => assertArchiver("linux", missing), /needs the zip command.*Nothing was packaged/);
  assert.throws(() => assertArchiver("win32", missing), /needs tar\.exe.*Windows 10/);
  assert.doesNotThrow(() => assertArchiver("linux", () => {}));
  const packager = await readFile(new URL("../scripts/package-leaderboard.mjs", import.meta.url), "utf8");
  assert.match(packager, /async function build\(\) \{\n  assertArchiver\(\);/, "checked before anything is staged");
  assert.match(packager, /archiveCommand\(process\.platform, zip,/, "and the archive is made with the platform's command");

  // Windows' tar.exe is bsdtar. Where bsdtar is available, run the exact
  // Windows command and check the zip holds the same entries, with no "./".
  const { execFileSync } = await import("node:child_process");
  let version = "";
  try { version = execFileSync("tar", ["--version"], { encoding: "utf8" }); } catch { /* no tar */ }
  if (!version.includes("bsdtar")) { t.diagnostic("bsdtar not available here; Windows archive format not exercised"); return; }
  const stage = await tempDirectory(t);
  await mkdir(join(stage, "leaderboard-service", "public"), { recursive: true });
  await writeFile(join(stage, "package.json"), "{}");
  await writeFile(join(stage, "leaderboard-service", "server.mjs"), "x");
  await writeFile(join(stage, "leaderboard-service", "public", "index.html"), "y");
  const zip = join(stage, "..", `${stage.split("/").at(-1)}.zip`);
  t.after(() => rm(zip, { force: true }));
  const [command, args] = archiveCommand("win32", zip, ["leaderboard-service", "package.json"]);
  execFileSync(command, args, { cwd: stage });
  const header = (await readFile(zip)).subarray(0, 4);
  assert.deepEqual([...header], [0x50, 0x4b, 0x03, 0x04], "a zip, not a tar");
  const listing = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).trim().split("\n").filter(name => !name.endsWith("/")).sort();
  assert.deepEqual(listing, ["leaderboard-service/public/index.html", "leaderboard-service/server.mjs", "package.json"]);
});

// --- Review round 27 ---------------------------------------------------------

test("configure will not keep keys from a file others could read, but hardens one without keys", async t => {
  const { chmod, stat } = await import("node:fs/promises");
  const { configure } = await import("../scripts/configure-leaderboard.mjs");
  const directory = await tempDirectory(t);
  const url = "https://commit-and-sip-leaderboard.azurewebsites.net";
  const file = join(directory, "local-config.json");
  await configure({ configFile: file, url, access: { platform: POSIX } });
  await chmod(file, 0o644);                                    // restored from a backup
  const before = await readFile(file, "utf8");
  await assert.rejects(() => configure({ configFile: file, url, access: { platform: POSIX } }),
    { code: "config_exposed" });
  await assert.rejects(() => configure({ configFile: file, url, access: { platform: POSIX } }), /Rotate them/);
  assert.equal(await readFile(file, "utf8"), before, "the exposed keys were not reported as kept, nor rewritten");

  await chmod(file, 0o600);
  assert.deepEqual((await configure({ configFile: file, url, access: { platform: POSIX } })).generated, [], "private keys are kept");

  const urlOnly = join(directory, "url-only.json");
  await writeFile(urlOnly, JSON.stringify({ leaderboardUrl: "https://example.org/board" }));
  await chmod(urlOnly, 0o644);
  const fresh = await configure({ configFile: urlOnly, url, access: { platform: POSIX } });
  assert.deepEqual(fresh.generated, ["boothKey", "staffKey"]);
  assert.equal((await stat(urlOnly)).mode & 0o777, 0o600, "rewritten owner-only");
});

test("a failed takedown keeps its cause, and staff are told the fix for that cause", async t => {
  const { publicBoardText } = await import("../scripts/remove-drink.mjs");
  const causes = [
    [Object.assign(new Error("401"), { code: "unauthorized", status: 401 }), /refused this machine's staff key.*--from/],
    [Object.assign(new Error("503"), { code: "reservation_key_mismatch", status: 503 }), /outdated reservation key/],
    [Object.assign(new Error("404"), { code: "not_found", status: 404 }), /may need redeploying/],
    [Object.assign(new Error("200"), { code: "unexpected_response", status: 200 }), /may need redeploying/],
    [Object.assign(new Error("500"), { code: "server_error", status: 500 }), /refused it \(500 server_error\)/],
    [new TypeError("fetch failed"), /could not be reached/],
  ];
  for (const [error, advice] of causes) {
    let fail = true;
    const client = { async publish(sent) { return { ...sent, entries: 1, rank: 1 }; },
      async retract() { if (fail) throw error; return "retracted"; } };
    const { engine, store } = await engineWith(t, client);
    await engine.open({ runId: "booth-1" });
    const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
    await engine.publish("booth-1");
    const removal = await engine.removeDrink({ id: served.submission.id, reason: "test", removedBy: "lead" });
    assert.equal(removal.published, "failed");
    assert.match(removal.cause, advice, error.message);
    assert.match(publicBoardText(removal.published, removal.failure), advice);
    assert.match((await engine.adminOverview()).removals[0].cause, advice);
    assert.match(publicBoardText("failed", (await engine.retryRetractions())[0].failure), advice, "and on --retry");

    fail = false;                                              // the cause is fixed
    await engine.retryRetractions();
    const settled = (await store.read()).removals[0];
    assert.equal(settled.published, "retracted");
    assert.equal(settled.failure, undefined, "a settled takedown carries no stale cause");
    assert.equal((await engine.adminOverview()).removals[0].cause, null);
  }
});

test("the dashboard reports publishing and the attendee link separately", async t => {
  const publishOnly = { async publish(sent) { return { ...sent, entries: 1, rank: 1 }; } };
  const staff = { ...publishOnly, async retract() { return "absent"; } };
  assert.deepEqual((await (await engineWith(t, null)).engine.adminOverview()).publishing, { enabled: false, takedowns: false });
  assert.deepEqual((await (await engineWith(t, publishOnly)).engine.adminOverview()).publishing, { enabled: true, takedowns: false });
  const { engine } = await engineWith(t, staff);
  const overview = await engine.adminOverview();
  assert.deepEqual(overview.publishing, { enabled: true, takedowns: true });
  assert.equal(overview.leaderboardUrl, null, "publishing with no attendee link is a real, reported state");
  const renderer = await readFile(new URL("../.github/extensions/commit-and-sip/renderer/admin.js", import.meta.url), "utf8");
  assert.match(renderer, /line\(list, !publishing\.enabled/, "publishing is rendered from its own status");
  assert.match(renderer, /line\(list, state\.leaderboardUrl\s*\? `Attendee link \(QR\)/, "the attendee link from its own");
  assert.match(renderer, /if \(published === "failed" && cause\) return/, "and a failed takedown shows its cause");
});

test("a board with two rows under one handle is refused", async t => {
  const directory = await tempDirectory(t);
  const file = join(directory, "default.json");
  const text = JSON.stringify({ entries: [entry("mona-a"), { ...entry("mona-b"), handle: entry("mona-a").handle }], reserved: [], version: 1 });
  await writeFile(file, text);
  await assert.rejects(() => openStore({ directory }), /two entries with handle/);
  assert.equal(await readFile(file, "utf8"), text);
});

// --- Review round 28 ---------------------------------------------------------

test("an ACL can expose a 0600 key file; it is detected, and stripped when written", async t => {
  const { readableByOthers } = await import("../.github/extensions/commit-and-sip/domain.mjs");
  const file = "/tmp/x";
  const ls = stdout => async () => ({ stdout });
  const directory = await tempDirectory(t);
  const target = join(directory, "keys.json");
  await writeFile(target, "{}", { mode: 0o600 });
  const exposed = (platform, run) => readableByOthers(target, { platform, run });
  // macOS: entries are listed under the mode line; "+" is hidden by any xattr.
  assert.equal(await exposed("darwin", ls(`-rw-------@ 1 me  staff  2 Jan 1 00:00 ${file}\n 0: group:everyone allow read\n`)), true);
  assert.equal(await exposed("darwin", ls(`-rw-------@ 1 me  staff  2 Jan 1 00:00 ${file}\n 0: group:everyone deny delete\n`)), false);
  assert.equal(await exposed("darwin", ls(`-rw-------@ 1 me  staff  2 Jan 1 00:00 ${file}\n`)), false);
  // Linux: "+" after the mode is an ACL; "." is an SELinux context, not one.
  assert.equal(await exposed("linux", ls(`-rw-------+ 1 me me 2 Jan 1 00:00 ${file}\n`)), true);
  assert.equal(await exposed("linux", ls(`-rw-------. 1 me me 2 Jan 1 00:00 ${file}\n`)), false);
  assert.equal(await exposed("linux", ls(`-rw------- 1 me me 2 Jan 1 00:00 ${file}\n`)), false);
  // Could not look: counts as exposed.
  assert.equal(await exposed("darwin", async () => { throw new Error("ls failed"); }), true);
});

test("on macOS, a real ACL entry is refused, and configure never inherits one", { skip: process.platform !== "darwin" && "macOS ACLs" }, async t => {
  const { execFileSync } = await import("node:child_process");
  const { chmod } = await import("node:fs/promises");
  const { loadStaffConfig, readableByOthers } = await import("../.github/extensions/commit-and-sip/domain.mjs");
  const { configure } = await import("../scripts/configure-leaderboard.mjs");
  const url = "https://commit-and-sip-leaderboard.azurewebsites.net";
  const directory = await tempDirectory(t);
  const file = join(directory, "local-config.json");
  await configure({ configFile: file, url });
  assert.equal(await readableByOthers(file), false);
  execFileSync("/bin/chmod", ["+a", "everyone allow read", file]);     // the mode still says 0600
  await chmod(file, 0o600);
  await assert.rejects(() => loadStaffConfig(file), { code: "config_exposed" });
  await assert.rejects(() => loadStaffConfig(file), /chmod -N/);
  await assert.rejects(() => configure({ configFile: file, url }), { code: "config_exposed" }, "its keys are not kept either");

  // A folder whose ACL every new file inherits: the key file is written without it.
  const shared = await tempDirectory(t);
  execFileSync("/bin/chmod", ["+a", "everyone allow read,file_inherit", shared]);
  const inherited = join(shared, "local-config.json");
  await configure({ configFile: inherited, url });
  assert.doesNotMatch(execFileSync("/bin/ls", ["-led", inherited], { encoding: "utf8" }), /allow/);
  assert.ok((await loadStaffConfig(inherited)).leaderboardApi);
});

test("the dashboard's Refresh and retry button sends the refresh action", async () => {
  const html = await readFile(new URL("../.github/extensions/commit-and-sip/renderer/admin.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../.github/extensions/commit-and-sip/renderer/admin.js", import.meta.url), "utf8");
  assert.match(html, /<button id="admin-refresh" type="button">Refresh and retry<\/button>/);
  assert.match(script, /\$\("admin-refresh"\)\.addEventListener\("click", \(\) => act\("refresh", \{\}\)\)/);
  assert.doesNotMatch(script, /Refresh to retry/, "every instruction names the button that retries");
});

test("a key file whose ACL could not be stripped is never written to", async t => {
  const { restrictToOwner } = await import("../scripts/configure-leaderboard.mjs");
  const directory = await tempDirectory(t);
  const file = join(directory, "keys.tmp");
  await writeFile(file, "", { mode: 0o600 });
  // Linux without the acl tools, on a file that still carries an ACL.
  const run = async command => {
    if (command === "setfacl") throw Object.assign(new Error("spawn setfacl ENOENT"), { code: "ENOENT" });
    return { stdout: `-rw-------+ 1 me me 0 Jan 1 00:00 ${file}\n` };
  };
  await assert.rejects(() => restrictToOwner(file, { platform: "linux", run }), /Could not make .* private.*no keys were written/);
  const clean = async command => (command === "setfacl" ? { stdout: "" } : { stdout: `-rw------- 1 me me 0 Jan 1 00:00 ${file}\n` });
  await restrictToOwner(file, { platform: "linux", run: clean });
});

// --- Review round 29 ---------------------------------------------------------

test("a late success never overwrites a refusal, and the resend reports the refusal that won", async t => {
  const lostBoard = gate();
  const onWire = gate();
  let sends = 0;
  const client = {
    async publish(sent) {
      sends += 1;
      if (sends === 1) { onWire.open(); await lostBoard.opened; return { ...sent, entries: 1, rank: 1 }; }   // the lost board, answering late
      throw Object.assign(new Error("409 duplicate_drink"), { code: "duplicate_drink", status: 409 });     // the replacement
    },
  };
  const { engine, store } = await engineWith(t, client);
  await engine.open({ runId: "booth-1" });
  await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  const stale = engine.publish("booth-1", { again: true });
  await onWire.opened;
  const refused = await engine.publish("booth-1", { again: true });
  assert.equal(refused.state, "rejected");
  lostBoard.open();
  const late = await stale;
  const sync = (await store.read()).runs["booth-1"].sync;
  assert.equal(sync.state, "rejected", "the late success did not bring the lost board's rank back");
  assert.equal(sync.receipt, undefined);
  assert.equal(late.state, "rejected", "and the late attempt reports the state that won, not success");
});

test("permission checks follow a symbolic link to the file actually read", { skip: process.platform !== "darwin" && "macOS ACLs" }, async t => {
  const { execFileSync } = await import("node:child_process");
  const { symlink } = await import("node:fs/promises");
  const { loadStaffConfig, readableByOthers } = await import("../.github/extensions/commit-and-sip/domain.mjs");
  const directory = await tempDirectory(t);
  const target = join(directory, "real-config.json");
  await writeFile(target, JSON.stringify({ leaderboardApi: { boothKey: "b".repeat(64), staffKey: "s".repeat(64), url: "https://example.org" } }), { mode: 0o600 });
  execFileSync("/bin/chmod", ["+a", "everyone allow read", target]);   // 0600, but readable through its ACL
  const link = join(directory, "local-config.json");
  await symlink(target, link);
  assert.equal(await readableByOthers(link), true, "the target's ACL is what counts");
  await assert.rejects(() => loadStaffConfig(link), { code: "config_exposed" });
  execFileSync("/bin/chmod", ["-N", target]);
  assert.equal(await readableByOthers(link), false);
});

// --- Review round 30 ---------------------------------------------------------

test("the credential file is never packaged under any spelling of its case", async () => {
  const { win32, posix } = await import("node:path");
  const { isNeverPackaged } = await import("../scripts/package-leaderboard.mjs");
  for (const file of ["C:\\repo\\BOOTH\\LOCAL-CONFIG.JSON", "C:\\repo\\booth\\Local-Config.json", "c:\\REPO\\booth\\local-config.json"]) {
    assert.equal(isNeverPackaged(file, { paths: win32, root: "C:\\repo" }), true, file);
  }
  for (const file of ["/repo/BOOTH/local-config.json", "/repo/booth/LOCAL-CONFIG.JSON"]) {   // macOS volumes ignore case too
    assert.equal(isNeverPackaged(file, { paths: posix, root: "/repo" }), true, file);
  }
  assert.equal(isNeverPackaged("C:\\repo\\booth\\handle-words.json", { paths: win32, root: "C:\\repo" }), false);
});

test("the runbook gives a supported way to back up and to recover a lost reservation key", async () => {
  const runbook = await readFile(new URL("../booth/RUNBOOK.md", import.meta.url), "utf8");
  const section = runbook.slice(runbook.indexOf("#### Backing up and recovering the reservation key"));
  assert.match(section, /cat \/home\/data\/commit-and-sip\/reservation\.key/);
  assert.match(section, /mv \/home\/data\/commit-and-sip\/<EVENT_ID>\.json/, "the board is preserved, not deleted");
  assert.match(section, /On \*\*every\*\* booth machine, run `npm run leaderboard:republish -- --takedowns`/);
  assert.match(section, /Only when every booth has finished, run `npm run leaderboard:republish -- --open` once, then `npm run leaderboard:republish -- --drinks` on each/);
  assert.match(section, /closed to drinks meanwhile/);
  assert.match(section, /archived and wiped.*blocklist/s, "and the limit is stated with its remedy");
});

// --- Review round 31 ---------------------------------------------------------

test("a slow retry sweep runs in the background: the dashboard is answered promptly, and never twice", async t => {
  const slow = gate();
  let retractions = 0;
  const client = {
    async publish(sent) { return { ...sent, entries: 1, rank: 1 }; },
    async retract() { retractions += 1; if (retractions === 1) throw new Error("offline"); await slow.opened; return "retracted"; },
  };
  const { engine } = await engineWith(t, client);
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  await engine.publish("booth-1");
  const panel = new AdminPanel(engine, { sweepWaitMs: 50 });
  await panel.dispatch("remove_drink", { id: served.submission.id, reason: "test", removedBy: "lead" });

  const started = Date.now();
  const first = await panel.dispatch("refresh", {});
  assert.ok(Date.now() - started < 1000, "answered while the retry is still on the wire");
  assert.equal(first.retrying, true);
  assert.equal(first.removals[0].published, "failed", "and what it shows is what is recorded so far");
  const second = await panel.dispatch("refresh", {});
  assert.equal(second.retrying, true);
  assert.equal(retractions, 2, "a second Refresh joined the sweep instead of starting another");

  slow.open();
  await panel.sweep;
  const after = await panel.get();
  assert.equal(after.retrying, false);
  assert.equal(after.removals[0].published, "retracted");

  const renderer = await readFile(new URL("../.github/extensions/commit-and-sip/renderer/admin.js", import.meta.url), "utf8");
  assert.match(renderer, /poll = retrying \? setTimeout\(\(\) => \{ void load\(\); \}, 2000\) : null;/, "the dashboard polls until the sweep ends");
});

// --- Review round 32 ---------------------------------------------------------

test("a takedown replay is recorded as owed before it is sent, and a failed one stays owed", async t => {
  const { WIPE_CONFIRMATION } = await import("../.github/extensions/commit-and-sip/services/event-archive.mjs");
  const held = gate();
  const asked = gate();
  let replayFails = false;
  let calls = 0;
  const client = {
    async publish(sent) { return { ...sent, entries: 1, rank: 1 }; },
    async retract() {
      calls += 1;
      if (calls === 1) return "retracted";                     // the original takedown, on the board later lost
      asked.open(); await held.opened;
      if (replayFails) throw new TypeError("fetch failed");
      return "absent";
    },
  };
  const { engine, store } = await engineWith(t, client);
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  await engine.dispatch("booth-1", "complete", {});
  await engine.publish("booth-1");
  assert.equal((await engine.removeDrink({ id: served.submission.id, reason: "test", removedBy: "lead" })).published, "retracted");

  // While the replay is on the wire, the ledger already says it is owed.
  replayFails = true;
  const rebuilding = engine.republishAll();
  await asked.opened;
  assert.equal((await store.read()).removals[0].published, "replaying");
  assert.equal((await engine.owedPublicTakedowns()).length, 1);
  assert.equal((await engine.adminOverview()).removals[0].owed, true);
  held.open();
  const { blocked } = await rebuilding;
  assert.equal(blocked, true);

  // The failure is recorded, so the dashboard, retries and the wipe all see it.
  const record = (await store.read()).removals[0];
  assert.equal(record.published, "failed");
  assert.deepEqual(record.failure, { code: null, status: null });
  await assert.rejects(() => engine.archiveAndWipe({ archivedBy: "lead", confirm: WIPE_CONFIRMATION }), { code: "takedowns_owed" });
  replayFails = false;
  await engine.retryRetractions();
  assert.equal((await store.read()).removals[0].published, "absent");
});

test("a handle the service cannot place is a final refusal, not an endless retry", async t => {
  const { syncView, TERMINAL_REJECTIONS } = await import("../.github/extensions/commit-and-sip/services/leaderboard.mjs");
  assert.ok(TERMINAL_REJECTIONS.includes("handle_taken"));
  let sends = 0;
  const client = { async publish() { sends += 1; throw Object.assign(new Error("409 handle_taken"), { code: "handle_taken", status: 409 }); } };
  const { engine, store } = await engineWith(t, client);
  await engine.open({ runId: "booth-1" });
  await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  await engine.publish("booth-1");
  assert.equal((await store.read()).runs["booth-1"].sync.state, "rejected");
  await engine.retryPublications();
  await engine.republishAll();
  assert.equal(sends, 1, "never resent, by a sweep or a rebuild");
  assert.match(syncView({ code: "handle_taken", state: "rejected" }).message, /could not list it under your handle/);
  assert.match(syncView({ code: "duplicate_drink", state: "rejected" }).message, /did not accept this name/);
});

// --- Review round 33 ---------------------------------------------------------

test("the background sweep interval is shared by every station on the machine", async () => {
  const { BoothPanel } = await import("../.github/extensions/commit-and-sip/booth-panel.mjs");
  let sweeps = 0;
  const engine = { retryPublications: async () => { sweeps += 1; } };
  const stations = [new BoothPanel(engine), new BoothPanel(engine), new BoothPanel(engine)];
  // Staggered idle polls from three stations within one interval.
  stations[0].sweepInBackground(1_000);
  stations[1].sweepInBackground(4_000);
  stations[2].sweepInBackground(9_000);
  assert.equal(sweeps, 1, "one sweep for the machine, not one per station");
  stations[1].sweepInBackground(31_500);
  assert.equal(sweeps, 2);
});

test("the board page personalises only with a publication reference, never on a handle alone", async () => {
  const page = await readFile(new URL("../leaderboard-service/public/board.js", import.meta.url), "utf8");
  assert.match(page, /const personal = params\.get\("handle"\) && params\.get\("ref"\)/);
  assert.doesNotMatch(page, /\bif \(handle\b|else if \(handle\b|!handle\b/, "no branch keys off the handle alone");
  assert.match(page, /\} else if \(personal && board\.you === null\) \{/, "'not on the board' is said only about a referenced drink");
});

// --- Review round 34 ---------------------------------------------------------

test("a staff key without a booth key is never reused, and --from cannot name this machine's own config", async t => {
  const { chmod } = await import("node:fs/promises");
  const { configure } = await import("../scripts/configure-leaderboard.mjs");
  const directory = await tempDirectory(t);
  const url = "https://commit-and-sip-leaderboard.azurewebsites.net";
  const partial = join(directory, "partial.json");
  const text = JSON.stringify({ leaderboardApi: { staffKey: "s".repeat(64), url } });
  await writeFile(partial, text);
  await chmod(partial, 0o644);                                  // perhaps read by others; never checked as "fresh"
  let minted = 0;
  await assert.rejects(() => configure({ configFile: partial, key: () => { minted += 1; return "k".repeat(64); }, url }),
    { code: "invalid_config" });
  await assert.rejects(() => configure({ configFile: partial, url }), /staffKey but no boothKey.*exposed/);
  assert.equal(minted, 0);
  assert.equal(await readFile(partial, "utf8"), text, "nothing was written");

  // --from naming the target itself, directly or through a link.
  const own = join(directory, "local-config.json");
  await configure({ configFile: own, url });
  const before = await readFile(own, "utf8");
  await assert.rejects(() => configure({ configFile: own, from: own, url }), /names this machine's own config/);
  const { symlink } = await import("node:fs/promises");
  await symlink(own, join(directory, "alias.json"));
  await assert.rejects(() => configure({ configFile: own, from: join(directory, "alias.json"), url }), /own config/);
  assert.equal(await readFile(own, "utf8"), before);
});

test("removing a drink this booth never published raises no public-board alarm", async t => {
  const { removalReport } = await import("../scripts/remove-drink.mjs");
  const { engine } = await engineWith(t, null);                  // a booth that does not publish
  await engine.open({ runId: "booth-1" });
  const served = await engine.dispatch("booth-1", "submit_name", { name: "Mona Moonrise Mocha" });
  const removed = await engine.removeDrink({ id: served.submission.id, reason: "test", removedBy: "lead" });
  assert.deepEqual([removed.published, removed.owed], ["not-configured", false]);
  const report = removalReport(removed);
  assert.equal(report.exitCode, 0);
  assert.doesNotMatch(report.text, /NOT off|copy the deployed keys/);
  assert.match(report.text, /never on the public leaderboard from this booth/);
  // A settled outcome is still reported as what it is.
  assert.match(removalReport({ ...removed, owed: false, published: "absent" }).text, /It was not on the public leaderboard\./);
});

// --- Review round 35 ---------------------------------------------------------

test("a multi-booth rebuild runs in two phases, and a booth cannot send drinks before its own takedowns", async t => {
  const { parsePhase } = await import("../scripts/republish-leaderboard.mjs");
  assert.deepEqual(parsePhase(["--takedowns"]), { drinks: false, takedowns: true });
  assert.deepEqual(parsePhase(["--drinks"]), { drinks: true, takedowns: false });
  assert.deepEqual(parsePhase(["--all"]), { drinks: true, takedowns: true });
  for (const argv of [[], ["--takedowns", "--drinks"], ["--everything"]]) {
    assert.throws(() => parsePhase(argv), /--takedowns \| --open \| --drinks \| --all/, "the phase is always named");
  }

  // Two booths that took down different names, rebuilding onto an empty board.
  const board = await service(t);
  const to = url => createLeaderboardClient({ boothKey: BOOTH_KEY, staffKey: STAFF_KEY, url });
  const lost = await service(t);
  const boothA = (await engineWith(t, to(lost.url))).engine;
  const boothB = (await engineWith(t, to(lost.url))).engine;
  await boothA.open({ runId: "a-1" });
  await boothA.dispatch("a-1", "submit_name", { name: "Ducky Dawn Drizzle" });
  await boothA.publish("a-1");
  await boothB.open({ runId: "b-1" });
  const takenDownAtB = await boothB.dispatch("b-1", "submit_name", { name: "Mona Moonrise Mocha" });
  await boothB.publish("b-1");
  await boothB.removeDrink({ id: takenDownAtB.submission.id, reason: "test", removedBy: "lead" });
  boothA.leaderboardClient = to(board.url);
  boothB.leaderboardClient = to(board.url);

  // Drinks before this booth's own takedown phase: refused, nothing sent.
  const early = await boothA.republishAll({ takedowns: false });
  assert.deepEqual([early.blocked, early.reason], [true, "takedowns_not_replayed"]);
  assert.equal((await fetch(`${board.url}/api/board`).then(r => r.json())).total, 0);

  // Phase one on every booth, then phase two on every booth.
  for (const booth of [boothA, boothB]) assert.equal((await booth.republishAll({ drinks: false })).blocked, false);
  assert.equal((await fetch(`${board.url}/api/board`).then(r => r.json())).total, 0, "phase one sends no drink");
  for (const booth of [boothA, boothB]) assert.equal((await booth.republishAll({ takedowns: false })).blocked, false);
  assert.deepEqual((await fetch(`${board.url}/api/board`).then(r => r.json())).entries.map(row => row.name), ["Ducky Dawn Drizzle"]);
  assert.equal((await post(board.url, submission("Mona Moonrise Mocha", OTHER_HANDLE))).status, 409, "B's takedown was in place first");

  // The marker is single-use: the next rebuild starts with takedowns again.
  assert.equal((await boothA.republishAll({ takedowns: false })).reason, "takedowns_not_replayed");
});

test("the integration contract describes launch gates, not unbuilt work", async () => {
  const contract = await readFile(new URL("../docs/integration-contract.md", import.meta.url), "utf8");
  assert.doesNotMatch(contract, /Not yet built/);
  assert.match(contract, /### Launch gates\n\nThe code is built and the leaderboard service is deployed\./);
});

// --- Review round 36 ---------------------------------------------------------

test("a board created from nothing is closed to drinks until staff open it, but takes takedowns", async t => {
  const { ClosedError } = await import("../leaderboard-service/store.mjs");
  const directory = await tempDirectory(t);
  const store = await FileStore.open({ directory });
  assert.deepEqual(await store.state(), { closed: true });
  await assert.rejects(() => store.admit(entry("mona-a"), { fingerprint: fp("mona-a"), handles: [entry("mona-a").handle] }), ClosedError);
  assert.equal(await store.retract("mona-gone", fp("mona-gone")), false, "takedowns are replayed onto it");
  const reopened = await FileStore.open({ directory });
  assert.deepEqual(await reopened.state(), { closed: true }, "closed survives a restart");
  assert.equal(await reopened.isReserved(fp("mona-gone")), true);
  await reopened.openBoard();
  assert.deepEqual(await (await FileStore.open({ directory })).state(), { closed: false });
  await reopened.admit(entry("mona-a"), { fingerprint: fp("mona-a"), handles: [entry("mona-a").handle] });

  // A board written before the gate existed (the live one) is open.
  const legacy = await tempDirectory(t);
  await writeFile(join(legacy, "default.json"), JSON.stringify({ entries: [], reserved: [] }));
  assert.deepEqual(await (await FileStore.open({ directory: legacy })).state(), { closed: false });
  const bad = await tempDirectory(t);
  await writeFile(join(bad, "default.json"), JSON.stringify({ closed: "yes", entries: [], reserved: [] }));
  await assert.rejects(() => FileStore.open({ directory: bad }), /malformed closed flag/);
});

test("the service holds drinks while rebuilding, and only the staff key opens it", async t => {
  const { url } = await service(t, { store: new MemoryStore({ closed: true }) });
  const refused = await post(url, submission("Mona Moonrise Mocha"));
  assert.equal(refused.status, 503);
  assert.equal((await refused.json()).error, "board_rebuilding");
  assert.equal((await board(url)).rebuilding, true);
  const open = (body, key) => fetch(`${url}/api/board/open`, { body: JSON.stringify(body), method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` } });
  assert.equal((await open({ open: true }, BOOTH_KEY)).status, 401, "a booth key cannot open it");
  assert.equal((await open({}, STAFF_KEY)).status, 400);
  assert.equal((await open({ open: true, extra: 1 }, STAFF_KEY)).status, 400);
  assert.equal((await open({ open: true }, STAFF_KEY)).status, 200);
  assert.equal((await board(url)).rebuilding, false);
  assert.equal((await post(url, submission("Mona Moonrise Mocha"))).status, 201);
  const page = await readFile(new URL("../leaderboard-service/public/board.js", import.meta.url), "utf8");
  assert.match(page, /board\.rebuilding\s*\? "The board is being rebuilt\./, "the monitor says so too");
});

test("a rebuild holds every booth's ordinary publishing until staff open the board", async t => {
  const { parsePhase } = await import("../scripts/republish-leaderboard.mjs");
  assert.deepEqual(parsePhase(["--open"]), { open: true });
  const lost = await service(t);
  const directory = await tempDirectory(t);
  const replacement = await service(t, { store: await FileStore.open({ directory }) });   // created from nothing: closed
  const to = url => createLeaderboardClient({ boothKey: BOOTH_KEY, staffKey: STAFF_KEY, url });
  const boothA = (await engineWith(t, to(lost.url))).engine;
  const boothB = (await engineWith(t, to(lost.url))).engine;
  await boothB.open({ runId: "b-1" });
  const takenDown = await boothB.dispatch("b-1", "submit_name", { name: "Mona Moonrise Mocha" });
  await boothB.publish("b-1");
  await boothB.removeDrink({ id: takenDown.submission.id, reason: "test", removedBy: "lead" });
  boothA.leaderboardClient = to(replacement.url);
  boothB.leaderboardClient = to(replacement.url);

  // Mid-rebuild, an attendee at A invents the name B took down. A's ordinary
  // publish is held, not admitted, though B has not replayed yet.
  await boothA.open({ runId: "a-1" });
  await boothA.dispatch("a-1", "submit_name", { name: "Mona Moonrise Mocha" });
  await boothA.publish("a-1");
  const held = (await boothA.store.read()).runs["a-1"].sync;
  assert.deepEqual([held.state, held.code], ["failed", "board_rebuilding"], "kept, and retried later");
  assert.equal((await board(replacement.url)).total, 0);

  await boothB.republishAll({ drinks: false });                      // B replays its takedown
  const wrongKey = createLeaderboardClient({ boothKey: BOOTH_KEY, staffKey: "w".repeat(64), url: replacement.url });
  await assert.rejects(() => wrongKey.openBoard(), { status: 401 }, "a refused opening is reported, never assumed");
  assert.equal((await board(replacement.url)).rebuilding, true);
  await boothB.leaderboardClient.openBoard();                         // staff open the board
  await boothA.retryPublications();                                   // A's own retry, after opening
  assert.deepEqual([(await boothA.store.read()).runs["a-1"].sync.state, (await boothA.store.read()).runs["a-1"].sync.code],
    ["rejected", "unavailable_drink"], "B's takedown was in place first");
  assert.equal((await board(replacement.url)).total, 0);
});
