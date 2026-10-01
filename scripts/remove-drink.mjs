import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { guardNodeVersion } from "./require-node.mjs";
import { loadCatalog, loadStaffConfig } from "../.github/extensions/commit-and-sip/domain.mjs";
import { leaderboardClientFromConfig } from "../.github/extensions/commit-and-sip/services/leaderboard-client.mjs";
import { retractionCause } from "../.github/extensions/commit-and-sip/services/leaderboard.mjs";
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

const USAGE = 'Usage: npm run remove -- --list | --retry | --id <drink-id> --by "<name>" --reason "<why>"';

// The three modes are alternatives. A takedown typed alongside --list or
// --retry, or a flag given twice, is refused rather than quietly ignored: a
// moderation command that silently did something else is worse than none.
export function parseArguments(argv) {
  const args = { by: null, id: null, list: false, reason: null, retry: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error(`${flag} was given twice. ${USAGE}`);
    seen.add(flag);
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
  const removal = args.id !== null || args.by !== null || args.reason !== null;
  if ([args.list, args.retry, removal].filter(Boolean).length > 1) {
    throw new Error(`Choose one of --list, --retry, or a removal (--id, --by, --reason). ${USAGE}`);
  }
  if (args.list || args.retry) return args;
  if (!args.id || !args.by || !args.reason) {
    throw new Error(USAGE);
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

// What `--retry` tells staff. "Nothing waiting" is said only when it is true:
// a booth that cannot retract still has to own up to takedowns it owes.
export async function retryReport(engine) {
  const owed = await engine.owedPublicTakedowns();
  if (!engine.leaderboardClient?.retract) {
    if (!owed.length) return { exitCode: 0, text: "No takedowns are waiting to reach the public leaderboard.\n" };
    return {
      exitCode: 1,
      text: `${owed.map(record => `${record.id}\tNOT off the public leaderboard`).join("\n")}\n`
        + `${owed.length} takedown${owed.length === 1 ? "" : "s"} could not reach the public leaderboard because this booth has no staff key. `
        + `Only this machine holds ${owed.length === 1 ? "that removal" : "those removals"}: copy the deployed keys to this machine with npm run leaderboard:configure -- --url <url> --from <an owner-only (chmod 600) copy of a staff machine's booth/local-config.json>, then delete that copy, then retry.\n`,
    };
  }
  const results = await engine.retryRetractions();
  return {
    exitCode: results.some(result => !["retracted", "absent"].includes(result.published)) ? 1 : 0,
    text: results.length
      ? `${results.map(result => `${result.id}\t${publicBoardText(result.published, result.failure)}`).join("\n")}\n`
      : "No takedowns are waiting to reach the public leaderboard.\n",
  };
}

export const PUBLIC_BOARD = {
  absent: "It was not on the public leaderboard.",
  failed: "It is NOT yet off the public leaderboard. Run npm run remove -- --retry once the network is back.",
  "not-configured": "This booth has no staff key, so it is NOT off the public leaderboard. To finish it, copy the deployed keys to this machine with npm run leaderboard:configure -- --url <url> --from <an owner-only (chmod 600) copy of a staff machine's booth/local-config.json>, then delete that copy, then retry.",
  replaying: "It may not be reserved on the rebuilt public leaderboard: the rebuild stopped before replaying this takedown. Run npm run remove -- --retry.",
  "in-doubt": "It may still be on the public leaderboard: it was still being published when it was taken down. Run npm run remove -- --retry.",
  retracted: "It was taken off the public leaderboard.",
};

// Every outcome gets words. One this table does not know is reported as
// unresolved, never printed as "undefined".
export function publicBoardText(published, failure = null) {
  if (published === "failed") {
    return `It is NOT yet off the public leaderboard: ${retractionCause(failure)}. Run npm run remove -- --retry once that is fixed.`;
  }
  return Object.hasOwn(PUBLIC_BOARD, published) ? PUBLIC_BOARD[published]
    : "It may still be on the public leaderboard: the outcome was not recorded. Run npm run remove -- --retry.";
}

// What a removal prints. A settled outcome is always reported. An unsettled
// one is a warning only when the drink may be public (`owed`, decided by the
// engine); a booth that never published has nothing to take down, and saying
// it is "NOT off" the board would be a false alarm. Any takedown that may
// still be public is unfinished, so the command fails.
export function removalReport(record) {
  const settled = ["retracted", "absent"].includes(record.published);
  const board = settled || record.owed ? publicBoardText(record.published, record.failure)
    : "It was never on the public leaderboard from this booth, so nothing is owed there.";
  return {
    exitCode: record.owed ? 1 : 0,
    text: `Removed ${record.name} (${record.id}) entered by ${record.handle}.\n`
      + `Recorded by ${record.removedBy} at ${record.removedAt}: ${record.reason}\n`
      + "The name stays reserved and cannot be re-entered at this booth.\n"
      + `${board}\n`,
  };
}

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
      const report = await retryReport(engine);
      process.stdout.write(report.text);
      process.exitCode = report.exitCode;
    } else if (args.list) {
      const drinks = await listDrinks(engine);
      process.stdout.write(drinks.length
        ? `${drinks.map(drink => `${drink.id}\t${drink.name}`).join("\n")}\n`
        : "No attendee drinks are on the house menu.\n");
    } else {
      const report = removalReport(await engine.removeDrink({ id: args.id, removedBy: args.by, reason: args.reason }));
      process.stdout.write(report.text);
      process.exitCode = report.exitCode;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
