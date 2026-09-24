import { mkdir, readdir, readFile, rename, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DomainError } from "./domain.mjs";

// Chosen so listArtifacts, which only offers .json, can never show a pending
// archive to staff as though it were a verified one.
const PENDING_SUFFIX = ".pending";

// The booth and the staff scripts must resolve the same ledger. Working this
// out in two places invites drift, and the failure mode is silent: a removal
// that appears to succeed against a directory the running booth never reads.
export function dataDirectory(env = process.env) {
  const directory = env.COMMIT_AND_SIP_DATA_DIR ??
    join(env.COPILOT_HOME ?? join(homedir(), ".copilot"), "extensions", "commit-and-sip", "artifacts");
  if (!isAbsolute(directory)) throw new Error("COMMIT_AND_SIP_DATA_DIR must be an absolute staff-owned directory.");
  return directory;
}

export class RunStore {
  constructor(directory) {
    this.directory = directory;
    this.path = join(directory, "ledger.json");
    this.lock = join(directory, "ledger.lock");
    // Exports and archives live beside the ledger, never inside the repository
    // clone: that clone is disposable and may be deleted after an event, and
    // committing attendee data would publish it.
    this.exports = join(directory, "exports");
  }

  // Refuses to overwrite. Two archives on one day must never collide silently,
  // because the survivor would look like a complete record of both.
  async writeArtifact(name, payload) {
    await mkdir(this.exports, { recursive: true, mode: 0o700 });
    const path = join(this.exports, name);
    let file;
    try {
      file = await open(path, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new DomainError("artifact_exists", `${name} already exists. Nothing was written.`, 409);
      }
      throw error;
    }
    try {
      await file.writeFile(`${JSON.stringify(payload, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    return path;
  }

  async readArtifact(path) {
    return JSON.parse(await readFile(path, "utf8"));
  }

  async listArtifacts() {
    try {
      const names = await readdir(this.exports);
      return names.filter(name => name.endsWith(".json")).sort();
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  // An archive has to exist on disk before it can be read back and verified,
  // but a file that fails that check must never look like a good copy of the
  // event. Pending artifacts carry a suffix listArtifacts ignores, so they are
  // invisible to staff until publishArtifact renames one into place.
  async writePendingArtifact(name, payload) {
    return this.writeArtifact(`${name}${PENDING_SUFFIX}`, payload);
  }

  async publishArtifact(pendingPath) {
    if (!pendingPath.endsWith(PENDING_SUFFIX)) throw new Error("Only a pending artifact can be published.");
    const path = pendingPath.slice(0, -PENDING_SUFFIX.length);
    await rename(pendingPath, path);
    return path;
  }

  // Best effort on purpose: the caller is already failing, and a leftover
  // pending file is far less harmful than masking the original error.
  async discardArtifact(path) {
    await rm(path, { force: true }).catch(() => {});
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
