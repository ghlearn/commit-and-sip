import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { startServer } from "../.github/extensions/commit-and-sip/server.mjs";

test("loopback API requires capability, exact Origin, Host, content type, and bounded JSON", async t => {
  // A minimal stub keeps this suite on the transport's security rules rather
  // than on any one panel's behaviour.
  const entry = await startServer({
    panel: { runId: "test", get: async () => ({ runId: "test" }), dispatch: async () => ({ done: true }) }
  });
  t.after(() => entry.close());
  const url = new URL(entry.url);
  assert.equal(entry.server.address().address, "127.0.0.1");
  const authorization = `Bearer ${url.searchParams.get("ticket")}`;
  assert.equal((await fetch(`${url.origin}/api/state`)).status, 401);
  assert.equal((await fetch(`${url.origin}/api/state`, { headers: { authorization } })).status, 200);
  const headers = { authorization, "content-type": "application/json", origin: url.origin };
  const send = (body, extra = {}) => fetch(`${url.origin}/api/action`, { method: "POST", headers: { ...headers, ...extra }, body });
  assert.equal((await send('{"action":"start","input":{}}')).status, 200);
  assert.equal((await send("{}", { origin: "https://evil.example" })).status, 403);
  const rejectedHost = await new Promise((resolve, reject) => {
    const req = request(`${url.origin}/api/state`, { headers: { host: "evil.example", authorization } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(rejectedHost, 403);
  assert.equal((await send("{}", { "content-type": "text/plain" })).status, 415);
  assert.equal((await send("{")).status, 400);
  assert.equal((await send(JSON.stringify({ action: "start", input: {}, score: 1000 }))).status, 400);
  assert.equal((await send("x".repeat(8193))).status, 413);
});
