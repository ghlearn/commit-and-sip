import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pilotFixture } from "./canvas-pilot.mjs";
import { startServer } from "../../.github/extensions/commit-and-sip/server.mjs";

// Run only for browser validation. All GitHub responses and writes are mocked.
const directory = await mkdtemp(join(tmpdir(), "sip-browser-mocked-"));
const pilot = await pilotFixture(join(directory, "pilot"));
const controls = join(directory, "mocked-transport-controls.json");
const inspect = pilot.engine.github.inspectPullRequest;
pilot.engine.github.inspectPullRequest = async (...args) => {
  let values = {};
  try { values = JSON.parse(await readFile(controls, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  pilot.remote.merged = values.authorizedMockMerge === true;
  pilot.remote.checksPassed = values.checksPassed !== false;
  return inspect(...args);
};
await pilot.open();
const entry = await startServer({ engine: pilot.engine, runId: pilot.input.runId });
const native = await pilotFixture(join(directory, "native"));
native.config.mode = "live";
delete native.assignment.reviewSource;
native.engine.viewEvidence = null;
await native.engine.open({ ...native.input, mode: "live" });
const nativeEntry = await startServer({ engine: native.engine, runId: native.input.runId });
const rehearsal = await pilotFixture(join(directory, "rehearsal"));
await rehearsal.engine.open({ runId: "mocked-rehearsal", mode: "rehearsal", orderId: "mona-latte" });
const rehearsalEntry = await startServer({ engine: rehearsal.engine, runId: "mocked-rehearsal" });
console.log(JSON.stringify({ fixture: "MOCKED TRANSPORT ONLY", directory, controls,
  pilot: entry.url, native: nativeEntry.url, rehearsal: rehearsalEntry.url }));
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => {
  await Promise.all([entry.close(), nativeEntry.close(), rehearsalEntry.close()]);
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
});
