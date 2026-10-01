import { createHash, randomBytes } from "node:crypto";
import { requireValue } from "../domain.mjs";

// The booth is authoritative for its own menu; the event leaderboard is a
// separate service that no booth can see into. Everything here is a client
// seam: the local entry is always durable first, and a submission that fails
// can never cost an attendee the drink they invented or the score they earned.
export const SYNC_STATES = ["disabled", "pending", "confirmed", "failed", "rejected"];

// Refusals that retrying cannot change: another attendee already holds the
// name, or staff took it down. They become "rejected" and are never sent
// again, not even by a rebuild. Otherwise, after the service lost its data,
// the booth that lost a clash could publish first and take the name from the
// attendee who legitimately holds it.
export const TERMINAL_REJECTIONS = ["duplicate_drink", "unavailable_drink"];

// A random value minted once per publication and kept with the run, so every
// retry of one publication carries the same token. It lets the service tell a
// retry apart from a different attendee at another booth who drew the same
// handle and typed the same name: public fields cannot. It identifies the
// publication only, never the booth, device or run, and the service stores
// only its hash.
export const PUBLICATION_TOKEN = /^[0-9a-f]{32}$/;
export const newPublicationToken = () => randomBytes(16).toString("hex");

// What the service stores in place of the token.
export const tokenHashOf = token => createHash("sha256").update(token).digest("hex");

// The attendee's QR link and the board page find their own row with this, not
// with the drink ID: the ID is the name, slugged, and request URLs end up in
// web-server logs. It is derived from the token's hash, so the booth (which
// holds the token) and the service (which holds only the hash) compute the
// same value, and it reveals neither the token nor the name.
export const publicRef = tokenHash => createHash("sha256").update(`ref:${tokenHash}`).digest("hex").slice(0, 16);

// Exactly what is sent. Kept minimal on purpose: no run ID, no device, and no
// booth identity, because an anonymous handle is all a public board needs.
export function submissionFor(entry, token) {
  requireValue(entry && typeof entry === "object", "invalid_submission", "A menu entry is required to submit a score.", 400);
  requireValue(typeof entry.handle === "string" && entry.handle.length > 0,
    "invalid_submission", "A submitted entry needs a barista handle.", 400);
  requireValue(Number.isSafeInteger(entry.score) && entry.score > 0,
    "invalid_submission", "A submitted entry needs a positive integer score.", 400);
  requireValue(typeof entry.name === "string" && entry.name.length > 0,
    "invalid_submission", "A submitted entry needs a drink name.", 400);
  requireValue(typeof token === "string" && PUBLICATION_TOKEN.test(token),
    "invalid_submission", "A submitted entry needs its publication token.", 400);
  return { handle: entry.handle, id: entry.id, name: entry.name, score: entry.score, token };
}

