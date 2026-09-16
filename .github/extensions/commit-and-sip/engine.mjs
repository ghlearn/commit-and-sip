import {
  DomainError, requireValue, exactInput, validRunId, makeRun, publicRun,
  rehearsalIssue, rehearsalReview, generateHandle, liveAssignment, validBaseRef
} from "./domain.mjs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { checkpointFeedback } from "./content.mjs";
import { provisionRecords } from "./services/provision.mjs";

export class RunEngine {
  constructor({ store, catalog, config = {}, github = null, completion = null, viewEvidence = null }) {
    Object.assign(this, { store, catalog, config, github, completion, viewEvidence });
  }

  present(run) {
    return publicRun(run, { nativeReviewAvailable: run.mode === "live" && typeof this.viewEvidence?.read === "function" });
  }

  requireLiveAdapters(mode = "live") {
    requireValue(this.config?.mode === mode && this.github, "live_unconfigured",
      "Live mode and its GitHub adapter must be configured before opening or using a live run.");
  }

  assertRunBinding(run) {
    requireValue(["rehearsal", "live", "live-canvas-pilot"].includes(run.mode), "invalid_mode", "The saved run mode is invalid.");
    if (run.mode === "rehearsal") return;
    this.requireLiveAdapters(run.mode);
    const assigned = liveAssignment(this.config, this.catalog, run.runId);
    requireValue(isDeepStrictEqual(assigned, run.assignment) &&
      isDeepStrictEqual(this.catalog.orders.find(order => order.id === assigned.orderId), run.order),
    "assignment_changed", "This saved run has a different or unbound assignment, source, order, or check policy. Restore its original configuration.");
    if (run.mode === "live-canvas-pilot") requireValue(
      ["order", "reviewing", "approved", "pilot-served"].includes(run.phase) &&
      run.result === null && run.handle === null && run.commentId === null && run.completionPending === false,
    "pilot_state_invalid", "This pilot has incompatible event-result state. Preserve the run for staff recovery; it cannot be converted to a ranked result.");
  }

  async open(input, { requireNew = false } = {}) {
    exactInput(input, ["runId", "mode", "orderId"]);
    requireValue(validRunId(input.runId), "invalid_run", "Use a stable run ID of 1-80 letters, digits, hyphens or underscores.", 400);
    requireValue(["rehearsal", "live", "live-canvas-pilot"].includes(input.mode), "invalid_mode", "Choose rehearsal, live, or live-canvas-pilot explicitly.", 400);
    return this.store.transaction(data => {
      let run = Object.hasOwn(data.runs, input.runId) ? data.runs[input.runId] : null;
      if (run) {
        requireValue(!requireNew, "run_exists", "That run ID already exists. Choose a fresh ID for the next attendee.");
        requireValue(run.mode === input.mode && (!input.orderId || input.orderId === run.order.id),
          "run_conflict", "This run ID belongs to a different mode or order. Use a new run ID.");
        this.assertRunBinding(run);
        return this.present(run);
      }
      const assignment = input.mode !== "rehearsal" ? liveAssignment(this.config, this.catalog, input.runId) : null;
      if (input.mode !== "rehearsal") {
        this.requireLiveAdapters(input.mode);
        requireValue(!input.orderId || input.orderId === assignment.orderId, "order_conflict", "The order must match the staff assignment.");
        requireValue(!Object.values(data.runs).some(existing => existing.mode !== "rehearsal" &&
          existing.assignment?.repo.toLowerCase() === this.config.repo.toLowerCase() &&
          (existing.assignment.issueNumber === assignment.issueNumber || existing.assignment.prNumber === assignment.prNumber)),
        "assignment_reused", "This issue or PR already belongs to another run. Staff must prepare a fresh issue and PR.");
      }
      for (const provision of provisionRecords(data)) {
        if (provision.runId === input.runId) {
          requireValue(input.mode !== "rehearsal" && provision.stage === "installed" &&
            isDeepStrictEqual(assignment, { ...provision.assignment, issueNumber: provision.issueNumber }),
          "provision_conflict", "This run is reserved for provisioning. Staff must finish installing its original assignment before opening it.");
        } else if (assignment?.repo.toLowerCase() === provision.assignment.repo.toLowerCase()) {
          requireValue(assignment.prNumber !== provision.assignment.prNumber && assignment.issueNumber !== provision.issueNumber,
            "assignment_reused", "This issue or PR is reserved by a provisioned run.");
        }
      }
      if (input.mode === "rehearsal") requireValue(typeof input.orderId === "string", "order_required",
        "Choose a catalog drink explicitly when creating a new rehearsal. Omit it only when resuming a saved run.", 400);
      const order = this.catalog.orders.find(item => item.id === (assignment?.orderId ?? input.orderId));
      requireValue(order, "invalid_order", "Choose Mona Latte, Copilot Cortado, or Ducky Cold Brew.", 400);
      run = makeRun({
        runId: input.runId, mode: input.mode, order,
        assignment: assignment ? { ...assignment, repo: this.config.repo } : null
      });
      data.runs[input.runId] = run;
      return this.present(run);
    });
  }

