import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { guardNodeVersion } from "./require-node.mjs";
import { loadCatalog, loadStaffConfig } from "../.github/extensions/commit-and-sip/domain.mjs";
import { leaderboardClientFromConfig } from "../.github/extensions/commit-and-sip/services/leaderboard-client.mjs";
import { dataDirectory, RunStore } from "../.github/extensions/commit-and-sip/store.mjs";
import { BoothEngine } from "../.github/extensions/commit-and-sip/booth-engine.mjs";
import { loadNameRules } from "../.github/extensions/commit-and-sip/services/coffee-name.mjs";

guardNodeVersion();

// Staff takedown. This is deliberately a script rather than a canvas action:
// the canvas runs on an unattended screen facing the queue, and a remove button
// there would let anyone delete a rival's entry.
//
// It writes through the same engine and the same ledger lock as the booth, so a
// removal during a live run cannot interleave with an attendee's submission.

export function parseArguments(argv) {
  const args = { by: null, id: null, list: false, reason: null, retry: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--list") { args.list = true; continue; }
    if (flag === "--retry") { args.retry = true; continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
    index += 1;
    if (flag === "--id") args.id = value;
    else if (flag === "--by") args.by = value;
    else if (flag === "--reason") args.reason = value;
    else throw new Error(`Unknown option ${flag}.`);
  }
  if (args.list || args.retry) return args;
  if (!args.id || !args.by || !args.reason) {
    throw new Error('Usage: npm run remove -- --list | --retry | --id <drink-id> --by "<name>" --reason "<why>"');
  }
  return args;
}

// Built from the same staff config as the booth, so a takedown here reaches
// the same public leaderboard the booth published to.
export async function openEngine(directory = dataDirectory(), config = null) {
  return new BoothEngine({
    store: new RunStore(directory), catalog: await loadCatalog(), rules: await loadNameRules(),
    leaderboardClient: leaderboardClientFromConfig(config ?? await loadStaffConfig()),
  });
}

export const PUBLIC_BOARD = {
  absent: "It was not on the public leaderboard.",
  failed: "It is NOT yet off the public leaderboard. Run npm run remove -- --retry once the network is back.",
  "not-configured": "This booth has no staff key for the public leaderboard. Remove it there separately.",
  retracted: "It was taken off the public leaderboard.",
};

// Staff need the ID, and nobody should be asked to guess it from a screen or
// hand-copy it from a ledger file.
export async function listDrinks(engine) {
  const { houseMenu } = await engine.house();
  return houseMenu.filter(drink => !drink.example);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Staff run this mid-event, often with a queue waiting. A stack trace is not
  // a useful answer to a mistyped ID, so report the message and nothing else.
  try {
    const args = parseArguments(process.argv.slice(2));
    const engine = await openEngine();
    if (args.retry) {
      const results = await engine.retryRetractions();
      process.stdout.write(results.length
        ? `${results.map(result => `${result.id}\t${PUBLIC_BOARD[result.published]}`).join("\n")}\n`
        : "No takedowns are waiting to reach the public leaderboard.\n");
      if (results.some(result => result.published === "failed")) process.exitCode = 1;
    } else if (args.list) {
      const drinks = await listDrinks(engine);
      process.stdout.write(drinks.length
        ? `${drinks.map(drink => `${drink.id}\t${drink.name}`).join("\n")}\n`
        : "No attendee drinks are on the house menu.\n");
    } else {
      const record = await engine.removeDrink({ id: args.id, removedBy: args.by, reason: args.reason });
      process.stdout.write(`Removed ${record.name} (${record.id}) entered by ${record.handle}.\n`
        + `Recorded by ${record.removedBy} at ${record.removedAt}: ${record.reason}\n`
        + "The name stays reserved and cannot be re-entered at this booth.\n"
        + `${PUBLIC_BOARD[record.published]}\n`);
      if (record.published === "failed") process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
