import { DomainError, requireValue, exactInput, validRunId, generateHandle } from "./domain.mjs";
import { PLACEMENTS } from "./services/coffee-name.mjs";
import { validateLeaderboardUrl } from "./services/public-url.mjs";
import { addDrink, leaderboard, removeDrink, seedMenu, standingFor } from "./services/booth-menu.mjs";
import {
  confirmedSync, failedSync, initialSync, submissionFor, syncView, validateLeaderboardClient, validateReceipt
} from "./services/leaderboard.mjs";
import {
  archiveMatches, archivePayload, artifactName, emptyLedger, eventSummary, exportPayload, WIPE_CONFIRMATION
} from "./services/event-archive.mjs";
import { blocklistStatus } from "./services/moderation.mjs";

// The booth flow is entirely canvas-driven: the attendee is given a handle,
// invents one drink, and sees their score and standing. It performs no GitHub
// review, approval, merge, or issue write, so it shares none of the live
// engine's evidence gates. It keeps its own phase machine deliberately rather
// than threading a second shape through the reviewed live engine.
const PHASES = ["naming", "served", "complete"];

// How much of the house menu and leaderboard the attendee screen shows at
// once. See houseView for why these are bounded and what is unaffected.
const MENU_WINDOW = 12;
const BOARD_WINDOW = 10;

export class BoothEngine {
  constructor({ store, catalog, rules, leaderboardUrl = null, leaderboardClient = null }) {
    // Reuse the reviewed leaderboard rule rather than inventing a second,
    // weaker one here: a destination attendees are told to scan must be a
    // public HTTPS address, and anything else is refused before any QR exists.
    if (leaderboardUrl !== null) {
      try { leaderboardUrl = validateLeaderboardUrl(leaderboardUrl); }
      catch { throw new DomainError("invalid_leaderboard_url", "The configured leaderboard URL is not an approved public HTTPS address."); }
    }
    validateLeaderboardClient(leaderboardClient);
    Object.assign(this, { store, catalog, rules, leaderboardUrl, leaderboardClient });
  }

  // The QR target is real only when staff have configured a deployed
  // leaderboard. With none configured this stays null and the canvas must say
  // so plainly rather than render a placeholder as a working code.
  attendeeUrl(run) {
    // A removed drink has no place to point at. Handing over a code that leads
    // to an empty leaderboard lookup would be worse than saying nothing.
    if (!this.leaderboardUrl || run.phase === "naming" || run.removed) return null;
    const url = new URL(this.leaderboardUrl);
    url.searchParams.set("handle", run.handle);
    return url.toString();
  }

  // The menu lives alongside runs in the same ledger, defaulted so an existing
  // ledger written before the booth flow still loads.
  houseMenu(data) {
    if (!Array.isArray(data.menu) || data.menu.length === 0) data.menu = seedMenu(this.catalog);
    return data.menu;
  }

  // Removals live beside the menu in the same ledger, defaulted so a ledger
  // written before takedown existed still loads.
  removalLog(data) {
    if (!Array.isArray(data.removals)) data.removals = [];
    return data.removals;
  }

  // Staff-only, and deliberately not routed through `dispatch`: that whitelist
  // is the attendee's surface, and a booth screen where anyone can delete a
  // rival's entry is worse than no takedown at all. Reached through the staff
  // script instead.
  async removeDrink({ id, removedBy, reason }) {
    const record = await this.store.transaction(data => {
      const record = removeDrink(this.houseMenu(data), this.removalLog(data), id, { removedBy, reason });
      // Whoever entered it may still be at the counter. Mark their run so the
      // screen says what happened instead of showing a rank that no longer
      // exists; standingFor would otherwise report "pending" forever.
      for (const run of Object.values(data.runs)) {
        if (run.submission?.id !== record.id) continue;
        run.removed = { at: record.removedAt };
        run.statusMessage = "Booth staff removed this drink from the house menu.";
        run.events.push({ type: "removed", at: record.removedAt });
      }
      return record;
    });
    // The local takedown is already committed and never depends on the
    // network. Reaching the public board is attempted after it, and a failure
    // is recorded so staff can see it and retry rather than assume it worked.
    return { ...record, published: await this.retract(record.id) };
  }

  // Takes a removed drink off the public board and records the outcome on the
  // removal record: "retracted", "absent" (it was never published there), or
  // "failed". "not-configured" means this booth has no staff key for the
  // service, which is a real gap in a takedown and is reported as one.
  async retract(id) {
    let published;
    if (!this.leaderboardClient?.retract) {
      published = "not-configured";
    } else {
      try { published = await this.leaderboardClient.retract(id); }
      catch { published = "failed"; }
    }
    await this.store.transaction(data => {
      const record = this.removalLog(data).findLast(item => item.id === id);
      if (record) record.published = published;
    });
    return published;
  }

