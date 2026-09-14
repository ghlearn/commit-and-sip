import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DomainError, loadCatalog } from "./domain.mjs";
import { RunStore } from "./store.mjs";
import { RunEngine } from "./engine.mjs";
import { startServer } from "./server.mjs";
import { liveAdapters } from "./services/live.mjs";

const panels = new Map();
const catalog = await loadCatalog();
let config = {};
try {
  config = JSON.parse(await readFile(new URL("../../../booth/local-config.json", import.meta.url), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const directory = process.env.COMMIT_AND_SIP_DATA_DIR ??
  join(process.env.COPILOT_HOME ?? join(homedir(), ".copilot"), "extensions", "commit-and-sip", "artifacts");
if (!isAbsolute(directory)) throw new Error("COMMIT_AND_SIP_DATA_DIR must be an absolute staff-owned directory.");
const store = new RunStore(directory);
let engine;
let session;

async function guarded(fn) {
  try { return await fn(); }
  catch (error) {
    if (error instanceof DomainError) throw new CanvasError(error.code, error.message);
    await session?.log(`Commit & Sip service error: ${error.name}; inspect service configuration and retry.`, { level: "error" });
    throw new CanvasError("service_unavailable", "Commit & Sip could not reach a required service. Progress is preserved; ask booth staff to inspect configuration.");
  }
}

const empty = { type: "object", properties: {}, additionalProperties: false };
const actionSchemas = {
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
  start: "Load the assigned issue and PR (explicit rehearsal fixtures or configured live GitHub data).",
  refresh: "Read saved run progress without changing review evidence.",
  hint: "Show acceptance-criteria guidance; hints have no score penalty.",
  view: "Open a simulated review surface in rehearsal only; cannot certify live App views.",
  check_order: "Check price, serving style, and diff scope against the order.",
  approve: "Explicit approval decision, gated by review evidence and acceptance criteria; does not merge.",
  serve: "Apply the rehearsal menu or independently verify an already-authorized live merge.",
  complete: "Retry idempotent final result after a verified menu update."
};

engine = new RunEngine({ store, catalog, config });

session = await joinSession({
  requestedEnvironmentVariables: config.mode === "live" && config.completionEndpoint ? ["COMMIT_AND_SIP_COMPLETION_TOKEN"] : [],
  canvases: [createCanvas({
    id: "commit-and-sip",
    displayName: "Commit & Sip",
    description: "Order Up at the Level Up Lounge: a guided cafe PR-review exercise with explicit rehearsal and gated live modes.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$" },
        mode: { enum: ["rehearsal", "live"] },
        orderId: { enum: catalog.orders.map(order => order.id) }
      },
      required: ["runId", "mode"],
      additionalProperties: false
    },
    actions: Object.entries(actionSchemas).map(([name, inputSchema]) => ({
      name, description: descriptions[name], inputSchema,
      handler: ctx => guarded(async () => {
        const panel = panels.get(ctx.instanceId);
        if (!panel) throw new DomainError("panel_missing", "Reopen this canvas before continuing.");
        return engine.dispatch(panel.runId, name, ctx.input ?? {});
      })
    })),
    open: ctx => guarded(async () => {
      await engine.open(ctx.input);
      let panel = panels.get(ctx.instanceId);
      if (panel && panel.runId !== ctx.input.runId) {
        throw new DomainError("panel_conflict", "Open a new panel instance for a different run.");
      }
      if (!panel) {
        panel = {
          runId: ctx.input.runId,
          ...await startServer({
            engine, runId: ctx.input.runId,
            reportError: error => session?.log(`Commit & Sip HTTP service error: ${error.name}; check staff configuration.`, { level: "error" })
          })
        };
        panels.set(ctx.instanceId, panel);
      }
      return { title: `Commit & Sip · ${ctx.input.mode === "rehearsal" ? "Rehearsal" : "Live"}`, url: panel.url };
    }),
    onClose: async ctx => {
      const panel = panels.get(ctx.instanceId);
      if (panel) {
        panels.delete(ctx.instanceId);
        await panel.close();
      }
    }
  })]
});

if (config.mode === "live") {
  const adapters = liveAdapters(config, process.env.COMMIT_AND_SIP_COMPLETION_TOKEN);
  engine.github = adapters.github;
  engine.completion = adapters.completion;
}
