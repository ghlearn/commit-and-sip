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
  assert.match(section, /<img class="qr qr-repo" src="\/repo-qr\.png" width="164" height="164" alt="QR code for gh\.io\/commit-and-sip[^"]+">/);

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

// The supplied image (pinned by hash above) is 800px with 26px modules and
// only 23px of white of its own, so the white padding around it on screen is
// most of its quiet zone. A scanner expects four modules of it.
const ASSET = { size: 800, module: 26, edge: 23 };
const quietModules = (box, padding) => {
  const scale = (box - 2 * padding) / ASSET.size;           // border-box: padding is inside the box
  return (padding + ASSET.edge * scale) / (ASSET.module * scale);
};

test("the repository QR keeps a four-module quiet zone wherever it is shown", async () => {
  const boothCss = await readFile(new URL("style.css", renderer), "utf8");
  const booth = /^\.qr\.qr-repo \{ width: (\d+)px; height: \1px; padding: (\d+)px; image-rendering: auto; \}$/m.exec(boothCss);
  // Smoothed, not pixelated: it is an 800px image scaled down (see style.css).
  assert.ok(booth, "the booth sizes and smooths the repository code with its own rule");
  assert.ok(quietModules(+booth[1], +booth[2]) >= 4, `booth: ${quietModules(+booth[1], +booth[2]).toFixed(2)} modules`);

  const boardCss = await readFile(new URL("../leaderboard-service/public/board.css", import.meta.url), "utf8");
  const board = /\.built-qr \{[^}]*padding: (\d+)px; background: #fff;[^}]*width: clamp\((\d+)px, [\d.]+vw, (\d+)px\)/.exec(boardCss);
  assert.ok(board, "the board sizes its code with a padded clamp");
  for (const box of [+board[2], +board[3]]) {
    assert.ok(quietModules(box, +board[1]) >= 4, `board at ${box}px: ${quietModules(box, +board[1]).toFixed(2)} modules`);
  }
});

test("each attendee's leaderboard code is encoded with a four-module margin", async () => {
  const { renderQrDataUrl } = await import("../.github/extensions/commit-and-sip/services/qr.mjs");
  let options;
  const url = await renderQrDataUrl("https://gh.io/commit-and-sip-leader?handle=a-b-c&ref=0123456789abcdef",
    async () => ({ default: { toDataURL: async (_, given) => { options = given; return "data:image/png;base64,"; } } }));
  assert.ok(url);
  assert.ok(options.margin >= 4, `margin ${options.margin}`);
});

// Following the documentation must never expose attendee names before the
// moderation review: the attendee QR is a gated setting in every setup step.
test("the setup docs keep the attendee QR gated on the blocklist review", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const runbook = await readFile(new URL("../booth/RUNBOOK.md", import.meta.url), "utf8");
  const setting = text => text.split("\n").find(line => line.startsWith("- `leaderboardUrl` puts a"));
  for (const [label, text] of [["README", readme], ["runbook", runbook]]) {
    const line = setting(text);
    assert.ok(line, `${label} describes the setting`);
    assert.match(line, /Leave it unset until the moderation blocklist is reviewed/, `${label}: the gate comes first`);
  }
  const readiness = runbook.slice(runbook.indexOf("## Leaderboard and QR readiness"));
  assert.match(readiness, /stays gated on the blocklist review/);
});

