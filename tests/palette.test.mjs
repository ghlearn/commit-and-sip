import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const renderer = new URL("../.github/extensions/commit-and-sip/renderer/", import.meta.url);
const css = await readFile(new URL("style.css", renderer), "utf8");
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
    ["accent", "page"], ["accent", "surface"], ["cafe-ink", "cafe-paper"],
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
});

test("the booth screen shares the light palette and carries the house cup on the board", async () => {
  const booth = await readFile(new URL("booth.html", renderer), "utf8");
  assert.match(booth, /name="color-scheme" content="light"/);
  assert.match(booth, /href="\/style\.css"/);
  assert.equal(colors.page, "#ffffff");
  assert.equal(colors["on-accent"], "#ffffff");
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
