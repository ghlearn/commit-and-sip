import { test } from "node:test";
import assert from "node:assert/strict";
import { loadNameRules } from "../.github/extensions/commit-and-sip/services/coffee-name.mjs";
import { EXAMPLE_IDS, MAX_SCORE, scoreCoffeeName } from "../.github/extensions/commit-and-sip/services/name-score.mjs";

const rules = await loadNameRules();

test("the rubric is bounded and its parts sum to the advertised maximum", () => {
  assert.equal(MAX_SCORE, 5000);
  const { breakdown } = scoreCoffeeName("Mona Mocha", rules);
  assert.equal(breakdown.reduce((sum, part) => sum + part.max, 0), MAX_SCORE,
    "an attendee can only be told the score is out of 5000 if the parts really reach it");
});

test("a score is a pure, reproducible function of the name alone", () => {
  const first = scoreCoffeeName("Ducky Dawn Drip", rules);
  // Repeated, re-cased and re-spaced submissions must never disagree, so a
  // disputed score at the booth can always be reproduced. The attendee's own
  // capitalisation is kept for display, while the menu ID stays canonical so
  // "Mona Mocha" and "mona mocha" collide as duplicates.
  for (const raw of ["Ducky Dawn Drip", "  ducky   dawn  drip ", "DUCKY DAWN DRIP"]) {
    const repeat = scoreCoffeeName(raw, rules);
    assert.equal(repeat.score, first.score);
    assert.deepEqual(repeat.breakdown, first.breakdown);
    assert.equal(repeat.id, first.id);
    assert.equal(repeat.mascot, first.mascot);
  }
  assert.equal(scoreCoffeeName("DUCKY DAWN DRIP", rules).name, "DUCKY DAWN DRIP", "display keeps what the attendee typed");
});

test("every score stays inside 1 to 5000 and is explained by its breakdown", () => {
  const names = [
    "Mona Mocha", "Monachino", "Ducky Doppio", "Copilot Cosmic Crema",
    "Monachino Midnight Mocha Marvel", "Mona Nebula", "Copilot Quantum Roast",
    `Mona ${"a".repeat(35)}`, "Ducky Bubblegum Brew", "Mona Moonlight Mocha",
  ];
  for (const name of names) {
    const { score, breakdown } = scoreCoffeeName(name, rules);
    assert.ok(Number.isSafeInteger(score) && score >= 1 && score <= MAX_SCORE, `${name} scored ${score}`);
    assert.equal(breakdown.reduce((sum, part) => sum + part.points, 0), score, `${name} breakdown must equal its score`);
    for (const part of breakdown) {
      assert.ok(part.points >= 0 && part.points <= part.max, `${name} part ${part.label} is out of range`);
    }
  }
});

test("richer names outrank plainer ones", () => {
  const score = name => scoreCoffeeName(name, rules).score;
  assert.ok(score("Monachino Midnight Mocha Marvel") > score("Mona Moonlight Mocha"));
  assert.ok(score("Mona Moonlight Mocha") > score("Mona Mocha"));
  assert.ok(score("Mona Mocha") > score("Mona Nebula"), "a coffee term beats a bare invented word");
});

test("the house examples are never scored", () => {
  for (const name of ["Mona Latte", "Copilot Cortado", "Ducky Cold Brew", "  mona   latte  "]) {
    assert.throws(() => scoreCoffeeName(name, rules), { code: "example_name", status: 400 });
  }
  assert.deepEqual(EXAMPLE_IDS, ["mona-latte", "copilot-cortado", "ducky-cold-brew"]);
});

test("scoring refuses anything the name rules reject", () => {
  for (const name of ["Morning Espresso", "Latte Supreme", "Mona <img src=x>", "Mo", "Mona blocked-example-term"]) {
    assert.throws(() => scoreCoffeeName(name, rules), { code: "invalid_name", status: 400 });
  }
});
