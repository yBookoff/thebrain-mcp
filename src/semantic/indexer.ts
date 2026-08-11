/**
 * Building and maintaining the semantic index.
 *
 * The initial build is triggered by an explicit tool rather than at server
 * start: on a 10,000-thought brain it takes about a minute, and the user
 * should know it is happening.
 *
 * Thoughts are enumerated through the modification log — the API has no
 * "list all" endpoint. The same log supplies incremental sync signals.
 */

import type { TheBrainApi } from "../api/index.js";
import {
  ModType,
  REEMBED_MOD_TYPES,
  ThoughtKind,
  type ModificationLogDto,
} from "../api/types.js";
import { replayThoughtIds } from "../api/resources/thoughts.js";
import { buildDocument, documentHash, type IndexableThought } from "./document.js";
import type { Embedder } from "./embedder.js";
import type { StoredVector, VectorStore } from "./store.js";

export interface IndexProgress {
  phase: "enumerate" | "fetch" | "embed" | "store" | "done";
  done: number;
  total: number;
  message: string;
}

export interface IndexResult {
  indexed: number;
  skipped: number;
  removed: number;
  elapsedMs: number;
}

export interface IndexStatus {
  exists: boolean;
  compatible: boolean;
  brainId: string | null;
  model: string | null;
  size: number;
  syncedThrough: string | null;
}

export interface IndexerOptions {
  /** How many API requests to keep in flight. The API handles twenty easily. */
  concurrency?: number;
  /** How many documents to encode per batch before writing to storage. */
  embedBatch?: number;
}

const DEFAULT_CONCURRENCY = 12;
const DEFAULT_EMBED_BATCH = 64;

/** Thought kinds we skip: system and internal ones. */
const SKIP_KINDS: ReadonlySet<number> = new Set([ThoughtKind.System]);

export class SemanticIndexer {
  readonly #api: TheBrainApi;
  readonly #store: VectorStore;
  readonly #embedder: Embedder;
  readonly #concurrency: number;
  readonly #embedBatch: number;

  constructor(
    api: TheBrainApi,
    store: VectorStore,
    embedder: Embedder,
    options: IndexerOptions = {},
  ) {
    this.#api = api;
    this.#store = store;
    this.#embedder = embedder;
    this.#concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.#embedBatch = options.embedBatch ?? DEFAULT_EMBED_BATCH;
  }

