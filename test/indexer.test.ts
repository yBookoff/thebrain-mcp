import { describe, expect, it } from "vitest";

import { TheBrainError, type ApiErrorKind, type TheBrainApi } from "../src/api/index.js";
import type { ModificationLogDto } from "../src/api/types.js";
import { EmbedderUnavailableError, type Embedder } from "../src/semantic/embedder.js";
import {
  SemanticIndexer,
  linkEndIds,
  logThoughtId,
  mapWithConcurrency,
} from "../src/semantic/indexer.js";
import {
  EmptyQueryError,
  SearchFailedError,
  SemanticSearch,
  dedupeVariants,
} from "../src/semantic/search.js";
import { VectorStore, normalize } from "../src/semantic/store.js";

const BRAIN = "aaaaaaaa-0000-4000-8000-000000000001";

/** Deterministic embedder: the vector derives from the text, no model needed. */
class FakeEmbedder implements Embedder {
  readonly id: string = "fake@v1";
  readonly dimensions = 8;
  calls = 0;
  /** Every document handed to the embedder, so tests can see what got indexed. */
  readonly documents: string[] = [];

  async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls += texts.length;
    this.documents.push(...texts);
    return texts.map((t) => this.#vec(t));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    this.calls += 1;
    return this.#vec(text);
  }

  #vec(text: string): Float32Array {
    const v = new Float32Array(this.dimensions);
    for (let i = 0; i < text.length; i += 1) {
      v[i % this.dimensions]! += text.charCodeAt(i) % 17;
    }
    return normalize(v);
  }
}

interface FakeThought {
  id: string;
  name: string;
  kind?: number;
  label?: string;
  typeName?: string;
  /** A type that is a thought of this fake brain, so renaming it shows here. */
  typeId?: string;
  /** Tag names, or ids of tags that are thoughts of this fake brain. */
  tags?: string[];
  note?: string;
  /**
   * Left out, the graph carries no `aliases` field at all, as on builds before
   * 15.0.621. The current one always sends a list, empty when there are none.
   */
  aliases?: string[];
  /** Ids of thoughts linked to this one, as the graph endpoint reports them. */
  children?: string[];
  parents?: string[];
  jumps?: string[];
}

const log = (
  sourceId: string,
  modType: number,
  at: string,
  sourceType = 2,
): ModificationLogDto => ({
  sourceId,
  sourceType,
  extraAId: "",
  extraAType: -1,
  extraBId: "",
  extraBType: -1,
  modType,
  oldValue: null,
  newValue: null,
  userId: "u",
  brainId: BRAIN,
  creationDateTime: at,
  modificationDateTime: at,
  syncUpdateDateTime: null,
});

/**
 * A note event, shaped the way the live API records it: the source is the
 * `Notes.md` attachment and the thought is named in extraA.
 */
const noteLog = (
  thoughtId: string,
  modType: number,
  at: string,
  attachmentId = `att-${thoughtId}`,
): ModificationLogDto => ({
  ...log(attachmentId, modType, at, 4),
  extraAId: thoughtId,
  extraAType: 2,
});

/**
 * A link event, shaped the way the live API records it: the source is the link
 * and its two thoughts sit in extraA and extraB. For a tag link that is the tag
 * and the thought it marks, for a type link the type and its instance, for an
 * ordinary link parent and child. Nothing else in the entry tells them apart.
 */
const linkLog = (
  a: string,
  b: string,
  modType: number,
  at: string,
  linkId = `link-${a}-${b}`,
): ModificationLogDto => ({
  ...log(linkId, modType, at, 3),
  extraAId: a,
  extraAType: 2,
  extraBId: b,
  extraBType: 2,
});

/** Minimal fake API: only what the indexer and search actually touch. */
function fakeApi(
  thoughts: Map<string, FakeThought>,
  logs: ModificationLogDto[],
  searchResults: Map<string, string[]> = new Map(),
  home: string | null = null,
) {
  const calls = { graph: 0, graphIds: [] as string[], notes: 0, modifications: 0, search: 0 };
  const ref = (id: string) => ({ id, name: thoughts.get(id)?.name ?? null, kind: 1 });
  const api = {
    brains: {
      async get(brainId: string) {
        if (home === null) throw new Error("no home thought");
        return { id: brainId, name: "brain", homeThoughtId: home };
      },
      async allModifications(_brainId: string, options?: { since?: string }) {
        calls.modifications += 1;
        if (options?.since === undefined) return logs;
        return logs.filter((l) => l.modificationDateTime >= options.since!);
      },
    },
    thoughts: {
      async getGraph(_brainId: string, id: string) {
        calls.graph += 1;
        calls.graphIds.push(id);
        const t = thoughts.get(id);
        if (t === undefined) throw new Error(`no thought ${id}`);
        return {
          thought: {
            id: t.id,
            name: t.name,
            kind: t.kind ?? 1,
            label: t.label ?? null,
            ...(t.aliases !== undefined ? { aliases: t.aliases } : {}),
          },
          parents: (t.parents ?? []).map(ref),
          children: (t.children ?? []).map(ref),
          jumps: (t.jumps ?? []).map(ref),
          siblings: [],
          links: [],
          // Tags and types are thoughts of their own. Given by name, their ids
          // point nowhere, like a tag the walk may try once and find gone.
          type:
            t.typeId !== undefined
              ? ref(t.typeId)
              : t.typeName
                ? { id: `type-${t.typeName}`, name: t.typeName }
                : null,
          tags: (t.tags ?? []).map((tag) =>
            thoughts.has(tag) ? ref(tag) : { id: `tag-${tag}`, name: tag },
          ),
          // The real API reports a note as an attachment flagged `isNotes`.
          // Omitting it here is what let the note-indexing bug through.
          attachments: t.note ? [{ id: `att-${t.id}`, isNotes: true, type: 1 }] : [],
        };
      },
    },
    notes: {
      async get(_brainId: string, id: string) {
        calls.notes += 1;
        return thoughts.get(id)?.note ?? "";
      },
    },
    search: {
      async inBrain(_brainId: string, query: string) {
        calls.search += 1;
        const ids = searchResults.get(query) ?? [];
        return ids.map((id) => ({ thought: { ...thoughts.get(id)!, kind: thoughts.get(id)?.kind ?? 1 } }));
      },
    },
  };
  return { api: api as unknown as TheBrainApi, calls };
}

describe("helpers", () => {
  it("logThoughtId reads a thought event straight from sourceId", () => {
    expect(logThoughtId(log("a", 103, "t1"))).toBe("a");
  });

  it("logThoughtId resolves a note event through extraA, not the attachment", () => {
    // Regression: notes are attachments, so sourceId is the Notes.md id.
    // Reading it as the thought kept notes out of the index entirely.
    for (const modType of [801, 802, 803]) {
      const entry = noteLog("thought-1", modType, "t1", "attachment-9");
      expect(entry.sourceId).toBe("attachment-9");
      expect(logThoughtId(entry)).toBe("thought-1");
    }
  });

  it("logThoughtId reads an alias change from sourceId, like any thought event", () => {
    expect(logThoughtId(log("a", 211, "t1"))).toBe("a");
  });

  it("logThoughtId ignores events about other entities", () => {
    expect(logThoughtId(log("some-link", 101, "t1", 3))).toBeNull();
    // An attachment event that is not a note: a URL attachment, say.
    expect(logThoughtId({ ...noteLog("t", 501, "t1") })).toBeNull();
  });

  it("linkEndIds names both ends of a link that was created, deleted, moved or re-meant", () => {
    for (const modType of [101, 102, 402, 404]) {
      expect(linkEndIds(linkLog("tag", "thought", modType, "t1"))).toEqual(["tag", "thought"]);
    }
  });

  it("linkEndIds is empty for a link event that keeps its ends, and for other entities", () => {
    // Renamed, thickness, direction, relation.
    for (const modType of [103, 401, 403, 405]) {
      expect(linkEndIds(linkLog("a", "b", modType, "t1"))).toEqual([]);
    }
    expect(linkEndIds(log("a", 101, "t1"))).toEqual([]);
    expect(linkEndIds(noteLog("a", 801, "t1"))).toEqual([]);
  });

  it("mapWithConcurrency preserves result order", async () => {
    const out = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
  });

  it("mapWithConcurrency respects the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("an empty input does not hang", async () => {
    await expect(mapWithConcurrency([], 4, async () => 1)).resolves.toEqual([]);
  });

  it("dedupeVariants strips duplicates, case and blanks", () => {
    expect(dedupeVariants(["Unity", "unity", "  ", "engine", "Unity "])).toEqual([
      "Unity",
      "engine",
    ]);
  });
});

