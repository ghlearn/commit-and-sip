import { createHash, randomBytes } from "node:crypto";
import { chmod, constants, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_SCORE } from "../.github/extensions/commit-and-sip/services/name-score.mjs";

// Reservations are HMAC-SHA256 fingerprints of drink IDs, in hex.
const FINGERPRINT = /^[0-9a-f]{64}$/;

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

// The board is closed to new entries while it is being rebuilt. Takedowns
// are replayed first, and no drink may land before every booth has reserved
// the names it took down, so admission waits (a booth keeps the drink and
// sends it again) while retractions still go through.
export class ClosedError extends Error {
  constructor() {
    super("The board is being rebuilt and is not taking entries yet.");
    this.name = "ClosedError";
    this.code = "board_rebuilding";
  }
}

// A clear names the board staff looked at. Any other board, such as one
// another staff machine cleared a moment earlier, is left alone.
export class BoardChangedError extends Error {
  constructor() {
    super("The board changed since it was read.");
    this.name = "BoardChangedError";
    this.code = "board_changed";
  }
}

export class MemoryStore {
  constructor({ closed = false } = {}) {
    this.entries = new Map();
    this.reserved = new Set();
    this.closed = closed;
    this.boardId = randomBytes(16).toString("hex");
    // Every drink ever admitted to this board, for tracking. It only grows:
    // a takedown removes an entry but not the fact it was captured, and a
    // booth resending the same publication is not a new capture.
    this.captured = 0;
  }

  // `boardId` names this board, so a booth can tell the board it replayed its
  // takedowns onto from a later replacement.
  async state() { return { boardId: this.boardId, captured: this.captured, closed: Boolean(this.closed) }; }

  // Opening is a staff decision: every booth has replayed its takedowns.
  async openBoard() { this.closed = false; }

  // Empties the board for the next event, on staff's word that every booth
  // has ended its own. It becomes a new board: a new ID (so a booth's rebuild
  // record for the old one proves nothing here), no entries, a captured count
  // of 0, open, and no reservations, as with a new EVENT_ID.
  async clearBoard(expectedBoardId) {
    if (expectedBoardId !== this.boardId) throw new BoardChangedError();
    const cleared = { captured: this.captured, total: this.entries.size };
    this.entries = new Map();
    this.reserved = new Set();
    this.captured = 0;
    this.closed = false;
    this.boardId = randomBytes(16).toString("hex");
    return { boardId: this.boardId, cleared };
  }

  async create(entry) {
    if (this.entries.has(entry.id)) throw new ConflictError(entry.id);
    this.entries.set(entry.id, { ...entry });
    this.captured += 1;
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
    if (this.closed) throw new ClosedError();
    if (this.reserved.has(fingerprint)) throw new ReservedError();
    const board = () => [...this.entries.values()].map(item => ({ ...item }));
    const existing = this.entries.get(entry.id);
    if (existing) return { created: false, entries: board(), entry: { ...existing } };
    const used = new Set([...this.entries.values()].map(item => item.handle));
    const handle = handles.find(candidate => !used.has(candidate));
    if (!handle) throw new HandleTakenError();
    const stored = { ...entry, handle };
    this.entries.set(entry.id, stored);
    this.captured += 1;
    return { created: true, entries: board(), entry: { ...stored } };
  }

  // Reserves even when nothing was published: staff often catch a name before
  // it syncs, and another booth must still be refused it.
  async retract(id, fingerprint) {
    // A reservation that is not a fingerprint could never match one, and
    // would silently release the name it was meant to hold.
    if (typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint)) {
      throw new TypeError("A reservation must be a 64-character hex HMAC-SHA256 fingerprint.");
    }
    this.reserved.add(fingerprint);
    return this.entries.delete(id);
  }
}

