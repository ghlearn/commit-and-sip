import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { loadNameRules } from "../.github/extensions/commit-and-sip/services/coffee-name.mjs";
import { blocklistStatus } from "../.github/extensions/commit-and-sip/services/moderation.mjs";
import { createApp } from "./app.mjs";
import { FileStore, openReservationKey } from "./store.mjs";

// Node built-ins only: no SDK, no connection string, no storage account. The
// board is kept on App Service's persistent /home storage by a single instance.

const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};

const rules = await loadNameRules();
const words = JSON.parse(await readFile(new URL("../booth/handle-words.json", import.meta.url), "utf8"));
const directory = process.env.DATA_DIR || "/home/data/commit-and-sip";
const store = await FileStore.open({ directory, event: process.env.EVENT_ID || "default" });

const app = createApp({
  boothKey: required("BOOTH_KEY"), log: message => console.error(message), reservationKey: await openReservationKey(directory, store),
  rules, staffKey: required("STAFF_KEY"), store, words,
});

const port = Number(process.env.PORT) || 8080;
createServer(app).listen(port, () => {
  console.log(`Commit & Sip leaderboard listening on ${port}.`);
  // The service moderates with the blocklist deployed alongside it. Say so
  // plainly in the log, the way the booth does, while that list is unreviewed.
  if (!blocklistStatus(rules.blocklist).ready) {
    console.warn("Moderation blocklist is the unreviewed placeholder. Do not point a public QR code at this service.");
  }
});
