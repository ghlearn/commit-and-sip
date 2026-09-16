import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pilotFixture } from "./fixtures/canvas-pilot.mjs";
import { RunEngine } from "../.github/extensions/commit-and-sip/engine.mjs";
import { RunStore } from "../.github/extensions/commit-and-sip/store.mjs";
import { canvasDefinition } from "../.github/extensions/commit-and-sip/canvas.mjs";
import { CompletionAuthority } from "../.github/extensions/commit-and-sip/services/authority.mjs";
import { liveAdapters } from "../.github/extensions/commit-and-sip/services/live.mjs";
import { resultLinks } from "../.github/extensions/commit-and-sip/renderer/result-links.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "sip-canvas-pilot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return pilotFixture(directory);
}

async function assessed(f) {
  await f.open();
  await f.act("start");
  await f.review();
  return f.act("check_order", f.answers);
}

test("real adapter through mocked transport: pilot inspection, submitted checkpoint, explicit approval and separate serving", async t => {
  const f = await fixture(t);
  const open = await f.open();
  assert.equal(open.verification.reviewSource, "canvas-pilot");
  assert.equal(open.verification.nativeReviewAvailable, false);
  assert.equal(open.exercise.completion, null);
  await f.act("start");
  await assert.rejects(f.act("check_order", f.answers), { code: "canvas_review_incomplete" });
  await assert.rejects(f.act("approve"), { code: "assessment_required" });
  await assert.rejects(f.act("view", { surface: "checks" }), { code: "view_sequence" });
  await f.review();
  const wrong = await f.act("check_order", { ...f.answers, price: 5 });
  assert.equal(wrong.assessmentPassed, false);
  await assert.rejects(f.act("approve"), { code: "assessment_required" });
  await f.act("check_order", f.answers);
  assert.equal(f.remote.calls.some(call => call.method !== "GET"), false);
  const saved = (await f.options.store.read()).runs[f.input.runId];
  assert.deepEqual(saved.checkpointAnswers, f.answers);
  assert.equal(saved.reviewSyncedAt, null, "no fake native timestamp");
  assert.deepEqual(saved.canvasReview.identity, { ...saved.assignment, runId: f.input.runId });
  const approved = await f.act("approve");
  assert.equal(approved.phase, "approved");
  assert.deepEqual(approved.menu, []);
  await assert.rejects(f.act("serve"), { code: "merge_pending" });
  assert.deepEqual((await f.act("refresh")).views, []);
  assert.equal((await f.act("refresh")).phase, "approved");
  const decision = (await f.options.store.read()).runs[f.input.runId].pilotDecision;
  assert.deepEqual(decision.answers, f.answers, "verified decision survives snapshot revocation");
  f.remote.merged = true; // Separate authorized merge, only within the mocked transport.
  const served = await f.act("serve");
  assert.equal(served.phase, "pilot-served");
  assert.deepEqual(served.menu, f.remote.menu);
  assert.equal(served.servedCommitSha, "c".repeat(40));
  assert.equal(served.result, null);
  assert.equal(served.completionPending, false);
  assert.match(served.exercise.completion, /not native Skills completion or event finalization/);
  assert.deepEqual(await f.act("serve"), served);
  await assert.rejects(f.act("complete"), { code: "pilot_not_ranked" });
  const data = await f.options.store.read();
  assert.equal(data.runs[f.input.runId].handle, null);
  assert.equal(data.runs[f.input.runId].commentId, null);
  assert.equal(data.results.length, 0);
  assert.ok(data.runs[f.input.runId].events.every(event => !event.type.includes("completed")));
  assert.equal(f.remote.calls.filter(call => call.method !== "GET").length, 1);
  assert.ok(f.remote.calls.some(call => call.body?.body === `<!-- commit-and-sip-approval:${decision.approvalAttemptId} -->`));
  for (const key of ["assignment", "pilotDecision", "approvalAttempt", "canvasReview", "checkpointAnswers"]) {
    assert.equal(key in served, false);
  }
  assert.deepEqual(resultLinks({ ...served, phase: "completed", result: { leaderboardUrl: "https://example.com", qrImageUrl: "https://example.com/qr.png" } }),
    { leaderboardUrl: null, qrImageUrl: null });
  const restarted = new RunEngine({ ...f.options, store: new RunStore(f.options.store.directory) });
  assert.deepEqual(await restarted.open(f.input), served);
});