  async get(runId) {
    const data = await this.store.read();
    const run = Object.hasOwn(data.runs, runId) ? data.runs[runId] : null;
    requireValue(run, "run_missing", "Open this run before continuing.", 404);
    this.assertRunBinding(run);
    return this.present(run);
  }

  async inspect(run) {
    requireValue(validBaseRef(run.assignment.baseRef) && Array.isArray(run.assignment.requiredChecks) &&
      run.assignment.requiredChecks.length > 0 &&
      run.assignment.requiredChecks.every(name => typeof name === "string" && name.trim().length > 0) &&
      new Set(run.assignment.requiredChecks).size === run.assignment.requiredChecks.length,
    "assignment_changed", "This saved run has no valid pinned branch/check policy. Staff must restore its original verified assignment.");
    if (run.approvalAttempt) {
      requireValue(isDeepStrictEqual(run.approvalAttempt.identity, { ...run.assignment, runId: run.runId }),
        "approval_attempt_conflict", "The saved approval attempt belongs to a different assignment. Restore the original assignment.");
    }
    const evidence = await this.github.inspectPullRequest(run.assignment.prNumber, {
      expectedHeadSha: run.assignment.headSha, reviewer: run.assignment.reviewer,
      order: run.order, requiredChecks: [...run.assignment.requiredChecks], expectedBaseRef: run.assignment.baseRef,
      ...(run.mode === "live-canvas-pilot" ? { verifyCurrentBase: true } : {}),
      ...(run.approvalAttempt ? { approvalAttemptId: run.approvalAttempt.id } : {})
    });
    requireValue(evidence.headSha === run.assignment.headSha && evidence.baseRef === run.assignment.baseRef && evidence.checksPassed,
      "evidence_invalid", "The assigned PR head, base branch, and passing checks must be verified.");
    if (run.mode === "live-canvas-pilot") requireValue(typeof evidence.summary === "string" && evidence.summary.trim() &&
      evidence.files?.length === 1 && typeof evidence.files[0].patch === "string" && evidence.files[0].patch.trim() &&
      Array.isArray(evidence.checks) && evidence.checks.length > 0,
    "review_unavailable", "The real PR summary, text patch, and checks must be available for in-canvas inspection.");
    return evidence;
  }

  reviewIdentity(run) {
    return { ...run.assignment, runId: run.runId };
  }

