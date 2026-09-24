import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function requiredMajor(range) {
  const match = /^>=\s*(\d+)(?:\.|\s|$)/.exec(String(range ?? "").trim());
  if (!match) throw new Error(`Unsupported engines.node range: ${JSON.stringify(range)}`);
  return Number(match[1]);
}

export function evaluateNodeVersion(version, range) {
  const match = /^v?(\d+)(?:\.|$)/.exec(String(version ?? "").trim());
  if (!match) throw new Error(`Unrecognized Node version: ${JSON.stringify(version)}`);
  const required = requiredMajor(range);
  const actual = Number(match[1]);
  return { supported: actual >= required, required, actual };
}

export function unsupportedNodeMessage({ required, actual }) {
  return [
    `Node ${actual} is not supported; this repository requires Node >=${required}.`,
    "Older runtimes do not fail cleanly here: the loopback fetch suites keep experimental",
    "undici handles open, so `npm test` hangs indefinitely instead of reporting failures.",
    "",
    "Switch versions before rerunning:",
    "  nvm use              # reads .nvmrc",
    `  nvm install ${required}       # if that version is missing`,
    "",
    `Current interpreter: ${process.execPath}`,
  ].join("\n");
}

export function assertSupportedNode({ version = process.version, engines } = {}) {
  const range = engines ?? JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).engines?.node;
  const result = evaluateNodeVersion(version, range);
  if (!result.supported) {
    const error = new Error(unsupportedNodeMessage(result));
    error.code = "unsupported_node";
    throw error;
  }
  return result;
}

export function guardNodeVersion() {
  try {
    assertSupportedNode();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) guardNodeVersion();
