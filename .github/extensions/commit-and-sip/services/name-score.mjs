import { requireValue } from "../domain.mjs";
import { validateCoffeeName } from "./coffee-name.mjs";

// The booth score is a pure function of the submitted name. It is deterministic
// so the same name always scores the same, a rank can be recomputed server-side
// from stored names, and staff can explain any score at the booth from the
// returned breakdown. No model call is involved; this is a rubric, not a judge.
//
// Every category maximum can be earned by one valid name at the same time
// (a test proves it), so 5,000 is a real ceiling, not a sum on paper. Letter
// value pays in single points, so scores are not stuck on steps of 50 and two
// different names rarely land on the same total. Rarely is not never: a
// finite range cannot give every name its own score, so the leaderboard and a
// standalone booth refuse a drink whose score another drink already holds.
export const MAX_SCORE = 5000;

// The seeded house drinks are worked examples shown to attendees. They are never
// scored or ranked, so nobody competes against the demo entries.
export const EXAMPLE_IDS = ["mona-latte", "copilot-cortado", "ducky-cold-brew"];

const COFFEE_TERMS = [
  "affogato", "americano", "barista", "bean", "blend", "brew", "cappuccino", "chai",
  "cold", "cortado", "crema", "cup", "doppio", "drip", "espresso", "flat", "foam",
  "french", "frappe", "grind", "latte", "macchiato", "mocha", "moka", "pour", "press",
  "roast", "ristretto", "shot", "steam", "sip", "white"
];

// Common filler that should not read as an inventive addition.
const COMMON_WORDS = [
  "a", "and", "big", "black", "blue", "cool", "cute", "fast", "good", "great", "hot",
  "iced", "little", "my", "new", "nice", "of", "old", "one", "our", "smooth", "super",
  "sweet", "the", "to", "top", "warm", "with"
];

function words(name) {
  return name.toLowerCase().split(" ").filter(Boolean);
}

function tokens(name) {
  return words(name).map(word => word.replace(/[^a-z0-9]/g, "")).filter(Boolean);
}

function alliterationPoints(name, mascot) {
  const initial = mascot[0];
  // The mascot is required wherever it sits, so only the other words count as
  // echoes of it.
  const echoes = tokens(name).filter(token => !token.includes(mascot) && token.startsWith(initial)).length;
  if (echoes >= 2) return 800;
  return echoes === 1 ? 450 : 0;
}

function craftPoints(name) {
  const found = new Set(tokens(name).filter(token => COFFEE_TERMS.includes(token)));
  if (found.size >= 2) return { points: 800, found: [...found] };
  return { points: found.size === 1 ? 500 : 0, found: [...found] };
}

function wordplayPoints(name, mascot) {
  const list = tokens(name);
  let points = 0;
  const signals = [];
  // A blend fuses the mascot into a longer word, such as "Monachino", wherever
  // that word sits in the name.
  if (list.some(token => token !== mascot && token.includes(mascot))) {
    points += 400;
    signals.push("blend");
  }
  // Internal rhyme: two words sharing a three-letter ending.
  const endings = list.filter(token => token.length >= 3).map(token => token.slice(-3));
  if (new Set(endings).size < endings.length) {
    points += 400;
    signals.push("rhyme");
  }
  return { points: Math.min(points, 800), signals };
}

// Two to five words is the house shape. This band is deliberately flat, and
// wide enough to hold a mascot, two coffee terms and two invented words, so a
// richer name is not penalised for having room to be inventive.
function economyPoints(name) {
  const count = words(name).length;
  if (count >= 2 && count <= 5) return 500;
  if (count === 6) return 300;
  return count === 1 ? 200 : 100;
}

// Same unbroken-text rule validateCoffeeName uses, so crew credit never exceeds
// the mascots validation recognises. Punctuation is deliberately not stripped
// here: "Co-pilot" is not Copilot, while a blend such as "Monachino" still counts.
function mascotsIn(name, mascots) {
  const lower = name.toLowerCase();
  return mascots.filter(mascot => lower.includes(mascot));
}

// Bringing more than one mascot to the party is rewarded deliberately here,
// rather than by accident through Invention.
function crewPoints(crew) {
  if (crew.length >= 3) return 600;
  return crew.length === 2 ? 300 : 0;
}

function rarityPoints(name, mascots) {
  const inventive = new Set(tokens(name).filter(token =>
    !mascots.some(mascot => token.includes(mascot))
    && !COFFEE_TERMS.includes(token) && !COMMON_WORDS.includes(token)));
  return { points: Math.min(inventive.size, 2) * 250, inventive: [...inventive] };
}

// Each letter is worth its place in the alphabet (A=1 ... Z=26), capped. The
// only category that pays in single points, so it is what keeps two different
// names off the same total. Digits, spaces and punctuation are worth nothing.
const LETTER_VALUE_MAX = 400;
function letterPoints(name) {
  const total = [...name.toLowerCase()].reduce((sum, char) =>
    sum + (char >= "a" && char <= "z" ? char.charCodeAt(0) - 96 : 0), 0);
  return Math.min(total, LETTER_VALUE_MAX);
}

export function scoreCoffeeName(raw, rules) {
  const { name, id, mascot, placement } = validateCoffeeName(raw, rules);
  requireValue(!EXAMPLE_IDS.includes(id), "example_name",
    "That is one of the house examples. Invent your own drink to be scored.", 400);

  const craft = craftPoints(name);
  const play = wordplayPoints(name, mascot);
  const crew = mascotsIn(name, rules.mascots);
  const rarity = rarityPoints(name, rules.mascots);
  const breakdown = [
    { label: "Valid house name", max: 600, points: 600 },
    { label: "Alliteration", max: 800, points: alliterationPoints(name, mascot) },
    { label: "Coffee craft", max: 800, points: craft.points, detail: craft.found },
    { label: "Wordplay", max: 800, points: play.points, detail: play.signals },
    { label: "House shape", max: 500, points: economyPoints(name) },
    { label: "Mascot crew", max: 600, points: crewPoints(crew), detail: crew },
    { label: "Invention", max: 500, points: rarity.points, detail: rarity.inventive },
    { label: "Letter value", max: LETTER_VALUE_MAX, points: letterPoints(name) },
  ];
  const total = breakdown.reduce((sum, part) => sum + part.points, 0);
  // Clamped so a rubric change can never emit an out-of-range competition score.
  const score = Math.min(Math.max(total, 1), MAX_SCORE);
  // Placement is reported, never scored: no position is worth more than another,
  // so the attendee's choice of where to put the mascot stays a free one.
  return { breakdown, id, mascot, name, placement, score };
}