describe("initial indexing", () => {
  function scenario() {
    const thoughts = new Map<string, FakeThought>([
      ["a", { id: "a", name: "Unity", typeName: "Tool", note: "game engine" }],
      ["b", { id: "b", name: "borscht recipe" }],
      ["c", { id: "c", name: "vector databases", tags: ["data"] }],
    ]);
    const logs = [
      log("a", 101, "2026-08-11T09:00:00"),
      log("b", 101, "2026-08-11T09:01:00"),
      log("c", 101, "2026-08-11T09:02:00"),
      noteLog("a", 801, "2026-08-11T09:03:00"),
      log("deleted", 101, "2026-08-11T09:04:00"),
      log("deleted", 102, "2026-08-11T09:05:00"),
    ];
    return { thoughts, logs };
  }

  it("indexes live thoughts and skips deleted ones", async () => {
    const { thoughts, logs } = scenario();
    const { api, calls } = fakeApi(thoughts, logs);
    const store = new VectorStore(":memory:");
    const indexer = new SemanticIndexer(api, store, new FakeEmbedder());

    const result = await indexer.rebuild(BRAIN);
    expect(result.indexed).toBe(3);
    expect(store.size()).toBe(3);
    // The deleted thought was never fetched.
    expect(calls.graphIds).not.toContain("deleted");
    store.close();
  });

  it("notes are fetched only for thoughts that have one", async () => {
    const { thoughts, logs } = scenario();
    const { api, calls } = fakeApi(thoughts, logs);
    const store = new VectorStore(":memory:");
    await new SemanticIndexer(api, store, new FakeEmbedder()).rebuild(BRAIN);
    // Only thought `a` carries a note attachment; b and c cost no extra request.
    expect(calls.notes).toBe(1);
    store.close();
  });

  it("the note text reaches the embedded document", async () => {
    const { thoughts, logs } = scenario();
    const { api } = fakeApi(thoughts, logs);
    const store = new VectorStore(":memory:");
    const embedder = new FakeEmbedder();
    await new SemanticIndexer(api, store, embedder).rebuild(BRAIN);
    expect(embedder.documents.some((d) => d.includes("game engine"))).toBe(true);
    store.close();
  });

  it("aliases reach the embedded document", async () => {
    const thoughts = new Map<string, FakeThought>([
      ["a", { id: "a", name: "RAG", aliases: ["Retrieval-augmented generation"] }],
      ["b", { id: "b", name: "no aliases", aliases: [] }],
    ]);
    const { api } = fakeApi(thoughts, [
      log("a", 101, "2026-08-11T09:00:00"),
      log("b", 101, "2026-08-11T09:01:00"),
    ]);
    const store = new VectorStore(":memory:");
    const embedder = new FakeEmbedder();
    await new SemanticIndexer(api, store, embedder).rebuild(BRAIN);
    expect(embedder.documents).toContain("RAG\nRetrieval-augmented generation");
    expect(embedder.documents).toContain("no aliases");
    store.close();
  });

  it("a note with no log event whatsoever is still indexed", async () => {
    // The log window may not reach back to when the note was written, and note
    // events are keyed by attachment anyway. The graph is the source of truth.
    const thoughts = new Map<string, FakeThought>([
      ["a", { id: "a", name: "Mere Exposure", note: "furniture hanging from the ceiling" }],
    ]);
    const { api } = fakeApi(thoughts, [log("a", 101, "2026-08-11T09:00:00")]);
    const store = new VectorStore(":memory:");
    const embedder = new FakeEmbedder();
    await new SemanticIndexer(api, store, embedder).rebuild(BRAIN);
    expect(embedder.documents.some((d) => d.includes("furniture hanging"))).toBe(true);
    store.close();
  });

  it("a repeat run does not recompute unchanged entries", async () => {
    const { thoughts, logs } = scenario();
    const { api } = fakeApi(thoughts, logs);
    const store = new VectorStore(":memory:");
    const embedder = new FakeEmbedder();
    const indexer = new SemanticIndexer(api, store, embedder);

    await indexer.rebuild(BRAIN);
    const afterFirst = embedder.calls;

    const second = await indexer.rebuild(BRAIN);
    expect(second.skipped).toBe(3);
    expect(second.indexed).toBe(0);
    expect(embedder.calls).toBe(afterFirst);
    store.close();
  });

  it("renaming a thought triggers recomputation", async () => {
    const { thoughts, logs } = scenario();
    const { api } = fakeApi(thoughts, logs);
    const store = new VectorStore(":memory:");
    const indexer = new SemanticIndexer(api, store, new FakeEmbedder());
    await indexer.rebuild(BRAIN);

    thoughts.set("b", { id: "b", name: "solyanka recipe" });
    const second = await indexer.rebuild(BRAIN);
    expect(second.indexed).toBe(1);
    expect(second.skipped).toBe(2);
    store.close();
  });

  it("a thought that vanishes between log and fetch does not break indexing", async () => {
    const { thoughts, logs } = scenario();
    thoughts.delete("b");
    const { api } = fakeApi(thoughts, logs);
    const store = new VectorStore(":memory:");
    const result = await new SemanticIndexer(api, store, new FakeEmbedder()).rebuild(BRAIN);
    expect(result.indexed).toBe(2);
    store.close();
  });

  describe("thoughts the log never saw", () => {
    // Imported and old brains carry thoughts with no `created` event. Measured
    // on a live TheBrain 15: 0 of 56, 1 of 44 and 125 of 187 thoughts logged.
    function imported() {
      const thoughts = new Map<string, FakeThought>([
        ["home", { id: "home", name: "Life areas", children: ["x", "y"] }],
        ["x", { id: "x", name: "Health", parents: ["home"] }],
        ["y", { id: "y", name: "Stress management", parents: ["home"], jumps: ["z"] }],
        ["z", { id: "z", name: "Relaxation techniques", jumps: ["y"] }],
      ]);
      return thoughts;
    }

    it("a brain with an empty log is indexed through the graph", async () => {
      const { api } = fakeApi(imported(), [], new Map(), "home");
      const store = new VectorStore(":memory:");
      const result = await new SemanticIndexer(api, store, new FakeEmbedder()).rebuild(BRAIN);
      expect(result.indexed).toBe(4);
      expect(store.size()).toBe(4);
      store.close();
    });

    it("each graph is fetched once: the walk's result is reused for indexing", async () => {
      const { api, calls } = fakeApi(imported(), [], new Map(), "home");
      const store = new VectorStore(":memory:");
      await new SemanticIndexer(api, store, new FakeEmbedder()).rebuild(BRAIN);
      expect(calls.graph).toBe(4);
      store.close();
    });

    it("an island cut off from home is reached through a logged thought", async () => {
      const thoughts = imported();
      thoughts.set("q", { id: "q", name: "Island", children: ["r"] });
      thoughts.set("r", { id: "r", name: "Unlogged child", parents: ["q"] });
      const { api } = fakeApi(thoughts, [log("q", 101, "2026-08-11T09:00:00")], new Map(), "home");
      const store = new VectorStore(":memory:");
      const result = await new SemanticIndexer(api, store, new FakeEmbedder()).rebuild(BRAIN);
      expect(result.indexed).toBe(6);
      store.close();
    });

    it("without a home thought it still indexes what the log knows", async () => {
      const { api } = fakeApi(imported(), [log("y", 101, "2026-08-11T09:00:00")]);
      const store = new VectorStore(":memory:");
      const result = await new SemanticIndexer(api, store, new FakeEmbedder()).rebuild(BRAIN);
      // y, then z by its jump and home by y's parent link, then x as home's child.
      expect(result.indexed).toBe(4);
      store.close();
    });
  });

  it("reports progress", async () => {
    const { thoughts, logs } = scenario();
    const { api } = fakeApi(thoughts, logs);
    const store = new VectorStore(":memory:");
    const phases: string[] = [];
    await new SemanticIndexer(api, store, new FakeEmbedder()).rebuild(BRAIN, (p) =>
      phases.push(p.phase),
    );
    expect(phases[0]).toBe("enumerate");
    expect(phases).toContain("embed");
    expect(phases.at(-1)).toBe("done");
    store.close();
  });

  it("status reflects the built index", async () => {
    const { thoughts, logs } = scenario();
    const { api } = fakeApi(thoughts, logs);
    const store = new VectorStore(":memory:");
    const indexer = new SemanticIndexer(api, store, new FakeEmbedder());

    expect(indexer.status(BRAIN).exists).toBe(false);
    await indexer.rebuild(BRAIN);
    const status = indexer.status(BRAIN);
    expect(status).toMatchObject({ exists: true, compatible: true, size: 3, brainId: BRAIN });
    expect(status.syncedThrough).not.toBeNull();
    store.close();
  });

  it("an index built to an older document format is incompatible", async () => {
    // Aliases joined the document in format 3. An index from before would rank
    // thoughts that have aliases by vectors built without them.
    const { thoughts, logs } = scenario();
    const { api } = fakeApi(thoughts, logs);
    const store = new VectorStore(":memory:");
    const embedder = new FakeEmbedder();
    const indexer = new SemanticIndexer(api, store, embedder);
    await indexer.rebuild(BRAIN);
    expect(indexer.status(BRAIN).model).toBe("fake@v1#doc3");

    store.setMeta({ ...store.getMeta()!, model: "fake@v1#doc2" });
    expect(indexer.status(BRAIN).compatible).toBe(false);
    store.close();
  });

  it("changing the model makes the index incompatible", async () => {
    const { thoughts, logs } = scenario();
    const { api } = fakeApi(thoughts, logs);
    const store = new VectorStore(":memory:");
    await new SemanticIndexer(api, store, new FakeEmbedder()).rebuild(BRAIN);

    class OtherEmbedder extends FakeEmbedder {
      override readonly id = "other@v2";
    }
    const other = new SemanticIndexer(api, store, new OtherEmbedder());
    expect(other.status(BRAIN).compatible).toBe(false);
    store.close();
  });
});