test("pilot source is explicit, immutable, and checked on every action and direct resume", async t => {
  for (const key of ["reviewSource", "headSha", "baseRef", "reviewer", "orderId", "prNumber", "issueNumber", "requiredChecks", "mode"]) {
    await t.test(key, async t => {
      const f = await fixture(t);
      await assessed(f);
      if (key === "mode") f.config.mode = "live";
      else if (key === "requiredChecks") f.config.requiredChecks = ["different-check"];
      else f.assignment[key] = { reviewSource: "native", headSha: "d".repeat(40), baseRef: "other",
        reviewer: "other", orderId: "ducky-cold-brew", prNumber: 3, issueNumber: 4 }[key];
      const writes = f.remote.calls.length;
      for (const action of ["refresh", "start", "view", "hint", "check_order", "approve", "serve", "sync_review"]) {
        await assert.rejects(f.act(action, action === "view" ? { surface: "summary" } : action === "check_order" ? f.answers : {}));
      }
      await assert.rejects(f.open());
      await assert.rejects(f.engine.open({ ...f.input, mode: "live" }), { code: "run_conflict" });
      await assert.rejects(f.act("complete"), { code: "pilot_not_ranked" });
      assert.equal(f.remote.calls.length, writes);
    });
  }
  const f = await fixture(t);
  delete f.assignment.reviewSource;
  await assert.rejects(f.open(), { code: "review_source_conflict" });
  f.assignment.reviewSource = "invented";
  f.config.mode = "live";
  await assert.rejects(f.open(), { code: "invalid_review_source" });
});

test("native assignment remains native even if staff later enable the canvas pilot", async t => {
  const f = await fixture(t);
  f.config.mode = "live";
  delete f.assignment.reviewSource;
  await f.engine.open({ ...f.input, mode: "live" });
  await f.act("start");
  await assert.rejects(f.act("view", { surface: "summary" }), { code: "native_views_unavailable" });
  f.config.mode = "live-canvas-pilot";
  f.assignment.reviewSource = "canvas-pilot";
  await assert.rejects(f.open(), { code: "run_conflict" });
  await assert.rejects(f.act("refresh"), { code: "live_unconfigured" });
  f.config.runs.other = { ...f.assignment };
  await assert.rejects(f.engine.open({ runId: "other", mode: "live-canvas-pilot" }), { code: "assignment_reused" });
  f.config.repo = "FIXTURE/menu";
  await assert.rejects(f.engine.open({ runId: "other", mode: "live-canvas-pilot" }), { code: "assignment_reused" });
});

test("unbound observations and legacy event-shaped pilot state fail closed on resume and approval", async t => {
  for (const field of ["identity", "surfaces", "answers"]) {
    await t.test(field, async t => {
      const f = await fixture(t);
      await assessed(f);
      await f.options.store.transaction(data => {
        const run = data.runs[f.input.runId];
        if (field === "identity") run.canvasReview.identity.reviewSource = "native";
        if (field === "surfaces") run.canvasReview.surfaces = ["summary", "summary", "checks"];
        if (field === "answers") run.checkpointAnswers = null;
      });
      await assert.rejects(f.act("approve"));
      assert.equal((await f.act("refresh")).assessmentPassed, false);
      assert.equal(f.remote.reviews.length, 0);
    });
  }
  for (const change of [{ phase: "completed" }, { result: { score: 1000 } }, { completionPending: true }]) {
    const f = await fixture(t);
    await f.open();
    await f.options.store.transaction(data => Object.assign(data.runs[f.input.runId], change));
    await assert.rejects(f.open(), { code: "pilot_state_invalid" });
    await assert.rejects(f.act("refresh"), { code: "pilot_state_invalid" });
  }
});

