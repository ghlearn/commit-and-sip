import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomInt, randomUUID } from "node:crypto";

export class DomainError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function requireValue(condition, code, message, status) {
  if (!condition) throw new DomainError(code, message, status);
}

export function validRunId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id);
}

export function exactInput(input, fields = []) {
  requireValue(input && typeof input === "object" && !Array.isArray(input) &&
    Object.keys(input).every(key => fields.includes(key)),
  "invalid_input", "This action received unexpected input.", 400);
}

export async function loadCatalog() {
  const orders = JSON.parse(await readFile(new URL("../../../booth/orders.json", import.meta.url), "utf8"));
  const words = JSON.parse(await readFile(new URL("../../../booth/handle-words.json", import.meta.url), "utf8"));
  return { orders, words };
}

export function generateHandle(words, used) {
  for (let attempt = 0; attempt < 1024; attempt++) {
    const handle = [words.adjectives, words.verbs, words.nouns]
      .map(list => list[randomInt(list.length)]).join("-");
    if (!used.has(handle)) return handle;
  }
  // A suffix keeps the curated vocabulary when the finite phrase pool fills.
  let handle;
  do {
    handle = `${words.adjectives[0]}-${words.verbs[0]}-${words.nouns[0]}-${randomUUID().slice(0, 8)}`;
  } while (used.has(handle));
  return handle;
}

// The booth reads one optional staff file. Retired pull-request keys are
// rejected rather than ignored so a stale config cannot look configured.
const RETIRED_KEYS = ["mode", "runs", "repo", "requiredChecks"];

export function validateStaffConfig(config) {
  requireValue(config !== null && typeof config === "object" && !Array.isArray(config),
    "invalid_config", "Staff configuration must be a non-array JSON object.", 400);
  const retired = RETIRED_KEYS.filter(key => Object.hasOwn(config, key));
  requireValue(retired.length === 0, "retired_config",
    `Remove retired pull-request settings from booth/local-config.json: ${retired.join(", ")}.`, 400);
  requireValue(config.leaderboardUrl === undefined || typeof config.leaderboardUrl === "string",
    "invalid_config", "A configured leaderboardUrl must be a string.", 400);
  return config;
}

// On Windows a file's mode says nothing about who can read it; its ACL does.
// The path travels in an environment variable, never inside the script, so no
// file name can change what runs. Identities are compared as SIDs, which do
// not change with the system language the way group names do.
const WINDOWS_ACL = [
  "$ErrorActionPreference = 'Stop'",
  "$acl = Get-Acl -LiteralPath $env:SIP_ACL_FILE",
  "$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "$aces = @($acl.Access | ForEach-Object { @{ sid = $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; type = [string]$_.AccessControlType } })",
  "ConvertTo-Json -Compress -Depth 3 -InputObject @{ me = $me; aces = $aces }",
].join("\n");
// LocalSystem and the local Administrators group can read any file anyway.
const WINDOWS_PRIVILEGED = ["S-1-5-18", "S-1-5-32-544"];

// Whether a file can be read by anyone but its owner (and, on Windows, the
// accounts that can read everything regardless). Anything that cannot be
// verified counts as readable: the answer guards keys, so it fails closed.
export async function readableByOthers(file, { platform = process.platform, run = promisify(execFile), env = process.env } = {}) {
  const { mode } = await stat(file);
  if (platform !== "win32") return (mode & 0o077) !== 0;
  let acl;
  try {
    const path = file instanceof URL ? fileURLToPath(file) : String(file);
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL],
      { env: { ...env, SIP_ACL_FILE: path } });
    acl = JSON.parse(stdout);
  } catch {
    return true;
  }
  const me = acl?.me;
  const aces = [].concat(acl?.aces ?? []);
  if (typeof me !== "string" || !/^S-1-[0-9-]+$/.test(me) || aces.length === 0) return true;
  return aces.some(ace => typeof ace?.sid !== "string" || !["Allow", "Deny"].includes(ace?.type)
    || (ace.type === "Allow" && ace.sid !== me && !WINDOWS_PRIVILEGED.includes(ace.sid)));
}

// How to make a key file owner-only again, in the terms of the platform.
export function restrictAdvice(file, platform = process.platform) {
  return platform === "win32"
    ? `icacls "${file}" /inheritance:r /grant:r "%USERDOMAIN%\\%USERNAME%:F"`
    : `chmod 600 ${file}`;
}

// Shared by the extension and the staff scripts, so a takedown from the
// command line reaches the same leaderboard service the booth publishes to.
// A missing file means an unconfigured booth, which is a supported state.
//
// A file holding the service keys is accepted only while its owner alone can
// read it. The configurator always writes it that way; a copied or restored
// file may not be, and other users of the machine could then publish or take
// drinks down as this booth.
export async function loadStaffConfig(file = new URL("../../../booth/local-config.json", import.meta.url), access = {}) {
  let config;
  try {
    config = validateStaffConfig(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {};
  }
  if (config.leaderboardApi !== undefined && await readableByOthers(file, access)) {
    throw new DomainError("config_exposed", "booth/local-config.json holds the leaderboard keys and can be read by other "
      + "users of this machine, or that could not be verified, so it was not loaded. Restrict it: "
      + `${restrictAdvice("booth/local-config.json", access.platform)}. If anyone else `
      + "could have read it, treat the keys as exposed and rotate them (booth/RUNBOOK.md, Copying the keys to another machine).", 400);
  }
  return config;
}