const EVENT = /^[a-z0-9-]{1,63}$/;
const STORED_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const STORED_HANDLE = /^[a-z]+-[a-z]+-[a-z]+(?:-[0-9a-f]{8})?$/;
const TOKEN_HASH = /^[0-9a-f]{64}$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const BOARD_ID = /^[0-9a-f]{32}$/;

// What is wrong with a stored row, or null. Every field the board serves or
// compares must be present and of its type, or a corrupted row would load,
// pass /healthz, and break every reader of /api/board. `tokenHash` is the one
// optional field: rows written before publication tokens have none, and are
// only ever matched by it when it is there.
function storedEntryProblem(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "an entry that is not an object";
  if (typeof entry.id !== "string" || !STORED_ID.test(entry.id)) return "an entry without a valid ID";
  const where = `entry ${entry.id}`;
  if (typeof entry.handle !== "string" || !STORED_HANDLE.test(entry.handle)) return `${where} has no valid handle`;
  if (typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 80) return `${where} has no valid name`;
  // The same bounds the rubric clamps to, so no impossible score is served.
  if (!Number.isSafeInteger(entry.score) || entry.score < 1 || entry.score > MAX_SCORE) return `${where} has no valid score`;
  if (typeof entry.createdAt !== "string" || Number.isNaN(Date.parse(entry.createdAt))) return `${where} has no valid createdAt`;
  if (entry.tokenHash !== undefined && (typeof entry.tokenHash !== "string" || !TOKEN_HASH.test(entry.tokenHash))) {
    return `${where} has a malformed tokenHash`;
  }
  return null;
}
// Longest pause between two looks at a malformed lease that still counts as
// watching it continuously. Waiters poll every 20-50ms.
const MALFORMED_WATCH_GAP_MS = 250;

export class LockLostError extends Error {
  constructor() {
    super("This instance's lock on the board was taken over before the write committed.");
    this.name = "LockLostError";
    this.code = "lock_lost";
  }
}

