import {
  DomainError, requireValue, exactInput, validRunId, makeRun, publicRun,
  rehearsalIssue, rehearsalReview, generateHandle, liveAssignment
} from "./domain.mjs";
import { checkpointFeedback } from "./content.mjs";

export class RunEngine {
  constructor({ store, catalog, config = {}, github = null, completion = null, viewEvidence = null }) {
    Object.assign(this, { store, catalog, config, github, completion, viewEvidence });
  }

  present(run) {
    return publicRun(run, { nativeReviewAvailable: run.mode === "live" && typeof this.viewEvidence?.read === "function" });
  }

  async open(input, { requireNew = false } = {}) {
    exactInput(input, ["runId", "mode", "orderId"]);
    requireValue(validRunId(input.runId), "invalid_run", "Use a stable run ID of 1-80 letters, digits, hyphens or underscores.", 400);
    requireValue(["rehearsal", "live"].includes(input.mode), "invalid_mode", "Choose rehearsal or live explicitly.", 400);
    return this.store.transaction(data => {
      let run = Object.hasOwn(data.runs, input.runId) ? data.runs[input.runId] : null;
      if (run) {
        requireValue(!requireNew, "run_exists", "That run ID already exists. Choose a fresh ID for the next attendee.");
        requireValue(run.mode === input.mode && (!input.orderId || input.orderId === run.order.id),
          "run_conflict", "This run ID belongs to a different mode or order. Use a new run ID.");
        if (run.mode === "live") {
          const assigned = this.config.runs?.[input.runId];
          requireValue(assigned && run.assignment.repo === this.config.repo &&
            ["issueNumber", "prNumber", "headSha", "reviewer", "orderId"].every(key => assigned[key] === run.assignment[key]),
          "assignment_changed", "This saved live run belongs to a different repository or assignment. Restore its configuration or create a new run.");
        }
        return this.present(run);
      }
      const assignment = input.mode === "live" ? liveAssignment(this.config, this.catalog, input.runId) : null;
      if (input.mode === "live") {
        requireValue(this.config.mode === "live" && assignment && this.github, "live_unconfigured",
          "Staff must configure the live repository and assign this run's issue, PR, reviewer and head SHA.");
        requireValue(!input.orderId || input.orderId === assignment.orderId, "order_conflict", "The order must match the staff assignment.");
        requireValue(!Object.values(data.runs).some(existing => existing.mode === "live" &&
          existing.assignment?.repo === this.config.repo &&
          (existing.assignment.issueNumber === assignment.issueNumber || existing.assignment.prNumber === assignment.prNumber)),
        "assignment_reused", "This issue or PR already belongs to another run. Staff must prepare a fresh issue and PR.");
      }
      const order = this.catalog.orders.find(item => item.id === (assignment?.orderId ?? input.orderId ?? "mona-latte"));
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
    return this.present(run);
  }

  async inspect(run) {
    const evidence = await this.github.inspectPullRequest(run.assignment.prNumber, {
      expectedHeadSha: run.assignment.headSha, reviewer: run.assignment.reviewer,
      order: run.order, requiredChecks: this.config.requiredChecks
    });
    requireValue(evidence.headSha === run.assignment.headSha && evidence.checksPassed,
      "evidence_invalid", "The assigned PR head and passing checks must be verified.");
    return evidence;
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
        if (run.mode !== "live" || !verificationFailed) throw error;
        // Roll back tentative work, but commit revocation under the same lock before rethrowing.
        saved.views = [];
        saved.evidenceHeadSha = null;
        saved.assessmentPassed = false;
        saved.reviewSyncedAt = null;
        saved.review = null;
        saved.statusMessage = saved.phase === "reviewing"
          ? "Review verification failed. Approval is locked; restore the trusted evidence and refresh verified review."
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

  async dispatch(runId, action, input = {}) {
    requireValue(validRunId(runId), "invalid_run", "Invalid run ID.", 400);
    if (action === "refresh") { exactInput(input); return this.get(runId); }
    if (action === "sync_review") { exactInput(input); return this.syncReview(runId); }
    if (action === "complete") { exactInput(input); return this.complete(runId); }
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
          requireValue(rehearsal, "native_views_unavailable", "Use native App review surfaces. Local clicks do not count as live view evidence.");
          requireValue(run.phase === "reviewing", "wrong_phase", "Start the order before opening review surfaces.");
          const surfaces = ["summary", "changes", "checks"];
          requireValue(surfaces.includes(input.surface), "invalid_surface", "Choose summary, changes or checks.", 400);
          requireValue(surfaces.indexOf(input.surface) <= run.views.length, "view_sequence", "Review the summary, then changes, then checks.");
          if (!run.views.includes(input.surface)) run.views.push(input.surface);
          run.statusMessage = `${input.surface} opened in the rehearsal. Compare the change with your order.`;
          break;
        }
        case "hint":
          exactInput(input);
          requireValue(["order", "reviewing", "approved"].includes(run.phase), "wrong_phase",
            "Hints are available before serving. Your saved menu and completion result are unchanged.");
          run.hintCount++;
          run.statusMessage = `Compare the added item with the issue: $${run.order.price.toFixed(2)}, ${run.order.serving}, and only one new drink. Hints never reduce your score.`;
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
          run.statusMessage = feedback ?? "Acceptance criteria checked. You can now make your approval decision.";
          break;
        }
        case "approve": {
          exactInput(input);
          if (["approved", "served", "completed"].includes(run.phase)) break;
          requireValue(run.phase === "reviewing" && run.assessmentPassed, "assessment_required", "Complete the acceptance-criteria checkpoint before approving.");
          if (!rehearsal) await verify(async () => {
            await this.verifyViews(run);
            let evidence = await this.inspect(run);
            requireValue(!evidence.merged && !evidence.approved, "assignment_used", "This run's PR was approved before the learner decision. Ask staff for a fresh assignment.");
            if (!evidence.approved) await this.github.approve(run.assignment.prNumber, {
              headSha: run.assignment.headSha, reviewer: run.assignment.reviewer
            });
            evidence = await this.inspect(run);
            requireValue(evidence.approved, "approval_unverified", "Approval has not been verified on GitHub. Retry verification.");
          });
          requireValue(run.views.length === 3, "review_incomplete", "Inspect summary, changes, and checks before approving.");
          run.phase = "approved";
          run.events.push({ type: rehearsal ? "rehearsal_approved" : "github_approval_verified", at: new Date().toISOString() });
          run.statusMessage = rehearsal ? "Rehearsal approval recorded. Apply the menu separately." : "GitHub approval verified. A separate merge must succeed before the drink is served.";
          break;
        }
        case "serve": {
          exactInput(input);
          if (["served", "completed"].includes(run.phase)) break;
          requireValue(run.phase === "approved", "approval_required", "Approve the correct PR before applying the menu.");
          if (!rehearsal) await verify(async () => {
            await this.verifyViews(run);
            const evidence = await this.inspect(run);
            requireValue(evidence.approved && evidence.merged && evidence.mergeCommitSha,
              "merge_pending", "Approval is not a merge. Wait for the authorized merge, then verify the merged menu again.");
            run.menu = evidence.menu;
            run.servedCommitSha = evidence.mergeCommitSha;
          });
          else run.menu = [run.order];
          run.phase = "served";
          run.completionPending = true;
          run.events.push({ type: rehearsal ? "rehearsal_menu_applied" : "merged_menu_verified", at: new Date().toISOString() });
          run.statusMessage = "Drink added to the menu. Preparing the final result.";
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
      requireValue(run && ["served", "completed"].includes(run.phase), "menu_required", "Verify the menu update before requesting a result.");
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
