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

test("one valid name earns every category maximum, so 5000 is really reachable", () => {
  // Summing the caps is not enough: the old rubric's caps also summed to 5000,
  // but its word-count band made the last 400 points impossible to earn.
  const best = "Monaduckycopilot Moka Mocha Mint Squint";
  assert.ok(best.length <= 40, "the name fits the length limit");
  const { breakdown, score } = scoreCoffeeName(best, rules);
  for (const part of breakdown) assert.equal(part.points, part.max, `${part.label} is at its maximum`);
  assert.equal(score, MAX_SCORE);
});

test("scores move in single points, not steps of 50", () => {
  const score = name => scoreCoffeeName(name, rules).score;
  const letters = name => scoreCoffeeName(name, rules).breakdown.find(part => part.label === "Letter value");
  // A one-letter respelling changes the score without changing any coarse category.
  assert.equal(score("Mona Moonrisf Mocha") - score("Mona Moonrise Mocha"), 1);
  assert.equal(letters("Mona Mocha").points, 83, "A=1 ... Z=26, summed over the letters");
  assert.equal(letters(`Mona ${"z".repeat(35)}`).points, 400, "Letter value is capped");
  const seen = new Set(["Mona Mocha", "Mona Moonrise Mocha", "Ducky Dawn Drizzle", "Copilot Cinder Crema",
    "Mona Moonlight Mocha", "Mona Nebula", "Ducky Doppio", "Copilot Cosmic Crema"].map(score));
  assert.equal(seen.size, 8, "everyday names do not pile up on the same total");
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

test("more mascots earn a Mascot crew bonus, not Invention credit", () => {
  const part = (name, label) => scoreCoffeeName(name, rules).breakdown.find(item => item.label === label);
  assert.equal(part("Mona Mocha", "Mascot crew").points, 0);
  assert.equal(part("Mona Ducky Mocha", "Mascot crew").points, 300);
  assert.equal(part("Mona Ducky Copilot Mocha", "Mascot crew").points, 600);
  assert.equal(part("Monachino Ducky", "Mascot crew").points, 300, "a blended mascot still joins the crew");
  assert.deepEqual(part("Mona Ducky Copilot Mocha", "Invention").detail, [], "mascots are not invented words");

  const score = name => scoreCoffeeName(name, rules).score;
  assert.ok(score("Mona Ducky Copilot Mocha") > score("Mona Ducky Mocha"));
  assert.ok(score("Mona Ducky Mocha") > score("Mona Mocha"));
  assert.ok(score("Mona Ducky Mocha") > score("Mona Nebula Mocha"), "a second mascot beats an ordinary invented word");
});

test("Mascot crew only counts mascots the name validator recognises", () => {
  const crew = name => scoreCoffeeName(name, rules).breakdown.find(item => item.label === "Mascot crew");
  const members = name => [...crew(name).detail].sort();

  // Validation needs a mascot's text unbroken, so punctuation inside a word
  // cannot earn crew credit that validation itself would not give.
  assert.deepEqual(crew("Mona Du'cky Co-pilot Mocha"), { label: "Mascot crew", max: 600, points: 0, detail: ["mona"] });
  assert.deepEqual(members("Mona Du-cky Mocha"), ["mona"]);
  assert.deepEqual(members("Mona Ducky Co-pilot Mocha"), ["ducky", "mona"]);
  assert.equal(crew("Mona Ducky Co-pilot Mocha").points, 300, "only the unbroken mascots join the crew");

  // Blends and neighbouring punctuation still count, because the mascot's own
  // letters are unbroken.
  assert.deepEqual(members("Monachino Ducky's Mocha"), ["ducky", "mona"]);
  assert.equal(crew("Mona-chino Ducky").points, 300);
});

test("the house examples are never scored", () => {
  for (const name of ["Mona Latte", "Copilot Cortado", "Ducky Cold Brew", "  mona   latte  "]) {
    assert.throws(() => scoreCoffeeName(name, rules), { code: "example_name", status: 400 });
  }
  assert.deepEqual(EXAMPLE_IDS, ["mona-latte", "copilot-cortado", "ducky-cold-brew"]);
});

test("scoring refuses anything the name rules reject", () => {
  for (const name of ["Morning Espresso", "Latte Supreme", "Mona <img src=x>", "Mo"]) {
    assert.throws(() => scoreCoffeeName(name, rules), { code: "invalid_name", status: 400 });
  }
  // A blocked name is refused before it can be scored. The term is a fixture so
  // this stays true whatever the reviewed list ends up containing.
  const blocked = {
    ...rules,
    blocklist: { review: { placeholder: true }, entries: [{ term: "zzqq", match: "substring" }] }
  };
  assert.throws(() => scoreCoffeeName("Mona zzqq", blocked), { code: "invalid_name", status: 400 });
});
