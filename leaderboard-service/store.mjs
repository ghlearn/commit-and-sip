import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// One interface, two backends: memory for the tests, a JSON file for Azure.
//
// In App Service the file lives under /home, which is Azure-backed storage that
// survives restarts and redeployments. That is only safe with exactly one
// writer, so the service must run on one instance (the plan pins it, and
// overlapped recycling is disabled). Within that one process every write is
// serialised, and each lands atomically through a rename, so a crash mid-write
// leaves the previous board intact rather than a torn file.
//
// This board is a projection. Every booth machine keeps the authoritative copy
// of its own drinks, and `npm run leaderboard:republish` rebuilds the board
// from them.
//
// create() is create-if-absent, never upsert. Two booth machines can each serve
// the same drink name, and the second must be told so rather than silently
// overwrite the first attendee's entry.
//
// retract() deletes an entry and reserves its ID, so a name staff took down at
// one booth cannot be typed in again at another. Only a keyed fingerprint of
// the ID is kept: no name, no reason, and no record of who removed it.

export class ConflictError extends Error {
  constructor(id) {
    super(`An entry with ID "${id}" already exists.`);
    this.name = "ConflictError";
    this.code = "conflict";
  }
}

export class ReservedError extends Error {
  constructor() {
    super("That drink ID is reserved.");
    this.name = "ReservedError";
    this.code = "reserved";
  }
}

export class HandleTakenError extends Error {
  constructor() {
    super("Every candidate handle is already used by another entry.");
    this.name = "HandleTakenError";
    this.code = "handle_taken";
  }
}

export class MemoryStore {
  constructor() {
    this.entries = new Map();
    this.reserved = new Set();
  }

  async create(entry) {
    if (this.entries.has(entry.id)) throw new ConflictError(entry.id);
    this.entries.set(entry.id, { ...entry });
  }

  async get(id) {
    const entry = this.entries.get(id);
    return entry ? { ...entry } : null;
  }

  async list() { return [...this.entries.values()].map(entry => ({ ...entry })); }

  async isReserved(fingerprint) { return this.reserved.has(fingerprint); }

  // The whole admission decision as one step, so nothing can interleave with
  // it: a retraction cannot slip between the reservation check and the write,
  // and two attendees sharing a handle cannot both claim the unsuffixed form.
  // Returns the stored entry when the ID already exists, for the caller to
  // judge as a retry or a clash; otherwise stores it under the first handle in
  // `handles` that no other entry uses.
  async admit(entry, { fingerprint, handles }) {
    if (this.reserved.has(fingerprint)) throw new ReservedError();
    const existing = this.entries.get(entry.id);
    if (existing) return { created: false, entry: { ...existing } };
    const used = new Set([...this.entries.values()].map(item => item.handle));
    const handle = handles.find(candidate => !used.has(candidate));
    if (!handle) throw new HandleTakenError();
    const stored = { ...entry, handle };
    this.entries.set(entry.id, stored);
    return { created: true, entry: { ...stored } };
  }

  // Reserves even when nothing was published: staff often catch a name before
  // it syncs, and another booth must still be refused it.
  async retract(id, fingerprint) {
    this.reserved.add(fingerprint);
    return this.entries.delete(id);
  }
}

const EVENT = /^[a-z0-9-]{1,63}$/;

export class FileStore extends MemoryStore {
  // The event ID names the file, so it is held to a charset that cannot walk
  // out of the data directory.
  static async open({ directory, event = "default" }) {
    if (!EVENT.test(event)) throw new Error("EVENT_ID must be 1-63 lowercase letters, digits, or hyphens.");
    await mkdir(directory, { recursive: true });
    const store = new FileStore();
    store.file = join(directory, `${event}.json`);
    store.queue = Promise.resolve();
    let text = null;
    try { text = await readFile(store.file, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (text !== null) {
      // An unreadable board is left exactly as found and the service refuses
      // to start. Starting empty would overwrite it on the first submission.
      let saved;
      try { saved = JSON.parse(text); } catch { saved = null; }
      if (!Array.isArray(saved?.entries) || !Array.isArray(saved.reserved ?? [])) {
        throw new Error(`${store.file} is not a readable board. Move it aside to start empty, or restore it.`);
      }
      for (const entry of saved.entries) store.entries.set(entry.id, entry);
      for (const fingerprint of saved.reserved ?? []) store.reserved.add(fingerprint);
    }
    return store;
  }

  // Writes are chained so two requests can never interleave a read-modify-write.
  // Memory changes only if the disk does: if the write or the rename fails,
  // the maps are put back, so a retry cannot report success for an entry that
  // would vanish on restart.
  serialise(change) {
    const next = this.queue.then(async () => {
      const entries = new Map(this.entries);
      const reserved = new Set(this.reserved);
      try {
        const result = await change();
        const temporary = `${this.file}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify({ entries: [...this.entries.values()], reserved: [...this.reserved] })}\n`);
        await rename(temporary, this.file);
        return result;
      } catch (error) {
        this.entries = entries;
        this.reserved = reserved;
        throw error;
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  create(entry) { return this.serialise(() => super.create(entry)); }

  admit(entry, options) { return this.serialise(() => super.admit(entry, options)); }

  // A write changes the maps before its file lands, so a read that did not
  // wait could show an entry that is about to be rolled back, or briefly hide
  // one a failed retraction is about to restore. Reads wait for every write
  // queued before them. Writes never read through these, so nothing waits on
  // itself.
  async get(id) { await this.queue; return super.get(id); }

  async list() { await this.queue; return super.list(); }

  async isReserved(fingerprint) { await this.queue; return super.isReserved(fingerprint); }

  retract(id, fingerprint) { return this.serialise(() => super.retract(id, fingerprint)); }
}

// The key for reservation fingerprints. Generated by the service on first
// start and kept beside the board, readable by the service only. It is not
// derived from the staff key, because rotating that key would then silently
// void every reservation.
export async function reservationKey(directory) {
  const file = join(directory, "reservation.key");
  try {
    return (await readFile(file, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(directory, { recursive: true });
  const key = randomBytes(32).toString("hex");
  // "wx" fails if another process created it first, rather than replacing it.
  try {
    await writeFile(file, `${key}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") return (await readFile(file, "utf8")).trim();
    throw error;
  }
  await chmod(file, 0o600);
  return key;
}
