import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RunEngine } from "../.github/extensions/commit-and-sip/engine.mjs";
import { RunStore } from "../.github/extensions/commit-and-sip/store.mjs";
import { DomainError, loadCatalog } from "../.github/extensions/commit-and-sip/domain.mjs";
import { GithubAdapter } from "../.github/extensions/commit-and-sip/services/github.mjs";
import { inspectLivePilot } from "../.github/extensions/commit-and-sip/services/pilot.mjs";

const catalog = await loadCatalog();
const order = catalog.orders[0];
const headSha = "a".repeat(40);
const mergeSha = "c".repeat(40);
const identity = { runId: "pilot-001", repo: "ghlearn/commit-and-sip", prNumber: 2, headSha };
const config = {
  mode: "live", repo: identity.repo, requiredChecks: ["menu-validation"],
  runs: { [identity.runId]: { issueNumber: 1, prNumber: 2, reviewer: "reviewer", headSha, orderId: order.id } }
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "sip-pilot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const facts = {
    headSha, checksPassed: true, approved: false, merged: false, mergeCommitSha: null,
    menu: [order], files: [{ filename: "src/data/specials.json", patch: "Verified fixture patch" }],
    checks: [{ name: "menu-validation", conclusion: "success" }], summary: "Verified proposal fixture"
  };
  let views = { ...identity, surfaces: [] };
  let viewError = null;
  let reads = 0;
  const github = {
    repo: config.repo,
    readIssue: async () => ({ number: 1, state: "open", title: "Review your order", body: "Assigned criteria" }),
    inspectPullRequest: async () => ({ ...facts }),
    approve: async () => { facts.approved = true; facts.approvedForAttempt = true; }
  };
  const viewEvidence = { read: async request => {
    assert.deepEqual(request, identity);
    reads++;
    if (viewError) throw viewError;
    return views;
  } };
  const engine = new RunEngine({ store: new RunStore(directory), catalog, config, github, viewEvidence });
  await engine.open({ runId: identity.runId, mode: "live" });
  await engine.dispatch(identity.runId, "start");
  return {
    engine, facts, github, viewEvidence,
    views: value => { views = value; },
    fail: error => { viewError = error; },
    reads: () => reads,
    sync: () => engine.dispatch(identity.runId, "sync_review"),
    checkpoint: () => engine.dispatch(identity.runId, "check_order", { price: order.price, serving: order.serving, scope: "one-drink" })
  };
}

test("trusted partial views synchronize before the checkpoint without treating refresh as evidence", async t => {
  const f = await fixture(t);
  const start = await f.engine.get(identity.runId);
  assert.equal(start.verification.nativeReviewAvailable, true);
  assert.deepEqual(start.reviewTarget, { repo: config.repo, issueNumber: 1, prNumber: 2, headSha });
  assert.equal(JSON.stringify(start).includes('"reviewer"'), false);
  assert.match(start.exercise.sections[1].paragraphs.join(" "), /native PR views/);
  await f.engine.dispatch(identity.runId, "refresh");
  assert.equal(f.reads(), 0);
  f.views({ ...identity, surfaces: ["summary"] });
  const partial = await f.sync();
  assert.deepEqual(partial.views, ["summary"]);
  assert.equal(partial.assessmentPassed, false);
  assert.equal(partial.evidenceHeadSha, null);
  assert.match(partial.verification.syncedAt, /Z$/);
  await assert.rejects(f.checkpoint(), { code: "native_views_incomplete" });
  f.views({ ...identity, surfaces: ["checks", "summary", "changes"] });
  const all = await f.sync();
  assert.deepEqual(all.views, ["summary", "changes", "checks"]);
  assert.equal(all.assessmentPassed, false, "view evidence does not fill learner answers");
  assert.equal(all.evidenceHeadSha, headSha);
  assert.equal((await f.checkpoint()).assessmentPassed, true);
  assert.equal((await f.engine.dispatch(identity.runId, "approve")).phase, "approved");
  await assert.rejects(f.sync(), { code: "wrong_phase" });
});

