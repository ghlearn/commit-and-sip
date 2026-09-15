import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DomainError, loadCatalog, validateStaffConfig } from "./domain.mjs";
import { RunStore } from "./store.mjs";
import { RunEngine } from "./engine.mjs";
import { canvasDefinition } from "./canvas.mjs";
import { liveAdapters } from "./services/live.mjs";

const catalog = await loadCatalog();
let config = {};
try {
  config = validateStaffConfig(JSON.parse(await readFile(new URL("../../../booth/local-config.json", import.meta.url), "utf8")));
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

engine = new RunEngine({ store, catalog, config });

session = await joinSession({
  requestedEnvironmentVariables: config.mode === "live" && config.completionEndpoint ? ["COMMIT_AND_SIP_COMPLETION_TOKEN"] : [],
  canvases: [createCanvas(canvasDefinition({
    engine, guarded,
    reportError: error => session?.log(`Commit & Sip HTTP service error: ${error.name}; check staff configuration.`, { level: "error" })
  }))]
});

if (config.mode === "live") {
  const adapters = liveAdapters(config, process.env.COMMIT_AND_SIP_COMPLETION_TOKEN);
  engine.github = adapters.github;
  engine.completion = adapters.completion;
}
