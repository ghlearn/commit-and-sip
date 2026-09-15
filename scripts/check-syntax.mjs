import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (/\.(mjs|js)$/.test(entry.name)) execFileSync(process.execPath, ["--check", path], { stdio: "inherit" });
  }
}
await check(".");
