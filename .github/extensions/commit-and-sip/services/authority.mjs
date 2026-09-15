import { exactInput, requireValue, validRunId } from "../domain.mjs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

function assignmentIdentity(assignment) {
  if (!assignment) return null;
  const { repo, issueNumber, prNumber, headSha, reviewer, orderId, requiredChecks = ["menu-validation"] } = assignment;
  return structuredClone({ repo, issueNumber, prNumber, headSha, reviewer, orderId, requiredChecks });
}

function receiptProjection(result) {
  const { assignment, requestedHandle, ...receipt } = result;
  return receipt;
}

// Deployment code supplies trusted evidence readers; HTTP callers cannot supply evidence or scores.
export class CompletionAuthority {
  constructor({ store, assignments, github, viewEvidence, checkpointEvidence, catalog, postComment }) {
    Object.assign(this, { store, assignments, github, viewEvidence, checkpointEvidence, catalog, postComment });
  }

  async accept(input) {
    exactInput(input, ["runId", "handle"]);
    requireValue(validRunId(input.runId), "invalid_run", "Invalid completion run.", 400);
    const { runId, handle } = input;
    requireValue(typeof handle === "string" && /^[a-z]+-[a-z]+-[a-z]+(?:-[a-f0-9]{8})?$/.test(handle),
      "invalid_handle", "The completion handle must use the curated cafe vocabulary.", 400);
    const [adjective, verb, noun] = handle.split("-");
    requireValue(this.catalog.words.adjectives.includes(adjective) &&
      this.catalog.words.verbs.includes(verb) && this.catalog.words.nouns.includes(noun),
    "invalid_handle", "The completion handle is not in the curated vocabulary.", 400);
    const assignment = assignmentIdentity(Object.hasOwn(this.assignments, runId) ? this.assignments[runId] : null);
    requireValue(assignment, "unknown_run", "This run was not registered by booth staff.", 404);
    requireValue(!Object.entries(this.assignments).some(([id, other]) => id !== runId &&
      other.repo === assignment.repo &&
      (other.issueNumber === assignment.issueNumber || other.prNumber === assignment.prNumber)),
    "assignment_reused", "Each event run requires its own exercise issue and prepared PR.");
    const receipt = await this.store.transaction(async data => {
      const existing = data.results.find(result => result.runId === runId);
      if (existing) {
        requireValue(isDeepStrictEqual(existing.assignment, assignment), "assignment_conflict",
          "This receipt belongs to a different or unbound assignment. Restore its original registration; do not reuse the run ID.");
        requireValue(existing.handle === handle || existing.requestedHandle === handle,
          "handle_conflict", "This run already has a different reserved handle.");
        return existing;
      }
      requireValue(!data.results.some(result => result.assignment?.repo === assignment.repo &&
        (result.assignment.issueNumber === assignment.issueNumber || result.assignment.prNumber === assignment.prNumber)),
      "assignment_reused", "This issue or PR is already reserved for another run.");
      requireValue(this.viewEvidence && this.checkpointEvidence && this.github, "evidence_unavailable",
        "Completion requires trusted native-view, acceptance-checkpoint, and GitHub evidence.");
      requireValue(this.github.repo === assignment.repo, "repository_mismatch",
        "The GitHub verifier must be bound to the assigned repository.");
      const order = this.catalog.orders.find(item => item.id === assignment.orderId);
      requireValue(order, "unknown_order", "The assigned order is not in the trusted catalog.");
      const identity = { runId, repo: assignment.repo, prNumber: assignment.prNumber, headSha: assignment.headSha };
      const views = await this.viewEvidence.read(identity);
      const checkpoint = await this.checkpointEvidence.read(identity);
      for (const evidence of [views, checkpoint]) {
        requireValue(evidence && Object.entries(identity).every(([key, value]) => evidence[key] === value),
          "evidence_identity", "Review evidence does not match this run's exact PR head.");
      }
      requireValue(Array.isArray(views.surfaces) && views.surfaces.length === 3 &&
        new Set(views.surfaces).size === 3 && ["summary", "changes", "checks"].every(surface => views.surfaces.includes(surface)),
        "views_incomplete", "Native review surface evidence is incomplete.");
      requireValue(checkpoint.passed === true && checkpoint.price === order.price &&
        checkpoint.serving === order.serving && checkpoint.scope === "one-drink",
      "checkpoint_incomplete", "The trusted acceptance-criteria checkpoint is incomplete.");
      const pr = await this.github.inspectPullRequest(assignment.prNumber, {
        expectedHeadSha: assignment.headSha, reviewer: assignment.reviewer, order,
        requiredChecks: assignment.requiredChecks
      });
      requireValue(pr.headSha === assignment.headSha && pr.checksPassed && pr.approved &&
        pr.merged && pr.mergeCommitSha, "completion_ineligible",
      "GitHub approval, exact head checks, and merged menu must all verify independently.");
      // Correct completions tie; neither speed nor accessibility assistance affects rank.
      const score = 1000;
      let canonicalHandle = handle;
      let suffix = 0;
      while (data.results.some(result => result.handle === canonicalHandle)) {
        canonicalHandle = `${[adjective, verb, noun].join("-")}-${createHash("sha256").update(`${runId}:${suffix++}`).digest("hex").slice(0, 8)}`;
      }
      const result = {
        runId, assignment, handle: canonicalHandle, requestedHandle: handle, score,
        rankAtCompletion: 1 + data.results.filter(item => item.score > score).length,
        recordedAt: new Date().toISOString(), judge: null, rank: 1 + data.results.filter(item => item.score > score).length
      };
      data.results.push(result);
      return result;
    });
    return receiptProjection(receipt);
  }

  async finalize(input) {
    await this.accept(input);
    return this.store.transaction(async data => {
      const result = data.results.find(item => item.runId === input.runId);
      requireValue(isDeepStrictEqual(result.assignment, assignmentIdentity(this.assignments[input.runId])),
        "assignment_conflict", "The registered assignment changed after reservation. Restore the original assignment before retrying.");
      requireValue(this.github?.repo === result.assignment.repo, "repository_mismatch", "The issue writer must remain bound to the reserved repository.");
      if (!result.commentId) {
        requireValue(this.postComment, "comment_unconfigured",
          "The result is reserved. Configure the exercise-issue comment writer and retry.");
        result.commentId = await this.postComment(result.assignment.issueNumber, receiptProjection(result));
        requireValue(Number.isSafeInteger(result.commentId) && result.commentId > 0,
          "comment_unverified", "The issue comment writer did not return a verified comment ID.");
      }
      return receiptProjection(result);
    });
  }

  async leaderboard() {
    const { results } = await this.store.read();
    return results.filter(result => result.commentId).map(({ handle, score }) => ({
      handle, score, liveRank: 1 + results.filter(result => result.commentId && result.score > score).length
    })).sort((a, b) => a.liveRank - b.liveRank || a.handle.localeCompare(b.handle));
  }
}
