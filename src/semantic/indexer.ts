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
 *
 * A run reads first and writes after. Every request it makes is a read, and
 * the last of them is answered before the index is touched, so a run that a
 * failed request stops has written nothing. A read that fails is not an
 * answer: it is never taken for a thought that is gone or for one with no
 * note. What a run does with it goes by whether the next read could have got
 * past it (`STOPS_THE_RUN`, `#graph`).
 */

import { TheBrainError, type ApiErrorKind } from "../api/errors.js";
import type { TheBrainApi } from "../api/index.js";
import { compareLogTime, logTime } from "../api/log.js";
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
import { EmbedderUnavailableError, type Embedder } from "./embedder.js";
import type { StoredVector, VectorStore } from "./store.js";

export interface IndexProgress {
  phase: "enumerate" | "fetch" | "embed" | "store" | "done";
  done: number;
  total: number;
  message: string;
}

/**
 * A thought a run asked TheBrain for and got no answer about. Its row in the
 * index, if it has one, is left as it was.
 */
export interface UnreadThought {
  id: string;
  /** Its name, when an earlier read of the run had given one. */
  name: string | null;
  /**
   * The read that failed: the thought's graph; the thought itself, asked for
   * after a 403 on its graph; or its note.
   */
  read: "graph" | "thought" | "note";
  error: unknown;
}

export interface IndexResult {
  /** What was run. A sync with no finished index to refresh is a rebuild. */
  ran: "rebuild" | "sync";
  indexed: number;
  /**
   * Rows given the kind their thought has now, with the vector left as it
   * was: the document had not changed, so there was nothing to encode.
   */
  kindUpdated: number;
  skipped: number;
  removed: number;
  /**
   * The thoughts the run asked TheBrain for: every one a rebuild found, or
   * the ones a sync found changed.
   */
  asked: number;
  /**
   * Those it could not read. With any, the run is not complete: the
   * watermark is where it was, so the next run reads for them again. When
   * none of `asked` was read, nothing was written at all.
   */
  unread: UnreadThought[];
  /**
   * Rows a rebuild left in place although its walk did not reach their
   * thoughts, because a graph on the way was not read: what lies beyond that
   * graph was not walked, and a row is not removed on that account.
   */
  keptUnreached: number;
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

/**
 * Failures that are not one thought's own, so the first is the run's: a key
 * TheBrain rejects, a `brainId` that is no brain, and TheBrain not answering,
 * which is a refused or dropped connection and a request that timed out.
 * Every read after it would get the same, and a run makes thousands of them:
 * against an app that hangs, each waits out its thirty seconds.
 *
 * A dropped connection or a timeout may be one request's. It stops the run
 * all the same, because nothing is lost by that: the run has written nothing
 * yet, and the next one starts where this one did.
 *
 * Anything else is taken for the thought's own: a 5xx, the catch-all 403, an
 * answer that does not parse. That thought is left for the next run and the
 * rest are read.
 */
const STOPS_THE_RUN: readonly ApiErrorKind[] = ["auth", "unknown_brain", "network"];

function stopsTheRun(error: unknown): boolean {
  return error instanceof TheBrainError && STOPS_THE_RUN.includes(error.kind);
}

/** What the read of one thought's graph came to. */
type GraphRead = { graph: CleanGraph } | { gone: true } | { unread: UnreadThought };

/** The same for the thought as it goes into the index, its note read too. */
type ThoughtRead = { thought: IndexableThought } | { gone: true } | { unread: UnreadThought };

interface Collected {
  thoughts: IndexableThought[];
  gone: string[];
  unread: UnreadThought[];
}

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
   *
   * Throws `EmbedderUnavailableError` before the first request when nothing
   * could be encoded, and the failure of a read that stops the run (see
   * `STOPS_THE_RUN`; the log's and the brain's own reads always do). The
   * index is then as it was. A thought that could not be read is returned in
   * `unread`, and the build is not finished: no watermark is set.
   */
  async rebuild(
    brainId: string,
    onProgress: (p: IndexProgress) => void = (): void => undefined,
  ): Promise<IndexResult> {
    await this.#requireEmbedder();
    return this.#rebuild(brainId, onProgress, Date.now());
  }

