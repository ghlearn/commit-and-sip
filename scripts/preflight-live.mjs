import { readFile } from "node:fs/promises";
import { DomainError, loadCatalog } from "../.github/extensions/commit-and-sip/domain.mjs";
import { GithubAdapter, GithubError } from "../.github/extensions/commit-and-sip/services/github.mjs";
import { inspectLivePilot } from "../.github/extensions/commit-and-sip/services/pilot.mjs";

const args = process.argv.slice(2);
try {
  if (![2, 4].includes(args.length) || args[0] !== "--run" || (args.length === 4 && args[2] !== "--config")) {
    throw new DomainError("usage", "Usage: npm run preflight:live -- --run RUN_ID [--config STAFF_CONFIG_PATH]", 400);
  }
  const config = JSON.parse(await readFile(args[3] ?? "booth/local-config.json", "utf8"));
  const report = await inspectLivePilot({ config, catalog: await loadCatalog(), runId: args[1], github: new GithubAdapter({ repo: config.repo }) });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = 2;
} catch (error) {
  if (error instanceof DomainError || error instanceof GithubError) {
    process.stderr.write(`Live preflight failed (${error.code}): ${error.message}\n`);
  } else if (error.code === "ENOENT" || error instanceof SyntaxError) {
    process.stderr.write("Live preflight failed: supply an existing staff configuration file containing valid JSON. No GitHub writes were attempted.\n");
  } else throw error;
  process.exitCode = 1;
}
