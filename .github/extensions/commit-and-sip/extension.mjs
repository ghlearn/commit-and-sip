import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { readFile } from "node:fs/promises";
import { DomainError, loadCatalog, validateStaffConfig } from "./domain.mjs";
import { dataDirectory, RunStore } from "./store.mjs";
import { BoothEngine } from "./booth-engine.mjs";
import { loadNameRules } from "./services/coffee-name.mjs";
import { blocklistStatus } from "./services/moderation.mjs";
import { boothCanvasDefinition } from "./canvas.mjs";

const catalog = await loadCatalog();
let config = {};
try {
  config = validateStaffConfig(JSON.parse(await readFile(new URL("../../../booth/local-config.json", import.meta.url), "utf8")));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const directory = dataDirectory();
const store = new RunStore(directory);
let session;

async function guarded(fn) {
  try { return await fn(); }
  catch (error) {
    if (error instanceof DomainError) throw new CanvasError(error.code, error.message);
    await session?.log(`Commit & Sip service error: ${error.name}; inspect service configuration and retry.`, { level: "error" });
    throw new CanvasError("service_unavailable", "Commit & Sip could not reach a required service. Progress is preserved; ask booth staff to inspect configuration.");
  }
}

const rules = await loadNameRules();
const engine = new BoothEngine({ store, catalog, rules, leaderboardUrl: config.leaderboardUrl ?? null });

session = await joinSession({
  canvases: [createCanvas(boothCanvasDefinition({
    engine, guarded,
    reportError: error => session?.log(`Commit & Sip HTTP service error: ${error.name}; check staff configuration.`, { level: "error" })
  }))]
});

// Attendee names go on a published menu, so an unreviewed blocklist is a real
// event risk. Say so every start rather than letting it pass unnoticed.
const moderation = blocklistStatus(rules.blocklist);
if (!moderation.ready) {
  await session.log(`Commit & Sip moderation is not event-ready: ${moderation.reason} Review booth/blocked-terms.json before publishing attendee names.`, { level: "warning" });
}
