import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../.github/extensions/commit-and-sip/domain.mjs";
import {
  buildAttendeeOrder, coffeeNameId, loadNameRules, normalizeCoffeeName,
  validateCoffeeName, validateNameRules
} from "../.github/extensions/commit-and-sip/services/coffee-name.mjs";

const rules = await loadNameRules();
const rejects = (raw, pattern, active = rules) => {
  let error;
  assert.throws(() => validateCoffeeName(raw, active), thrown => {
    error = thrown;
    return thrown instanceof DomainError;
  });
  assert.equal(error.code, "invalid_name");
  assert.equal(error.status, 400);
  if (pattern) assert.match(error.message, pattern);
};

test("booth name rules load and validate", () => {
  assert.deepEqual(validateNameRules(rules), rules);
  assert.deepEqual(rules.mascots, ["mona", "ducky", "copilot"]);
  for (const mascot of rules.mascots) {
    assert.ok(["original-latte-cup", "original-cortado-cup", "original-cold-brew-glass"].includes(rules.artworkByMascot[mascot]));
  }
  for (const broken of [
    null, [], { ...rules, minLength: 0 }, { ...rules, minLength: 50, maxLength: 10 },
    { ...rules, mascots: [] }, { ...rules, mascots: ["Mona"] }, { ...rules, mascots: ["mona", "mona"] },
    { ...rules, artworkByMascot: { ...rules.artworkByMascot, mona: "unapproved-cup" } },
    { ...rules, prices: [] }, { ...rules, prices: [0] }, { ...rules, prices: [5.005] },
    { ...rules, servings: ["warm"] }, { ...rules, servings: ["hot", "hot"] },
    { ...rules, blockedTerms: ["retired"] }, { ...rules, blockedTerms: [] },
  ]) {
    assert.throws(() => validateNameRules(broken), { code: "invalid_name_rules", status: 400 });
  }
});

test("a valid mascot name is normalized and given a menu ID", () => {
  assert.deepEqual(validateCoffeeName("  Ducky   Doppio  ", rules),
    { name: "Ducky Doppio", id: "ducky-doppio", mascot: "ducky", placement: "start" });
  assert.deepEqual(validateCoffeeName("Mona's Morning Mocha", rules),
    { name: "Mona's Morning Mocha", id: "monas-morning-mocha", mascot: "mona", placement: "blend" });
  assert.equal(validateCoffeeName("COPILOT CREAM", rules).mascot, "copilot");
  assert.equal(validateCoffeeName("Copilot Cold-Brew 2", rules).id, "copilot-cold-brew-2");
  assert.equal(normalizeCoffeeName("A\u00a0\u00a0B"), "A B");
  assert.equal(coffeeNameId("Mona's  Café-Latte"), "monas-caf-latte");
});

test("a mascot must appear somewhere, but the attendee chooses where", () => {
  for (const name of ["Morning Espresso", "Plain Latte", "Octocat Brew"]) rejects(name, /Include mona, ducky, copilot somewhere/);
  // The attendee picks the placement, so every position is equally valid.
  assert.equal(validateCoffeeName("Mona Mocha", rules).placement, "start");
  assert.equal(validateCoffeeName("Cold Brew Ducky", rules).placement, "end");
  assert.equal(validateCoffeeName("Iced Copilot Cup", rules).placement, "middle");
  assert.equal(validateCoffeeName("Monastery Blend", rules).placement, "blend");
  assert.equal(validateCoffeeName("Monastery Blend", rules).mascot, "mona");
});

test("the mascot is something to build on, not the whole drink", () => {
  // Otherwise the first attendee claims "Mona" outright and invents nothing.
  for (const name of ["Mona", "Ducky", "Copilot", "  copilot  ", "DUCKY"]) {
    rejects(name, /cannot be just the mascot/);
  }
  // Anything they add of their own is enough, including a fused blend.
  for (const name of ["Monachino", "Mona Mocha", "Ducky Dawn Drip", "Copilot X"]) {
    assert.ok(validateCoffeeName(name, rules).id.length > validateCoffeeName(name, rules).mascot.length);
  }
});

test("attendee text cannot smuggle injection or spoofing into GitHub surfaces", () => {
  rejects("Mona <img src=x>", /only letters, numbers/);
  rejects("Mona [link](http://x)", /only letters, numbers/);
  rejects("Mona | Ducky", /only letters, numbers/);
  rejects("Mona`Latte`", /only letters, numbers/);
  rejects("Ducky\u202Eevil", /only letters, numbers/);
  rejects("Mona\u200bLatte", /only letters, numbers/);
  rejects("Mona http", /Remove links/);
  rejects("Mona www.example", /only letters, numbers/);
  rejects("ducky.com brew", /only letters, numbers/);
  rejects("Mona @arilivigni", /only letters, numbers/);
  rejects("Mona -- Ducky", /Remove links/);
  rejects("-Mona Latte", /Start and end/);
  rejects("Mona Latte-", /Start and end/);
  rejects("'Mona'", /Start and end/);
  // Line breaks and tabs are neutralized to single spaces rather than rejected,
  // so a multi-line paste cannot survive into an issue body or PR title.
  for (const raw of ["Mona\nLatte", "Mona\r\nLatte", "Mona\tLatte", "Mona\u2028Latte"]) {
    assert.deepEqual(validateCoffeeName(raw, rules),
      { name: "Mona Latte", id: "mona-latte", mascot: "mona", placement: "start" });
  }
});

test("length limits and the staff blocklist are enforced after normalization", () => {
  rejects("Mo", /3 to 40 characters/);
  rejects(`Mona ${"a".repeat(40)}`, /3 to 40 characters/);
  assert.equal(validateCoffeeName(`Mona ${"a".repeat(35)}`, rules).name.length, 40);
  // Deliberately a fixture, not whatever the shipped list happens to contain.
  // Pinning these to real moderation terms would mean a reviewer replacing the
  // placeholder had to paste slurs into this file to keep the suite green.
  const blocked = {
    ...rules,
    blocklist: { review: { placeholder: true }, entries: [{ term: "zzqq", match: "substring" }] }
  };
  rejects("Mona zzqq", /not available/, blocked);
  rejects("MONA ZZQQ", /not available/, blocked);
  // The retired flat list could not have caught this; the structured list folds
  // the digit swap back to "brew" before comparing.
  rejects("Ducky Br3w", /not available/, {
    ...rules,
    blocklist: { review: { placeholder: true }, entries: [{ term: "ducky brew", match: "substring" }] }
  });
  for (const raw of [null, undefined, 42, {}, []]) {
    assert.throws(() => validateCoffeeName(raw, rules), { code: "invalid_name", status: 400 });
  }
});

test("an attendee order is deterministic, schema-valid, and catalog-shaped", () => {
  const order = buildAttendeeOrder("Ducky Doppio", rules, "run-a");
  assert.deepEqual(Object.keys(order).sort(), ["artwork", "description", "id", "name", "price", "serving"]);
  assert.deepEqual(buildAttendeeOrder("Ducky Doppio", rules, "run-a"), order);
  assert.equal(order.id, "ducky-doppio");
  assert.equal(order.artwork, rules.artworkByMascot.ducky);
  assert.ok(rules.prices.includes(order.price));
  assert.ok(rules.servings.includes(order.serving));
  assert.match(order.description, /^A ducky-inspired pour/);
  assert.notDeepEqual(buildAttendeeOrder("Ducky Doppio", rules, "run-b"), order, "a different run varies the facts to verify");
  assert.throws(() => buildAttendeeOrder("Ducky Doppio", rules, ""), { code: "invalid_run", status: 400 });
});
