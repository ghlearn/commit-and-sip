import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { loadCatalog } from "../.github/extensions/commit-and-sip/domain.mjs";

const args = process.argv.slice(2);
if (args.length !== 6 || args[0] !== "--base" || args[2] !== "--head" || args[4] !== "--order" ||
  !/^[a-f0-9]{40}$/.test(args[1]) || !/^[a-f0-9]{40}$/.test(args[3])) {
  throw new Error("Usage: node scripts/grade-order.mjs --base FULL_SHA --head FULL_SHA --order DRINK_ID");
}
const [base, head, orderId] = [args[1], args[3], args[5]];
const { orders } = await loadCatalog();
const order = orders.find(order => order.id === orderId);
if (!order) throw new Error("Unknown drink order.");
const git = (...argv) => execFileSync("git", ["--no-pager", ...argv], { encoding: "utf8" });
const changes = git("diff", "--name-status", base, head).trim();
if (changes !== "M\tsrc/data/specials.json") throw new Error("Only the existing menu file may change.");
const before = JSON.parse(git("show", `${base}:src/data/specials.json`));
const after = JSON.parse(git("show", `${head}:src/data/specials.json`));
if (!Array.isArray(before) || !Array.isArray(after) ||
  before.some(item => item.id === order.id) || !isDeepStrictEqual(after, [...before, order])) {
  throw new Error("Preserve all existing items and their order, then append exactly the assigned drink.");
}
if (new Set(after.map(item => item.id)).size !== after.length) throw new Error("Drink IDs must be unique.");
for (const item of after) {
  if (!orders.some(candidate => isDeepStrictEqual(candidate, item))) throw new Error("Menu data must match the approved catalog schema and values.");
}
process.stdout.write(`Order correct: ${order.name}. GitHub review, trusted checks, and merge still require independent verification.\n`);