test("sync cannot accept caller-provided evidence or run in rehearsal", async t => {
  const f = await fixture(t);
  await assert.rejects(f.engine.dispatch(identity.runId, "sync_review", { surfaces: ["summary", "changes", "checks"] }), { code: "invalid_input" });
  await f.engine.open({ runId: "rehearsal", mode: "rehearsal" });
  await assert.rejects(f.engine.dispatch("rehearsal", "sync_review"), { code: "wrong_phase" });
  assert.equal(f.reads(), 0);
});

test("malformed, cross-run, cross-PR and stale-head observations revoke stored progress", async t => {
  const f = await fixture(t);
  const valid = { ...identity, surfaces: ["summary", "changes", "checks"] };
  for (const invalid of [null, { ...valid, runId: "other" }, { ...valid, repo: "other/repo" },
    { ...valid, prNumber: 9 }, { ...valid, headSha: mergeSha },
    { ...valid, surfaces: ["summary", "summary", "changes", "checks"] },
    { ...valid, surfaces: ["summary", "changes", "checks", "invented"] }]) {
    f.views(valid);
    await f.sync();
    await f.checkpoint();
    f.views(invalid);
    await assert.rejects(f.sync(), { code: "native_views_invalid" });
    const persisted = await f.engine.get(identity.runId);
    assert.deepEqual(persisted.views, []);
    assert.equal(persisted.assessmentPassed, false);
    assert.equal(persisted.review, null);
    assert.equal(persisted.verification.syncedAt, null);
    await assert.rejects(f.engine.dispatch(identity.runId, "approve"), { code: "assessment_required" });
  }
});

test("withdrawn views, GitHub failures and unavailable readers keep the checkpoint locked durably", async t => {
  const f = await fixture(t);
  const unlock = async () => {
    f.views({ ...identity, surfaces: ["summary", "changes", "checks"] });
    f.fail(null);
    Object.assign(f.facts, { checksPassed: true, headSha, merged: false });
    await f.sync();
    await f.checkpoint();
  };
  await unlock();
  f.views({ ...identity, surfaces: [] });
  assert.equal((await f.sync()).assessmentPassed, false);
  for (const invalid of [{ checksPassed: false }, { headSha: mergeSha }, { merged: true }]) {
    await unlock();
    Object.assign(f.facts, invalid);
    await assert.rejects(f.sync());
    assert.deepEqual((await f.engine.get(identity.runId)).views, []);
  }
  for (const error of [new DomainError("provider_unavailable", "Reader unavailable"), new Error("Reader transport failed")]) {
    await unlock();
    f.fail(error);
    await assert.rejects(f.sync(), error);
    const restored = new RunEngine({ store: new RunStore(f.engine.store.directory), catalog, config, github: f.github });
    assert.equal((await restored.get(identity.runId)).assessmentPassed, false);
  }
  f.engine.viewEvidence = null;
  await assert.rejects(f.sync(), { code: "native_views_unavailable" });
  assert.equal((await f.engine.get(identity.runId)).verification.nativeReviewAvailable, false);
});

test("verified serving preserves the app menu and merge revision without fabricating an event result", async t => {
  const f = await fixture(t);
  f.views({ ...identity, surfaces: ["summary", "changes", "checks"] });
  await f.sync();
  await f.checkpoint();
  await f.engine.dispatch(identity.runId, "approve");
  await assert.rejects(f.engine.dispatch(identity.runId, "serve"), { code: "merge_pending" });
  Object.assign(f.facts, { merged: true, mergeCommitSha: mergeSha });
  await assert.rejects(f.engine.dispatch(identity.runId, "serve"), { code: "completion_unconfigured" });
  const served = await f.engine.get(identity.runId);
  assert.equal(served.phase, "served");
  assert.deepEqual(served.menu, [order]);
  assert.equal(served.servedCommitSha, mergeSha);
  assert.equal(served.result, null);
  assert.equal(served.exercise.completion, null);
  assert.equal(served.completionPending, true);
  const saved = await f.engine.store.read();
  assert.equal(saved.runs[identity.runId].commentId, null);
  assert.ok(saved.runs[identity.runId].handle);
  assert.deepEqual(saved.results, []);
  await assert.rejects(f.engine.dispatch(identity.runId, "complete"), { code: "completion_unconfigured" });
  assert.equal((await f.engine.store.read()).runs[identity.runId].handle, saved.runs[identity.runId].handle);
});

