/**
 * Vector storage on `node:sqlite`.
 *
 * A vector index is deliberately not used: 50,000 thoughts at 384 dimensions
 * is 75 MB and roughly 30 ms for a full scan. Brute force is simpler and,
 * more importantly for an npx install, needs no native extension.
 *
 * Loading into memory is lazy, so the server's cold start stays fast.
 *
 * So is the file. A store is named by a brain's identifier and is opened for
 * a look as often as for a build: `brain_list` asks every brain's, and
 * `brain_search` asks before it knows the brain is there. Opening used to
 * create the file, three of them with the journal, so a look left an empty
 * index behind for every brain listed and for a `brainId` that is no brain.
 * Now only a write creates it, and a read of a file that is not there answers
 * what an empty index would.
 *
 * The file is shared. Every client session starts a server process of its
 * own, and they all open the same file for a brain. What here is for that,
 * each measured with real server processes (ARCHITECTURE.md, §8):
 *
 * - **The rows in memory follow the file.** A search asks SQLite for its
 *   `data_version` first, which changes when any other connection commits,
 *   and reads the rows again when it has. They used to be dropped by this
 *   store's own writes alone: a process went on ranking by what it had loaded
 *   whatever another one built since.
 * - **A write is one transaction**: all of it is in the file or none is,
 *   also for a process that is killed part of the way.
 * - **A statement waits for another connection's write**, `BUSY_TIMEOUT_MS`,
 *   where it used to fail at once with SQLite's `database is locked`. One
 *   that waits that long in vain throws `IndexBusyError`, a sentence.
 * - **A run takes the index for itself** (`claim`), so that two rebuilds or
 *   syncs are one after the other and never interleaved.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface StoredVector {
  thoughtId: string;
  name: string;
  kind: number;
  /** Hash of the indexed text: lets unchanged thoughts skip re-embedding. */
  contentHash: string;
  vector: Float32Array;
}

export interface SimilarityHit {
  thoughtId: string;
  name: string;
  kind: number;
  score: number;
}

export interface IndexMeta {
  brainId: string;
  /** Model identifier. Changing the model invalidates the index. */
  model: string;
  dimensions: number;
  /** The point up to which the modification log has been replayed. */
  syncedThrough: string | null;
}

/**
 * How long a statement waits for a write another connection has open, in
 * milliseconds. SQLite's own default is not to wait: with two processes
 * writing in batches, one of them failed with `database is locked` in 11
 * pairs of runs out of 13. No write here is longer than a batch of rows, a
 * few milliseconds, so this is never waited out between two servers that both
 * work; the wait blocks the process, which is why it is not longer.
 */
export const BUSY_TIMEOUT_MS = 2_000;

/**
 * How long a run waits for the run that holds the index before it gives up,
 * in milliseconds, and how often it asks. A sync that follows an ingest takes
 * from a tenth of a second to a few seconds, and that is the run two sessions
 * start at the same moment: the second one waits it out. A rebuild of a large
 * brain takes minutes and is not waited for.
 */
export const RUN_WAIT_MS = 10_000;
const RUN_POLL_MS = 50;

export interface StoreOptions {
  /** In place of `BUSY_TIMEOUT_MS`. */
  busyTimeoutMs?: number;
}

/** What every message here says of why there is another process at all. */
const SHARED =
  "Every client session runs a server process of its own, and they share one index file";

/**
 * Another connection had the index file locked for longer than a statement
 * waits. Its message is whole: a tool passes it on as it is.
 */
export class IndexBusyError extends Error {
  constructor(doing: "read" | "write", waitedMs: number, cause: unknown) {
    super(
      "Another server process had the semantic index of this brain locked, and had not let " +
        `go of it after ${seconds(waitedMs)}. ${SHARED}. ` +
        (doing === "write"
          ? "This write to the index was not made."
          : "The index was not read."),
      { cause },
    );
    this.name = "IndexBusyError";
  }
}

/**
 * Another run holds the index, a rebuild or a sync, and did not finish while
 * this one waited. Nothing was read or written by the run that throws it.
 */
export class IndexRunningError extends Error {
  readonly waitedMs: number;

  constructor(waitedMs: number) {
    super(
      "Another rebuild or sync of this brain's semantic index is running, and had not " +
        `finished after ${seconds(waitedMs)} of waiting. ${SHARED}, which one run writes ` +
        "at a time.",
    );
    this.name = "IndexRunningError";
    this.waitedMs = waitedMs;
  }
}

function seconds(ms: number): string {
  return `${ms >= 1000 ? Math.round(ms / 1000) : Number((ms / 1000).toFixed(2))} s`;
}

