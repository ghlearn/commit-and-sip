import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { guardNodeVersion } from "./require-node.mjs";
import { validateStaffConfig } from "../.github/extensions/commit-and-sip/domain.mjs";
import { validateLeaderboardApi } from "../.github/extensions/commit-and-sip/services/leaderboard-client.mjs";

guardNodeVersion();

// Points this booth at the leaderboard service and prepares its deployment.
//
// booth/local-config.json is the one place the two API keys live. This writes
// them there (generating them the first time and keeping them after that), and
// writes the secure deployment parameters the Bicep needs from the same keys.
// Both files are readable by this user only and neither is committed.
//
// It deliberately does not set leaderboardUrl. That setting puts a QR code in
// front of attendees, and it waits for the blocklist review and brand sign-off.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const newKey = () => randomBytes(32).toString("hex");

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writePrivate(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  // writeFile's mode applies only when it creates the file.
  await chmod(file, 0o600);
}

export async function configure({ url, staff = true, configFile, parametersFile, key = newKey }) {
  const config = await readJson(configFile);
  const existing = config.leaderboardApi ?? {};
  const api = {
    url,
    boothKey: existing.boothKey ?? key(),
    ...(staff ? { staffKey: existing.staffKey ?? key() } : {}),
  };
  validateLeaderboardApi(api);
  const next = validateStaffConfig({ ...config, leaderboardApi: api });
  await writePrivate(configFile, next);
  if (parametersFile) {
    if (!api.staffKey) throw new Error("The deployment needs the staff key. Run this on a staff machine without --no-staff-key.");
    await writePrivate(parametersFile, {
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
      contentVersion: "1.0.0.0",
      parameters: { boothKey: { value: api.boothKey }, staffKey: { value: api.staffKey } },
    });
  }
  // Which keys are new. A booth-only machine promoted to staff keeps its booth
  // key and gains a staff key, and the deployment must be told about that one.
  const generated = [
    ...(existing.boothKey ? [] : ["boothKey"]),
    ...(staff && !existing.staffKey ? ["staffKey"] : []),
  ];
  return { generated, next };
}

export function parseArguments(argv) {
  const args = { parameters: true, staff: true, url: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--no-staff-key") { args.staff = false; args.parameters = false; continue; }
    if (flag === "--url") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--url needs a value.");
      args.url = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option ${flag}.`);
  }
  if (!args.url) throw new Error("Usage: npm run leaderboard:configure -- --url https://<app>.azurewebsites.net [--no-staff-key]");
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const parametersFile = args.parameters ? resolve(root, "dist", "leaderboard.secure.parameters.json") : null;
    const { generated } = await configure({
      configFile: resolve(root, "booth", "local-config.json"), parametersFile, staff: args.staff, url: args.url,
    });
    process.stdout.write((generated.length
      ? `Generated ${generated.join(" and ")} in booth/local-config.json. Redeploy the infrastructure so the service accepts ${generated.length === 1 ? "it" : "them"}.\n`
      : "Kept the existing leaderboard keys in booth/local-config.json.\n")
      + (parametersFile ? "Wrote dist/leaderboard.secure.parameters.json for the deployment. Delete it once deployed.\n" : "")
      + "leaderboardUrl (the attendee QR code) was not changed.\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
