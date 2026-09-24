import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  assertSupportedNode, evaluateNodeVersion, guardNodeVersion, requiredMajor, unsupportedNodeMessage
} from "../scripts/require-node.mjs";

const run = promisify(execFile);
const root = new URL("../", import.meta.url);
const readRoot = name => readFile(new URL(name, root), "utf8");
const engines = ">=22";

test("version comparison uses the declared engines floor", () => {
  assert.equal(requiredMajor(engines), 22);
  assert.equal(requiredMajor(">= 22.1.0"), 22);
  for (const range of ["", "22", "^22", "latest", null, undefined]) {
    assert.throws(() => requiredMajor(range), /Unsupported engines\.node range/);
  }
  for (const version of ["v22.20.0", "22.20.0", "v23.1.0"]) {
    assert.deepEqual(evaluateNodeVersion(version, engines), { supported: true, required: 22, actual: Number(version.replace(/^v/, "").split(".")[0]) });
  }
  for (const version of ["v18.12.1", "v20.12.2", "v21.7.3"]) {
    assert.equal(evaluateNodeVersion(version, engines).supported, false);
  }
  for (const version of ["", "node", null]) {
    assert.throws(() => evaluateNodeVersion(version, engines), /Unrecognized Node version/);
  }
});

test("an unsupported runtime throws an actionable error instead of running", () => {
  let error;
  assert.throws(() => assertSupportedNode({ version: "v18.12.1", engines }), thrown => {
    error = thrown;
    return thrown.code === "unsupported_node";
  });
  assert.match(error.message, /Node 18 is not supported; this repository requires Node >=22\./);
  assert.match(error.message, /hangs indefinitely/);
  assert.match(error.message, /nvm use\s+# reads \.nvmrc/);
  assert.match(error.message, /nvm install 22/);
  assert.equal(unsupportedNodeMessage({ required: 22, actual: 18 }), error.message);
  assert.deepEqual(assertSupportedNode({ version: "v22.20.0", engines }), { supported: true, required: 22, actual: 22 });
  assert.deepEqual(assertSupportedNode(), evaluateNodeVersion(process.version, engines));
  assert.equal(typeof guardNodeVersion, "function");
});

test("the guard runs as a standalone script and passes on this interpreter", async () => {
  const { stdout, stderr } = await run(process.execPath, [new URL("scripts/require-node.mjs", root).pathname]);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
  const script = await readRoot("scripts/require-node.mjs");
  assert.match(script, /process\.exit\(1\)/);
});

test("npm entrypoints guard the runtime and cannot hang forever", async () => {
  const { scripts, engines: declared } = JSON.parse(await readRoot("package.json"));
  assert.equal(declared.node, engines);
  assert.equal(scripts.pretest, "node scripts/require-node.mjs");
  assert.equal(scripts.precheck, "node scripts/require-node.mjs");
  assert.match(scripts.test, /^node --test --test-timeout=\d+ --test-force-exit tests\/\*\.test\.mjs$/);
  for (const name of ["generate-qr.mjs"]) {
    const source = await readRoot(`scripts/${name}`);
    assert.match(source, /import \{ guardNodeVersion \} from "\.\/require-node\.mjs";/);
    assert.match(source, /^guardNodeVersion\(\);$/m);
  }
});

test("the pinned version, engines floor, and CI runtime stay consistent", async () => {
  const nvmrc = (await readRoot(".nvmrc")).trim();
  assert.match(nvmrc, /^\d+$/);
  assert.equal(Number(nvmrc), requiredMajor(engines));
  assert.match(await readRoot(".npmrc"), /^engine-strict=true$/m);
  const workflow = await readRoot(".github/workflows/exercise-validation.yml");
  assert.match(workflow, /node-version-file: \.nvmrc/);
  assert.doesNotMatch(workflow, /node-version: /);
});
