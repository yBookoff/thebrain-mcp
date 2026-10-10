import { describe, expect, it } from "vitest";

import type { TheBrainApi } from "../src/api/index.js";
import type { ModificationLogDto } from "../src/api/types.js";
import type { Embedder } from "../src/semantic/embedder.js";
import {
  SemanticIndexer,
  linkEndIds,
  logThoughtId,
  mapWithConcurrency,
} from "../src/semantic/indexer.js";
import { SemanticSearch, dedupeVariants } from "../src/semantic/search.js";
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
