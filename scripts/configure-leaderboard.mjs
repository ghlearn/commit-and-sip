import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { guardNodeVersion } from "./require-node.mjs";
import { DomainError, readableByOthers, validateStaffConfig } from "../.github/extensions/commit-and-sip/domain.mjs";
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
const execFileAsync = promisify(execFile);
const newKey = () => randomBytes(32).toString("hex");

async function readJson(file) {
  let value;
  try { value = JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  // Checked before any property is read: `null` or an array is valid JSON,
  // and would otherwise surface as a TypeError instead of saying what is wrong.
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("invalid_config", `${file} must hold a JSON object.`, 400);
  }
  return value;
}

// A present but malformed leaderboardApi is an error, not a machine with no
// keys: reading it as empty would mint keys the deployed service rejects.
function apiOf(config, file) {
  const api = config.leaderboardApi;
  if (api === undefined) return {};
  if (api === null || typeof api !== "object" || Array.isArray(api)) {
    throw new DomainError("invalid_config", `${file} has a leaderboardApi that is not an object.`, 400);
  }
  return api;
}

// The file keys are copied from is a second copy of them. It must be readable
// by its owner only while it exists, and deleted once they are copied. On
// Windows, POSIX modes say nothing about ACLs, so this cannot be checked there.
async function assertPrivateSource(file, platform) {
  let exposed;
  try { exposed = await readableByOthers(file, { platform }); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error(`${file} does not exist.`);
    throw error;
  }
  if (exposed) {
    throw new Error(`${file} can be read by other users of this machine, and it holds the service keys. `
      + `Restrict it first (chmod 600 ${file}), run this again, then delete it.`);
  }
}

// Makes a file readable by its owner only, before anything secret is in it.
// On Windows, POSIX modes do not set ACLs, so inheritance is removed and only
// the current user is granted access with icacls. If that cannot be done, the
// caller writes nothing.
export async function restrictToOwner(path, { platform = process.platform, run = execFileAsync, env = process.env } = {}) {
  if (platform !== "win32") {
    await chmod(path, 0o600);   // in case the umask left it narrower than intended, never wider
    return;
  }
  const user = env.USERNAME && (env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME);
  if (!user) throw new Error("Cannot tell which Windows user to restrict the key file to, so no keys were written.");
  await run("icacls", [path, "/inheritance:r", "/grant:r", `${user}:F`]);
}

// The keys are written only into a new file that is private from the moment
// it exists, and that file then replaces the target in one rename. Writing
// into the existing file would not work: `mode` applies only when a file is
// created, so an older, readable local-config.json would hold both keys until
// a later chmod, and would keep holding them if that chmod failed. A rename
// within one volume keeps the new file's owner-only permissions or ACL.
async function writePrivate(file, value, access = {}) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, "", { flag: "wx", mode: 0o600 });
    await restrictToOwner(temporary, access);
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function configure({ url, staff = true, configFile, parametersFile, from = null, key = newKey, access = {} }) {
  const config = await readJson(configFile);
  const existing = apiOf(config, configFile);
  let source = existing;
  if (from !== null) {
    await assertPrivateSource(from, access.platform ?? process.platform);
    source = apiOf(await readJson(from), from);
    if (!source.boothKey || (staff && !source.staffKey)) {
      throw new Error(`${from} has no ${source.boothKey ? "staffKey" : "leaderboardApi keys"} to copy. Use the booth/local-config.json of a staff machine.`);
    }
  }
  const fresh = !source.boothKey;
  if (!fresh && staff && !source.staffKey) {
    throw new Error("This machine has a booth key but no staff key. A new staff key would not match the deployed "
      + "service, and redeploying to add one would lock out every other staff machine. Copy the keys from a staff "
      + "machine instead: npm run leaderboard:configure -- --url <url> --from <an owner-only (chmod 600) copy of that machine's booth/local-config.json>, then delete that copy.");
  }
  const api = {
    url,
    boothKey: source.boothKey ?? key(),
    ...(staff ? { staffKey: source.staffKey ?? key() } : {}),
  };
  validateLeaderboardApi(api);
  const next = validateStaffConfig({ ...config, leaderboardApi: api });
  await writePrivate(configFile, next, access);
  if (parametersFile) {
    if (!api.staffKey) throw new Error("The deployment needs the staff key. Run this on a staff machine without --no-staff-key.");
    await writePrivate(parametersFile, {
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
      contentVersion: "1.0.0.0",
      parameters: { boothKey: { value: api.boothKey }, staffKey: { value: api.staffKey } },
    }, access);
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

// What the command tells the operator, including what to delete afterwards.
export function report({ copied, from, generated, parametersFile, removed, staff }) {
  const kept = ["boothKey", "staffKey"].filter(key => !generated.includes(key) && !removed.includes(key)
    && !copied.includes(key) && (key === "boothKey" || staff));
  return (generated.length
    ? `Generated ${generated.join(" and ")} in booth/local-config.json. Redeploy the infrastructure so the service accepts ${generated.length === 1 ? "it" : "them"}.\n`
    : "")
    + (copied.length ? `Copied ${copied.join(" and ")} from ${from}. They match the deployed service; no redeploy is needed.\n` : "")
    + (from ? `Delete ${from} now: it is a second copy of the keys, and this machine no longer needs it.\n` : "")
    + (kept.length ? `Kept the existing ${kept.join(" and ")}.\n` : "")
    + (removed.length ? "Removed the staffKey: this machine can now publish but not take drinks down.\n" : "")
    + (parametersFile ? "Wrote dist/leaderboard.secure.parameters.json for the deployment. Delete it once deployed.\n" : "")
    + "leaderboardUrl (the attendee QR code) was not changed.\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const parametersFile = args.parameters ? resolve(root, "dist", "leaderboard.secure.parameters.json") : null;
    const { copied, generated, removed } = await configure({
      configFile: resolve(root, "booth", "local-config.json"), from: args.from, parametersFile, staff: args.staff, url: args.url,
    });
    process.stdout.write(report({ copied, from: args.from, generated, parametersFile, removed, staff: args.staff }));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
