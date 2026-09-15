import { randomUUID } from "node:crypto";
import { exactInput, requireValue, validRunId } from "./domain.mjs";

export class PanelRun {
  constructor(engine, runId = null) {
    this.engine = engine;
    this.runId = runId;
    this.selecting = false;
    this.suggestedRunId = `rehearsal-${randomUUID()}`;
  }

  async get() {
    if (this.runId) return this.engine.get(this.runId);
    return {
      phase: "setup", mode: null, suggestedRunId: this.suggestedRunId,
      orders: this.engine.catalog.orders.map(({ id, name }) => ({ id, name }))
    };
  }

  async dispatch(action, input = {}) {
    if (action !== "select_run") {
      if (action === "refresh") { exactInput(input); return this.get(); }
      requireValue(this.runId, "selection_required", "Choose a new or saved rehearsal in this canvas before starting.");
      return this.engine.dispatch(this.runId, action, input);
    }
    exactInput(input, ["operation", "runId", "mode", "orderId"]);
    requireValue(["new", "resume"].includes(input.operation) && input.mode === "rehearsal" && validRunId(input.runId),
      "invalid_selection", "Choose New or Resume rehearsal and a valid run ID. Live assignments must be opened explicitly by staff.", 400);
    requireValue(input.operation === "new" ? this.engine.catalog.orders.some(order => order.id === input.orderId) : !Object.hasOwn(input, "orderId"),
      "invalid_selection", "Choose a catalog drink for a new rehearsal; resume uses the saved order.", 400);
    requireValue(!this.selecting, "selection_busy", "A run selection is already in progress. Refresh before trying again.");
    this.selecting = true;
    try {
      if (this.runId) {
        requireValue(this.runId === input.runId, "panel_conflict", "This panel already has an order. Open another panel for a different run.");
        const saved = await this.get();
        requireValue(saved.mode === input.mode && (!input.orderId || saved.order.id === input.orderId),
          "run_conflict", "The saved mode or order does not match. Keep the original assignment.");
        return saved;
      }
      if (input.operation === "resume") {
        const saved = await this.engine.get(input.runId);
        requireValue(saved.mode === "rehearsal", "run_conflict", "This is a live run. Staff must reopen it with its original live assignment.");
      }
      const run = await this.engine.open({ runId: input.runId, mode: "rehearsal", ...(input.operation === "new" ? { orderId: input.orderId } : {}) },
        { requireNew: input.operation === "new" });
      this.runId = run.runId;
      return run;
    } finally {
      this.selecting = false;
    }
  }
}
