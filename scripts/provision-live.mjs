import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DomainError, loadCatalog } from "../.github/extensions/commit-and-sip/domain.mjs";
import { RunStore } from "../.github/extensions/commit-and-sip/store.mjs";
import { GithubAdapter, GithubError } from "../.github/extensions/commit-and-sip/services/github.mjs";
import { LiveProvisioner } from "../.github/extensions/commit-and-sip/services/provision.mjs";
import { StaffConfigFile } from "../.github/extensions/commit-and-sip/services/staff-config.mjs";

const usage = "Usage: npm run provision:live -- --run RUN_ID --pr NUMBER --head FULL_SHA --base BRANCH --reviewer LOGIN --order ORDER_ID [--review-source native|canvas-pilot] [--config STAFF_CONFIG_PATH] [--apply]. Default: native read-only preview. canvas-pilot explicitly provisions an unranked assignment; configuration mode is never changed.";
try {
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!["--run", "--pr", "--head", "--base", "--reviewer", "--order", "--review-source", "--config", "--apply"].includes(key) ||
      Object.hasOwn(options, key)) throw new DomainError("usage", usage, 400);
    options[key] = key === "--apply" ? true : args[++i];
    if (!options[key] || (typeof options[key] === "string" && options[key].startsWith("--"))) {
      throw new DomainError("usage", usage, 400);
    }
  }
  if (!["--run", "--pr", "--head", "--base", "--reviewer", "--order"].every(key => options[key]) ||
    !/^[1-9][0-9]*$/.test(options["--pr"]) ||
    (options["--review-source"] !== undefined && !["native", "canvas-pilot"].includes(options["--review-source"]))) {
    throw new DomainError("usage", usage, 400);
  }
  const directory = process.env.COMMIT_AND_SIP_DATA_DIR ??
    join(process.env.COPILOT_HOME ?? join(homedir(), ".copilot"), "extensions", "commit-and-sip", "artifacts");
  if (!isAbsolute(directory)) throw new DomainError("invalid_store", "Use an absolute staff-owned COMMIT_AND_SIP_DATA_DIR.", 400);
  const configFile = new StaffConfigFile(resolve(options["--config"] ?? "booth/local-config.json"));
  const config = await configFile.read();
  const provisioner = new LiveProvisioner({
    store: new RunStore(directory), catalog: await loadCatalog(),
    github: new GithubAdapter({ repo: config.repo }), configFile
  });
  const report = await provisioner.provision({
    runId: options["--run"], prNumber: Number(options["--pr"]), headSha: options["--head"],
    baseRef: options["--base"], reviewer: options["--reviewer"], orderId: options["--order"],
    ...(options["--review-source"] === undefined ? {} : { reviewSource: options["--review-source"] })
  }, { apply: options["--apply"] === true });
  const { reviewer, ...assignment } = report.assignment;
  process.stdout.write(`${JSON.stringify({ ...report, assignment }, null, 2)}\n`);
} catch (error) {
  if (error instanceof DomainError || error instanceof GithubError) {
    process.stderr.write(`Live provisioning stopped (${error.code}): ${error.message}\n`);
  } else {
    process.stderr.write("Live provisioning stopped: staff configuration/storage is unavailable or invalid. Preserve the journal and retry this exact run after staff recovery; remote writes may require reconciliation.\n");
  }
  process.exitCode = 1;
}
