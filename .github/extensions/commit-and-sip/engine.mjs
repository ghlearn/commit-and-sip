import {
  DomainError, requireValue, exactInput, validRunId, makeRun, publicRun,
  rehearsalIssue, rehearsalReview, generateHandle
} from "./domain.mjs";
import { checkpointFeedback } from "./content.mjs";

export class RunEngine {
  constructor({ store, catalog, config = {}, github = null, completion = null, viewEvidence = null }) {
    Object.assign(this, { store, catalog, config, github, completion, viewEvidence });
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
        return publicRun(run);
      }
      const assignment = input.mode === "live" ? this.config.runs?.[input.runId] : null;
      if (input.mode === "live") {
        requireValue(this.config.mode === "live" && assignment && this.github, "live_unconfigured",
          "Staff must configure the live repository and assign this run's issue, PR, reviewer and head SHA.");
        requireValue(Number.isSafeInteger(assignment.issueNumber) && assignment.issueNumber > 0 &&
          Number.isSafeInteger(assignment.prNumber) && assignment.prNumber > 0 &&
          /^[a-f0-9]{40}$/.test(assignment.headSha) &&
          typeof assignment.reviewer === "string" && /^[a-zA-Z0-9-]{1,39}$/.test(assignment.reviewer),
        "invalid_assignment", "The live assignment requires valid issue/PR numbers, reviewer, and exact head SHA.");
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
      return publicRun(run);
    });
  }

  async get(runId) {
    const data = await this.store.read();
    const run = Object.hasOwn(data.runs, runId) ? data.runs[runId] : null;
    requireValue(run, "run_missing", "Open this run before continuing.", 404);
    return publicRun(run);
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

  async verifyViews(run) {
    requireValue(this.viewEvidence, "native_views_unavailable",
      "Native App view evidence is not configured. Canvas clicks cannot certify live PR review.");
    const evidence = await this.viewEvidence.read({
      runId: run.runId, repo: this.config.repo, prNumber: run.assignment.prNumber,
      headSha: run.assignment.headSha
    });
    requireValue(evidence?.runId === run.runId && evidence.headSha === run.assignment.headSha &&
      evidence.prNumber === run.assignment.prNumber && evidence.repo === this.config.repo &&
      Array.isArray(evidence.surfaces) &&
      ["summary", "changes", "checks"].every(surface => evidence.surfaces.includes(surface)),
    "native_views_incomplete", "Open the assigned PR summary, changed files and checks in the App before approving.");
    run.views = ["summary", "changes", "checks"];
    run.evidenceHeadSha = evidence.headSha;
  }

  async dispatch(runId, action, input = {}) {
    requireValue(validRunId(runId), "invalid_run", "Invalid run ID.", 400);
    if (action === "refresh") { exactInput(input); return this.get(runId); }
    if (action === "complete") { exactInput(input); return this.complete(runId); }
    const state = await this.store.transaction(async data => {
      const run = Object.hasOwn(data.runs, runId) ? data.runs[runId] : null;
      requireValue(run, "run_missing", "Open this run before continuing.", 404);
      const rehearsal = run.mode === "rehearsal";
      switch (action) {
        case "start": {
          exactInput(input);
          if (run.phase !== "order") break;
          if (rehearsal) {
            run.issue = rehearsalIssue(run);
            run.review = rehearsalReview(run);
          } else {
            const issue = await this.github.readIssue(run.assignment.issueNumber);
            run.issue = { title: issue.title, body: issue.body, number: issue.number, url: issue.html_url };
            const evidence = await this.inspect(run);
            run.review = { summary: evidence.summary, files: evidence.files, checks: evidence.checks, headSha: evidence.headSha };
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
          run.hintCount++;
          run.statusMessage = `Compare the added item with the issue: $${run.order.price.toFixed(2)}, ${run.order.serving}, and only one new drink. Hints never reduce your score.`;
          break;
        case "check_order": {
          exactInput(input, ["price", "serving", "scope"]);
          requireValue(run.phase === "reviewing", "wrong_phase", "Check the order while reviewing.");
          if (!rehearsal) { await this.verifyViews(run); await this.inspect(run); }
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
          if (!rehearsal) await this.verifyViews(run);
          requireValue(run.views.length === 3, "review_incomplete", "Inspect summary, changes, and checks before approving.");
          if (!rehearsal) {
            let evidence = await this.inspect(run);
            requireValue(!evidence.merged, "already_merged", "This run's PR was merged before the approval step. Ask staff for a fresh assignment.");
            if (!evidence.approved) await this.github.approve(run.assignment.prNumber, {
              headSha: run.assignment.headSha, reviewer: run.assignment.reviewer
            });
            evidence = await this.inspect(run);
            requireValue(evidence.approved, "approval_unverified", "Approval has not been verified on GitHub. Retry verification.");
          }
          run.phase = "approved";
          run.events.push({ type: rehearsal ? "rehearsal_approved" : "github_approval_verified", at: new Date().toISOString() });
          run.statusMessage = rehearsal ? "Rehearsal approval recorded. Apply the menu separately." : "GitHub approval verified. A separate merge must succeed before the drink is served.";
          break;
        }
        case "serve": {
          exactInput(input);
          if (["served", "completed"].includes(run.phase)) break;
          requireValue(run.phase === "approved", "approval_required", "Approve the correct PR before applying the menu.");
          if (!rehearsal) {
            await this.verifyViews(run);
            const evidence = await this.inspect(run);
            requireValue(evidence.approved && evidence.merged && evidence.mergeCommitSha,
              "merge_pending", "Approval is not a merge. Wait for the authorized merge, then verify the merged menu again.");
            run.menu = evidence.menu;
          } else run.menu = [run.order];
          run.phase = "served";
          run.completionPending = true;
          run.events.push({ type: rehearsal ? "rehearsal_menu_applied" : "merged_menu_verified", at: new Date().toISOString() });
          run.statusMessage = "Drink added to the menu. Preparing the final result.";
          break;
        }
        default: throw new DomainError("unknown_action", "This canvas action is not supported.", 400);
      }
      return publicRun(run);
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
    return this.store.transaction(async data => {
      const run = data.runs[runId];
      if (run.phase === "completed") return publicRun(run);
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
        requireValue(this.completion && this.viewEvidence, "completion_unconfigured",
          "The authenticated leaderboard completion service and native review evidence must be configured. Your verified menu update is preserved.");
        await this.verifyViews(run);
        const evidence = await this.inspect(run);
        requireValue(evidence.approved && evidence.merged, "completion_evidence", "GitHub approval and merged menu must still verify before completion.");
        run.result = await this.completion.finish(run);
      }
      run.phase = "completed";
      run.completionPending = false;
      run.statusMessage = run.mode === "rehearsal" ? "Rehearsal complete. No real PR, issue comment or event leaderboard was changed." :
        "Completed. Your final result is recorded in the exercise issue.";
      return publicRun(run);
    });
  }
}
