import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

// One interface, two backends: memory for the tests, a JSON file for Azure.
//
// In App Service the file lives under /home, which is Azure-backed storage that
// survives restarts and redeployments and is shared by every instance. The
// plan runs one instance, but correctness does not depend on it: writes take
// a lock on the share, work from what is on disk, and check the version has
// not moved (see FileStore). Each lands atomically through a rename, so a
// crash mid-write leaves the previous board intact rather than a torn file.
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
  // `entries` is the whole board as it stood at this admission, taken inside
  // the same step. A receipt ranked from a later read could find the entry
  // already retracted by a takedown queued behind this one.
  async admit(entry, { fingerprint, handles }) {
    if (this.reserved.has(fingerprint)) throw new ReservedError();
    const board = () => [...this.entries.values()].map(item => ({ ...item }));
    const existing = this.entries.get(entry.id);
    if (existing) return { created: false, entries: board(), entry: { ...existing } };
    const used = new Set([...this.entries.values()].map(item => item.handle));
    const handle = handles.find(candidate => !used.has(candidate));
    if (!handle) throw new HandleTakenError();
    const stored = { ...entry, handle };
    this.entries.set(entry.id, stored);
    return { created: true, entries: board(), entry: { ...stored } };
  }

  // Reserves even when nothing was published: staff often catch a name before
  // it syncs, and another booth must still be refused it.
  async retract(id, fingerprint) {
    this.reserved.add(fingerprint);
    return this.entries.delete(id);
  }
}

const EVENT = /^[a-z0-9-]{1,63}$/;

export class LockLostError extends Error {
  constructor() {
    super("This instance's lock on the board was taken over before the write committed.");
    this.name = "LockLostError";
    this.code = "lock_lost";
  }
}

export class ConcurrentWriteError extends Error {
  constructor() {
    super("Another instance wrote the board during this write.");
    this.name = "ConcurrentWriteError";
    this.code = "concurrent_write";
  }
}

// The file on /home is the only source of truth, and every write is made
// under a lock that other instances honour too.
//
// App Service normally runs this on one instance, but it does not promise
// that: during scale operations or platform maintenance a second instance can
// run against the same /home share. Each instance keeps its own memory, so a
// write that trusted memory would overwrite whatever the other had written.
// So a write takes a lock file created exclusively on the share, re-reads the
// board from disk, applies its change, checks the version on disk has not
// moved, and replaces the file atomically. Reads always come from disk.
//
// The lock is a lease. An instance that dies holding it would otherwise block
// the board forever, so a lock not renewed for `staleLockMs` is taken over.
// A live holder renews it every `staleLockMs / 3`, so only a holder that has
// stopped making progress for the whole period can lose it. And a holder that
// has lost it cannot commit: ownership is checked again immediately before
// the rename, after the new board is already written aside, and a holder
// that finds someone else's lease gives up and retries from disk.
//
// The residual risk is a holder that passes that final check and then stalls
// for more than `staleLockMs` before the rename completes. Plain files offer
// no compare-and-swap to rule it out entirely. The version check narrows it
// further, and each booth can rebuild its part of the board with
// `npm run leaderboard:republish`.
export class FileStore extends MemoryStore {
  // The event ID names the file, so it is held to a charset that cannot walk
  // out of the data directory.
  static async open({ directory, event = "default", lockTimeoutMs = 10_000, staleLockMs = 15_000 }) {
    if (!(staleLockMs >= 30)) throw new Error("staleLockMs must be at least 30ms.");
    if (!EVENT.test(event)) throw new Error("EVENT_ID must be 1-63 lowercase letters, digits, or hyphens.");
    await mkdir(directory, { recursive: true });
    const store = new FileStore();
    const file = join(directory, `${event}.json`);
    Object.assign(store, { file, lockFile: `${file}.lock`, lockTimeoutMs, queue: Promise.resolve(), staleLockMs });
    // An unreadable board is left exactly as found and the service refuses
    // to start. Starting empty would overwrite it on the first submission.
    store.load(await store.snapshot());
    return store;
  }