  // Retries every takedown that did not reach the public board. Safe to call
  // repeatedly: a retraction that already landed comes back "absent".
  async retryRetractions() {
    const data = await this.store.read();
    const pending = this.removalLog(data).filter(record => record.published === "failed");
    const results = [];
    for (const record of pending) results.push({ id: record.id, published: await this.retract(record.id) });
    return results;
  }

  // Sends every drink this booth still has on its menu to the public board,
  // whatever its sync state. The booth is the authoritative copy, so this
  // rebuilds the board after its data is lost or a new EVENT_ID is set, and it
  // publishes drinks served before this booth was configured, whose sync is
  // "disabled" and would otherwise never be sent. Entries already on the board
  // come back as successes, so running it twice is harmless. Removed drinks are
  // never republished.
  async republishAll() {
    if (!this.leaderboardClient) return [];
    const data = await this.store.read();
    const runIds = this.houseMenu(data).filter(entry => !entry.example && data.runs[entry.runId])
      .map(entry => entry.runId);
    const results = [];
    for (const runId of runIds) {
      await this.publish(runId, { again: true });
      const run = (await this.store.read()).runs[runId];
      results.push({ runId, name: run.submission?.name, state: run.sync.state, reason: run.sync.reason });
    }
    return results;
  }

  // --- Staff operations -----------------------------------------------------
  // None of these are reachable from `dispatch`. The attendee canvas is an
  // unattended screen facing a queue; exporting, archiving and wiping belong to
  // a separate staff surface, the same reasoning that keeps takedown out.

  // What staff need before deciding anything. Removal reasons and staff names
  // appear here and nowhere on the attendee screen.
  async adminOverview() {
    const data = await this.store.read();
    const menu = this.houseMenu(data);
    return {
      archives: await this.store.listArtifacts(),
      blocklist: blocklistStatus(this.rules.blocklist),
      dataDirectory: this.store.directory,
      houseMenu: menu.map(({ example, handle, id, name, score }) => ({ example, handle, id, name, score })),
      leaderboard: leaderboard(menu),
      leaderboardUrl: this.leaderboardUrl,
      removals: this.removalLog(data),
      summary: eventSummary(data),
    };
  }

  // Hand-over is the attendee's own action, and it requires a served drink. An
  // attendee who starts an order and walks away therefore leaves a station that
  // nobody can close, which would block the end-of-event archive forever. This
  // is the staff way out, and it is recorded rather than silent.
  async closeStation({ runId, closedBy }) {
    requireValue(validRunId(runId), "invalid_run", "Invalid run ID.", 400);
    requireValue(typeof closedBy === "string" && closedBy.trim().length > 0,
      "invalid_close", "Record who closed this station.", 400);
    return this.store.transaction(data => {
      const run = Object.hasOwn(data.runs, runId) ? data.runs[runId] : null;
      requireValue(run && run.mode === "booth", "run_missing", "That station does not exist.", 404);
      requireValue(run.phase !== "complete", "already_complete", "That station is already handed over.", 409);
      const at = new Date().toISOString();
      run.phase = "complete";
      run.completedAt = at;
      run.closedBy = closedBy.trim();
      // A drink that reached the menu stays on it. Closing a station ends the
      // attendee's turn; it is not a takedown and must not look like one.
      run.events.push({ type: "closed_by_staff", at });
      return { handle: run.handle, runId, served: Boolean(run.submission) };
    });
  }

  // Reading results out mid-event is safe and changes nothing, so it is kept
  // separate from the archive: staff should never have to risk a wipe to get a
  // copy of the standings.
  async exportResults({ exportedBy, now = new Date().toISOString() } = {}) {
    const data = await this.store.read();
    const payload = exportPayload(data, { exportedBy, now });
    const path = await this.store.writeArtifact(artifactName("results", now), payload);
    return { path, summary: payload.summary };
  }

