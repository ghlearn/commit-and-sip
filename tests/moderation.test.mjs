import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blocklistStatus, canonicalizeForMatch, findBlockedTerm, loadBlocklist, matchTokens, validateBlocklist
} from "../.github/extensions/commit-and-sip/services/moderation.mjs";
import { loadNameRules, validateCoffeeName } from "../.github/extensions/commit-and-sip/services/coffee-name.mjs";
import { readFileSync } from "node:fs";
import { inspectEntries, falsePositives } from "../scripts/check-blocklist.mjs";

const shippedNotes = () => JSON.parse(
  readFileSync(new URL("../booth/blocked-terms.json", import.meta.url), "utf8")).review.notes;

const list = validateBlocklist({
  review: { placeholder: false, reviewedBy: "booth-lead", reviewedAt: "2026-01-01" },
  entries: [
    { term: "zzqq", match: "substring" },
    { term: "grind", match: "word" }
  ]
});

test("canonicalization defeats spacing, doubling and digit swaps", () => {
  const forms = ["zzqq", "z z q q", "z-z-q-q", "zzzzqq", "z'z'q'q", "zzqq"];
  for (const form of forms) {
    assert.equal(canonicalizeForMatch(form), "zq", `${form} should fold to the same form`);
  }
  assert.equal(canonicalizeForMatch("m0n4"), "mona");
  assert.equal(canonicalizeForMatch("5t34m"), "steam");
});

test("a blocked term is still caught when it is evaded", () => {
  for (const name of ["Mona zzqq", "Mona z z q q", "Mona zz-qq", "Mona zzzqqq", "Mona ZZQQ"]) {
    assert.ok(findBlockedTerm(name, list), `${name} should be blocked`);
  }
});

test("substring mode blocks the fragment anywhere, including across words", () => {
  assert.ok(findBlockedTerm("Monazzqqster", list));
  // Separators are removed before matching, so a term split across two words
  // is still one continuous run and cannot slip through.
  assert.ok(findBlockedTerm("Mona zz qq brew", list));
});

test("word mode does not reject ordinary words that contain the term", () => {
  // The Scunthorpe problem: a real list contains fragments of innocent words,
  // so word mode has to leave longer words alone.
  assert.equal(findBlockedTerm("Mona Grinder", list), null);
  assert.equal(findBlockedTerm("Coldgrind Mona", list), null);
  assert.ok(findBlockedTerm("Mona Grind", list), "the standalone word is still blocked");
  assert.ok(findBlockedTerm("Mona g r i n d", list), "and its spaced form collapses back to it");
});

test("tokenization keeps word boundaries that the joined form discards", () => {
  assert.deepEqual(matchTokens("Mona's Cold-Brew"), ["mona", "s", "cold", "brew"]);
  assert.equal(canonicalizeForMatch("Mona's Cold-Brew"), "monascoldbrew");
});

test("a blocklist must declare provenance and a usable match mode", () => {
  const rejects = value => assert.throws(() => validateBlocklist(value), { code: "invalid_blocklist" });
  rejects({ entries: [] });
  rejects({ entries: [{ term: "x", match: "word" }] });
  rejects({ review: { placeholder: true }, entries: [{ term: "x", match: "fuzzy" }] });
  rejects({ review: { placeholder: true }, entries: [{ term: "X", match: "word" }] });
  // A term of pure separators folds to nothing and would match every name.
  rejects({ review: { placeholder: true }, entries: [{ term: "---", match: "substring" }] });
  rejects({ review: {}, entries: [] });
});

