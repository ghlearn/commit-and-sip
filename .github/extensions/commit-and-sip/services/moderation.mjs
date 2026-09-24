import { readFile } from "node:fs/promises";
import { requireValue } from "../domain.mjs";

// Attendee names are published on the house menu, so a blocked term has to stay
// blocked when someone spaces it out, doubles a letter, or swaps in a digit.
// The name charset rejects non-ASCII before this runs, so homoglyph and
// zero-width evasion is already impossible here and only ASCII tricks remain.
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", "@": "a", $: "s", "!": "i", "+": "t" };

function fold(text) {
  return text.toLowerCase().replace(/./g, character => LEET[character] ?? character);
}

function collapse(text) {
  return text.replace(/(.)\1+/g, "$1");
}

// Separators vanish and repeated characters collapse, so "b a d", "b-a-d" and
// "baaad" all reduce to the same form. Both sides are folded the same way, so
// legitimate doubled letters still match their own term.
export function canonicalizeForMatch(text) {
  return collapse(fold(text).replace(/[^a-z0-9]+/g, ""));
}

// Word mode needs the separators the joined form throws away.
export function matchTokens(text) {
  return fold(text).split(/[^a-z0-9]+/).filter(Boolean).map(collapse);
}

export function validateBlocklist(list) {
  const nonempty = value => typeof value === "string" && value.trim().length > 0;
  requireValue(list && typeof list === "object" && !Array.isArray(list),
    "invalid_blocklist", "The moderation blocklist must be an object.", 400);
  requireValue(Array.isArray(list.entries), "invalid_blocklist", "The moderation blocklist needs an entries array.", 400);
  for (const entry of list.entries) {
    requireValue(entry && typeof entry === "object" && !Array.isArray(entry),
      "invalid_blocklist", "Every blocklist entry must be an object.", 400);
    requireValue(nonempty(entry.term) && entry.term === entry.term.toLowerCase(),
      "invalid_blocklist", "Blocklist terms must be nonempty lowercase strings.", 400);
    // A term that folds away to nothing would match every name.
    requireValue(canonicalizeForMatch(entry.term).length > 0,
      "invalid_blocklist", `Blocklist term "${entry.term}" has no matchable characters.`, 400);
    requireValue(["word", "substring"].includes(entry.match),
      "invalid_blocklist", `Blocklist term "${entry.term}" needs match "word" or "substring".`, 400);
  }
  requireValue(list.review && typeof list.review === "object" && !Array.isArray(list.review),
    "invalid_blocklist", "The moderation blocklist needs a review block recording its provenance.", 400);
  requireValue(typeof list.review.placeholder === "boolean",
    "invalid_blocklist", "The blocklist review block must state whether it is still a placeholder.", 400);
  return list;
}

// Whether this list may be relied on at an event. Kept separate from validation
// so a placeholder still loads and the booth still runs, but staff are told
// plainly rather than discovering it from published attendee text.
export function blocklistStatus(list) {
  if (list.review.placeholder) {
    return { ready: false, reason: "The moderation blocklist is still the shipped placeholder and has not been reviewed." };
  }
  if (!list.entries.length) {
    return { ready: false, reason: "The moderation blocklist is empty." };
  }
  const { reviewedBy, reviewedAt } = list.review;
  if (typeof reviewedBy !== "string" || !reviewedBy.trim()) {
    return { ready: false, reason: "The moderation blocklist records no reviewer." };
  }
  if (typeof reviewedAt !== "string" || Number.isNaN(Date.parse(reviewedAt))) {
    return { ready: false, reason: "The moderation blocklist records no valid review date." };
  }
  return { ready: true, reason: null };
}

// Substring mode catches terms that are never innocent. Word mode exists so a
// term that is a fragment of ordinary words does not reject "Classic Mona".
export function findBlockedTerm(name, list) {
  if (!list?.entries?.length) return null;
  const joined = canonicalizeForMatch(name);
  const tokens = matchTokens(name);
  for (const entry of list.entries) {
    const term = canonicalizeForMatch(entry.term);
    if (entry.match === "substring" ? joined.includes(term) : matchesWholeWords(tokens, term)) return entry;
  }
  return null;
}

// Word mode must consume whole words, or "grind" would reject "Grinder". But a
// term is trivially evaded by spacing it out, which turns it into many
// one-letter tokens, so a run of consecutive tokens counts as one word when it
// joins to exactly the term. "g r i n d" is caught; "Grinder" is still not.
function matchesWholeWords(tokens, term) {
  for (let start = 0; start < tokens.length; start += 1) {
    let joined = "";
    for (let end = start; end < tokens.length; end += 1) {
      joined = collapse(joined + tokens[end]);
      if (joined === term) return true;
      if (joined.length > term.length) break;
    }
  }
  return false;
}

export async function loadBlocklist() {
  return validateBlocklist(JSON.parse(await readFile(new URL("../../../../booth/blocked-terms.json", import.meta.url), "utf8")));
}
