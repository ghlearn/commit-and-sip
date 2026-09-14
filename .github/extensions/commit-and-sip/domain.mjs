import { readFile } from "node:fs/promises";
import { randomInt, randomUUID } from "node:crypto";

export class DomainError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function requireValue(condition, code, message, status) {
  if (!condition) throw new DomainError(code, message, status);
}

export function validRunId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id);
}

export function exactInput(input, fields = []) {
  requireValue(input && typeof input === "object" && !Array.isArray(input) &&
    Object.keys(input).every(key => fields.includes(key)),
  "invalid_input", "This action received unexpected input.", 400);
}

export async function loadCatalog() {
  const orders = JSON.parse(await readFile(new URL("../../../booth/orders.json", import.meta.url), "utf8"));
  const words = JSON.parse(await readFile(new URL("../../../booth/handle-words.json", import.meta.url), "utf8"));
  return { orders, words };
}

export function generateHandle(words, used) {
  for (let attempt = 0; attempt < 1024; attempt++) {
    const handle = [words.adjectives, words.verbs, words.nouns]
      .map(list => list[randomInt(list.length)]).join("-");
    if (!used.has(handle)) return handle;
  }
  // A suffix keeps the curated vocabulary when the finite phrase pool fills.
  let handle;
  do {
    handle = `${words.adjectives[0]}-${words.verbs[0]}-${words.nouns[0]}-${randomUUID().slice(0, 8)}`;
  } while (used.has(handle));
  return handle;
}

export const liveBlockers = [
  "Native Copilot App review-view observation is not configured. Live approval and completion are locked.",
  "Public HTTPS leaderboard, authenticated completion service, and issue-renderable QR asset need staff configuration.",
  "Authentic Copilot App guide screenshots must be captured and approved before booth use."
];

export function makeRun({ runId, mode, order, assignment = null, now = new Date().toISOString() }) {
  return {
    runId, mode, order, assignment, phase: "order", createdAt: now,
    views: [], evidenceHeadSha: null, hintCount: 0, assessmentPassed: false,
    assessmentAttempts: 0, menu: [], result: null, issue: null, review: null,
    events: [], completionPending: false, commentId: null, handle: null,
    statusMessage: mode === "rehearsal" ? "Rehearsal only. No GitHub writes or event scores." : "Live run awaits verified evidence."
  };
}

export function rehearsalIssue(run) {
  const { order } = run;
  return {
    title: `Order Up! Review ${order.name}`,
    number: null,
    url: null,
    body: `Rehearsal exercise issue\n\nYour order: ${order.name}, $${order.price.toFixed(2)}, ${order.serving}.\n` +
      `Description: "${order.description}"\nArtwork: ${order.artwork} (original cafe illustration).\n\n` +
      "Inspect the PR summary, actual menu diff, and checks. Confirm only this drink is added, " +
      "then answer the acceptance-criteria checkpoint and approve. Approval is not a merge: apply the rehearsal menu separately.\n\n" +
      "This is a simulation, not a real GitHub issue. Live orders and onboarding must live in the assigned exercise issue."
  };
}

export function rehearsalReview(run) {
  return {
    headSha: `rehearsal-${run.runId}`,
    summary: `Add ${run.order.name} to the Level Up Lounge menu. Rehearsal fixture, not a Copilot-authored PR.`,
    files: [{ filename: "src/data/specials.json", patch: `-[]\n+${JSON.stringify([run.order], null, 2).replaceAll("\n", "\n+")}` }],
    checks: [{ name: "menu-validation (simulated)", conclusion: "success" }]
  };
}

export function publicRun(run) {
  const { assignment, events, handle, commentId, ...publicState } = run;
  // Only explicitly selected, non-credential state crosses the renderer boundary.
  return {
    ...publicState,
    blockers: run.mode === "live" ? liveBlockers : [],
    completionPending: run.phase === "served" || run.completionPending
  };
}
