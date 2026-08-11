/**
 * Vector storage on `node:sqlite`.
 *
 * A vector index is deliberately not used: 50,000 thoughts at 384 dimensions
 * is 75 MB and roughly 30 ms for a full scan. Brute force is simpler and,
 * more importantly for an npx install, needs no native extension.
 *
 * Loading into memory is lazy, so the server's cold start stays fast.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
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
  readonly #db: DatabaseSync;
  /** In-memory cache: filled on first search, not on open. */
  #cache: StoredVector[] | null = null;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  // ---------------------------------------------------------------- metadata

  getMeta(): IndexMeta | null {
    const rows = this.#db.prepare("SELECT key, value FROM meta").all() as Array<{
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
    const stmt = this.#db.prepare(
      "INSERT INTO meta(key, value) VALUES(?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    stmt.run("brainId", meta.brainId);
    stmt.run("model", meta.model);
    stmt.run("dimensions", String(meta.dimensions));
    if (meta.syncedThrough !== null) stmt.run("syncedThrough", meta.syncedThrough);
  }

  setSyncedThrough(iso: string): void {
    this.#db
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
    this.#db.exec("DELETE FROM vectors; DELETE FROM meta;");
    this.#cache = null;
  }

  // ------------------------------------------------------------------ writes

  upsert(entries: readonly StoredVector[]): void {
    if (entries.length === 0) return;
    const stmt = this.#db.prepare(
      "INSERT INTO vectors(thought_id, name, kind, content_hash, vector) " +
        "VALUES(?, ?, ?, ?, ?) ON CONFLICT(thought_id) DO UPDATE SET " +
        "name = excluded.name, kind = excluded.kind, " +
        "content_hash = excluded.content_hash, vector = excluded.vector",
    );
    this.#db.exec("BEGIN");
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
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    this.#cache = null;
  }

  remove(thoughtIds: readonly string[]): void {
    if (thoughtIds.length === 0) return;
    const stmt = this.#db.prepare("DELETE FROM vectors WHERE thought_id = ?");
    this.#db.exec("BEGIN");
    try {
      for (const id of thoughtIds) stmt.run(id);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    this.#cache = null;
  }

  // ------------------------------------------------------------------- reads

  size(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM vectors").get() as {
      n: number;
    };
    return row.n;
  }

  /** Hashes of what is already indexed, so unchanged entries can be skipped. */
  contentHashes(): Map<string, string> {
    const rows = this.#db
      .prepare("SELECT thought_id, content_hash FROM vectors")
      .all() as Array<{ thought_id: string; content_hash: string }>;
    return new Map(rows.map((r) => [r.thought_id, r.content_hash]));
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
    const rows = this.#db
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