function githubFixture() {
  const baseSha = "b".repeat(40);
  const root = `/repos/${config.repo}`;
  const pr = {
    number: 2, title: "Add Mona Latte", body: "Menu proposal", user: { login: "author" },
    head: { sha: headSha, repo: { full_name: config.repo } }, base: { sha: baseSha, repo: { full_name: config.repo } },
    state: "open", draft: false, mergeable: true, mergeable_state: "clean", merged: false, merge_commit_sha: null
  };
  const encode = menu => ({ type: "file", encoding: "base64", content: Buffer.from(JSON.stringify(menu)).toString("base64") });
  const responses = {
    [`${root}/issues/1`]: { number: 1, state: "open", title: "Review your order", body: "Assigned learner criteria", user: { login: "staff" } },
    [`${root}/pulls/2`]: pr,
    [`${root}/pulls/2/files?per_page=100&page=1`]: [{ filename: "src/data/specials.json", status: "modified" }],
    [`${root}/pulls/2/reviews?per_page=100&page=1`]: [],
    [`${root}/commits/${headSha}/check-runs?filter=all&per_page=100&page=1`]: { check_runs: [{ id: 1, name: "menu-validation", head_sha: headSha, status: "completed", conclusion: "success", app: { slug: "github-actions", id: 1 } }] },
    [`${root}/commits/${headSha}/statuses?per_page=100&page=1`]: [],
    [`${root}/contents/src/data/specials.json?ref=${headSha}`]: encode([order]),
    [`${root}/contents/src/data/specials.json?ref=${baseSha}`]: encode([])
  };
  const calls = [];
  const github = new GithubAdapter({ repo: config.repo, request: async (method, path) => {
    calls.push(method);
    assert.equal(method, "GET");
    assert.ok(Object.hasOwn(responses, path), `Unexpected preflight path: ${path}`);
    return structuredClone(responses[path]);
  } });
  return { github, calls, responses, root };
}

test("pilot preflight verifies the actual GitHub adapter using GET only and never certifies native readiness", async () => {
  const f = githubFixture();
  const report = await inspectLivePilot({ config, catalog, runId: identity.runId, github: f.github });
  assert.equal(report.status, "assignment-verified");
  assert.equal(report.liveReady, false);
  assert.deepEqual(report.order, order);
  assert.equal(report.headSha, headSha);
  assert.ok(report.blockers.length);
  assert.ok(f.calls.length > 5);
  assert.equal(f.calls.every(method => method === "GET"), true);
  assert.equal(Object.hasOwn(report, "reviewer"), false);
});

test("preflight rejects invalid configuration, used assignments, wrong issues and failed checks", async () => {
  for (const change of [{ requiredChecks: [] }, { mode: "rehearsal" }, { runs: {} }, { repo: "other/repo" }]) {
    const f = githubFixture();
    await assert.rejects(inspectLivePilot({ config: { ...config, ...change }, catalog, runId: identity.runId, github: f.github }));
    assert.equal(f.calls.length, 0);
  }
  for (const change of ["closed", "approved", "failed-check"]) {
    const f = githubFixture();
    if (change === "closed") f.responses[`${f.root}/issues/1`].state = "closed";
    if (change === "approved") f.responses[`${f.root}/pulls/2/reviews?per_page=100&page=1`] = [{ id: 1, user: { login: "reviewer" }, state: "APPROVED", commit_id: headSha }];
    if (change === "failed-check") f.responses[`${f.root}/commits/${headSha}/check-runs?filter=all&per_page=100&page=1`].check_runs[0].conclusion = "failure";
    await assert.rejects(inspectLivePilot({ config, catalog, runId: identity.runId, github: f.github }));
    assert.equal(f.calls.every(method => method === "GET"), true);
  }
});

