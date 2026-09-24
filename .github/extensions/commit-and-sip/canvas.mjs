import { DomainError, exactInput, requireValue } from "./domain.mjs";
import { PLACEMENTS } from "./services/coffee-name.mjs";
import { BoothPanel } from "./booth-panel.mjs";
import { startServer } from "./server.mjs";

const empty = { type: "object", properties: {}, additionalProperties: false };

export function boothCanvasDefinition({ engine, guarded = fn => fn(), reportError = () => {} }) {
  const panels = new Map();
  const opening = new Set();
  const boothActions = {
    begin: [empty, "Mint a barista handle and start one attendee's order at this station."],
    submit_name: [{
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 80 },
        mascot: { enum: engine.rules.mascots },
        placement: { enum: PLACEMENTS }
      },
      required: ["name"], additionalProperties: false
    }, "Add the attendee's invented drink to the house menu and score it. A declared mascot or placement is checked against the name."],
    complete: [empty, "Finish this attendee and clear the station for the next one. The drink stays on the menu and leaderboard."],
    refresh: [empty, "Read the current station state, house menu, and leaderboard."]
  };
  return {
    id: "commit-and-sip",
    displayName: "Commit & Sip",
    description: "Run the booth naming competition: one attendee invents one coffee, a rubric scores it, and it joins the house menu.",
    inputSchema: { type: "object", maxProperties: 0 },
    actions: Object.entries(boothActions).map(([name, [inputSchema, description]]) => ({
      name, description, inputSchema,
      handler: ctx => guarded(async () => {
        const panel = panels.get(ctx.instanceId);
        if (!panel) throw new DomainError("panel_missing", "Reopen this canvas before continuing.");
        return panel.dispatch(name, ctx.input ?? {});
      })
    })),
    open: ctx => guarded(async () => {
      exactInput(ctx.input === undefined ? {} : ctx.input);
      requireValue(!opening.has(ctx.instanceId), "panel_busy", "This panel is opening. Retry after it connects.");
      opening.add(ctx.instanceId);
      try {
        let panel = panels.get(ctx.instanceId);
        if (!panel) {
          panel = await startServer({ engine, panel: new BoothPanel(engine), home: "booth.html", reportError });
          panels.set(ctx.instanceId, panel);
        }
        const state = await panel.get();
        return {
          title: `Commit & Sip · ${state.phase === "idle" ? "Name a drink" : state.phase === "naming" ? "Inventing" : "Scored"}`,
          url: panel.url
        };
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
