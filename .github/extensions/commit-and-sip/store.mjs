import { mkdir, readFile, rename, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DomainError } from "./domain.mjs";

export class RunStore {
  constructor(directory) {
    this.directory = directory;
    this.path = join(directory, "ledger.json");
    this.lock = join(directory, "ledger.lock");
  }

  async read() {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8"));
      if (data.version !== 1 || !data.runs || typeof data.runs !== "object" ||
        Array.isArray(data.runs) || !Array.isArray(data.results)) {
        throw new DomainError("store_invalid", "Run storage has an unsupported format. Ask booth staff to restore it.");
      }
      return data;
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, runs: {}, results: [] };
      throw error;
    }
  }

  async transaction(fn) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let lock;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        lock = await open(this.lock, "wx", 0o600);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    if (!lock) throw new DomainError("store_busy", "Run storage is locked by an active operation or a lock left after a crash. If retry stays blocked, staff must follow Lock and storage recovery in booth/RUNBOOK.md. Never remove ledger.lock until all writers are confirmed stopped; preserve the ledger and retry the same run.");
    const temp = join(this.directory, `.ledger-${randomUUID()}.tmp`);
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      const data = await this.read();
      const result = await fn(data);
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(data, null, 2)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, this.path);
      const dir = await open(this.directory, "r");
      try { await dir.sync(); } finally { await dir.close(); }
      return result;
    } finally {
      await lock.close();
      await rm(temp, { force: true });
      await rm(this.lock);
    }
  }
}
