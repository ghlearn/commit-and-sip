import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DomainError } from "../.github/extensions/commit-and-sip/domain.mjs";
import { leaderboard } from "../.github/extensions/commit-and-sip/services/booth-menu.mjs";
import { canonicalHandle, PUBLICATION_TOKEN, publicRef, tokenHashOf } from "../.github/extensions/commit-and-sip/services/leaderboard.mjs";
import { blocklistStatus } from "../.github/extensions/commit-and-sip/services/moderation.mjs";
import { scoreCoffeeName } from "../.github/extensions/commit-and-sip/services/name-score.mjs";
import { HandleTakenError, ReservedError } from "./store.mjs";

// The public leaderboard for the Commit & Sip booth.
//
// Reading is open to anyone who scans the booth QR. Writing is not: a booth
// submits with a booth key and staff retract with a staff key. The keys are
// only the first line. Every submission is re-scored and re-moderated here
// with the booth's own modules, so even a leaked booth key cannot post a score
// the rubric did not award, a name the blocklist refuses, or a handle that was
// not built from the curated word lists. Ranking is the booth's own
// `leaderboard()`, so the booth and this board cannot disagree about a tie.

const MAX_BODY_BYTES = 2048;
const BOARD_SIZE = 20;
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const HANDLE = /^([a-z]+)-([a-z]+)-([a-z]+)(?:-[0-9a-f]{8})?$/;
const SUBMISSION_KEYS = ["handle", "id", "name", "score", "token"];

const renderer = path => new URL(`../.github/extensions/commit-and-sip/renderer/${path}`, import.meta.url);
const STATIC = {
  "/": { file: new URL("./public/index.html", import.meta.url), type: "text/html; charset=utf-8" },
  "/board.css": { file: new URL("./public/board.css", import.meta.url), type: "text/css; charset=utf-8" },
  "/board.js": { file: new URL("./public/board.js", import.meta.url), type: "text/javascript; charset=utf-8" },
  "/fonts/MonaSansVF.woff2": { file: renderer("fonts/MonaSansVF.woff2"), type: "font/woff2" },
  // The font licence requires the notice to travel with the font.
  "/fonts/OFL.txt": { file: renderer("fonts/OFL.txt"), type: "text/plain; charset=utf-8" },
};

// No inline script or style anywhere, so the policy can forbid both.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "font-src 'self'",
  "connect-src 'self'", "img-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    Object.assign(this, { status, code });
  }
}

export function handleIsCurated(handle, words) {
  const match = typeof handle === "string" ? HANDLE.exec(handle) : null;
  return Boolean(match) && words.adjectives.includes(match[1]) && words.verbs.includes(match[2])
    && words.nouns.includes(match[3]);
}

// Comparing digests keeps the comparison constant-time regardless of what
// length the caller sent.
function keyMatches(header, expected) {
  const match = typeof header === "string" ? /^Bearer (\S+)$/.exec(header) : null;
  if (!match) return false;
  const digest = value => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(match[1]), digest(expected));
}

function requireKey(request, expected) {
  if (!keyMatches(request.headers.authorization, expected)) {
    throw new HttpError(401, "unauthorized", "A valid key is required.");
  }
}

async function readJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw new HttpError(415, "unsupported_media_type", "Send application/json.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "The request body is too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "invalid_json", "The request body is not valid JSON."); }
}

