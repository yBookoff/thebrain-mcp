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
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
  /** Null until the file is there: opened by the first write, or found by a read. */
  #db: DatabaseSync | null = null;
  /** In-memory cache: filled on first search, not on open. */
  #cache: StoredVector[] | null = null;

  constructor(path: string) {
    this.#path = path;
    if (path === ":memory:") this.#open();
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
  }

  /** The database for a write: created, with its directory, when it is not there. */
  #open(): DatabaseSync {
    if (this.#db !== null) return this.#db;
    if (this.#path !== ":memory:") mkdirSync(dirname(this.#path), { recursive: true });
    const db = new DatabaseSync(this.#path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA);
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

  // ---------------------------------------------------------------- metadata

  getMeta(): IndexMeta | null {
    const db = this.#existing();
    if (db === null) return null;
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
  }

  setMeta(meta: IndexMeta): void {
    const stmt = this.#open().prepare(
      "INSERT INTO meta(key, value) VALUES(?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    stmt.run("brainId", meta.brainId);
    stmt.run("model", meta.model);
    stmt.run("dimensions", String(meta.dimensions));
    if (meta.syncedThrough !== null) stmt.run("syncedThrough", meta.syncedThrough);
  }

  setSyncedThrough(iso: string): void {
    this.#open()
      .prepare(
        "INSERT INTO meta(key, value) VALUES('syncedThrough', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(iso);
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

  clear(): void {
    this.#existing()?.exec("DELETE FROM vectors; DELETE FROM meta;");
    this.#cache = null;
  }

  // ------------------------------------------------------------------ writes

  upsert(entries: readonly StoredVector[]): void {
    if (entries.length === 0) return;
    const db = this.#open();
    const stmt = db.prepare(
      "INSERT INTO vectors(thought_id, name, kind, content_hash, vector) " +
        "VALUES(?, ?, ?, ?, ?) ON CONFLICT(thought_id) DO UPDATE SET " +
        "name = excluded.name, kind = excluded.kind, " +
        "content_hash = excluded.content_hash, vector = excluded.vector",
    );
    db.exec("BEGIN");
    try {
      for (const e of entries) {
        stmt.run(
          e.thoughtId,
          e.name,
          e.kind,
          e.contentHash,
          Buffer.from(e.vector.buffer, e.vector.byteOffset, e.vector.byteLength),
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
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
    const db = this.#existing();
    if (db === null) return;
    const stmt = db.prepare("UPDATE vectors SET kind = ? WHERE thought_id = ?");
    db.exec("BEGIN");
    try {
      for (const [id, kind] of kinds) stmt.run(kind, id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    this.#cache = null;
  }

  remove(thoughtIds: readonly string[]): void {
    if (thoughtIds.length === 0) return;
    // Nor one to remove: `brain_delete_thought` calls this for a brain that
    // may never have been indexed.
    const db = this.#existing();
    if (db === null) return;
    const stmt = db.prepare("DELETE FROM vectors WHERE thought_id = ?");
    db.exec("BEGIN");
    try {
      for (const id of thoughtIds) stmt.run(id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    this.#cache = null;
  }

  // ------------------------------------------------------------------- reads

  size(): number {
    const db = this.#existing();
    if (db === null) return 0;
    const row = db.prepare("SELECT COUNT(*) AS n FROM vectors").get() as {
      n: number;
    };
    return row.n;
  }

  /** Hashes of what is already indexed, so unchanged entries can be skipped. */
  contentHashes(): Map<string, string> {
    const db = this.#existing();
    if (db === null) return new Map();
    const rows = db
      .prepare("SELECT thought_id, content_hash FROM vectors")
      .all() as Array<{ thought_id: string; content_hash: string }>;
    return new Map(rows.map((r) => [r.thought_id, r.content_hash]));
  }

  /**
   * The kind each row was indexed with. It is no part of the document, so the
   * hash says nothing of it and it is compared on its own.
   */
  kinds(): Map<string, number> {
    const db = this.#existing();
    if (db === null) return new Map();
    const rows = db.prepare("SELECT thought_id, kind FROM vectors").all() as Array<{
      thought_id: string;
      kind: number;
    }>;
    return new Map(rows.map((r) => [r.thought_id, r.kind]));
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

  #load(): StoredVector[] {
    if (this.#cache !== null) return this.#cache;
    const db = this.#existing();
    // Not cached: the file may be there by the next search.
    if (db === null) return [];
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
    return this.#cache;
  }
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
