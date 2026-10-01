import { exactInput, requireValue } from "./domain.mjs";

// The staff dashboard is a separate panel on a separate canvas, not a mode of
// the attendee screen. Keeping the surfaces apart is what lets the attendee
// canvas keep a whitelist with no destructive action in it at all.
export class AdminPanel {
  constructor(engine, { sweepWaitMs = 3_000 } = {}) {
    this.engine = engine;
    this.sweepWaitMs = sweepWaitMs;
    this.sweep = null;
    // The booth panel exposes a runId; this one never drives a run, and the
    // local server reads that property.
    this.runId = null;
    this.busy = false;
  }

  // `retrying` tells the dashboard a retry sweep is still running, so it keeps
  // polling instead of showing a result that is about to change.
  // The flag must describe the data it is sent with: a sweep that finishes
  // (or starts) while the overview is being read would otherwise pair a
  // stale overview with "not retrying", and the dashboard would stop polling
  // on a result that has already changed. So read again until no sweep
  // started or ended during the read.
  async get() {
    for (;;) {
      const sweep = this.sweep;
      const overview = await this.engine.adminOverview();
      if (this.sweep === sweep) return { ...overview, retrying: Boolean(sweep) };
    }
  }

  async dispatch(action, input = {}) {
    if (action === "refresh") {
      exactInput(input);
      // Refresh is when a takedown that missed the public board is retried,
      // mirroring how the booth retries a publish that did not land. Every
      // owed item is tried in turn and each attempt can take seconds, which
      // can outlast the dashboard's request. So the sweep runs in the
      // background, one at a time (a second Refresh joins it), and the answer
      // waits only briefly: a quick sweep is shown finished, a slow one as
      // still running, and the dashboard polls until it is done. Staff are
      // never shown a timeout while the ledger is still changing.
      this.sweep ??= (async () => {
        try {
          await this.engine.retryRetractions().catch(() => {});
          await this.engine.retryPublications().catch(() => {});
        } finally {
          this.sweep = null;
        }
      })();
      let timer;
      await Promise.race([this.sweep, new Promise(resolve => { timer = setTimeout(resolve, this.sweepWaitMs); })]);
      clearTimeout(timer);
      return this.get();
    }
    if (action === "export_results") {
      exactInput(input, ["exportedBy"]);
      const result = await this.engine.exportResults({ exportedBy: input.exportedBy });
      return { ...(await this.get()), notice: { kind: "exported", path: result.path } };
    }
    if (action === "remove_drink") {
      exactInput(input, ["id", "reason", "removedBy"]);
      const record = await this.engine.removeDrink({
        id: input.id, reason: input.reason, removedBy: input.removedBy,
      });
      return { ...(await this.get()), notice: { cause: record.cause, kind: "removed", name: record.name, owed: record.owed, published: record.published } };
    }
    if (action === "close_station") {
      exactInput(input, ["runId", "closedBy"]);
      const closed = await this.engine.closeStation({ runId: input.runId, closedBy: input.closedBy });
      return { ...(await this.get()), notice: { handle: closed.handle, kind: "closed" } };
    }
    if (action === "archive_and_wipe") {
      exactInput(input, ["archivedBy", "confirm"]);
      // Serialised deliberately. A double-click on a destructive control must
      // not start a second archive while the first holds the ledger lock, or
      // staff see a lock error where they expect a wipe.
      requireValue(!this.busy, "admin_busy", "That operation is already running. Wait for it to finish.", 409);
      this.busy = true;
      try {
        const result = await this.engine.archiveAndWipe({
          archivedBy: input.archivedBy, confirm: input.confirm,
        });
        return { ...(await this.get()), notice: { archive: result.archive, kind: "wiped", was: result.summary } };
      } finally {
        this.busy = false;
      }
    }
    requireValue(false, "unknown_action", "That staff action does not exist.", 400);
  }
}
