import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { guardNodeVersion } from "./require-node.mjs";
import { openEngine } from "./remove-drink.mjs";

guardNodeVersion();

// Sends every drink on this booth's menu to the public leaderboard again.
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
    const results = await engine.republishAll();
    for (const result of results) {
      process.stdout.write(`${result.state === "confirmed" ? "ok    " : "FAILED"}\t${result.name}`
        + `${result.state === "confirmed" ? "" : `\t${result.reason ?? ""}`}\n`);
    }
    const failed = results.filter(result => result.state !== "confirmed").length;
    process.stdout.write(results.length
      ? `${results.length - failed} of ${results.length} drinks are on the public leaderboard.\n`
      : "This booth has no attendee drinks to publish.\n");
    if (failed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
