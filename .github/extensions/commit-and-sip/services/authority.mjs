import { exactInput, requireValue, validBaseRef, validRunId } from "../domain.mjs";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

function assignmentIdentity(assignment) {
  if (!assignment) return null;
  const { repo, issueNumber, prNumber, headSha, reviewer, orderId, baseRef, approvalAttempt,
    requiredChecks = ["menu-validation"] } = assignment;
  return structuredClone({ repo, issueNumber, prNumber, headSha, reviewer, orderId, baseRef, approvalAttempt, requiredChecks });
}

function utcTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  const time = Date.parse(value);
  const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction = "") => `.${fraction.padEnd(3, "0")}Z`);
  return Number.isFinite(time) && new Date(time).toISOString() === normalized ? time : NaN;
}

function validateAttempt(assignment) {
  const attempt = assignment.approvalAttempt;
  requireValue(attempt && typeof attempt.id === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(attempt.id) &&
    Number.isFinite(utcTime(attempt.reviewedAt)) &&
    utcTime(attempt.reviewedAt) <= utcTime(attempt.checkpointAt) &&
    utcTime(attempt.checkpointAt) <= utcTime(attempt.decidedAt),
  "approval_attempt_invalid", "Completion requires this run's trusted, chronologically ordered explicit approval attempt.");
  requireValue(validBaseRef(assignment.baseRef) &&
    Array.isArray(assignment.requiredChecks) && assignment.requiredChecks.length > 0 &&
    assignment.requiredChecks.every(name => typeof name === "string" && name.trim().length > 0) &&
    new Set(assignment.requiredChecks).size === assignment.requiredChecks.length,
  "invalid_assignment", "Completion requires a pinned base branch and required checks.");
}

function sameExercise(left, right) {
  return left?.repo === right.repo &&
    (left.issueNumber === right.issueNumber || left.prNumber === right.prNumber);
}

function receiptProjection(result) {
  const { assignment, requestedHandle, ...receipt } = result;
  return receipt;
}

// Deployment code supplies trusted evidence readers; HTTP callers cannot supply evidence or scores.
export class CompletionAuthority {
  constructor({ store, assignments, github, viewEvidence, checkpointEvidence, catalog, postComment,
    now = Date.now, claimTtlMs = 60_000 }) {
    Object.assign(this, { store, assignments, github, viewEvidence, checkpointEvidence, catalog, postComment });
    requireValue(typeof now === "function" && Number.isSafeInteger(claimTtlMs) && claimTtlMs > 0,
      "invalid_claim_config", "Completion claims require a clock and positive lease duration.");
    Object.assign(this, { now, claimTtlMs });
  }

  assertAssignment(runId, assignment) {
    requireValue(isDeepStrictEqual(assignment, assignmentIdentity(
      Object.hasOwn(this.assignments, runId) ? this.assignments[runId] : null)),
    "assignment_conflict", "The registered assignment changed after reservation. Restore the original assignment before retrying.");
    requireValue(!Object.entries(this.assignments).some(([id, other]) =>
      id !== runId && sameExercise(other, assignment)),
    "assignment_reused", "Each event run requires its own exercise issue and prepared PR.");
  }

  assertReservation(reservation, assignment, handle) {
    requireValue(isDeepStrictEqual(reservation.assignment, assignment), "assignment_conflict",
      "This reservation belongs to a different or unbound assignment. Restore its original registration; do not reuse the run ID.");
    requireValue(reservation.handle === handle || reservation.requestedHandle === handle,
      "handle_conflict", "This run already has a different reserved handle.");
  }