/** SQLITE_BUSY or SQLITE_LOCKED, whatever the extended code. */
function isBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { errcode?: unknown }).errcode;
  if (typeof code === "number") return (code & 0xff) === 5 || (code & 0xff) === 6;
  return /database (table )?is locked/i.test(error.message);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vectors (
  thought_id   TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  vector       BLOB NOT NULL
);
`;

export class VectorStore {
  readonly #path: string;
  readonly #busyTimeoutMs: number;
  /** Null until the file is there: opened by the first write, or found by a read. */
  #db: DatabaseSync | null = null;
  /** In-memory cache: filled on first search, not on open. */
  #cache: StoredVector[] | null = null;
  /** The file's `data_version` as this connection saw it before the cache was read. */
  #cacheVersion = -1;
  /** A run holds a store in memory: there is no file to lock. */
  #claimed = false;

  constructor(path: string, options: StoreOptions = {}) {
    this.#path = path;
    this.#busyTimeoutMs = options.busyTimeoutMs ?? BUSY_TIMEOUT_MS;
    if (path === ":memory:") this.#open();
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
    // A `data_version` is one connection's count, and the next connection
    // starts its own: the rows are read again rather than matched against it.
    this.#cache = null;
  }

  /** The database for a write: created, with its directory, when it is not there. */
  #open(): DatabaseSync {
    if (this.#db !== null) return this.#db;
    if (this.#path !== ":memory:") mkdirSync(dirname(this.#path), { recursive: true });
    const db = new DatabaseSync(this.#path);
    try {
      // First, so that the two below wait as well: another process may be
      // making this file at this moment, and the look that met it half made
      // answered `database is locked`.
      db.exec(`PRAGMA busy_timeout = ${this.#busyTimeoutMs}`);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(SCHEMA);
    } catch (error) {
      db.close();
      throw error;
    }
    this.#db = db;
    return db;
  }

  /**
   * The database for a read, or null while there is no file: nothing is
   * created to be looked at. Asked each time, since another process sharing
   * the data directory may have built the index meanwhile.
   */
  #existing(): DatabaseSync | null {
    if (this.#db !== null) return this.#db;
    return existsSync(this.#path) ? this.#open() : null;
  }

  /** A read; `empty` is its answer while there is no file. */
  #read<T>(empty: T, read: (db: DatabaseSync) => T): T {
    try {
      const db = this.#existing();
      return db === null ? empty : read(db);
    } catch (error) {
      throw this.#busy(error, "read");
    }
  }

  /**
   * A write, as one transaction: all of it is in the file or none of it, for
   * this process when a statement fails and for every other when this one is
   * killed. `create` is false for a write that has nothing to write to while
   * there is no file.
   *
   * `BEGIN IMMEDIATE` takes the write lock at once, waiting for it if another
   * connection has it, so that the wait is over before the first row.
   */
  #write(create: boolean, write: (db: DatabaseSync) => void): void {
    try {
      const db = create ? this.#open() : this.#existing();
      if (db === null) return;
      db.exec("BEGIN IMMEDIATE");
      try {
        write(db);
        db.exec("COMMIT");
      } catch (error) {
        // SQLite has rolled some failures back itself, and then this throws:
        // the failure that is told is the first one.
        try {
          db.exec("ROLLBACK");
        } catch {
          // Nothing left to roll back.
        }
        throw error;
      }
    } catch (error) {
      throw this.#busy(error, "write");
    }
  }

  /** SQLite's `database is locked` as a sentence; any other error as it is. */
  #busy(error: unknown, doing: "read" | "write"): unknown {
    return isBusy(error) ? new IndexBusyError(doing, this.#busyTimeoutMs, error) : error;
  }

  // -------------------------------------------------------------------- runs

  /**
   * Takes the index for one run, a rebuild or a sync, and resolves with what
   * gives it back. While it is held no other run gets it, in this process or
   * in another: one that asks waits up to `waitMs`, and then is refused with
   * `IndexRunningError`. Reads and single writes do not ask for it.
   *
   * A run reads TheBrain for seconds or minutes and then writes, and what it
   * writes it decided by the index it found when it started. Two runs over
   * each other wrote an older reading of a thought over a newer one and left
   * the watermark past the change (ARCHITECTURE.md, §8).
   *
   * What is held is a lock on a file beside the index, `<index>.lock`, taken
   * through SQLite because that is the lock Node has: the operating system
   * drops it when the process that holds it dies, however it dies, so a
   * killed run leaves nothing to clear. Nothing is ever written to that file.
   * It is made by the first run and stays, empty.
   */
  async claim(waitMs: number = RUN_WAIT_MS): Promise<() => void> {
    const started = Date.now();
    for (;;) {
      const release = this.#tryClaim();
      if (release !== null) return release;
      const left = waitMs - (Date.now() - started);
      if (left <= 0) throw new IndexRunningError(waitMs);
      await sleep(Math.min(RUN_POLL_MS, left));
    }
  }

  #tryClaim(): (() => void) | null {
    // Given back once, however often it is called: a second call must not
    // let go of what the next run holds by then.
    const once = (release: () => void) => {
      let held = true;
      return (): void => {
        if (!held) return;
        held = false;
        release();
      };
    };
    if (this.#path === ":memory:") {
      if (this.#claimed) return null;
      this.#claimed = true;
      return once(() => {
        this.#claimed = false;
      });
    }
    mkdirSync(dirname(this.#path), { recursive: true });
    const lock = new DatabaseSync(`${this.#path}.lock`);
    try {
      // The journal in memory: with the default one a file appears beside the
      // lock for as long as it is held, and outlives a holder that is killed.
      lock.exec("PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE");
    } catch (error) {
      lock.close();
      if (isBusy(error)) return null;
      throw error;
    }
    // Closing ends the transaction, and with it the lock.
    return once(() => lock.close());
  }

  // ---------------------------------------------------------------- metadata

  getMeta(): IndexMeta | null {
    return this.#read(null, (db) => {
      const rows = db.prepare("SELECT key, value FROM meta").all() as Array<{
        key: string;
        value: string;
      }>;
      if (rows.length === 0) return null;
      const map = new Map(rows.map((r) => [r.key, r.value]));
      const brainId = map.get("brainId");
      const model = map.get("model");
      const dimensions = map.get("dimensions");
      if (brainId === undefined || model === undefined || dimensions === undefined) {
        return null;
      }
      return {
        brainId,
        model,
        dimensions: Number(dimensions),
        syncedThrough: map.get("syncedThrough") ?? null,
      };
    });
  }

  setMeta(meta: IndexMeta): void {
    this.#write(true, (db) => putMeta(db, meta));
  }

  setSyncedThrough(iso: string): void {
    this.#write(true, (db) => {
      db.prepare(
        "INSERT INTO meta(key, value) VALUES('syncedThrough', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(iso);
    });
  }

  /**
   * The index is usable only when brain, model and dimensions all match.
   * A model change would silently corrupt search, so it is checked explicitly.
   */
  isCompatible(brainId: string, model: string, dimensions: number): boolean {
    const meta = this.getMeta();
    if (meta === null) return false;
    return (
      meta.brainId === brainId &&
      meta.model === model &&
      meta.dimensions === dimensions
    );
  }

  /**
   * Empties the index and writes the metadata of the build that takes its
   * place, in one transaction. A rebuild over an index of another model did
   * it in three steps: the rows, the old metadata, the new. A process killed
   * after the first left the old model's metadata, watermark included, over
   * no rows at all, which reads as a built index, and a sync by a server of
   * that model would then have added to it the thoughts changed since.
   */
  startOver(meta: IndexMeta): void {
    this.#write(true, (db) => {
      db.exec("DELETE FROM vectors; DELETE FROM meta;");
      putMeta(db, meta);
    });
    this.#cache = null;
  }

  // ------------------------------------------------------------------ writes

  upsert(entries: readonly StoredVector[]): void {
    if (entries.length === 0) return;
    this.#write(true, (db) => {
      const stmt = db.prepare(
        "INSERT INTO vectors(thought_id, name, kind, content_hash, vector) " +
          "VALUES(?, ?, ?, ?, ?) ON CONFLICT(thought_id) DO UPDATE SET " +
          "name = excluded.name, kind = excluded.kind, " +
          "content_hash = excluded.content_hash, vector = excluded.vector",
      );
      for (const e of entries) {
        stmt.run(
          e.thoughtId,
          e.name,
          e.kind,
          e.contentHash,
          Buffer.from(e.vector.buffer, e.vector.byteOffset, e.vector.byteLength),
        );
      }
    });
    this.#cache = null;
  }

  /**
   * Sets the kind of rows that are there already and leaves the rest of each:
   * name, hash and vector. A thought that changes kind keeps its document, so
   * there is nothing to encode, and the kind is what `search` excludes by.
   * An identifier with no row is passed over.
   */
  setKinds(kinds: ReadonlyMap<string, number>): void {
    if (kinds.size === 0) return;
    // With no file there is no row to set a kind on.
    this.#write(false, (db) => {
      const stmt = db.prepare("UPDATE vectors SET kind = ? WHERE thought_id = ?");
      for (const [id, kind] of kinds) stmt.run(kind, id);
    });
    this.#cache = null;
  }

  remove(thoughtIds: readonly string[]): void {
    if (thoughtIds.length === 0) return;
    // Nor one to remove: `brain_delete_thought` calls this for a brain that
    // may never have been indexed.
    this.#write(false, (db) => {
      const stmt = db.prepare("DELETE FROM vectors WHERE thought_id = ?");
      for (const id of thoughtIds) stmt.run(id);
    });
    this.#cache = null;
  }

  // ------------------------------------------------------------------- reads

  size(): number {
    return this.#read(0, (db) => {
      const row = db.prepare("SELECT COUNT(*) AS n FROM vectors").get() as {
        n: number;
      };
      return row.n;
    });
  }

  /** Hashes of what is already indexed, so unchanged entries can be skipped. */
  contentHashes(): Map<string, string> {
    return this.#read(new Map<string, string>(), (db) => {
      const rows = db
        .prepare("SELECT thought_id, content_hash FROM vectors")
        .all() as Array<{ thought_id: string; content_hash: string }>;
      return new Map(rows.map((r) => [r.thought_id, r.content_hash]));
    });
  }

  /**
   * The kind each row was indexed with. It is no part of the document, so the
   * hash says nothing of it and it is compared on its own.
   */
  kinds(): Map<string, number> {
    return this.#read(new Map<string, number>(), (db) => {
      const rows = db.prepare("SELECT thought_id, kind FROM vectors").all() as Array<{
        thought_id: string;
        kind: number;
      }>;
      return new Map(rows.map((r) => [r.thought_id, r.kind]));
    });
  }

  /**
   * Nearest by cosine. Vectors are normalised on write, so cosine is just a
   * dot product.
   */
  search(
    query: Float32Array,
    options: { limit?: number; excludeKinds?: readonly number[] } = {},
  ): SimilarityHit[] {
    const limit = options.limit ?? 20;
    const exclude = new Set(options.excludeKinds ?? []);
    const all = this.#load();

    const hits: SimilarityHit[] = [];
    for (const entry of all) {
      if (exclude.has(entry.kind)) continue;
      hits.push({
        thoughtId: entry.thoughtId,
        name: entry.name,
        kind: entry.kind,
        score: dot(query, entry.vector),
      });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  /**
   * The rows a search ranks, from memory while the file is as it was when
   * they were read.
   *
   * `PRAGMA data_version` is SQLite's own count of the commits other
   * connections have made to the file, another process's among them, and it
   * does not move for this connection's own: those drop the cache themselves.
   * Asking costs a microsecond, against six milliseconds for the scan of
   * 20,000 vectors, and nothing has to be kept in step by whoever writes: the
   * file's modification time does not move at all for a commit, which goes
   * to the journal beside it, and a counter of this store's own would stand
   * still for a server of an older version.
   *
   * It is asked for before the rows and not after. A commit that lands
   * between the two is then in the rows and not in the count: the next
   * search reads them once more for nothing. The other way round it would be
   * in the count and not in the rows, and never read.
   */
  #load(): StoredVector[] {
    // Not cached while there is no file: it may be there by the next search.
    return this.#read<StoredVector[]>([], (db) => {
      const { data_version: version } = db.prepare("PRAGMA data_version").get() as {
        data_version: number;
      };
      if (this.#cache !== null && this.#cacheVersion === version) return this.#cache;
      const rows = db
        .prepare("SELECT thought_id, name, kind, content_hash, vector FROM vectors")
        .all() as Array<{
        thought_id: string;
        name: string;
        kind: number;
        content_hash: string;
        vector: Uint8Array;
      }>;
      this.#cache = rows.map((r) => ({
        thoughtId: r.thought_id,
        name: r.name,
        kind: r.kind,
        contentHash: r.content_hash,
        // Copy: the Buffer backing from SQLite may be reused.
        vector: new Float32Array(
          r.vector.buffer.slice(
            r.vector.byteOffset,
            r.vector.byteOffset + r.vector.byteLength,
          ),
        ),
      }));
      this.#cacheVersion = version;
      return this.#cache;
    });
  }
}

/** The rows of `meta` for a build. A watermark that is null leaves the one there. */
function putMeta(db: DatabaseSync, meta: IndexMeta): void {
  const stmt = db.prepare(
    "INSERT INTO meta(key, value) VALUES(?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  stmt.run("brainId", meta.brainId);
  stmt.run("model", meta.model);
  stmt.run("dimensions", String(meta.dimensions));
  if (meta.syncedThrough !== null) stmt.run("syncedThrough", meta.syncedThrough);
}

/** Dot product. Equals cosine for normalised vectors. */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += a[i]! * b[i]!;
  return sum;
}

/** In-place normalisation: afterwards cosine is a single multiply. */
export function normalize(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  for (let i = 0; i < vector.length; i += 1) vector[i] = vector[i]! / norm;
  return vector;
}
