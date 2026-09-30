import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { newPublicationToken, submissionFor, validateReceipt } from "../.github/extensions/commit-and-sip/services/leaderboard.mjs";
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
  assert.equal((await del(url, sent.id)).status, 404, "a second retraction reports it is already gone");
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
  assert.equal((await del(url, early.id)).status, 404, "nothing was on the board");
  assert.equal((await post(url, submission("Ducky Dawn Drizzle", OTHER_HANDLE))).status, 409,
    "but the name is reserved all the same");
});

test("the stored board keeps no readable trace of a removed name", async t => {
  const directory = await tempDirectory(t);
  const key = await reservationKey(directory);
  const store = await FileStore.open({ directory });
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
  const { createHash } = await import("node:crypto");
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
  for (let index = 0; index < 25; index += 1) {
    const entry = submission(`Mona Test ${index} Mocha`);
    await store.create({ ...entry, createdAt: "2026-01-01T00:00:00Z" });
  }
  const full = await board(url);
  assert.equal(full.entries.length, 20);
  assert.equal(full.total, 25);
  assert.ok(!Number.isNaN(Date.parse(full.asOf)), "the board says when it was read");
  assert.deepEqual(Object.keys(full.entries[0]).sort(), ["handle", "name", "rank", "score"],
    "no ID, timestamp, or anything else beyond what the board shows");
  assert.equal((await board(url, `?handle=${HANDLE}`)).you.handle, HANDLE);
  assert.equal((await board(url, `?handle=${OTHER_HANDLE}`)).you, null, "an unknown handle is said to be absent");
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

const entry = (id, score = 1000) => ({ createdAt: "2026-01-01T00:00:00Z", handle: HANDLE, id, name: id, score });

test("the file store survives a restart and never overwrites on create", async t => {
  const directory = await tempDirectory(t);
  const store = await FileStore.open({ directory, event: "event-2026" });
  await store.create(entry("mona-a"));
  await store.create(entry("mona-b"));
  await assert.rejects(() => store.create(entry("mona-a", 9)), ConflictError);
  assert.equal(await store.retract("mona-b", "fp-b"), true);
  assert.equal(await store.retract("mona-b", "fp-b"), false);
  assert.equal(await store.isReserved("fp-b"), true);
  const reopened = await FileStore.open({ directory, event: "event-2026" });
  assert.deepEqual(await reopened.list(), [entry("mona-a")], "what was written is what comes back");
  assert.equal(await reopened.isReserved("fp-b"), true, "a reservation survives a restart");
  assert.deepEqual(await (await FileStore.open({ directory, event: "other" })).list(), [],
    "a new EVENT_ID starts a new board");
});

test("concurrent writes are serialised and none is lost", async t => {
  const directory = await tempDirectory(t);
  const store = await FileStore.open({ directory });
  const ids = Array.from({ length: 30 }, (_, index) => `mona-${index}`);
  await Promise.all(ids.map(id => store.create(entry(id))));
  await Promise.all(ids.slice(0, 10).map(id => store.retract(id, `fp-${id}`)));
  const reopened = await FileStore.open({ directory });
  assert.deepEqual((await reopened.list()).map(item => item.id).sort(), ids.slice(10).sort());
  assert.equal((await Promise.all(ids.slice(0, 10).map(id => reopened.isReserved(`fp-${id}`)))).every(Boolean), true);
});

test("an unreadable board is left alone and the service refuses to start", async t => {
  const directory = await tempDirectory(t);
  const file = join(directory, "default.json");
  await writeFile(file, "{ torn");
  await assert.rejects(() => FileStore.open({ directory }), /not a readable board/);
  assert.equal(await readFile(file, "utf8"), "{ torn", "starting empty would overwrite it on the next submission");
});

test("the event ID cannot walk out of the data directory", async t => {
  const directory = await tempDirectory(t);
  for (const event of ["../escape", "a/b", "UPPER", "", "x".repeat(64)]) {
    await assert.rejects(() => FileStore.open({ directory, event }), /EVENT_ID/, JSON.stringify(event));
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
  const rebuilt = new BoothEngine({ catalog, rules, store: runs,
    leaderboardClient: createLeaderboardClient({ boothKey: BOOTH_KEY, url: replacement.url }) });
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

  // A booth machine that should publish but not delete.
  const boothOnly = await configure({ configFile: join(directory, "booth.json"), staff: false, url });
  assert.equal(boothOnly.next.leaderboardApi.staffKey, undefined);
  // Later promoted to a staff machine: the booth key is kept, and the new
  // staff key must be reported, or the deployment is never told about it.
  const promoted = await configure({ configFile: join(directory, "booth.json"), url });
  assert.deepEqual(promoted.generated, ["staffKey"]);
  assert.equal(promoted.next.leaderboardApi.boothKey, boothOnly.next.leaderboardApi.boothKey);

  // Other staff settings survive, and an existing QR is left exactly as it was.
  await writeFile(join(directory, "kept.json"), JSON.stringify({ leaderboardUrl: "https://example.org/board" }));
  const kept = await configure({ configFile: join(directory, "kept.json"), url });
  assert.equal(kept.next.leaderboardUrl, "https://example.org/board");

  await assert.rejects(() => configure({ configFile, url: "http://insecure.example.org" }), { code: "invalid_config" });
  assert.throws(() => parseArguments([]), /Usage/);
  assert.deepEqual(parseArguments(["--url", url, "--no-staff-key"]), { parameters: false, staff: false, url });
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
  const store = Object.setPrototypeOf(await FileStore.open({ directory }), GatedStore.prototype);
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
  assert.equal((await retraction).status, 404);
  const published = await publication;
  assert.equal(published.status, 409, "the submission must see the reservation queued ahead of it");
  assert.equal((await published.json()).error, "unavailable_drink");
  assert.equal((await board(url)).total, 0);
});

test("a failed write leaves memory exactly as it was on disk", async t => {
  const directory = await tempDirectory(t);
  const store = await FileStore.open({ directory });
  await store.create(entry("mona-kept"));
  // The disk refuses the write after the change has been applied in memory,
  // which is the moment a rollback has to happen.
  let full = true;
  const persist = store.persist.bind(store);
  store.persist = text => (full ? Promise.reject(Object.assign(new Error("disk full"), { code: "ENOSPC" })) : persist(text));
  await assert.rejects(() => store.admit(entry("mona-lost"), { fingerprint: "fp", handles: [OTHER_HANDLE] }), { code: "ENOSPC" });
  await assert.rejects(() => store.retract("mona-kept", "fp-kept"), { code: "ENOSPC" });
  const inMemory = await MemoryStore.prototype.list.call(store);
  assert.deepEqual(inMemory.map(item => item.id), ["mona-kept"], "the failed admission is not left in memory");
  assert.equal(await MemoryStore.prototype.isReserved.call(store, "fp-kept"), false, "nor the failed reservation");
  assert.deepEqual((await store.list()).map(item => item.id), ["mona-kept"], "and the board served is what the disk holds");
  // Once the disk recovers, a retry is a fresh admission, not a false "already there".
  full = false;
  assert.equal((await store.admit(entry("mona-lost"), { fingerprint: "fp", handles: [OTHER_HANDLE] })).created, true);
  assert.deepEqual((await (await FileStore.open({ directory })).list()).map(item => item.id).sort(), ["mona-kept", "mona-lost"]);
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
  assert.equal((await board(url, `?handle=${HANDLE}&drink=${first.id}`)).you.name, first.name);
  assert.equal((await board(url, `?handle=${HANDLE}&drink=${second.id}`)).you.name, second.name);
  assert.equal((await board(url, `?handle=${secondReceipt.handle}&drink=${second.id}`)).you.name, second.name);
  assert.equal((await board(url, `?handle=${HANDLE}&drink=someone-else`)).you, null);
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
  assert.equal((await rebuilt.store.read()).removals[0].published, "retracted", "a settled outcome is not rewritten");

  // A booth without a staff key cannot restore reservations, and says so.
  const boothOnly = new BoothEngine({ catalog, rules, store: runs,
    leaderboardClient: createLeaderboardClient({ boothKey: BOOTH_KEY, url: replacement.url }) });
  assert.deepEqual((await boothOnly.republishAll()).removals, [{ id: removed.submission.id, published: "not-configured" }]);
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
  const store = await FileStore.open({ directory });
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
  const owner = (await board(lost.url, `?handle=${a.handle}&drink=mona-moonrise-mocha`)).you;
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
  const store = Object.setPrototypeOf(await FileStore.open({ directory }), SlowDisk.prototype);
  const admitting = store.admit(entry("mona-pending"), { fingerprint: "fp", handles: [HANDLE] });
  const pending = Symbol("pending");
  const tick = () => new Promise(resolve => setImmediate(() => resolve(pending)));
  assert.equal(await Promise.race([store.list(), tick()]), pending, "list waits for the write in progress");
  assert.equal(await Promise.race([store.get("mona-pending"), tick()]), pending);
  assert.equal(await Promise.race([store.isReserved("fp"), tick()]), pending);

  // The write then fails. The entry must never have been visible.
  await rm(directory, { force: true, recursive: true });
  const reading = store.list();
  land();
  await assert.rejects(admitting, { code: "ENOENT" });
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
  assert.match(report.text, /add the staff key to this machine/, "the fix names this machine, which holds the removal");
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
  const [a, b] = await Promise.all([FileStore.open({ directory }), FileStore.open({ directory })]);
  const ids = Array.from({ length: 24 }, (_, index) => `mona-${index}`);
  await Promise.all(ids.map((id, index) => (index % 2 ? a : b)
    .admit(entry(id), { fingerprint: `fp-${id}`, handles: [`${HANDLE}-${String(index).padStart(8, "0")}`] })));
  const fresh = await FileStore.open({ directory });
  assert.deepEqual((await fresh.list()).map(item => item.id).sort(), [...ids].sort(), "every write from both instances survived");
  assert.equal((await a.list()).length, 24, "each instance reads what the other wrote");
  assert.equal((await b.get("mona-1")).id, "mona-1");
});

test("a takedown on one instance stops a submission arriving at the other", async t => {
  const directory = await tempDirectory(t);
  const [a, b] = await Promise.all([FileStore.open({ directory }), FileStore.open({ directory })]);
  await a.retract("mona-moonrise-mocha", "fp-moonrise");
  const { ReservedError } = await import("../leaderboard-service/store.mjs");
  await assert.rejects(() => b.admit(entry("mona-moonrise-mocha"), { fingerprint: "fp-moonrise", handles: [HANDLE] }), ReservedError);
  assert.equal(await b.isReserved("fp-moonrise"), true);
});

test("a lock left by a dead instance is taken over; a live one is waited for", async t => {
  const { utimes } = await import("node:fs/promises");
  const directory = await tempDirectory(t);
  const lock = join(directory, "default.json.lock");
  const store = await FileStore.open({ directory, lockTimeoutMs: 150, staleLockMs: 1_000 });

  await writeFile(lock, "live-instance");
  await assert.rejects(() => store.create(entry("mona-waited")), { code: "board_locked" });
  assert.equal(await readFile(lock, "utf8"), "live-instance", "another instance's live lock is never broken");

  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  await store.create(entry("mona-after-crash"));
  assert.deepEqual((await store.list()).map(item => item.id), ["mona-after-crash"], "a dead instance's lock does not block the board");
  const { access } = await import("node:fs/promises");
  await assert.rejects(() => access(lock), { code: "ENOENT" }, "and the lock is released afterwards");
});

test("a holder whose lease was taken over cannot commit over the new holder", async t => {
  const { utimes } = await import("node:fs/promises");
  const directory = await tempDirectory(t);
  const lock = join(directory, "default.json.lock");
  const [a, b] = await Promise.all([FileStore.open({ directory, staleLockMs: 60 }), FileStore.open({ directory, staleLockMs: 60 })]);
  // A stalls long enough to lose its lease: no renewal while it is frozen.
  a.renewLease = () => () => {};
  // The exact interleaving from the review: A has passed its version check
  // and is about to rename when B takes over the stale lease and commits.
  let stalled = false;
  const persist = a.persist.bind(a);
  a.persist = async (text, owner) => {
    if (!stalled) {
      stalled = true;
      const old = new Date(Date.now() - 60_000);
      await utimes(lock, old, old);
      await b.create(entry("mona-from-b"));
    }
    return persist(text, owner);
  };
  await a.create(entry("mona-from-a"));
  const fresh = await FileStore.open({ directory });
  assert.deepEqual((await fresh.list()).map(item => item.id).sort(), ["mona-from-a", "mona-from-b"],
    "A found it no longer held the lease, did not rename, and retried from disk");
});

test("a live holder renews its lease, so a slow write is never taken over", async t => {
  const directory = await tempDirectory(t);
  const [a, b] = await Promise.all([
    FileStore.open({ directory, staleLockMs: 90 }),
    FileStore.open({ directory, lockTimeoutMs: 250, staleLockMs: 90 }),
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
  assert.deepEqual((await (await FileStore.open({ directory })).list()).map(item => item.id), ["mona-slow"]);
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
  const source = await readFile(new URL("../scripts/remove-drink.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(record\.owed\) process\.exitCode = 1;/);
});

test("two writers that ever overlap cannot trample each other's temporary file", async t => {
  // The lock normally prevents this; the unique temporary name is the defence
  // for the moment it does not (a lease judged stale while its holder still
  // writes). Every overlapping write must land whole.
  const directory = await tempDirectory(t);
  const [a, b] = await Promise.all([FileStore.open({ directory }), FileStore.open({ directory })]);
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
  assert.match(served.attendeeUrl, /drink=mona-moonrise-mocha/, "before the refusal a link is offered");
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
  const { stat, utimes } = await import("node:fs/promises");
  const directory = await tempDirectory(t);
  const store = await FileStore.open({ directory, staleLockMs: 60 });   // renews every 20ms
  const lock = join(directory, "default.json.lock");
  const old = new Date(Date.now() - 60_000);
  const stop = store.renewLease("mine");
  t.after(stop);

  await writeFile(lock, "someone-else");
  await utimes(lock, old, old);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.ok(Date.now() - (await stat(lock)).mtimeMs > 30_000,
    "a lease this instance lost is left to go stale, so a dead holder cannot be kept alive");

  await writeFile(lock, "mine");
  await utimes(lock, old, old);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.ok(Date.now() - (await stat(lock)).mtimeMs < 1_000, "its own lease is renewed");
});
