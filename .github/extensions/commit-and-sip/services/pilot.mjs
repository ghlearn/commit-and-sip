import { liveAssignment, requireValue, validRunId } from "../domain.mjs";

export async function inspectLivePilot({ config, catalog, runId, github }) {
  requireValue(validRunId(runId), "invalid_run", "Use the assigned run ID.", 400);
  const assignment = liveAssignment(config, catalog, runId);
  requireValue(github.repo === assignment.repo, "repository_mismatch", "The GitHub adapter must target the assigned repository.");
  const order = catalog.orders.find(order => order.id === assignment.orderId);
  const issue = await github.readIssue(assignment.issueNumber);
  requireValue(issue.number === assignment.issueNumber && issue.state === "open" &&
    typeof issue.body === "string" && issue.body.trim(),
  "invalid_issue", "The assigned exercise issue must be open and contain learner instructions.");
  await inspectPreparedPullRequest({ assignment, order, github });
  const reviewSource = assignment.reviewSource ?? "native";
  const pilot = reviewSource === "canvas-pilot";
  return {
    status: "assignment-verified", liveReady: false,
    mode: pilot ? "live-canvas-pilot" : "live", reviewSource, eventEligible: false, permissionsCertified: false,
    runId, repo: assignment.repo, issueNumber: assignment.issueNumber, prNumber: assignment.prNumber,
    headSha: assignment.headSha, baseRef: assignment.baseRef, requiredChecks: assignment.requiredChecks, order,
    blockers: pilot ? [
      "Unranked canvas pilot only. Canvas review is not native in-App PR-view evidence or production live readiness.",
      "No event eligibility, score, leaderboard, QR, or completion comment is authorized by this pilot.",
      "This read-only preflight does not certify permissions. Staff must compare issue instructions with the order above and separately confirm reviewer and merge permissions."
    ] : [
      "Native in-App PR navigation and authenticated view evidence must be supplied by the host integration; this preflight cannot certify them.",
      "Trusted checkpoint evidence and authenticated completion hosting remain required for event results.",
      "Staff must compare issue instructions with the order above and confirm reviewer and separate merge permissions before a pilot."
    ]
  };
}

export async function inspectPreparedPullRequest({ assignment, order, github }) {
  requireValue(github.repo === assignment.repo, "repository_mismatch", "The GitHub adapter must target the assigned repository.");
  const evidence = await github.inspectPullRequest(assignment.prNumber, {
    expectedHeadSha: assignment.headSha, expectedBaseRef: assignment.baseRef,
    reviewer: assignment.reviewer, order, requiredChecks: assignment.requiredChecks
  });
  requireValue(evidence.headSha === assignment.headSha && evidence.baseRef === assignment.baseRef && evidence.checksPassed,
    "evidence_invalid", "The exact assigned revision and passing checks must verify.");
  if (assignment.reviewSource === "canvas-pilot") requireValue(typeof evidence.summary === "string" && evidence.summary.trim() &&
    evidence.files?.length === 1 && typeof evidence.files[0].patch === "string" && evidence.files[0].patch.trim() &&
    Array.isArray(evidence.checks) && evidence.checks.length > 0,
  "review_unavailable", "The real PR summary, text patch, and checks must be available for in-canvas inspection.");
  requireValue(!evidence.approved && !evidence.merged,
    "assignment_used", "Prepare a fresh PR: this pilot assignment is already approved or merged.");
  return evidence;
}