  async snapshot() {
    let text;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return { entries: new Map(), reserved: new Set(), version: 0 };
      throw error;
    }
    let saved;
    try { saved = JSON.parse(text); } catch { saved = null; }
    if (!Array.isArray(saved?.entries) || !Array.isArray(saved.reserved ?? [])) {
      throw new Error(`${this.file} is not a readable board. Move it aside to start empty, or restore it.`);
    }
    return {
      entries: new Map(saved.entries.map(entry => [entry.id, entry])),
      reserved: new Set(saved.reserved ?? []),
      version: Number.isSafeInteger(saved.version) ? saved.version : 0,
    };
  }

  // Copies, so a change applied to memory can never alter the snapshot it
  // may have to be rolled back to.
  load(disk) {
    this.entries = new Map([...disk.entries].map(([id, entry]) => [id, { ...entry }]));
    this.reserved = new Set(disk.reserved);
  }

  async acquireLock() {
    const owner = randomBytes(8).toString("hex");
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        // Exclusive create is atomic on the /home share: exactly one instance wins.
        await writeFile(this.lockFile, owner, { flag: "wx" });
        return owner;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      try {
        const [info, holder] = await Promise.all([stat(this.lockFile), readFile(this.lockFile, "utf8")]);
        if (Date.now() - info.mtimeMs > this.staleLockMs) {
          // Take over only the exact lease judged stale, never one created since.
          if ((await readFile(this.lockFile, "utf8")) === holder) await rm(this.lockFile, { force: true });
          continue;
        }
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (Date.now() > deadline) {
        throw Object.assign(new Error("The board is locked by another instance."), { code: "board_locked" });
      }
      await new Promise(resolve => setTimeout(resolve, 20 + Math.floor(Math.random() * 30)));
    }
  }

  // Renews the lease while this instance holds it, but only while it is still
  // this instance's: a renewal must never refresh a lease someone else took.
  renewLease(owner) {
    const timer = setInterval(async () => {
      try {
        if ((await readFile(this.lockFile, "utf8")) === owner) {
          const now = new Date();
          await utimes(this.lockFile, now, now);
        }
      } catch { /* the commit-time check is what decides */ }
    }, Math.floor(this.staleLockMs / 3));
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async assertOwner(owner) {
    let holder = null;
    try { holder = await readFile(this.lockFile, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (holder !== owner) throw new LockLostError();
  }

  async releaseLock(owner) {
    try {
      if ((await readFile(this.lockFile, "utf8")) === owner) await rm(this.lockFile, { force: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  // The random suffix matters: process IDs can repeat across instances, and
  // two writers sharing a temporary file would corrupt each other's write.
  async persist(text, owner = null) {
    const temporary = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, text);
    try {
      // Fencing: the last thing before the rename. The slow part, writing the
      // new board, is already done, so the window after this check is short.
      if (owner !== null) await this.assertOwner(owner);
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  // Writes are chained within this process and locked across instances.
  // Memory changes only if the disk does: if anything fails, memory is put
  // back to what the disk holds.
  serialise(change) {
    const attempt = async () => {
      const owner = await this.acquireLock();
      const stopRenewing = this.renewLease(owner);
      try {
        const disk = await this.snapshot();
        this.load(disk);
        try {
          const result = await change();
          if ((await this.snapshot()).version !== disk.version) throw new ConcurrentWriteError();
          await this.persist(`${JSON.stringify({
            entries: [...this.entries.values()], reserved: [...this.reserved], version: disk.version + 1,
          })}\n`, owner);
          return result;
        } catch (error) {
          this.load(disk);
          throw error;
        }
      } finally {
        stopRenewing();
        await this.releaseLock(owner);
      }
    };
    const next = this.queue.then(async () => {
      for (let tries = 1; ; tries += 1) {
        try { return await attempt(); }
        catch (error) {
          const retryable = error instanceof ConcurrentWriteError || error instanceof LockLostError;
          if (!retryable || tries >= 3) throw error;
        }
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  create(entry) { return this.serialise(() => super.create(entry)); }

  admit(entry, options) { return this.serialise(() => super.admit(entry, options)); }

  retract(id, fingerprint) { return this.serialise(() => super.retract(id, fingerprint)); }

  // Reads come from disk, after every write this process has queued, so they
  // see what another instance wrote and never a change that has not landed.
  // They never assign to the shared maps: a write in progress owns those.
  async get(id) {
    await this.queue;
    const entry = (await this.snapshot()).entries.get(id);
    return entry ? { ...entry } : null;
  }

  async list() {
    await this.queue;
    return [...(await this.snapshot()).entries.values()].map(entry => ({ ...entry }));
  }

  async isReserved(fingerprint) {
    await this.queue;
    return (await this.snapshot()).reserved.has(fingerprint);
  }
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