describe("incremental sync", () => {
  it("with no watermark it does a full rebuild", async () => {
    const thoughts = new Map<string, FakeThought>([["a", { id: "a", name: "thought" }]]);
    const { api } = fakeApi(thoughts, [log("a", 101, "2026-08-11T09:00:00")]);
    const store = new VectorStore(":memory:");
    const result = await new SemanticIndexer(api, store, new FakeEmbedder()).sync(BRAIN);
    expect(result.indexed).toBe(1);
    store.close();
  });

  it("picks up a new thought and leaves the old ones alone", async () => {
    const thoughts = new Map<string, FakeThought>([["a", { id: "a", name: "first" }]]);
    const logs = [log("a", 101, "2026-08-11T09:00:00")];
    const { api } = fakeApi(thoughts, logs);
    const store = new VectorStore(":memory:");
    const embedder = new FakeEmbedder();
    const indexer = new SemanticIndexer(api, store, embedder);

    await indexer.rebuild(BRAIN);
    const afterFirst = embedder.calls;

    thoughts.set("b", { id: "b", name: "second" });
    logs.push(log("b", 101, "2099-01-01T00:00:00"));

    const result = await indexer.sync(BRAIN);
    expect(result.indexed).toBe(1);
    expect(embedder.calls).toBe(afterFirst + 1);
    expect(store.size()).toBe(2);
    store.close();
  });

  it("a deletion removes the thought from the index", async () => {
    const thoughts = new Map<string, FakeThought>([
      ["a", { id: "a", name: "first" }],
      ["b", { id: "b", name: "second" }],
    ]);
    const logs = [
      log("a", 101, "2026-08-11T09:00:00"),
      log("b", 101, "2026-08-11T09:00:01"),
    ];
    const { api } = fakeApi(thoughts, logs);
    const store = new VectorStore(":memory:");
    const indexer = new SemanticIndexer(api, store, new FakeEmbedder());
    await indexer.rebuild(BRAIN);
    expect(store.size()).toBe(2);

    thoughts.delete("b");
    logs.push(log("b", 102, "2099-01-01T00:00:00"));
    const result = await indexer.sync(BRAIN);
    expect(result.removed).toBe(1);
    expect(store.size()).toBe(1);
    store.close();
  });

  it("create-then-delete within one window is not indexed", async () => {
    const thoughts = new Map<string, FakeThought>([["a", { id: "a", name: "first" }]]);
    const logs = [log("a", 101, "2026-08-11T09:00:00")];
    const { api, calls } = fakeApi(thoughts, logs);
    const store = new VectorStore(":memory:");
    const indexer = new SemanticIndexer(api, store, new FakeEmbedder());
    await indexer.rebuild(BRAIN);
    const graphBefore = calls.graph;

    logs.push(log("x", 101, "2099-01-01T00:00:00"));
    logs.push(log("x", 102, "2099-01-01T00:00:01"));
    const result = await indexer.sync(BRAIN);

    expect(result.indexed).toBe(0);
    expect(calls.graph).toBe(graphBefore);
    store.close();
  });

  it("a note change triggers recomputation", async () => {
    const thoughts = new Map<string, FakeThought>([
      ["a", { id: "a", name: "thought", note: "old note" }],
    ]);
    const logs = [log("a", 101, "2026-08-11T09:00:00"), noteLog("a", 801, "2026-08-11T09:00:01")];
    const { api } = fakeApi(thoughts, logs);
    const store = new VectorStore(":memory:");
    const indexer = new SemanticIndexer(api, store, new FakeEmbedder());
    await indexer.rebuild(BRAIN);

    thoughts.set("a", { id: "a", name: "thought", note: "new note" });
    logs.push(noteLog("a", 803, "2099-01-01T00:00:00"));
    const result = await indexer.sync(BRAIN);
    expect(result.indexed).toBe(1);
    store.close();
  });

  it("an alias change triggers recomputation", async () => {
    const thoughts = new Map<string, FakeThought>([
      ["a", { id: "a", name: "RAG", aliases: [] }],
      ["b", { id: "b", name: "untouched", aliases: [] }],
    ]);
    const logs = [log("a", 101, "2026-08-11T09:00:00"), log("b", 101, "2026-08-11T09:00:01")];
    const { api } = fakeApi(thoughts, logs);
    const store = new VectorStore(":memory:");
    const embedder = new FakeEmbedder();
    const indexer = new SemanticIndexer(api, store, embedder);
    await indexer.rebuild(BRAIN);

    thoughts.set("a", { id: "a", name: "RAG", aliases: ["Retrieval-augmented generation"] });
    logs.push(log("a", 211, "2099-01-01T00:00:00"));
    const result = await indexer.sync(BRAIN);

    expect(result.indexed).toBe(1);
    expect(embedder.documents.at(-1)).toBe("RAG\nRetrieval-augmented generation");
    store.close();
  });

  it("a note-only edit is not lost by the incremental path", async () => {
    // The thought itself produces no log entry when only its note changes:
    // the only trace is an attachment event pointing at it through extraA.
    const thoughts = new Map<string, FakeThought>([
      ["a", { id: "a", name: "stable name", note: "before" }],
    ]);
    const logs = [log("a", 101, "2026-08-11T09:00:00"), noteLog("a", 801, "2026-08-11T09:00:01")];
    const { api } = fakeApi(thoughts, logs);
    const store = new VectorStore(":memory:");
    const embedder = new FakeEmbedder();
    const indexer = new SemanticIndexer(api, store, embedder);
    await indexer.rebuild(BRAIN);

    thoughts.set("a", { id: "a", name: "stable name", note: "after the edit" });
    logs.push(noteLog("a", 803, "2099-01-01T00:00:00"));
    const result = await indexer.sync(BRAIN);

    expect(result.indexed).toBe(1);
    expect(embedder.documents.at(-1)).toContain("after the edit");
    store.close();
  });

  describe("label, type and tags", () => {
    // What the live API logs for each of these is contract-tested in
    // test/resources.integration.test.ts; the entries here have the same shape.
    const LATER = "2099-01-01T00:00:00";

    async function indexed(thoughts: Map<string, FakeThought>) {
      const logs = [...thoughts.keys()].map((id, i) => log(id, 101, `2026-08-11T09:00:0${i}`));
      const { api, calls } = fakeApi(thoughts, logs);
      const store = new VectorStore(":memory:");
      const embedder = new FakeEmbedder();
      const indexer = new SemanticIndexer(api, store, embedder);
      await indexer.rebuild(BRAIN);
      return { logs, calls, store, embedder, indexer };
    }

    it("a label change triggers recomputation", async () => {
      const thoughts = new Map<string, FakeThought>([
        ["a", { id: "a", name: "Unity" }],
        ["b", { id: "b", name: "untouched" }],
      ]);
      const { logs, store, embedder, indexer } = await indexed(thoughts);

      thoughts.set("a", { id: "a", name: "Unity", label: "game engine" });
      logs.push(log("a", 202, LATER));
      const result = await indexer.sync(BRAIN);

      expect(result).toMatchObject({ indexed: 1, skipped: 0 });
      expect(embedder.documents.at(-1)).toBe("Unity\ngame engine");
      store.close();
    });

    it("a type change triggers recomputation", async () => {
      const thoughts = new Map<string, FakeThought>([
        ["a", { id: "a", name: "Unity", typeId: "y" }],
        ["y", { id: "y", name: "Tool", kind: 2, children: ["a"] }],
        ["z", { id: "z", name: "Engine", kind: 2 }],
      ]);
      const { logs, store, embedder, indexer } = await indexed(thoughts);

      thoughts.set("a", { id: "a", name: "Unity", typeId: "z" });
      thoughts.set("y", { id: "y", name: "Tool", kind: 2 });
      thoughts.set("z", { id: "z", name: "Engine", kind: 2, children: ["a"] });
      // The old type's link goes and the new one's comes, each with its own 203.
      logs.push(
        linkLog("y", "a", 102, LATER),
        log("a", 203, LATER),
        linkLog("z", "a", 101, LATER),
        log("a", 203, LATER),
      );
      const result = await indexer.sync(BRAIN);

      expect(result.indexed).toBe(1);
      expect(embedder.documents.at(-1)).toBe("Unity\ntype: Engine");
      store.close();
    });

    it("attaching a tag re-embeds the thought, which the log names only as a link's end", async () => {
      const thoughts = new Map<string, FakeThought>([
        ["a", { id: "a", name: "vector databases" }],
        ["b", { id: "b", name: "untouched" }],
        ["g", { id: "g", name: "data", kind: 4 }],
      ]);
      const { logs, store, embedder, indexer } = await indexed(thoughts);

      thoughts.set("a", { id: "a", name: "vector databases", tags: ["g"] });
      thoughts.set("g", { id: "g", name: "data", kind: 4, children: ["a"] });
      logs.push(linkLog("g", "a", 101, LATER));
      const result = await indexer.sync(BRAIN);

      // The tag is the link's other end: read again, and skipped by hash.
      expect(result).toMatchObject({ indexed: 1, skipped: 1 });
      expect(embedder.documents.at(-1)).toBe("vector databases\ntags: data");
      store.close();
    });

    it("detaching a tag re-embeds the thought", async () => {
      const thoughts = new Map<string, FakeThought>([
        ["a", { id: "a", name: "vector databases", tags: ["g"] }],
        ["g", { id: "g", name: "data", kind: 4, children: ["a"] }],
      ]);
      const { logs, store, embedder, indexer } = await indexed(thoughts);

      thoughts.set("a", { id: "a", name: "vector databases" });
      thoughts.set("g", { id: "g", name: "data", kind: 4 });
      logs.push(linkLog("g", "a", 102, LATER));
      const result = await indexer.sync(BRAIN);

      expect(result.indexed).toBe(1);
      expect(embedder.documents.at(-1)).toBe("vector databases");
      store.close();
    });

    it("a tag the graph did not show yet is picked up by the next sync", async () => {
      // A write is in the log at once and in the graph a moment later. On the
      // live API a sync straight after attaching a tag read the old graph one
      // time in four, and used to move its watermark past the entry.
      const thoughts = new Map<string, FakeThought>([
        ["a", { id: "a", name: "vector databases" }],
        ["g", { id: "g", name: "data", kind: 4 }],
      ]);
      const { logs, store, embedder, indexer } = await indexed(thoughts);

      // Stamped now and without an offset, as the log writes it.
      logs.push(linkLog("g", "a", 101, new Date().toISOString().slice(0, -1)));
      const early = await indexer.sync(BRAIN);
      expect(early).toMatchObject({ indexed: 0, skipped: 2 });

      thoughts.set("a", { id: "a", name: "vector databases", tags: ["g"] });
      const late = await indexer.sync(BRAIN);
      expect(late.indexed).toBe(1);
      expect(embedder.documents.at(-1)).toBe("vector databases\ntags: data");
      store.close();
    });

    it("a deletion read again by the next sync is not counted twice", async () => {
      const thoughts = new Map<string, FakeThought>([
        ["a", { id: "a", name: "kept" }],
        ["b", { id: "b", name: "doomed" }],
      ]);
      const { logs, store, indexer } = await indexed(thoughts);

      thoughts.delete("b");
      logs.push(log("b", 102, new Date().toISOString().slice(0, -1)));
      expect((await indexer.sync(BRAIN)).removed).toBe(1);
      expect((await indexer.sync(BRAIN)).removed).toBe(0);
      store.close();
    });

    it.each(["oldest first", "newest first"])(
      "a deleted tag leaves the index and the thought it marked is re-embedded (log %s)",
      async (order) => {
        const thoughts = new Map<string, FakeThought>([
          ["a", { id: "a", name: "vector databases", tags: ["g"] }],
          ["g", { id: "g", name: "data", kind: 4, children: ["a"] }],
        ]);
        const { logs, calls, store, embedder, indexer } = await indexed(thoughts);
        const graphBefore = calls.graph;

        thoughts.delete("g");
        thoughts.set("a", { id: "a", name: "vector databases" });
        // The tag's links are logged as deleted, then the tag itself.
        const entries = [linkLog("g", "a", 102, LATER), log("g", 102, "2099-01-01T00:00:01")];
        logs.push(...(order === "newest first" ? entries.reverse() : entries));
        const result = await indexer.sync(BRAIN);

        expect(result).toMatchObject({ indexed: 1, removed: 1 });
        expect(embedder.documents.at(-1)).toBe("vector databases");
        expect(store.size()).toBe(1);
        expect(calls.graphIds.slice(graphBefore)).toEqual(["a"]);
        store.close();
      },
    );

    it("an ordinary link costs a graph request per end and no embedding", async () => {
      const thoughts = new Map<string, FakeThought>([
        ["a", { id: "a", name: "parent" }],
        ["b", { id: "b", name: "child" }],
        ["c", { id: "c", name: "bystander" }],
      ]);
      const { logs, calls, store, embedder, indexer } = await indexed(thoughts);
      const graphBefore = calls.graph;
      const embeddedBefore = embedder.calls;

      thoughts.set("a", { id: "a", name: "parent", children: ["b"] });
      thoughts.set("b", { id: "b", name: "child", parents: ["a"] });
      logs.push(linkLog("a", "b", 101, LATER));
      const result = await indexer.sync(BRAIN);

      expect(result).toMatchObject({ indexed: 0, skipped: 2 });
      expect(calls.graphIds.slice(graphBefore).sort()).toEqual(["a", "b"]);
      expect(embedder.calls).toBe(embeddedBefore);
      store.close();
    });

    it("a link's own rename marks nothing", async () => {
      const thoughts = new Map<string, FakeThought>([
        ["a", { id: "a", name: "parent", children: ["b"] }],
        ["b", { id: "b", name: "child", parents: ["a"] }],
      ]);
      const { logs, calls, store, indexer } = await indexed(thoughts);
      const graphBefore = calls.graph;

      logs.push(linkLog("a", "b", 103, LATER));
      await indexer.sync(BRAIN);

      expect(calls.graph).toBe(graphBefore);
      store.close();
    });

    it.each([
      { what: "tag", kind: 4, carry: { tags: ["x"] }, line: "tags: datasets" },
      { what: "type", kind: 2, carry: { typeId: "x" }, line: "type: datasets" },
    ])("renaming a $what re-embeds every thought that carries it", async ({ kind, carry, line }) => {
      const thoughts = new Map<string, FakeThought>([
        ["x", { id: "x", name: "data", kind, children: ["a", "b"] }],
        ["a", { id: "a", name: "vector databases", ...carry }],
        ["b", { id: "b", name: "warehouses", ...carry }],
        ["c", { id: "c", name: "bystander" }],
      ]);
      const { logs, calls, store, embedder, indexer } = await indexed(thoughts);
      const graphBefore = calls.graph;
      const embeddedBefore = embedder.documents.length;

      thoughts.set("x", { id: "x", name: "datasets", kind, children: ["a", "b"] });
      // The only entry: the log does not name the thoughts that carry it.
      logs.push(log("x", 103, LATER));
      const result = await indexer.sync(BRAIN);

      expect(result.indexed).toBe(3);
      expect(embedder.documents.slice(embeddedBefore).sort()).toEqual([
        "datasets",
        `vector databases\n${line}`,
        `warehouses\n${line}`,
      ]);
      // One request each, the renamed one included: its graph is reused.
      expect(calls.graphIds.slice(graphBefore).sort()).toEqual(["a", "b", "x"]);
      store.close();
    });

    it("renaming an ordinary thought leaves its children alone", async () => {
      const thoughts = new Map<string, FakeThought>([
        ["a", { id: "a", name: "parent", children: ["b"] }],
        ["b", { id: "b", name: "child", parents: ["a"] }],
      ]);
      const { logs, calls, store, indexer } = await indexed(thoughts);
      const graphBefore = calls.graph;

      thoughts.set("a", { id: "a", name: "renamed parent", children: ["b"] });
      logs.push(log("a", 103, LATER));
      const result = await indexer.sync(BRAIN);

      expect(result.indexed).toBe(1);
      expect(calls.graphIds.slice(graphBefore)).toEqual(["a"]);
      store.close();
    });
  });
});

