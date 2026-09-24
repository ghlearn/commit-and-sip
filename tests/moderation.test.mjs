import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blocklistStatus, canonicalizeForMatch, findBlockedTerm, loadBlocklist, matchTokens, validateBlocklist
} from "../.github/extensions/commit-and-sip/services/moderation.mjs";
import { loadNameRules, validateCoffeeName } from "../.github/extensions/commit-and-sip/services/coffee-name.mjs";

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

test("the shipped blocklist is valid, wired to names, and honestly unreviewed", async () => {
  const shipped = await loadBlocklist();
  const status = blocklistStatus(shipped);
  assert.equal(status.ready, false, "the shipped list is a placeholder and must not claim readiness");

  const rules = await loadNameRules();
  assert.deepEqual(rules.blocklist, shipped);
  assert.throws(() => validateCoffeeName("Mona blocked-example-term", rules), { code: "invalid_name" });
  // Evasion of the shipped placeholder is blocked by the same folding.
  assert.throws(() => validateCoffeeName("Mona blockedexampleterm", rules), { code: "invalid_name" });
  assert.throws(() => validateCoffeeName("Mona exampleword", rules), { code: "invalid_name" });
  // Word mode leaves a longer word alone.
  assert.equal(validateCoffeeName("Mona Examplewordsmith", rules).id, "mona-examplewordsmith");
  assert.equal(validateCoffeeName("Mona Moonrise", rules).id, "mona-moonrise");
});

test("an absent blocklist is not treated as a match", () => {
  assert.equal(findBlockedTerm("Mona Moonrise", undefined), null);
  assert.equal(findBlockedTerm("Mona Moonrise", { entries: [] }), null);
});
