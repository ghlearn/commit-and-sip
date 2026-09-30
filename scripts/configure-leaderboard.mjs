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

// Keys are generated only for a brand-new deployment, when this machine has no
// booth key yet. After that, the service holds these exact keys, and a freshly
// generated staff key would be refused. Redeploying to accept it would lock
// out every other staff machine. So a booth-only machine becomes a staff
// machine by copying the deployed keys from one that already has them
// (`from`: that machine's booth/local-config.json, moved over a private
// channel), never by minting new ones.
export async function configure({ url, staff = true, configFile, parametersFile, from = null, key = newKey }) {
  const config = await readJson(configFile);
  const existing = config.leaderboardApi ?? {};
  let source = existing;
  if (from !== null) {
    source = (await readJson(from)).leaderboardApi ?? {};
    if (!source.boothKey || (staff && !source.staffKey)) {
      throw new Error(`${from} has no ${source.boothKey ? "staffKey" : "leaderboardApi keys"} to copy. Use the booth/local-config.json of a staff machine.`);
    }
  }
  const fresh = !source.boothKey;
  if (!fresh && staff && !source.staffKey) {
    throw new Error("This machine has a booth key but no staff key. A new staff key would not match the deployed "
      + "service, and redeploying to add one would lock out every other staff machine. Copy the keys from a staff "
      + "machine instead: npm run leaderboard:configure -- --url <url> --from <that machine's booth/local-config.json>");
  }
  const api = {
    url,
    boothKey: source.boothKey ?? key(),
    ...(staff ? { staffKey: source.staffKey ?? key() } : {}),
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
  // What changed on this machine: keys newly generated (fresh setup only),
  // copied from another machine, or removed by --no-staff-key.
  const generated = fresh ? ["boothKey", ...(staff ? ["staffKey"] : [])] : [];
  const copied = from === null ? [] : ["boothKey", "staffKey"].filter(name => api[name] && api[name] !== existing[name]);
  const removed = !staff && existing.staffKey ? ["staffKey"] : [];
  return { copied, generated, next, removed };
}

export function parseArguments(argv) {
  const args = { from: null, parameters: true, staff: true, url: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--no-staff-key") { args.staff = false; args.parameters = false; continue; }
    if (flag === "--url" || flag === "--from") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
      args[flag.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option ${flag}.`);
  }
  if (!args.url) throw new Error("Usage: npm run leaderboard:configure -- --url https://<app>.azurewebsites.net [--from <staff machine's booth/local-config.json>] [--no-staff-key]");
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const parametersFile = args.parameters ? resolve(root, "dist", "leaderboard.secure.parameters.json") : null;
    const { copied, generated, removed } = await configure({
      configFile: resolve(root, "booth", "local-config.json"), from: args.from, parametersFile, staff: args.staff, url: args.url,
    });
    const kept = ["boothKey", "staffKey"].filter(key => !generated.includes(key) && !removed.includes(key)
      && !copied.includes(key) && (key === "boothKey" || args.staff));
    process.stdout.write((generated.length
      ? `Generated ${generated.join(" and ")} in booth/local-config.json. Redeploy the infrastructure so the service accepts ${generated.length === 1 ? "it" : "them"}.\n`
      : "")
      + (copied.length ? `Copied ${copied.join(" and ")} from ${args.from}. They match the deployed service; no redeploy is needed.\n` : "")
      + (kept.length ? `Kept the existing ${kept.join(" and ")}.\n` : "")
      + (removed.length ? "Removed the staffKey: this machine can now publish but not take drinks down.\n" : "")
      + (parametersFile ? "Wrote dist/leaderboard.secure.parameters.json for the deployment. Delete it once deployed.\n" : "")
      + "leaderboardUrl (the attendee QR code) was not changed.\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