describe("a thought that changes kind", () => {
  // What the live API logs and reads back for each change is contract-tested
  // in test/resources.integration.test.ts, under the same name. The fake brain
  // and its log below are shaped by that, not by what the indexer reads.
  const NORMAL = 1;
  const TYPE = 2;
  const TAG = 4;
  /** A kind as a `304` writes it. */
  const KIND_NAME: Record<number, string> = { 1: "Normal", 2: "Type", 4: "Tag" };
  /** What a `404` calls a link under a thought of that kind. */
  const UNDER: Record<number, string> = { 1: "Normal", 2: "InstanceOf", 4: "HasTag" };
  type Change = [from: number, to: number];
  const cases = (changes: Change[]): Array<{ change: Change; named: string }> =>
    changes.map((change) => ({
      change,
      named: `${KIND_NAME[change[0]]} → ${KIND_NAME[change[1]]}`,
    }));
  const CHANGES = cases([
    [NORMAL, TAG],
    [TAG, NORMAL],
    [NORMAL, TYPE],
    [TYPE, NORMAL],
    [TYPE, TAG],
    [TAG, TYPE],
  ]);
  /** The two that leave the document of a thought with no label as it was. */
  const BETWEEN_ORDINARY_AND_TAG = CHANGES.filter(({ change }) => !change.includes(TYPE));
  const TO_OR_FROM_A_TYPE = CHANGES.filter(({ change }) => change.includes(TYPE));

  /**
   * A thought as the API reads it. One with no label of its own reads with
   * its name for a label while it is a type, and with none otherwise.
   */
  const thoughtOf = (
    id: string,
    name: string,
    kind: number,
    extra: Partial<FakeThought> = {},
  ): FakeThought => ({
    id,
    name,
    kind,
    ...(kind === TYPE ? { label: name } : {}),
    ...extra,
  });

  /** How a thought under one of that kind is linked to it. */
  const under = (xId: string, kind: number): Partial<FakeThought> =>
    kind === TYPE ? { typeId: xId } : kind === TAG ? { tags: [xId] } : { parents: [xId] };

  /**
   * The log of one kind change, in the API's order: what is under the thought
   * first, its own `304` last, every entry stamped apart.
   *
   * Each link under it changes meaning, a `404` with both ends. A thought that
   * gains the changed one for its type has a `203` straight after its link's
   * entry; those that lose it have theirs ahead of every link.
   */
  function kindChange(
    x: { id: string; name: string },
    [from, to]: Change,
    below: readonly string[] = [],
    at = "2099-01-01T00:00:00",
  ): ModificationLogDto[] {
    let tick = 0;
    const stamp = (): string => `${at}.${String((tick += 1)).padStart(6, "0")}`;
    const typeSet = (id: string, oldValue: string | null, newValue: string | null) => ({
      ...log(id, 203, stamp()),
      oldValue,
      newValue,
    });
    const entries: ModificationLogDto[] = [];
    if (from === TYPE) for (const id of below) entries.push(typeSet(id, x.name, null));
    for (const id of below) {
      entries.push({
        ...linkLog(x.id, id, 404, stamp()),
        oldValue: UNDER[from]!,
        newValue: UNDER[to]!,
      });
      if (to === TYPE) entries.push(typeSet(id, null, x.name));
    }
    entries.push({
      ...log(x.id, 304, stamp()),
      oldValue: KIND_NAME[from]!,
      newValue: KIND_NAME[to]!,
    });
    return entries;
  }

  async function indexed(thoughts: Map<string, FakeThought>) {
    const logs = [...thoughts.keys()].map((id, i) => log(id, 101, `2026-08-11T09:00:0${i}`));
    const { api, calls } = fakeApi(thoughts, logs);
    const store = new VectorStore(":memory:");
    const embedder = new FakeEmbedder();
    const indexer = new SemanticIndexer(api, store, embedder);
    await indexer.rebuild(BRAIN);
    return { api, logs, calls, store, embedder, indexer };
  }

  /** The kind a thought's row holds, read the way a search reads it. */
  const kindOf = (store: VectorStore, id: string): number | undefined =>
    store.search(new Float32Array(8), { limit: 1000 }).find((h) => h.thoughtId === id)?.kind;

  it("the 304 names the thought in sourceId, and is no link event", () => {
    const [entry] = kindChange({ id: "x", name: "data" }, [NORMAL, TAG]);
    expect(entry).toMatchObject({ modType: 304, sourceType: 2, oldValue: "Normal", newValue: "Tag" });
    expect(logThoughtId(entry!)).toBe("x");
    expect(linkEndIds(entry!)).toEqual([]);
  });

  it.each(BETWEEN_ORDINARY_AND_TAG)(
    "sync gives the row its kind and encodes nothing: $named, a thought with nothing under it",
    async ({ change }) => {
      // The document is the one it was, so its hash is too, and the only entry
      // in the log is the 304. The row kept its kind through sync and rebuild.
      const [from, to] = change;
      const thoughts = new Map<string, FakeThought>([
        ["x", thoughtOf("x", "data", from)],
        ["b", thoughtOf("b", "bystander", NORMAL)],
      ]);
      const { logs, calls, store, embedder, indexer } = await indexed(thoughts);
      expect(kindOf(store, "x")).toBe(from);
      const graphBefore = calls.graph;
      const embeddedBefore = embedder.calls;

      thoughts.set("x", thoughtOf("x", "data", to));
      logs.push(...kindChange({ id: "x", name: "data" }, change));
      const result = await indexer.sync(BRAIN);

      expect(kindOf(store, "x")).toBe(to);
      expect(result).toMatchObject({ indexed: 0, kindUpdated: 1, skipped: 0, removed: 0 });
      expect(embedder.calls).toBe(embeddedBefore);
      expect(calls.graphIds.slice(graphBefore)).toEqual(["x"]);
      store.close();
    },
  );

  it.each(TO_OR_FROM_A_TYPE)(
    "to or from a type the document changes as well, with only the 304 to say so: $named",
    async ({ change }) => {
      // A thought with no label of its own reads with its name for a label
      // while it is a type. No 202 is logged for that.
      const [from, to] = change;
      const thoughts = new Map<string, FakeThought>([["x", thoughtOf("x", "data", from)]]);
      const { logs, store, embedder, indexer } = await indexed(thoughts);
      expect(embedder.documents.at(-1)).toBe(from === TYPE ? "data\ndata" : "data");

      thoughts.set("x", thoughtOf("x", "data", to));
      logs.push(...kindChange({ id: "x", name: "data" }, change));
      const result = await indexer.sync(BRAIN);

      expect(kindOf(store, "x")).toBe(to);
      expect(embedder.documents.at(-1)).toBe(to === TYPE ? "data\ndata" : "data");
      expect(result).toMatchObject({ indexed: 1, kindUpdated: 0, skipped: 0 });
      store.close();
    },
  );

  it.each(CHANGES)(
    "a thought with a label of its own keeps its document through any change: $named",
    async ({ change }) => {
      const [from, to] = change;
      const labelled = (kind: number): FakeThought =>
        thoughtOf("x", "data", kind, { label: "what was measured" });
      const thoughts = new Map<string, FakeThought>([["x", labelled(from)]]);
      const { logs, store, embedder, indexer } = await indexed(thoughts);
      const embeddedBefore = embedder.calls;

      thoughts.set("x", labelled(to));
      logs.push(...kindChange({ id: "x", name: "data" }, change));
      const result = await indexer.sync(BRAIN);

      expect(kindOf(store, "x")).toBe(to);
      expect(result).toMatchObject({ indexed: 0, kindUpdated: 1, skipped: 0 });
      expect(embedder.calls).toBe(embeddedBefore);
      store.close();
    },
  );

  it.each(CHANGES)(
    "a rebuild corrects the kind with no entry in the log to go by: $named",
    async ({ change }) => {
      // An index synced before sync read the 304 holds such rows, and a rebuild
      // compared hashes alone: it skipped them as unchanged.
      const [from, to] = change;
      const labelled = (kind: number): FakeThought =>
        thoughtOf("x", "data", kind, { label: "what was measured" });
      const thoughts = new Map<string, FakeThought>([
        ["x", labelled(from)],
        ["b", thoughtOf("b", "bystander", NORMAL)],
      ]);
      const { store, embedder, indexer } = await indexed(thoughts);
      const embeddedBefore = embedder.calls;

      thoughts.set("x", labelled(to));
      const result = await indexer.rebuild(BRAIN);

      expect(kindOf(store, "x")).toBe(to);
      expect(result).toMatchObject({ indexed: 0, kindUpdated: 1, skipped: 1, removed: 0 });
      expect(embedder.calls).toBe(embeddedBefore);
      // And there is nothing left for the next one.
      expect(await indexer.rebuild(BRAIN)).toMatchObject({ indexed: 0, kindUpdated: 0, skipped: 2 });
      store.close();
    },
  );

  it("after one sync a thought turned into a tag has left the default search, and one turned back is in it", async () => {
    const thoughts = new Map<string, FakeThought>([
      ["x", thoughtOf("x", "data", NORMAL)],
      ["g", thoughtOf("g", "gotcha", TAG)],
      ["b", thoughtOf("b", "bystander", NORMAL)],
    ]);
    const { api, logs, store, embedder, indexer } = await indexed(thoughts);
    const search = new SemanticSearch(api, store, embedder);
    const found = async (query: string, includeAuxiliary = false) =>
      (await search.find(BRAIN, query, { includeAuxiliary })).matches.map((m) => [
        m.thoughtId,
        m.kind,
      ]);
    expect(await found("data")).toContainEqual(["x", NORMAL]);
    expect((await found("gotcha")).map(([id]) => id)).not.toContain("g");

    thoughts.set("x", thoughtOf("x", "data", TAG));
    thoughts.set("g", thoughtOf("g", "gotcha", NORMAL));
    logs.push(
      ...kindChange({ id: "x", name: "data" }, [NORMAL, TAG]),
      ...kindChange({ id: "g", name: "gotcha" }, [TAG, NORMAL], [], "2099-01-01T00:00:01"),
    );
    await indexer.sync(BRAIN);

    expect((await found("data")).map(([id]) => id)).not.toContain("x");
    // Asked for, it comes with the kind it has now: the Kind column prints it.
    expect(await found("data", true)).toContainEqual(["x", TAG]);
    expect(await found("gotcha")).toContainEqual(["g", NORMAL]);
    store.close();
  });

  it.each(CHANGES)(
    "what is under the thought is read again through its own entries: $named",
    async ({ change }) => {
      // Children of an ordinary thought, the thoughts a tag is on, the
      // instances of a type: one becomes the other, and each of their
      // documents names the tag or the type.
      const [from, to] = change;
      const x = (kind: number): FakeThought =>
        thoughtOf("x", "data", kind, { children: ["c", "d"] });
      const below = (kind: number): Array<[string, FakeThought]> => [
        ["c", thoughtOf("c", "vector databases", NORMAL, under("x", kind))],
        ["d", thoughtOf("d", "warehouses", NORMAL, under("x", kind))],
      ];
      const thoughts = new Map<string, FakeThought>([
        ["x", x(from)],
        ...below(from),
        ["b", thoughtOf("b", "bystander", NORMAL)],
      ]);
      const { logs, calls, store, embedder, indexer } = await indexed(thoughts);
      const graphBefore = calls.graph;
      const embeddedBefore = embedder.documents.length;

      thoughts.set("x", x(to));
      for (const [id, thought] of below(to)) thoughts.set(id, thought);
      logs.push(...kindChange({ id: "x", name: "data" }, change, ["c", "d"]));
      const result = await indexer.sync(BRAIN);

      const line = to === TYPE ? "\ntype: data" : to === TAG ? "\ntags: data" : "";
      // Its own document changes only with the label a type reads with.
      const own = from === TYPE || to === TYPE;
      expect(embedder.documents.slice(embeddedBefore).sort()).toEqual(
        [
          ...(own ? [to === TYPE ? "data\ndata" : "data"] : []),
          `vector databases${line}`,
          `warehouses${line}`,
        ].sort(),
      );
      expect(kindOf(store, "x")).toBe(to);
      expect(result).toMatchObject({ indexed: own ? 3 : 2, kindUpdated: own ? 0 : 1, skipped: 0 });
      // One request each, and none for the bystander.
      expect(calls.graphIds.slice(graphBefore).sort()).toEqual(["c", "d", "x"]);
      store.close();
    },
  );

  it("a thought turned into a tag loses its type, and its row gets the kind with the new document", async () => {
    const thoughts = new Map<string, FakeThought>([
      ["x", thoughtOf("x", "data", NORMAL, { typeId: "t", tags: ["g"] })],
      ["t", thoughtOf("t", "Topic", TYPE, { children: ["x"] })],
      ["g", thoughtOf("g", "gotcha", TAG, { children: ["x"] })],
    ]);
    const { logs, store, embedder, indexer } = await indexed(thoughts);
    expect(embedder.documents).toContain("data\ntype: Topic\ntags: gotcha");

    // The type's link is deleted and the thought's type cleared; the tag it
    // carried stays, as a tag on a tag; then the 304.
    thoughts.set("x", thoughtOf("x", "data", TAG, { tags: ["g"] }));
    thoughts.set("t", thoughtOf("t", "Topic", TYPE));
    logs.push(
      linkLog("t", "x", 102, "2099-01-01T00:00:00.000001"),
      { ...log("x", 203, "2099-01-01T00:00:00.000002"), oldValue: "Topic", newValue: null },
      {
        ...linkLog("g", "x", 404, "2099-01-01T00:00:00.000003"),
        oldValue: "HasTag",
        newValue: "SubTagOf",
      },
      { ...log("x", 304, "2099-01-01T00:00:00.000004"), oldValue: "Normal", newValue: "Tag" },
    );
    const result = await indexer.sync(BRAIN);

    expect(result).toMatchObject({ indexed: 1, kindUpdated: 0 });
    expect(embedder.documents.at(-1)).toBe("data\ntags: gotcha");
    expect(kindOf(store, "x")).toBe(TAG);
    store.close();
  });

  it("a kind the graph did not show yet is picked up by the next sync, and counted once", async () => {
    // The 304 is in the log at once and the graph follows up to 0.25 s later:
    // read in between, the thought still has its old kind.
    const thoughts = new Map<string, FakeThought>([["x", thoughtOf("x", "data", NORMAL)]]);
    const { logs, store, indexer } = await indexed(thoughts);

    // Stamped now and without an offset, as the log writes it.
    const now = new Date().toISOString().slice(0, 19);
    logs.push(...kindChange({ id: "x", name: "data" }, [NORMAL, TAG], [], now));
    const early = await indexer.sync(BRAIN);
    expect(early).toMatchObject({ indexed: 0, kindUpdated: 0, skipped: 1 });
    expect(kindOf(store, "x")).toBe(NORMAL);

    thoughts.set("x", thoughtOf("x", "data", TAG));
    const late = await indexer.sync(BRAIN);
    expect(kindOf(store, "x")).toBe(TAG);
    expect(late).toMatchObject({ indexed: 0, kindUpdated: 1, skipped: 0 });

    // The overlap reads the entry a third time, and there is nothing to do.
    expect(await indexer.sync(BRAIN)).toMatchObject({ indexed: 0, kindUpdated: 0, skipped: 1 });
    store.close();
  });

  it("a run with no kind to correct reports none", async () => {
    const thoughts = new Map<string, FakeThought>([["x", thoughtOf("x", "data", NORMAL)]]);
    const { logs, store, indexer } = await indexed(thoughts);
    expect(await indexer.rebuild(BRAIN)).toMatchObject({ indexed: 0, kindUpdated: 0, skipped: 1 });
    logs.push(log("y", 101, "2099-01-01T00:00:00"));
    thoughts.set("y", thoughtOf("y", "new", NORMAL));
    expect(await indexer.sync(BRAIN)).toMatchObject({ indexed: 1, kindUpdated: 0, skipped: 0 });
    store.close();
  });
});