  async readViews(run) {
    requireValue(typeof this.viewEvidence?.read === "function", "native_views_unavailable",
      "Native App view evidence is not configured. Canvas clicks cannot certify live PR review.");
    const evidence = await this.viewEvidence.read({
      runId: run.runId, repo: run.assignment.repo, prNumber: run.assignment.prNumber,
      headSha: run.assignment.headSha
    });
    const surfaces = ["summary", "changes", "checks"];
    requireValue(evidence?.runId === run.runId && evidence.headSha === run.assignment.headSha &&
      evidence.prNumber === run.assignment.prNumber && evidence.repo === run.assignment.repo &&
      Array.isArray(evidence.surfaces) && evidence.surfaces.every(surface => surfaces.includes(surface)) &&
      new Set(evidence.surfaces).size === evidence.surfaces.length,
    "native_views_invalid", "Review evidence does not match this run, repository, PR, and revision. Ask staff to verify the assignment.");
    return surfaces.filter(surface => evidence.surfaces.includes(surface));
  }

  async verifyViews(run) {
    if (run.mode === "live-canvas-pilot") {
      requireValue(isDeepStrictEqual(run.canvasReview?.identity, this.reviewIdentity(run)) &&
        isDeepStrictEqual(run.canvasReview?.surfaces, ["summary", "changes", "checks"]) &&
        isDeepStrictEqual(run.views, run.canvasReview.surfaces),
      "canvas_review_incomplete", "Inspect all three real PR sections in this pilot canvas for the assigned revision.");
      run.evidenceHeadSha = run.assignment.headSha;
      return;
    }
    const views = await this.readViews(run);
    requireValue(views.length === 3, "native_views_incomplete", "Open the assigned PR summary, changed files and checks in the App before approving.");
    run.views = views;
    run.evidenceHeadSha = run.assignment.headSha;
  }

  async runTransaction(runId, operation) {
    let failure;
    const state = await this.store.transaction(async data => {
      const run = Object.hasOwn(data.runs, runId) ? data.runs[runId] : null;
      requireValue(run, "run_missing", "Open this run before continuing.", 404);
      this.assertRunBinding(run);
      const saved = structuredClone(run);
      let verificationFailed = false;
      const verify = async check => {
        try { return await check(); }
        catch (error) {
          verificationFailed = true;
          throw error;
        }
      };
      try {
        return await operation(run, data, verify);
      } catch (error) {
        if (run.mode === "rehearsal" || !verificationFailed) throw error;
        // Roll back tentative work, but commit revocation under the same lock before rethrowing.
        saved.views = [];
        saved.evidenceHeadSha = null;
        saved.assessmentPassed = false;
        saved.reviewSyncedAt = null;
        saved.review = null;
        if (run.mode === "live-canvas-pilot") {
          saved.canvasReview = null;
          saved.checkpointAnswers = null;
        }
        saved.statusMessage = saved.phase === "reviewing"
          ? "Review verification failed. Approval is locked; restore verification and inspect the assigned review again."
          : "Live verification failed. Saved progress is preserved; restore the trusted evidence and retry the current step.";
        data.runs[runId] = saved;
        failure = { error };
        return this.present(saved);
      }
    });
    if (failure) throw failure.error;
    return state;
  }

  async syncReview(runId) {
    return this.runTransaction(runId, async (run, data, verify) => {
      requireValue(run.mode === "live" && run.phase === "reviewing", "wrong_phase", "Refresh verified review while reviewing a live assignment.");
      await verify(async () => {
        const views = await this.readViews(run);
        const evidence = await this.inspect(run);
        requireValue(!evidence.merged, "already_merged", "This PR was merged before this run's approval. Ask staff for a fresh assignment.");
        run.views = views;
        run.evidenceHeadSha = views.length === 3 ? run.assignment.headSha : null;
        if (views.length !== 3) run.assessmentPassed = false;
        run.review = { summary: evidence.summary, files: evidence.files, checks: evidence.checks, headSha: evidence.headSha };
        run.reviewSyncedAt = new Date().toISOString();
        run.statusMessage = views.length === 3
          ? "All three native PR views and current checks verified. Compare the order and complete the factual checkpoint."
          : `${views.length} of 3 native PR views verified. Inspect the remaining sections in the App, then refresh verified review.`;
      });
      return this.present(run);
    });
  }