// Status statements go stale silently. These are the ones that were once true
// and are not now: the live build refusing the client, a private repository,
// no public destination at all. None may come back into the operator docs.
test("the operator docs describe the current deployment, not an earlier one", async () => {
  const stale = [/predates (most of )?this document/i, /Redeploy before first use/, /refuses the current booth client/,
    /current booth client does not work/i, /repository it opens is private/, /there is no public QR destination/i,
    /no attendee-facing QR code points at it/i, /gated on the blocklist review and the service redeploy/,
    /one such change is waiting/, /change not yet live is the board page's 24 px quiet zone/];
  for (const file of ["../README.md", "../booth/RUNBOOK.md", "../docs/leaderboard-service.md", "../docs/integration-contract.md",
    "../docs/architecture.md", "../.github/images/README.md"]) {
    const text = await readFile(new URL(file, import.meta.url), "utf8");
    for (const phrase of stale) assert.doesNotMatch(text, phrase, `${file}: ${phrase}`);
  }
});

// A readiness count that disagrees with its own list makes the launch
// criteria ambiguous. Count the items, do not trust the sentence.
test("the readiness sections count exactly the gates they list", async () => {
  const words = { Two: 2, Three: 3, Four: 4 };
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const intro = /It is \*\*not\*\* event-ready\. (\w+) human reviews are outstanding[^\n]*\n\n((?:- [^\n]*\n)+)/.exec(readme);
  assert.ok(intro, "the README states how many reviews are outstanding, then lists them");
  assert.equal(intro[2].trim().split("\n").length, words[intro[1]], "README: the count matches the list");

  const contract = await readFile(new URL("../docs/integration-contract.md", import.meta.url), "utf8");
  const gates = contract.slice(contract.indexOf("### Launch gates"), contract.indexOf("\n## ", contract.indexOf("### Launch gates")));
  const stated = /(\w+) gates stand between this and attendees/.exec(gates);
  assert.ok(stated);
  const paragraphs = gates.split("\n\n").slice(2).filter(p => p.trim() && !p.startsWith("Not a gate") && !/^The leaderboard service is deployed/.test(p));
  assert.equal(paragraphs.length, words[stated[1]], "contract: one paragraph per stated gate");
  assert.doesNotMatch(gates, /other three gates|Four gates/);
});

// Opening a fresh board is safe only when no booth still holds takedowns for
// it to reserve. The runbook may offer the --open shortcut only behind
// archive and reset on every booth, and must keep the full sequence otherwise.
test("the runbook opens a fresh board directly only after every booth is archived and reset", async () => {
  const runbook = await readFile(new URL("../booth/RUNBOOK.md", import.meta.url), "utf8");
  const fresh = runbook.split("\n").find(line => line.startsWith("| Starting a new event on a fresh board |"));
  assert.ok(fresh, "the new-event case has its own row");
  const resetAll = fresh.indexOf("archive and reset) on every booth machine");
  assert.ok(resetAll >= 0 && resetAll < fresh.indexOf("republish -- --open"), "reset every booth, then open");
  assert.match(fresh, /If any booth was not archived and reset, do not take this shortcut/);
  const carried = runbook.split("\n").find(line => line.startsWith("| Public board lost, or `EVENT_ID` changed while booths still hold the event |"));
  assert.ok(carried, "the carried-over case keeps its row");
  const takedowns = carried.indexOf("--takedowns");
  assert.ok(takedowns >= 0 && takedowns < carried.indexOf("--open") && carried.indexOf("--open") < carried.indexOf("--drinks"), "otherwise: takedowns, then open, then drinks");
  const start = runbook.indexOf("To start a fresh board for a new event");
  assert.ok(start >= 0, "the operations section explains a fresh board");
  const ops = runbook.slice(start, runbook.indexOf("\n\n", start));
  const reset = ops.indexOf("archive and reset every booth first");
  assert.ok(reset >= 0 && reset < ops.indexOf("republish -- --open"), "reset every booth before the --open shortcut");
  assert.ok(ops.indexOf("--takedowns") >= 0 && ops.indexOf("--takedowns") < ops.lastIndexOf("--drinks"), "and the full sequence otherwise");
  assert.doesNotMatch(runbook, /open it with `npm run leaderboard:republish -- --open`/, "no unconditional open");
});

// Every operator instruction to open a board, in any doc, must be preceded in
// the same block by its prerequisite: every booth reset, or takedowns first.
test("no doc tells an operator to open a board before its prerequisite", async () => {
  const docs = ["../booth/RUNBOOK.md", "../README.md", "../docs/leaderboard-service.md", "../docs/integration-contract.md", "../docs/architecture.md"];
  let checked = 0;
  for (const doc of docs) {
    const text = await readFile(new URL(doc, import.meta.url), "utf8");
    // Paragraphs are blocks, and so is each table row: one row's prerequisite
    // must not vouch for an instruction in another row.
    const blocks = text.split(/\n\s*\n/).flatMap(part => part.split("\n").every(line => line.startsWith("|")) ? part.split("\n") : [part]);
    for (const block of blocks) {
      let at = block.indexOf("republish -- --open");
      while (at >= 0) {
        checked += 1;
        const before = block.slice(0, at).toLowerCase();
        assert.ok(/archive and reset every booth|archive and reset\) on every booth|republish -- --takedowns|`--takedowns`/.test(before),
          `${doc}: an --open instruction lacks its prerequisite: ${block.slice(Math.max(0, at - 160), at + 40)}`);
        at = block.indexOf("republish -- --open", at + 1);
      }
    }
  }
  assert.ok(checked >= 4, `found ${checked} --open instructions`);
});