test("readiness is reported separately so a placeholder still loads", () => {
  assert.equal(blocklistStatus(list).ready, true);
  const placeholder = blocklistStatus({ review: { placeholder: true }, entries: list.entries });
  assert.equal(placeholder.ready, false);
  assert.match(placeholder.reason, /placeholder/);
  for (const review of [{ placeholder: false }, { placeholder: false, reviewedBy: "x" }, { placeholder: false, reviewedBy: "x", reviewedAt: "nope" }]) {
    assert.equal(blocklistStatus({ review, entries: list.entries }).ready, false);
  }
  assert.equal(blocklistStatus({ review: { placeholder: false, reviewedBy: "x", reviewedAt: "2026-01-01" }, entries: [] }).ready, false);
});

test("the shipped blocklist is valid, wired to names, and honest about its own review state", async () => {
  const shipped = await loadBlocklist();
  const status = blocklistStatus(shipped);
  // Asserting a flat `ready === false` would have meant that approving the list
  // broke the suite -- the one edit this file exists to invite. Pin the honest
  // invariant instead, which holds before and after a reviewer signs off.
  if (shipped.review.placeholder) {
    assert.equal(status.ready, false, "a placeholder must never claim readiness");
  } else {
    assert.ok(shipped.entries.length, "an approved list must not be empty");
    assert.ok(status.ready, `an approved list must record its reviewer and date: ${status.reason}`);
  }

  const rules = await loadNameRules();
  assert.deepEqual(rules.blocklist, shipped, "the shipped list must be the one name validation uses");

  // Probe with whatever the file actually contains rather than a hardcoded term.
  // Matching behaviour is covered above on fixtures, so this survives the
  // placeholder being replaced by a reviewed list without ever naming a term
  // here -- a reviewer must never have to paste slurs into the test suite.
  for (const entry of shipped.entries) {
    assert.ok(findBlockedTerm(entry.term, shipped),
      `the shipped list does not catch its own entry "${entry.term}"`);
  }
  assert.equal(validateCoffeeName("Mona Moonrise", rules).id, "mona-moonrise",
    "an ordinary name must survive whatever list is shipped");
});

test("an absent blocklist is not treated as a match", () => {
  assert.equal(findBlockedTerm("Mona Moonrise", undefined), null);
  assert.equal(findBlockedTerm("Mona Moonrise", { entries: [] }), null);
});

// The review aid behind `npm run blocklist`. These use shaped placeholders, not
// moderation terms, for the same reason as the suite above.
test("the checker rejects an entry that folds to a single character", () => {
  // Repeat collapsing makes any doubled term one character, so "bb" as a
  // substring refuses every name containing the letter b. The guidance in
  // blocked-terms.json once recommended exactly this spelling for numeric
  // codes, so the rule protects against that advice coming back.
  const findings = inspectEntries([{ term: "bb", match: "substring" }]);
  assert.ok(findings.some(finding => finding.level === "error"),
    "a substring entry folding to one character must be an error");
  assert.equal(canonicalizeForMatch("88"), canonicalizeForMatch("bb"),
    "writing a numeric code in letters must not be treated as a fix");
});

test("the checker fails a list that would refuse a house drink", () => {
  const houseNames = JSON.parse(
    readFileSync(new URL("../booth/orders.json", import.meta.url), "utf8")).map(order => order.name);
  const bad = { entries: [{ term: "bb", match: "substring" }], review: { placeholder: true } };
  const hits = falsePositives(houseNames, bad, houseNames);
  assert.ok(hits.some(hit => hit.house), "refusing a seeded drink must be caught");
  assert.equal(falsePositives(houseNames, list, houseNames).length, 0,
    "a sensibly scoped list must leave the house drinks alone");
});

test("the shipped guidance warns about repeat collapsing", () => {
  const notes = shippedNotes().join(" ");
  // Tied to the claim, not to a keyword: "collapse" also appears in an
  // unrelated note, so matching it alone would pass without the warning.
  assert.ok(/doubled[^.]{0,40}single character/i.test(notes),
    "the notes must warn that a doubled code is compared as one character");
  assert.ok(!/must be listed in their folded letter form/i.test(notes),
    "the notes must not recommend the letter spelling as if it were safe");
});
