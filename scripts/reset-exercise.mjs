import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { RunStore } from "../.github/extensions/commit-and-sip/store.mjs";
import { RunEngine } from "../.github/extensions/commit-and-sip/engine.mjs";
import { loadCatalog } from "../.github/extensions/commit-and-sip/domain.mjs";

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--new-run" || args[2] !== "--order") {
  throw new Error("Usage: npm run reset -- --new-run UNIQUE_RUN_ID --order mona-latte|copilot-cortado|ducky-cold-brew. Creates rehearsal only; never deletes results.");
}
const directory = process.env.COMMIT_AND_SIP_DATA_DIR ??
  join(process.env.COPILOT_HOME ?? join(homedir(), ".copilot"), "extensions", "commit-and-sip", "artifacts");
if (!isAbsolute(directory)) throw new Error("COMMIT_AND_SIP_DATA_DIR must be an absolute, staff-owned storage directory.");
const store = new RunStore(directory);
const engine = new RunEngine({ store, catalog: await loadCatalog() });
await engine.open({ runId: args[1], mode: "rehearsal", orderId: args[3] }, { requireNew: true });
process.stdout.write(`Fresh rehearsal order saved. Open canvas commit-and-sip with ${JSON.stringify({ runId: args[1], mode: "rehearsal", orderId: args[3] })}\n`);