  // The destructive one. Order is the entire safety property: archive, read it
  // back, compare it against what is still in the ledger, and only then reset.
  // Writing happens inside the transaction so no run can be added between the
  // archive and the wipe and be destroyed without ever being recorded.
  async archiveAndWipe({ archivedBy, confirm, now = new Date().toISOString() } = {}) {
    requireValue(confirm === WIPE_CONFIRMATION, "confirmation_required",
      `Type ${WIPE_CONFIRMATION} to confirm. Nothing was changed.`, 400);
    return this.store.transaction(async data => {
      const summary = eventSummary(data);
      // An attendee mid-order would lose the drink on the screen in front of
      // them. Finish or hand over the station first.
      requireValue(summary.active.length === 0, "station_active",
        `${summary.active.length === 1 ? "One station still has" : `${summary.active.length} stations still have`} an attendee. Close or hand over every order first. Nothing was changed.`, 409);
      requireValue(summary.attendees > 0 || summary.invented > 0 || summary.removals > 0,
        "nothing_to_archive", "There is nothing recorded to archive. Nothing was changed.", 409);

      const payload = archivePayload(data, { archivedBy, now });
      // Verify before publishing, not after. The file has to exist to be read
      // back, but one that fails the check must not survive in exports/ where
      // staff could copy it off believing the event was saved.
      const pending = await this.store.writePendingArtifact(artifactName("event", now), payload);
      let path;
      try {
        const written = await this.store.readArtifact(pending);
        requireValue(archiveMatches(written, data), "archive_unverified",
          "The archive did not read back correctly, so nothing was wiped. Preserve the ledger and ask staff to check storage.", 500);
        path = await this.store.publishArtifact(pending);
      } catch (error) {
        await this.store.discardArtifact(pending);
        throw error;
      }

      const empty = emptyLedger();
      for (const key of Object.keys(data)) delete data[key];
      Object.assign(data, empty);
      return { archive: path, summary };
    });
  }

  // The counter view: what is on the menu and who is winning. It needs no run,
  // so the booth screen is never blank between attendees.
  //
  // Both lists are windowed. A booth day appends one drink per attendee, and
  // measured across 159 of them the uncapped board grew 122px and 14 words
  // each time, reaching 18 screens of scrolling. Nobody reads that, and the
  // drinks worth seeing are the newest and the best. Staff still get the whole
  // list from adminOverview, and an attendee's own placing comes from
  // `standing`, which is ranked against the full menu rather than this window.
  houseView(data) {
    const menu = this.houseMenu(data);
    const invented = menu.filter(entry => !entry.example);
    const board = leaderboard(menu);
    return {
      // Newest first: the attendee most likely reading this just added the
      // drink at the top.
      houseMenu: [...menu.filter(entry => entry.example), ...invented.slice(-MENU_WINDOW).reverse()]
        .map(({ artwork, example, id, name, price, serving }) =>
          ({ artwork, example, id, name, price, serving })),
      houseMenuTotal: invented.length,
      leaderboard: board.slice(0, BOARD_WINDOW),
      leaderboardTotal: board.length,
      leaderboardUrl: this.leaderboardUrl,
      mascots: this.rules.mascots,
      placements: PLACEMENTS,
    };
  }

  async house() {
    return this.houseView(await this.store.read());
  }

  present(run, data) {
    return {
      ...this.houseView(data),
      attendeeUrl: this.attendeeUrl(run),
      completedAt: run.completedAt ?? null,
      createdAt: run.createdAt,
      // The attendee's handle is shown from the very start so they can note it
      // down and find themselves on the leaderboard later.
      handle: run.handle,
      phase: run.phase,
      // Staff identity and the stated reason stay out of the attendee screen.
      // That a drink came down is the attendee's business; who decided it and
      // on what grounds is not.
      removed: run.removed ? { at: run.removed.at } : null,
      runId: run.runId,
      statusMessage: run.statusMessage,
      submission: run.submission,
      // The booth's own standing is a local fact. The event standing is only
      // ever what the service confirmed, so the two are reported separately.
      standing: run.phase === "naming" ? null : standingFor(this.houseMenu(data), run.runId),
      sync: syncView(run.sync),
    };
  }

  async open(input = {}) {
    exactInput(input, ["runId"]);
    requireValue(validRunId(input.runId), "invalid_run",
      "Use a stable run ID of 1-80 letters, digits, hyphens or underscores.", 400);
    return this.store.transaction(data => {
      const existing = Object.hasOwn(data.runs, input.runId) ? data.runs[input.runId] : null;
      if (existing) {
        requireValue(existing.mode === "booth", "run_conflict",
          "That run ID belongs to a different exercise mode. Use a new run ID.");
        return this.present(existing, data);
      }
      const used = new Set([
        ...Object.values(data.runs).map(run => run.handle),
        ...this.houseMenu(data).map(entry => entry.handle),
      ].filter(Boolean));
      const run = {
        createdAt: new Date().toISOString(),
        events: [{ type: "opened", at: new Date().toISOString() }],
        handle: generateHandle(this.catalog.words, used),
        mode: "booth",
        phase: "naming",
        runId: input.runId,
        statusMessage: "Invent a drink name to add to the house menu.",
        submission: null,
      };
      data.runs[input.runId] = run;
      return this.present(run, data);
    });
  }