// This instance fingerprints with a different reservation key from the one
// the board is bound to, so its fingerprints would not match the board's
// reservations. It must not write, and should be restarted to pick up the key.
export class KeyMismatchError extends Error {
  constructor() {
    super("The board is bound to a different reservation key than this instance holds. Restart the instance.");
    this.name = "KeyMismatchError";
    this.code = "reservation_key_mismatch";
    this.status = 503;
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
// the board forever, so a lease whose holder has shown no sign of life for
// `staleLockMs` is taken over. A live holder beats on its own heartbeat file
// every `staleLockMs / 3`, so only a holder that has stopped making progress
// for the whole period can lose it. And a holder that
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
  // A waiter must be able to outlast the stale interval, or a lease left
  // half-written by a crashed creator could never be taken over: every request
  // would give up first, and the next would restart the watch. So by default a
  // write waits the stale interval plus a margin. Tests pass shorter values
  // on purpose, to observe a wait that has not yet run out.
  static async open({ directory, event = "default", staleLockMs = 15_000, lockTimeoutMs = staleLockMs + 5_000 }) {
    if (!(staleLockMs >= 30)) throw new Error("staleLockMs must be at least 30ms.");
    if (!EVENT.test(event)) throw new Error("EVENT_ID must be 1-63 lowercase letters, digits, or hyphens.");
    await mkdir(directory, { recursive: true });
    const store = new FileStore();
    const file = join(directory, `${event}.json`);
    Object.assign(store, { file, lockFile: `${file}.lock`, lockTimeoutMs, queue: Promise.resolve(), staleLockMs });
    // An unreadable board is left exactly as found and the service refuses
    // to start. Starting empty would overwrite it on the first submission.
    const disk = await store.snapshot();
    store.load(disk);
    // A board is named before anything reads it: a new one is written now,
    // closed and with its ID, and a board from before IDs gets one. Otherwise
    // the first reader would see no ID and a rebuild could not record which
    // board it replayed onto. The write is the usual locked one.
    if (!disk.boardId) await store.serialise(() => {});
    return store;
  }

  async snapshot() {
    let text;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      // A board this service is creating from nothing starts closed: it may be
      // the replacement for one that was lost, and takedowns must be
      // replayed onto it before any drink. Staff open it.
      if (error.code === "ENOENT") return { boardId: null, captured: 0, closed: true, entries: new Map(), keyId: null, reserved: new Set(), version: 0 };
      throw error;
    }
    const unreadable = reason => new Error(`${this.file} is not a readable board (${reason}). Move it aside to start empty, or restore it.`);
    let saved;
    try { saved = JSON.parse(text); } catch { saved = null; }
    // A field written before it existed may be missing. One that is present
    // must be well formed: `"reserved": null` read as "none" would release
    // every takedown and drop them from the next write.
    if (!Array.isArray(saved?.entries) || (saved.reserved !== undefined && !Array.isArray(saved.reserved))) {
      throw unreadable("wrong shape");
    }
    if (saved.version !== undefined && (!Number.isSafeInteger(saved.version) || saved.version < 0)) {
      throw unreadable("a malformed version");
    }
    // Missing on a board written before the gate existed, which is open.
    if (saved.closed !== undefined && typeof saved.closed !== "boolean") throw unreadable("a malformed closed flag");
    if (saved.boardId !== undefined && (typeof saved.boardId !== "string" || !BOARD_ID.test(saved.boardId))) {
      throw unreadable("a malformed board ID");
    }
    // Every row must be loadable as itself. Two rows with one ID would load
    // "successfully" as one, and the next write would drop the other for good.
    const entries = new Map();
    const handles = new Set();
    for (const entry of saved.entries) {
      const problem = storedEntryProblem(entry);
      if (problem) throw unreadable(problem);
      if (entries.has(entry.id)) throw unreadable(`two entries with ID ${entry.id}`);
      // Handles are unique across the board; two rows with one would make the
      // public board, and an attendee's own link, ambiguous.
      if (handles.has(entry.handle)) throw unreadable(`two entries with handle ${entry.handle}`);
      entries.set(entry.id, entry);
      handles.add(entry.handle);
    }
    // A reservation that is not a fingerprint (a readable ID, a truncated
    // hash) would load, pass /healthz and match nothing, releasing the name.
    const reserved = new Set(saved.reserved ?? []);
    if (reserved.size !== (saved.reserved ?? []).length
      || [...reserved].some(item => typeof item !== "string" || !FINGERPRINT.test(item))) {
      throw unreadable("malformed reservations");
    }
    // A board from before the tally starts it at what it holds now. A present
    // tally must be a count, and can never be below the drinks still on it.
    if (saved.captured !== undefined
      && (!Number.isSafeInteger(saved.captured) || saved.captured < entries.size)) {
      throw unreadable("a malformed captured count");
    }
    // Likewise a mangled key binding must not read as "unbound".
    if (saved.keyId !== undefined && (typeof saved.keyId !== "string" || !KEY_ID.test(saved.keyId))) {
      throw unreadable("a malformed reservation key ID");
    }
    return {
      boardId: saved.boardId ?? null,
      captured: saved.captured ?? entries.size,
      closed: saved.closed ?? false,
      entries,
      keyId: saved.keyId ?? null,
      reserved,
      version: saved.version ?? 0,
    };
  }

  // For the health check: the board can be read, and is bound to this
  // instance's reservation key.
  async assertKeyBound() {
    const disk = await this.snapshot();
    if (this.keyId && disk.keyId !== this.keyId) throw new KeyMismatchError();
  }

  // Copies, so a change applied to memory can never alter the snapshot it
  // may have to be rolled back to.
  load(disk) {
    this.entries = new Map([...disk.entries].map(([id, entry]) => [id, { ...entry }]));
    this.reserved = new Set(disk.reserved);
    this.closed = disk.closed;
    this.captured = disk.captured;
    this.boardId = disk.boardId;
  }

