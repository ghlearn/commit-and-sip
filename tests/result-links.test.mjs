import { test } from "node:test";
import assert from "node:assert/strict";
import { CompletionClient, validateLeaderboardUrl } from "../.github/extensions/commit-and-sip/services/completion.mjs";
import { resultLinks } from "../.github/extensions/commit-and-sip/renderer/result-links.mjs";
import { startServer } from "../.github/extensions/commit-and-sip/server.mjs";

const receipt = { runId: "url-test", handle: "brisk-brews-coffee", score: 1000, rank: 1, rankAtCompletion: 1,
  recordedAt: "2026-09-15T10:00:00.000Z", commentId: 42 };

for (const origin of ["https://leaderboard.cafe.dev", "https://8.8.8.8", "https://[2606:4700:4700::1111]", "https://github.com"]) {
  test(`renderer preserves both verified completion URLs at ${origin}`, async () => {
    const leaderboardUrl = validateLeaderboardUrl(`${origin}/leaderboard`);
    const qrImageUrl = validateLeaderboardUrl(`${origin}/qr.png`);
    const client = new CompletionClient({
      url: `${origin}/submit`, leaderboardUrl, qrImageUrl, approvedQrOrigins: [origin],
      submit: async () => receipt, resolvePublic: async () => {},
      fetch: async () => ({ ok: true, headers: { get: () => "image/png" } })
    });
    const result = await client.submitResult({ runId: receipt.runId, handle: receipt.handle });
    assert.deepEqual(resultLinks({ mode: "live", phase: "completed", result }), { leaderboardUrl, qrImageUrl });
  });
}

test("uncompleted and rehearsal runs never display event links", () => {
  const result = { leaderboardUrl: "https://8.8.8.8/leaderboard", qrImageUrl: "https://8.8.8.8/qr.png" };
  for (const mode of ["rehearsal", "live"]) {
    for (const phase of ["order", "reviewing", "approved", "served", "completed"]) {
      if (mode === "live" && phase === "completed") continue;
      assert.deepEqual(resultLinks({ mode, phase, result }), { leaderboardUrl: null, qrImageUrl: null });
    }
  }
});

test("rendering still rejects unsafe schemes and malformed link values", () => {
  for (const value of [null, undefined, 12, "not a URL", "javascript:alert(1)", "data:text/html,bad", "http://8.8.8.8",
    "https://user:password@cafe.dev/", "https://cafe.dev:8443", "https://cafe.dev/#fragment", " https://cafe.dev/"]) {
    assert.deepEqual(resultLinks({ mode: "live", phase: "completed", result: { leaderboardUrl: value, qrImageUrl: "https://8.8.8.8/qr.png" } }),
      { leaderboardUrl: null, qrImageUrl: null });
    assert.equal(resultLinks({ mode: "live", phase: "completed", result: { leaderboardUrl: "https://cafe.dev/", qrImageUrl: value } }).qrImageUrl, null);
  }
});

test("server validation continues to reject private and reserved IP addresses", () => {
  for (const value of ["https://127.0.0.1", "https://10.0.0.1", "https://[::1]", "https://[fc00::1]", "https://[2001:db8::1]"]) {
    assert.throws(() => validateLeaderboardUrl(value));
  }
});

test("the browser entrypoint loads the result-link module from the loopback asset allowlist", async t => {
  const panel = await startServer({ engine: {}, runId: "url-test" });
  t.after(() => panel.close());
  const origin = new URL(panel.url).origin;
  assert.match(await (await fetch(panel.url)).text(), /<script type="module" src="\/app\.js"><\/script>/);
  assert.match(await (await fetch(`${origin}/app.js`)).text(), /import \{ resultLinks \} from "\.\/result-links\.mjs"/);
  const response = await fetch(`${origin}/result-links.mjs`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /javascript/);
  assert.match(await response.text(), /export function resultLinks/);
});