describe("search", () => {
  async function ready() {
    const thoughts = new Map<string, FakeThought>([
      ["a", { id: "a", name: "Unity", note: "game engine" }],
      ["b", { id: "b", name: "borscht recipe" }],
      ["t", { id: "t", name: "Tool", kind: 2 }],
    ]);
    const logs = [
      log("a", 101, "2026-08-11T09:00:00"),
      log("b", 101, "2026-08-11T09:00:01"),
      log("t", 101, "2026-08-11T09:00:02"),
      noteLog("a", 801, "2026-08-11T09:00:03"),
    ];
    const searchResults = new Map([
      ["Unity", ["a"]],
      ["engine", ["a", "b"]],
      ["games", ["a"]],
    ]);
    const { api, calls } = fakeApi(thoughts, logs, searchResults);
    const store = new VectorStore(":memory:");
    const embedder = new FakeEmbedder();
    await new SemanticIndexer(api, store, embedder).rebuild(BRAIN);
    return { api, store, embedder, calls };
  }

  it("with a ready index it runs in vector mode", async () => {
    const { api, store, embedder } = await ready();
    const search = new SemanticSearch(api, store, embedder);
    const outcome = await search.find(BRAIN, "Unity");
    expect(outcome.mode).toBe("vector");
    expect(outcome.degradedReason).toBeNull();
    expect(outcome.matches[0]!.source).toBe("vector");
    store.close();
  });

  it("in vector mode a variant finds what the query alone misses", async () => {
    // Regression: variants were ignored whenever the index was ready.
    const { api, store, embedder } = await ready();
    const search = new SemanticSearch(api, store, embedder);
    const alone = await search.find(BRAIN, "zzzz", { limit: 1 });
    expect(alone.matches[0]!.thoughtId).not.toBe("b");
    expect(alone.matches[0]!.matchedVariant).toBeNull();

    const withVariant = await search.find(BRAIN, "zzzz", {
      variants: ["borscht recipe"],
      limit: 1,
    });
    expect(withVariant.mode).toBe("vector");
    expect(withVariant.matches[0]!.thoughtId).toBe("b");
    expect(withVariant.matches[0]!.matchedVariant).toBe("borscht recipe");
    store.close();
  });

  it("in vector mode a thought appears once, with its best score", async () => {
    const { api, store, embedder } = await ready();
    const outcome = await new SemanticSearch(api, store, embedder).find(BRAIN, "Unity", {
      variants: ["Unity game engine", "unity"],
    });
    const ids = outcome.matches.map((m) => m.thoughtId);
    expect(new Set(ids).size).toBe(ids.length);
    // Credit goes to the phrasing that scored best; "unity" is a case-duplicate
    // of the query and is dropped before searching.
    for (const m of outcome.matches) {
      expect([null, "Unity game engine"]).toContain(m.matchedVariant);
    }
    const scores = outcome.matches.map((m) => m.score);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
    store.close();
  });

  it("types and tags stay out of the results", async () => {
    const { api, store, embedder } = await ready();
    const outcome = await new SemanticSearch(api, store, embedder).find(BRAIN, "Tool");
    expect(outcome.matches.map((m) => m.thoughtId)).not.toContain("t");
    store.close();
  });

  it("with no index it falls back to the lexical fan-out and says why", async () => {
    const thoughts = new Map<string, FakeThought>([["a", { id: "a", name: "Unity" }]]);
    const searchResults = new Map([
      ["engine", ["a"]],
      ["Unity", ["a"]],
    ]);
    const { api } = fakeApi(thoughts, [], searchResults);
    const store = new VectorStore(":memory:");
    const outcome = await new SemanticSearch(api, store, new FakeEmbedder()).find(
      BRAIN,
      "engine",
      { variants: ["Unity"] },
    );
    expect(outcome.mode).toBe("keyword");
    expect(outcome.degradedReason).toMatch(/not been built/);
    expect(outcome.matches[0]!.thoughtId).toBe("a");
    expect(outcome.matches[0]!.source).toBe("keyword");
    store.close();
  });

  it("something found by several phrasings ranks higher", async () => {
    const thoughts = new Map<string, FakeThought>([
      ["a", { id: "a", name: "Unity" }],
      ["b", { id: "b", name: "borscht" }],
    ]);
    const searchResults = new Map([
      ["engine", ["b", "a"]],
      ["Unity", ["a"]],
      ["gamedev", ["a"]],
    ]);
    const { api } = fakeApi(thoughts, [], searchResults);
    const store = new VectorStore(":memory:");
    const outcome = await new SemanticSearch(api, store, new FakeEmbedder()).find(
      BRAIN,
      "engine",
      { variants: ["Unity", "gamedev"] },
    );
    // `a` matched three variants, `b` only one despite ranking first there.
    expect(outcome.matches[0]!.thoughtId).toBe("a");
    store.close();
  });

  it("a failure on one variant does not break the others", async () => {
    const thoughts = new Map<string, FakeThought>([["a", { id: "a", name: "Unity" }]]);
    const { api } = fakeApi(thoughts, [], new Map([["Unity", ["a"]]]));
    // The "broken" variant is absent from the map, so it returns an empty list.
    const store = new VectorStore(":memory:");
    const outcome = await new SemanticSearch(api, store, new FakeEmbedder()).find(
      BRAIN,
      "broken",
      { variants: ["Unity"] },
    );
    expect(outcome.matches).toHaveLength(1);
    store.close();
  });
});

