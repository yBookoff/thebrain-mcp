import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUSY_TIMEOUT_MS,
  IndexBusyError,
  IndexRunningError,
  RUN_WAIT_MS,
  VectorStore,
  dot,
  normalize,
  type SimilarityHit,
  type StoredVector,
} from "../src/semantic/store.js";

const BRAIN = "aaaaaaaa-0000-4000-8000-000000000001";

function vec(...values: number[]): Float32Array {
  return normalize(new Float32Array(values));
}

function store(): VectorStore {
  return new VectorStore(":memory:");
}

/**
 * How the two tests that time a search take their figures.
 *
 * Each timed one search, once, and held it under 200 ms. A figure on a clock
 * is the machine's as much as the store's. A scan of 20,000 vectors takes
 * 7 ms on a performance core of an Apple M4 and 20–66 ms on an efficiency
 * core, which is where a process at background priority runs, and where one
 * at ordinary priority ran for a quarter of an hour of these measurements.
 * The search that reads the rows again takes 41–62 ms on the one and 130–330
 * ms on the other, on both sides of the 200 ms it was held under. With two
 * more runs of the suite going, the best of five scans took up to 233 ms and
 * the best of five such searches 831 ms. And no bound that is over all of
 * that tells a store that has gone wrong where the cores are fast: one that
 * read the rows again for every search scanned in 38 ms.
 *
 * So a search is held against `bareScan()` and not against the clock: the
 * same scan of the same rows, timed straight after it, as fast or as slow
 * as the machine is at that moment. That is done `ROUNDS` times and the
 * least of the ratios is held: it takes a busy moment on the search in
 * every round, and none on the scan beside it, to fail a store that is as
 * it should be. The search was three bare scans or more in none of 990
 * rounds with no other run of the suite going, in 2 of 200 with two more,
 * and in 32 of 400 with those two and the test at background priority,
 * three of a test's five at the most.
 */
const ROUNDS = 5;
/**
 * For a test that builds an index of this size and times it. One took 6.8 s
 * at background priority with two more runs of the suite going: Vitest's
 * own 5 s would be a figure sitting on top of a measurement again.
 */
const TIMED = { timeout: 30_000 };

/** Milliseconds for one call. */
function ms(run: () => void): number {
  const t0 = performance.now();
  run();
  return performance.now() - t0;
}

/** The least of a figure over the rounds. */
function least<R>(rounds: readonly R[], of: (round: R) => number): number {
  return Math.min(...rounds.map(of));
}

/**
 * An index of the size a scan is promised for: 20,000 thoughts at the 384
 * dimensions of the model. The query is the first row's own vector, so
 * that row is among the hits whatever the others score.
 */