test("stale GitHub facts and unavailable review data durably revoke pilot observations and checkpoint", async t => {
  for (const fault of ["head", "base", "checks", "menu", "patch", "unavailable", "premature-merge"]) {
    await t.test(fault, async t => {
      const f = await fixture(t);
      await assessed(f);
      if (fault === "head") f.remote.head = "d".repeat(40);
      if (fault === "base") f.remote.baseRef = "other";
      if (fault === "checks") f.remote.checksPassed = false;
      if (fault === "menu") f.remote.menu = [{ ...f.remote.menu[0], price: 9 }];
      if (fault === "patch") f.remote.patch = null;
      if (fault === "unavailable") f.remote.unavailable = true;
      if (fault === "premature-merge") f.remote.merged = true;
      await assert.rejects(f.act("approve"));
      const reopened = await new RunEngine(f.options).open(f.input);
      assert.deepEqual(reopened.views, []);
      assert.equal(reopened.assessmentPassed, false);
      assert.equal(reopened.review, null);
      assert.equal(reopened.evidenceHeadSha, null);
      assert.equal((await f.options.store.read()).runs[f.input.runId].checkpointAnswers, null);
      assert.equal(f.remote.calls.some(call => call.method !== "GET"), false);
    });
  }
});

test("approval retries reconcile exact persisted attempt after response loss without duplicate POST", async t => {
  const f = await fixture(t);
  await assessed(f);
  f.remote.loseApprovalResponse = true;
  await assert.rejects(f.act("approve"), { code: "github_verification" });
  const attempt = (await f.options.store.read()).runs[f.input.runId].approvalAttempt;
  assert.ok(attempt.id);
  const restarted = new RunEngine(f.options);
  await restarted.open(f.input);
  await f.review();
  await f.act("check_order", f.answers);
  assert.equal((await restarted.dispatch(f.input.runId, "approve")).phase, "approved");
  await Promise.all([f.act("approve"), f.act("approve")]);
  assert.equal(f.remote.calls.filter(call => call.method === "POST").length, 1);
  assert.equal((await f.options.store.read()).runs[f.input.runId].approvalAttempt.id, attempt.id);
});

test("an unrelated approval cannot be adopted during recovery of a lost pilot approval response", async t => {
  const f = await fixture(t);
  await assessed(f);
  f.remote.loseApprovalResponse = true;
  await assert.rejects(f.act("approve"));
  f.remote.reviews[0].body = "<!-- commit-and-sip-approval:11111111-1111-4111-8111-111111111111 -->";
  await f.review();
  await f.act("check_order", f.answers);
  await assert.rejects(f.act("approve"), { code: "assignment_used" });
  assert.equal(f.remote.calls.filter(call => call.method === "POST").length, 1);
});

