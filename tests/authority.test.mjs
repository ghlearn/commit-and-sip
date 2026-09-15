import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RunStore } from "../.github/extensions/commit-and-sip/store.mjs";
import { loadCatalog } from "../.github/extensions/commit-and-sip/domain.mjs";
import { CompletionAuthority } from "../.github/extensions/commit-and-sip/services/authority.mjs";

const approvalAttempt = {
  id: "ab1e4ff1-407c-4c59-96cb-b8f21f426536",
  reviewedAt: "2026-09-15T10:00:00.000Z",
  checkpointAt: "2026-09-15T10:00:01.000Z",
  decidedAt: "2026-09-15T10:00:02.999Z"
};

const fixtureScopes = new WeakMap();

function fixtureScope(t) {
  if (!fixtureScopes.has(t)) fixtureScopes.set(t, { gates: [], pending: [] });
  return fixtureScopes.get(t);
}

async function testDirectory(t) {
  const directory = join(process.cwd(), `.authority-test-${randomUUID()}`);
  await mkdir(directory);
  t.after(async () => {
    const scope = fixtureScope(t);
    scope.gates.forEach(release => release());
    await Promise.all(scope.pending);
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("authority independently verifies registered facts, computes rank, and recovers comment failures", async t => {
  const dir = await testDirectory(t);
  const identity = { runId: "live-001", repo: "ghlearn/commit-and-sip", prNumber: 2, headSha: "a".repeat(40) };
  let calls = 0;
  let inspections = 0;
  const authority = new CompletionAuthority({
    store: new RunStore(dir), catalog: await loadCatalog(),
    assignments: { "live-001": { ...identity, reviewer: "reviewer", issueNumber: 1, orderId: "mona-latte", baseRef: "main", approvalAttempt } },
    viewEvidence: { read: async () => ({ ...identity, completedAt: approvalAttempt.reviewedAt, surfaces: ["summary", "changes", "checks"] }) },
    checkpointEvidence: { read: async () => ({ ...identity, completedAt: approvalAttempt.checkpointAt, passed: true, price: 5.5, serving: "hot", scope: "one-drink" }) },
    github: { repo: identity.repo, inspectPullRequest: async () => {
      inspections++;
      return { headSha: identity.headSha, baseRef: "main", checksPassed: true, approved: true,
        approvedForAttempt: true, approvedAt: "2026-09-15T10:00:02Z", merged: true, mergeCommitSha: "b".repeat(40) };
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
  authority.viewEvidence.read = async request => ({ ...request, completedAt: approvalAttempt.reviewedAt, surfaces: ["summary", "changes", "checks"] });
  authority.checkpointEvidence.read = async request => ({ ...request, completedAt: approvalAttempt.checkpointAt, passed: true, price: 5.5, serving: "hot", scope: "one-drink" });
  const collision = await authority.finalize({ runId: "live-002", handle: input.handle });
  assert.match(collision.handle, /^sneaky-flying-pancake-[a-f0-9]{8}$/);
  assert.deepEqual(await authority.finalize({ runId: "live-002", handle: input.handle }), collision);
  assert.equal("requestedHandle" in collision, false);
});


async function reservationFixture(t) {
  const directory = await testDirectory(t);
  const assignment = { repo: "cafe/menu", issueNumber: 1, prNumber: 2, headSha: "a".repeat(40),
    reviewer: "reviewer", orderId: "mona-latte", baseRef: "main",
    approvalAttempt: structuredClone(approvalAttempt), requiredChecks: ["menu-validation"] };
  const comments = [];
  const options = {
    store: new RunStore(directory), catalog: await loadCatalog(), assignments: { reserved: assignment },
    github: { repo: assignment.repo, inspectPullRequest: async () => ({ headSha: assignment.headSha,
      baseRef: "main", checksPassed: true, approved: true, approvedForAttempt: true,
      approvedAt: "2026-09-15T10:00:02Z", merged: true, mergeCommitSha: "b".repeat(40) }) },
    viewEvidence: { read: async identity => ({ ...identity, completedAt: approvalAttempt.reviewedAt, surfaces: ["summary", "changes", "checks"] }) },
    checkpointEvidence: { read: async identity => ({ ...identity, completedAt: approvalAttempt.checkpointAt, passed: true, price: 5.5, serving: "hot", scope: "one-drink" }) },
    postComment: async (issueNumber, receipt) => { comments.push({ issueNumber, receipt }); return 42; }
  };
  return { options, comments, assignment, input: { runId: "reserved", handle: "sneaky-flying-pancake" }, authority: new CompletionAuthority(options) };
}

test("invalid issue numbers fail before transactions, evidence, GitHub, or reservations", async t => {
  const f = await reservationFixture(t);
  let transactions = 0;
  let networkCalls = 0;
  const transaction = f.options.store.transaction.bind(f.options.store);
  f.options.store.transaction = async () => { transactions++; throw new Error("unexpected transaction"); };
  const unexpectedNetwork = async () => { networkCalls++; throw new Error("unexpected network request"); };
  const originalReaders = {
    view: f.authority.viewEvidence.read,
    checkpoint: f.authority.checkpointEvidence.read,
    github: f.authority.github.inspectPullRequest
  };
  f.authority.viewEvidence.read = unexpectedNetwork;
  f.authority.checkpointEvidence.read = unexpectedNetwork;
  f.authority.github.inspectPullRequest = unexpectedNetwork;
  for (const issueNumber of [undefined, null, 0, -1, 0.5, "1", Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    if (issueNumber === undefined) delete f.assignment.issueNumber;
    else f.assignment.issueNumber = issueNumber;
    await assert.rejects(f.authority.accept(f.input), { code: "invalid_assignment" });
    await assert.rejects(f.authority.finalize(f.input), { code: "invalid_assignment" });
    const data = await f.options.store.read();
    assert.deepEqual(data.results, []);
    assert.equal(data.completionClaims, undefined);
    assert.equal(transactions, 0);
    assert.equal(networkCalls, 0);
    assert.equal(f.comments.length, 0);
    await assert.rejects(access(f.options.store.path), { code: "ENOENT" });
  }
  f.assignment.issueNumber = 1;
  f.options.store.transaction = transaction;
  f.authority.viewEvidence.read = originalReaders.view;
  f.authority.checkpointEvidence.read = originalReaders.checkpoint;
  f.authority.github.inspectPullRequest = originalReaders.github;
  assert.equal((await f.authority.finalize(f.input)).commentId, 42);
});

test("reservations pin every assignment field across restart, including already-finalized receipts", async t => {
  for (const finalized of [false, true]) {
    await t.test(finalized ? "finalized" : "pending", async t => {
      const f = await reservationFixture(t);
      const receipt = await (finalized ? f.authority.finalize(f.input) : f.authority.accept(f.input));
      assert.equal("assignment" in receipt, false);
      const reserved = await f.options.store.read();
      assert.deepEqual(reserved.results[0].assignment, f.assignment);
      const changes = { repo: "other/menu", issueNumber: 3, prNumber: 4, headSha: "c".repeat(40),
        reviewer: "other-reviewer", orderId: "ducky-cold-brew", requiredChecks: ["other-check"], baseRef: "release",
        approvalAttempt: { ...approvalAttempt, id: randomUUID() } };
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
  await assert.rejects(f.authority.finalize(f.input), { code: "assignment_conflict" });
  assert.equal((await f.options.store.read()).results[0].assignment.issueNumber, 1);
  assert.equal((await f.options.store.read()).results[0].commentId, undefined);
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
    f.authority.viewEvidence.read = async identity => ({ ...identity, completedAt: approvalAttempt.reviewedAt, surfaces });
    await assert.rejects(f.authority.finalize(f.input), { code: "views_incomplete" });
    assert.equal((await f.options.store.read()).results.length, 0);
    assert.equal(f.comments.length, 0);
  }
  f.authority.viewEvidence.read = async identity => ({ ...identity, completedAt: approvalAttempt.reviewedAt, surfaces: ["checks", "summary", "changes"] });
  assert.equal((await f.authority.finalize(f.input)).commentId, 42);
  assert.equal(f.comments.length, 1);
});

test("explicit approval attempt proof is required, server-owned, and chronologically valid", async t => {
  const malformed = [
    undefined, null, {}, { ...approvalAttempt, id: "invented" }, { ...approvalAttempt, id: null },
    ...["reviewedAt", "checkpointAt", "decidedAt"].flatMap(field =>
      [undefined, null, 0, "yesterday", "2026-02-30T10:00:00Z", "2026-09-15T10:00:00+00:00"]
        .map(value => ({ ...approvalAttempt, [field]: value }))),
    { ...approvalAttempt, reviewedAt: "2026-09-15T10:00:02Z" },
    { ...approvalAttempt, decidedAt: "2026-09-15T10:00:00Z" }
  ];
  const f = await reservationFixture(t);
  let reads = 0;
  f.authority.viewEvidence.read = async () => { reads++; };
  for (const attempt of malformed) {
    f.assignment.approvalAttempt = attempt;
    await assert.rejects(f.authority.finalize(f.input), { code: "approval_attempt_invalid" });
    assert.deepEqual((await f.options.store.read()).results, []);
  }
  assert.equal(reads, 0);
  assert.equal(f.comments.length, 0);
  await assert.rejects(f.authority.finalize({ ...f.input, approvalAttempt }), { code: "invalid_input" });
});

test("trusted view and checkpoint timestamps must exactly match the registered attempt", async t => {
  for (const reader of ["viewEvidence", "checkpointEvidence"]) {
    await t.test(reader, async t => {
      const f = await reservationFixture(t);
      const read = f.authority[reader].read;
      for (const completedAt of [undefined, null, "2026-09-15T09:59:59.000Z", "2026-09-15T10:00:00Z"]) {
        f.authority[reader].read = async identity => ({ ...await read(identity), completedAt });
        await assert.rejects(f.authority.finalize(f.input), { code: "approval_attempt_mismatch" });
        assert.deepEqual((await f.options.store.read()).results, []);
        assert.equal(f.comments.length, 0);
      }
    });
  }
});

test("GitHub must approve this attempt, exact base/head and checks, after the trusted decision", async t => {
  const f = await reservationFixture(t);
  const inspect = f.authority.github.inspectPullRequest;
  for (const override of [
    { approved: false }, { approved: "true" }, { approvedForAttempt: false }, { approvedForAttempt: undefined },
    { approvedAt: undefined }, { approvedAt: "invalid" }, { approvedAt: "2026-02-30T12:00:00Z" },
    { approvedAt: "2026-09-15T10:00:01Z" }, { approvedAt: "2026-09-15T10:00:01.999Z" },
    { baseRef: "other" }, { baseRef: undefined }, { headSha: "c".repeat(40) },
    { checksPassed: false }, { merged: false }, { mergeCommitSha: null }
  ]) {
    f.authority.github.inspectPullRequest = async () => ({ ...await inspect(), ...override });
    await assert.rejects(f.authority.finalize(f.input), { code: "completion_ineligible" });
    assert.deepEqual((await f.options.store.read()).results, []);
    assert.equal(f.comments.length, 0);
  }
  f.authority.github.inspectPullRequest = async (number, options) => {
    assert.equal(number, f.assignment.prNumber);
    assert.equal(options.approvalAttemptId, approvalAttempt.id);
    assert.equal(options.expectedHeadSha, f.assignment.headSha);
    assert.equal(options.expectedBaseRef, "main");
    assert.equal(options.reviewer, f.assignment.reviewer);
    assert.deepEqual(options.requiredChecks, ["menu-validation"]);
    // The decision is .999; GitHub's rounded-down timestamp in that same second is valid.
    return inspect();
  };
  assert.equal((await f.authority.finalize(f.input)).commentId, 42);
});

function gate(t) {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  fixtureScope(t).gates.push(release);
  return { entered, release, wait: async () => { enter(); await released; } };
}

// Observe immediately so a deliberately fenced-out worker never causes an unhandled rejection.
function observe(promise, t) {
  const pending = promise.then(value => ({ value }), error => ({ error }));
  fixtureScope(t).pending.push(pending);
  return pending;
}

async function waitFor(promise, label) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5000);
    })]);
  } finally {
    clearTimeout(timeout);
  }
}

function secondRun(f) {
  f.options.assignments.another = { ...structuredClone(f.assignment), issueNumber: 3, prNumber: 4,
    approvalAttempt: { ...approvalAttempt, id: randomUUID() } };
  return { ...f.input, runId: "another" };
}

test("different runs complete while any remote evidence reader or issue writer stalls", async t => {
  for (const stage of ["viewEvidence", "checkpointEvidence", "github", "postComment"]) {
    await t.test(stage, { timeout: 10_000 }, async t => {
      const f = await reservationFixture(t);
      const otherInput = secondRun(f);
      const blocked = gate(t);
      if (stage === "github") {
        const inspect = f.authority.github.inspectPullRequest;
        f.authority.github.inspectPullRequest = async (number, options) => {
          if (number === f.assignment.prNumber) await blocked.wait();
          return inspect(number, options);
        };
      } else if (stage === "postComment") {
        const post = f.authority.postComment;
        f.authority.postComment = async (...args) => {
          if (args[0] === f.assignment.issueNumber) await blocked.wait();
          return post(...args);
        };
      } else {
        const read = f.authority[stage].read;
        f.authority[stage].read = async identity => {
          if (identity.runId === f.input.runId) await blocked.wait();
          return read(identity);
        };
      }
      const pending = observe(f.authority.finalize(f.input), t);
      await blocked.entered;
      const other = new CompletionAuthority({ ...f.options, postComment: f.authority.postComment,
        store: new RunStore(f.options.store.directory) });
      const complete = await other.finalize(otherInput);
      assert.equal(complete.commentId, 42);
      assert.equal((await f.options.store.read()).completionClaims.find(claim => claim.runId === f.input.runId).stage,
        stage === "postComment" ? "comment" : "verify");
      blocked.release();
      const first = await pending;
      assert.equal(first.error, undefined);
      assert.notEqual(first.value.handle, complete.handle);
      const data = await f.options.store.read();
      assert.equal(data.results.length, 2);
      assert.equal(new Set(data.results.map(result => result.runId)).size, 2);
      assert.equal(new Set(data.results.map(result => result.handle)).size, 2);
      assert.equal(data.completionClaims.every(claim => claim.owner === null), true);
      assert.deepEqual(await f.authority.finalize(f.input), first.value);
      assert.deepEqual(await other.finalize(otherInput), complete);
      assert.equal(f.comments.length, 2);
    });
  }
});

test("durable verification leases exclude duplicates and fence expired workers across restart", { timeout: 10_000 }, async t => {
  const f = await reservationFixture(t);
  let now = 100_000;
  const oldGate = gate(t);
  const newGate = gate(t);
  const inspect = f.options.github.inspectPullRequest;
  let inspections = 0;
  f.options.github.inspectPullRequest = async () => {
    inspections++;
    await (inspections === 1 ? oldGate : newGate).wait();
    return inspect();
  };
  const options = { ...f.options, now: () => now, claimTtlMs: 1000 };
  const old = new CompletionAuthority(options);
  const pending = observe(old.accept(f.input), t);
  await oldGate.entered;
  const firstClaim = (await f.options.store.read()).completionClaims[0];
  const restarted = new CompletionAuthority({ ...options, store: new RunStore(f.options.store.directory) });
  await assert.rejects(restarted.accept(f.input), { code: "completion_busy" });
  await assert.rejects(restarted.accept({ ...f.input, handle: "cozy-dancing-muffin" }), { code: "handle_conflict" });
  assert.equal(inspections, 1);
  now += 1000;
  const successor = observe(restarted.accept(f.input), t);
  await newGate.entered;
  const nextClaim = (await f.options.store.read()).completionClaims[0];
  assert.notEqual(nextClaim.owner, firstClaim.owner);
  assert.equal(nextClaim.fence, firstClaim.fence + 1);
  oldGate.release();
  assert.equal((await pending).error.code, "completion_claim_lost");
  assert.deepEqual((await f.options.store.read()).completionClaims[0], nextClaim);
  assert.deepEqual((await f.options.store.read()).results, []);
  newGate.release();
  const completed = await successor;
  assert.equal(completed.error, undefined);
  assert.deepEqual(await old.accept(f.input), completed.value);
  assert.equal((await f.options.store.read()).results.length, 1);
  assert.equal(inspections, 2);
});

test("expired comment leases recover across restart with one idempotent comment and one receipt", { timeout: 10_000 }, async t => {
  const f = await reservationFixture(t);
  let now = 100_000;
  const oldGate = gate(t);
  const newGate = gate(t);
  const posted = new Map();
  const keys = [];
  const options = { ...f.options, now: () => now, claimTtlMs: 1000,
    postComment: async (issueNumber, receipt, { idempotencyKey }) => {
      keys.push(idempotencyKey);
      assert.equal(issueNumber, 1);
      assert.equal("assignment" in receipt, false);
      if (!posted.has(idempotencyKey)) posted.set(idempotencyKey, 42);
      await (keys.length === 1 ? oldGate : newGate).wait();
      return posted.get(idempotencyKey);
    } };
  const old = new CompletionAuthority(options);
  const pending = observe(old.finalize(f.input), t);
  await oldGate.entered;
  const restarted = new CompletionAuthority({ ...options, store: new RunStore(f.options.store.directory) });
  await assert.rejects(restarted.finalize(f.input), { code: "completion_busy" });
  assert.equal(keys.length, 1);
  assert.deepEqual(await old.leaderboard(), []);
  now += 1000;
  const successor = observe(restarted.finalize(f.input), t);
  await newGate.entered;
  const newClaim = (await f.options.store.read()).completionClaims[0];
  oldGate.release();
  assert.equal((await pending).error.code, "completion_claim_lost");
  assert.deepEqual((await f.options.store.read()).completionClaims[0], newClaim);
  assert.equal((await f.options.store.read()).results[0].commentId, undefined);
  newGate.release();
  const completed = await successor;
  assert.equal(completed.error, undefined);
  assert.equal(completed.value.commentId, 42);
  assert.equal(posted.size, 1);
  assert.equal(new Set(keys).size, 1);
  assert.equal(keys.length, 2);
  assert.equal((await f.options.store.read()).results.length, 1);
  assert.deepEqual(await old.finalize(f.input), completed.value);
  assert.equal(keys.length, 2);
});

test("lease expiry without a successor still prevents a stale verification commit", async t => {
  const f = await reservationFixture(t);
  let now = 100_000;
  const inspect = f.options.github.inspectPullRequest;
  let calls = 0;
  f.options.github.inspectPullRequest = async () => {
    if (++calls === 1) now += 1000;
    return inspect();
  };
  const authority = new CompletionAuthority({ ...f.options, now: () => now, claimTtlMs: 1000 });
  await assert.rejects(authority.finalize(f.input), { code: "completion_claim_lost" });
  assert.deepEqual((await f.options.store.read()).results, []);
  assert.equal(f.comments.length, 0);
  assert.equal((await authority.finalize(f.input)).commentId, 42);
});

test("assignment mutation during verification cannot change or reuse a durable reservation", { timeout: 10_000 }, async t => {
  for (const [field, value] of Object.entries({
    issueNumber: 5, prNumber: 6, repo: "other/menu", baseRef: "release", headSha: "d".repeat(40),
    reviewer: "someone", requiredChecks: ["other-check"], orderId: "ducky-cold-brew",
    approvalAttempt: { ...approvalAttempt, decidedAt: "2026-09-15T10:00:03Z" }
  })) {
    await t.test(field, async t => {
      const f = await reservationFixture(t);
      const original = structuredClone(f.assignment);
      const blocked = gate(t);
      const pr = await f.authority.github.inspectPullRequest();
      f.authority.github.inspectPullRequest = async () => { await blocked.wait(); return pr; };
      const pending = observe(f.authority.finalize(f.input), t);
      await blocked.entered;
      f.assignment[field] = value;
      blocked.release();
      assert.equal((await pending).error.code, "assignment_conflict");
      assert.deepEqual((await f.options.store.read()).results, []);
      assert.deepEqual((await f.options.store.read()).completionClaims[0].assignment, original);
      assert.equal(f.comments.length, 0);
      await assert.rejects(f.authority.finalize(f.input), { code: "assignment_conflict" });
      const reused = new CompletionAuthority({ ...f.options, assignments: { another: original } });
      await assert.rejects(reused.accept({ ...f.input, runId: "another" }), { code: "assignment_reused" });
      Object.assign(f.assignment, original);
      assert.equal((await f.authority.finalize(f.input)).commentId, 42);
    });
  }
});

test("a duplicate registration added during verification fails closed at commit", async t => {
  const f = await reservationFixture(t);
  const inspect = f.authority.github.inspectPullRequest;
  f.authority.github.inspectPullRequest = async () => {
    f.options.assignments.another = structuredClone(f.assignment);
    return inspect();
  };
  await assert.rejects(f.authority.finalize(f.input), { code: "assignment_reused" });
  assert.deepEqual((await f.options.store.read()).results, []);
  assert.equal(f.comments.length, 0);
});

test("completion writer retries an uncertain remote success using the same durable idempotency key", async t => {
  const f = await reservationFixture(t);
  const posted = new Map();
  const keys = [];
  const options = { ...f.options, postComment: async (issue, receipt, { idempotencyKey }) => {
    keys.push(idempotencyKey);
    if (!posted.has(idempotencyKey)) posted.set(idempotencyKey, { id: 42, issue, receipt });
    if (keys.length === 1) throw new Error("remote succeeded but response was lost");
    return posted.get(idempotencyKey).id;
  } };
  await assert.rejects(new CompletionAuthority(options).finalize(f.input), /response was lost/);
  const before = (await f.options.store.read()).results[0];
  assert.equal(before.commentId, undefined);
  assert.equal((await f.options.store.read()).completionClaims[0].owner, null);
  const restarted = new CompletionAuthority({ ...options, store: new RunStore(f.options.store.directory) });
  const complete = await restarted.finalize(f.input);
  assert.equal(complete.commentId, 42);
  assert.equal(complete.handle, before.handle);
  assert.equal(complete.recordedAt, before.recordedAt);
  assert.equal(posted.size, 1);
  assert.equal(new Set(keys).size, 1);
  assert.equal(keys.length, 2);
  assert.deepEqual(await restarted.finalize(f.input), complete);
  assert.equal(keys.length, 2);
});

test("a failed completion ledger write retries without duplicating the remote comment", async t => {
  const f = await reservationFixture(t);
  const transaction = f.options.store.transaction.bind(f.options.store);
  let failCommit = true;
  f.options.store.transaction = callback => transaction(async data => {
    const result = await callback(data);
    if (failCommit && data.results.some(item => item.commentId)) {
      failCommit = false;
      throw new Error("disk write failed");
    }
    return result;
  });
  const posted = new Map();
  const keys = [];
  const options = { ...f.options, postComment: async (_issue, _receipt, { idempotencyKey }) => {
    keys.push(idempotencyKey);
    if (!posted.has(idempotencyKey)) posted.set(idempotencyKey, 42);
    return posted.get(idempotencyKey);
  } };
  await assert.rejects(new CompletionAuthority(options).finalize(f.input), /disk write failed/);
  assert.equal((await f.options.store.read()).results[0].commentId, undefined);
  const restarted = new CompletionAuthority({ ...options, store: new RunStore(f.options.store.directory) });
  assert.equal((await restarted.finalize(f.input)).commentId, 42);
  assert.equal(posted.size, 1);
  assert.equal(new Set(keys).size, 1);
  assert.equal(keys.length, 2);
  assert.equal((await f.options.store.read()).results.length, 1);
});

test("unconfigured or unverified comment writers preserve the reserved result for retry", async t => {
  const f = await reservationFixture(t);
  f.authority.postComment = null;
  await assert.rejects(f.authority.finalize(f.input), { code: "comment_unconfigured" });
  const original = (await f.options.store.read()).results[0];
  for (const commentId of [undefined, null, 0, -1, 1.5, "42"]) {
    f.authority.postComment = async () => commentId;
    await assert.rejects(f.authority.finalize(f.input), { code: "comment_unverified" });
    assert.deepEqual((await f.options.store.read()).results, [original]);
  }
  f.authority.postComment = f.options.postComment;
  assert.equal((await f.authority.finalize(f.input)).commentId, 42);
});

test("simultaneous verification commits allocate globally unique handles atomically", { timeout: 10_000 }, async t => {
  const f = await reservationFixture(t);
  const otherInput = secondRun(f);
  const gates = [gate(t), gate(t)];
  const inspect = f.options.github.inspectPullRequest;
  f.options.github.inspectPullRequest = async number => {
    await gates[number === f.assignment.prNumber ? 0 : 1].wait();
    return inspect();
  };
  const another = new CompletionAuthority({ ...f.options, store: new RunStore(f.options.store.directory) });
  const pending = [observe(f.authority.finalize(f.input), t), observe(another.finalize(otherInput), t)];
  await Promise.all(gates.map(item => item.entered));
  assert.equal((await f.options.store.read()).results.length, 0);
  gates.forEach(item => item.release());
  const completed = await Promise.all(pending);
  assert.equal(completed.every(item => !item.error), true);
  const results = (await f.options.store.read()).results;
  assert.equal(results.length, 2);
  assert.equal(new Set(results.map(item => item.handle)).size, 2);
  assert.equal(results.filter(item => item.handle === f.input.handle).length, 1);
  assert.equal(results.every(item => item.score === 1000 && item.commentId === 42), true);
  assert.equal(f.comments.length, 2);
});

test("assignment mutation during a stalled comment fences persistence and preserves the retry key", { timeout: 10_000 }, async t => {
  const f = await reservationFixture(t);
  const blocked = gate(t);
  const posted = new Map();
  const keys = [];
  f.authority.postComment = async (issue, receipt, { idempotencyKey }) => {
    keys.push(idempotencyKey);
    assert.equal(issue, 1);
    assert.equal("assignment" in receipt, false);
    if (!posted.has(idempotencyKey)) posted.set(idempotencyKey, 42);
    if (keys.length === 1) await blocked.wait();
    return posted.get(idempotencyKey);
  };
  const pending = observe(f.authority.finalize(f.input), t);
  await blocked.entered;
  f.assignment.approvalAttempt.decidedAt = "2026-09-15T10:00:03Z";
  blocked.release();
  assert.equal((await pending).error.code, "assignment_conflict");
  assert.equal((await f.options.store.read()).results[0].commentId, undefined);
  assert.deepEqual(await f.authority.leaderboard(), []);
  await assert.rejects(f.authority.finalize(f.input), { code: "assignment_conflict" });
  assert.equal(keys.length, 1);
  f.assignment.approvalAttempt.decidedAt = approvalAttempt.decidedAt;
  const restarted = new CompletionAuthority({ ...f.options, postComment: f.authority.postComment,
    store: new RunStore(f.options.store.directory) });
  assert.equal((await restarted.finalize(f.input)).commentId, 42);
  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, 1);
  assert.equal(posted.size, 1);
});

test("missing trusted readers and malformed branch/check policy never create a result", async t => {
  for (const reader of ["viewEvidence", "checkpointEvidence", "github"]) {
    const f = await reservationFixture(t);
    f.authority[reader] = null;
    await assert.rejects(f.authority.finalize(f.input), { code: "evidence_unavailable" });
    assert.deepEqual((await f.options.store.read()).results, []);
    assert.equal(f.comments.length, 0);
  }
  for (const change of [{ baseRef: undefined }, { baseRef: "" }, { baseRef: "HEAD" },
    { baseRef: "../main" }, { baseRef: "main.lock" }, { baseRef: "main branch" }, { requiredChecks: [] },
    { requiredChecks: null }, { requiredChecks: "menu-validation" }, { requiredChecks: [""] },
    { requiredChecks: ["menu-validation", "menu-validation"] }]) {
    const f = await reservationFixture(t);
    Object.assign(f.assignment, change);
    await assert.rejects(f.authority.finalize(f.input), { code: "invalid_assignment" });
    assert.deepEqual((await f.options.store.read()).results, []);
    assert.equal(f.comments.length, 0);
  }
});

test("heartbeats retain ownership for healthy slow verification and comment writers", async t => {
  for (const stage of ["verify", "comment"]) {
    await t.test(stage, { timeout: 10_000 }, async t => {
      const f = await reservationFixture(t);
      const blocked = gate(t);
      let calls = 0;
      if (stage === "verify") {
        const inspect = f.options.github.inspectPullRequest;
        f.options.github.inspectPullRequest = async () => {
          calls++;
          await blocked.wait();
          return inspect();
        };
      } else {
        const post = f.options.postComment;
        f.options.postComment = async (...args) => {
          calls++;
          await blocked.wait();
          return post(...args);
        };
      }
      const transaction = f.options.store.transaction.bind(f.options.store);
      let now = 100_000;
      let initialClaim;
      let heartbeatCount = 0;
      let confirmRenewals;
      const renewed = new Promise(resolve => { confirmRenewals = resolve; });
      f.options.store.transaction = async callback => {
        let heartbeat = false;
        const result = await transaction(data => {
          const previous = structuredClone(data.completionClaims?.[0]);
          // Scheduling/fsync delays must not consume the synthetic lease. Advance only when
          // the active worker enters a transaction, by less than one lease duration.
          if (previous?.stage === stage && previous.owner) now += 200;
          const value = callback(data);
          const claim = data.completionClaims?.[0];
          if (!initialClaim && claim?.stage === stage && claim.owner) initialClaim = structuredClone(claim);
          heartbeat = previous?.stage === stage && previous.owner &&
            claim?.owner === previous.owner && claim.fence === previous.fence &&
            claim.expiresAt > previous.expiresAt;
          return value;
        });
        if (heartbeat && ++heartbeatCount === 4) confirmRenewals();
        return result;
      };
      const options = { ...f.options, now: () => now, claimTtlMs: 600 };
      const authority = new CompletionAuthority(options);
      const pending = observe(authority.finalize(f.input), t);
      await waitFor(blocked.entered, `${stage} remote gate`);
      await waitFor(renewed, `${stage} lease renewals`);
      const currentClaim = (await f.options.store.read()).completionClaims[0];
      assert.ok(now >= initialClaim.expiresAt);
      assert.ok(currentClaim.expiresAt > initialClaim.expiresAt);
      assert.equal(currentClaim.owner, initialClaim.owner);
      assert.equal(currentClaim.fence, initialClaim.fence);
      assert.deepEqual(currentClaim.assignment, initialClaim.assignment);
      assert.equal(currentClaim.requestedHandle, f.input.handle);
      const restarted = new CompletionAuthority({ ...options, store: new RunStore(f.options.store.directory) });
      await assert.rejects(restarted.finalize(f.input), { code: "completion_busy" });
      assert.equal(calls, 1);
      blocked.release();
      const complete = await waitFor(pending, `${stage} completion`);
      assert.equal(complete.error, undefined);
      assert.equal(complete.value.commentId, 42);
      assert.equal((await f.options.store.read()).completionClaims[0].owner, null);
      assert.deepEqual(await restarted.finalize(f.input), complete.value);
      assert.equal(calls, 1);
    });
  }
});

test("ledger fencing cannot guarantee exactly-once posting with a read-then-create writer", { timeout: 10_000 }, async t => {
  const f = await reservationFixture(t);
  const blocked = gate(t);
  let now = 100_000;
  let calls = 0;
  const remoteComments = [];
  const options = { ...f.options, now: () => now, claimTtlMs: 1000,
    postComment: async () => {
      calls++;
      // Both workers can observe an empty remote issue before either request creates a comment.
      const existing = remoteComments[0];
      if (calls === 1) await blocked.wait();
      if (existing) return existing;
      const id = 42 + remoteComments.length;
      remoteComments.push(id);
      return id;
    } };
  const pending = observe(new CompletionAuthority(options).finalize(f.input), t);
  await blocked.entered;
  // Simulate lease loss while the remote request remains in flight (crash/partition/long pause).
  now += 1000;
  const restarted = new CompletionAuthority({ ...options, store: new RunStore(f.options.store.directory) });
  const complete = await restarted.finalize(f.input);
  blocked.release();
  assert.equal((await pending).error.code, "completion_claim_lost");
  assert.deepEqual(remoteComments, [42, 43]);
  const results = (await f.options.store.read()).results;
  assert.equal(results.length, 1);
  assert.equal(results[0].commentId, complete.commentId);
  assert.equal(results[0].commentId, 42);
});

test("fixture cleanup drains gated workers before removing their ledger directory", async t => {
  const hooks = [];
  const scope = { after: hook => hooks.push(hook) };
  const directory = await testDirectory(scope);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const blocked = gate(scope);
  const pending = observe((async () => {
    await blocked.wait();
    await new RunStore(directory).transaction(data => { data.results.push({ runId: "cleanup" }); });
  })(), scope);
  await blocked.entered;
  await hooks[0]();
  assert.equal((await pending).error, undefined);
  await assert.rejects(access(directory), { code: "ENOENT" });
});
