import { describe, expect, it } from "vitest";

import { VectorStore, dot, normalize } from "../src/semantic/store.js";

const BRAIN = "aaaaaaaa-0000-4000-8000-000000000001";

function vec(...values: number[]): Float32Array {
  return normalize(new Float32Array(values));
}

function store(): VectorStore {
  return new VectorStore(":memory:");
}

describe("vector arithmetic", () => {
  it("normalisation yields unit length", () => {
    const v = normalize(new Float32Array([3, 4]));
    expect(dot(v, v)).toBeCloseTo(1, 6);
  });

  it("a zero vector does not break normalisation", () => {
    const v = normalize(new Float32Array([0, 0, 0]));
    expect([...v]).toEqual([0, 0, 0]);
  });

  it("cosine of identical directions is one", () => {
    expect(dot(vec(1, 0), vec(2, 0))).toBeCloseTo(1, 6);
  });

  it("cosine of orthogonal vectors is zero", () => {
    expect(dot(vec(1, 0), vec(0, 1))).toBeCloseTo(0, 6);
  });
});

describe("storage", () => {
  it("stores and returns a vector without distortion", () => {
    const s = store();
    const original = vec(0.1, -0.5, 0.84);
    s.upsert([
      { thoughtId: "t1", name: "thought", kind: 1, contentHash: "h1", vector: original },
    ]);
    const hits = s.search(original, { limit: 1 });
    expect(hits[0]!.thoughtId).toBe("t1");
    expect(hits[0]!.score).toBeCloseTo(1, 5);
    s.close();
  });

  it("ranks by proximity", () => {
    const s = store();
    s.upsert([
      { thoughtId: "near", name: "near", kind: 1, contentHash: "a", vector: vec(1, 0.1, 0) },
      { thoughtId: "far", name: "far", kind: 1, contentHash: "b", vector: vec(0, 0, 1) },
      { thoughtId: "middle", name: "middle", kind: 1, contentHash: "c", vector: vec(0.7, 0.7, 0) },
    ]);
    const hits = s.search(vec(1, 0, 0), { limit: 3 });
    expect(hits.map((h) => h.thoughtId)).toEqual(["near", "middle", "far"]);
    s.close();
  });

  it("limit caps the result set", () => {
    const s = store();
    s.upsert(
      Array.from({ length: 10 }, (_, i) => ({
        thoughtId: `t${i}`,
        name: `thought ${i}`,
        kind: 1,
        contentHash: `h${i}`,
        vector: vec(1, i / 10, 0),
      })),
    );
    expect(s.search(vec(1, 0, 0), { limit: 3 })).toHaveLength(3);
    s.close();
  });

  it("excludeKinds removes types and tags from results", () => {
    const s = store();
    s.upsert([
      { thoughtId: "ordinary", name: "ordinary", kind: 1, contentHash: "a", vector: vec(1, 0) },
      { thoughtId: "type", name: "type", kind: 2, contentHash: "b", vector: vec(1, 0) },
      { thoughtId: "tag", name: "tag", kind: 4, contentHash: "c", vector: vec(1, 0) },
    ]);
    const hits = s.search(vec(1, 0), { excludeKinds: [2, 4] });
    expect(hits.map((h) => h.thoughtId)).toEqual(["ordinary"]);
    s.close();
  });

  it("upsert updates the existing row instead of duplicating", () => {
    const s = store();
    s.upsert([{ thoughtId: "t1", name: "old", kind: 1, contentHash: "h1", vector: vec(1, 0) }]);
    s.upsert([{ thoughtId: "t1", name: "new", kind: 1, contentHash: "h2", vector: vec(0, 1) }]);
    expect(s.size()).toBe(1);
    const hits = s.search(vec(0, 1), { limit: 1 });
    expect(hits[0]!.name).toBe("new");
    s.close();
  });

  it("remove deletes and invalidates the cache", () => {
    const s = store();
    s.upsert([
      { thoughtId: "a", name: "a", kind: 1, contentHash: "1", vector: vec(1, 0) },
      { thoughtId: "b", name: "b", kind: 1, contentHash: "2", vector: vec(0, 1) },
    ]);
    expect(s.search(vec(1, 0))).toHaveLength(2);
    s.remove(["a"]);
    const hits = s.search(vec(1, 0));
    expect(hits.map((h) => h.thoughtId)).toEqual(["b"]);
    expect(s.size()).toBe(1);
    s.close();
  });

  it("empty operations do not throw", () => {
    const s = store();
    expect(() => s.upsert([])).not.toThrow();
    expect(() => s.remove([])).not.toThrow();
    expect(s.search(vec(1, 0))).toEqual([]);
    s.close();
  });

  it("contentHashes returns a map for skipping unchanged entries", () => {
    const s = store();
    s.upsert([
      { thoughtId: "a", name: "a", kind: 1, contentHash: "hash-a", vector: vec(1, 0) },
      { thoughtId: "b", name: "b", kind: 1, contentHash: "hash-b", vector: vec(0, 1) },
    ]);
    expect(s.contentHashes()).toEqual(
      new Map([
        ["a", "hash-a"],
        ["b", "hash-b"],
      ]),
    );
    s.close();
  });
});