test("wrong reviewer, own PR, unrelated marked approval, superseding review, and wrong merged menu cannot serve", async t => {
  for (const fault of ["actor", "author", "marker", "reviewer", "review-head", "dismissed", "merge-menu", "serve-head", "serve-base", "serve-checks", "base-reset", "base-menu-changed"]) {
    await t.test(fault, async t => {
      const f = await fixture(t);
      await assessed(f);
      if (fault === "actor" || fault === "author") {
        if (fault === "actor") f.remote.actor = "other";
        else f.remote.author = f.assignment.reviewer;
        await assert.rejects(f.act("approve"), { code: "github_verification" });
        assert.equal(f.remote.reviews.length, 0);
        return;
      }
      await f.act("approve");
      if (fault === "marker") f.remote.reviews[0].body = "<!-- commit-and-sip-approval:11111111-1111-4111-8111-111111111111 -->";
      if (fault === "reviewer") f.remote.reviews[0].user.login = "other";
      if (fault === "review-head") f.remote.reviews[0].commit_id = "d".repeat(40);
      if (fault === "dismissed") f.remote.reviews.push({ ...f.remote.reviews[0], id: 2, state: "DISMISSED" });
      if (fault === "merge-menu") f.remote.mergeMenu = [];
      if (fault === "serve-head") f.remote.head = "d".repeat(40);
      if (fault === "serve-base") f.remote.baseRef = "other";
      if (fault === "serve-checks") f.remote.checksPassed = false;
      if (fault === "base-reset" || fault === "base-menu-changed") {
        f.remote.baseTip = "d".repeat(40);
        if (fault === "base-reset") f.remote.baseContainsMerge = false;
        else f.remote.baseMenu = [];
      }
      f.remote.merged = true;
      await assert.rejects(f.act("serve"));
      assert.equal((await f.act("refresh")).phase, "approved");
      assert.deepEqual((await f.act("refresh")).menu, []);
      assert.equal((await f.options.store.read()).results.length, 0);
    });
  }
});

test("SDK and HTTP share pilot gates; neither caller can change provenance or submit native evidence", async t => {
  const f = await fixture(t);
  const canvas = canvasDefinition({ engine: f.engine });
  const instanceId = "isolated-pilot-panel";
  const entry = await canvas.open({ instanceId, input: f.input });
  t.after(() => canvas.onClose({ instanceId }));
  assert.match(entry.title, /Unranked GitHub pilot/);
  const url = new URL(entry.url);
  const sdk = (name, input = {}) => canvas.actions.find(action => action.name === name).handler({ instanceId, input });
  const send = async (action, input = {}) => fetch(`${url.origin}/api/action`, {
    method: "POST", headers: { origin: url.origin, authorization: `Bearer ${url.searchParams.get("ticket")}`, "content-type": "application/json" },
    body: JSON.stringify({ action, input })
  });
  for (const [name, input] of [["sync_review", {}], ["complete", {}], ["approve", { reviewSource: "native" }],
    ["view", { surface: "summary", headSha: f.assignment.headSha }], ["check_order", { ...f.answers, passed: true }],
    ["select_run", { operation: "resume", runId: f.input.runId, mode: "rehearsal" }]]) {
    await assert.rejects(sdk(name, input));
    assert.ok((await send(name, input)).status >= 400);
  }
  assert.equal((await sdk("start")).phase, "reviewing");
  assert.equal((await send("view", { surface: "summary" })).status, 200);
  await sdk("view", { surface: "changes" });
  await sdk("view", { surface: "checks" });
  await sdk("check_order", f.answers);
  assert.equal((await send("approve")).status, 200);
  assert.equal((await send("serve")).status, 409);
  f.remote.merged = true;
  assert.equal((await sdk("serve")).phase, "pilot-served");
  assert.equal((await send("complete")).status, 409);
});

test("authority and native completion adapter reject pilot provenance before any transport or reservation", async t => {
  const f = await fixture(t);
  const authority = new CompletionAuthority({ store: f.options.store, catalog: f.options.catalog,
    assignments: { [f.input.runId]: { ...f.assignment, repo: f.config.repo } } });
  for (const method of ["accept", "finalize"]) await assert.rejects(authority[method]({
    runId: f.input.runId, handle: "sneaky-flying-pancake"
  }), { code: "review_source_ineligible" });
  assert.equal((await authority.store.read()).results.length, 0);
  assert.equal((await authority.store.read()).completionClaims, undefined);
  assert.equal(liveAdapters(f.config).completion, null);
  const native = liveAdapters({ ...f.config, mode: "live" });
  await assert.rejects(native.completion.finish({ mode: "live", assignment: f.assignment }), { code: "review_source_ineligible" });
});