// Handles are unique at one booth, not across an event: there are 512
// unsuffixed phrases. When two booths hand out the same one, the service keeps
// the first and gives the later drink this handle instead. It is derived from
// the drink ID, so a retry always lands on the same value and the booth can
// check the receipt exactly rather than accept whatever handle comes back.
export function canonicalHandle(handle, id) {
  return `${handle.replace(/-[0-9a-f]{8}$/, "")}-${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
}

// A receipt is trusted only when it is about the entry that was actually sent.
// A service that answers with a different handle, ID, name or score is
// reporting on someone else, and its rank must never be shown next to this
// attendee's drink. The ID is compared too: without it, a receipt for another
// entry that happened to share the handle, name and score would pass.
export function validateReceipt(receipt, submission) {
  requireValue(receipt && typeof receipt === "object" && !Array.isArray(receipt),
    "invalid_receipt", "The leaderboard service returned an unusable receipt.");
  const handleMatches = receipt.handle === submission.handle
    || receipt.handle === canonicalHandle(submission.handle, submission.id);
  requireValue(handleMatches && receipt.id === submission.id
    && receipt.name === submission.name && receipt.score === submission.score,
    "receipt_mismatch", "The leaderboard receipt does not match the submitted entry.");
  requireValue(Number.isSafeInteger(receipt.rank) && receipt.rank > 0,
    "invalid_receipt", "The leaderboard receipt has no usable rank.");
  requireValue(receipt.entries === undefined || (Number.isSafeInteger(receipt.entries) && receipt.entries >= receipt.rank),
    "invalid_receipt", "The leaderboard receipt has an impossible entry count.");
  return {
    entries: receipt.entries ?? null,
    handle: receipt.handle,
    rank: receipt.rank,
    score: receipt.score,
  };
}

export function initialSync(enabled, now = new Date().toISOString()) {
  return enabled
    ? { attempts: 0, state: "pending", updatedAt: now }
    : { attempts: 0, state: "disabled", updatedAt: now };
}

export function confirmedSync(previous, receipt, now = new Date().toISOString()) {
  return { ...previous, attempts: previous.attempts + 1, receipt, state: "confirmed", updatedAt: now };
}

// The failure reason is kept for staff, never surfaced to the attendee, and
// deliberately carries no service internals beyond a short message.
export function failedSync(previous, error, now = new Date().toISOString()) {
  const code = typeof error?.code === "string" && /^[a-z_]{1,40}$/.test(error.code) ? error.code : null;
  return {
    ...previous,
    attempts: previous.attempts + 1,
    code,
    reason: typeof error?.message === "string" ? error.message.slice(0, 200) : "Unknown leaderboard error.",
    state: TERMINAL_REJECTIONS.includes(code) ? "rejected" : "failed",
    updatedAt: now,
  };
}

// What the canvas is allowed to say. A local score is a fact the booth owns; a
// global rank is not, until the service has confirmed it. These are separate so
// the UI cannot imply an event standing that nobody has accepted.
export function syncView(sync, handle = null) {
  if (!sync || sync.state === "disabled") {
    return { eventRank: null, message: null, state: "disabled" };
  }
  if (sync.state === "confirmed") {
    return {
      entries: sync.receipt.entries,
      eventRank: sync.receipt.rank,
      message: `Confirmed on the event leaderboard at rank ${sync.receipt.rank}.`
        + (handle && sync.receipt.handle !== handle
          ? ` Another booth had already used your handle, so the board shows you as ${sync.receipt.handle}.`
          : ""),
      state: "confirmed",
    };
  }
  if (sync.state === "rejected") {
    // Deliberately says nothing about why, as the booth does for a blocklist
    // hit. Staff read the code from the sync record.
    return {
      eventRank: null,
      message: "Your drink is saved at this booth, but the event leaderboard did not accept this name.",
      state: "rejected",
    };
  }
  return {
    eventRank: null,
    message: "Your drink is saved at this booth. Its place on the event leaderboard is still being confirmed.",
    state: sync.state,
  };
}

// A client publishes one submission and returns a receipt, or throws. It owns
// its own timeout: a booth queue must not wait on a slow service. It may also
// retract(id) a drink staff took down; a client without it is a booth that
// can publish but not delete, and takedowns there report "not-configured".
// services/leaderboard-client.mjs is the HTTP client for leaderboard-service/.
export function validateLeaderboardClient(client) {
  requireValue(client === null || typeof client?.publish === "function",
    "invalid_leaderboard_client", "A leaderboard client must expose publish(submission).");
  requireValue(client === null || client.retract === undefined || typeof client.retract === "function",
    "invalid_leaderboard_client", "A leaderboard client's retract must be a function when present.");
  return client;
}

// What went wrong with a retraction, kept on the removal record. A refused
// key, an outdated service and an outage each need a different fix, and
// "failed" alone suggests only the last.
export function retractionFailure(error) {
  return {
    code: typeof error?.code === "string" && /^[a-z_]{1,40}$/.test(error.code) ? error.code : null,
    status: Number.isInteger(error?.status) ? error.status : null,
  };
}

// The cause in words, for the dashboard and the staff commands alike. Each
// surface adds its own way to retry.
export function retractionCause(failure) {
  const { code = null, status = null } = failure ?? {};
  if (status === 401 || status === 403) {
    return "the service refused this machine's staff key. Copy the deployed keys to this machine "
      + "(an owner-only copy with npm run leaderboard:configure -- --url <url> --from <file>, then delete the copy)";
  }
  if (code === "reservation_key_mismatch") return "a service instance is on an outdated reservation key and is being restarted";
  if (status === 404 || code === "unexpected_response") {
    return "the service did not answer as the current build does, so it may need redeploying (booth/RUNBOOK.md)";
  }
  if (status !== null) return `the service refused it (${status}${code ? ` ${code}` : ""})`;
  return "the service could not be reached";
}
