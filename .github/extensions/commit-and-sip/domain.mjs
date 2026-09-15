import { readFile } from "node:fs/promises";
import { randomInt, randomUUID } from "node:crypto";
import { exerciseContent, renderRehearsalOrder } from "./content.mjs";

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

export function validBaseRef(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 255 &&
    value !== "HEAD" && value !== "@" && !value.startsWith("-") && !value.endsWith(".") &&
    !/[\u0000-\u0020\u007f~^:?*\[\\]/.test(value) && !value.includes("..") && !value.includes("@{") &&
    value.split("/").every(part => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
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

export function validateStaffConfig(config) {
  requireValue(config !== null && typeof config === "object" && !Array.isArray(config),
    "invalid_config", "Staff configuration must be a non-array JSON object.", 400);
  requireValue(config.runs === undefined || (config.runs !== null && typeof config.runs === "object" && !Array.isArray(config.runs)),
    "invalid_config", "Configured runs must be an object keyed by run ID.", 400);
  return config;
}

export function liveAssignment(config, catalog, runId) {
  validateStaffConfig(config);
  const assignment = config.runs && Object.hasOwn(config.runs, runId) ? config.runs[runId] : null;
  requireValue(config.mode === "live" && assignment, "live_unconfigured", "Staff must configure live mode and assign this run before a pilot.");
  requireValue(typeof config.repo === "string" && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(config.repo) &&
    Number.isSafeInteger(assignment.issueNumber) && assignment.issueNumber > 0 &&
    Number.isSafeInteger(assignment.prNumber) && assignment.prNumber > 0 &&
    typeof assignment.headSha === "string" && /^[a-f0-9]{40}$/.test(assignment.headSha) &&
    typeof assignment.reviewer === "string" && /^[a-zA-Z0-9-]{1,39}$/.test(assignment.reviewer),
  "invalid_assignment", "The live assignment requires a repository, valid issue/PR numbers, reviewer, and exact head SHA.");
  requireValue(validBaseRef(assignment.baseRef), "invalid_base_ref", "Assign the intended application base branch before opening a live run.", 400);
  const requiredChecks = config.requiredChecks === undefined ? ["menu-validation"] : config.requiredChecks;
  requireValue(Array.isArray(requiredChecks) && requiredChecks.length > 0 &&
    requiredChecks.every(name => typeof name === "string" && name.trim().length > 0) &&
    new Set(requiredChecks).size === requiredChecks.length,
  "invalid_checks", "Configure unique nonempty required check names for the live assignment.", 400);
  requireValue(catalog.orders.some(order => order.id === assignment.orderId), "invalid_order", "The assigned order must exist in the booth catalog.", 400);
  return { ...assignment, repo: config.repo, requiredChecks: [...requiredChecks] };
}

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
    body: renderRehearsalOrder(order)
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

export function publicRun(run, { nativeReviewAvailable = false } = {}) {
  const { assignment, approvalAttempt, events, handle, commentId, ...publicState } = run;
  // Only explicitly selected, non-credential state crosses the renderer boundary.
  return {
    ...publicState,
    exercise: exerciseContent(run),
    reviewTarget: run.mode === "live" && assignment ? {
      repo: assignment.repo, issueNumber: assignment.issueNumber, prNumber: assignment.prNumber, headSha: assignment.headSha
    } : null,
    verification: { nativeReviewAvailable: run.mode === "live" && nativeReviewAvailable, syncedAt: run.reviewSyncedAt ?? null },
    blockers: run.mode === "live" ? liveBlockers.filter((_, index) => index !== 0 || !nativeReviewAvailable) : [],
    completionPending: run.phase === "served" || run.completionPending
  };
}
