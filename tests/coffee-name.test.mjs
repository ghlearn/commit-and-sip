import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../.github/extensions/commit-and-sip/domain.mjs";
import {
  buildAttendeeOrder, coffeeNameId, loadNameRules, normalizeCoffeeName,
  proposePullRequestCopy, validateCoffeeName, validateNameRules
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
    { ...rules, proposal: { flawRate: 1.5, flawFields: ["price"] } },
    { ...rules, proposal: { flawRate: 0.5, flawFields: ["name"] } },
    { ...rules, proposal: { flawRate: 0.5, flawFields: [] } },
    { ...rules, blockedTerms: ["NotLowercase"] }, { ...rules, blockedTerms: [""] },
  ]) {
    assert.throws(() => validateNameRules(broken), { code: "invalid_name_rules", status: 400 });
  }
});

test("a valid mascot name is normalized and given a menu ID", () => {
  assert.deepEqual(validateCoffeeName("  Ducky   Doppio  ", rules), { name: "Ducky Doppio", id: "ducky-doppio", mascot: "ducky" });
  assert.deepEqual(validateCoffeeName("Mona's Morning Mocha", rules), { name: "Mona's Morning Mocha", id: "monas-morning-mocha", mascot: "mona" });
  assert.equal(validateCoffeeName("COPILOT CREAM", rules).mascot, "copilot");
  assert.equal(validateCoffeeName("Cold-Brew Ducky 2", rules).id, "cold-brew-ducky-2");
  assert.equal(normalizeCoffeeName("A\u00a0\u00a0B"), "A B");
  assert.equal(coffeeNameId("Mona's  Café-Latte"), "monas-caf-latte");
});

test("names without an approved mascot are rejected", () => {
  for (const name of ["Morning Espresso", "Plain Latte", "Octocat Brew"]) rejects(name, /Include mona, ducky, copilot/);
  assert.equal(validateCoffeeName("Monastery Blend", rules).mascot, "mona", "substring matches are accepted deliberately");
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
    assert.deepEqual(validateCoffeeName(raw, rules), { name: "Mona Latte", id: "mona-latte", mascot: "mona" });
  }
});

test("length limits and the staff blocklist are enforced after normalization", () => {
  rejects("Mo", /3 to 40 characters/);
  rejects(`Mona ${"a".repeat(40)}`, /3 to 40 characters/);
  assert.equal(validateCoffeeName(`Mona ${"a".repeat(35)}`, rules).name.length, 40);
  rejects("Mona blocked-example-term", /not available/);
  rejects("MONA BLOCKED-EXAMPLE-TERM", /not available/);
  rejects("Ducky Brew", /not available/, { ...rules, blockedTerms: ["ducky brew"] });
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

test("a seeded proposal misstates exactly one field while the diff stays correct", () => {
  const order = buildAttendeeOrder("Mona Latte Supreme", rules, "run-1");
  const always = { ...rules, proposal: { flawRate: 1, flawFields: ["price", "serving"] } };
  const never = { ...rules, proposal: { flawRate: 0, flawFields: ["price", "serving"] } };

  const clean = proposePullRequestCopy(order, never, "run-1");
  assert.equal(clean.flaw, null);
  assert.deepEqual(clean.claim, { price: order.price, serving: order.serving });

  const seeded = proposePullRequestCopy(order, always, "run-1");
  assert.ok(seeded.flaw, "flawRate 1 must always seed a flaw");
  assert.ok(["price", "serving"].includes(seeded.flaw.field));
  assert.equal(seeded.flaw.actual, order[seeded.flaw.field]);
  assert.equal(seeded.flaw.claimed, seeded.claim[seeded.flaw.field]);
  assert.notEqual(seeded.claim[seeded.flaw.field], order[seeded.flaw.field]);
  const differing = ["price", "serving"].filter(key => seeded.claim[key] !== order[key]);
  assert.deepEqual(differing, [seeded.flaw.field], "exactly one claimed field may differ");
  assert.deepEqual(proposePullRequestCopy(order, always, "run-1"), seeded, "seeding is deterministic per run");

  for (const copy of [clean, seeded]) {
    assert.deepEqual(copy.entry, order, "the committed menu entry always matches the order exactly");
    assert.equal(copy.title, `Add ${order.name} to the menu`);
    assert.match(copy.body, new RegExp(`Price: \\$${copy.claim.price.toFixed(2)}`));
    assert.match(copy.body, new RegExp(`Serving: ${copy.claim.serving}`));
  }

  const servingOnly = proposePullRequestCopy(order, { ...always, proposal: { flawRate: 1, flawFields: ["serving"] } }, "run-1");
  assert.equal(servingOnly.flaw.field, "serving");
  assert.equal(servingOnly.claim.serving, order.serving === "hot" ? "cold" : "hot");
  assert.equal(servingOnly.entry.serving, order.serving);

  const priceOnly = proposePullRequestCopy(order, { ...always, proposal: { flawRate: 1, flawFields: ["price"] } }, "run-1");
  assert.equal(priceOnly.flaw.field, "price");
  assert.ok(rules.prices.includes(priceOnly.claim.price));
  assert.notEqual(priceOnly.claim.price, order.price);
  assert.equal(priceOnly.entry.price, order.price);
});

test("the configured flaw rate is honored across many runs", () => {
  const rate = rules.proposal.flawRate;
  const runs = Array.from({ length: 400 }, (_, index) => `run-${index}`);
  const flawed = runs.filter(runId => proposePullRequestCopy(buildAttendeeOrder("Copilot Cortado Deluxe", rules, runId), rules, runId).flaw).length;
  const observed = flawed / runs.length;
  assert.ok(Math.abs(observed - rate) < 0.1, `observed flaw rate ${observed} should approximate ${rate}`);
});
