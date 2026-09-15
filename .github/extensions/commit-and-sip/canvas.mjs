import { DomainError, exactInput, requireValue, validRunId } from "./domain.mjs";
import { startServer } from "./server.mjs";

const empty = { type: "object", properties: {}, additionalProperties: false };
const selectionProperties = {
  runId: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$" },
  mode: { const: "rehearsal" }
};
const actionSchemas = {
  select_run: {
    type: "object",
    oneOf: [
      {
        properties: { ...selectionProperties, operation: { const: "new" }, orderId: { type: "string" } },
        required: ["operation", "runId", "mode", "orderId"], additionalProperties: false
      },
      {
        properties: { ...selectionProperties, operation: { const: "resume" } },
        required: ["operation", "runId", "mode"], additionalProperties: false
      }
    ]
  },
  start: empty, refresh: empty, hint: empty, approve: empty, serve: empty, complete: empty,
  view: { type: "object", properties: { surface: { enum: ["summary", "changes", "checks"] } }, required: ["surface"], additionalProperties: false },
  check_order: {
    type: "object", properties: {
      price: { type: "number", minimum: 0, maximum: 100 },
      serving: { enum: ["hot", "cold"] }, scope: { enum: ["one-drink", "unrelated-edits"] }
    }, required: ["price", "serving", "scope"], additionalProperties: false
  }
};
const descriptions = {
  select_run: "Explicitly create or resume a rehearsal from the setup screen; never resets a run or falls back from live.",
  start: "Load the assigned issue and PR (explicit rehearsal fixtures or configured live GitHub data).",
  refresh: "Read saved run progress without changing review evidence.",
  hint: "Show acceptance-criteria guidance; hints have no score penalty.",
  view: "Open a simulated review surface in rehearsal only; cannot certify live App views.",
  check_order: "Check price, serving style, and diff scope against the order.",
  approve: "Explicit approval decision, gated by review evidence and acceptance criteria; does not merge.",
  serve: "Apply the rehearsal menu or independently verify an already-authorized live merge.",
  complete: "Retry idempotent final result after a verified menu update."
};

export function canvasDefinition({ engine, guarded = fn => fn(), reportError = () => {} }) {
  const panels = new Map();
  const opening = new Set();
  const inputSchema = {
    type: "object",
    oneOf: [
      { maxProperties: 0 },
      {
        properties: {
          runId: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$" },
          mode: { enum: ["rehearsal", "live"] },
          orderId: { enum: engine.catalog.orders.map(order => order.id) }
        },
        required: ["runId", "mode"], additionalProperties: false
      }
    ]
  };
  return {
    id: "commit-and-sip",
    displayName: "Commit & Sip",
    description: "Open the cafe setup screen, or resume an assigned run for the one-step PR-review exercise.",
    inputSchema,
    actions: Object.entries(actionSchemas).map(([name, inputSchema]) => ({
      name, description: descriptions[name], inputSchema,
      handler: ctx => guarded(async () => {
        const panel = panels.get(ctx.instanceId);
        if (!panel) throw new DomainError("panel_missing", "Reopen this canvas before continuing.");
        return panel.dispatch(name, ctx.input ?? {});
      })
    })),
    open: ctx => guarded(async () => {
      const input = ctx.input === undefined ? {} : ctx.input;
      exactInput(input, ["runId", "mode", "orderId"]);
      const assigned = Object.keys(input).length > 0;
      if (assigned) {
        requireValue(validRunId(input.runId) && ["rehearsal", "live"].includes(input.mode),
          "invalid_assignment", "Supply both runId and mode, or open with no input to choose a rehearsal.", 400);
        requireValue(!Object.hasOwn(input, "orderId") || engine.catalog.orders.some(order => order.id === input.orderId),
          "invalid_order", "Use an order from the booth catalog.", 400);
      }
      requireValue(!opening.has(ctx.instanceId), "panel_busy", "This panel is opening. Retry after it connects.");
      opening.add(ctx.instanceId);
      try {
        let panel = panels.get(ctx.instanceId);
        if (panel && assigned) {
          requireValue(panel.runId === input.runId, "panel_conflict", "Open a new panel instance for a different run.");
          await engine.open(input);
        }
        if (!panel) {
          if (assigned) await engine.open(input);
          panel = await startServer({ engine, runId: assigned ? input.runId : null, reportError });
          panels.set(ctx.instanceId, panel);
        }
        const state = await panel.get();
        return { title: `Commit & Sip · ${state.mode === "live" ? "Live" : state.mode === "rehearsal" ? "Rehearsal" : "Choose an order"}`, url: panel.url };
      } finally {
        opening.delete(ctx.instanceId);
      }
    }),
    onClose: async ctx => {
      const panel = panels.get(ctx.instanceId);
      if (panel) {
        panels.delete(ctx.instanceId);
        await panel.close();
      }
    }
  };
}
