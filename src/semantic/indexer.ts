/**
 * Building and maintaining the semantic index.
 *
 * The initial build is triggered by an explicit tool rather than at server
 * start: on a 10,000-thought brain it takes about a minute, and the user
 * should know it is happening.
 *
 * The API has no "list all" endpoint. A rebuild enumerates thoughts from the
 * modification log and then walks the graph outward from the home thought and
 * from every logged thought, because the log alone misses thoughts that were
 * never created in this brain (imports, old brains). The log still supplies
 * incremental sync signals.
 */

import type { TheBrainApi } from "../api/index.js";
import type { CleanGraph } from "../api/resources/thoughts.js";
import {
  EntityType,
  ModType,
  REEMBED_MOD_TYPES,
  TAG_LINK_MOD_TYPES,
  ThoughtKind,
  aliasesOf,
  type ModificationLogDto,
} from "../api/types.js";
import { replayThoughtIds } from "../api/resources/thoughts.js";
import {
  buildDocument,
  documentHash,
  indexModelId,
  type IndexableThought,
} from "./document.js";
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
  /**
   * Rows given the kind their thought has now, with the vector left as it
   * was: the document had not changed, so there was nothing to encode.
   */
  kindUpdated: number;
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

/**
 * How far before its own start a run leaves the watermark.
 *
 * A write is in the log at once and in `graph` a moment later: a tag after
 * 0.1–0.5 s, about a second when several are attached in a row. A sync that
 * ran in between read the entry, fetched the old graph, skipped it by hash and
 * moved past the entry for good. Measured on a live TheBrain 15: of four tags
 * each followed at once by a sync, one was lost that way. So the next run reads
 * the last seconds again, ten times the longest delay measured, and the hash
 * drops what it has already seen.
 */
const SYNC_OVERLAP_MS = 10_000;

/** Thought kinds we skip: system and internal ones. */
const SKIP_KINDS: ReadonlySet<number> = new Set([ThoughtKind.System]);