  status(brainId: string): IndexStatus {
    const meta = this.#store.getMeta();
    return {
      exists: meta !== null,
      compatible: this.#store.isCompatible(
        brainId,
        this.#embedder.id,
        this.#embedder.dimensions,
      ),
      brainId: meta?.brainId ?? null,
      model: meta?.model ?? null,
      size: this.#store.size(),
      syncedThrough: meta?.syncedThrough ?? null,
    };
  }

  /**
   * Full re-index.
   *
   * Unchanged thoughts are reused by document hash, so a repeat run is cheap:
   * embeddings are computed only for what actually changed.
   */
  async rebuild(
    brainId: string,
    onProgress: (p: IndexProgress) => void = (): void => undefined,
  ): Promise<IndexResult> {
    const startedAt = Date.now();
    const watermark = new Date().toISOString();

    if (!this.#store.isCompatible(brainId, this.#embedder.id, this.#embedder.dimensions)) {
      this.#store.clear();
    }
    this.#store.setMeta({
      brainId,
      model: this.#embedder.id,
      dimensions: this.#embedder.dimensions,
      syncedThrough: null,
    });

    onProgress({ phase: "enumerate", done: 0, total: 0, message: "reading the log" });
    const logs = await this.#api.brains.modifications(brainId);
    const alive = replayThoughtIds(logs);
    const withNotes = thoughtsWithNotes(logs);

    // Drop anything that no longer exists in the brain.
    const known = [...this.#store.contentHashes().keys()];
    const stale = known.filter((id) => !alive.has(id));
    this.#store.remove(stale);

    const result = await this.#indexThoughts(brainId, [...alive], withNotes, onProgress);
    this.#store.setSyncedThrough(watermark);

    onProgress({
      phase: "done",
      done: result.indexed + result.skipped,
      total: alive.size,
      message: "index built",
    });
    return { ...result, removed: stale.length, elapsedMs: Date.now() - startedAt };
  }

  /**
   * Incremental sync from the log.
   *
   * The watermark is taken at the start — a small overlap is harmless because
   * unchanged entries are filtered out by document hash.
   */
  async sync(
    brainId: string,
    onProgress: (p: IndexProgress) => void = (): void => undefined,
  ): Promise<IndexResult> {
    const startedAt = Date.now();
    const meta = this.#store.getMeta();
    if (
      meta === null ||
      !this.#store.isCompatible(brainId, this.#embedder.id, this.#embedder.dimensions)
    ) {
      return this.rebuild(brainId, onProgress);
    }
    if (meta.syncedThrough === null) return this.rebuild(brainId, onProgress);

    const watermark = new Date().toISOString();
    onProgress({ phase: "enumerate", done: 0, total: 0, message: "reading changes" });
    const logs = await this.#api.brains.modifications(brainId, {
      since: meta.syncedThrough,
    });

    const touched = new Set<string>();
    const deleted = new Set<string>();
    for (const log of logs) {
      if (log.sourceType !== 2) continue;
      if (log.modType === ModType.Deleted) {
        deleted.add(log.sourceId);
        touched.delete(log.sourceId);
      } else if (log.modType === ModType.Created || REEMBED_MOD_TYPES.has(log.modType)) {
        if (!deleted.has(log.sourceId)) touched.add(log.sourceId);
      }
    }

    this.#store.remove([...deleted]);
    const withNotes = thoughtsWithNotes(logs);
    const result = await this.#indexThoughts(brainId, [...touched], withNotes, onProgress);
    this.#store.setSyncedThrough(watermark);

    onProgress({
      phase: "done",
      done: result.indexed,
      total: touched.size,
      message: "synced",
    });
    return { ...result, removed: deleted.size, elapsedMs: Date.now() - startedAt };
  }

  async #indexThoughts(
    brainId: string,
    ids: readonly string[],
    withNotes: ReadonlySet<string>,
    onProgress: (p: IndexProgress) => void,
  ): Promise<{ indexed: number; skipped: number }> {
    if (ids.length === 0) return { indexed: 0, skipped: 0 };

    const existing = this.#store.contentHashes();
    const total = ids.length;
    let fetched = 0;

    // The graph returns a thought, its tags and its type in one request —
    // cheaper than fetching them separately.
    const collected = await mapWithConcurrency(ids, this.#concurrency, async (id) => {
      const item = await this.#collect(brainId, id, withNotes.has(id));
      fetched += 1;
      if (fetched % 50 === 0 || fetched === total) {
        onProgress({
          phase: "fetch",
          done: fetched,
          total,
          message: `reading thoughts: ${fetched} of ${total}`,
        });
      }
      return item;
    });

    const pending: Array<{ thought: IndexableThought; doc: string; hash: string }> = [];
    let skipped = 0;
    for (const item of collected) {
      if (item === null) continue;
      if (SKIP_KINDS.has(item.kind)) continue;
      const doc = buildDocument(item);
      const hash = documentHash(doc);
      if (existing.get(item.id) === hash) {
        skipped += 1;
        continue;
      }
      pending.push({ thought: item, doc, hash });
    }

    let indexed = 0;
    for (let i = 0; i < pending.length; i += this.#embedBatch) {
      const chunk = pending.slice(i, i + this.#embedBatch);
      const vectors = await this.#embedder.embedDocuments(chunk.map((c) => c.doc));
      const rows: StoredVector[] = chunk.map((c, j) => ({
        thoughtId: c.thought.id,
        name: c.thought.name,
        kind: c.thought.kind,
        contentHash: c.hash,
        vector: vectors[j]!,
      }));
      this.#store.upsert(rows);
      indexed += rows.length;
      onProgress({
        phase: "embed",
        done: indexed,
        total: pending.length,
        message: `encoding: ${indexed} of ${pending.length}`,
      });
    }

    return { indexed, skipped };
  }

  async #collect(
    brainId: string,
    thoughtId: string,
    fetchNote: boolean,
  ): Promise<IndexableThought | null> {
    try {
      const graph = await this.#api.thoughts.getGraph(brainId, thoughtId);
      const note = fetchNote
        ? await this.#api.notes.get(brainId, thoughtId).catch(() => "")
        : "";
      return {
        id: graph.thought.id,
        name: graph.thought.name ?? "",
        kind: graph.thought.kind,
        label: graph.thought.label,
        typeName: graph.type?.name ?? null,
        tagNames: graph.tags.map((t) => t.name ?? "").filter((n) => n.length > 0),
        note,
      };
    } catch {
      // The thought may have vanished between reading the log and loading it.
      return null;
    }
  }
}

/** Thoughts with note-related events in the log. */
export function thoughtsWithNotes(logs: readonly ModificationLogDto[]): Set<string> {
  const ids = new Set<string>();
  for (const log of logs) {
    if (log.sourceType !== 2) continue;
    if (
      log.modType === ModType.NoteCreated ||
      log.modType === ModType.NoteChanged ||
      log.modType === ModType.NoteDeleted
    ) {
      ids.add(log.sourceId);
    }
  }
  return ids;
}

/** Bounded-concurrency map: the API is fast, but there is no need to flood it. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}
