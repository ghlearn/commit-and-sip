import { randomUUID } from "node:crypto";
import { exactInput, requireValue } from "./domain.mjs";
import { renderQrDataUrl } from "./services/qr.mjs";

// One panel is one booth station, used by attendee after attendee. The panel
// holds only which run is at the counter right now; every durable fact lives in
// the run store, so a reopened panel never invents or loses an attendee.
export class BoothPanel {
  constructor(engine, { renderQr = renderQrDataUrl } = {}) {
    this.engine = engine;
    this.renderQr = renderQr;
    this.runId = null;
    this.busy = false;
  }

  async get() {
    if (!this.runId) return { phase: "idle", ...(await this.engine.house()) };
    const state = await this.currentRun();
    if (!state) return { phase: "idle", ...(await this.engine.house()) };
    return this.decorate(state);
  }

  // The panel's cursor is a cache of who is at the counter, and the ledger can
  // move without it: staff close an abandoned station, or an event archive
  // wipes the ledger entirely. Either leaves this panel pointing at a run the
  // attendee never finished, which would refuse `begin` as already_started and
  // strand the station. Reconcile instead of trusting the cursor: a run that is
  // gone or already finished releases it, and the next attendee can start.
  async currentRun() {
    let state;
    try {
      state = await this.engine.get(this.runId);
    } catch (error) {
      if (error?.code !== "run_missing") throw error;
      this.runId = null;
      return null;
    }
    if (state.phase === "complete") {
      this.runId = null;
      return null;
    }
    return state;
  }

  // The QR image is derived from the verified destination rather than stored,
  // so it cannot outlive or contradict the configured leaderboard.
  async decorate(state) {
    const qrDataUrl = state.attendeeUrl ? await this.renderQr(state.attendeeUrl) : null;
    return { ...state, qrDataUrl };
  }

  async dispatch(action, input = {}) {
    if (action === "refresh") { exactInput(input); return this.get(); }
    if (action === "begin") {
      exactInput(input);
      // Release a cursor the ledger has already moved past, so a staff close or
      // an event wipe does not leave this station refusing every new attendee.
      if (this.runId) await this.currentRun();
      requireValue(!this.runId, "already_started",
        "This station already has a barista. Finish that order before starting another.", 409);
      // Guard the gap between minting a run ID and recording it, so a double
      // click cannot strand a started run that the panel then forgets.
      requireValue(!this.busy, "station_busy", "This station is already starting an order. Wait a moment.", 409);
      this.busy = true;
      try {
        const state = await this.engine.open({ runId: `booth-${randomUUID()}` });
        this.runId = state.runId;
        return this.decorate(state);
      } finally {
        this.busy = false;
      }
    }
    if (this.runId) await this.currentRun();
    requireValue(this.runId, "not_started", "Start an order at this station first.", 409);
    const state = await this.engine.dispatch(this.runId, action, input);
    // Serving commits locally first; publishing to the event leaderboard is a
    // separate step that must not be able to fail the attendee's submission.
    if (action === "submit_name") {
      await this.engine.publish(this.runId).catch(() => {});
      return this.decorate(await this.engine.get(this.runId));
    }
    // Completing hands the station to the next attendee. The run itself stays
    // finished in the store; only this panel's cursor is released.
    if (action === "complete") {
      this.runId = null;
      return { phase: "idle", ...(await this.engine.house()), justCompleted: state.handle };
    }
    return this.decorate(state);
  }
}