function validateSubmission(body, rules, words) {
  const shaped = body && typeof body === "object" && !Array.isArray(body)
    && Object.keys(body).sort().join() === SUBMISSION_KEYS.join()
    && typeof body.handle === "string" && typeof body.id === "string"
    && typeof body.name === "string" && Number.isSafeInteger(body.score)
    && typeof body.token === "string" && PUBLICATION_TOKEN.test(body.token);
  if (!shaped) throw new HttpError(400, "invalid_submission", `Send exactly ${SUBMISSION_KEYS.join(", ")}.`);
  if (!handleIsCurated(body.handle, words)) {
    throw new HttpError(422, "invalid_handle", "The handle was not built from the booth's word lists.");
  }
  let scored;
  try {
    scored = scoreCoffeeName(body.name, rules);
  } catch (error) {
    // The booth has its own copy of these rules, so reaching this means the
    // two disagree or someone is posting directly. Either way, staff read the
    // reason from the booth's sync record; the public learns nothing from it.
    if (error instanceof DomainError) throw new HttpError(422, "rejected_name", "The booth rules refuse this name.");
    throw error;
  }
  if (scored.name !== body.name || scored.id !== body.id || scored.score !== body.score) {
    throw new HttpError(422, "score_mismatch", "The submitted score is not what the rubric awards this name.");
  }
  return { handle: body.handle, id: scored.id, name: scored.name, score: scored.score, token: body.token };
}

function receiptFor(entry, entries) {
  const board = leaderboard(entries);
  const row = board.find(item => item.handle === entry.handle && item.name === entry.name);
  // ID, name and score echo exactly what arrived; the handle is the one stored,
  // which is the submitted handle or its canonical form. The booth checks both.
  return { entries: board.length, handle: entry.handle, id: entry.id, name: entry.name, rank: row.rank, score: entry.score };
}

const publicRow = ({ handle, name, rank, score }) => ({ handle, name, rank, score });