describe("index compatibility", () => {
  it("empty storage is compatible with nothing", () => {
    const s = store();
    expect(s.isCompatible(BRAIN, "e5-small", 384)).toBe(false);
    s.close();
  });

  it("brain, model and dimensions all match", () => {
    const s = store();
    s.setMeta({ brainId: BRAIN, model: "e5-small", dimensions: 384, syncedThrough: null });
    expect(s.isCompatible(BRAIN, "e5-small", 384)).toBe(true);
    s.close();
  });

  it("changing the model makes the index unusable", () => {
    const s = store();
    s.setMeta({ brainId: BRAIN, model: "e5-small", dimensions: 384, syncedThrough: null });
    expect(s.isCompatible(BRAIN, "e5-base", 384)).toBe(false);
    s.close();
  });

  it("changing dimensions makes the index unusable", () => {
    const s = store();
    s.setMeta({ brainId: BRAIN, model: "e5-small", dimensions: 384, syncedThrough: null });
    expect(s.isCompatible(BRAIN, "e5-small", 768)).toBe(false);
    s.close();
  });

  it("a different brain does not match", () => {
    const s = store();
    s.setMeta({ brainId: BRAIN, model: "e5-small", dimensions: 384, syncedThrough: null });
    expect(s.isCompatible("11111111-2222-3333-4444-555555555555", "e5-small", 384)).toBe(
      false,
    );
    s.close();
  });

  it("the sync watermark is persisted", () => {
    const s = store();
    s.setMeta({ brainId: BRAIN, model: "m", dimensions: 3, syncedThrough: null });
    s.setSyncedThrough("2026-08-11T12:00:00Z");
    expect(s.getMeta()?.syncedThrough).toBe("2026-08-11T12:00:00Z");
    s.close();
  });

  it("clear wipes everything", () => {
    const s = store();
    s.setMeta({ brainId: BRAIN, model: "m", dimensions: 2, syncedThrough: null });
    s.upsert([{ thoughtId: "a", name: "a", kind: 1, contentHash: "h", vector: vec(1, 0) }]);
    s.clear();
    expect(s.size()).toBe(0);
    expect(s.getMeta()).toBeNull();
    s.close();
  });
});

describe("scale", () => {
  it("scanning 20,000 vectors at 384 dimensions stays under 200 ms", () => {
    const s = store();
    const dim = 384;
    const batch = Array.from({ length: 20_000 }, (_, i) => {
      const v = new Float32Array(dim);
      for (let d = 0; d < dim; d += 1) v[d] = Math.sin(i * 0.01 + d);
      return {
        thoughtId: `t${i}`,
        name: `thought ${i}`,
        kind: 1,
        contentHash: `h${i}`,
        vector: normalize(v),
      };
    });
    s.upsert(batch);

    const query = normalize(
      new Float32Array(Array.from({ length: dim }, (_, d) => Math.sin(d))),
    );
    s.search(query, { limit: 10 }); // warm the cache

    const t0 = performance.now();
    const hits = s.search(query, { limit: 10 });
    const elapsed = performance.now() - t0;

    expect(hits).toHaveLength(10);
    expect(elapsed).toBeLessThan(200);
    s.close();
  });
});
