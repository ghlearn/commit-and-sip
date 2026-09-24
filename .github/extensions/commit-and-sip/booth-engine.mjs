import { DomainError, requireValue, exactInput, validRunId, generateHandle } from "./domain.mjs";
import { PLACEMENTS } from "./services/coffee-name.mjs";
import { addDrink, leaderboard, seedMenu, standingFor } from "./services/booth-menu.mjs";

// The booth flow is entirely canvas-driven: the attendee is given a handle,
// invents one drink, and sees their score and standing. It performs no GitHub
// review, approval, merge, or issue write, so it shares none of the live
// engine's evidence gates. It keeps its own phase machine deliberately rather
// than threading a second shape through the reviewed live engine.
const PHASES = ["naming", "served", "complete"];

export class BoothEngine {
  constructor({ store, catalog, rules, leaderboardUrl = null }) {
    // An unparseable or non-web destination would produce a QR that scans to
    // nothing, so it is refused at construction rather than shown to attendees.
    if (leaderboardUrl !== null) {
      let parsed = null;
      try { parsed = new URL(leaderboardUrl); } catch { parsed = null; }
      requireValue(parsed && (parsed.protocol === "https:" || parsed.protocol === "http:"),
        "invalid_leaderboard_url", "The configured leaderboard URL is not a valid web address.");
    }
    Object.assign(this, { store, catalog, rules, leaderboardUrl });
  }

  // The QR target is real only when staff have configured a deployed
  // leaderboard. With none configured this stays null and the canvas must say
  // so plainly rather than render a placeholder as a working code.
  attendeeUrl(run) {
    if (!this.leaderboardUrl || run.phase === "naming") return null;
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

  present(run, data) {
    const menu = this.houseMenu(data);
    return {
      attendeeUrl: this.attendeeUrl(run),
      completedAt: run.completedAt ?? null,
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
      placements: PLACEMENTS,
      runId: run.runId,
      statusMessage: run.statusMessage,
      submission: run.submission,
      standing: run.phase === "naming" ? null : standingFor(menu, run.runId),
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
        handle: run.handle, rawName: input.name, rules: this.rules, runId,
      });
      run.submission = {
        breakdown: entry.breakdown, id: entry.id, name: entry.name, placement: entry.placement,
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