  claim(data, runId, assignment, handle, stage) {
    // Keep the assignment/handle binding after release or expiry. Only a short ledger transaction
    // acquires a lease; remote I/O never holds the global lock, and late workers cannot commit.
    data.completionClaims ??= [];
    let claim = data.completionClaims.find(item => item.runId === runId);
    if (claim) this.assertReservation(claim, assignment, handle);
    requireValue(!data.results.some(item => item.runId !== runId && sameExercise(item.assignment, assignment)) &&
      !data.completionClaims.some(item => item.runId !== runId && sameExercise(item.assignment, assignment)),
    "assignment_reused", "This issue or PR is already reserved for another run.");
    requireValue(!claim?.owner || claim.expiresAt <= this.now(), "completion_busy",
      "Another worker owns this run's completion lease. Retry after it completes or its lease expires.");
    if (!claim) {
      claim = { runId, assignment, requestedHandle: handle, fence: 0 };
      data.completionClaims.push(claim);
    }
    Object.assign(claim, { stage, owner: randomUUID(), fence: claim.fence + 1, expiresAt: this.now() + this.claimTtlMs });
    return structuredClone(claim);
  }

  assertClaim(data, lease) {
    const claim = data.completionClaims?.find(item => item.runId === lease.runId);
    requireValue(claim?.owner === lease.owner && claim.fence === lease.fence && claim.stage === lease.stage &&
      claim.expiresAt > this.now(), "completion_claim_lost", "This completion lease expired or was replaced. Retry with the current worker.");
    this.assertAssignment(lease.runId, lease.assignment);
    return claim;
  }

  async release(lease) {
    await this.store.transaction(data => {
      const claim = data.completionClaims?.find(item => item.runId === lease.runId);
      // A late worker must never release a successor's lease.
      if (claim?.owner === lease.owner && claim.fence === lease.fence) claim.owner = null;
    });
  }

  startHeartbeat(lease) {
    let stopped = false;
    let timer;
    let renewal = Promise.resolve();
    const schedule = () => {
      timer = setTimeout(() => {
        renewal = this.store.transaction(data => {
          const claim = this.assertClaim(data, lease);
          claim.expiresAt = this.now() + this.claimTtlMs;
        }).then(() => {
          if (!stopped) schedule();
        }, () => {
          // Never revive an expired/replaced lease. Every final commit independently checks
          // ownership and expiry; a renewal failure stops heartbeats, not an in-flight request.
        });
      }, Math.max(1, Math.floor(this.claimTtlMs / 3)));
    };
    schedule();
    return async () => {
      stopped = true;
      clearTimeout(timer);
      await renewal;
    };
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
    requireValue(Number.isSafeInteger(assignment.issueNumber) && assignment.issueNumber > 0,
      "invalid_assignment", "Completion requires a positive safe integer exercise issue number.");
    const reservation = await this.store.transaction(data => {
      this.assertAssignment(runId, assignment);
      const existing = data.results.find(result => result.runId === runId);
      if (existing) {
        this.assertReservation(existing, assignment, handle);
        validateAttempt(assignment);
        return { receipt: existing };
      }
      validateAttempt(assignment);
      return { lease: this.claim(data, runId, assignment, handle, "verify") };
    });
    if (reservation.receipt) return receiptProjection(reservation.receipt);
    const { lease } = reservation;
    const stopHeartbeat = this.startHeartbeat(lease);
    try {
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
      requireValue(views.completedAt === assignment.approvalAttempt.reviewedAt &&
        checkpoint.completedAt === assignment.approvalAttempt.checkpointAt,
      "approval_attempt_mismatch", "Trusted review and checkpoint evidence must belong to the registered approval attempt.");
      requireValue(Array.isArray(views.surfaces) && views.surfaces.length === 3 &&
        new Set(views.surfaces).size === 3 && ["summary", "changes", "checks"].every(surface => views.surfaces.includes(surface)),
        "views_incomplete", "Native review surface evidence is incomplete.");
      requireValue(checkpoint.passed === true && checkpoint.price === order.price &&
        checkpoint.serving === order.serving && checkpoint.scope === "one-drink",
      "checkpoint_incomplete", "The trusted acceptance-criteria checkpoint is incomplete.");
      const pr = await this.github.inspectPullRequest(assignment.prNumber, {
        expectedHeadSha: assignment.headSha, reviewer: assignment.reviewer, order,
        requiredChecks: assignment.requiredChecks, expectedBaseRef: assignment.baseRef,
        approvalAttemptId: assignment.approvalAttempt.id
      });
      // GitHub review timestamps have second precision; the trusted decision may include milliseconds.
      requireValue(pr && pr.headSha === assignment.headSha && pr.baseRef === assignment.baseRef &&
        pr.checksPassed === true && pr.approved === true && pr.approvedForAttempt === true &&
        Number.isFinite(utcTime(pr.approvedAt)) &&
        utcTime(pr.approvedAt) >= Math.floor(utcTime(assignment.approvalAttempt.decidedAt) / 1000) * 1000 &&
        pr.merged === true && pr.mergeCommitSha, "completion_ineligible",
      "GitHub approval, exact head checks, and merged menu must all verify independently.");
      const receipt = await this.store.transaction(data => {
        const claim = this.assertClaim(data, lease);
        requireValue(this.github.repo === assignment.repo, "repository_mismatch", "The GitHub verifier changed repositories.");
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
        claim.owner = null;
        return result;
      });
      return receiptProjection(receipt);
    } catch (error) {
      await this.release(lease);
      throw error;
    } finally {
      await stopHeartbeat();
    }
  }

