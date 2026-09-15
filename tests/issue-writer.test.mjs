import { test } from "node:test";
import assert from "node:assert/strict";
import { IssueCompletionWriter } from "../.github/extensions/commit-and-sip/services/issue-writer.mjs";
import { GithubAdapter } from "../.github/extensions/commit-and-sip/services/github.mjs";
import { CompletionClient } from "../.github/extensions/commit-and-sip/services/completion.mjs";

test("remote comment writer prepares one real adapter comment and returns a client-verifiable receipt", async () => {
  const comments = [];
  let writes = 0;
  const github = new GithubAdapter({
    repo: "ghlearn/commit-and-sip",
    request: async (method, path, body) => {
      if (method === "GET" && path === "/user") return { login: "completion-service" };
      if (method === "GET" && path.endsWith("/issues/1")) return { number: 1, title: "Order up", user: { login: "booth" } };
      if (method === "GET" && path.includes("/comments?")) return comments;
      if (method === "POST" && path.endsWith("/issues/1/comments")) {
        writes++;
        const comment = { id: 42, body: body.body, user: { login: "completion-service" } };
        comments.push(comment);
        return comment;
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    }
  });
  const network = {
    resolvePublic: async () => {},
    fetch: async () => ({ ok: true, headers: { get: () => "image/png" } })
  };
  const writer = new IssueCompletionWriter({
    github, leaderboardUrl: "https://example.org/leaderboard",
    qrImageUrl: "https://example.org/leaderboard-qr.png", approvedQrOrigins: ["https://example.org"],
    network
  });
  const reserved = { runId: "test-run", handle: "sneaky-flying-pancake", score: 1000,
    rank: 1, rankAtCompletion: 1, recordedAt: "2026-09-14T00:00:00.000Z", judge: null };
  const commentId = await writer.write(1, reserved);
  assert.equal(commentId, 42);
  assert.equal(await writer.write(1, reserved), 42);
  assert.equal(writes, 1);
  assert.match(comments[0].body, /<!-- commit-and-sip:test-run -->/);
  assert.match(comments[0].body, /Rank at completion: #1/);
  assert.match(comments[0].body, /QR code linking/);
  assert.match(comments[0].body, /No AI commentary was generated/);
  const client = new CompletionClient({
    url: "https://example.org/complete", leaderboardUrl: "https://example.org/leaderboard",
    submit: async () => ({ ...reserved, commentId }), ...network
  });
  const receipt = await client.submitResult({ runId: reserved.runId, handle: reserved.handle });
  assert.equal(receipt.commentId, 42);
});
