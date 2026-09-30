import { spawn, execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path, { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { guardNodeVersion } from "./require-node.mjs";

guardNodeVersion();

// Builds the deployable zip for leaderboard-service/.
//
// The service imports the booth's own rubric, moderation and ranking modules
// and reads the booth's rule files, so the zip keeps the repository layout for
// exactly those files. Which files that is gets derived by walking the real
// import graph, not maintained by hand, so a new import cannot be forgotten.
// The staged copy is then started and asked for its pages before anything is
// zipped: a missing file fails here, not in Azure in front of a queue.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(root, "leaderboard-service", "server.mjs");
const IMPORT = /\bimport\s+(?:[^"';]*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/g;
const URL_LITERAL = /new URL\(\s*["'](\.{1,2}\/[^"'$`]+)["']\s*,\s*import\.meta\.url\s*\)/g;
const RENDERER_ASSET = /\brenderer\(\s*["']([^"']+)["']\s*\)/g;

// Referenced by shared modules the service imports, but never shipped. The
// staff config holds the booth and staff keys; the service gets its own keys
// from App Service settings. Walking the graph would otherwise pack it.
export const NEVER_PACKAGE = ["booth/local-config.json"];

// Compared as resolved absolute paths, never as relative strings: on Windows
// `relative()` returns `booth\\local-config.json`, which would not match the
// entry above and would put both API keys into the zip. `paths` is injectable
// so the Windows behaviour is tested on any platform.
export function isNeverPackaged(file, { root: base = root, paths = path } = {}) {
  const target = paths.resolve(file);
  return NEVER_PACKAGE.some(entry => paths.resolve(base, ...entry.split("/")) === target);
}

// Manifest entries are always forward-slash relative paths, whatever the OS.
const manifestPath = file => relative(root, file).split(path.sep).join("/");

// Every repository file the service needs at runtime.
export async function packageManifest() {
  const files = new Set();
  const pending = [ENTRY];
  while (pending.length) {
    const file = pending.pop();
    if (files.has(file) || isNeverPackaged(file)) continue;
    if (!existsSync(file)) throw new Error(`The service needs ${relative(root, file)}, which does not exist.`);
    files.add(file);
    if (!file.endsWith(".mjs")) continue;
    const source = await readFile(file, "utf8");
    const base = pathToFileURL(file);
    for (const [, specifier] of source.matchAll(IMPORT)) pending.push(fileURLToPath(new URL(specifier, base)));
    for (const [, specifier] of source.matchAll(URL_LITERAL)) pending.push(fileURLToPath(new URL(specifier, base)));
    for (const [, asset] of source.matchAll(RENDERER_ASSET)) {
      pending.push(join(root, ".github", "extensions", "commit-and-sip", "renderer", asset));
    }
  }
  return [...files].map(manifestPath).sort();
}

const freePort = () => new Promise((done, fail) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => done(port));
  }).on("error", fail);
});

// Starts the staged service with throwaway settings and checks that every page
// and asset loads, using a throwaway data directory.
async function smokeTest(stage) {
  const port = await freePort();
  const dataDirectory = await mkdtemp(join(tmpdir(), "sip-smoke-"));
  const child = spawn(process.execPath, ["leaderboard-service/server.mjs"], {
    cwd: stage, stdio: ["ignore", "pipe", "pipe"],
    env: {
      BOOTH_KEY: "b".repeat(40), DATA_DIR: dataDirectory, PATH: process.env.PATH, PORT: String(port),
      STAFF_KEY: "s".repeat(40),
    },
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  try {
    const deadline = Date.now() + 15_000;
    while (!output.includes("listening")) {
      if (child.exitCode !== null) throw new Error(`The staged service exited:\n${output}`);
      if (Date.now() > deadline) throw new Error(`The staged service did not start:\n${output}`);
      await new Promise(done => setTimeout(done, 100));
    }
    for (const path of ["/healthz", "/", "/board.js", "/board.css", "/fonts/MonaSansVF.woff2", "/fonts/OFL.txt"]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      if (!response.ok) throw new Error(`The staged service answered ${response.status} for ${path}.`);
    }
  } finally {
    child.kill();
    await rm(dataDirectory, { force: true, recursive: true });
  }
}

async function build() {
  const stage = join(root, "dist", "leaderboard");
  const zip = join(root, "dist", "leaderboard.zip");
  // Only this script's own outputs: dist/ also holds the secure deployment
  // parameters written by leaderboard:configure.
  await rm(stage, { force: true, recursive: true });
  await rm(zip, { force: true });
  await mkdir(stage, { recursive: true });

  const manifest = await packageManifest();
  for (const file of manifest) {
    await mkdir(dirname(join(stage, file)), { recursive: true });
    await copyFile(join(root, file), join(stage, file));
  }
  // App Service runs `npm start` from the zip root, so the root manifest is the
  // service's own, pointed at its entry by path. The service has no
  // dependencies, so nothing is installed and no development tooling ships.
  const service = JSON.parse(await readFile(join(root, "leaderboard-service", "package.json"), "utf8"));
  if (service.dependencies && Object.keys(service.dependencies).length) {
    throw new Error("The leaderboard service is meant to run on Node built-ins only. Package dependencies deliberately.");
  }
  service.scripts = { start: "node leaderboard-service/server.mjs" };
  await writeFile(join(stage, "package.json"), `${JSON.stringify(service, null, 2)}\n`);

  await smokeTest(stage);
  execFileSync("zip", ["-qr", zip, "."], { cwd: stage });
  process.stdout.write(`Packaged ${manifest.length} repository files and no dependencies.\n`
    + `Smoke test passed against the staged copy.\n${relative(root, zip)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await build();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
