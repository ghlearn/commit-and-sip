import { requireValue } from "../domain.mjs";
import { buildAttendeeOrder, coffeeNameId, normalizeCoffeeName, PLACEMENT_LABELS, PLACEMENTS } from "./coffee-name.mjs";
import { EXAMPLE_IDS, scoreCoffeeName } from "./name-score.mjs";

// The house menu is the shared artefact of the booth: seeded examples plus every
// drink attendees invent. Uniqueness is enforced on the canonical menu ID, so
// "Mona Mocha", "mona mocha" and "  Mona   Mocha " are the same drink.
//
// This module is authoritative for one booth's own menu. A single booth cannot
// know what was invented at another booth, so cross-booth uniqueness belongs to
// the leaderboard service: callers may merge remotely known IDs into `menu`
// before calling addDrink, and the duplicate check then covers both.

export function seedMenu(catalog) {
  return catalog.orders
    .filter(order => EXAMPLE_IDS.includes(order.id))
    .map(order => ({ ...order, example: true }));
}

export function findDrink(menu, id) {
  return menu.find(entry => entry.id === id) ?? null;
}

export function addDrink(menu, { rawName, rules, runId, handle, choice = {}, now = new Date().toISOString() }) {
  requireValue(Array.isArray(menu), "menu_invalid", "The house menu is unavailable. Ask booth staff to restore it.");
  requireValue(typeof runId === "string" && runId.length > 0, "invalid_run", "A run ID is required to add a drink.", 400);
  requireValue(typeof handle === "string" && handle.length > 0, "invalid_handle", "A barista handle is required to add a drink.", 400);
  requireValue(choice.mascot === undefined || rules.mascots.includes(choice.mascot),
    "invalid_choice", "Pick one of the booth mascots.", 400);
  requireValue(choice.placement === undefined || PLACEMENTS.includes(choice.placement),
    "invalid_choice", `Pick a placement: ${PLACEMENTS.join(", ")}.`, 400);

  // Check for a duplicate before scoring so an attendee who retypes an existing
  // drink is told plainly, rather than being scored and then refused.
  const id = coffeeNameId(normalizeCoffeeName(rawName).toLowerCase());
  const clash = findDrink(menu, id);
  requireValue(!clash, "duplicate_drink",
    clash?.example
      ? `${clash.name} is already one of our house examples. Invent a different drink.`
      : `${clash?.name} is already on the menu. Invent a different drink.`,
    409);

  const { name, mascot, placement, score, breakdown } = scoreCoffeeName(rawName, rules);
  // The canvas lets the attendee choose a mascot and where it sits. Honour that
  // choice by checking the typed name against it instead of quietly overriding.
  requireValue(choice.mascot === undefined || choice.mascot === mascot, "mascot_mismatch",
    `You chose ${choice.mascot}, but ${name} uses ${mascot}. Change the name or the mascot.`, 400);
  requireValue(choice.placement === undefined || choice.placement === placement, "placement_mismatch",
    `You chose ${mascot} ${PLACEMENT_LABELS[choice.placement]}, but ${name} has it ${PLACEMENT_LABELS[placement]}.`, 400);

  const drink = buildAttendeeOrder(rawName, rules, runId);
  const entry = { ...drink, breakdown, createdAt: now, example: false, handle, mascot, placement, runId, score };
  requireValue(entry.id === id, "menu_invalid", "The drink ID changed between checks. Try the name again.");
  menu.push(entry);
  return entry;
}

// Equal scores share a rank, matching the completion authority's convention.
export function leaderboard(menu) {
  const scored = menu.filter(entry => !entry.example && Number.isFinite(entry.score));
  return scored
    .map(entry => ({
      handle: entry.handle,
      name: entry.name,
      rank: 1 + scored.filter(other => other.score > entry.score).length,
      score: entry.score,
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export function standingFor(menu, runId) {
  const entry = menu.find(item => !item.example && item.runId === runId);
  if (!entry) return null;
  const board = leaderboard(menu);
  const place = board.find(row => row.handle === entry.handle && row.name === entry.name) ?? null;
  return place && { ...place, entries: board.length };
}