  async #rebuild(
    brainId: string,
    onProgress: (p: IndexProgress) => void,
    startedAt: number,
  ): Promise<IndexResult> {
    onProgress({ phase: "enumerate", done: 0, total: 0, message: "reading the log" });
    const logs = await this.#api.brains.allModifications(brainId);
    const logged = replayThoughtIds(logs);

    onProgress({ phase: "enumerate", done: 0, total: 0, message: "walking the graph" });
    const reads = await this.#walk(brainId, logged);
    const { thoughts, gone, unread } = await this.#collect(
      brainId,
      reads,
      noteStates(logs),
      onProgress,
    );
    const done = (
      written: { indexed: number; kindUpdated: number; skipped: number },
      removed: number,
      keptUnreached: number,
    ): IndexResult => ({
      ran: "rebuild",
      ...written,
      removed,
      asked: reads.size,
      unread,
      keptUnreached,
      elapsedMs: Date.now() - startedAt,
    });

    // Every read is made. A run that read no thought writes nothing: not the
    // metadata either, which is what says a build was started.
    if (unread.length === reads.size && unread.length > 0) {
      onProgress({ phase: "done", done: 0, total: reads.size, message: "no thought was read" });
      return done(NOTHING_WRITTEN, 0, 0);
    }

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

    // A row goes when its thought was read as gone, or when the walk did not
    // reach it and was whole. With a graph not read the walk is not whole:
    // what lies beyond that graph was never asked for, and the thoughts the
    // log does not list are reached through graphs alone. A failed note read
    // leaves the walk as it is.
    const walked = unread.every((u) => u.read === "note");
    const leaving = new Set(gone);
    const known = [...this.#store.contentHashes().keys()];
    const unreached = known.filter((id) => !reads.has(id));
    const stale = known.filter((id) => leaving.has(id) || (walked && !reads.has(id)));
    this.#store.remove(stale);

    const written = await this.#write(thoughts, onProgress);
    // The watermark is what says a build finished, and what a sync reads
    // from. One that left a thought unread is not finished, and a sync would
    // not go back for that thought: nothing in the log says it changed.
    if (unread.length === 0) this.#store.setSyncedThrough(watermarkAt(startedAt));

    onProgress({
      phase: "done",
      done: written.indexed + written.skipped,
      total: reads.size,
      message: unread.length === 0 ? "index built" : `${unread.length} thoughts not read`,
    });
    return done(written, stale.length, walked ? 0 : unreached.length);
  }

  /**
   * Incremental sync from the log.
   *
   * The watermark is taken a little before the start (`SYNC_OVERLAP_MS`), so
   * the tail of this run is read again by the next one; unchanged entries are
   * filtered out by document hash. Every change since the watermark is read,
   * however many: the API alone would keep only the newest page and drop the
   * oldest changes while the watermark moved past them.
   *
   * The watermark moves only when every changed thought was read. With one
   * left in `unread` it stays where it was, and the next sync reads the same
   * changes again: moved, it would pass that thought's change for good. What
   * was read is written all the same, and the hash skips it next time.
   *
   * Throws as `rebuild` does, the index then being as it was.
   */
  async sync(
    brainId: string,
    onProgress: (p: IndexProgress) => void = (): void => undefined,
  ): Promise<IndexResult> {
    await this.#requireEmbedder();
    const startedAt = Date.now();
    const meta = this.#store.getMeta();
    if (
      meta === null ||
      meta.syncedThrough === null ||
      !this.#store.isCompatible(
        brainId,
        indexModelId(this.#embedder.id),
        this.#embedder.dimensions,
      )
    ) {
      return this.#rebuild(brainId, onProgress, startedAt);
    }

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
    // carriers as children. When that graph is not read the carriers are not
    // known: the renamed thought stands in `unread`, the watermark stays, and
    // the next sync reads its rename again.
    const reads = new Map<string, GraphRead>();
    await this.#graphs(
      brainId,
      [...renamed].filter((id) => touched.has(id)),
      reads,
    );
    for (const read of reads.values()) {
      if (!("graph" in read) || !CARRIED_KINDS.has(read.graph.thought.kind)) continue;
      for (const carrier of read.graph.children) {
        if (!deleted.has(carrier.id)) touched.add(carrier.id);
      }
    }
    await this.#graphs(
      brainId,
      [...touched].filter((id) => !reads.has(id)),
      reads,
    );

    const { thoughts, gone, unread } = await this.#collect(
      brainId,
      reads,
      noteStates(logs),
      onProgress,
    );
    const done = (
      written: { indexed: number; kindUpdated: number; skipped: number },
      removed: number,
    ): IndexResult => ({
      ran: "sync",
      ...written,
      removed,
      asked: reads.size,
      unread,
      keptUnreached: 0,
      elapsedMs: Date.now() - startedAt,
    });

    // As in a rebuild: no thought read, nothing written. The deletions the
    // log names are read again by the next sync, the watermark being where
    // it was.
    if (unread.length === reads.size && unread.length > 0) {
      onProgress({ phase: "done", done: 0, total: reads.size, message: "no thought was read" });
      return done(NOTHING_WRITTEN, 0);
    }

    // Only what was indexed counts as removed: the overlap reads a deletion
    // twice, and a thought created and deleted between two runs never got in.
    // A row goes on the log's word that its thought was deleted, or on a read
    // that said the thought is gone. Never on a read that failed.
    const known = this.#store.contentHashes();
    const leaving = [...new Set([...deleted, ...gone])].filter((id) => known.has(id));
    this.#store.remove(leaving);
    const written = await this.#write(thoughts, onProgress);
    if (unread.length === 0) this.#store.setSyncedThrough(watermarkAt(startedAt));

    onProgress({
      phase: "done",
      done: written.indexed,
      total: reads.size,
      message: unread.length === 0 ? "synced" : `${unread.length} thoughts not read`,
    });
    return done(written, leaving.length);
  }

  /**
   * Refuses a run that could encode nothing, before it reads a brain to find
   * that out at its first document. Without the optional package a rebuild
   * read the whole log and walked the whole graph first: 13 requests on a
   * brain of one thought, minutes on a real one.
   */
  async #requireEmbedder(): Promise<void> {
    if ((await this.#embedder.isAvailable?.()) === false) throw new EmbedderUnavailableError();
  }

  /**
   * One thought's graph, or what stands in its place.
   *
   * The graph of an identifier no thought has is a 403 in the API's catch-all
   * words, which a request that failed for a reason of its own gets too
   * (docs/api-map.md, L3). The thought's own read tells the two apart: it is a
   * 404 only when the thought is not there. So a thought is `gone` on that 404
   * alone, and any other failure leaves it `unread`.
   *
   * Throws the failure that stops the run.
   */
  async #graph(brainId: string, id: string): Promise<GraphRead> {
    try {
      return { graph: await this.#api.thoughts.getGraph(brainId, id) };
    } catch (error) {
      if (stopsTheRun(error)) throw error;
      const unread: GraphRead = { unread: { id, name: null, read: "graph", error } };
      if (!(error instanceof TheBrainError)) return unread;
      // Refused before any request: what is no identifier names no thought.
      if (error.kind === "invalid_uuid") return { gone: true };
      if (error.kind !== "forbidden") return unread;
      try {
        const thought = await this.#api.thoughts.get(brainId, id);
        // It is there, and its graph was refused: for a moment after it is
        // deleted, or for a reason the answer does not give.
        return { unread: { id, name: thought.name, read: "graph", error } };
      } catch (second) {
        if (stopsTheRun(second)) throw second;
        if (second instanceof TheBrainError && second.kind === "not_found") return { gone: true };
        return { unread: { id, name: null, read: "thought", error: second } };
      }
    }
  }

  /** Reads the graphs of `ids` into `reads`, a bounded number at a time. */
  async #graphs(
    brainId: string,
    ids: readonly string[],
    reads: Map<string, GraphRead>,
  ): Promise<void> {
    const fetched = await mapWithConcurrency(ids, this.#concurrency, (id) =>
      this.#graph(brainId, id),
    );
    fetched.forEach((read, i) => reads.set(ids[i]!, read));
  }

  /**
   * Every thought reachable from the home thought or from a logged thought,
   * with what the read of its graph came to, so indexing can reuse what the
   * walk already fetched.
   *
   * The log alone undercounts. Measured on a live TheBrain 15 against
   * `statistics.thoughts`: one brain with 56 thoughts had no `created` events at
   * all, another had 1 of 44, a third 125 of 187. Walking the graph from the
   * home thought found 56, 46 and 184 (types and tags included, unlinked
   * thoughts excluded). Seeding from the log as well keeps islands that are
   * cut off from home but were created here.
   *
   * The brain's own read is not caught. It names the home thought, and a brain
   * the log does not list is walked from there alone: with that read's failure
   * taken for "no home thought", such a brain was walked nowhere, reported as
   * built, and lost every row it had.
   */
  async #walk(brainId: string, logged: ReadonlySet<string>): Promise<Map<string, GraphRead>> {
    const home = (await this.#api.brains.get(brainId)).homeThoughtId;

    const reads = new Map<string, GraphRead>();
    const queued = new Set<string>(logged);
    if (typeof home === "string" && home !== "") queued.add(home);

    let frontier = [...queued];
    while (frontier.length > 0) {
      const level = frontier;
      await this.#graphs(brainId, level, reads);
      const next: string[] = [];
      for (const id of level) {
        const read = reads.get(id)!;
        // A graph that was not read lists nothing: what is next to it is
        // reached some other way or not at all, and the rebuild says so.
        if (!("graph" in read)) continue;
        for (const neighbour of neighbourIds(read.graph)) {
          if (queued.has(neighbour)) continue;
          queued.add(neighbour);
          next.push(neighbour);
        }
      }
      frontier = next;
    }
    return reads;
  }

  /**
   * Turns the graphs a run has read into the thoughts to index, reading each
   * one's note where it has one.
   */
  async #collect(
    brainId: string,
    reads: ReadonlyMap<string, GraphRead>,
    notes: ReadonlyMap<string, boolean>,
    onProgress: (p: IndexProgress) => void,
  ): Promise<Collected> {
    const ids = [...reads.keys()];
    const total = ids.length;
    let fetched = 0;

    // The graph returns a thought, its tags and its type in one request —
    // cheaper than fetching them separately.
    const collected = await mapWithConcurrency(ids, this.#concurrency, async (id) => {
      const item = await this.#thought(brainId, id, reads.get(id)!, notes);
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

    const out: Collected = { thoughts: [], gone: [], unread: [] };
    collected.forEach((item, i) => {
      if ("thought" in item) out.thoughts.push(item.thought);
      else if ("gone" in item) out.gone.push(ids[i]!);
      else out.unread.push(item.unread);
    });
    return out;
  }

  async #thought(
    brainId: string,
    thoughtId: string,
    read: GraphRead,
    notes: ReadonlyMap<string, boolean>,
  ): Promise<ThoughtRead> {
    if (!("graph" in read)) return read;
    const graph = read.graph;
    // A note shows up as an attachment flagged `isNotes`, so the graph we
    // already fetched says whether reading the note is worth a request. The
    // modification log cannot answer this for every thought: its note events
    // are keyed by the attachment, and old ones fall outside whatever window
    // we asked for.
    //
    // Where the log this run read does say, it is taken over the graph. For a
    // moment after a note is changed the graph lists no Notes attachment, at
    // one read within 0.2 s of the change (docs/api-map.md, L32), and for a
    // moment after a note is deleted it still lists one, whose read is a 403.
    // Read then, a thought with a note was indexed as one without.
    const hasNote = notes.get(thoughtId) ?? graph.attachments.some((a) => a.isNotes);
    let note = "";
    if (hasNote) {
      try {
        note = await this.#api.notes.get(brainId, thoughtId);
      } catch (error) {
        if (stopsTheRun(error)) throw error;
        // Not `""`: a thought with no note is a 200 from this read, so a
        // failure is never that answer. Indexed without the note it has, the
        // thought would lose the text it is found by, and its row would be
        // replaced with one built from the name.
        return { unread: { id: thoughtId, name: graph.thought.name, read: "note", error } };
      }
    }
    return {
      thought: {
        id: graph.thought.id,
        name: graph.thought.name ?? "",
        kind: graph.thought.kind,
        aliases: aliasesOf(graph.thought),
        label: graph.thought.label,
        typeName: graph.type?.name ?? null,
        tagNames: graph.tags.map((t) => t.name ?? "").filter((n) => n.length > 0),
        note,
      },
    };
  }

  /** Encodes what changed and writes it. No request to TheBrain is made here. */
  async #write(
    thoughts: readonly IndexableThought[],
    onProgress: (p: IndexProgress) => void,
  ): Promise<{ indexed: number; kindUpdated: number; skipped: number }> {
    if (thoughts.length === 0) return { ...NOTHING_WRITTEN };

    const existing = this.#store.contentHashes();
    const kinds = this.#store.kinds();

    const pending: Array<{ thought: IndexableThought; doc: string; hash: string }> = [];
    // The kind is stored beside the document and is no part of it, so a row
    // can have the right hash and the wrong kind. An ordinary thought turned
    // into a tag has the document it had: it used to be skipped here by a
    // sync and by a rebuild alike, and a default search went on returning it.
    const rekinded = new Map<string, number>();
    let skipped = 0;
    for (const item of thoughts) {
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
}

const NOTHING_WRITTEN = { indexed: 0, kindUpdated: 0, skipped: 0 } as const;

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

/**
 * What the given log says of each thought's note: true when the latest note
 * entry about the thought is its note written or changed, false when it is
 * the note deleted. A thought the log has no note entry for is not in the
 * map, and its graph is what says.
 *
 * The latest by `logTime`, not by position: a run of changes is one `803`
 * that moves, and it carries the time of the last change.
 */
export function noteStates(logs: readonly ModificationLogDto[]): Map<string, boolean> {
  const latest = new Map<string, ModificationLogDto>();
  for (const log of logs) {
    if (!isNoteMod(log.modType) || log.extraAType !== EntityType.Thought) continue;
    const seen = latest.get(log.extraAId);
    if (seen === undefined || compareLogTime(logTime(log), logTime(seen)) > 0) {
      latest.set(log.extraAId, log);
    }
  }
  return new Map(
    [...latest].map(([id, log]) => [id, log.modType !== ModType.NoteDeleted] as const),
  );
}

/** Note lifecycle events: created, changed, deleted. */
export function isNoteMod(modType: number): boolean {
  return (
    modType === ModType.NoteCreated ||
    modType === ModType.NoteChanged ||
    modType === ModType.NoteDeleted
  );
}

/**
 * Bounded-concurrency map: the API is fast, but there is no need to flood it.
 *
 * A worker that throws ends the map: it rejects with that error, and no item
 * is started after it. The other runners used to go on to the end of the
 * list with nobody to read what they fetched, which against a TheBrain that
 * is not answering is a request per item, each waiting out its timeout.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let failed = false;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      if (failed) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index]!, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  await Promise.all(runners);
  return results;
}
