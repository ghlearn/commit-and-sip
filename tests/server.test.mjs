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

test("a panel serves only its own page and script", async t => {
  const stub = () => ({ panel: { runId: null, get: async () => ({}), dispatch: async () => ({}) } });
  const booth = await startServer(stub());
  const admin = await startServer({ ...stub(), home: "admin.html", script: "admin.js" });
  t.after(() => Promise.all([booth.close(), admin.close()]));

  const text = async (entry, path, authorized = false) => {
    const url = new URL(entry.url);
    const headers = authorized ? { authorization: `Bearer ${url.searchParams.get("ticket")}` } : {};
    const response = await fetch(`${url.origin}${path}`, { headers });
    return { body: response.ok ? await response.text() : "", status: response.status };
  };

  // The booth screen faces a queue. Whoever is standing at it must not be able
  // to pull the staff dashboard's script out of the same server. Assets are
  // served pre-auth, so an unlisted one falls through to the API branch and is
  // refused there; holding this panel's own ticket does not get it either.
  assert.equal((await text(booth, "/admin.js")).status, 401);
  assert.equal((await text(booth, "/admin.js", true)).status, 404);
  assert.equal((await text(admin, "/booth.js", true)).status, 404);
  assert.match((await text(booth, "/")).body, /Name a drink/);
  assert.match((await text(admin, "/")).body, /Booth staff dashboard/);
  assert.match((await text(booth, "/booth.js")).body, /addEventListener/);
  assert.match((await text(admin, "/admin.js")).body, /addEventListener/);
  // Presentation stays shared so the two screens cannot drift apart visually.
  assert.equal((await text(booth, "/style.css")).status, 200);
  assert.equal((await text(admin, "/style.css")).status, 200);
});