  async prepareApproval(runId) {
    return this.runTransaction(runId, async (run, data, verify) => {
      if (run.mode === "rehearsal" || ["approved", "served", "completed", "pilot-served"].includes(run.phase)) return;
      requireValue(run.phase === "reviewing" && run.assessmentPassed, "assessment_required", "Complete the acceptance-criteria checkpoint before approving.");
      await verify(async () => {
        await this.verifyViews(run);
        if (run.mode === "live-canvas-pilot") requireValue(isDeepStrictEqual(run.checkpointAnswers,
          { price: run.order.price, serving: run.order.serving, scope: "one-drink" }),
        "checkpoint_required", "Submit your actual checkpoint answers before approving this pilot.");
        const evidence = await this.inspect(run);
        requireValue(!evidence.merged && (!evidence.approved || (run.approvalAttempt && evidence.approvedForAttempt === true)),
          "assignment_used", "This PR has an approval from outside this run's learner decision. Ask staff for a fresh assignment.");
        if (!run.approvalAttempt) run.approvalAttempt = { id: randomUUID(), identity: structuredClone({ ...run.assignment, runId }) };
      });
    });
  }

  async dispatch(runId, action, input = {}) {
    requireValue(validRunId(runId), "invalid_run", "Invalid run ID.", 400);
    if (action === "refresh") { exactInput(input); return this.get(runId); }
    if (action === "sync_review") { exactInput(input); return this.syncReview(runId); }
    if (action === "complete") { exactInput(input); return this.complete(runId); }
    if (action === "approve") { exactInput(input); await this.prepareApproval(runId); }
    const state = await this.runTransaction(runId, async (run, data, verify) => {
      const rehearsal = run.mode === "rehearsal";
      switch (action) {
        case "start": {
          exactInput(input);
          if (run.phase !== "order") break;
          if (rehearsal) {
            run.issue = rehearsalIssue(run);
            run.review = rehearsalReview(run);
          } else {
            await verify(async () => {
              const issue = await this.github.readIssue(run.assignment.issueNumber);
              run.issue = { title: issue.title, body: issue.body, number: issue.number, url: issue.html_url };
              const evidence = await this.inspect(run);
              run.review = { summary: evidence.summary, files: evidence.files, checks: evidence.checks, headSha: evidence.headSha };
            });
          }
          run.phase = "reviewing";
          run.events.push({ type: "started", at: new Date().toISOString() });
          run.statusMessage = "Inspect the summary, changed menu file, and check results.";
          break;
        }
        case "view": {
          exactInput(input, ["surface"]);
          requireValue(rehearsal || run.mode === "live-canvas-pilot", "native_views_unavailable", "Use native App review surfaces. Local clicks do not count as live view evidence.");
          requireValue(run.phase === "reviewing", "wrong_phase", "Start the order before opening review surfaces.");
          const surfaces = ["summary", "changes", "checks"];
          requireValue(surfaces.includes(input.surface), "invalid_surface", "Choose summary, changes or checks.", 400);
          requireValue(surfaces.indexOf(input.surface) <= run.views.length, "view_sequence", "Review the summary, then changes, then checks.");
          if (!rehearsal) await verify(async () => {
            const evidence = await this.inspect(run);
            requireValue(!evidence.merged, "already_merged", "This PR was merged before this run's approval. Ask staff for a fresh assignment.");
            run.review = { summary: evidence.summary, files: evidence.files, checks: evidence.checks, headSha: evidence.headSha };
            if (run.canvasReview) requireValue(isDeepStrictEqual(run.canvasReview.identity, this.reviewIdentity(run)),
              "canvas_review_invalid", "Canvas observations belong to another assignment. Inspect this assigned revision again.");
            run.canvasReview ??= { identity: structuredClone(this.reviewIdentity(run)), surfaces: [] };
            if (!run.canvasReview.surfaces.includes(input.surface)) run.canvasReview.surfaces.push(input.surface);
          });
          if (!run.views.includes(input.surface)) run.views.push(input.surface);
          run.statusMessage = rehearsal ? `${input.surface} opened in the rehearsal. Compare the change with your order.`
            : `${input.surface} opened in the real GitHub-connected pilot canvas. In-canvas observation only, not native App tracking or comprehension evidence.`;
          break;
        }
        case "hint":
          exactInput(input);
          requireValue(["order", "reviewing", "approved"].includes(run.phase), "wrong_phase",
            "Hints are available before serving. Your saved menu and completion result are unchanged.");
          run.hintCount++;
          run.statusMessage = `Compare the added item with the issue: $${run.order.price.toFixed(2)}, ${run.order.serving}, and only one new drink. ${run.mode === "live-canvas-pilot" ? "Hints are free; this pilot is unranked." : "Hints never reduce your score."}`;
          break;
        case "check_order": {
          exactInput(input, ["price", "serving", "scope"]);
          requireValue(run.phase === "reviewing", "wrong_phase", "Check the order while reviewing.");
          if (!rehearsal) await verify(async () => {
            await this.verifyViews(run);
            const evidence = await this.inspect(run);
            requireValue(!evidence.merged, "already_merged", "This PR was merged before this run's approval. Ask staff for a fresh assignment.");
          });
          requireValue(run.views.length === 3, "review_incomplete", "Inspect the summary, changes, and checks first.");
          requireValue(typeof input.price === "number" && Number.isFinite(input.price) && input.price >= 0 && input.price <= 100 &&
            ["hot", "cold"].includes(input.serving) && ["one-drink", "unrelated-edits"].includes(input.scope),
          "invalid_answers", "Enter a price, serving style, and change scope.", 400);
          run.assessmentAttempts++;
          const feedback = checkpointFeedback(run.order, input);
          run.assessmentPassed = feedback === null;
          if (run.mode === "live-canvas-pilot") run.checkpointAnswers = structuredClone(input);
          run.statusMessage = feedback ?? "Acceptance criteria checked. You can now make your approval decision.";
          break;
        }
        case "approve": {
          exactInput(input);
          if (["approved", "served", "completed", "pilot-served"].includes(run.phase)) break;
          requireValue(run.phase === "reviewing" && run.assessmentPassed, "assessment_required", "Complete the acceptance-criteria checkpoint before approving.");
          if (!rehearsal) await verify(async () => {
            await this.verifyViews(run);
            let evidence = await this.inspect(run);
            requireValue(!evidence.merged && (!evidence.approved || evidence.approvedForAttempt === true), "assignment_used", "This PR has an approval from outside this run's learner decision. Ask staff for a fresh assignment.");
            if (!evidence.approved) await this.github.approve(run.assignment.prNumber, {
              headSha: run.assignment.headSha, reviewer: run.assignment.reviewer,
              expectedBaseRef: run.assignment.baseRef, approvalAttemptId: run.approvalAttempt.id
            });
            evidence = await this.inspect(run);
            requireValue(evidence.approved && evidence.approvedForAttempt === true, "approval_unverified", "Approval has not been verified on GitHub. Retry verification.");
          });
          requireValue(run.views.length === 3, "review_incomplete", "Inspect summary, changes, and checks before approving.");
          if (run.mode === "live-canvas-pilot") run.pilotDecision = {
            identity: structuredClone(this.reviewIdentity(run)), surfaces: [...run.views],
            answers: structuredClone(run.checkpointAnswers), approvalAttemptId: run.approvalAttempt.id
          };
          run.phase = "approved";
          run.events.push({ type: rehearsal ? "rehearsal_approved" : "github_approval_verified", at: new Date().toISOString() });
          run.statusMessage = rehearsal ? "Rehearsal approval recorded. Apply the menu separately." : "GitHub approval verified. A separate merge must succeed before the drink is served.";
          break;
        }
        case "serve": {
          exactInput(input);
          if (["served", "completed", "pilot-served"].includes(run.phase)) break;
          requireValue(run.phase === "approved", "approval_required", "Approve the correct PR before applying the menu.");
          if (!rehearsal) await verify(async () => {
            if (run.mode === "live-canvas-pilot") {
              requireValue(isDeepStrictEqual(run.pilotDecision?.identity, this.reviewIdentity(run)) &&
                isDeepStrictEqual(run.pilotDecision?.surfaces, ["summary", "changes", "checks"]) &&
                isDeepStrictEqual(run.pilotDecision?.answers, { price: run.order.price, serving: run.order.serving, scope: "one-drink" }) &&
                run.approvalAttempt?.id && run.pilotDecision.approvalAttemptId === run.approvalAttempt.id,
              "pilot_decision_invalid", "Serving requires this pilot's saved explicit review decision and submitted checkpoint.");
            } else await this.verifyViews(run);
            const evidence = await this.inspect(run);
            if (run.mode === "live-canvas-pilot") requireValue(evidence.approvedForAttempt === true,
              "approval_unverified", "The current GitHub approval must match this pilot's exact decision marker.");
            requireValue(evidence.approved && evidence.merged && evidence.mergeCommitSha,
              "merge_pending", "Approval is not a merge. Wait for the authorized merge, then verify the merged menu again.");
            run.menu = evidence.menu;
            run.servedCommitSha = evidence.mergeCommitSha;
          });
          else run.menu = [run.order];
          run.phase = run.mode === "live-canvas-pilot" ? "pilot-served" : "served";
          run.completionPending = run.mode !== "live-canvas-pilot";
          run.events.push({ type: rehearsal ? "rehearsal_menu_applied" : "merged_menu_verified", at: new Date().toISOString() });
          run.statusMessage = run.mode === "live-canvas-pilot"
            ? "Pilot learning activity finished: authorized merge and menu verified. Unranked; no native Skills/event completion, score, or issue update."
            : "Drink added to the menu. Preparing the final result.";
          break;
        }
        default: throw new DomainError("unknown_action", "This canvas action is not supported.", 400);
      }
      return this.present(run);
    });
    if (state.phase === "served") return this.complete(runId);
    return state;
  }

