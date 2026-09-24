import { requireValue } from "../domain.mjs";

// End-of-event handling is the one place where a booth destroys data, so the
// shape of an archive is defined here as pure functions. The engine does the
// IO; everything about *what* is written is decided where it can be tested
// without touching a disk.

export const WIPE_CONFIRMATION = "wipe";

// A run is still the station's business until it is completed. Wiping under an
// attendee would delete the drink they are looking at, so the count of these
// is what the wipe refusal is built on.
export function activeRuns(data) {
  return Object.values(data.runs ?? {})
    .filter(run => run.mode === "booth" && run.phase !== "complete")
    .map(run => ({ handle: run.handle, phase: run.phase, runId: run.runId }));
}

// What staff need to see before deciding anything, and the same numbers the
// archive records, so a summary shown on screen and a summary in a file can be
// compared rather than trusted.
export function eventSummary(data) {
  const menu = Array.isArray(data.menu) ? data.menu : [];
  const removals = Array.isArray(data.removals) ? data.removals : [];
  const runs = Object.values(data.runs ?? {}).filter(run => run.mode === "booth");
  const invented = menu.filter(entry => !entry.example);
  return {
    active: activeRuns(data),
    attendees: runs.length,
    completed: runs.filter(run => run.phase === "complete").length,
    examples: menu.length - invented.length,
    invented: invented.length,
    removals: removals.length,
    scored: invented.reduce((total, entry) => total + (entry.score ?? 0), 0),
  };
}

// Removed drinks are deliberately included. They are the audit trail for a
// moderation decision, and a wipe would otherwise destroy the only record that
// a name was ever published and taken down.
export function exportPayload(data, { exportedBy, now = new Date().toISOString() } = {}) {
  requireValue(typeof exportedBy === "string" && exportedBy.trim().length > 0,
    "invalid_export", "Record who exported these results.", 400);
  const menu = Array.isArray(data.menu) ? data.menu : [];
  return {
    drinks: menu.filter(entry => !entry.example).map(entry => ({
      createdAt: entry.createdAt ?? null,
      handle: entry.handle ?? null,
      id: entry.id,
      name: entry.name,
      score: entry.score ?? null,
    })),
    examples: menu.filter(entry => entry.example).map(entry => ({ id: entry.id, name: entry.name })),
    exportedAt: now,
    exportedBy: exportedBy.trim(),
    kind: "commit-and-sip-results",
    removals: (Array.isArray(data.removals) ? data.removals : []).map(record => ({
      id: record.id, name: record.name, reason: record.reason,
      removedAt: record.removedAt, removedBy: record.removedBy,
    })),
    summary: eventSummary(data),
    version: 1,
  };
}

// An archive is the whole ledger, not a projection of it. A results export is
// for reading; this is for restoring, so it must not quietly drop a field the
// booth depends on.
export function archivePayload(data, { archivedBy, now = new Date().toISOString() } = {}) {
  requireValue(typeof archivedBy === "string" && archivedBy.trim().length > 0,
    "invalid_archive", "Record who archived this event.", 400);
  return {
    archivedAt: now,
    archivedBy: archivedBy.trim(),
    kind: "commit-and-sip-archive",
    ledger: data,
    summary: eventSummary(data),
    version: 1,
  };
}

// Timestamped rather than sequential so two archives can never be confused,
// and colon-free so the name is valid on every filesystem staff might use.
export function artifactName(prefix, now = new Date().toISOString()) {
  return `${prefix}-${now.replace(/[:.]/g, "-")}.json`;
}

// The archive is read back off the disk and compared before anything is
// destroyed. Trusting the write to have worked is exactly the assumption that
// turns a routine reset into a lost event.
export function archiveMatches(written, data) {
  if (!written || written.kind !== "commit-and-sip-archive" || !written.ledger) return false;
  const before = eventSummary(data);
  const after = eventSummary(written.ledger);
  return ["attendees", "completed", "invented", "removals", "scored"]
    .every(key => before[key] === after[key]);
}

export function emptyLedger() {
  return { version: 1, runs: {}, results: [] };
}