describe("search: a phrasing TheBrain's search does not answer", () => {
  const thoughts = new Map<string, FakeThought>([
    ["a", { id: "a", name: "Unity" }],
    ["b", { id: "b", name: "borscht" }],
  ]);
  const found = new Map([
    ["engine", ["a"]],
    ["Unity", ["a"]],
    ["soup", ["b"]],
  ]);

  /**
   * A search with no index, so every phrasing goes to the fake API. A phrasing
   * in `failures` is refused with what it names; the rest answer from `found`.
   */
  function fallback(failures: Record<string, unknown>, embedder: Embedder = new FakeEmbedder()) {
    const { api, calls } = fakeApi(thoughts, [], found);
    const answer = api.search.inBrain.bind(api.search);
    const asked: string[] = [];
    api.search.inBrain = async (brainId, query, options) => {
      asked.push(query);
      if (query in failures) throw failures[query];
      return answer(brainId, query, options);
    };
    const store = new VectorStore(":memory:");
    return { search: new SemanticSearch(api, store, embedder), store, asked, calls };
  }

  const refused = (kind: ApiErrorKind, status?: number): TheBrainError =>
    new TheBrainError(kind, `refused as ${kind}`, {
      ...(status !== undefined ? { status } : {}),
      method: "GET",
      path: `/api/search/${BRAIN}`,
    });

  it("is left out and named, and the others still rank", async () => {
    // It used to count as a phrasing that found nothing.
    const failure = refused("server", 500);
    const { search, store } = fallback({ soup: failure });
    const outcome = await search.find(BRAIN, "engine", { variants: ["soup", "Unity"] });

    expect(outcome.mode).toBe("keyword");
    expect(outcome.matches.map((m) => m.thoughtId)).toEqual(["a"]);
    expect(outcome.phrasings).toBe(3);
    expect(outcome.notSearched).toEqual([{ phrasing: "soup", error: failure }]);
    store.close();
  });

  it("with every phrasing answered nothing is reported as left out", async () => {
    const { search, store } = fallback({});
    const outcome = await search.find(BRAIN, "engine", { variants: ["nothing has this"] });
    expect(outcome.phrasings).toBe(2);
    expect(outcome.notSearched).toEqual([]);
    store.close();
  });

  it("when no phrasing is answered there is no outcome, empty or otherwise", async () => {
    // TheBrain not running fails them all, and read as nothing found.
    const down = new TheBrainError("network", "could not reach http://localhost:11522");
    const { search, store, asked } = fallback({ engine: down, soup: down, Unity: down });
    const failed = await search
      .find(BRAIN, "engine", { variants: ["soup", "Unity"] })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failed).toBeInstanceOf(SearchFailedError);
    expect((failed as SearchFailedError).failures).toEqual([
      { phrasing: "engine", error: down },
      { phrasing: "soup", error: down },
      { phrasing: "Unity", error: down },
    ]);
    expect(asked.sort()).toEqual(["Unity", "engine", "soup"]);
    store.close();
  });

  it("a query alone that fails is not an empty result either", async () => {
    const failure = refused("query_too_long", 414);
    const { search, store } = fallback({ engine: failure });
    await expect(search.find(BRAIN, "engine")).rejects.toMatchObject({
      name: "SearchFailedError",
      failures: [{ phrasing: "engine", error: failure }],
    });
    store.close();
  });

  it.each<[ApiErrorKind]>([["auth"], ["unknown_brain"], ["invalid_uuid"]])(
    "%s is about the call and stops the search, though another phrasing would answer",
    async (kind) => {
      const failure = refused(kind, 401);
      const { search, store } = fallback({ soup: failure });
      const failed = await search.find(BRAIN, "engine", { variants: ["soup"] }).then(
        () => null,
        (error: unknown) => error,
      );
      // The failure itself, for the tool to explain as it does anywhere else.
      expect(failed).toBe(failure);
      store.close();
    },
  );

  it.each<[string, unknown]>([
    ["network", new TheBrainError("network", "request exceeded 30000 ms")],
    ["server", refused("server", 503)],
    ["bad_request", refused("bad_request", 400)],
    ["forbidden", refused("forbidden", 403)],
    ["not_found", refused("not_found", 404)],
    ["query_too_long", refused("query_too_long", 414)],
    ["route_miss", refused("route_miss", 200)],
    ["malformed", refused("malformed", 200)],
    ["an error that is not the API's", new TypeError("cannot read properties of undefined")],
  ])("%s may be one phrasing's own, and only that phrasing is left out", async (_kind, failure) => {
    const { search, store } = fallback({ soup: failure });
    const outcome = await search.find(BRAIN, "engine", { variants: ["soup"] });
    expect(outcome.matches.map((m) => m.thoughtId)).toEqual(["a"]);
    expect(outcome.notSearched).toEqual([{ phrasing: "soup", error: failure }]);
    store.close();
  });

  it("an empty query with no variant to stand for it is refused, and nothing is asked", async () => {
    // The fan-out sent no request and answered an empty result.
    const { search, store, asked } = fallback({});
    await expect(search.find(BRAIN, "   ")).rejects.toBeInstanceOf(EmptyQueryError);
    await expect(search.find(BRAIN, "", { variants: ["", " \t"] })).rejects.toThrow(
      /query is empty, and so is every variant/,
    );
    expect(asked).toEqual([]);
    store.close();
  });

  it("an empty query is carried by its variants, and empty variants are not phrasings", async () => {
    const { search, store, asked } = fallback({});
    const outcome = await search.find(BRAIN, " ", { variants: ["", "Unity", "unity"] });
    expect(asked).toEqual(["Unity"]);
    expect(outcome.phrasings).toBe(1);
    expect(outcome.matches.map((m) => m.thoughtId)).toEqual(["a"]);
    store.close();
  });

  describe("with a ready index", () => {
    async function indexed(embedder: Embedder) {
      const { api } = fakeApi(thoughts, [
        log("a", 101, "2026-08-11T09:00:00"),
        log("b", 101, "2026-08-11T09:00:01"),
      ]);
      const asked: string[] = [];
      api.search.inBrain = async (_brainId, query) => {
        asked.push(query);
        throw new TheBrainError("network", "could not reach http://localhost:11522");
      };
      const store = new VectorStore(":memory:");
      await new SemanticIndexer(api, store, new FakeEmbedder()).rebuild(BRAIN);
      return { search: new SemanticSearch(api, store, embedder), store, asked };
    }

    /** The package that is not installed: its id and size are known, and nothing embeds. */
    class AbsentEmbedder extends FakeEmbedder {
      override async embedQuery(): Promise<Float32Array> {
        throw new EmbedderUnavailableError();
      }
    }

    it("ranking by vectors asks TheBrain nothing, so its failures do not reach it", async () => {
      const { search, store, asked } = await indexed(new FakeEmbedder());
      const outcome = await search.find(BRAIN, "Unity", { variants: ["soup"] });
      expect(outcome.mode).toBe("vector");
      expect(outcome.matches.length).toBeGreaterThan(0);
      expect(outcome).toMatchObject({ phrasings: 2, notSearched: [] });
      expect(asked).toEqual([]);
      store.close();
    });

    it("an empty query is refused there too, with nothing embedded", async () => {
      // It was embedded as it came, and the brain ranked against an empty string.
      const embedder = new FakeEmbedder();
      const { search, store } = await indexed(embedder);
      const before = embedder.calls;
      await expect(search.find(BRAIN, "  ")).rejects.toBeInstanceOf(EmptyQueryError);
      expect(embedder.calls).toBe(before);
      store.close();
    });

    it("without the embeddings package it falls back, says why, and does not throw", async () => {
      const { api } = fakeApi(thoughts, [log("a", 101, "2026-08-11T09:00:00")], found);
      const store = new VectorStore(":memory:");
      await new SemanticIndexer(api, store, new FakeEmbedder()).rebuild(BRAIN);
      const outcome = await new SemanticSearch(api, store, new AbsentEmbedder()).find(
        BRAIN,
        "engine",
        { variants: ["nothing has this"] },
      );
      expect(outcome.mode).toBe("keyword");
      expect(outcome.degradedReason).toMatch(/@huggingface\/transformers package is not installed/);
      expect(outcome.matches.map((m) => m.thoughtId)).toEqual(["a"]);
      expect(outcome.notSearched).toEqual([]);
      store.close();
    });

    it("without the package a search TheBrain does not answer is still not an empty result", async () => {
      const { search, store, asked } = await indexed(new AbsentEmbedder());
      await expect(search.find(BRAIN, "Unity", { variants: ["soup"] })).rejects.toBeInstanceOf(
        SearchFailedError,
      );
      expect(asked.sort()).toEqual(["Unity", "soup"]);
      store.close();
    });
  });
});
