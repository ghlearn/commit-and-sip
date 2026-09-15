import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "../.github/extensions/commit-and-sip/domain.mjs";

test("local grader accepts only the exact menu-only commit delta", async t => {
  const directory = await mkdtemp(join(tmpdir(), "sip-grader-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = message => {
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-qm", `${message}\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  await mkdir(join(directory, "src/data"), { recursive: true });
  await writeFile(join(directory, "src/data/specials.json"), "[]\n");
  const base = commit("Empty test menu");
  const { orders } = await loadCatalog();
  await writeFile(join(directory, "src/data/specials.json"), JSON.stringify([orders[0]]));
  const head = commit("Add test drink");
  const grader = fileURLToPath(new URL("../scripts/grade-order.mjs", import.meta.url));
  const grade = ref => execFileSync(process.execPath, [grader, "--base", base, "--head", ref, "--order", "mona-latte"],
    { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.match(grade(head), /Order correct: Mona Latte/);
  await writeFile(join(directory, "unrelated.txt"), "Unrelated change");
  const unexpected = commit("Add unrelated test file");
  assert.throws(() => grade(unexpected), /Only the existing menu file may change/);
});
