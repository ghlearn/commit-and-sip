import { requireValue } from "../domain.mjs";
import { validateCoffeeName } from "./coffee-name.mjs";

// The booth score is a pure function of the submitted name. It is deterministic
// so the same name always scores the same, a rank can be recomputed server-side
// from stored names, and staff can explain any score at the booth from the
// returned breakdown. No model call is involved; this is a rubric, not a judge.
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
  // The mascot word itself is required, so only echoes after it count.
  const echoes = tokens(name).slice(1).filter(token => token.startsWith(initial)).length;
  if (echoes >= 2) return 800;
  return echoes === 1 ? 450 : 0;
}

function craftPoints(name) {
  const found = new Set(tokens(name).filter(token => COFFEE_TERMS.includes(token)));
  if (found.size >= 2) return { points: 900, found: [...found] };
  return { points: found.size === 1 ? 600 : 0, found: [...found] };
}

function wordplayPoints(name, mascot) {
  const list = tokens(name);
  let points = 0;
  const signals = [];
  // A blend fuses the mascot into a longer word, such as "Monachino".
  if (list[0] !== mascot && list[0]?.startsWith(mascot)) {
    points += 450;
    signals.push("blend");
  }
  // Internal rhyme: two words sharing a three-letter ending.
  const endings = list.filter(token => token.length >= 3).map(token => token.slice(-3));
  if (new Set(endings).size < endings.length) {
    points += 450;
    signals.push("rhyme");
  }
  return { points: Math.min(points, 900), signals };
}

// Two to four words is the house shape. This band is deliberately flat so a
// richer name is not penalised for having room to be inventive.
function economyPoints(name) {
  const count = words(name).length;
  if (count >= 2 && count <= 4) return 600;
  if (count === 5) return 350;
  return count === 1 ? 250 : 150;
}

function rarityPoints(name, mascot) {
  const inventive = new Set(tokens(name).filter(token =>
    !token.startsWith(mascot) && !COFFEE_TERMS.includes(token) && !COMMON_WORDS.includes(token)));
  return { points: Math.min(inventive.size, 3) * 400, inventive: [...inventive] };
}

export function scoreCoffeeName(raw, rules) {
  const { name, id, mascot } = validateCoffeeName(raw, rules);
  requireValue(!EXAMPLE_IDS.includes(id), "example_name",
    "That is one of the house examples. Invent your own drink to be scored.", 400);

  const craft = craftPoints(name);
  const play = wordplayPoints(name, mascot);
  const rarity = rarityPoints(name, mascot);
  const breakdown = [
    { label: "Valid house name", max: 600, points: 600 },
    { label: "Alliteration", max: 800, points: alliterationPoints(name, mascot) },
    { label: "Coffee craft", max: 900, points: craft.points, detail: craft.found },
    { label: "Wordplay", max: 900, points: play.points, detail: play.signals },
    { label: "House shape", max: 600, points: economyPoints(name) },
    { label: "Invention", max: 1200, points: rarity.points, detail: rarity.inventive },
  ];
  const total = breakdown.reduce((sum, part) => sum + part.points, 0);
  // Clamped so a rubric change can never emit an out-of-range competition score.
  const score = Math.min(Math.max(total, 1), MAX_SCORE);
  return { breakdown, id, mascot, name, score };
}
