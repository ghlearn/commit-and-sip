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

test("both entrypoints share the light palette and artwork follows semantic colors", async () => {
  for (const filename of ["index.html", "launcher.html"]) {
    const html = await readFile(new URL(filename, renderer), "utf8");
    assert.match(html, /name="color-scheme" content="light"/);
    assert.match(html, /href="\/style\.css"/);
  }
  assert.equal(colors.page, "#ffffff");
  assert.equal(colors["on-accent"], "#ffffff");
  assert.match(css, /color-scheme: light/);
  assert.doesNotMatch(css, /var\(--(?:background-color-default|text-color-default|color-focus-outline)/);
  assert.match(css, /@media \(forced-colors: active\)/);
  const html = await readFile(new URL("index.html", renderer), "utf8");
  assert.match(html, /fill="var\(--cup-white\)"/);
  assert.match(html, /stroke="var\(--board-highlight\)"/);
  assert.doesNotMatch(html, /cream cup|brass-colored saucer/);
});
