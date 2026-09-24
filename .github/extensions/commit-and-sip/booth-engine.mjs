import { DomainError, requireValue, exactInput, validRunId, generateHandle } from "./domain.mjs";
import { addDrink, leaderboard, seedMenu, standingFor } from "./services/booth-menu.mjs";

// The booth flow is entirely canvas-driven: the attendee is given a handle,
// invents one drink, and sees their score and standing. It performs no GitHub
// review, approval, merge, or issue write, so it shares none of the live
// engine's evidence gates. It keeps its own phase machine deliberately rather
// than threading a second shape through the reviewed live engine.
const PHASES = ["naming", "served"];

export class BoothEngine {
  constructor({ store, catalog, rules, leaderboardUrl = null }) {
    Object.assign(this, { store, catalog, rules, leaderboardUrl });
  }

  // The menu lives alongside runs in the same ledger, defaulted so an existing
  // ledger written before the booth flow still loads.
  houseMenu(data) {
    if (!Array.isArray(data.menu) || data.menu.length === 0) data.menu = seedMenu(this.catalog);
    return data.menu;
  }

  present(run, data) {
    const menu = this.houseMenu(data);
    return {
      createdAt: run.createdAt,
      handle: run.handle,
      // The attendee's handle is shown from the very start so they can note it
      // down and find themselves on the leaderboard later.
      houseMenu: menu.map(({ artwork, example, id, name, price, serving }) =>
        ({ artwork, example, id, name, price, serving })),
      leaderboard: leaderboard(menu),
      leaderboardUrl: this.leaderboardUrl,
      mascots: this.rules.mascots,
      phase: run.phase,
      runId: run.runId,
      statusMessage: run.statusMessage,
      submission: run.submission,
      standing: run.phase === "served" ? standingFor(menu, run.runId) : null,
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

  async dispatch(runId, action, input = {}) {
    requireValue(validRunId(runId), "invalid_run", "Invalid run ID.", 400);
    if (action === "refresh") { exactInput(input); return this.get(runId); }
    requireValue(action === "submit_name", "unknown_action", "That action is not available at this booth.", 400);
    exactInput(input, ["name"]);
    return this.store.transaction(data => {
      const run = Object.hasOwn(data.runs, runId) ? data.runs[runId] : null;
      requireValue(run, "run_missing", "That run does not exist. Start a new one.", 404);
      requireValue(run.mode === "booth", "run_conflict", "That run belongs to a different exercise mode.");
      requireValue(PHASES.includes(run.phase), "invalid_phase", "This run has an unusable state. Ask booth staff.");
      // One drink per attendee keeps the competition fair and the menu readable.
      requireValue(run.phase === "naming", "already_served",
        "You have already added your drink. Each attendee invents one.", 409);

      const entry = addDrink(this.houseMenu(data), {
        handle: run.handle, rawName: input.name, rules: this.rules, runId,
      });
      run.submission = {
        breakdown: entry.breakdown, id: entry.id, name: entry.name,
        price: entry.price, score: entry.score, serving: entry.serving,
      };
      run.phase = "served";
      run.events.push({ type: "served", at: entry.createdAt });
      run.statusMessage = `${entry.name} is on the menu and scored ${entry.score} out of 5000.`;
      return this.present(run, data);
    });
  }
}

export { DomainError };