  async finalize(input) {
    await this.accept(input);
    const reservation = await this.store.transaction(data => {
      const result = data.results.find(item => item.runId === input.runId);
      this.assertAssignment(input.runId, result.assignment);
      requireValue(this.github?.repo === result.assignment.repo, "repository_mismatch", "The issue writer must remain bound to the reserved repository.");
      if (result.commentId) return { receipt: result };
      requireValue(this.postComment, "comment_unconfigured",
        "The result is reserved. Configure the exercise-issue comment writer and retry.");
      return { result, lease: this.claim(data, input.runId, result.assignment, result.requestedHandle, "comment") };
    });
    if (reservation.receipt) return receiptProjection(reservation.receipt);
    const { result, lease } = reservation;
    const stopHeartbeat = this.startHeartbeat(lease);
    try {
      // Heartbeats exclude ordinary overlapping slow workers. They cannot retract a remote write
      // after a crash, partition, or lost lease. Exactly-once posting therefore still requires an
      // atomic remote idempotency service; GithubAdapter's read-then-create writer is NOT one.
      // The trusted writer MUST atomically deduplicate this stable key, returning the same verified
      // comment ID across retries/restarts and overlapping expired leases. A scan-then-post is not
      // sufficient: fencing protects the ledger, but cannot cancel an already in-flight GitHub write.
      const idempotencyKey = createHash("sha256").update(JSON.stringify({
        runId: result.runId, assignment: result.assignment
      })).digest("hex");
      const commentId = await this.postComment(result.assignment.issueNumber, receiptProjection(result), { idempotencyKey });
      requireValue(Number.isSafeInteger(commentId) && commentId > 0,
        "comment_unverified", "The issue comment writer did not return a verified comment ID.");
      return await this.store.transaction(data => {
        const claim = this.assertClaim(data, lease);
        const current = data.results.find(item => item.runId === input.runId);
        this.assertReservation(current, result.assignment, result.handle);
        requireValue(this.github?.repo === result.assignment.repo, "repository_mismatch", "The issue writer changed repositories.");
        current.commentId = commentId;
        claim.owner = null;
        return receiptProjection(current);
      });
    } catch (error) {
      await this.release(lease);
      throw error;
    } finally {
      await stopHeartbeat();
    }
  }

  async leaderboard() {
    const { results } = await this.store.read();
    return results.filter(result => result.commentId).map(({ handle, score }) => ({
      handle, score, liveRank: 1 + results.filter(result => result.commentId && result.score > score).length
    })).sort((a, b) => a.liveRank - b.liveRank || a.handle.localeCompare(b.handle));
  }
}
