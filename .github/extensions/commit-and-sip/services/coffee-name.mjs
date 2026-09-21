import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DomainError, requireValue } from "../domain.mjs";

// Attendee text reaches GitHub issue bodies, pull-request titles, and menu data.
// These rules reject injection and spoofing structurally; blockedTerms is a
// separate staff-supplied moderation list and is not a substitute for review.
const ALLOWED = /^[A-Za-z0-9 '-]+$/;
const OPENING = /^[A-Za-z0-9]/;
const CLOSING = /[A-Za-z0-9]$/;
const FORBIDDEN_SUBSTRINGS = ["http", "www.", ".com", ".net", ".org", "@", "#", "--"];

export async function loadNameRules() {
  return validateNameRules(JSON.parse(await readFile(new URL("../../../../booth/name-rules.json", import.meta.url), "utf8")));
}

export function validateNameRules(rules) {
  const positiveInt = value => Number.isSafeInteger(value) && value > 0;
  requireValue(rules && typeof rules === "object" && !Array.isArray(rules), "invalid_name_rules", "Booth name rules must be an object.", 400);
  requireValue(positiveInt(rules.minLength) && positiveInt(rules.maxLength) && rules.minLength <= rules.maxLength,
    "invalid_name_rules", "Booth name rules need a valid length range.", 400);
  requireValue(Array.isArray(rules.mascots) && rules.mascots.length > 0 &&
    rules.mascots.every(token => typeof token === "string" && /^[a-z]{2,20}$/.test(token)) &&
    new Set(rules.mascots).size === rules.mascots.length,
  "invalid_name_rules", "Booth name rules need unique lowercase mascot tokens.", 400);
  requireValue(rules.artworkByMascot && typeof rules.artworkByMascot === "object" &&
    rules.mascots.every(token => ["original-latte-cup", "original-cortado-cup", "original-cold-brew-glass"].includes(rules.artworkByMascot[token])),
  "invalid_name_rules", "Every mascot needs approved artwork.", 400);
  requireValue(Array.isArray(rules.prices) && rules.prices.length > 0 &&
    rules.prices.every(price => Number.isFinite(price) && price > 0 && price <= 1000 && Math.round(price * 100) === price * 100),
  "invalid_name_rules", "Booth prices must be positive amounts with at most two decimals.", 400);
  requireValue(Array.isArray(rules.servings) && rules.servings.length > 0 &&
    rules.servings.every(serving => ["hot", "cold"].includes(serving)) && new Set(rules.servings).size === rules.servings.length,
  "invalid_name_rules", "Booth servings must be unique hot/cold values.", 400);
  requireValue(rules.proposal && typeof rules.proposal === "object" &&
    Number.isFinite(rules.proposal.flawRate) && rules.proposal.flawRate >= 0 && rules.proposal.flawRate <= 1 &&
    Array.isArray(rules.proposal.flawFields) && rules.proposal.flawFields.length > 0 &&
    rules.proposal.flawFields.every(field => ["price", "serving"].includes(field)) &&
    new Set(rules.proposal.flawFields).size === rules.proposal.flawFields.length,
  "invalid_name_rules", "Proposal flaw settings must use a 0-1 rate and unique supported fields.", 400);
  requireValue(Array.isArray(rules.blockedTerms) &&
    rules.blockedTerms.every(term => typeof term === "string" && term.trim().length > 0 && term === term.toLowerCase()),
  "invalid_name_rules", "Blocked terms must be nonempty lowercase strings.", 400);
  return rules;
}

export function normalizeCoffeeName(raw) {
  requireValue(typeof raw === "string", "invalid_name", "Enter a coffee name.", 400);
  // Normalize before validating so width/accent tricks cannot smuggle a blocked term.
  return raw.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function coffeeNameId(name) {
  return name.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function validateCoffeeName(raw, rules) {
  validateNameRules(rules);
  const name = normalizeCoffeeName(raw);
  const reject = message => { throw new DomainError("invalid_name", message, 400); };
  if (name.length < rules.minLength || name.length > rules.maxLength) {
    reject(`Use ${rules.minLength} to ${rules.maxLength} characters.`);
  }
  if (!ALLOWED.test(name)) reject("Use only letters, numbers, spaces, hyphens, and apostrophes.");
  if (!OPENING.test(name) || !CLOSING.test(name)) reject("Start and end the name with a letter or number.");
  const lower = name.toLowerCase();
  for (const fragment of FORBIDDEN_SUBSTRINGS) {
    if (lower.includes(fragment)) reject("Remove links, mentions, and repeated punctuation from the name.");
  }
  const mascot = rules.mascots.find(token => lower.includes(token));
  if (!mascot) reject(`Include ${rules.mascots.join(", ")} in the name.`);
  for (const term of rules.blockedTerms) {
    if (lower.includes(term)) reject("That name is not available. Try another.");
  }
  const id = coffeeNameId(name);
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) reject("That name cannot become a menu ID. Try another.");
  return { name, id, mascot };
}

function digest(...parts) {
  return createHash("sha256").update(parts.join("\u0000")).digest();
}

function pick(list, bytes, offset) {
  return list[bytes.readUInt32BE(offset) % list.length];
}

export function buildAttendeeOrder(raw, rules, runId) {
  requireValue(typeof runId === "string" && runId.length > 0, "invalid_run", "A run ID is required to build an order.", 400);
  const { name, id, mascot } = validateCoffeeName(raw, rules);
  const bytes = digest("order", runId, id);
  return {
    artwork: rules.artworkByMascot[mascot],
    description: `A ${mascot}-inspired pour invented at the Level Up Lounge.`,
    id,
    name,
    price: pick(rules.prices, bytes, 0),
    serving: pick(rules.servings, bytes, 4),
  };
}

function formatPrice(price) {
  return `$${price.toFixed(2)}`;
}

// The booth bot always commits the ordered drink unchanged, so the diff is
// truthful and the append-only menu gate still passes. On a seeded run the
// pull-request description misstates exactly one field, and the attendee is
// expected to trust the diff over the prose during review.
export function proposePullRequestCopy(order, rules, runId) {
  validateNameRules(rules);
  requireValue(typeof runId === "string" && runId.length > 0, "invalid_run", "A run ID is required to propose pull-request copy.", 400);
  const { flawRate, flawFields } = rules.proposal;
  const bytes = digest("proposal", runId, order.id);
  const claim = { price: order.price, serving: order.serving };
  let flaw = null;
  if (bytes.readUInt32BE(0) / 0x100000000 < flawRate) {
    const field = pick(flawFields, bytes, 4);
    if (field === "serving") {
      claim.serving = order.serving === "hot" ? "cold" : "hot";
    } else {
      const alternatives = rules.prices.filter(price => price !== order.price);
      requireValue(alternatives.length > 0, "invalid_name_rules", "Price flaws need at least two configured prices.", 400);
      claim.price = pick(alternatives, bytes, 8);
    }
    flaw = { field, actual: order[field], claimed: claim[field] };
  }
  return {
    claim,
    flaw,
    body: [
      `Adds **${order.name}** to the Level Up Lounge menu.`,
      "",
      `- Price: ${formatPrice(claim.price)}`,
      `- Serving: ${claim.serving}`,
      `- Artwork: ${order.artwork}`,
      "",
      "Review the diff against the order card before approving.",
    ].join("\n"),
    entry: { ...order },
    title: `Add ${order.name} to the menu`,
  };
}
