import { liveAssignment, requireValue, validRunId } from "../domain.mjs";

export async function inspectLivePilot({ config, catalog, runId, github }) {
  requireValue(validRunId(runId), "invalid_run", "Use the assigned run ID.", 400);
  const assignment = liveAssignment(config, catalog, runId);
  requireValue(github.repo === assignment.repo, "repository_mismatch", "The GitHub adapter must target the assigned repository.");
  requireValue(Array.isArray(config.requiredChecks) && config.requiredChecks.length > 0 &&
    config.requiredChecks.every(name => typeof name === "string" && name.trim()) &&
    new Set(config.requiredChecks).size === config.requiredChecks.length,
  "invalid_checks", "Configure unique, nonempty required check names before a pilot.");
  const order = catalog.orders.find(order => order.id === assignment.orderId);
  const issue = await github.readIssue(assignment.issueNumber);
  requireValue(issue.number === assignment.issueNumber && issue.state === "open" &&
    typeof issue.body === "string" && issue.body.trim(),
  "invalid_issue", "The assigned exercise issue must be open and contain learner instructions.");
  const evidence = await github.inspectPullRequest(assignment.prNumber, {
    expectedHeadSha: assignment.headSha, reviewer: assignment.reviewer, order, requiredChecks: config.requiredChecks
  });
  requireValue(evidence.headSha === assignment.headSha && evidence.checksPassed,
    "evidence_invalid", "The exact assigned revision and passing checks must verify.");
  requireValue(!evidence.approved && !evidence.merged,
    "assignment_used", "Prepare a fresh PR: this pilot assignment is already approved or merged.");
  return {
    status: "assignment-verified", liveReady: false,
    runId, repo: assignment.repo, issueNumber: assignment.issueNumber, prNumber: assignment.prNumber,
    headSha: assignment.headSha, order,
    blockers: [
      "Native in-App PR navigation and authenticated view evidence must be supplied by the host integration; this preflight cannot certify them.",
      "Trusted checkpoint evidence and authenticated completion hosting remain required for event results.",
      "Staff must compare issue instructions with the order above and confirm reviewer and separate merge permissions before a pilot."
    ]
  };
}
