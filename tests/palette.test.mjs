import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startServer } from "../.github/extensions/commit-and-sip/server.mjs";

const renderer = new URL("../.github/extensions/commit-and-sip/renderer/", import.meta.url);
const css = await readFile(new URL("style.css", renderer), "utf8");
const boothHtml = await readFile(new URL("booth.html", renderer), "utf8");
const adminHtml = await readFile(new URL("admin.html", renderer), "utf8");
const colors = Object.fromEntries([...css.matchAll(/--([a-z-]+):\s*(#[a-f0-9]{6});/g)].map(([, name, value]) => [name, value]));
function luminance(color) {
  assert.match(color, /^#[a-f0-9]{6}$/);
  const linear = color.slice(1).match(/../g).map(hex => {
    const value = parseInt(hex, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(foreground, background) {
  const values = [luminance(colors[foreground]), luminance(colors[background])].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("green-and-white palette meets AA for text, secondary text, and action states", () => {
  for (const [foreground, background] of [
    ["text", "page"], ["text", "surface"], ["muted", "page"], ["muted", "surface"],
    ["accent-ink", "page"], ["accent-ink", "surface"], ["cafe-ink", "cafe-paper"],
    ["on-accent", "accent"], ["on-accent", "accent-hover"],
    ["cafe-chalk", "cafe-board"], ["board-muted", "cafe-board"], ["board-highlight", "cafe-board"],
    ["error", "error-surface"]
  ]) {
    const ratio = contrast(foreground, background);
    assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)} must be at least 4.5:1`);
  }
  for (const background of ["page", "surface", "cafe-paper", "error-surface"]) {
    assert.ok(contrast("focus", background) >= 3, `Focus on ${background} must reach 3:1`);
    assert.ok(contrast("line", background) >= 3, `Control borders on ${background} must reach 3:1`);
  }
  assert.ok(contrast("board-line", "cafe-board") >= 3);
  // The ring also lands on the primary button, which is the accent itself.
  assert.ok(contrast("focus", "accent") >= 3, "Focus on a primary button must reach 3:1");
});

// Green 3 is the main colour but only reaches 1.51:1 on white, so the whole
// scheme rests on it being a fill and never ink. A single `color: var(--accent)`
// would put unreadable text on the page while every ratio above still passed.
test("the main colour is never used as ink", () => {
  assert.ok(contrast("accent", "page") < 3, "this guard assumes an accent too light for text");
  const offenders = css.split("\n").filter(line =>
    // Negative lookbehind so border-color and outline-color do not count.
    /(?<![-\w])color:\s*var\(--accent\)/.test(line));
  assert.deepEqual(offenders, [], `--accent must be a fill, not ink:\n${offenders.join("\n")}`);

  for (const [name, source] of [["booth.html", boothHtml], ["admin.html", adminHtml]]) {
    assert.doesNotMatch(source, /stroke="var\(--accent\)"/, `${name} strokes artwork in the fill colour`);
    assert.doesNotMatch(source, /(?<![-\w])color:\s*var\(--accent\)/, `${name} uses the fill colour as ink`);
  }
});

// The froth is the Mona mascot, supplied as a raster asset rather than drawn
// by hand. It only reaches the page if the server is willing to serve it.
test("the cup carries the Mona mascot and the booth actually serves it", async t => {
  // Regex-matching the static allow-list would still pass if resolution, the
  // status, or the content type broke, so drive the same loopback surface the
  // canvas renderer uses.
  const served = await startServer({ panel: { runId: "mona-test", get: async () => ({}), dispatch: async () => ({}) } });
  t.after(() => served.close());
  const origin = new URL(served.url).origin;

  const response = await fetch(`${origin}/mona.png`);
  assert.equal(response.status, 200, "the booth does not serve /mona.png");
  assert.equal(response.headers.get("content-type"), "image/png");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(bytes, await readFile(new URL("mona.png", renderer)), "served bytes differ from the asset on disk");
  assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG");

  // A 200 is not enough: the page's own policy has to allow the image, or it
  // is fetched and still never painted.
  const page = await fetch(served.url);
  assert.match(page.headers.get("content-security-policy"), /(?:^|; )img-src [^;]*'self'/);

  const board = boothHtml.match(/<section class="chalkboard"[\s\S]*?<\/section>/)[0];
  assert.match(board, /<image href="\/mona\.png"/, "the cup no longer carries the mascot");
  // The old heart and its brown detail strokes must be gone, not layered under.
  assert.doesNotMatch(board, /#C08A54" stroke-width="2"/, "the old froth heart is still drawn");
  // The illustration is no longer wholly original, so it must not say it is.
  assert.doesNotMatch(boothHtml, /Original café illustration/);
  assert.match(boothHtml, /<desc id="cup-description">[^<]*Mona mascot[^<]*<\/desc>/);
});

// The latte-art reading depends entirely on the asset being a single-colour
// cream silhouette. Dropping the full-colour mascot back in would still render
// and still pass every other test, but it reads as a sticker in the coffee.
test("the froth asset is a cream silhouette that reads against the coffee", async () => {
  const { PNG } = await import("pngjs");
  const png = PNG.sync.read(await readFile(new URL("mona.png", renderer)));
  const hues = new Set();
  let opaque = 0;
  for (let i = 0; i < png.width * png.height; i++) {
    if (png.data[i * 4 + 3] === 0) continue;
    opaque++;
    hues.add(`${png.data[i * 4]},${png.data[i * 4 + 1]},${png.data[i * 4 + 2]}`);
  }
  assert.ok(opaque > 1000, "froth asset is effectively empty");
  assert.equal(hues.size, 1, `froth must be one colour, found ${hues.size} (full-colour mascot?)`);

  const [r, g, b] = [...hues][0].split(",").map(Number);
  const cream = "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");
  const coffee = boothHtml.match(/rx="67"[^>]*fill="(#[0-9A-Fa-f]{6})"/)[1].toLowerCase();
  const ratio = (() => {
    const lum = c => { const l = c.slice(1).match(/../g).map(x => { const v = parseInt(x, 16) / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return l[0] * 0.2126 + l[1] * 0.7152 + l[2] * 0.0722; };
    const v = [lum(cream), lum(coffee)].sort((a, z) => z - a);
    return (v[0] + 0.05) / (v[1] + 0.05);
  })();
  assert.ok(ratio >= 3, `froth ${cream} on coffee ${coffee} is ${ratio.toFixed(2)}:1, too faint to read`);
});

test("the booth screen shares the light palette and carries the house cup on the board", async () => {
  const booth = await readFile(new URL("booth.html", renderer), "utf8");
  assert.match(booth, /name="color-scheme" content="light"/);
  assert.match(booth, /href="\/style\.css"/);
  assert.equal(colors.page, "#ffffff");
  assert.equal(colors["on-accent"], "#101411");
  assert.match(css, /color-scheme: light/);
  assert.doesNotMatch(css, /var\(--(?:background-color-default|text-color-default|color-focus-outline)/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(booth, /fill="var\(--cup-white\)"/);
  assert.match(booth, /stroke="var\(--board-highlight\)"/);
  assert.doesNotMatch(booth, /cream cup|brass-colored saucer/);
  // The cup is white on pale green. It is only legible against the dark
  // board, so it must stay inside the chalkboard rather than on the page.
  const board = booth.match(/<section class="chalkboard"[\s\S]*?<\/section>/);
  assert.ok(board, "cup artwork needs a chalkboard section");
  assert.match(board[0], /class="cup-art"/);
  assert.ok(contrast("cup-white", "cafe-board") >= 4.5);
});

test("bundled Mona Sans covers reading and display roles while retaining monospace and tabular results", async () => {
  assert.match(css, /--body-font: "Mona Sans",/);
  assert.match(css, /--display-font: var\(--body-font\)/);
  assert.match(css, /--utility-font: var\(--font-mono/);
  assert.match(css, /h2 \{ font-family: var\(--body-font\); font-weight: 600;/);
  assert.match(css, /details p \{ max-width: 70ch; font-size: 15px;/);
  assert.match(css, /font-variant-numeric: tabular-nums/);
  assert.equal((css.match(/@font-face/g) ?? []).length, 2);
  assert.equal((css.match(/font-weight: 200 900/g) ?? []).length, 2);
  assert.equal((css.match(/font-display: swap/g) ?? []).length, 2);
  assert.match(css, /font-optical-sizing: auto/);
  assert.doesNotMatch(css, /@import|url\(["']?https?:/);
  const html = await readFile(new URL("booth.html", renderer), "utf8");
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/);
  assert.match(html, /rel="preload" href="\/fonts\/MonaSansVF\.woff2" as="font" type="font\/woff2" crossorigin/);
});

// The previous tabular-nums assertion only proved the declaration was present
// somewhere in the file. Its selectors (.order-specs, .result-details,
// .menu-price) had been deleted by the naming-competition rewrite, so the rule
// matched no rendered element and the test still passed. Tie the selectors to
// the markup so an orphaned rule fails instead of passing quietly. The panels
// build their rows in script, so the scripts count as rendered markup too.
test("every selector styling figures still matches an element the booth renders", async () => {
  const markup = (await Promise.all(
    ["booth.html", "admin.html", "booth.js", "admin.js"].map(name => readFile(new URL(name, renderer), "utf8")),
  )).join("\n");

  const rules = css.split("\n").filter(line => line.includes("font-variant-numeric: tabular-nums"));
  assert.ok(rules.length > 0, "no rule sets tabular figures");

  for (const rule of rules) {
    const selectors = rule.slice(0, rule.indexOf("{")).split(",").map(part => part.trim());
    assert.ok(selectors.length > 0);
    for (const selector of selectors) {
      const token = selector.replace(/^[.#]/, "").split(/[\s:>]/)[0];
      assert.match(
        markup,
        new RegExp(`["'\\s]${token}["'\\s]`),
        `${selector} sets tabular figures but nothing the booth renders uses it`,
      );
    }
  }
});

// Figures only line up if they are in a column of their own. Both panels build
// that column in script, so pin the structure rather than only the CSS.
test("scores and staff counts are rendered as their own column", async () => {
  const booth = await readFile(new URL("booth.js", renderer), "utf8");
  const admin = await readFile(new URL("admin.js", renderer), "utf8");

  assert.match(booth, /className = "entry-score"/);
  assert.match(admin, /className = "total-value"/);
  // The score must be the last child, or it is not the rightmost column.
  assert.match(booth, /item\.append\(rank, main, score\)/);
  assert.match(admin, /item\.append\(text, figure\)/);
  assert.match(admin, /item\.append\(main, score\)/);

  for (const [name, selector] of [
    ["#leaderboard li", "#leaderboard li"],
    ["#admin-totals li", "#admin-totals li"],
    ["#admin-menu li", "#admin-menu li"],
  ]) {
    const rule = css.split("\n").find(line => line.startsWith(`${selector} {`));
    assert.ok(rule, `${name} has no layout rule`);
    assert.match(rule, /display: grid/, `${name} must lay its figures out in a grid column`);
  }
});

// Columnising the rows took the word "points" out of the staff menu text, where
// it used to read "2050 points, barista ...". Nothing on screen replaces it, so
// the column has to carry it for anyone who cannot see the layout.
test("the score column still says what its figures are", async () => {
  const booth = await readFile(new URL("booth.js", renderer), "utf8");
  const admin = await readFile(new URL("admin.js", renderer), "utf8");

  for (const [name, source] of [["booth.js", booth], ["admin.js", admin]]) {
    assert.match(source, /"visually-hidden"/, `${name} does not label its score column`);
    assert.match(source, /" points"/, `${name} does not name the unit of its scores`);
  }

  const rule = css.slice(css.indexOf(".visually-hidden"));
  assert.ok(css.includes(".visually-hidden"), "no .visually-hidden rule to hide the label with");
  // display:none and visibility:hidden would take it from screen readers too.
  assert.doesNotMatch(rule.slice(0, rule.indexOf("}")), /display: none|visibility: hidden/);
  assert.match(rule.slice(0, rule.indexOf("}")), /clip-path/);
});
