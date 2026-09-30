import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { guardNodeVersion } from "./require-node.mjs";
import { openEngine } from "./remove-drink.mjs";

guardNodeVersion();

// Rebuilds this booth's part of the public leaderboard: replays every
// takedown, so removed names are reserved again, then sends every drink on the
// menu.
//
// Use it after the service's data is lost or EVENT_ID changes, or when this
// booth served drinks before it was configured to publish. The booth is the
// authoritative copy; the board is a projection of every booth's menu, so run
// it on each booth machine. Drinks staff removed are never sent.

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const engine = await openEngine();
    if (!engine.leaderboardClient) {
      throw new Error("This booth has no leaderboardApi in booth/local-config.json, so there is nowhere to publish.");
    }
    const { drinks, removals } = await engine.republishAll();
    const unsettled = removals.filter(removal => !["retracted", "absent"].includes(removal.published));
    for (const removal of unsettled) {
      process.stdout.write(`FAILED\t${removal.id}\ttakedown not replayed (${removal.published})\n`);
    }
    process.stdout.write(removals.length
      ? `${removals.length - unsettled.length} of ${removals.length} takedowns are reserved on the public leaderboard.\n`
      : "This booth has no takedowns to replay.\n");
    if (unsettled.some(removal => removal.published === "not-configured")) {
      // The removals are recorded only in this booth's ledger, so no other
      // machine can replay them.
      process.stdout.write("This booth has no staff key, so removed names are NOT reserved. "
        + "Add the staff key to this machine with npm run leaderboard:configure, then run this again here.\n");
    }
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
    if (failed || unsettled.length) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