function realistic(): { rows: StoredVector[]; query: Float32Array } {
  const dim = 384;
  const rows = Array.from({ length: 20_000 }, (_, i) => {
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
  const query = normalize(new Float32Array(Array.from({ length: dim }, (_, d) => Math.sin(d))));
  return { rows, query };
}

/**
 * A scan and nothing else: the query against every row, and the best of
 * them, over rows that are in memory already. Written out here and not
 * through `dot()`: a yardstick made of the store's own code is slower
 * whenever the store is.
 */
function bareScan(rows: readonly StoredVector[], query: Float32Array, limit: number): SimilarityHit[] {
  const hits: SimilarityHit[] = [];
  for (const { thoughtId, name, kind, vector } of rows) {
    let score = 0;
    for (let i = 0; i < query.length; i += 1) score += query[i]! * vector[i]!;
    hits.push({ thoughtId, name, kind, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
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

  it("kinds returns what each row was indexed as", () => {
    const s = store();
    s.upsert([
      { thoughtId: "a", name: "a", kind: 1, contentHash: "hash-a", vector: vec(1, 0) },
      { thoughtId: "b", name: "b", kind: 4, contentHash: "hash-b", vector: vec(0, 1) },
    ]);
    expect(s.kinds()).toEqual(
      new Map([
        ["a", 1],
        ["b", 4],
      ]),
    );
    s.close();
  });

  it("setKinds changes the kind a search excludes by, and nothing else of the row", () => {
    const s = store();
    s.upsert([
      { thoughtId: "a", name: "data", kind: 1, contentHash: "hash-a", vector: vec(1, 0.2) },
      { thoughtId: "b", name: "gotcha", kind: 4, contentHash: "hash-b", vector: vec(0.2, 1) },
    ]);
    // Read once, so that the rows are in the cache a search answers from.
    const before = s.search(vec(1, 0));
    expect(s.search(vec(1, 0), { excludeKinds: [2, 4] }).map((h) => h.thoughtId)).toEqual(["a"]);

    s.setKinds(
      new Map([
        ["a", 4],
        ["b", 1],
      ]),
    );

    expect(s.search(vec(1, 0), { excludeKinds: [2, 4] }).map((h) => h.thoughtId)).toEqual(["b"]);
    expect(s.search(vec(1, 0))).toEqual(
      before.map((h) => ({ ...h, kind: h.thoughtId === "a" ? 4 : 1 })),
    );
    expect(s.contentHashes()).toEqual(
      new Map([
        ["a", "hash-a"],
        ["b", "hash-b"],
      ]),
    );
    expect(s.size()).toBe(2);
    s.close();
  });

  it("setKinds passes over an identifier with no row, and an empty map", () => {
    const s = store();
    s.upsert([{ thoughtId: "a", name: "a", kind: 1, contentHash: "h", vector: vec(1, 0) }]);
    expect(() => s.setKinds(new Map())).not.toThrow();
    s.setKinds(new Map([["nobody", 4]]));
    expect(s.kinds()).toEqual(new Map([["a", 1]]));
    expect(s.size()).toBe(1);
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
  it("scanning 20,000 vectors at 384 dimensions costs under three times a bare scan of them", TIMED, () => {
    const s = store();
    const { rows, query } = realistic();
    s.upsert(rows);
    s.search(query, { limit: 10 }); // warm the cache
    bareScan(rows, query, 10); // and the yardstick

    let hits: SimilarityHit[] = [];
    let bare: SimilarityHit[] = [];
    const rounds = Array.from({ length: ROUNDS }, () => {
      const scan = ms(() => {
        hits = s.search(query, { limit: 10 });
      });
      const yard = ms(() => {
        bare = bareScan(rows, query, 10);
      });
      return { scan, yard };
    });

    // The yardstick is the same scan: it comes to the same ten.
    expect(hits).toHaveLength(10);
    expect(hits.map((h) => h.thoughtId)).toEqual(bare.map((h) => h.thoughtId));
    // 1.05 at the most on a performance core left alone, and 1.2 under any
    // load tried. Reading the rows again for every search made it 5.0–5.2
    // and a dot product by way of plain arrays 17–24. A query to the
    // database for every row made it 3.0–7.6: 2.98 in one run of seven.
    expect(least(rounds, (r) => r.scan / r.yard)).toBeLessThan(3);
    s.close();
  });
});

describe("the index file", () => {
  // Opening a store created its file, and the journal's two beside it. A
  // store is opened for a look as often as for a build: `brain_list` asks
  // every brain's, and `brain_search` asks before it knows the brain is there.
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "thebrain-mcp-store-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const data = (): string => join(dir, "data");
  const path = (): string => join(data(), `index-${BRAIN}.sqlite`);
  const meta = { brainId: BRAIN, model: "m", dimensions: 2, syncedThrough: null };
  const row = { thoughtId: "a", name: "a", kind: 1, contentHash: "h", vector: vec(1, 0) };

  it("is not created by a look: a store with no file reads as an empty index", () => {
    const s = new VectorStore(path());
    expect(s.getMeta()).toBeNull();
    expect(s.isCompatible(BRAIN, "m", 2)).toBe(false);
    expect(s.size()).toBe(0);
    expect(s.contentHashes()).toEqual(new Map());
    expect(s.kinds()).toEqual(new Map());
    expect(s.search(vec(1, 0))).toEqual([]);
    s.close();
    // Not its directory either.
    expect(existsSync(data())).toBe(false);
  });

  it("nor by a write with nothing to write to", () => {
    const s = new VectorStore(path());
    s.remove(["a"]);
    s.setKinds(new Map([["a", 4]]));
    s.upsert([]);
    s.clear();
    s.close();
    expect(existsSync(data())).toBe(false);
  });

  it("is created by the first write, with its directory, and read back by the next store", () => {
    const s = new VectorStore(path());
    s.setMeta(meta);
    expect(existsSync(path())).toBe(true);
    s.upsert([row]);
    s.setSyncedThrough("2026-10-11T00:00:00.000Z");
    s.close();

    const again = new VectorStore(path());
    expect(again.getMeta()).toEqual({ ...meta, syncedThrough: "2026-10-11T00:00:00.000Z" });
    expect(again.size()).toBe(1);
    again.close();
  });

  it("an upsert alone creates it", () => {
    const s = new VectorStore(path());
    s.upsert([row]);
    expect(readdirSync(data())).toContain(`index-${BRAIN}.sqlite`);
    expect(s.size()).toBe(1);
    s.close();
  });

  it("is found by a store that was opened before it was there", () => {
    // Two servers can share a data directory: one builds, the other looks.
    const early = new VectorStore(path());
    expect(early.size()).toBe(0);
    expect(early.search(vec(1, 0))).toEqual([]);

    const builder = new VectorStore(path());
    builder.setMeta(meta);
    builder.upsert([row]);

    expect(early.getMeta()?.brainId).toBe(BRAIN);
    expect(early.size()).toBe(1);
    expect(early.search(vec(1, 0)).map((h) => h.thoughtId)).toEqual(["a"]);
    early.close();
    builder.close();
  });
});

/**
 * Every client session starts a server process of its own, and they all open
 * the same file for a brain. What follows is one file under several stores,
 * and under another process where only a process will do.
 *
 * The other process writes through `node:sqlite` itself, the SQL the store
 * sends: the store cannot tell who wrote a row, and a `.ts` file is not what
 * a bare `node` runs. It says `ready` when it is where the test wants it.
 */
function otherProcess(
  script: string,
  ...args: string[]
): { child: ChildProcess; ready: Promise<void>; gone: Promise<void> } {
  const child = spawn(
    process.execPath,
    ["--no-warnings", "--input-type=module", "-e", script, ...args],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout!.once("data", () => resolve());
    child.once("exit", () => reject(new Error("the other process ended before it was ready")));
  });
  // For a test that waits for the end only: not an unhandled rejection.
  ready.catch(() => undefined);
  return { child, ready, gone };
}

describe("one index file under several stores", () => {
  let dir: string;
  const open: VectorStore[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "thebrain-mcp-shared-"));
  });
  afterEach(() => {
    for (const s of open.splice(0)) s.close();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });
  const path = (): string => join(dir, `index-${BRAIN}.sqlite`);
  /** A store as one server process holds it. `busyTimeoutMs` short, for a wait that is to fail. */
  const server = (busyTimeoutMs?: number): VectorStore => {
    const s = new VectorStore(path(), busyTimeoutMs === undefined ? {} : { busyTimeoutMs });
    open.push(s);
    return s;
  };
  const meta = { brainId: BRAIN, model: "m", dimensions: 2, syncedThrough: null };
  const row = (id: string, vector: Float32Array, kind = 1) => ({
    thoughtId: id,
    name: id,
    kind,
    contentHash: `h-${id}`,
    vector,
  });
  const ids = (s: VectorStore, options: { excludeKinds?: number[] } = {}): string[] =>
    s.search(vec(1, 0), options).map((h) => h.thoughtId);

  describe("a search ranks by what another store wrote since the last one", () => {
    // The rows were read once and kept until this store's own next write: a
    // server went on ranking by what it had loaded, whatever another built.
    /** Two rows written by one store and searched, so cached, by the other. */
    const pair = (): { writer: VectorStore; reader: VectorStore } => {
      const writer = server();
      writer.setMeta(meta);
      writer.upsert([row("a", vec(1, 0.5)), row("b", vec(0.5, 1), 4)]);
      const reader = server();
      expect(ids(reader)).toEqual(["a", "b"]);
      return { writer, reader };
    };

    it("a row added", () => {
      const { writer, reader } = pair();
      writer.upsert([row("c", vec(1, 0))]);
      expect(ids(reader)).toEqual(["c", "a", "b"]);
    });

    it("a row replaced", () => {
      const { writer, reader } = pair();
      writer.upsert([{ ...row("b", vec(1, 0)), name: "renamed" }]);
      expect(reader.search(vec(1, 0))[0]).toMatchObject({ thoughtId: "b", name: "renamed" });
    });

    it("a row given another kind", () => {
      const { writer, reader } = pair();
      expect(ids(reader, { excludeKinds: [4] })).toEqual(["a"]);
      writer.setKinds(new Map([["a", 4], ["b", 1]]));
      expect(ids(reader, { excludeKinds: [4] })).toEqual(["b"]);
    });

    it("a row removed", () => {
      const { writer, reader } = pair();
      writer.remove(["a"]);
      expect(ids(reader)).toEqual(["b"]);
    });

    it("every row cleared, and the index started over", () => {
      const { writer, reader } = pair();
      writer.clear();
      expect(ids(reader)).toEqual([]);
      writer.upsert([row("a", vec(1, 0))]);
      expect(ids(reader)).toEqual(["a"]);
      writer.startOver({ ...meta, model: "other" });
      expect(ids(reader)).toEqual([]);
      expect(reader.getMeta()?.model).toBe("other");
    });

    it("the rest of a build that the store first searched part of the way through", () => {
      // A session that searched while another was building its first index
      // kept the first batch: 64 rows of 2,001, with status saying "built".
      const builder = server();
      builder.setMeta(meta);
      builder.upsert([row("a", vec(1, 0.1)), row("b", vec(1, 0.2))]);
      const reader = server();
      expect(ids(reader)).toEqual(["a", "b"]);
      builder.upsert([row("c", vec(1, 0)), row("d", vec(1, 0.3))]);
      builder.setSyncedThrough("2026-10-11T00:00:00.000Z");
      expect(ids(reader)).toEqual(["c", "a", "b", "d"]);
    });

    it("and its own writes as before, which the store that wrote the rows sees in its turn", () => {
      const { writer, reader } = pair();
      expect(ids(writer)).toEqual(["a", "b"]);
      reader.remove(["b"]);
      expect(ids(reader)).toEqual(["a"]);
      expect(ids(writer)).toEqual(["a"]);
    });

    it("rows written by another process", async () => {
      const { reader } = pair();
      const other = otherProcess(
        `import { DatabaseSync } from "node:sqlite";
         const db = new DatabaseSync(process.argv.at(-1));
         db.prepare("INSERT INTO vectors VALUES('c', 'c', 1, 'h-c', ?)")
           .run(Buffer.from(new Float32Array([1, 0]).buffer));
         db.close();`,
        path(),
      );
      await other.gone;
      expect(ids(reader)).toEqual(["c", "a", "b"]);
    });
  });

  it("the rows are read again only when the file has changed", () => {
    // What a search asks first is one PRAGMA. The scan stays what it costs.
    const writer = server();
    writer.upsert([row("a", vec(1, 0))]);
    const reader = server();
    ids(reader);

    const prepared = vi.spyOn(DatabaseSync.prototype, "prepare");
    const rowsRead = (): number =>
      prepared.mock.calls.filter(([sql]) => /SELECT .*vector FROM vectors/.test(sql)).length;
    for (let i = 0; i < 5; i += 1) ids(reader);
    expect(rowsRead()).toBe(0);
    expect(prepared.mock.calls.map(([sql]) => sql)).toEqual(Array(5).fill("PRAGMA data_version"));

    writer.upsert([row("b", vec(0, 1))]);
    for (let i = 0; i < 5; i += 1) expect(ids(reader)).toEqual(["a", "b"]);
    expect(rowsRead()).toBe(1);
  });

  it("a store that is closed and used again reads the rows again", () => {
    // `data_version` is one connection's count: the next connection's is not
    // to be matched against the rows the last one read.
    const reader = server();
    reader.upsert([row("a", vec(1, 0))]);
    expect(ids(reader)).toEqual(["a"]);
    reader.close();
    const writer = server();
    writer.upsert([row("b", vec(1, 0.1))]);
    expect(ids(reader)).toEqual(["a", "b"]);
  });

  describe("a write another connection has open", () => {
    /** A connection of some other process's, with a write begun and not ended. */
    const midWrite = (): DatabaseSync => {
      const db = new DatabaseSync(path());
      db.exec("BEGIN IMMEDIATE");
      db.prepare("INSERT INTO vectors VALUES('z', 'z', 1, 'h-z', ?)").run(
        Buffer.from(new Float32Array([1, 0]).buffer),
      );
      return db;
    };
    const BUSY =
      "Another server process had the semantic index of this brain locked, and had not let " +
      "go of it after 0.03 s. Every client session runs a server process of its own, and " +
      "they share one index file.";

    it("is not in the way of a read, which answers by the rows as they were before it", () => {
      const s = server();
      s.setMeta(meta);
      s.upsert([row("a", vec(1, 0.5))]);
      const writing = midWrite();
      expect(s.size()).toBe(1);
      expect(ids(s)).toEqual(["a"]);
      expect(s.getMeta()?.brainId).toBe(BRAIN);
      expect([...s.contentHashes().keys()]).toEqual(["a"]);
      writing.exec("COMMIT");
      writing.close();
      expect(ids(s)).toEqual(["z", "a"]);
    });

    it.each<[string, (s: VectorStore) => void]>([
      ["upsert", (s) => s.upsert([row("b", vec(0, 1))])],
      ["remove", (s) => s.remove(["a"])],
      ["setKinds", (s) => s.setKinds(new Map([["a", 4]]))],
      ["setMeta", (s) => s.setMeta({ ...meta, model: "other" })],
      ["setSyncedThrough", (s) => s.setSyncedThrough("2026-10-11T00:00:00.000Z")],
      ["clear", (s) => s.clear()],
      ["startOver", (s) => s.startOver({ ...meta, model: "other" })],
    ])("%s that waits for it in vain fails with a sentence, and writes nothing", (_name, write) => {
      // SQLite's own answer was the whole result of the tool: `database is
      // locked`, at once, for whichever of two servers wrote second.
      const s = server(30);
      s.setMeta(meta);
      s.upsert([row("a", vec(1, 0))]);
      const writing = midWrite();

      const failure = (() => {
        try {
          write(s);
        } catch (error) {
          return error;
        }
        return null;
      })();
      expect(failure).toBeInstanceOf(IndexBusyError);
      expect((failure as Error).message).toBe(`${BUSY} This write to the index was not made.`);
      expect((failure as Error).message).not.toMatch(/database is locked/);

      writing.exec("ROLLBACK");
      writing.close();
      expect(s.getMeta()).toEqual(meta);
      expect(s.kinds()).toEqual(new Map([["a", 1]]));
      // And the store is as good as it was: the next write is made.
      write(s);
    });

    it("is waited for, and the write is made after it", async () => {
      const s = server();
      s.setMeta(meta);
      s.upsert([row("a", vec(1, 0))]);
      // Another process, since the wait blocks this one: nothing here could
      // end the write that is waited for.
      const other = otherProcess(
        `import { DatabaseSync } from "node:sqlite";
         const db = new DatabaseSync(process.argv.at(-1));
         db.exec("BEGIN IMMEDIATE");
         db.prepare("INSERT INTO vectors VALUES('z', 'z', 1, 'h-z', ?)")
           .run(Buffer.from(new Float32Array([0, 1]).buffer));
         console.log("ready");
         setTimeout(() => { db.exec("COMMIT"); db.close(); }, 300);`,
        path(),
      );
      await other.ready;
      // Not timed: on a busy machine this line may come late. Without the
      // wait it throws `database is locked` while the other still writes.
      s.upsert([row("b", vec(1, 0.5))]);
      await other.gone;
      expect(ids(s)).toEqual(["a", "b", "z"]);
    });

    it("a look that meets the file half made waits as a write does", () => {
      // Opening sets the journal mode and makes the tables where they are not
      // there yet. Met while another process was at exactly that, a status
      // answered `database is locked`.
      const making = new DatabaseSync(path());
      making.exec("BEGIN IMMEDIATE; CREATE TABLE half_made (x)");
      const s = server(30);
      expect(() => s.getMeta()).toThrowError(IndexBusyError);
      expect(() => s.size()).toThrowError(`${BUSY} The index was not read.`);
      making.exec("ROLLBACK");
      making.close();
      // The file is there with nothing in it: an empty index, as before.
      expect(s.getMeta()).toBeNull();
      expect(s.size()).toBe(0);
    });
  });

  describe("a write is all in the file or not there at all", () => {
    const built = { ...meta, syncedThrough: "2026-10-10T00:00:00.000Z" };
    /** A row SQLite refuses, part of the way through a write. */
    const refused = { ...row("bad", vec(0, 1)), name: null as unknown as string };

    it("an upsert that fails at its second row leaves the first out too", () => {
      const s = server();
      s.upsert([row("a", vec(1, 0))]);
      expect(() => s.upsert([row("b", vec(1, 0.1)), refused])).toThrowError(/NOT NULL/);
      expect(ids(s)).toEqual(["a"]);
    });

    it("an index started over keeps its rows and its watermark when the new metadata is not written", () => {
      // A rebuild over an index of another model cleared the rows, then the
      // metadata, then wrote the new: a process killed after the first step
      // left the old watermark over no rows, which reads as a built index.
      const s = server();
      s.setMeta(built);
      s.upsert([row("a", vec(1, 0))]);
      const other = server();
      expect(ids(other)).toEqual(["a"]);

      expect(() => s.startOver({ ...meta, model: null as unknown as string })).toThrowError(
        /NOT NULL/,
      );
      expect(s.getMeta()).toEqual(built);
      expect(ids(s)).toEqual(["a"]);
      expect(ids(other)).toEqual(["a"]);

      s.startOver({ ...meta, model: "other" });
      expect(s.getMeta()).toEqual({ ...meta, model: "other" });
      expect(s.size()).toBe(0);
      expect(other.getMeta()).toEqual({ ...meta, model: "other" });
    });

    it("a process killed before the end of a write leaves the index as it was", async () => {
      const s = server();
      s.setMeta(built);
      s.upsert([row("a", vec(1, 0)), row("b", vec(0.5, 1))]);
      // What `startOver` sends, cut off before its last statement.
      const other = otherProcess(
        `import { DatabaseSync } from "node:sqlite";
         const db = new DatabaseSync(process.argv.at(-1));
         db.exec("BEGIN IMMEDIATE; DELETE FROM vectors; DELETE FROM meta;");
         db.exec("INSERT INTO meta VALUES('brainId', 'x'), ('model', 'other')");
         console.log("ready");
         setInterval(() => {}, 1000);`,
        path(),
      );
      await other.ready;
      other.child.kill("SIGKILL");
      await other.gone;

      expect(s.getMeta()).toEqual(built);
      expect(ids(s)).toEqual(["a", "b"]);
      // The lock died with the process: the next write does not wait.
      s.upsert([row("c", vec(1, 0.1))]);
      expect(s.size()).toBe(3);
    });
  });

  describe("one run at a time", () => {
    const lockFile = (): string => `index-${BRAIN}.sqlite.lock`;
    const RUNNING = (waited: string): string =>
      "Another rebuild or sync of this brain's semantic index is running, and had not " +
      `finished after ${waited} of waiting. Every client session runs a server process of ` +
      "its own, and they share one index file, which one run writes at a time.";

    it("a second claim waits for the first to be given back", async () => {
      const first = server();
      const second = server();
      const release = await first.claim();
      let got = false;
      const waiting = second.claim(5_000).then((give) => {
        got = true;
        return give;
      });
      await new Promise((r) => setTimeout(r, 120));
      expect(got).toBe(false);
      release();
      const give = await waiting;
      expect(got).toBe(true);
      give();
    });

    it("and is refused when it is not, by a sentence that says how long it waited", async () => {
      const first = server();
      const second = server();
      const release = await first.claim();
      const t0 = performance.now();
      const refusal = await second.claim(60).catch((error: unknown) => error);
      expect(performance.now() - t0).toBeGreaterThanOrEqual(55);
      expect(refusal).toBeInstanceOf(IndexRunningError);
      expect((refusal as IndexRunningError).message).toBe(RUNNING("0.06 s"));
      expect((refusal as IndexRunningError).waitedMs).toBe(60);
      // Not waited for at all, when the caller will not wait.
      await expect(second.claim(0)).rejects.toThrowError(RUNNING("0 s"));
      release();
      (await second.claim(0))();
    });

    it("the same store is refused as another is: two runs in one server", async () => {
      const s = server();
      const release = await s.claim();
      await expect(s.claim(0)).rejects.toBeInstanceOf(IndexRunningError);
      release();
      // Given back twice is given back once.
      release();
      const again = await s.claim(0);
      await expect(s.claim(0)).rejects.toBeInstanceOf(IndexRunningError);
      again();
    });

    it("a store in memory is held the same way", async () => {
      const s = store();
      const release = await s.claim();
      await expect(s.claim(30)).rejects.toThrowError(RUNNING("0.03 s"));
      release();
      const again = await s.claim(0);
      // Given back twice is given back once, here too.
      release();
      await expect(s.claim(0)).rejects.toBeInstanceOf(IndexRunningError);
      again();
      (await s.claim(0))();
      s.close();
    });

    it("keeps nobody from reading, or from a single write", async () => {
      const running = server();
      const other = server();
      const release = await running.claim();
      other.setMeta(meta);
      other.upsert([row("a", vec(1, 0))]);
      expect(ids(running)).toEqual(["a"]);
      other.remove(["a"]);
      expect(running.size()).toBe(0);
      release();
    });

    it("is a lock on an empty file beside the index, which no look makes", async () => {
      const s = server();
      s.getMeta();
      s.search(vec(1, 0));
      s.remove(["a"]);
      expect(readdirSync(dir)).toEqual([]);

      const release = await s.claim();
      // No journal beside it while it is held, and no index yet: a run that
      // stops before its first write leaves the lock file and nothing else.
      expect(readdirSync(dir)).toEqual([lockFile()]);
      release();
      expect(readdirSync(dir)).toEqual([lockFile()]);
      expect(statSync(join(dir, lockFile())).size).toBe(0);
    });

    it("is given back by a process that is killed while it holds it", async () => {
      const s = server();
      // What `claim` sends, from a process that then never lets go.
      const other = otherProcess(
        `import { DatabaseSync } from "node:sqlite";
         const lock = new DatabaseSync(process.argv.at(-1));
         lock.exec("PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE");
         console.log("ready");
         setInterval(() => {}, 1000);`,
        `${path()}.lock`,
      );
      await other.ready;
      await expect(s.claim(60)).rejects.toBeInstanceOf(IndexRunningError);
      other.child.kill("SIGKILL");
      await other.gone;
      (await s.claim(0))();
      expect(readdirSync(dir)).toEqual([lockFile()]);
    });

    it("stays held, for another process too, when a second run in the holder's own process is refused", async () => {
      // A process that closes any descriptor of a file drops every lock it
      // has on that file: POSIX. A refused claim opens the lock file and
      // closes it again, in the process that holds it.
      const s = server();
      const release = await s.claim();
      for (let i = 0; i < 3; i += 1) {
        await expect(s.claim(0)).rejects.toBeInstanceOf(IndexRunningError);
        await expect(server().claim(0)).rejects.toBeInstanceOf(IndexRunningError);
      }
      const tried = (): Promise<string> => {
        const other = otherProcess(
          `import { DatabaseSync } from "node:sqlite";
           const lock = new DatabaseSync(process.argv.at(-1));
           try {
             lock.exec("PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE");
             console.log("taken");
           } catch (error) {
             console.log(error.message);
           }`,
          `${path()}.lock`,
        );
        return new Promise((resolve) =>
          other.child.stdout!.once("data", (said) => resolve(String(said).trim())),
        );
      };
      expect(await tried()).toBe("database is locked");
      release();
      expect(await tried()).toBe("taken");
    });

    it("the waits are what the messages say: two seconds for a write, ten for a run", () => {
      expect(BUSY_TIMEOUT_MS).toBe(2_000);
      expect(RUN_WAIT_MS).toBe(10_000);
      expect(new IndexBusyError("write", BUSY_TIMEOUT_MS, null).message).toContain(
        "had not let go of it after 2 s.",
      );
      expect(new IndexRunningError(RUN_WAIT_MS).message).toBe(RUNNING("10 s"));
    });
  });

  it("scanning 20,000 vectors in a file another store writes to costs under three times a bare scan, and reading them again under forty", TIMED, () => {
    // What a search now does besides the scan: it asks the file's version
    // every time, and reads the rows again after another store's write.
    const { rows, query } = realistic();
    const writer = server();
    writer.upsert(rows);
    const reader = server();
    reader.search(query, { limit: 10 }); // warm the cache
    bareScan(rows, query, 10); // and the yardstick

    let hits: SimilarityHit[] = [];
    const rounds = Array.from({ length: ROUNDS }, (_, round) => {
      writer.upsert([{ ...rows[0]!, name: `written ${round}` }]);
      const again = ms(() => {
        hits = reader.search(query, { limit: 10 });
      });
      // The rows were read again, or this is the time of something else.
      expect(hits.map((h) => h.name)).toContain(`written ${round}`);
      // The search after it finds nothing new in the file, in every round.
      const scan = ms(() => {
        hits = reader.search(query, { limit: 10 });
      });
      expect(hits).toHaveLength(10);
      const yard = ms(() => {
        bareScan(rows, query, 10);
      });
      return { again, scan, yard };
    });

    // The scan, as in a store that has its index to itself: 1.0 at the most
    // on a performance core left alone, 1.2 under any load tried. Reading
    // the rows again for every search made it 5.4–6.9, a query for every
    // row 3.9–11.
    expect(least(rounds, (r) => r.scan / r.yard)).toBeLessThan(3);
    // Reading the rows again: 5–7 bare scans on a performance core left
    // alone, 11 at the most under any load tried. Read a hundred rows at a
    // time by OFFSET it was 55–72. Read one statement a row it was 9–17,
    // which this does not tell from a busy moment.
    expect(least(rounds, (r) => r.again / r.yard)).toBeLessThan(40);
  });
});
