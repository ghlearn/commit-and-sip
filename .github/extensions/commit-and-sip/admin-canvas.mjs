import { DomainError, exactInput, requireValue } from "./domain.mjs";
import { AdminPanel } from "./admin-panel.mjs";
import { startServer } from "./server.mjs";
import { CLEAR_BOARD_CONFIRMATION, WIPE_CONFIRMATION } from "./services/event-archive.mjs";

const empty = { type: "object", properties: {}, additionalProperties: false };
const staffName = { type: "string", minLength: 1, maxLength: 80 };

// A second canvas rather than a mode of the first. The attendee canvas runs
// unattended on a screen facing a queue, so exporting, archiving and wiping
// must not be reachable from it even by a malformed action name. Staff open
// this one deliberately through the App.
export function adminCanvasDefinition({ engine, guarded = fn => fn(), reportError = () => {} }) {
  const panels = new Map();
  const opening = new Set();
  const actions = {
    refresh: [empty, "Read the event totals, house menu, removals, and moderation readiness."],
    export_results: [{
      type: "object", properties: { exportedBy: staffName },
      required: ["exportedBy"], additionalProperties: false
    }, "Write the current results to a staff file. Changes nothing and is safe to run at any time."],
    remove_drink: [{
      type: "object",
      properties: { id: { type: "string", minLength: 1, maxLength: 80 }, reason: { type: "string", minLength: 1, maxLength: 200 }, removedBy: staffName },
      required: ["id", "reason", "removedBy"], additionalProperties: false
    }, "Take a drink off the house menu. The name stays reserved and cannot be resubmitted."],
    close_station: [{
      type: "object",
      properties: { runId: { type: "string", minLength: 1, maxLength: 120 }, closedBy: staffName },
      required: ["runId", "closedBy"], additionalProperties: false
    }, "End the turn of an attendee who walked away. Any drink they already served stays on the menu."],
    archive_and_wipe: [{
      type: "object",
      properties: { archivedBy: staffName, confirm: { const: WIPE_CONFIRMATION } },
      required: ["archivedBy", "confirm"], additionalProperties: false
    }, `Archive the whole event and reset the booth for the next one. Destructive: requires confirm "${WIPE_CONFIRMATION}".`],
    check_public_board: [empty, "Read what the shared public leaderboard holds now, and which board it is, before clearing it."],
    clear_public_board: [{
      type: "object",
      properties: { boardId: { type: "string", pattern: "^[0-9a-f]{32}$" }, clearedBy: staffName, confirm: { const: CLEAR_BOARD_CONFIRMATION } },
      required: ["boardId", "clearedBy", "confirm"], additionalProperties: false
    }, `Empty the public leaderboard for every booth, after this booth has ended its event. Destructive: requires the boardId from check_public_board and confirm "${CLEAR_BOARD_CONFIRMATION}".`],
  };
  return {
    id: "commit-and-sip-admin",
    displayName: "Commit & Sip · Booth staff",
    description: "Staff dashboard for one booth machine: event totals, results export, drink takedown, and end-of-event archive and reset.",
    inputSchema: { type: "object", maxProperties: 0 },
    actions: Object.entries(actions).map(([name, [inputSchema, description]]) => ({
      name, description, inputSchema,
      handler: ctx => guarded(async () => {
        const panel = panels.get(ctx.instanceId);
        if (!panel) throw new DomainError("panel_missing", "Reopen this dashboard before continuing.");
        return panel.dispatch(name, ctx.input ?? {});
      })
    })),
    open: ctx => guarded(async () => {
      exactInput(ctx.input === undefined ? {} : ctx.input);
      requireValue(!opening.has(ctx.instanceId), "panel_busy", "This dashboard is opening. Retry after it connects.");
      opening.add(ctx.instanceId);
      try {
        let panel = panels.get(ctx.instanceId);
        if (!panel) {
          panel = await startServer({
            engine, home: "admin.html", panel: new AdminPanel(engine), reportError, script: "admin.js",
          });
          panels.set(ctx.instanceId, panel);
        }
        return { title: "Commit & Sip · Booth staff", url: panel.url };
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
