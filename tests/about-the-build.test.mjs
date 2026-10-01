import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { startServer } from "../.github/extensions/commit-and-sip/server.mjs";
import { loadNameRules } from "../.github/extensions/commit-and-sip/services/coffee-name.mjs";
import { createApp } from "../leaderboard-service/app.mjs";
import { MemoryStore } from "../leaderboard-service/store.mjs";

// "How this was built", with a QR code for the repository, on both surfaces an
// attendee sees: the booth's served screen and the public leaderboard.

const renderer = new URL("../.github/extensions/commit-and-sip/renderer/", import.meta.url);
const qrFile = new URL("repo-qr.png", renderer);
const boothHtml = await readFile(new URL("booth.html", renderer), "utf8");
const boardHtml = await readFile(new URL("../leaderboard-service/public/index.html", import.meta.url), "utf8");
const about = html => html.match(/<section[^>]*aria-labelledby="built-heading"[\s\S]*?<\/section>/)?.[0];
const LINK = /<a href="https:\/\/gh\.io\/commit-and-sip" rel="noreferrer noopener" target="_blank">gh\.io\/commit-and-sip<\/a>/;

test("the repository QR is the image that was decoded and checked", async () => {
  // The supplied code was decoded with jsQR and ZXing to https://gh.io/commit-and-sip.
  // A replacement must be decoded the same way before this hash is updated.
  const digest = createHash("sha256").update(await readFile(qrFile)).digest("hex");
  assert.equal(digest, "f4f370edcb95644d6b7aaf571c87a8d353323c51b5321f6ce0cae948054d291f");
});

test("the booth's served screen says how it was built and links to the code", async t => {
  const served = boothHtml.match(/<section id="view-served"[\s\S]*?<button id="finish"/)?.[0];
  assert.ok(served, "the served view exists");
  const section = about(served);
  assert.ok(section, "the section is on the served screen, before hand-over");
  assert.match(section, /<h2 id="built-heading">How this was built<\/h2>/);
  assert.match(section, LINK);
  assert.match(section, /<img class="qr" src="\/repo-qr\.png" width="148" height="148" alt="QR code for gh\.io\/commit-and-sip[^"]+">/);

  const panel = await startServer({ panel: { runId: "about-test", get: async () => ({}), dispatch: async () => ({}) } });
  t.after(() => panel.close());
  const response = await fetch(`${new URL(panel.url).origin}/repo-qr.png`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(qrFile));
});

test("the public leaderboard says how it was built, serves the same code, and ships it", async t => {
  const section = about(boardHtml);
  assert.ok(section, "the section is on the board page");
  assert.match(section, LINK);
  assert.match(section, /<img class="built-qr" src="\/repo-qr\.png"[^>]* alt="QR code for gh\.io\/commit-and-sip[^"]+">/);

  const words = JSON.parse(await readFile(new URL("../booth/handle-words.json", import.meta.url), "utf8"));
  const app = createApp({ boothKey: "b".repeat(64), staffKey: "s".repeat(64), reservationKey: "r".repeat(64),
    rules: await loadNameRules(), store: new MemoryStore(), words });
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/repo-qr.png`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(qrFile), "the same file the booth shows");
  assert.match(response.headers.get("content-security-policy"), /(?:^|; )img-src 'self'/);

  const { packageManifest } = await import("../scripts/package-leaderboard.mjs");
  assert.ok((await packageManifest()).includes(".github/extensions/commit-and-sip/renderer/repo-qr.png"), "deployed with the service");
  const css = await readFile(new URL("../leaderboard-service/public/board.css", import.meta.url), "utf8");
  assert.match(css, /\.built-qr \{[^}]*padding: 8px; background: #fff;/, "a white quiet zone around a code that has almost none");
});

test("both screens make the same factual claims about the build", () => {
  for (const [label, html] of [["booth", about(boothHtml)], ["board", about(boardHtml)]]) {
    for (const claim of [/built with GitHub Copilot/, /a canvas: a small web app that runs inside the GitHub Copilot App as an extension/,
      /from a fixed rubric in the code, not from an AI model/, /Node\.js service on Azure App Service, set up with Bicep/,
      /reviewed with Copilot code review before merging, and GitHub Actions checks the repository/]) {
      assert.match(html, claim, `${label}: ${claim}`);
    }
  }
});
