import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { guardNodeVersion } from "./require-node.mjs";
import { openEngine } from "./remove-drink.mjs";
import { retractionCause } from "../.github/extensions/commit-and-sip/services/leaderboard.mjs";

guardNodeVersion();

// Rebuilds this booth's part of the public leaderboard: replays every
// takedown, so removed names are reserved again, then sends every drink on the
// menu. If any takedown is not reserved, no drink is sent.
//
// Use it after the service's data is lost or EVENT_ID changes, or when this
// booth served drinks before it was configured to publish. The booth is the
// authoritative copy; the board is a projection of every booth's menu, so run
// it on each booth machine. Drinks staff removed are never sent.
//
// With more than one booth the rebuild has two phases across the event, and
// the phase is always named: --takedowns on every booth, then --drinks on
// every booth, so no booth's drinks reach the new board before another booth
// has reserved the names it took down. --all runs both here, for a single
// booth, or once every other booth has finished --takedowns.

export const USAGE = "Usage: npm run leaderboard:republish -- --takedowns | --open | --drinks | --all\n"
  + "  --takedowns  replay this booth's takedowns. With several booths, run this on every booth first.\n"
  + "  --open       open a rebuilt (or new) board to drinks, once every booth has run --takedowns. Any one staff machine.\n"
  + "  --drinks     then send this booth's drinks.\n"
  + "  --all        takedowns, open, then drinks, all here: only for a single-booth event, or a booth that publishes drinks served before it was configured.";

export function parsePhase(argv) {
  const phases = { "--all": { drinks: true, open: true, takedowns: true }, "--drinks": { drinks: true, takedowns: false },
    "--open": { open: true }, "--takedowns": { drinks: false, takedowns: true } };
  if (argv.length !== 1 || !Object.hasOwn(phases, argv[0])) throw new Error(USAGE);
  return phases[argv[0]];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const phase = parsePhase(process.argv.slice(2));
    const engine = await openEngine();
    if (!engine.leaderboardClient) {
      throw new Error("This booth has no leaderboardApi in booth/local-config.json, so there is nowhere to publish.");
    }
    if (phase.open) {
      if (!engine.leaderboardClient.openBoard) {
        throw new Error("Opening the board needs the staff key. Copy the deployed keys to this machine with "
          + "npm run leaderboard:configure -- --url <url> --from <an owner-only (chmod 600) copy of a staff machine's "
          + "booth/local-config.json>, then delete that copy and run this again.");
      }
      await engine.leaderboardClient.openBoard();
      process.stdout.write("The board is open to drinks. Now run npm run leaderboard:republish -- --drinks on each booth; "
        + "drinks waiting on the booths are sent by their own retries too.\n");
      process.exit(0);
    }
    const { blocked, drinks, reason, removals } = await engine.republishAll(phase);
    const unsettled = removals.filter(removal => !["retracted", "absent"].includes(removal.published));
    for (const removal of unsettled) {
      process.stdout.write(`FAILED\t${removal.id}\ttakedown not replayed (${removal.published === "failed" ? retractionCause(removal.failure) : removal.published})\n`);
    }
    process.stdout.write(removals.length
      ? `${removals.length - unsettled.length} of ${removals.length} takedowns are reserved on the public leaderboard.\n`
      : "This booth has no takedowns to replay.\n");
    if (unsettled.some(removal => removal.published === "not-configured")) {
      // The removals are recorded only in this booth's ledger, so no other
      // machine can replay them.
      process.stdout.write("This booth has no staff key, so removed names are NOT reserved. "
        + "To fix it, copy the deployed keys to this machine with npm run leaderboard:configure -- --url <url> --from <an owner-only (chmod 600) copy of a staff machine's booth/local-config.json>, then delete that copy, then run this again here.\n");
    }
    if (blocked) {
      // Sending drinks while a removed name is unreserved would let the
      // replacement board accept it, so the rebuild stopped before any drink.
      process.stdout.write(reason === "takedowns_not_replayed"
        ? "No drinks were sent: this booth has not replayed its takedowns for this rebuild. Run --takedowns here (and on every other booth) first.\n"
        : reason === "cannot_open"
          ? "No drinks were sent: opening the board needs the staff key on this machine.\n"
          : "No drinks were sent. Every takedown must be reserved first; fix the failures above and run this again.\n");
    } else if (!phase.drinks) {
      process.stdout.write("Takedowns done. When every booth has run --takedowns, run npm run leaderboard:republish -- --drinks on each booth.\n");
    } else {
      // "rejected" drinks were refused for good (the name was taken or taken
      // down) and are deliberately not resent: they are reported, not failures.
      const label = { confirmed: "ok    ", rejected: "held  " };
      for (const result of drinks) {
        process.stdout.write(`${label[result.state] ?? "FAILED"}\t${result.name}`
          + `${result.state === "confirmed" ? "" : `\t${result.state === "rejected" ? "refused earlier; not resent" : result.reason ?? ""}`}\n`);
      }
      const held = drinks.filter(result => result.state === "rejected").length;
      const failed = drinks.filter(result => !["confirmed", "rejected"].includes(result.state)).length;
      process.stdout.write(drinks.length
        ? `${drinks.length - failed - held} of ${drinks.length} drinks are on the public leaderboard`
          + `${held ? `; ${held} held back because the service refused them earlier` : ""}.\n`
        : "This booth has no attendee drinks to publish.\n");
      if (failed) process.exitCode = 1;
    }
    if (blocked || unsettled.length) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
