import { resultLinks } from "./result-links.mjs";

(() => {
  "use strict";

  const ticketKey = "commit-and-sip:panel-ticket";
  const queryTicket = new URLSearchParams(window.location.search).get("ticket");
  let ticket = queryTicket;
  let storageUnavailable = false;
  try {
    if (queryTicket) window.sessionStorage.setItem(ticketKey, queryTicket);
    else ticket = window.sessionStorage.getItem(ticketKey);
  } catch {
    storageUnavailable = true;
  }
  if (!storageUnavailable) window.history.replaceState(null, "", "/");
  const $ = (id) => document.getElementById(id);
  const surfaces = ["summary", "changes", "checks"];
  const phases = ["order", "reviewing", "approved", "served", "completed", "pilot-served"];
  const labels = { order: "Order received", reviewing: "In review", approved: "Approved", served: "Served", completed: "Completed", "pilot-served": "Pilot served · unranked" };
  const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  let state = null;
  let busy = false;
  let mutating = false;
  let stale = true;
  let lastPaint = "";
  let actionError = false;
  let activeSurface = null;
  let guideSignature = "";

  function text(id, value) {
    const node = $(id);
    const next = value == null ? "" : String(value);
    if (node.textContent !== next) node.textContent = next;
  }

  function element(tag, value, className) {
    const node = document.createElement(tag);
    if (value != null) node.textContent = String(value);
    if (className) node.className = className;
    return node;
  }

  function formatPrice(value) {
    if (value == null || value === "") return "—";
    const amount = typeof value === "number" ? value
      : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
    return Number.isFinite(amount) ? currency.format(amount) : String(value);
  }

  function fail(error, fromAction = false) {
    actionError = actionError || fromAction;
    text("error-message", error.message || "The booth connection could not be reached.");
    $("error-region").hidden = false;
  }

  function primaryAction() {
    if (!state) return { label: ticket ? "Awaiting connection…" : "Reopen canvas to connect", enabled: false };
    const reviewed = surfaces.every((surface) => state.views.includes(surface));
    switch (state.phase) {
      case "order": return { action: "start", label: state.mode === "rehearsal" ? "Start rehearsal order" : state.mode === "live-canvas-pilot" ? "Start real GitHub pilot" : "Start live order", enabled: true };
      case "reviewing": return { action: "approve", label: state.mode === "rehearsal" ? "Approve rehearsal change" : state.mode === "live-canvas-pilot" ? "Approve pull request on GitHub" : "Approve reviewed change", enabled: reviewed && state.assessmentPassed === true };
      case "approved": return { action: "serve", label: state.mode === "rehearsal" ? "Apply rehearsal menu" : "Verify merged menu", enabled: true };
      case "served": return { action: "complete", label: "Retry result", enabled: true };
      case "pilot-served": return { label: "Pilot served · unranked", enabled: false };
      default: return { label: "Order completed", enabled: false };
    }
  }

  function controls() {
    const primary = primaryAction();
    text("primary-action", primary.label);
    $("primary-action").disabled = busy || stale || !ticket || !primary.enabled;
    $("primary-action").dataset.action = primary.action || "";
    document.querySelectorAll("[data-action]").forEach((button) => {
      if (button.id === "primary-action") return;
      const action = button.dataset.action;
      button.disabled = busy || !ticket || !state ||
        (stale && action !== "refresh") ||
        (action === "sync_review" && (state.mode !== "live" || state.phase !== "reviewing" || !state.verification?.nativeReviewAvailable)) ||
        (action === "view" && (!["rehearsal", "live-canvas-pilot"].includes(state.mode) || state.phase !== "reviewing")) ||
        (action === "hint" && !["order", "reviewing", "approved"].includes(state.phase));
    });
    const canCheck = state?.phase === "reviewing" && state.assessmentPassed !== true &&
      surfaces.every((surface) => state.views.includes(surface));
    $("order-check-fields").disabled = !canCheck || stale || mutating;
    $("check-order-action").disabled = !canCheck || stale || busy;
    $("retry-connection").disabled = busy || !ticket;
    $("counter").setAttribute("aria-busy", String(busy));
  }

  function paintExercise() {
    text("exercise-title", state.exercise.title);
    text("exercise-progress", state.phase === "completed"
      ? "Step 1 of 1 complete. Your result is below; there is no next learner step."
      : state.phase === "pilot-served" ? "Pilot learning finished. Not native Skills completion or event finalization."
      : `Step 1 of 1: ${labels[state.phase]}. Read, review, approve, and serve are activities within this step.`);
    $("exercise-guide").hidden = false;
    const signature = JSON.stringify(state.exercise.sections);
    if (guideSignature !== signature) {
      const sections = state.exercise.sections.map(({ heading, paragraphs }) => {
        const section = element("section");
        section.append(element("h3", heading), ...paragraphs.map(paragraph => element("p", paragraph)));
        return section;
      });
      $("exercise-sections").replaceChildren(...sections);
      guideSignature = signature;
    }
  }

  function paintMenu() {
    const menu = document.createDocumentFragment();
    state.menu.forEach((drink) => {
      const item = element("li");
      const heading = element("div", null, "menu-heading");
      heading.append(element("h3", drink.name), element("span", formatPrice(drink.price), "menu-price"));
      item.append(heading, element("p", drink.description));
      if (drink.id === state.order?.id) item.append(element("p", "Your assigned order", "assigned"));
      menu.append(item);
    });
    if (!state.menu.length) {
      const pending = element("li");
      const served = ["served", "completed"].includes(state.phase);
      pending.append(
        element("h3", state.order?.name || "Your reviewed drink"),
        element("p", served
          ? "No served menu entries have been returned yet. Refresh progress to check the saved menu."
          : "Your reviewed drink will appear here after it is served."),
        element("p", served ? "Waiting for menu data" : "Pending menu entry", "assigned"),
      );
      menu.append(pending);
    }
    $("menu").replaceChildren(menu);
  }

  function paintReview() {
    const rehearsal = state.mode === "rehearsal";
    const pilot = state.mode === "live-canvas-pilot";
    const canvasReview = rehearsal || pilot;
    const pilotDecided = pilot && ["approved", "pilot-served"].includes(state.phase);
    const review = state.review;
    $("review-surfaces").hidden = state.phase === "order" || pilotDecided;
    text("review-summary", review?.summary || "No review summary has been received.");
    text("head-sha", review?.headSha ? `Review revision: ${review.headSha}` : "");
    const files = document.createDocumentFragment();
    (review?.files || []).forEach((file) => {
      const article = element("article", null, "patch-file");
      const patch = element("pre", file.patch || "No text patch available for this file.");
      patch.tabIndex = 0;
      patch.setAttribute("aria-label", `Patch for ${file.filename}`);
      article.append(element("h4", file.filename), patch);
      files.append(article);
    });
    if (!review?.files?.length) files.append(element("p", "No changed files have been received."));
    $("changes-content").replaceChildren(files);
    const checks = element("ul", null, "check-list");
    (review?.checks || []).forEach((check) => {
      const item = element("li");
      item.append(element("span", pilot ? `${check.name} · ${check.appSlug || check.kind || "publisher unavailable"}` : check.name), element("strong", check.conclusion || "Pending"));
      checks.append(item);
    });
    $("checks-content").replaceChildren(review?.checks?.length ? checks : element("p", "No check results have been received."));
    surfaces.forEach((surface) => {
      const visited = state.views.includes(surface);
      const button = document.querySelector(`[data-surface="${surface}"]`);
      button.hidden = !canvasReview;
      button.setAttribute("aria-controls", `${surface}-content`);
      button.setAttribute("aria-expanded", String(visited || surface === activeSurface));
      button.textContent = `${visited ? "✓ Opened" : "Open"} ${surface}`;
      $("" + surface + "-content").hidden = canvasReview && !visited && surface !== activeSurface;
    });
    text("view-count", `${surfaces.filter((surface) => state.views.includes(surface)).length} / 3`);
    $("view-count").hidden = pilotDecided;
    $("view-count").setAttribute("aria-label", `${surfaces.filter((surface) => state.views.includes(surface)).length} of 3 review sections opened`);
    $("sync-review-action").hidden = canvasReview;
    $("verified-review-status").hidden = canvasReview;
    text("verified-review-status", state.verification?.nativeReviewAvailable
      ? state.verification.syncedAt
        ? `Trusted review evidence checked at ${state.verification.syncedAt}. Refresh again after visiting another native section.`
        : "Native review reader connected. Open the assigned PR sections in the App, then refresh verified review."
      : "Native review integration is unavailable. Staff must connect the trusted reader; approval remains locked.");
    text("review-help", pilotDecided
      ? "Your explicit review decision is saved. Approval is separate from serving; see Your app result and House menu for verified serving status."
      : rehearsal
      ? "Review all three sections, then check the order details before approving. These are simulated PR details, not native App screenshots."
      : pilot ? "Open each real GitHub section here, then submit your checkpoint answers. Progress records in-canvas observation only, not native App tracking or proof of comprehension. Unranked and not leaderboard eligible."
      : "Review in the native Copilot App, then use Refresh verified review. Opening these copied details or refreshing saved progress does not certify a live review.");
    $("order-check").hidden = state.phase === "order" || pilotDecided;
    const reviewed = surfaces.every((surface) => state.views.includes(surface));
    if (state.assessmentPassed === true) {
      $("check-price").value = state.order.price;
      $("check-serving").value = state.order.serving;
      $("check-scope").value = "one-drink";
    }
    $("review-feedback-link").hidden = state.phase !== "reviewing" || state.assessmentPassed || !state.assessmentAttempts;
    text("assessment-status", `${state.assessmentPassed === true
      ? "Order details match the validated change."
      : !reviewed ? "Review all three sections to unlock this factual check."
        : state.assessmentAttempts > 0 ? "Order details have not passed. Review the order and try again."
          : "Order details not checked yet."} Attempts: ${state.assessmentAttempts ?? 0}.`);
  }

  function paintAppResult() {
    const pilot = state.mode === "live-canvas-pilot";
    $("app-result").hidden = state.mode === "rehearsal";
    const served = ["served", "completed", "pilot-served"].includes(state.phase);
    text("app-result-status", state.phase === "pilot-served" ? "Served — unranked pilot menu verified"
      : state.phase === "completed" ? "Served — event result recorded"
      : served ? "Served — event result pending"
        : state.phase === "approved" ? "Approved — waiting for an authorized merge"
          : "Not served — review and approval required");
    text("app-result-detail", pilot && served
      ? `${state.order.name} is on the verified House menu. No event finalization is pending: this pilot is ineligible for handles, scores, rankings, QR, AI judging, and final issue updates.`
      : served
      ? `${state.order.name} is on the verified menu below. ${state.phase === "completed"
        ? "The accepted exercise result is recorded."
        : "No event score or issue update is confirmed yet. Your menu is saved; use Retry result after staff restore finalization."}`
      : "Approval alone does not change the menu. Verify the merged menu after the separate authorized merge.");
    text("served-revision", served && state.servedCommitSha ? `Verified merge revision: ${state.servedCommitSha}` : "");
    text("pilot-learning-summary", pilot && served ? state.exercise.completion : "");
    $("pilot-learning-summary").hidden = !(pilot && served);
  }

  function paintResult() {
    const result = state.result;
    const show = state.mode !== "live-canvas-pilot" && state.phase === "completed" && !!result;
    $("result").hidden = !show;
    if (!show) return;
    const rehearsal = state.mode === "rehearsal";
    text("result-context", rehearsal ? "Rehearsal result only — not submitted to the event leaderboard." : "Your verified order result.");
    $("learning-summary").replaceChildren(...state.exercise.completion.split("\n\n").map(paragraph => element("p", paragraph)));
    text("result-handle", result.handle || "Not returned");
    text("result-score", result.score ?? "Not returned");
    text("result-rank", result.rankAtCompletion ?? "Not available");
    const judge = result.judge;
    const commentary = judge?.source === "copilot" && judge.moderated === true && typeof judge.text === "string"
      ? judge.text.trim() : "";
    text("judge", commentary ? `Copilot: ${commentary}` : "Copilot commentary not configured");
    const { leaderboardUrl: url, qrImageUrl: qr } = resultLinks(state);
    $("leaderboard-link").hidden = !url;
    if (url) $("leaderboard-link").href = url;
    else $("leaderboard-link").removeAttribute("href");
    text("leaderboard-note", rehearsal
      ? "Rank is a local rehearsal snapshot, not a live event standing. Equal scores share a rank. Rehearsal QR not configured; no public leaderboard link."
      : url ? "Rank is a completion-time snapshot; equal scores share a rank. Public leaderboard opens in a new tab." : "A verified public leaderboard link is not available. Ask the booth host.");
    $("leaderboard-qr").hidden = !qr;
    if (qr && $("leaderboard-qr").getAttribute("src") !== qr) {
      $("qr-error").hidden = true;
      $("leaderboard-qr").src = qr;
    } else if (!qr) {
      $("leaderboard-qr").removeAttribute("src");
      $("qr-error").hidden = true;
    }
  }

  function paint() {
    const signature = JSON.stringify(state);
    if (lastPaint === signature) return;
    lastPaint = signature;
    const rehearsal = state.mode === "rehearsal";
    const pilot = state.mode === "live-canvas-pilot";
    text("mode-label", rehearsal ? "REHEARSAL — simulated PR" : pilot ? "UNRANKED PILOT — real GitHub-connected review" : "LIVE — GitHub-connected order");
    text("mode-description", rehearsal ? "No GitHub writes or event leaderboard." : pilot ? "In-canvas observation only. Not native App tracking; not leaderboard eligible." : "No rehearsal fallback. Native App review and a verified merge are required.");
    text("experience-label", pilot ? "A one-step GitHub Skills-style pilot · unranked" : "A five-minute GitHub Skills exercise");
    text("scoring-note", pilot ? "Hints are free. This pilot has no points, rank, handle, QR, or AI judge." : "Hints are free. Complete the activity to earn 1,000 points. Equal scores share a rank.");
    text("review-location", pilot ? "Open the real Summary, Changes, and Checks in this canvas. These observations never count as native App evidence." : "In rehearsal, open Summary, Changes, and Checks above, then confirm the order details. Opening a section alone does not verify its contents. In live mode, review the assigned issue and PR in the native Copilot App.");
    $("native-location").hidden = pilot;
    text("phase-stamp", labels[state.phase]);
    text("run-id", `Run ${state.runId}`);
    text("status", state.statusMessage || labels[state.phase]);
    text("ticket-heading", state.order?.name || "Waiting for an assigned order");
    text("order-description", state.order?.description || "Your assignment will appear here.");
    text("order-price", formatPrice(state.order?.price));
    text("order-serving", state.order?.serving ?? "—");
    text("artwork-note", state.order?.artwork ? `Artwork requirement: ${state.order.artwork}` : "House cup illustration is original café artwork.");
    text("issue-heading", rehearsal ? "Rehearsal exercise issue" : `Assigned exercise issue${state.issue?.number ? ` #${state.issue.number}` : ""}`);
    text("issue-title", state.issue?.title || (rehearsal ? `Order: ${state.order?.name || "pending"}` : "Assigned issue not available yet."));
    text("issue-body", state.issue?.body || (rehearsal ? `Prepare the assigned ${state.order?.name || "drink"}. Read the order requirements, inspect the summary, changes, and checks, then approve and apply the rehearsal menu.` : "Ask booth host to open assigned issue/PR in Copilot App"));
    $("native-guidance").hidden = rehearsal || pilot;
    $("review-target").hidden = rehearsal;
    const target = state.reviewTarget;
    text("review-target", target
      ? `Assigned issue: ${target.repo}#${target.issueNumber} · Pull request: ${target.repo}#${target.prNumber} · Revision: ${target.headSha}`
      : "Assigned review reference unavailable. Ask staff to check this run.");
    const blockers = state.blockers.map((blocker) => element("li", blocker));
    $("blockers").replaceChildren(...blockers);
    $("blocker-region").hidden = !blockers.length;
    text("hint-count", `Hints used: ${state.hintCount ?? 0}`);
    const phaseIndex = phases.indexOf(state.phase);
    document.querySelectorAll(".steps li").forEach((step, index) => {
      step.classList.toggle("is-done", index < phaseIndex);
      if (index === Math.min(phaseIndex, 3)) step.setAttribute("aria-current", "step");
      else step.removeAttribute("aria-current");
    });
    text("action-help", state.phase === "approved"
      ? "Approved is not served. Use the menu action to finish applying or verifying your change."
      : state.phase === "served"
        ? "Your menu update is saved. Use Retry result if the final result has not been recorded; retrying preserves your run and handle."
        : state.phase === "pilot-served" ? "Your real menu was verified. Pilot learning finished; no ranked event or native completion was recorded."
          : state.phase === "completed" ? "Your order is complete. Enjoy your drink."
          : "Approval needs all three review sections plus a passed order-details checkpoint. Opening a section alone is not enough.");
    paintExercise();
    paintMenu();
    paintReview();
    paintAppResult();
    paintResult();
  }

  function accept(next) {
    if (!next || !["rehearsal", "live", "live-canvas-pilot"].includes(next.mode) || !phases.includes(next.phase) ||
        (next.mode === "live-canvas-pilot" && (["served", "completed"].includes(next.phase) || next.result !== null || next.completionPending ||
          next.verification?.reviewSource !== "canvas-pilot" || next.verification?.nativeReviewAvailable)) ||
        (next.phase === "pilot-served" && next.mode !== "live-canvas-pilot") ||
        !Array.isArray(next.views) || !Array.isArray(next.menu) || !Array.isArray(next.blockers) || !next.runId ||
        typeof next.exercise?.title !== "string" || !Array.isArray(next.exercise.sections) ||
        !next.exercise.sections.every(section => typeof section?.heading === "string" &&
          Array.isArray(section.paragraphs) && section.paragraphs.every(paragraph => typeof paragraph === "string")) ||
        (["completed", "pilot-served"].includes(next.phase) ? typeof next.exercise.completion !== "string" : next.exercise.completion !== null)) {
      throw new Error("The booth returned an unrecognized order state. Ask the booth host to check the connection.");
    }
    if (state && (state.runId !== next.runId || state.mode !== next.mode)) {
      throw new Error("The booth returned a different run or mode. This order has not been switched. Ask the booth host to reopen the assigned canvas.");
    }
    state = next;
    if (!state.review) activeSurface = null;
    stale = false;
    paint();
  }

  async function request(path, body) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${ticket}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (response.status === 401) {
        ticket = null;
        $("access-note").hidden = true;
        let cacheWarning = "";
        try {
          window.sessionStorage.removeItem(ticketKey);
        } catch {
          cacheWarning = " This browser could not clear its cached panel ticket; close this panel before reopening.";
        }
        window.history.replaceState(null, "", "/");
        text("status", "Connection blocked — local panel access expired.");
        throw new Error(`This panel’s local access ticket is no longer valid. Ask the booth host to reopen your assigned canvas.${cacheWarning}`);
      }
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error(`The booth returned an unreadable response (HTTP ${response.status}). Retry the connection.`);
      }
      if (!response.ok || data?.error) {
        throw new Error(`${data?.error?.message || "The booth could not complete the request."}${data?.error?.code ? ` (${data.error.code})` : ` (HTTP ${response.status})`}`);
      }
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("The booth took too long to respond. Retry the connection to check whether your action was saved.");
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function sync(explicit = false) {
    if (busy || !ticket) return;
    busy = true;
    controls();
    try {
      accept(await request("/api/state"));
      if (explicit || !actionError) {
        $("error-region").hidden = true;
        actionError = false;
      }
    } catch (error) {
      stale = true;
      fail(error);
    } finally {
      busy = false;
      controls();
    }
  }

  async function act(action, input = {}) {
    if (busy || !ticket || !action) return;
    busy = true;
    mutating = true;
    controls();
    try {
      const next = await request("/api/action", { action, input });
      if (action === "view") activeSurface = input.surface;
      accept(next?.runId ? next : await request("/api/state"));
      if (["serve", "complete"].includes(action) && state.phase === "completed") $("result").focus();
      if (action === "serve" && state.phase === "pilot-served") $("app-result").focus();
      $("error-region").hidden = true;
      actionError = false;
    } catch (error) {
      stale = true;
      fail(error, true);
      if (ticket) {
        try {
          accept(await request("/api/state"));
        } catch (refreshError) {
          fail(new Error(`${error.message} The saved order could not be refreshed: ${refreshError.message}`), true);
        }
      }
    } finally {
      busy = false;
      mutating = false;
      controls();
    }
  }

  $("order-check").addEventListener("submit", (event) => {
    event.preventDefault();
    if ($("check-order-action").disabled || !$("order-check").reportValidity()) return;
    const price = $("check-price").valueAsNumber;
    if (!Number.isFinite(price)) return;
    void act("check_order", {
      price,
      serving: $("check-serving").value,
      scope: $("check-scope").value,
    });
  });
  document.querySelectorAll("[data-action], #primary-action").forEach((button) => {
    button.addEventListener("click", () => {
      if (!button.disabled) void act(button.dataset.action, button.dataset.surface ? { surface: button.dataset.surface } : {});
    });
  });
  $("retry-connection").addEventListener("click", () => void sync(true));
  $("leaderboard-qr").addEventListener("error", () => {
    $("leaderboard-qr").hidden = true;
    $("qr-error").hidden = false;
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void sync();
  });

  if (!ticket) {
    fail(new Error("This canvas has no available local access ticket. Ask the booth host to reopen your assigned canvas."));
    text("mode-label", "CONNECTION BLOCKED — mode not verified");
    text("status", "Connection blocked — access ticket missing.");
    controls();
  } else {
    if (storageUnavailable) {
      text("access-note", "Private session storage is unavailable. This panel kept its local access link so reloading still works. Do not share that link.");
      $("access-note").hidden = false;
    }
    void sync();
    window.setInterval(() => {
      if (!document.hidden) void sync();
    }, 3000);
  }
})();