  async complete(runId) {
    // Reserve the handle durably before any remote request: retries cannot regenerate it.
    await this.store.transaction(data => {
      const run = Object.hasOwn(data.runs, runId) ? data.runs[runId] : null;
      requireValue(run?.mode !== "live-canvas-pilot", "pilot_not_ranked", "This pilot cannot submit an event result or generate a score, rank, handle, or QR.");
      requireValue(run && ["served", "completed"].includes(run.phase), "menu_required", "Verify the menu update before requesting a result.");
      this.assertRunBinding(run);
      if (!run.handle) {
        run.handle = generateHandle(this.catalog.words, new Set(Object.values(data.runs).map(item => item.handle).filter(Boolean)));
      }
    });
    return this.runTransaction(runId, async (run, data, verify) => {
      if (run.phase === "completed") return this.present(run);
      if (run.mode === "rehearsal") {
        let result = data.results.find(item => item.runId === runId);
        if (!result) {
          const score = 1000;
          result = {
            runId, handle: run.handle, score,
            rankAtCompletion: 1 + data.results.filter(item => item.score > score).length,
            completedAt: new Date().toISOString(), judge: null,
            leaderboardUrl: null, qrImageUrl: null
          };
          data.results.push(result);
        }
        run.result = result;
      } else {
        await verify(async () => {
          await this.verifyViews(run);
          const evidence = await this.inspect(run);
          requireValue(evidence.approved && evidence.merged, "completion_evidence", "GitHub approval and merged menu must still verify before completion.");
        });
        requireValue(this.completion, "completion_unconfigured",
          "The authenticated leaderboard completion service must be configured. Your verified menu update is preserved.");
        run.result = await this.completion.finish(run);
      }
      run.phase = "completed";
      run.completionPending = false;
      run.statusMessage = run.mode === "rehearsal" ? "Rehearsal complete. No real PR, issue comment or event leaderboard was changed." :
        "Completed. Your final result is recorded in the exercise issue.";
      return this.present(run);
    });
  }
}
