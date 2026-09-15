import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunStore } from "../.github/extensions/commit-and-sip/store.mjs";
import { loadCatalog } from "../.github/extensions/commit-and-sip/domain.mjs";
import { CompletionAuthority } from "../.github/extensions/commit-and-sip/services/authority.mjs";

test("authority independently verifies registered facts, computes rank, and recovers comment failures", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sip-authority-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const identity = { runId: "live-001", repo: "ghlearn/commit-and-sip", prNumber: 2, headSha: "a".repeat(40) };
  let calls = 0;
  let inspections = 0;
  const authority = new CompletionAuthority({
    store: new RunStore(dir), catalog: await loadCatalog(),
    assignments: { "live-001": { ...identity, reviewer: "reviewer", issueNumber: 1, orderId: "mona-latte" } },
    viewEvidence: { read: async () => ({ ...identity, surfaces: ["summary", "changes", "checks"] }) },
    checkpointEvidence: { read: async () => ({ ...identity, passed: true, price: 5.5, serving: "hot", scope: "one-drink" }) },
    github: { repo: identity.repo, inspectPullRequest: async () => {
      inspections++;
      return { headSha: identity.headSha, checksPassed: true, approved: true, merged: true, mergeCommitSha: "b".repeat(40) };
    } },
    postComment: async () => {
      calls++;
      if (calls === 1) throw new Error("network unavailable");
      return 42;
    }
  });
  const input = { runId: "live-001", handle: "sneaky-flying-pancake" };
  await assert.rejects(authority.accept({ ...input, score: 90000 }), { code: "invalid_input" });
  await assert.rejects(authority.finalize(input), /network unavailable/);
  assert.equal((await authority.store.read()).results.length, 1);
  const result = await authority.finalize(input);
  assert.equal(result.score, 1000);
  assert.equal(result.rankAtCompletion, 1);
  assert.equal(result.commentId, 42);
  assert.deepEqual(await authority.finalize(input), result);
  assert.equal(calls, 2);
  assert.equal(inspections, 1);
  assert.deepEqual(await authority.leaderboard(), [{ handle: input.handle, score: 1000, liveRank: 1 }]);
  await assert.rejects(authority.accept({ ...input, handle: "cozy-dancing-muffin" }), { code: "handle_conflict" });
  authority.assignments["live-002"] = { ...authority.assignments["live-001"], issueNumber: 3, prNumber: 4 };
  authority.viewEvidence.read = async request => ({ ...request, surfaces: ["summary", "changes", "checks"] });
  authority.checkpointEvidence.read = async request => ({ ...request, passed: true, price: 5.5, serving: "hot", scope: "one-drink" });
  const collision = await authority.finalize({ runId: "live-002", handle: input.handle });
  assert.match(collision.handle, /^sneaky-flying-pancake-[a-f0-9]{8}$/);
  assert.deepEqual(await authority.finalize({ runId: "live-002", handle: input.handle }), collision);
  assert.equal("requestedHandle" in collision, false);
});


async function reservationFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "sip-reservation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const assignment = { repo: "cafe/menu", issueNumber: 1, prNumber: 2, headSha: "a".repeat(40),
    reviewer: "reviewer", orderId: "mona-latte", requiredChecks: ["menu-validation"] };
  const comments = [];
  const options = {
    store: new RunStore(directory), catalog: await loadCatalog(), assignments: { reserved: assignment },
    github: { repo: assignment.repo, inspectPullRequest: async () => ({ headSha: assignment.headSha,
      checksPassed: true, approved: true, merged: true, mergeCommitSha: "b".repeat(40) }) },
    viewEvidence: { read: async identity => ({ ...identity, surfaces: ["summary", "changes", "checks"] }) },
    checkpointEvidence: { read: async identity => ({ ...identity, passed: true, price: 5.5, serving: "hot", scope: "one-drink" }) },
    postComment: async (issueNumber, receipt) => { comments.push({ issueNumber, receipt }); return 42; }
  };
  return { options, comments, assignment, input: { runId: "reserved", handle: "sneaky-flying-pancake" }, authority: new CompletionAuthority(options) };
}

