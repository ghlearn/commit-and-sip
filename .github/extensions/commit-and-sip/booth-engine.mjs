import { randomUUID } from "node:crypto";
import { DomainError, requireValue, exactInput, validRunId, generateHandle } from "./domain.mjs";
import { PLACEMENTS } from "./services/coffee-name.mjs";
import { validateLeaderboardUrl } from "./services/public-url.mjs";
import { addDrink, leaderboard, removeDrink, seedMenu, standingFor } from "./services/booth-menu.mjs";
import {
  confirmedSync, failedSync, initialSync, newPublicationToken, publicRef, retractionCause, retractionFailure, submissionFor, syncView, tokenHashOf, validateLeaderboardClient, validateReceipt,
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

// Takedown outcomes that need no retry: removed from the public board, or it
// was never there. Anything else is still owed a retraction.
const SETTLED = ["retracted", "absent"];
// How long a claimed send blocks an event wipe. Far longer than a request can
// take (the client times out in seconds), so a live send is always seen, and
// short enough that a claim left by a crash stops blocking on its own.
const SEND_CLAIM_MS = 60_000;
const liveClaims = (sync, at = Date.now()) =>
  Object.values(sync?.sending ?? {}).filter(since => at - Date.parse(since) < SEND_CLAIM_MS).length;

// Whether a removed drink's ID may be on the public board, from any booth.
// The board is keyed by drink ID, not by run, so this run never having been
// sent proves little: "duplicate_drink" means another booth's entry holds
// this exact ID, and a drink served before this booth was configured
// ("disabled") may share its ID with one another booth published. The only
// proof the ID is not public is the service saying it is already reserved
// ("unavailable_drink"). A booth that does not publish at all has no board
// to answer to for drinks it never sent; it still owes one it did send.
// An unknown run is treated as public.
function mayBePublic(data, record, publishing) {
  const sync = data.runs[record.runId]?.sync;
  if (sync?.state === "rejected" && sync.code === "unavailable_drink") return false;
  if (publishing) return true;
  return sync?.state !== "disabled";
}

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
    // The service refused this publication: the name belongs to another
    // attendee, or was taken down. A code would open the board on their row
    // and call it "your drink".
    if (run.sync?.state === "rejected") return null;
    const url = new URL(this.leaderboardUrl);
    // Personalised only with the opaque publication reference. A handle is
    // unique at one booth, not across the event, so a handle-only link could
    // open the board on another attendee's row and call it "your drink".
    // Until this booth has minted the reference (before its first publish, or
    // on a booth that does not publish at all), the link is the plain board.
    if (!run.sync?.token) return url.toString();
    // Once the service confirms the drink, the handle it confirmed is the one
    // on the board: another booth may have used this phrase first. Nothing in
    // the URL spells out the drink's name.
    url.searchParams.set("handle", run.sync.state === "confirmed" ? run.sync.receipt.handle : run.handle);
    url.searchParams.set("ref", publicRef(tokenHashOf(run.sync.token)));
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
    // `owed` says whether the drink may still be public because of it.
    const published = await this.retract(record.id);
    const data = await this.store.read();
    const recorded = this.removalLog(data).findLast(item => item.id === record.id) ?? record;
    return this.takedownView({ ...recorded, owed: !SETTLED.includes(published) && mayBePublic(data, record, Boolean(this.leaderboardClient)), published });
  }

  // Takes a removed drink off the public board and records the outcome on the
  // removal record: "retracted", "absent" (it was never published there), or
  // "failed". "not-configured" means this booth has no staff key for the
  // service, which is a real gap in a takedown and is reported as one.
  // "in-doubt" means the service answered, but a send of the same drink may
  // have landed after that answer, so the takedown is retried rather than
  // settled.
  async retract(id) {
    // What had been sent before this retraction left. A send that ends after
    // this point may have reached the service after the retraction did.
    const sendsEndedBefore = this.sendsEnded(await this.store.read(), id);
    let published;
    let failure = null;
    if (!this.leaderboardClient?.retract) {
      published = "not-configured";
    } else {
      try { published = await this.leaderboardClient.retract(id); }
      catch (error) { published = "failed"; failure = retractionFailure(error); }
    }
    // Attempts can overlap (a dashboard refresh while an earlier try is still
    // waiting on the network). A settled outcome is never replaced by an
    // unsettled one, or a late timeout would bring back a takedown that
    // already landed. What is returned is what is recorded.
    return this.store.transaction(data => {
      const record = this.removalLog(data).findLast(item => item.id === id);
      if (!record) return published;
      // Settled only if no send of this drink can still land after it: none is
      // claimed now (a claim left by a crash stops counting once it expires),
      // and none ended while this retraction was on the wire.
      const sync = data.runs[record.runId]?.sync;
      const inDoubt = liveClaims(sync) > 0 || this.sendsEnded(data, id) !== sendsEndedBefore;
      if (SETTLED.includes(published) && inDoubt) published = "in-doubt";
      if (!SETTLED.includes(record.published) || SETTLED.includes(published)) {
        record.published = published;
        // Why it failed, while it is failing, so staff are given the right fix.
        if (failure) record.failure = failure;
        else delete record.failure;
      }
      return record.published;
    });
  }

  // A takedown as staff are shown it: its outcome and, while it is failing,
  // the cause in words.
  takedownView(record) {
    return { ...record, cause: record.published === "failed" ? retractionCause(record.failure) : null };
  }

  // Retracts, then reports the outcome as recorded, with its failure if any.
  async retractReport(id) {
    const published = await this.retract(id);
    const record = this.removalLog(await this.store.read()).findLast(item => item.id === id);
    return { id, published, ...(published === "failed" && record?.failure ? { failure: record.failure } : {}) };
  }

  // How many sends of this drink have finished, across its runs.
  sendsEnded(data, id) {
    return Object.values(data.runs).filter(run => run.submission?.id === id)
      .reduce((total, run) => total + (run.sync?.sendsEnded ?? 0), 0);
  }

  // Retries every takedown that has not reached the public board. Only
  // "retracted" and "absent" are settled: "failed" is a network error, a
  // missing outcome means the process stopped between the local removal and
  // the retraction, and "not-configured" becomes retryable once a staff key
  // is added. A booth that cannot retract has nothing to try, so it does not
  // rewrite the ledger on every refresh.
  // Removals still owed a retraction. They live in this booth's ledger, so
  // only this machine can finish them: another machine has no record of them.
  async unsettledRetractions() {
    return this.removalLog(await this.store.read()).filter(record => !SETTLED.includes(record.published));
  }

  // The subset that may still be showing on the public board. These are what
  // staff must be warned about, and what must not be wiped away.
  async owedPublicTakedowns(data = null) {
    const current = data ?? await this.store.read();
    return this.removalLog(current).filter(record => !SETTLED.includes(record.published) && mayBePublic(current, record, Boolean(this.leaderboardClient)));
  }

  async retryRetractions() {
    if (!this.leaderboardClient?.retract) return [];
    const data = await this.store.read();
    const pending = this.removalLog(data).filter(record => !SETTLED.includes(record.published));
    const results = [];
    for (const record of pending) results.push(await this.retractReport(record.id));
    return results;
  }

  // Retries every publication still owed: pending or failed, including runs
  // whose attendee has already handed over, which no screen is showing any
  // more. Refusals ("rejected") are final and not retried. Only one sweep runs
  // at a time; a second caller shares it.
  retryPublications() {
    this.publicationSweep ??= (async () => {
      try {
        if (!this.leaderboardClient) return 0;
        const data = await this.store.read();
        const owed = Object.entries(data.runs)
          .filter(([, run]) => ["pending", "failed"].includes(run.sync?.state) && !run.removed)
          .map(([runId]) => runId);
        for (const runId of owed) await this.publish(runId).catch(() => {});
        return owed.length;
      } finally {
        this.publicationSweep = null;
      }
    })();
    return this.publicationSweep;
  }

  // Sends every drink this booth still has on its menu to the public board,
  // whatever its sync state. The booth is the authoritative copy, so this
  // rebuilds the board after its data is lost or a new EVENT_ID is set, and it
  // publishes drinks served before this booth was configured, whose sync is
  // "disabled" and would otherwise never be sent. Entries already on the board
  // come back as successes, so running it twice is harmless. Removed drinks are
  // never republished.
  //
  // Takedowns are replayed first. A lost board loses its reservations too, and
  // without them a name staff removed could be published again from another
  // booth. A retraction of something not on the board still reserves it, so
  // replaying is safe, and settled outcomes on the removal records are kept.
  async republishAll() {
    if (!this.leaderboardClient) return { blocked: false, drinks: [], removals: [] };
    const removals = [];
    for (const record of this.removalLog(await this.store.read())) {
      if (!this.leaderboardClient.retract) {
        removals.push({ id: record.id, published: "not-configured" });
        continue;
      }
      if (!SETTLED.includes(record.published)) {
        removals.push(await this.retractReport(record.id));
        continue;
      }
      try { removals.push({ id: record.id, published: await this.leaderboardClient.retract(record.id) }); }
      catch (error) { removals.push({ failure: retractionFailure(error), id: record.id, published: "failed" }); }
    }
    // Takedowns first is a guarantee, not a preference. Until every removed ID
    // is reserved again, the replacement board would accept that name, so no
    // drink is sent: the rebuild stops here and says why.
    if (removals.some(removal => !SETTLED.includes(removal.published))) {
      return { blocked: true, drinks: [], removals };
    }
    const data = await this.store.read();
    const runIds = this.houseMenu(data).filter(entry => !entry.example && data.runs[entry.runId])
      .map(entry => entry.runId);
    const results = [];
    for (const runId of runIds) {
      const attempt = await this.publish(runId, { again: true });
      const run = (await this.store.read()).runs[runId];
      // Reported from the attempt, not the record: a rebuild that did not
      // land must fail even when the drink was confirmed on the lost board.
      results.push(attempt?.sent
        ? { name: run.submission?.name, reason: attempt.reason, runId, state: attempt.state }
        : { name: run.submission?.name, reason: run.sync.reason, runId, state: run.sync.state });
    }
    return { blocked: false, drinks: results, removals };
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
      // `owed`: not settled, and the drink may be public. The dashboard must
      // warn about these, including one whose outcome was never recorded.
      removals: this.removalLog(data).map(record => this.takedownView({
        ...record, owed: !SETTLED.includes(record.published) && mayBePublic(data, record, Boolean(this.leaderboardClient)),
      })),
      // Publishing (leaderboardApi) and the attendee link (leaderboardUrl) are
      // configured separately, so they are reported separately.
      publishing: { enabled: Boolean(this.leaderboardClient), takedowns: Boolean(this.leaderboardClient?.retract) },
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
    // A takedown that has not reached the public board is recorded only in
    // this ledger. Wiping it would leave the drink public with nothing left to
    // retry it from. A publish still on the wire can also land after the wipe
    // with no run left to notice it was removed. So let publications finish,
    // give every owed takedown one more try...
    await this.drainPublications();
    await this.retryRetractions().catch(() => {});
    return this.store.transaction(async data => {
      // ...and refuse if a publish started in the meantime, here or in another
      // process. Its claim is in this ledger, under this lock.
      const claimed = Object.values(data.runs).some(run => liveClaims(run.sync));
      requireValue(!this.inFlight?.size && !claimed, "publications_in_flight",
        "A drink is still being sent to the public leaderboard. Try again in a few seconds. Nothing was changed.", 409);
      // ...and refuse to wipe while any is still owed.
      const owed = this.removalLog(data).filter(record => !SETTLED.includes(record.published) && mayBePublic(data, record, Boolean(this.leaderboardClient)));
      requireValue(owed.length === 0, "takedowns_owed",
        `${owed.length === 1 ? "One takedown has" : `${owed.length} takedowns have`} not reached the public leaderboard, `
        + "so wiping would leave it public with no record to retry from. The dashboard shows why each has not landed: fix that and press Refresh and retry, "
        + "or copy the deployed keys to this machine with npm run leaderboard:configure -- --url <url> --from <an owner-only (chmod 600) copy of a staff machine's booth/local-config.json>, then delete that copy. Nothing was changed.", 409);
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
      sync: syncView(run.sync, run.handle),
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
  // One ordinary publish per run at a time: the background publish after
  // serving and a retry sweep started by the screen's poll would otherwise
  // both send it. A forced resend (`again`) is never merged, because a
  // rebuild must report its own attempt.
  publish(runId, options = {}) {
    if (options.again) return this.tracked(this.publishOnce(runId, options));
    this.publishing ??= new Map();
    if (!this.publishing.has(runId)) {
      this.publishing.set(runId, this.tracked(this.publishOnce(runId, options)).finally(() => this.publishing.delete(runId)));
    }
    return this.publishing.get(runId);
  }

  // Every publish attempt still on the wire. The event cannot be wiped while
  // one is: its outcome, and any retraction it turns out to need, would have
  // no run or removal record left to land in.
  tracked(attempt) {
    this.inFlight ??= new Set();
    this.inFlight.add(attempt);
    return attempt.finally(() => this.inFlight.delete(attempt));
  }

  async drainPublications() {
    while (this.inFlight?.size) await Promise.allSettled([...this.inFlight]);
  }

  async publishOnce(runId, { again = false } = {}) {
    if (!this.leaderboardClient) return;
    const data = await this.store.read();
    const run = data.runs[runId];
    if (!again && run?.sync?.state !== "pending" && run?.sync?.state !== "failed") return;
    // A refusal that retrying cannot change is final, even for a rebuild.
    if (!run?.sync || run.removed || run.sync.state === "rejected") return;
    const entry = this.houseMenu(data).find(item => !item.example && item.runId === runId);
    if (!entry) return;
    // Every send is claimed under the ledger lock first, and an event wipe
    // checks the claims under the same lock, so the two are ordered even across
    // processes (the republish command runs its own engine): either the wipe
    // sees this send coming and refuses, or this send finds the run gone and
    // never leaves. The token is minted in the same step, before the first
    // send and never after: a token that changed between a lost response and
    // its retry would make this booth's own entry look like somebody else's.
    const attempt = randomUUID();
    const token = await this.store.transaction(stored => {
      const current = Object.hasOwn(stored.runs, runId) ? stored.runs[runId] : null;
      if (!current?.sync || current.removed || current.sync.state === "rejected") return null;
      current.sync.token ??= newPublicationToken();
      const now = Date.now();
      const live = Object.entries(current.sync.sending ?? {}).filter(([, since]) => now - Date.parse(since) < SEND_CLAIM_MS);
      current.sync.sending = { ...Object.fromEntries(live), [attempt]: new Date(now).toISOString() };
      return current.sync.token;
    });
    if (!token) return;
    const submission = submissionFor(entry, token);
    let outcome;
    try {
      outcome = { ok: true, receipt: validateReceipt(await this.leaderboardClient.publish(submission), submission) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    const { recorded, removedMeanwhile } = await this.store.transaction(stored => {
      const current = stored.runs[runId];
      if (!current?.sync) return { recorded: null, removedMeanwhile: false };
      // Overlapping attempts: a late failure from an earlier try must not undo
      // a confirmation or a final refusal that another try already recorded.
      // A definitive refusal is the exception: it comes from the service as it
      // is now, so it replaces a confirmation from a board that was lost, or
      // the booth keeps showing a rank that no longer exists and a rebuild
      // keeps resending a name the service will never take.
      const settled = ["confirmed", "rejected"].includes(current.sync.state);
      // A failure carries no receipt: one from a lost board must not survive
      // into a refusal and be read as a rank.
      const { receipt: _lost, ...failure } = outcome.ok ? {} : failedSync(current.sync, outcome.error);
      // And a refusal is final: a run is never sent again once refused, so a
      // success arriving after one is from an attempt that started earlier,
      // possibly to a board since lost, and must not bring back its rank.
      if (outcome.ok) { if (current.sync.state !== "rejected") current.sync = confirmedSync(current.sync, outcome.receipt); }
      else if (!settled || failure.state === "rejected") current.sync = failure;
      const { [attempt]: _done, ...others } = current.sync.sending ?? {};
      if (Object.keys(others).length) current.sync.sending = others;
      else delete current.sync.sending;
      current.sync.sendsEnded = (current.sync.sendsEnded ?? 0) + 1;
      // A send of a removed drink may just have put it back on the board. Its
      // takedown is owed again until the retraction below lands, so a stop
      // before then leaves it to be retried, not recorded as done.
      if (current.removed) {
        const record = this.removalLog(stored).findLast(item => item.id === entry.id);
        if (record && SETTLED.includes(record.published)) record.published = "in-doubt";
      }
      return { recorded: { reason: current.sync.reason, state: current.sync.state }, removedMeanwhile: Boolean(current.removed) };
    });
    // Staff can take a drink down while its publish is still in flight. The
    // retraction may then reach the service before the submission does, and
    // the submission would put the drink straight back on the public board.
    // A failed response does not prove the submission did not land (the
    // service may have stored it and the answer been lost), so take it down
    // again whatever this attempt reported. A retraction of something absent
    // is harmless, and still reserves the name.
    if (removedMeanwhile) await this.retract(entry.id);
    // What this attempt did, separately from what is recorded. A forced
    // resend that fails leaves an earlier "confirmed" in place, which is
    // right for the record and wrong for a report on the resend. A success
    // that lost to a refusal already recorded reports the refusal that won.
    return outcome.ok
      ? (recorded?.state === "rejected" ? { reason: recorded.reason, sent: true, state: "rejected" } : { sent: true, state: "confirmed" })
      : { reason: failedSync({ attempts: 0 }, outcome.error).reason, sent: true,
        state: failedSync({ attempts: 0 }, outcome.error).state };
  }

  async dispatch(runId, action, input = {}) {
    requireValue(validRunId(runId), "invalid_run", "Invalid run ID.", 400);
    // A refresh is the natural moment to retry a submission that did not land,
    // so a booth recovers from a network blip without staff intervention.
    if (action === "refresh") { exactInput(input); await this.retryPublications().catch(() => {}); return this.get(runId); }
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
      // Minted with the served drink, in the same transaction, so the QR link
      // is personal from the first screen and every later send reuses it.
      if (this.leaderboardClient) run.sync.token = newPublicationToken();
      run.events.push({ type: "served", at: entry.createdAt });
      run.statusMessage = `${entry.name} is on the menu and scored ${entry.score} out of 5000.`;
      return this.present(run, data);
    });
  }
}

export { DomainError };