  async get(runId) {
    requireValue(validRunId(runId), "invalid_run", "Invalid run ID.", 400);
    const data = await this.store.read();
    const run = Object.hasOwn(data.runs, runId) ? data.runs[runId] : null;
    requireValue(run, "run_missing", "That run does not exist. Start a new one.", 404);
    requireValue(run.mode === "booth", "run_conflict", "That run belongs to a different exercise mode.");
    return this.present(run, data);
  }

  // Publishing happens after the local commit and outside the store lock, so a
  // slow or unreachable service never holds up the booth or the next attendee.
  // The entry is already durable; only the receipt is still missing.
  async publish(runId, { again = false } = {}) {
    if (!this.leaderboardClient) return;
    const data = await this.store.read();
    const run = data.runs[runId];
    if (!again && run?.sync?.state !== "pending" && run?.sync?.state !== "failed") return;
    if (!run?.sync || run.removed) return;
    const entry = this.houseMenu(data).find(item => !item.example && item.runId === runId);
    if (!entry) return;
    const submission = submissionFor(entry);
    let outcome;
    try {
      outcome = { ok: true, receipt: validateReceipt(await this.leaderboardClient.publish(submission), submission) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    const removedMeanwhile = await this.store.transaction(stored => {
      const current = stored.runs[runId];
      if (!current?.sync) return false;
      current.sync = outcome.ok
        ? confirmedSync(current.sync, outcome.receipt)
        : failedSync(current.sync, outcome.error);
      return Boolean(current.removed);
    });
    // Staff can take a drink down while its publish is still in flight. The
    // retraction may then reach the service before the submission does, and
    // the submission would put the drink straight back on the public board.
    // The receipt is proof it landed, so take it down again.
    if (outcome.ok && removedMeanwhile) await this.retract(entry.id);
  }

  async dispatch(runId, action, input = {}) {
    requireValue(validRunId(runId), "invalid_run", "Invalid run ID.", 400);
    // A refresh is the natural moment to retry a submission that did not land,
    // so a booth recovers from a network blip without staff intervention.
    if (action === "refresh") { exactInput(input); await this.publish(runId).catch(() => {}); return this.get(runId); }
    requireValue(["submit_name", "complete"].includes(action),
      "unknown_action", "That action is not available at this booth.", 400);
    exactInput(input, action === "complete" ? [] : ["name", "mascot", "placement"]);
    return this.store.transaction(data => {
      const run = Object.hasOwn(data.runs, runId) ? data.runs[runId] : null;
      requireValue(run, "run_missing", "That run does not exist. Start a new one.", 404);
      requireValue(run.mode === "booth", "run_conflict", "That run belongs to a different exercise mode.");
      requireValue(PHASES.includes(run.phase), "invalid_phase", "This run has an unusable state. Ask booth staff.");

      if (action === "complete") {
        // Completion closes out this attendee so the canvas can be handed to the
        // next one. Their drink stays on the house menu and the leaderboard: the
        // run is finished, not erased.
        requireValue(run.phase !== "naming", "not_served",
          "Add your drink to the menu before finishing.", 409);
        if (run.phase === "complete") return this.present(run, data);
        run.phase = "complete";
        run.completedAt = new Date().toISOString();
        run.events.push({ type: "completed", at: run.completedAt });
        run.statusMessage = "Thanks for playing. The booth is ready for the next barista.";
        return this.present(run, data);
      }

      // One drink per attendee keeps the competition fair and the menu readable.
      requireValue(run.phase === "naming", "already_served",
        "You have already added your drink. Each attendee invents one.", 409);

      const entry = addDrink(this.houseMenu(data), {
        choice: { mascot: input.mascot, placement: input.placement },
        handle: run.handle, rawName: input.name, removedIds: this.removalLog(data).map(record => record.id),
        rules: this.rules, runId,
      });
      run.submission = {
        breakdown: entry.breakdown, id: entry.id, name: entry.name, placement: entry.placement,
        price: entry.price, score: entry.score, serving: entry.serving,
      };
      run.phase = "served";
      run.sync = initialSync(Boolean(this.leaderboardClient));
      run.events.push({ type: "served", at: entry.createdAt });
      run.statusMessage = `${entry.name} is on the menu and scored ${entry.score} out of 5000.`;
      return this.present(run, data);
    });
  }
}

export { DomainError };