/** Thought kinds whose name is part of other thoughts' documents. */
const CARRIED_KINDS: ReadonlySet<number> = new Set([ThoughtKind.Tag, ThoughtKind.Type]);

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
        indexModelId(this.#embedder.id),
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
   * embeddings are computed only for what actually changed. A row's kind is
   * compared apart from the hash and corrected in place, with nothing encoded:
   * that is what repairs an index whose thoughts changed kind before a sync
   * read `304`.
   */
  async rebuild(
    brainId: string,
    onProgress: (p: IndexProgress) => void = (): void => undefined,
  ): Promise<IndexResult> {
    const startedAt = Date.now();
    const watermark = watermarkAt(startedAt);

    if (
      !this.#store.isCompatible(
        brainId,
        indexModelId(this.#embedder.id),
        this.#embedder.dimensions,
      )
    ) {
      this.#store.clear();
    }
    this.#store.setMeta({
      brainId,
      model: indexModelId(this.#embedder.id),
      dimensions: this.#embedder.dimensions,
      syncedThrough: null,
    });

    onProgress({ phase: "enumerate", done: 0, total: 0, message: "reading the log" });
    const logs = await this.#api.brains.allModifications(brainId);
    const logged = replayThoughtIds(logs);

    onProgress({ phase: "enumerate", done: 0, total: 0, message: "walking the graph" });
    const graphs = await this.#walk(brainId, logged);
    // A union, not a replacement: a logged thought whose graph failed to load
    // keeps its old behaviour — fetched once more, dropped only if it is gone.
    const alive = new Set([...logged, ...graphs.keys()]);

    // Drop anything that no longer exists in the brain.
    const known = [...this.#store.contentHashes().keys()];
    const stale = known.filter((id) => !alive.has(id));
    this.#store.remove(stale);

    const result = await this.#indexThoughts(brainId, [...alive], onProgress, graphs);
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
   * The watermark is taken a little before the start (`SYNC_OVERLAP_MS`), so
   * the tail of this run is read again by the next one; unchanged entries are
   * filtered out by document hash. Every change since the watermark is read,
   * however many: the API alone would keep only the newest page and drop the
   * oldest changes while the watermark moved past them.
   */
  async sync(
    brainId: string,
    onProgress: (p: IndexProgress) => void = (): void => undefined,
  ): Promise<IndexResult> {
    const startedAt = Date.now();
    const meta = this.#store.getMeta();
    if (
      meta === null ||
      !this.#store.isCompatible(
        brainId,
        indexModelId(this.#embedder.id),
        this.#embedder.dimensions,
      )
    ) {
      return this.rebuild(brainId, onProgress);
    }
    if (meta.syncedThrough === null) return this.rebuild(brainId, onProgress);

    const watermark = watermarkAt(startedAt);
    onProgress({ phase: "enumerate", done: 0, total: 0, message: "reading changes" });
    const logs = await this.#api.brains.allModifications(brainId, {
      since: meta.syncedThrough,
    });

    const touched = new Set<string>();
    const deleted = new Set<string>();
    const renamed = new Set<string>();
    for (const log of logs) {
      // A tag comes and goes as a link, with no event against the thought.
      for (const end of linkEndIds(log)) {
        if (!deleted.has(end)) touched.add(end);
      }
      const thoughtId = logThoughtId(log);
      if (thoughtId === null) continue;
      if (log.modType === ModType.Deleted && log.sourceType === EntityType.Thought) {
        deleted.add(thoughtId);
        touched.delete(thoughtId);
      } else if (log.modType === ModType.Created || REEMBED_MOD_TYPES.has(log.modType)) {
        if (!deleted.has(thoughtId)) touched.add(thoughtId);
        if (log.modType === ModType.NameChanged) renamed.add(thoughtId);
      }
    }

    // A renamed tag or type sits in the document of every thought that carries
    // it, and the log names only the tag or type itself. Its graph lists the
    // carriers as children.
    const graphs = await this.#graphs(
      brainId,
      [...renamed].filter((id) => touched.has(id)),
    );
    for (const graph of graphs.values()) {
      if (!CARRIED_KINDS.has(graph.thought.kind)) continue;
      for (const carrier of graph.children) {
        if (!deleted.has(carrier.id)) touched.add(carrier.id);
      }
    }

    // Only what was indexed counts as removed: the overlap reads a deletion
    // twice, and a thought created and deleted between two runs never got in.
    const known = this.#store.contentHashes();
    const gone = [...deleted].filter((id) => known.has(id));
    this.#store.remove(gone);
    const result = await this.#indexThoughts(brainId, [...touched], onProgress, graphs);
    this.#store.setSyncedThrough(watermark);

    onProgress({
      phase: "done",
      done: result.indexed,
      total: touched.size,
      message: "synced",
    });
    return { ...result, removed: gone.length, elapsedMs: Date.now() - startedAt };
  }

  /** The graphs of the given thoughts, minus any that could not be read. */
  async #graphs(brainId: string, ids: readonly string[]): Promise<Map<string, CleanGraph>> {
    const fetched = await mapWithConcurrency(ids, this.#concurrency, (id) =>
      this.#api.thoughts.getGraph(brainId, id).catch(() => null),
    );
    const graphs = new Map<string, CleanGraph>();
    fetched.forEach((graph, i) => {
      if (graph !== null) graphs.set(ids[i]!, graph);
    });
    return graphs;
  }

  /**
   * Every thought reachable from the home thought or from a logged thought,
   * with its graph, so indexing can reuse what the walk already fetched.
   *
   * The log alone undercounts. Measured on a live TheBrain 15 against
   * `statistics.thoughts`: one brain with 56 thoughts had no `created` events at
   * all, another had 1 of 44, a third 125 of 187. Walking the graph from the
   * home thought found 56, 46 and 184 (types and tags included, unlinked
   * thoughts excluded). Seeding from the log as well keeps islands that are
   * cut off from home but were created here.
   */
  async #walk(brainId: string, logged: ReadonlySet<string>): Promise<Map<string, CleanGraph>> {
    const home = await this.#api.brains
      .get(brainId)
      .then((b) => b.homeThoughtId)
      .catch(() => null);

    const graphs = new Map<string, CleanGraph>();
    const queued = new Set<string>(logged);
    if (home !== null) queued.add(home);

    let frontier = [...queued];
    while (frontier.length > 0) {
      const level = frontier;
      const fetched = await mapWithConcurrency(level, this.#concurrency, (id) =>
        this.#api.thoughts.getGraph(brainId, id).catch(() => null),
      );
      const next: string[] = [];
      fetched.forEach((graph, i) => {
        if (graph === null) return;
        graphs.set(level[i]!, graph);
        for (const neighbour of neighbourIds(graph)) {
          if (queued.has(neighbour)) continue;
          queued.add(neighbour);
          next.push(neighbour);
        }
      });
      frontier = next;
    }
    return graphs;
  }

  async #indexThoughts(
    brainId: string,
    ids: readonly string[],
    onProgress: (p: IndexProgress) => void,
    graphs: ReadonlyMap<string, CleanGraph> = new Map(),
  ): Promise<{ indexed: number; kindUpdated: number; skipped: number }> {
    if (ids.length === 0) return { indexed: 0, kindUpdated: 0, skipped: 0 };

    const existing = this.#store.contentHashes();
    const kinds = this.#store.kinds();
    const total = ids.length;
    let fetched = 0;

    // The graph returns a thought, its tags and its type in one request —
    // cheaper than fetching them separately.
    const collected = await mapWithConcurrency(ids, this.#concurrency, async (id) => {
      const item = await this.#collect(brainId, id, graphs.get(id));
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
    // The kind is stored beside the document and is no part of it, so a row
    // can have the right hash and the wrong kind. An ordinary thought turned
    // into a tag has the document it had: it used to be skipped here by a
    // sync and by a rebuild alike, and a default search went on returning it.
    const rekinded = new Map<string, number>();
    let skipped = 0;
    for (const item of collected) {
      if (item === null) continue;
      if (SKIP_KINDS.has(item.kind)) continue;
      const doc = buildDocument(item);
      const hash = documentHash(doc);
      if (existing.get(item.id) === hash) {
        if (kinds.get(item.id) === item.kind) skipped += 1;
        else rekinded.set(item.id, item.kind);
        continue;
      }
      pending.push({ thought: item, doc, hash });
    }
    this.#store.setKinds(rekinded);

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

    return { indexed, kindUpdated: rekinded.size, skipped };
  }

  async #collect(
    brainId: string,
    thoughtId: string,
    cached?: CleanGraph,
  ): Promise<IndexableThought | null> {
    try {
      const graph = cached ?? (await this.#api.thoughts.getGraph(brainId, thoughtId));
      // A note shows up as an attachment flagged `isNotes`, so the graph we
      // already fetched says whether reading the note is worth a request. The
      // modification log cannot answer this: its note events are keyed by the
      // attachment, and old ones fall outside whatever window we asked for.
      const hasNote = graph.attachments.some((a) => a.isNotes);
      const note = hasNote
        ? await this.#api.notes.get(brainId, thoughtId).catch(() => "")
        : "";
      return {
        id: graph.thought.id,
        name: graph.thought.name ?? "",
        kind: graph.thought.kind,
        aliases: aliasesOf(graph.thought),
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

/** Where the next sync starts reading for a run that began at `startedAt`. */
function watermarkAt(startedAt: number): string {
  return new Date(startedAt - SYNC_OVERLAP_MS).toISOString();
}

/**
 * The thought a log entry is about, or null if it is about something else.
 *
 * Most entries name the thought in `sourceId`. Note events do not: a note is
 * stored as a `Notes.md` attachment, so the entry's source is the attachment
 * (`sourceType` 4) and the thought sits in `extraA`. Reading `sourceId` blindly
 * dropped every note edit, which is how notes stayed out of the index while
 * every rebuild cheerfully reported "no changes".
 *
 * Measured against the live API:
 *   { modType: 801, sourceType: 4, sourceId: <attachment>,
 *     extraAId: <thought>, extraAType: 2 }
 *   { modType: 211, sourceType: 2, sourceId: <thought>, extraAType: -1 }
 * So an alias change is an ordinary thought event, unlike a note. A label
 * (`202`) and a type (`203`, set or lost) are ordinary thought events too, and
 * so is a change of kind:
 *   { modType: 304, sourceType: 2, sourceId: <thought>, extraAType: -1,
 *     oldValue: "Normal", newValue: "Tag" }
 * That entry is all the log has for a thought with nothing under it. What is
 * under it is named by its own entries: a `404` against each link whose
 * meaning the change turned, and a `203` against each thought that gained or
 * lost the changed one as its type.
 */
export function logThoughtId(log: ModificationLogDto): string | null {
  if (log.sourceType === EntityType.Thought) return log.sourceId;
  if (isNoteMod(log.modType) && log.extraAType === EntityType.Thought) return log.extraAId;
  return null;
}

/**
 * Both ends of a link event that may have given a thought a tag or taken one
 * away; empty for every other entry.
 *
 * A tag is a link, so attaching one logs nothing against the thought. Measured
 * against the live API:
 *   { modType: 101, sourceType: 3, sourceId: <link>,
 *     extraAId: <tag>, extraAType: 2, extraBId: <thought>, extraBType: 2 }
 * and `102` with the same ends when it is detached, or when the tag is
 * deleted. An ordinary parent link reads exactly the same, parent in `extraA`
 * and child in `extraB`, values null in both: the entry does not say which of
 * the two it is. So both ends of every such link are returned, and the
 * document hash drops the ones that did not change, at one graph request each.
 *
 * A moved link (`402`) names its new ends only. The thought a tag link was
 * moved away from is not in the entry, and keeps its vector until a rebuild.
 */
export function linkEndIds(log: ModificationLogDto): string[] {
  if (log.sourceType !== EntityType.Link || !TAG_LINK_MOD_TYPES.has(log.modType)) return [];
  return [
    ...(log.extraAType === EntityType.Thought ? [log.extraAId] : []),
    ...(log.extraBType === EntityType.Thought ? [log.extraBId] : []),
  ];
}

/**
 * Thoughts one hop away, tags and the type included: both are thoughts in their
 * own right. A tag's graph lists the thoughts it marks as children, and a type's
 * graph lists its instances the same way, so following them reaches thoughts
 * whose only connection is a shared tag or type. Both are contract-tested.
 */
export function neighbourIds(graph: CleanGraph): string[] {
  const ids = [...graph.parents, ...graph.children, ...graph.jumps, ...graph.tags].map(
    (t) => t.id,
  );
  if (graph.type !== null) ids.push(graph.type.id);
  return ids;
}

/** Note lifecycle events: created, changed, deleted. */
export function isNoteMod(modType: number): boolean {
  return (
    modType === ModType.NoteCreated ||
    modType === ModType.NoteChanged ||
    modType === ModType.NoteDeleted
  );
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
