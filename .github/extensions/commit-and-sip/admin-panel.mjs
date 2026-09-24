import { exactInput, requireValue } from "./domain.mjs";

// The staff dashboard is a separate panel on a separate canvas, not a mode of
// the attendee screen. Keeping the surfaces apart is what lets the attendee
// canvas keep a whitelist with no destructive action in it at all.
export class AdminPanel {
  constructor(engine) {
    this.engine = engine;
    // The booth panel exposes a runId; this one never drives a run, and the
    // local server reads that property.
    this.runId = null;
    this.busy = false;
  }

  async get() {
    return this.engine.adminOverview();
  }

  async dispatch(action, input = {}) {
    if (action === "refresh") {
      exactInput(input);
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
      return { ...(await this.get()), notice: { kind: "removed", name: record.name } };
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
