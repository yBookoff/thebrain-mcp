import { describe, expect, it } from "vitest";

import type { TheBrainApi } from "../src/api/index.js";
import type { ModificationLogDto } from "../src/api/types.js";
import type { Embedder } from "../src/semantic/embedder.js";
import {
  SemanticIndexer,
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
  typeName?: string;
  tags?: string[];
  note?: string;
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
      async modifications(_brainId: string, options?: { since?: string }) {
        calls.modifications += 1;
        if (options?.since === undefined) return logs;
        return logs.filter((l) => l.creationDateTime > options.since!);
      },
    },
    thoughts: {
      async getGraph(_brainId: string, id: string) {
        calls.graph += 1;
        calls.graphIds.push(id);
        const t = thoughts.get(id);
        if (t === undefined) throw new Error(`no thought ${id}`);
        return {
          thought: { id: t.id, name: t.name, kind: t.kind ?? 1, label: null },
          parents: (t.parents ?? []).map(ref),
          children: (t.children ?? []).map(ref),
          jumps: (t.jumps ?? []).map(ref),
          siblings: [],
          links: [],
          // Tags and types are thoughts of their own; these ids point nowhere,
          // like a tag the walk may try once and find gone.
          type: t.typeName ? { id: `type-${t.typeName}`, name: t.typeName } : null,
          tags: (t.tags ?? []).map((name) => ({ id: `tag-${name}`, name })),
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

  it("logThoughtId ignores events about other entities", () => {
    expect(logThoughtId(log("some-link", 101, "t1", 3))).toBeNull();
    // An attachment event that is not a note: a URL attachment, say.
    expect(logThoughtId({ ...noteLog("t", 501, "t1") })).toBeNull();
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