  // A lease is one small JSON document: who holds it and when they last
  // renewed it. Identity and age come from the same read, so a judgement that
  // a lease is stale always refers to that exact lease, never to one created
  // a moment later. (File mtimes cannot give that: a stat and a read are two
  // operations that can see two different files.)
  static lease(owner) { return JSON.stringify({ at: Date.now(), owner }); }

  async readLease() {
    let text;
    try { text = await readFile(this.lockFile, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    try {
      const { at, owner } = JSON.parse(text);
      return typeof owner === "string" && Number.isFinite(at) ? { at, owner, text } : { at: Infinity, owner: null, text };
    } catch {
      // Unparseable: a write in progress, or a creator that died mid-write.
      // seenAlive decides which, by watching it.
      return { at: Infinity, owner: null, text };
    }
  }

  async acquireLock() {
    const owner = randomBytes(8).toString("hex");
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        // Exclusive create is atomic on the /home share: exactly one instance wins.
        await writeFile(this.lockFile, FileStore.lease(owner), { flag: "wx" });
        return owner;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const held = await this.readLease();
      if (held && Date.now() - await this.seenAlive(held) > this.staleLockMs) {
        await this.takeOver(held);
        this.malformed = null;
        continue;
      }
      if (held && Date.now() > deadline) {
        throw Object.assign(new Error("The board is locked by another instance."), { code: "board_locked" });
      }
      await new Promise(resolve => setTimeout(resolve, 20 + Math.floor(Math.random() * 30)));
    }
  }

  // Taking a lease over and releasing one are this single step, and neither
  // ever overwrites a lease. The lock is moved aside in one atomic rename and
  // what was moved is compared with the lease the caller expected. Only on a
  // match is it gone for good. On a mismatch (another instance's lease), what
  // was moved is put back unchanged with an exclusive create, so it cannot
  // land on top of anyone. A holder that loses its lease this way cannot
  // commit: the ownership check before its rename fails.
  async swapLease(expected) {
    const aside = `${this.lockFile}.${randomBytes(6).toString("hex")}.aside`;
    try {
      await rename(this.lockFile, aside);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    try {
      const moved = await readFile(aside, "utf8");
      if (moved === expected) return true;
      await this.restoreLease(moved);
      return false;
    } finally {
      await rm(aside, { force: true }).catch(() => {});
    }
  }

  // Puts back a lease that was moved aside by mistake. Exclusive create: if a
  // third instance created a lock in that instant, theirs stands, and the
  // displaced holder's ownership check stops it from committing.
  async restoreLease(text) {
    try { await writeFile(this.lockFile, text, { flag: "wx" }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }

  // Renewal never touches the lock file. Each holder beats on its own file,
  // named for its owner token, which no other instance ever writes. So a
  // renewal cannot overwrite a successor's lease however it interleaves with
  // a takeover, and the lock itself is never absent while held.
  beatFile(owner) { return `${this.lockFile}.${owner}.beat`; }

  // When the holder named in this lease was last known to be working: the
  // later of the lease's own time and the holder's last heartbeat. Both are
  // read for that one owner, so the age always belongs to the lease judged.
  async lastSeen(lease) {
    if (lease.owner === null) return lease.at;
    try {
      const beat = Number(await readFile(this.beatFile(lease.owner), "utf8"));
      return Number.isFinite(beat) ? Math.max(lease.at, beat) : lease.at;
    } catch (error) {
      if (error.code === "ENOENT") return lease.at;
      throw error;
    }
  }

  // How recently the lease's holder was known to be alive.
  //
  // A malformed lease carries no time: its creator was stopped between the
  // exclusive create and finishing the write. Treating it as live forever
  // would block the board for good. So this instance times its own watch of
  // that exact text, and only while it watches continuously: a gap longer
  // than a few polls means it may have missed the lease changing and coming
  // back identical (an empty file from a new creator), so the clock restarts.
  // A creator mid-write finishes in milliseconds; one that stays malformed
  // for the whole stale period is dead. Takeover still compares the exact
  // text, so a lease that has since been completed is never removed.
  async seenAlive(lease, now = Date.now()) {
    if (lease.owner !== null) {
      this.malformed = null;
      return this.lastSeen(lease);
    }
    const watching = this.malformed?.text === lease.text && now - this.malformed.lastObserved <= MALFORMED_WATCH_GAP_MS;
    this.malformed = watching ? { ...this.malformed, lastObserved: now } : { lastObserved: now, since: now, text: lease.text };
    return this.malformed.since;
  }

  // Removes the lease judged stale, and only that one, then its heartbeat.
  async takeOver(lease) {
    const removed = await this.swapLease(lease.text);
    if (removed && lease.owner !== null) await rm(this.beatFile(lease.owner), { force: true }).catch(() => {});
  }

  // One heartbeat. Never throws: a missed beat is simply not a renewal, and
  // the ownership check before the commit is what decides.
  async renewOnce(owner) {
    const temporary = `${this.beatFile(owner)}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, String(Date.now()));
      await rename(temporary, this.beatFile(owner));
      return true;
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
      return false;
    }
  }

  // Beats on a timer while this instance holds the lock. A rejected promise
  // parked between ticks would count as unhandled and could stop the service,
  // so renewOnce never throws.
  renewLease(owner) {
    let stopped = false;
    let inFlight = Promise.resolve();
    const timer = setInterval(() => {
      inFlight = inFlight.then(() => (stopped ? false : this.renewOnce(owner)));
    }, Math.floor(this.staleLockMs / 3));
    timer.unref?.();
    // Stopping waits for a beat already under way, then removes the heartbeat,
    // so a finished holder leaves nothing that could keep a lease looking alive.
    return async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
      await rm(this.beatFile(owner), { force: true }).catch(() => {});
    };
  }

  async assertOwner(owner) {
    if ((await this.readLease())?.owner !== owner) throw new LockLostError();
  }

  // Releases only this instance's own lease, through the swap: a lease a
  // successor holds is put back, never deleted.
  async releaseLock(owner) {
    const held = await this.readLease();
    if (held?.owner === owner) await this.swapLease(held.text);
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
      const keyIdBefore = this.keyId;
      try {
        const disk = await this.snapshot();
        // Checked under the lock on every write: an instance still holding a
        // key the board is no longer bound to would record reservations that
        // the rest of the service cannot match, or miss theirs. A board whose
        // binding has gone counts too: writing would bind it back to this
        // instance's key, which may be the obsolete one. A restart re-binds.
        if (this.keyId && disk.keyId !== this.keyId) throw new KeyMismatchError();
        this.load(disk);
        try {
          const result = await change();
          if ((await this.snapshot()).version !== disk.version) throw new ConcurrentWriteError();
          await this.persist(`${JSON.stringify({
            // Minted with the board's first write, and changed only by a clear.
            boardId: this.boardId ?? randomBytes(16).toString("hex"),
            captured: this.captured,
            closed: Boolean(this.closed),
            entries: [...this.entries.values()], keyId: this.keyId ?? disk.keyId ?? undefined,
            reserved: [...this.reserved], version: disk.version + 1,
          })}\n`, owner);
          return result;
        } catch (error) {
          this.load(disk);
          this.keyId = keyIdBefore;
          throw error;
        }
      } finally {
        await stopRenewing();
        // A lease that cannot be removed expires on its own. Failing here would
        // turn a write that already landed into an error, or hide the error
        // that actually stopped the write.
        await this.releaseLock(owner).catch(() => {});
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

  openBoard() { return this.serialise(() => super.openBoard()); }

  // The cleared board is kept beside the live one, under the lock and before
  // anything changes, so a clear never destroys the only copy of an event.
  clearBoard(expectedBoardId) {
    return this.serialise(async () => {
      if (expectedBoardId !== this.boardId) throw new BoardChangedError();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await copyFile(this.file, this.file.replace(/\.json$/, `.cleared-${stamp}.json`), constants.COPYFILE_EXCL);
      return super.clearBoard(expectedBoardId);
    });
  }

  // From disk, like every read, so every instance agrees on it.
  async state() {
    const { boardId, captured, closed } = await this.snapshot();
    return { boardId, captured, closed };
  }

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
const RESERVATION_KEY = /^[0-9a-f]{64}$/;

// Reads the key, waiting while it is still being written. An exclusive create
// makes the file before its contents land, so a second instance starting at
// the same moment can see it empty or partial. Using a partial key would
// fingerprint names differently from every other instance, so a key that is
// not a complete 64-hex value is never returned; one that stays incomplete is
// an error, not something to replace.
async function readReservationKey(file, deadline) {
  for (;;) {
    const text = (await readFile(file, "utf8")).trim();
    if (RESERVATION_KEY.test(text)) return text;
    if (Date.now() > deadline) {
      throw new Error(`${file} does not hold a complete reservation key. Restore it rather than delete it: `
        + "a new key would release every reserved name.");
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// `create` writes the new key; it is replaceable so tests can hold a create
// half-done, the moment another instance must not read.
// Which key a board's reservations were fingerprinted with. Stored on the
// board, so a key that no longer matches is noticed rather than silently
// making every takedown unmatchable.
export const keyIdOf = key => createHash("sha256").update(`key:${key}`).digest("hex").slice(0, 16);

// Opens the reservation key for this store and binds it to the board. Fails
// closed: if the key file is gone while the board holds reservations, a new
// key would void every takedown, so the service refuses to start and says to
// restore the key. A board fingerprinted with a different key is refused too.
//
// The decision, any key creation and the binding happen under the store's
// cross-instance lock, and the binding is written to the board before the
// instance serves anything. An instance that started earlier with another
// key then finds the board bound to a key it does not hold, and every write
// it attempts is refused (KeyMismatchError) instead of recording
// fingerprints nobody else can match.
export async function openReservationKey(directory, store, options = {}) {
  const bind = () => bindReservationKey(directory, store, options);
  return typeof store.serialise === "function" ? store.serialise(bind) : bind();
}

async function bindReservationKey(directory, store, options) {
  const board = await store.snapshot();
  let exists = true;
  try { await readFile(join(directory, "reservation.key"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") exists = false; else throw error; }
  if (!exists && board.reserved.size > 0) {
    throw new Error(`reservation.key is missing, but ${store.file} holds ${board.reserved.size} reserved name(s). `
      + "Restore the key from backup; a new key would let every taken-down name be published again.");
  }
  const key = await reservationKey(directory, options);
  const keyId = keyIdOf(key);
  if (board.keyId && board.keyId !== keyId && board.reserved.size > 0) {
    throw new Error(`${store.file} was reserved with a different reservation key. Restore the matching reservation.key.`);
  }
  store.keyId = keyId;
  return key;
}

export async function reservationKey(directory, {
  waitMs = 5_000, create = (path, text) => writeFile(path, text, { flag: "wx", mode: 0o600 }),
} = {}) {
  const file = join(directory, "reservation.key");
  const deadline = Date.now() + waitMs;
  try {
    return await readReservationKey(file, deadline);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(directory, { recursive: true });
  const key = randomBytes(32).toString("hex");
  // "wx" fails if another instance created it first, rather than replacing it.
  // That instance's key is the one to use, once it is completely written.
  try {
    await create(file, `${key}\n`);
  } catch (error) {
    if (error.code === "EEXIST") return readReservationKey(file, deadline);
    throw error;
  }
  await chmod(file, 0o600);
  return key;
}