test("preflight CLI reports missing or malformed staff configuration without leaking its content", async t => {
  const directory = await mkdtemp(join(tmpdir(), "sip-preflight-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("../scripts/preflight-live.mjs", import.meta.url));
  const file = join(directory, "bad.json");
  await writeFile(file, "do-not-echo-this-invalid-json");
  for (const args of [[], ["--run", identity.runId, "--config", file], ["--run", identity.runId, "--config", join(directory, "missing.json")]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Live preflight failed/);
    assert.doesNotMatch(result.stderr, /do-not-echo/);
    assert.equal(result.stdout, "");
  }
});

async function prepareRevalidation(t, action) {
  const f = await fixture(t);
  f.views({ ...identity, surfaces: ["summary", "changes", "checks"] });
  await f.sync();
  await f.checkpoint();
  if (["serve", "complete"].includes(action)) await f.engine.dispatch(identity.runId, "approve");
  if (action === "complete") {
    Object.assign(f.facts, { merged: true, mergeCommitSha: mergeSha });
    const unavailable = new Error("Completion transport unavailable");
    f.engine.completion = { finish: async () => { throw unavailable; } };
    await assert.rejects(f.engine.dispatch(identity.runId, "serve"), error => error === unavailable);
  }
  return f;
}

async function assertRevoked(f, previous) {
  const stored = (await f.engine.store.read()).runs[identity.runId];
  assert.deepEqual(stored.views, []);
  assert.equal(stored.evidenceHeadSha, null);
  assert.equal(stored.assessmentPassed, false);
  assert.equal(stored.review, null);
  assert.equal(stored.reviewSyncedAt, null);
  for (const key of ["phase", "events", "issue", "menu", "servedCommitSha", "handle", "commentId", "result", "completionPending", "assessmentAttempts"]) {
    assert.deepEqual(stored[key], previous[key], `Preserve durable ${key} after failed verification`);
  }
  const restarted = new RunEngine({ store: new RunStore(f.engine.store.directory), catalog, config,
    github: f.github, viewEvidence: f.viewEvidence, completion: f.engine.completion });
  const refreshed = await restarted.dispatch(identity.runId, "refresh");
  assert.deepEqual(refreshed.views, []);
  assert.equal(refreshed.assessmentPassed, false);
  assert.equal(refreshed.review, null);
  assert.equal(refreshed.verification.syncedAt, null);
  assert.match(refreshed.statusMessage, /verification failed/);
  assert.equal((await f.engine.store.read()).results.length, 0);
}

for (const action of ["check_order", "approve", "serve", "complete"]) {
  test(`${action} durably revokes all stale review fields for every live evidence failure`, async t => {
    const cases = [
      ["missing reader", f => { f.engine.viewEvidence = null; }, "native_views_unavailable"],
      ["incomplete views", f => f.views({ ...identity, surfaces: ["summary"] }), "native_views_incomplete"],
      ["wrong native head", f => f.views({ ...identity, headSha: mergeSha, surfaces: [] }), "native_views_invalid"],
      ["changed GitHub head", f => { f.facts.headSha = mergeSha; }, "evidence_invalid"],
      ["failed check", f => { f.facts.checksPassed = false; }, "evidence_invalid"],
      ["GitHub transport failure", f => {
        f.github.inspectPullRequest = async () => { throw new DomainError("github_unavailable", "GitHub unavailable"); };
      }, "github_unavailable"],
      ["view transport failure", f => f.fail(new DomainError("reader_unavailable", "Reader unavailable")), "reader_unavailable"]
    ];
    if (["check_order", "approve"].includes(action)) {
      cases.push(["premature merge", f => { f.facts.merged = true; }, action === "approve" ? "assignment_used" : "already_merged"]);
    }
    if (["serve", "complete"].includes(action)) {
      cases.push(["approval withdrawn", f => { f.facts.approved = false; }, action === "serve" ? "merge_pending" : "completion_evidence"]);
      cases.push(["merge pending", f => { f.facts.merged = false; }, action === "serve" ? "merge_pending" : "completion_evidence"]);
    }
    for (const [name, invalidate, code] of cases) {
      await t.test(name, async t => {
        const f = await prepareRevalidation(t, action);
        const previous = (await f.engine.store.read()).runs[identity.runId];
        invalidate(f);
        const input = action === "check_order" ? { price: order.price, serving: order.serving, scope: "one-drink" } : {};
        await assert.rejects(f.engine.dispatch(identity.runId, action, input), { code });
        await assertRevoked(f, previous);
      });
    }
  });
}

test("approval verification after the GitHub write also commits revocation without an approval event", async t => {
  const f = await prepareRevalidation(t, "approve");
  const previous = (await f.engine.store.read()).runs[identity.runId];
  const failure = new Error("Post-approval inspection unavailable");
  f.github.approve = async () => {
    f.facts.approved = true;
    f.github.inspectPullRequest = async () => { throw failure; };
  };
  await assert.rejects(f.engine.dispatch(identity.runId, "approve"), error => error === failure);
  await assertRevoked(f, previous);
  assert.equal(f.facts.approved, true, "Remote outcome is not rolled back or falsely recorded locally");
});

test("approval write failure and start inspection failure use the shared revocation path", async t => {
  const f = await prepareRevalidation(t, "approve");
  let previous = (await f.engine.store.read()).runs[identity.runId];
  const failure = new Error("GitHub unavailable");
  f.github.approve = async () => { throw failure; };
  await assert.rejects(f.engine.dispatch(identity.runId, "approve"), error => error === failure);
  await assertRevoked(f, previous);
  await f.engine.store.transaction(data => { data.runs[identity.runId] = { ...previous, phase: "order" }; });
  previous = (await f.engine.store.read()).runs[identity.runId];
  f.github.readIssue = async () => ({ number: 1, title: "Tentative new issue", body: "Do not persist on failure" });
  f.github.inspectPullRequest = async () => { throw failure; };
  await assert.rejects(f.engine.dispatch(identity.runId, "start"), error => error === failure);
  await assertRevoked(f, previous);
});

test("non-verification input and completion transport errors preserve verified evidence", async t => {
  const f = await prepareRevalidation(t, "check_order");
  const beforeInput = (await f.engine.store.read()).runs[identity.runId];
  await assert.rejects(f.engine.dispatch(identity.runId, "check_order", { price: "invalid", serving: "hot", scope: "one-drink" }), { code: "invalid_answers" });
  assert.deepEqual((await f.engine.store.read()).runs[identity.runId], beforeInput);
  const pending = await prepareRevalidation(t, "complete");
  const beforeRetry = (await pending.engine.store.read()).runs[identity.runId];
  const failure = new Error("Result service unavailable");
  pending.engine.completion = { finish: async () => { throw failure; } };
  await assert.rejects(pending.engine.dispatch(identity.runId, "complete"), error => error === failure);
  assert.deepEqual((await pending.engine.store.read()).runs[identity.runId], beforeRetry);
});

test("restoring evidence permits recovery without replacing an approved or served run", async t => {
  for (const action of ["check_order", "approve", "serve", "complete"]) {
    await t.test(action, async t => {
      const f = await prepareRevalidation(t, action);
      const previous = (await f.engine.store.read()).runs[identity.runId];
      f.facts.checksPassed = false;
      await assert.rejects(action === "check_order" ? f.checkpoint() : f.engine.dispatch(identity.runId, action), { code: "evidence_invalid" });
      await assertRevoked(f, previous);
      f.facts.checksPassed = true;
      if (["check_order", "approve"].includes(action)) {
        await f.sync();
        await f.checkpoint();
        if (action === "approve") assert.equal((await f.engine.dispatch(identity.runId, "approve")).phase, "approved");
      } else {
        Object.assign(f.facts, { merged: true, mergeCommitSha: mergeSha });
        f.engine.completion = { finish: async run => ({ runId: run.runId, handle: run.handle, score: 1000, rankAtCompletion: 1 }) };
        const complete = await f.engine.dispatch(identity.runId, action);
        assert.equal(complete.phase, "completed");
        assert.deepEqual(complete.menu, [order]);
        if (previous.handle) assert.equal(complete.result.handle, previous.handle);
      }
    });
  }
});


for (const outage of ["post-write inspection", "lost write response", "before write"]) {
  test(`approval reconciles the same durable attempt after ${outage} and restart`, async t => {
    const f = await prepareRevalidation(t, "approve");
    let remoteMarker = null;
    let requests = 0;
    let remoteWrites = 0;
    let failOnce = true;
    const unavailable = new Error("Simulated GitHub outage");
    f.github.inspectPullRequest = async (number, options) => {
      if (outage === "post-write inspection" && remoteMarker && failOnce) {
        failOnce = false;
        throw unavailable;
      }
      return { ...f.facts, approvedForAttempt: !!(f.facts.approved && remoteMarker === options.approvalAttemptId) };
    };
    f.github.approve = async (number, options) => {
      requests++;
      const saved = (await f.engine.store.read()).runs[identity.runId];
      assert.equal(saved.phase, "reviewing");
      assert.equal(saved.approvalAttempt.id, options.approvalAttemptId, "attempt must be on disk before GitHub is called");
      assert.equal(saved.approvalAttempt.identity.headSha, headSha);
      if (outage === "before write" && failOnce) { failOnce = false; throw unavailable; }
      remoteWrites++;
      remoteMarker = options.approvalAttemptId;
      f.facts.approved = true;
      if (outage === "lost write response" && failOnce) { failOnce = false; throw unavailable; }
    };
    await assert.rejects(f.engine.dispatch(identity.runId, "approve"), error => error === unavailable);
    const pending = (await f.engine.store.read()).runs[identity.runId];
    assert.equal(pending.phase, "reviewing");
    assert.equal(pending.assessmentPassed, false);
    assert.ok(pending.approvalAttempt.id);
    const restarted = new RunEngine({ store: new RunStore(f.engine.store.directory), catalog, config, github: f.github, viewEvidence: f.viewEvidence });
    assert.equal("approvalAttempt" in await restarted.get(identity.runId), false);
    await restarted.dispatch(identity.runId, "sync_review");
    await restarted.dispatch(identity.runId, "check_order", { price: order.price, serving: order.serving, scope: "one-drink" });
    const approved = await restarted.dispatch(identity.runId, "approve");
    assert.equal(approved.phase, "approved");
    await restarted.dispatch(identity.runId, "approve");
    assert.equal(remoteWrites, 1);
    assert.equal(requests, outage === "before write" ? 2 : 1);
    const saved = (await restarted.store.read()).runs[identity.runId];
    assert.deepEqual(saved.approvalAttempt, pending.approvalAttempt);
    assert.equal(saved.events.filter(event => event.type === "github_approval_verified").length, 1);
  });
}

test("pre-existing or unrelated approvals cannot borrow a run's pending attempt", async t => {
  const f = await prepareRevalidation(t, "approve");
  f.facts.approved = true;
  await assert.rejects(f.engine.dispatch(identity.runId, "approve"), { code: "assignment_used" });
  assert.equal((await f.engine.store.read()).runs[identity.runId].approvalAttempt, undefined);
  f.facts.approved = false;
  await f.sync();
  await f.checkpoint();
  f.github.approve = async () => { throw new Error("Write not sent"); };
  await assert.rejects(f.engine.dispatch(identity.runId, "approve"), /Write not sent/);
  const pending = (await f.engine.store.read()).runs[identity.runId].approvalAttempt;
  f.facts.approved = true;
  f.facts.approvedForAttempt = false;
  await f.sync();
  await f.checkpoint();
  await assert.rejects(f.engine.dispatch(identity.runId, "approve"), { code: "assignment_used" });
  assert.deepEqual((await f.engine.store.read()).runs[identity.runId].approvalAttempt, pending);
});


test("saved approval attempts cannot be reused for a changed assignment", async t => {
  const f = await prepareRevalidation(t, "approve");
  f.github.approve = async () => { throw new Error("Write unavailable"); };
  await assert.rejects(f.engine.dispatch(identity.runId, "approve"), /Write unavailable/);
  await f.engine.store.transaction(data => { data.runs[identity.runId].approvalAttempt.identity.prNumber = 999; });
  await assert.rejects(f.sync(), { code: "approval_attempt_conflict" });
  assert.equal((await f.engine.get(identity.runId)).assessmentPassed, false);
});
