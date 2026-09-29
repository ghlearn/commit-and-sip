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
    ["board-ink", "board"], ["cup-line", "board"], ["cup-line", "cup-white"],
    ["error", "error-surface"]
  ]) {
    const ratio = contrast(foreground, background);
    assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)} must be at least 4.5:1`);
  }
  for (const background of ["page", "surface", "cafe-paper", "error-surface"]) {
    assert.ok(contrast("focus", background) >= 3, `Focus on ${background} must reach 3:1`);
    assert.ok(contrast("line", background) >= 3, `Control borders on ${background} must reach 3:1`);
  }
  assert.ok(contrast("board-line", "board") >= 3);
  assert.ok(contrast("cup-steam", "board") >= 3, "steam must read on the board");
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

  const board = boothHtml.match(/<section class="menu-board"[\s\S]*?<\/section>/)[0];
  assert.match(board, /<image href="\/mona\.png"/, "the cup no longer carries the mascot");
  // The old heart and its brown detail strokes must be gone, not layered under.
  assert.doesNotMatch(board, /#C08A54" stroke-width="2"/, "the old froth heart is still drawn");
  // The illustration is no longer wholly original, so it must not say it is.
  assert.doesNotMatch(boothHtml, /Original café illustration/);
  assert.match(boothHtml, /<desc id="cup-description">[^<]*Mona mascot[^<]*<\/desc>/);
});

// The mascot is approved brand art, so it may not be recoloured or flattened.
// That costs legibility: its own mid-tone pinks reach only ~2.1:1 on the
// coffee, so what makes it read is the cream froth pool drawn behind it, not
// its own luminance. Guard the froth, and guard that the art is still the
// approved colours with the sheet background keyed out.
test("the froth asset is the approved brand mascot, framed by a pool that reads on the coffee", async () => {
  const { PNG } = await import("pngjs");
  const png = PNG.sync.read(await readFile(new URL("mona.png", renderer)));
  const hues = new Set();
  let opaque = 0;
  let sheetBackground = 0;
  for (let i = 0; i < png.width * png.height; i++) {
    if (png.data[i * 4 + 3] < 250) continue;
    opaque++;
    const [r, g, b] = [png.data[i * 4], png.data[i * 4 + 1], png.data[i * 4 + 2]];
    hues.add(`${r},${g},${b}`);
    if (Math.hypot(r - 0xf2, g - 0xf5, b - 0xf3) < 24) sheetBackground++;
  }
  assert.ok(opaque > 1000, "froth asset is effectively empty");
  // A silhouette or a posterised recolour collapses this count.
  assert.ok(hues.size > 500, `mascot must keep its brand shading, found ${hues.size} colours`);
  const near = (target, tolerance) => [...hues].some(key => {
    const [r, g, b] = key.split(",").map(Number);
    return Math.hypot(r - target[0], g - target[1], b - target[2]) < tolerance;
  });
  assert.ok(near([0xff, 0x5c, 0x8a], 60), "the mascot's brand pink is missing");
  assert.ok(near([0x7a, 0x4d, 0xe8], 70), "the mascot's brand purple is missing");
  // The sheet it was cut from is Gray 1; any left behind is an unkeyed box.
  assert.equal(png.data[3], 0, "top-left corner is opaque, so the cutout failed");
  assert.equal(sheetBackground, 0, `${sheetBackground} pixels of sheet background survived the cutout`);

  const lum = c => { const l = c.slice(1).match(/../g).map(x => { const v = parseInt(x, 16) / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return l[0] * 0.2126 + l[1] * 0.7152 + l[2] * 0.0722; };
  const ratio = (a, b) => { const v = [lum(a), lum(b)].sort((x, z) => z - x); return (v[0] + 0.05) / (v[1] + 0.05); };
  const coffee = boothHtml.match(/rx="67"[^>]*fill="(#[0-9A-Fa-f]{6})"/)[1].toLowerCase();
  const frothMatch = boothHtml.match(/<ellipse cx="200" cy="115" rx="(\d+)" ry="(\d+)" fill="(#[0-9A-Fa-f]{6})"\/>\s*\n\s*<image href="\/mona\.png"/);
  assert.ok(frothMatch, "the mascot lost the froth pool that separates it from the coffee");
  const [poolRx, poolRy] = frothMatch.slice(1, 3).map(Number);
  const froth = frothMatch[3].toLowerCase();
  const separation = ratio(froth, coffee);
  assert.ok(separation >= 3, `froth ${froth} on coffee ${coffee} is ${separation.toFixed(2)}:1, too faint to frame the mascot`);

  // The pool is only a frame if the mascot actually sits inside it.
  const art = boothHtml.match(/<image href="\/mona\.png" x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/);
  assert.ok(art, "mascot image needs explicit geometry to be checked against the pool");
  const [x, y, w, h] = art.slice(1, 5).map(Number);
  assert.ok(x >= 200 - poolRx && x + w <= 200 + poolRx, "mascot overflows the froth pool horizontally");
  assert.ok(y >= 115 - poolRy && y + h <= 115 + poolRy, "mascot overflows the froth pool vertically");
  // A pool that merely contains the mascot can still be a speck in the cup.
  assert.ok(w * h > 0.55 * (2 * poolRx) * (2 * poolRy), "mascot is too small to read as latte art");
  // Squashing approved brand art is a brand defect, not a layout choice.
  assert.match(boothHtml, /href="\/mona\.png"[^>]*preserveAspectRatio="xMidYMid meet"/);
  assert.ok(Math.abs(w / h - png.width / png.height) < 0.05, "mascot box distorts the approved artwork");
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
  assert.doesNotMatch(booth, /cream cup|brass-colored saucer/);
  const board = booth.match(/<section class="menu-board"[\s\S]*?<\/section>/);
  assert.ok(board, "cup artwork needs a menu-board section");
  assert.match(board[0], /class="cup-art"/);

  // The board is light now, so the white cup has no edge of its own. It reads
  // only because it is outlined; a stroke that reverts to --cup-white, as it
  // was on the old dark board, would leave the cup invisible while every
  // colour token above still passed.
  assert.ok(contrast("cup-line", "board") >= 4.5);
  assert.ok(contrast("cup-white", "board") < 3, "this guard assumes a cup too pale to read unaided");
  const cupBody = board[0].match(/<path d="M120 115[^>]*>/)[0];
  assert.match(cupBody, /fill="var\(--cup-white\)"/);
  assert.match(cupBody, /stroke="var\(--cup-line\)"/, "the cup body lost its outline on the light board");
  // Every white stroke must have a darker one behind it at greater width.
  const handles = board[0].match(/<path d="M279 125[^>]*>/g) ?? [];
  assert.equal(handles.length, 2, "the handle needs an outline pass and a fill pass");
  assert.match(handles[0], /stroke="var\(--cup-line\)" stroke-width="24"/);
  assert.match(handles[1], /stroke="var\(--cup-white\)" stroke-width="14"/);

  // The glyph belongs on the exposed white face. It used to sit high enough to
  // tuck under the coffee, which reads as a smudge on the crema rather than as
  // a mark on the cup, and deepening the cup would quietly put it back there.
  const glyphPath = board[0].match(/<path d="(m188 [^"]*)" stroke="var\(--accent-ink\)"/);
  assert.ok(glyphPath, "the cup lost its code glyph");
  let [cx, cy] = [0, 0];
  let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
  // SVG packs coordinates ("180-10"), so tokenise numbers rather than pairs.
  const numbers = glyphPath[1].match(/-?\d*\.?\d+/g).map(Number);
  assert.equal(numbers.length % 2, 0, "glyph path has an odd number of coordinates");
  for (let i = 0; i < numbers.length; i += 2) {
    cx += numbers[i]; cy += numbers[i + 1];
    minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
    minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
  }
  const rim = board[0].match(/<ellipse cx="(\d+)" cy="(\d+)" rx="80" ry="(\d+)"/).slice(1).map(Number);
  assert.equal((minX + maxX) / 2, rim[0], "the glyph is not centred on the cup");
  assert.ok(minY > rim[1] + rim[2], "the glyph overlaps the coffee instead of sitting on the cup face");

  // A shade arc used to run down the cup, which read as a green line rather
  // than as shading. It is gone, and its token with it, so the glyph is the
  // only mark on the white face.
  assert.doesNotMatch(css, /--cup-shade\b/, "the cup shade token is back");
  assert.doesNotMatch(board[0], /var\(--cup-shade\)/, "the cup shade arc is back");
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

// A timed dry run found the QR rendering at its full 320px because the .qr rule
// was never applied to it, which pushed the hand-over button 119px below the
// fold on an 1100x800 panel. Styling an element the stylesheet already sizes is
// easy to drop again, so pin both halves: the class and the rule that sizes it.
test("the QR is displayed at the size the stylesheet sets for it", async () => {
  const booth = await readFile(new URL("booth.js", renderer), "utf8");

  assert.match(booth, /image\.className = "qr"/,
    "the QR image is built without the class that sizes it");

  const rule = css.split("\n").find(line => line.startsWith(".qr {"));
  assert.ok(rule, "no .qr rule to size the code with");
  const width = /width: (\d+)px/.exec(rule);
  assert.ok(width, ".qr does not set a width");
  // The encoder emits 320px. Displaying it at that size does not fit a short
  // booth panel; anything near it would put the hand-over button back off it.
  assert.ok(Number(width[1]) <= 200,
    `.qr displays the code at ${width[1]}px, which does not leave room for the hand-over button`);
});

// The hand-over button is the last step of the attendee flow. If it is off the
// bottom of a short booth panel the attendee can walk away without it, and the
// next person steps up to somebody else's served screen.
test("the hand-over button stays on screen on a short booth panel", async () => {
  const rule = css.split("\n").find(line => line.startsWith("#view-served > button.primary {"));
  assert.ok(rule, "the hand-over button has no rule keeping it on a short panel");
  assert.match(rule, /position: sticky/,
    "the hand-over button is not pinned, so a short panel can hide it");
  assert.match(rule, /bottom:/, "a sticky button with no bottom offset does not pin");
});

// The mascot shipped with a code guard but no matching correction to the prose,
// and two documents went on saying the cup carried no mascot and that official
// mascot art must not be added. Both read as "nothing here needs approval"
// while unapproved brand art was on screen. Tie the branding checklist to the
// assets actually served so that cannot drift again.
test("the branding checklist accounts for every image the booth serves", async () => {
  const serverSource = await readFile(new URL("../.github/extensions/commit-and-sip/server.mjs", import.meta.url), "utf8");
  const checklist = await readFile(new URL("../.github/images/README.md", import.meta.url), "utf8");

  const images = [...serverSource.matchAll(/\["\/([\w./-]+\.(?:png|jpg|jpeg|webp|gif|svg))"/g)].map(match => match[1]);
  assert.ok(images.includes("mona.png"), "expected the mascot in the shared asset list; this guard is reading the wrong thing");
  for (const asset of images) {
    assert.ok(checklist.includes(asset),
      `${asset} is served to attendees but is not named in .github/images/README.md`);
  }
});

// Approval is the thing a reader most needs to be told the truth about, and the
// cheapest error to make is describing the outstanding decision as settled.
test("the branding checklist does not claim the mascot is approved or absent", async () => {
  const checklist = await readFile(new URL("../.github/images/README.md", import.meta.url), "utf8");
  const contract = await readFile(new URL("../docs/integration-contract.md", import.meta.url), "utf8");

  for (const [name, text] of [["the asset checklist", checklist], ["the integration contract", contract]]) {
    assert.doesNotMatch(text, /(?:depicts|carries|shows|showing)[^.]{0,60}no mascot/i,
      `${name} still says the cup carries no mascot`);
    assert.doesNotMatch(text, /mascot[^.]{0,80}\bis approved\b/i, `${name} claims the mascot is approved`);
  }
  // State the gap, do not merely avoid denying it.
  assert.match(checklist, /\*\*Unapproved for this use\*\*/,
    "the checklist no longer records that the mascot is unapproved");
  assert.match(checklist, /Approved by:\*\* nobody/i,
    "the checklist no longer records that nobody has approved the mascot");
});
