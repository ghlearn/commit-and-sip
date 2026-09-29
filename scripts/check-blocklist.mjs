import { readFile } from "node:fs/promises";
import { guardNodeVersion } from "./require-node.mjs";
import {
  blocklistStatus, canonicalizeForMatch, findBlockedTerm, loadBlocklist
} from "../.github/extensions/commit-and-sip/services/moderation.mjs";

guardNodeVersion();

// A review aid for whoever owns booth/blocked-terms.json. It supplies no terms:
// choosing them is the reviewable act. What it does is show the reviewer the
// two things they cannot see by reading their own list.
//
// First, what each term actually becomes. Matching folds digits to letters,
// strips separators, and collapses repeated characters, so the string in the
// file is not the string that is compared. A doubled term is the trap: "88"
// and "bb" both reduce to "b", and as a substring that refuses every name
// containing the letter b.
//
// Second, what the list refuses that it should not. A false positive here is a
// person being turned down in front of a queue, which is worse than the miss
// the list was added to prevent, because it happens to someone innocent and it
// happens in public.

// Ordinary café vocabulary. Deliberately dull: it is a tripwire for
// over-broad entries, not a test of anything clever.
const VOCABULARY = [
  "latte", "mocha", "cortado", "cold brew", "espresso", "americano", "flat white",
  "cappuccino", "macchiato", "affogato", "chai", "hazelnut", "caramel", "vanilla",
  "classic", "house", "iced", "double", "single", "grinder", "roast", "blend",
  "morning", "midnight", "sunrise", "velvet", "smooth", "bold", "dark", "light"
];

function corpus(mascots, houseNames) {
  const names = new Set(houseNames);
  for (const mascot of mascots) {
    const cap = mascot[0].toUpperCase() + mascot.slice(1);
    for (const word of VOCABULARY) {
      names.add(`${cap} ${word}`);
      names.add(`${word} ${cap}`);
      names.add(`Classic ${cap} ${word}`);
    }
  }
  return [...names];
}

export function inspectEntries(entries) {
  const findings = [];
  const seen = new Map();
  for (const entry of entries) {
    const canonical = canonicalizeForMatch(entry.term);
    // One character as a substring matches almost every name there is.
    if (entry.match === "substring" && canonical.length === 1) {
      findings.push({ level: "error", term: entry.term, message:
        `folds to "${canonical}", a single character. As a substring this refuses any name containing that character. `
        + `Doubled terms collapse: "88" and "bb" both become "b".` });
    } else if (entry.match === "substring" && canonical.length === 2) {
      findings.push({ level: "warn", term: entry.term, message:
        `folds to "${canonical}", only two characters. Check it against ordinary words before keeping substring mode.` });
    }
    if (/[0-9]/.test(entry.term)) {
      findings.push({ level: "warn", term: entry.term, message:
        `contains digits and is compared as "${canonical}". Digits 2, 6 and 9 are not folded, so a numeric code may not `
        + `reduce to the letters you expect. Record the form you mean.` });
    }
    if (seen.has(canonical)) {
      findings.push({ level: "warn", term: entry.term, message:
        `folds to "${canonical}", the same as "${seen.get(canonical)}". One of them is redundant.` });
    } else {
      seen.set(canonical, entry.term);
    }
  }
  return findings;
}

export function falsePositives(names, list, houseNames) {
  const hits = [];
  for (const name of names) {
    const entry = findBlockedTerm(name, list);
    if (entry) hits.push({ name, term: entry.term, match: entry.match, house: houseNames.includes(name) });
  }
  return hits;
}

async function main() {
  const list = await loadBlocklist();
  const rules = JSON.parse(await readFile(new URL("../booth/name-rules.json", import.meta.url), "utf8"));
  const houseNames = JSON.parse(await readFile(new URL("../booth/orders.json", import.meta.url), "utf8")).map(order => order.name);

  const status = blocklistStatus(list);
  console.log(`Blocklist: ${list.entries.length} entr${list.entries.length === 1 ? "y" : "ies"}`);
  console.log(status.ready
    ? `Readiness: ready. Reviewed by ${list.review.reviewedBy} on ${list.review.reviewedAt}.`
    : `Readiness: NOT READY. ${status.reason}`);

  console.log("\nHow each term is actually compared:");
  for (const entry of list.entries) {
    console.log(`  ${entry.match.padEnd(9)} ${JSON.stringify(entry.term)} -> ${JSON.stringify(canonicalizeForMatch(entry.term))}`);
  }

  const findings = inspectEntries(list.entries);
  if (findings.length) {
    console.log("\nEntry warnings:");
    for (const finding of findings) console.log(`  [${finding.level.toUpperCase()}] ${JSON.stringify(finding.term)} ${finding.message}`);
  } else {
    console.log("\nEntry warnings: none.");
  }

  const names = corpus(rules.mascots, houseNames);
  const hits = falsePositives(names, list, houseNames);
  console.log(`\nFalse-positive sweep over ${names.length} ordinary names:`);
  if (!hits.length) {
    console.log("  none refused.");
  } else {
    for (const hit of hits.slice(0, 40)) {
      console.log(`  ${hit.house ? "HOUSE DRINK " : ""}${JSON.stringify(hit.name)} refused by ${JSON.stringify(hit.term)} (${hit.match})`);
    }
    if (hits.length > 40) console.log(`  ...and ${hits.length - 40} more.`);
  }

  // A list that refuses one of the booth's own seeded drinks is wrong in a way
  // no judgement call is needed to settle, so it is the one hard failure here.
  const houseHits = hits.filter(hit => hit.house);
  const errors = findings.filter(finding => finding.level === "error");
  if (houseHits.length) console.log(`\nFAIL: ${houseHits.length} house drink name(s) would be refused.`);
  if (errors.length) console.log(`FAIL: ${errors.length} entr${errors.length === 1 ? "y folds" : "ies fold"} to a single character.`);
  if (houseHits.length || errors.length) {
    console.log("This list is not safe to run a booth with. Reclassify or remove the entries above.");
    process.exitCode = 1;
    return;
  }
  console.log("\nNo blocking problems found. This checks breadth, not adequacy:");
  console.log("nothing here can tell you whether the list covers what it should.");
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
