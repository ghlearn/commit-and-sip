import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { DomainError, loadCatalog, loadStaffConfig } from "./domain.mjs";
import { dataDirectory, RunStore } from "./store.mjs";
import { BoothEngine } from "./booth-engine.mjs";
import { loadNameRules } from "./services/coffee-name.mjs";
import { blocklistStatus } from "./services/moderation.mjs";
import { leaderboardClientFromConfig } from "./services/leaderboard-client.mjs";
import { qrEncoderAvailable } from "./services/qr.mjs";
import { boothCanvasDefinition } from "./canvas.mjs";
import { adminCanvasDefinition } from "./admin-canvas.mjs";

const catalog = await loadCatalog();
const config = await loadStaffConfig();
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
// Publishing to the service (leaderboardApi) and advertising it to attendees
// (leaderboardUrl, which drives the QR code) are configured separately on
// purpose. The service can be proven end to end with staff entries while the
// QR stays off until moderation and brand review allow a public destination.
const engine = new BoothEngine({
  store, catalog, rules, leaderboardUrl: config.leaderboardUrl ?? null,
  leaderboardClient: leaderboardClientFromConfig(config),
});

const reportError = error =>
  session?.log(`Commit & Sip HTTP service error: ${error.name}; check staff configuration.`, { level: "error" });

session = await joinSession({
  canvases: [
    createCanvas(boothCanvasDefinition({ engine, guarded, reportError })),
    // Staff-only, and a separate canvas on purpose: the attendee screen must
    // stay a surface with no destructive action reachable from it.
    createCanvas(adminCanvasDefinition({ engine, guarded, reportError })),
  ]
});

// Attendee names go on a published menu, so an unreviewed blocklist is a real
// event risk. Say so every start rather than letting it pass unnoticed.
const moderation = blocklistStatus(rules.blocklist);
if (!moderation.ready) {
  await session.log(`Commit & Sip moderation is not event-ready: ${moderation.reason} Review booth/blocked-terms.json before publishing attendee names.`, { level: "warning" });
}

// The QR falls back to a plain link when the encoder is missing, which is the
// right behaviour but a silent one. Without this a booth that skipped `npm ci`
// runs all day before anyone notices attendees are typing URLs. Only worth
// saying when a leaderboard is configured, since otherwise there is no
// destination to encode and the served screen shows no QR either way.
if (config.leaderboardUrl && !(await qrEncoderAvailable())) {
  await session.log("Commit & Sip cannot render QR codes: the qrcode encoder is not installed, so the served screen will show a plain link instead. Run npm ci at this booth.", { level: "warning" });
}