export function createApp({ store, rules, words, boothKey, staffKey, reservationKey, now = () => new Date(), log = () => {} }) {
  for (const [label, key] of [["booth", boothKey], ["staff", staffKey], ["reservation", reservationKey]]) {
    if (typeof key !== "string" || key.length < 32) throw new Error(`The ${label} key must be at least 32 characters.`);
  }
  if (boothKey === staffKey) throw new Error("The booth and staff keys must differ.");
  const moderation = blocklistStatus(rules.blocklist).ready ? "reviewed" : "placeholder";
  const fingerprint = id => createHmac("sha256", reservationKey).update(id).digest("hex");

  const routes = {
    async "GET /api/board"(request, url) {
      const entries = await store.list();
      const board = leaderboard(entries);
      const body = { asOf: now().toISOString(), entries: board.slice(0, BOARD_SIZE).map(publicRow), total: board.length };
      const handle = url.searchParams.get("handle");
      if (handle !== null) {
        // With a publication reference the lookup is exact. A QR scanned
        // before the booth's publish was confirmed carries the handle the
        // booth issued, while the drink may be stored under its canonical
        // form, so either matches. The reference is opaque: the drink ID
        // would put the name in the logs.
        // A handle alone identifies nobody: another booth may have issued it.
        const ref = url.searchParams.get("ref");
        const own = ref === null ? undefined
          : entries.find(entry => entry.tokenHash && publicRef(entry.tokenHash) === ref
            && (entry.handle === handle || entry.handle === canonicalHandle(handle, entry.id)));
        const mine = HANDLE.test(handle) && own ? board.find(row => row.handle === own.handle && row.name === own.name) : undefined;
        body.you = mine ? publicRow(mine) : null;
      }
      return [200, body];
    },

    async "POST /api/entries"(request) {
      requireKey(request, boothKey);
      const submission = validateSubmission(await readJson(request), rules, words);
      // Handles are unique per booth, not per event. If another entry already
      // uses this one, the drink is stored under its canonical handle instead,
      // and the receipt says so.
      const handles = [submission.handle, canonicalHandle(submission.handle, submission.id)];
      // Only a hash of the publication token is kept; it is compared, never shown.
      const tokenHash = tokenHashOf(submission.token);
      const { token, ...fields } = submission;
      let admitted;
      try {
        // One store operation, so a retraction cannot land between checking
        // the reservation and writing the entry.
        admitted = await store.admit({ ...fields, createdAt: now().toISOString(), tokenHash },
          { fingerprint: fingerprint(submission.id), handles });
      } catch (error) {
        // Taken down at some booth. Worded exactly as the booth words a
        // blocklist hit, so nobody can tell the two apart and guess why.
        if (error instanceof ReservedError) throw new HttpError(409, "unavailable_drink", "That name is not available.");
        if (error instanceof HandleTakenError) throw new HttpError(409, "handle_taken", "That handle is already on the board.");
        throw error;
      }
      if (!admitted.created) {
        // A booth retries after a network blip, so the same publication
        // arriving twice is a success. Matching fields are not enough: another
        // booth can draw the same handle and its attendee type the same name,
        // and only the publication token tells the two apart.
        const existing = admitted.entry;
        const same = existing.tokenHash === tokenHash && handles.includes(existing.handle)
          && existing.name === submission.name && existing.score === submission.score;
        if (!same) throw new HttpError(409, "duplicate_drink", "Another barista already published a drink with this name.");
        return [200, receiptFor(existing, admitted.entries)];
      }
      // Ranked from the board as it stood at admission, not from a later read.
      return [201, receiptFor(admitted.entry, admitted.entries)];
    },

    // Deletes the entry and reserves the name at every booth. What is kept is
    // a keyed fingerprint of the ID and nothing else: the name, the reason and
    // who removed it stay in the booth's local ledger. 404 still reserves,
    // because staff often catch a name before it has synced. The ID arrives in
    // the body of a fixed route, so web-server logs never record it.
    async "POST /api/retractions"(request) {
      requireKey(request, staffKey);
      const body = await readJson(request);
      const shaped = body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).join() === "id";
      if (!shaped || typeof body.id !== "string" || !ID.test(body.id)) {
        throw new HttpError(400, "invalid_id", "Send exactly { id } with a drink ID.");
      }
      return (await store.retract(body.id, fingerprint(body.id))) ? [204, null] : [404, { error: "not_found" }];
    },

    // Reads the board, because that is what every other route needs. If the
    // /home share becomes unreadable, the health check fails with it, and App
    // Service sees an unhealthy instance rather than a green one serving 500s.
    async "GET /healthz"() {
      try {
        await store.list();
      } catch (error) {
        log(`health check could not read the board: ${error?.code ?? error?.name}`);
        return [503, { moderation, ok: false, store: "unreadable" }];
      }
      return [200, { moderation, ok: true }];
    },
  };

  return async function handle(request, response) {
    const headers = { "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
    // HEAD is GET without a body. The QR generator checks the destination with
    // an unauthenticated HEAD before it will encode it, so refusing HEAD here
    // would make this service impossible to put behind a QR code.
    const head = request.method === "HEAD";
    const method = head ? "GET" : request.method;
    try {
      const url = new URL(request.url, "http://localhost");
      const asset = method === "GET" ? STATIC[url.pathname] : undefined;
      if (asset) {
        response.writeHead(200, {
          ...headers, "Cache-Control": "public, max-age=300", "Content-Security-Policy": CONTENT_SECURITY_POLICY,
          "Content-Type": asset.type,
        });
        response.end(head ? undefined : await readFile(asset.file));
        return;
      }
      const route = routes[`${method} ${url.pathname}`];
      if (!route) throw new HttpError(404, "not_found", "Not found.");
      const [status, body] = await route(request, url);
      response.writeHead(status, { ...headers, "Cache-Control": "no-store",
        ...(body === null ? {} : { "Content-Type": "application/json; charset=utf-8" }) });
      response.end(body === null || head ? undefined : JSON.stringify(body));
    } catch (error) {
      const known = error instanceof HttpError;
      if (!known) log(`leaderboard error: ${error?.name}: ${error?.message}`);
      response.writeHead(known ? error.status : 500, { ...headers, "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8" });
      response.end(head ? undefined : JSON.stringify({ error: known ? error.code : "server_error", message: known ? error.message : "Unexpected error." }));
    }
  };
}