test("reservations pin every assignment field across restart, including already-finalized receipts", async t => {
  for (const finalized of [false, true]) {
    await t.test(finalized ? "finalized" : "pending", async t => {
      const f = await reservationFixture(t);
      const receipt = await (finalized ? f.authority.finalize(f.input) : f.authority.accept(f.input));
      assert.equal("assignment" in receipt, false);
      const reserved = await f.options.store.read();
      assert.deepEqual(reserved.results[0].assignment, f.assignment);
      const changes = { repo: "other/menu", issueNumber: 3, prNumber: 4, headSha: "c".repeat(40),
        reviewer: "other-reviewer", orderId: "ducky-cold-brew", requiredChecks: ["other-check"] };
      for (const [key, value] of Object.entries(changes)) {
        const changed = new CompletionAuthority({ ...f.options, store: new RunStore(f.options.store.directory),
          assignments: { reserved: { ...f.assignment, [key]: value } } });
        await assert.rejects(changed.accept(f.input), { code: "assignment_conflict" });
        await assert.rejects(changed.finalize(f.input), { code: "assignment_conflict" });
        assert.deepEqual(await f.options.store.read(), reserved);
        assert.equal(f.comments.length, finalized ? 1 : 0);
      }
      const restarted = new CompletionAuthority({ ...f.options, store: new RunStore(f.options.store.directory) });
      const complete = await restarted.finalize(f.input);
      assert.equal(complete.commentId, 42);
      assert.deepEqual(await restarted.finalize(f.input), complete);
      assert.equal(f.comments.length, 1);
      assert.equal(f.comments[0].issueNumber, 1);
      assert.equal("assignment" in f.comments[0].receipt, false);
      assert.equal("requestedHandle" in complete, false);
    });
  }
});

test("finalize rejects reassignment between accept and comment and posts only the persisted issue", async t => {
  const f = await reservationFixture(t);
  const originalAccept = f.authority.accept.bind(f.authority);
  f.authority.accept = async input => {
    const result = await originalAccept(input);
    f.options.assignments.reserved.issueNumber = 3;
    return result;
  };
  await assert.rejects(f.authority.finalize(f.input), { code: "assignment_conflict" });
  assert.equal(f.comments.length, 0);
  assert.equal((await f.options.store.read()).results[0].assignment.issueNumber, 1);
  f.options.assignments.reserved.issueNumber = 1;
  f.authority.accept = originalAccept;
  f.authority.postComment = async (issueNumber, receipt) => {
    f.options.assignments.reserved.issueNumber = 99;
    assert.equal(issueNumber, 1);
    assert.equal("assignment" in receipt, false);
    return 42;
  };
  await f.authority.finalize(f.input);
  assert.equal((await f.options.store.read()).results[0].assignment.issueNumber, 1);
  await assert.rejects(f.authority.finalize(f.input), { code: "assignment_conflict" });
});

test("legacy unbound receipts and reuse of persisted issue/PR reservations fail closed", async t => {
  const f = await reservationFixture(t);
  await f.authority.accept(f.input);
  const restarted = new CompletionAuthority({ ...f.options, assignments: { another: f.assignment } });
  await assert.rejects(restarted.accept({ ...f.input, runId: "another" }), { code: "assignment_reused" });
  await f.options.store.transaction(data => { delete data.results[0].assignment; });
  await assert.rejects(f.authority.finalize(f.input), { code: "assignment_conflict" });
  assert.equal(f.comments.length, 0);
});

test("authority rejects incomplete, duplicate, and invented surface evidence before reserving or commenting", async t => {
  const f = await reservationFixture(t);
  for (const surfaces of [null, "summary,changes,checks", [], ["summary", "changes"],
    ["summary", "changes", "checks", "checks"], ["summary", "changes", "checks", "invented"], ["summary", "changes", "invented"]]) {
    f.authority.viewEvidence.read = async identity => ({ ...identity, surfaces });
    await assert.rejects(f.authority.finalize(f.input), { code: "views_incomplete" });
    assert.equal((await f.options.store.read()).results.length, 0);
    assert.equal(f.comments.length, 0);
  }
  f.authority.viewEvidence.read = async identity => ({ ...identity, surfaces: ["checks", "summary", "changes"] });
  assert.equal((await f.authority.finalize(f.input)).commentId, 42);
  assert.equal(f.comments.length, 1);
});
