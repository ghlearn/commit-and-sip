import { requireValue } from "../domain.mjs";

// The booth is authoritative for its own menu; the event leaderboard is a
// separate service that no booth can see into. Everything here is a client
// seam: the local entry is always durable first, and a submission that fails
// can never cost an attendee the drink they invented or the score they earned.
export const SYNC_STATES = ["disabled", "pending", "confirmed", "failed"];

// Exactly what is sent. Kept minimal on purpose: no run ID, no device, and no
// booth identity, because an anonymous handle is all a public board needs.
export function submissionFor(entry) {
  requireValue(entry && typeof entry === "object", "invalid_submission", "A menu entry is required to submit a score.", 400);
  requireValue(typeof entry.handle === "string" && entry.handle.length > 0,
    "invalid_submission", "A submitted entry needs a barista handle.", 400);
  requireValue(Number.isSafeInteger(entry.score) && entry.score > 0,
    "invalid_submission", "A submitted entry needs a positive integer score.", 400);
  requireValue(typeof entry.name === "string" && entry.name.length > 0,
    "invalid_submission", "A submitted entry needs a drink name.", 400);
  return { handle: entry.handle, id: entry.id, name: entry.name, score: entry.score };
}

// A receipt is trusted only when it is about the entry that was actually sent.
// A service that answers with a different handle, ID, name or score is
// reporting on someone else, and its rank must never be shown next to this
// attendee's drink. The ID is compared too: without it, a receipt for another
// entry that happened to share the handle, name and score would pass.
export function validateReceipt(receipt, submission) {
  requireValue(receipt && typeof receipt === "object" && !Array.isArray(receipt),
    "invalid_receipt", "The leaderboard service returned an unusable receipt.");
  requireValue(receipt.handle === submission.handle && receipt.id === submission.id
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
  return {
    ...previous,
    attempts: previous.attempts + 1,
    reason: typeof error?.message === "string" ? error.message.slice(0, 200) : "Unknown leaderboard error.",
    state: "failed",
    updatedAt: now,
  };
}

// What the canvas is allowed to say. A local score is a fact the booth owns; a
// global rank is not, until the service has confirmed it. These are separate so
// the UI cannot imply an event standing that nobody has accepted.
export function syncView(sync) {
  if (!sync || sync.state === "disabled") {
    return { eventRank: null, message: null, state: "disabled" };
  }
  if (sync.state === "confirmed") {
    return {
      entries: sync.receipt.entries,
      eventRank: sync.receipt.rank,
      message: `Confirmed on the event leaderboard at rank ${sync.receipt.rank}.`,
      state: "confirmed",
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
