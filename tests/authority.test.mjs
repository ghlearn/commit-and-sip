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
