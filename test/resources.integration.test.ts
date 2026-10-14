/**
 * Contract tests for the resource layer against a live TheBrain.
 *
 * THESE TESTS WRITE TO A BRAIN. They create thoughts prefixed `zz-it-` and
 * clean up after themselves, but a mid-run failure can leave debris behind.
 *
 * The brain is therefore named explicitly and never guessed: falling back to
 * the active brain is dangerous, since a developer may not notice that a real
 * working tab is open.
 *
 * The alias tests also change the brain itself: per the spec, saving the first
 * alias in a brain makes it require TheBrain 15.0.621 or later on every device.
 * One more reason for the brain to be a throwaway.
 *
 *   THEBRAIN_API_KEY=...  THEBRAIN_TEST_BRAIN_ID=<uuid of a throwaway brain> \
 *     npx vitest run test/resources.integration.test.ts
 *
 * Missing either variable skips the suite.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi, type TestContext } from "vitest";

import {
  EntityType,
  LinkMeaning,
  MAX_ALIASES,
  ModType,
  Relation,
  TheBrainApi,
  TheBrainError,
  ThoughtKind,
  aliasesOf,
  compareLogTime,
  isTagLink,
  isTypeLink,
  isUuid,
  linkNameAsStored,
  linksOfPair,
  logEntryKey,
  logTime,
  mayHaveLanded,
  nameRefusal,
  noteAsStored,
  noteLinesDropped,
  replayThoughtIds,
  thoughtNameAsStored,
  type CleanGraph,
  type LinkDto,
  type ModificationLogDto,
  type NotesDto,
  type SearchResultDto,
  type ThoughtDto,
  type ThoughtGraphDto,
} from "../src/api/index.js";
import {
  LOG_NAME_LIMIT,
  describeChange,
  loggedThoughts,
  subjectIds,
} from "../src/operations/changes.js";
import {
  IngestMissingError,
  IngestValidationError,
  ingest,
  linkFound,
} from "../src/operations/ingest.js";
import { buildDocument, indexModelId } from "../src/semantic/document.js";
import type { Embedder } from "../src/semantic/embedder.js";
import {
  SemanticIndexer,
  isNoteMod,
  linkEndIds,
  logThoughtId,
  neighbourIds,
} from "../src/semantic/indexer.js";
import { SemanticSearch } from "../src/semantic/search.js";
import { VectorStore } from "../src/semantic/store.js";
import { linkedIn, roundsApart, sweepFrom, sweepTargets } from "./sweep.js";

const apiKey = process.env["THEBRAIN_API_KEY"];
const testBrainId = process.env["THEBRAIN_TEST_BRAIN_ID"];
const suite = apiKey && testBrainId ? describe : describe.skip;
const PREFIX = "zz-it-";

/** Above this count the brain is treated as real work and left untouched. */
const MAX_THOUGHTS_IN_TEST_BRAIN = 500;

/**
 * Writes are not instantly visible. Measured against the live API:
 *   create -> get(id)        instant
 *   rename -> get            ~0.1 s
 *   set note -> get note     ~0.2 s
 *   create -> findByName     ~5.6 s  (!)
 * So after a write we address thoughts by identifier, never by name.
 */
const settle = (ms = 1200): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Waits until a condition holds, instead of sleeping a fixed amount. */
async function eventually<T>(
  probe: () => Promise<T>,
  ok: (value: T) => boolean,
  { timeoutMs = 12_000, stepMs = 150 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await probe();
  while (!ok(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs));
    last = await probe();
  }
  return last;
}

/** `t` moved by `delta` microseconds, still offsetless, as the log writes it. */
function shiftMicros(t: string, delta: number): string {
  const [whole = "", fraction = ""] = t.split(".");
  const micros =
    Date.parse(`${whole}Z`) * 1000 + Number(fraction.padEnd(6, "0").slice(0, 6)) + delta;
  const seconds = Math.floor(micros / 1_000_000);
  const rest = micros - seconds * 1_000_000;
  return `${new Date(seconds * 1000).toISOString().slice(0, 19)}.${String(rest).padStart(6, "0")}`;
}

/**
 * Unicode's `White_Space`, all 25 code points of it: what the API drops at the
 * ends of a thought's name and of a link's.
 */
const WHITE_SPACE = [
  0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
].map((cp) => String.fromCodePoint(cp));

suite("resource layer against the live API", () => {
  let api: TheBrainApi;
  let brainId: string;
  const created: string[] = [];

  const make = async (name: string, kind: number = ThoughtKind.Normal): Promise<string> => {
    const id = await api.thoughts.create(brainId, { name: PREFIX + name, kind });
    created.push(id);
    return id;
  };

  /**
   * A create that is one of many sent at once, or null when it was answered
   * with the API's catch-all 403.
   *
   * With the app busy, one create in a burst is now and then answered so:
   * one in 100 in three bursts of five while four writers were at work in
   * another brain, and in none of three bursts with the app to itself. The
   * thought is made all the same: the log had a `101` for every request of
   * each of those bursts, the refused one included (4 of 4). So the client
   * takes that 403 to a write for one that may have been carried out
   * (`mayHaveLanded()`, docs/api-map.md, L45), and this asks it so: a client
   * that took it for a refusal again fails here. A test that needs a burst
   * is about what the burst leaves, and used to go red on it whenever a
   * second session was at work. So it is counted and said aloud here, and
   * the thought, which nothing has the identifier of, is left to the sweep
   * after the run. Any other failure is thrown as it came.
   */
  let unanswered = 0;
  const makeInBurst = async (name: string): Promise<string | null> => {
    try {
      return await make(name);
    } catch (error) {
      if (!(error instanceof TheBrainError) || error.kind !== "forbidden") throw error;
      if (!mayHaveLanded(error)) throw error;
      unanswered += 1;
      console.warn(
        `[burst] the create of ${PREFIX}${name} was answered with the catch-all 403: ` +
          `${error.status} ${JSON.stringify(error.body)}`,
      );
      return null;
    }
  };
  /** Thoughts created at once: the identifiers of those whose create was answered. */
  const makeAtOnce = async (names: readonly string[]): Promise<string[]> =>
    (await Promise.all(names.map(makeInBurst))).filter((id) => id !== null);

  /**
   * A minute before this run made its first request. Every entry a test
   * looks for in the log is later, since it is the test that wrote it.
   */
  const runStart = new Date(Date.now() - 60_000).toISOString();

  /**
   * The starts of the runs against this brain that have not swept up after
   * themselves, this one among them until it has. A file outside the
   * repository, one for each brain, so that the run after one that died
   * sweeps for it.
   */
  const ledger = (): string => join(tmpdir(), `thebrain-mcp-contract-${brainId}.json`);
  const unswept = (): string[] => {
    try {
      const starts: unknown = JSON.parse(readFileSync(ledger(), "utf8"));
      return Array.isArray(starts) ? starts.filter((s): s is string => typeof s === "string") : [];
    } catch {
      return [];
    }
  };
  const record = (starts: readonly string[]): void => {
    if (starts.length === 0) rmSync(ledger(), { force: true });
    else writeFileSync(ledger(), JSON.stringify(starts));
  };
  const earliest = (starts: readonly string[]): string =>
    starts.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));

  /**
   * Where this run's sweep starts: past the newest entry the brain logged
   * before the run's first write (`sweepFrom()`). The run's own start in the
   * ledger. Not `runStart`, a minute earlier, which took in the home thought
   * of a brain made in that minute.
   */
  let madeFrom = runStart;
  /** The newest entry the brain logged before this run wrote anything. */
  let before: ModificationLogDto | undefined;
  /** The brain's home thought, which no sweep deletes. */
  let home = "";

  /**
   * How long a thought is left after a thought it shares a link with is
   * deleted, and after the run's last write, before it is deleted itself.
   *
   * A thought deleted soon after a neighbour of its own now and then stays in
   * TheBrain's search for good: its read is a 404, and the search returns it
   * hours on (L34). The sweep deleted the thoughts of a run one after another,
   * a parent a few milliseconds before its children and a type before its
   * instances. On the test brain of a release check it left nine, each from
   * a sweep that ran slow beside other work in the app, each deleted 13 to
   * 215 ms after a neighbour; sweeps the app had to itself left none in
   * eight. BRMCP-47 had none of 720 deleted 120 to 330 ms after one; a
   * second is that with room for a busy app. It costs a run four to five
   * seconds: a round of every thought no two of which share a link, a
   * second round of some 200, and two or three of a few. Measured on two
   * runs of 2026-10-14: the sweep took 16 and 17 s for 770 and 1,040
   * deletes, where it had taken 11 s for 1,040 one after another, and the
   * search for `zz-it` after each had nothing that was gone.
   */
  const APART_MS = 1000;

  /**
   * Deletes those of `ids` that are still there, so that none goes within
   * `APART_MS` of a thought it shares a link with by `near`, nor of the
   * write before the call. Answers what it deleted, and how many deletes
   * failed.
   *
   * In rounds (`roundsApart()`), each one after another, `APART_MS` after
   * the round before. A parent and its children, a type and its instances, a
   * tag and what it is on go in two rounds, whichever is first, and the
   * first is never at risk: no neighbour of its own has been deleted.
   */
  const deleteApart = async (
    ids: Iterable<string>,
    near: ReadonlyMap<string, ReadonlySet<string>>,
  ): Promise<{ deleted: string[]; failed: number }> => {
    const there: string[] = [];
    for (const id of new Set(ids)) {
      if ((await api.thoughts.get(brainId, id).catch(() => null)) !== null) there.push(id);
    }
    const deleted: string[] = [];
    let failed = 0;
    for (const round of roundsApart(there, near)) {
      await settle(APART_MS);
      for (const id of round) {
        await api.thoughts.delete(brainId, id).then(
          () => deleted.push(id),
          () => (failed += 1),
        );
      }
    }
    return { deleted, failed };
  };

  /**
   * Deletes every thought the log has as created since `since` and not
   * deleted, whatever it is called, with `also` beside them, and answers
   * what it deleted and how many deletes failed. Never the home thought.
   *
   * By identifier, from the log, and not by name. A test renames a thought
   * to `ZZ-IT-…`, and makes names and types of characters that do not show,
   * none of which a prefix finds; and a create answered with the catch-all
   * 403 in a burst makes its thought with no identifier given back (4 of 4).
   * All of it is in the log, and in a throwaway brain everything made while
   * a run is on is the run's.
   */
  const sweepSince = async (
    since: string,
    also: readonly string[] = [],
  ): Promise<{ deleted: string[]; failed: number }> => {
    const logs = await api.brains.allModifications(brainId, { since });
    return deleteApart(sweepTargets(logs, also, home), linkedIn(logs));
  };

  /**
   * Whether a name is one these tests give, the way the API compares the
   * name of a tag: letter case, what does not show and the form of a
   * character set aside (L39). A create of a tag under such a name answers
   * with the tag that is there, in whatever state an earlier run left it.
   */
  const ours = (name: string | null): boolean =>
    (name ?? "")
      .normalize("NFKC")
      .replace(/[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cc}]/gu, "")
      .toLowerCase()
      .startsWith(PREFIX);

  /**
   * The newest `maxLogs` entries of this run.
   *
   * With a `startTime`, because a log request without one is answered in
   * time that goes by the length of the whole log, however few entries it
   * asks for. Measured on two brains with logs of 165,000 and 171,000
   * entries: the newest 50 took 135 ms with no bound and 15 ms from an hour
   * back, and the newest one 45 ms. A test brain's log only grows, by about
   * 2,800 entries a run, and these reads are polled. Bounded so, with the
   * index a test fills from its own start and the truncation test reading
   * no more than its four creates, the tests both versions have took 208 s
   * where they took 247 s on one such brain, and 194 s where they took 234
   * on the other.
   */
  const newestLogs = (maxLogs: number): Promise<ModificationLogDto[]> =>
    api.brains.modifications(brainId, { maxLogs, since: runStart });

  /**
   * An index of what the brain has logged since a little before `since`,
   * and of nothing older: for a test that needs the rows of the thoughts it
   * has just made, and says nothing of a rebuild. `since` is taken before
   * the test's first write.
   *
   * A rebuild reads the whole log and walks the whole brain, 3.5 s for the
   * log alone at 170,000 entries, and five tests ran one to get three rows.
   * Here the index starts empty with a watermark, so the sync that fills it
   * reads the log from there.
   *
   * The watermark is a quarter of a minute before `since`, not at it. A sync
   * leaves its own ten seconds before its start (`SYNC_OVERLAP_MS`), so the
   * test's next sync reads what the tests before this one logged in those
   * seconds. Indexed here, those thoughts are skipped by their hash then;
   * left out, they were encoded as new among what the test counts.
   */
  const indexedSince = async (
    since: string,
    embedder: Embedder,
  ): Promise<{ store: VectorStore; indexer: SemanticIndexer }> => {
    const store = new VectorStore(":memory:");
    store.setMeta({
      brainId,
      model: indexModelId(embedder.id),
      dimensions: embedder.dimensions,
      syncedThrough: new Date(Date.parse(since) - 15_000).toISOString(),
    });
    const indexer = new SemanticIndexer(api, store, embedder);
    const filled = await indexer.sync(brainId);
    expect(filled).toMatchObject({ ran: "sync", unread: [] });
    return { store, indexer };
  };

  /**
   * Leaves an index as one synced after everything the brain has logged so
   * far, so that its next sync hears of nothing older.
   *
   * A sync leaves its watermark ten seconds before its own start, and a
   * test's thoughts are seconds old: their `101` is in what the next sync
   * reads, and each is read again for that, whatever else the log says of
   * it. With a sync that passed over every label, type, kind and note entry,
   * three tests of what a sync reads a thought again for still passed. A
   * test that is about one entry calls this before the write that logs it.
   * One that is about the ten seconds does not.
   */
  const caughtUp = async (store: VectorStore): Promise<void> => {
    const [newest] = await newestLogs(1);
    store.setSyncedThrough(shiftMicros(logTime(newest!), 1));
  };

  beforeAll(async () => {
    if (!isUuid(testBrainId!)) {
      throw new Error(
        `THEBRAIN_TEST_BRAIN_ID must be a UUID, got ${JSON.stringify(testBrainId)}`,
      );
    }
    api = new TheBrainApi({ apiKey: apiKey! });
    brainId = testBrainId!;

    // Second seatbelt: the brain must exist and be small. If someone pointed
    // these tests at a real working brain, they refuse to touch it.
    //
    // `statistics.thoughts` was right at the first read after every write
    // measured: 19 creates, 19 deletes, eight bursts of 30 and of 100, and
    // eight sweeps of 100 to 350 deleted one after another, which is what
    // the run before this one ends with. It is asked again for five seconds
    // all the same before the run is refused. Two other counts of the same
    // answer are seconds behind a write (L41), and what waiting costs is
    // five seconds for a brain that is over the limit and stays over it.
    const stats = await eventually(
      () => api.brains.statistics(brainId),
      (s) => s.thoughts <= MAX_THOUGHTS_IN_TEST_BRAIN,
      { timeoutMs: 5_000, stepMs: 500 },
    );
    if (stats.thoughts > MAX_THOUGHTS_IN_TEST_BRAIN) {
      throw new Error(
        `brain "${stats.brainName}" holds ${stats.thoughts} thoughts, which does ` +
          `not look like a throwaway test brain. These tests write, so refusing. ` +
          `Create a separate brain and point THEBRAIN_TEST_BRAIN_ID at it.`,
      );
    }

    // Where this run's sweep will start, before it writes anything.
    home = (await api.brains.get(brainId)).homeThoughtId;
    [before] = await newestLogs(1);
    madeFrom = sweepFrom(before, runStart);

    // What an earlier run left, before this one makes anything. A run that
    // died has its start in the ledger still, and everything made since is
    // deleted. Left, a tag an earlier run made would be what this run's
    // create of one of that name answers with (L39), in the state it was
    // left in.
    const earlier = unswept();
    record([...earlier, madeFrom]);
    if (earlier.length > 0) {
      const { deleted, failed } = await sweepSince(earliest(earlier));
      console.warn(
        `[cleanup] ${earlier.length} earlier run(s) had not swept up: ${deleted.length} thoughts ` +
          `deleted${failed > 0 ? `, ${failed} deletes failed` : ""}`,
      );
      if (failed === 0) record([madeFrom]);
    }
    // And the tags and types of runs from before there was a ledger, by name.
    // The two lists are copies (L39): one just deleted above can be listed
    // still, and its second delete is a 200 that does nothing. What links
    // them is not known here, so each goes apart from the one before.
    const vocabulary = [
      ...(await api.thoughts.listTags(brainId)),
      ...(await api.thoughts.listTypes(brainId)),
    ].filter((t) => ours(t.name));
    for (const t of vocabulary) {
      await settle(APART_MS);
      await api.thoughts.delete(brainId, t.id);
    }
    if (vocabulary.length > 0) {
      console.warn(`[cleanup] tags and types an earlier run left: ${vocabulary.length}`);
    }
  }, 120_000);

  // The sweep is as long as the run made thoughts: some 850 deletes, 7 s
  // when the app has nothing else to do and 47 s when another session is at
  // it, which with the read of the log was more than the minute it had.
  afterAll(async () => {
    // Everything this run made that is still there: what it holds the
    // identifier of, and by the log a thought made by a create that got no
    // answer, or by a tool a test ran. From the earliest start in the ledger,
    // which is this run's unless an earlier one could not sweep. Taken off it
    // only when every delete went. Not by the log when another run against
    // this brain began after this one: it may be on still, and what it made
    // would go with this run's.
    const starts = unswept();
    if (starts.some((s) => Date.parse(s) > Date.parse(madeFrom))) {
      console.warn("[cleanup] a later run against this brain is in the ledger: no sweep by the log");
      const logs = await api.brains.allModifications(brainId, { since: madeFrom });
      await deleteApart(sweepTargets([], created, home), linkedIn(logs));
    } else {
      const { deleted, failed } = await sweepSince(earliest([...starts, madeFrom]), created);
      const ownIds = new Set(created);
      const strays = deleted.filter((id) => !ownIds.has(id)).length;
      if (strays + failed > 0) {
        console.warn(
          `[cleanup] thoughts this run made that no test deleted: ${strays}` +
            (failed > 0 ? `, ${failed} deletes failed and stay in the ledger` : ""),
        );
      }
      if (failed === 0) record([]);
    }

    // And debris from runs before the ledger, or from another machine, by
    // name: the name a thought was made with, which its `101` keeps (L37),
    // or the one it has, in the API's way of comparing them. All of the log,
    // since such a run may be any run: one read of it, 3.5 s at 170,000
    // entries, outside every test's own time.
    const logs = await api.brains.allModifications(brainId);
    const madeAs = new Map(
      logs
        .filter((l) => l.modType === ModType.Created && l.sourceType === EntityType.Thought)
        .map((l) => [l.sourceId, l.newValue]),
    );
    const leftovers: string[] = [];
    for (const id of replayThoughtIds(logs)) {
      const t = await api.thoughts.get(brainId, id).catch(() => null);
      if (t !== null && (ours(t.name) || ours(madeAs.get(id) ?? null))) leftovers.push(id);
    }
    if (leftovers.length > 0) {
      await deleteApart(sweepTargets([], leftovers, home), linkedIn(logs));
      console.warn(`[cleanup] removed leftovers from earlier runs: ${leftovers.length}`);
    }
  }, 300_000);

  it("a brain with no types, tags or pins answers each list with a 400 in words of its own, which the resources read as an empty list", async (ctx) => {
    // First in the file, while this run has made no type and no tag: a
    // throwaway brain at rest has none. Measured on TheBrain 15.0.640, 5 of 5
    // for each answer (docs/api-map.md, L1). `emptyOn400()` takes these three
    // sentences for an empty list and no other 400.
    type Refused = { status: number | undefined; said: string };
    const raw = (list: string): Promise<ThoughtDto[] | Refused> =>
      api.client.get<ThoughtDto[]>(`/api/thoughts/${brainId}/${list}`).catch((e: unknown) => {
        if (e instanceof TheBrainError) return { status: e.status, said: e.message };
        throw e;
      });
    const NONE = {
      types: { status: 400, said: `Could not retrieve list of Types for brain ${brainId}` },
      tags: { status: 400, said: `Could not retrieve list of Tags for brain ${brainId}` },
      pins: { status: 400, said: `Failed to get pins for brain ${brainId}` },
    };
    const [types, tags] = [await raw("types"), await raw("tags")];
    if (Array.isArray(types) || Array.isArray(tags)) {
      // A list that is there is never an empty one.
      for (const list of [types, tags]) if (Array.isArray(list)) expect(list.length).toBeGreaterThan(0);
      ctx.skip("the brain holds a type or a tag an earlier run left: the sweep after this run takes it");
    }
    expect(types).toEqual(NONE.types);
    expect(tags).toEqual(NONE.tags);
    expect(await api.thoughts.listTypes(brainId)).toEqual([]);
    expect(await api.thoughts.listTags(brainId)).toEqual([]);

    // With one of each, the same requests are a 200 and a list...
    const typeId = await api.thoughts.create(brainId, { name: `${PREFIX}only-type`, kind: ThoughtKind.Type });
    const tagId = await api.thoughts.create(brainId, { name: `${PREFIX}only-tag`, kind: ThoughtKind.Tag });
    created.push(typeId, tagId);
    const listed = async (): Promise<string[][]> => [
      (await api.thoughts.listTypes(brainId)).map((t) => t.id),
      (await api.thoughts.listTags(brainId)).map((t) => t.id),
    ];
    expect(await eventually(listed, ([a, b]) => a!.length > 0 && b!.length > 0)).toEqual([
      [typeId],
      [tagId],
    ]);
    // ...and the 400 again once the last one is deleted: 2 to 3 ms after.
    await api.thoughts.delete(brainId, typeId);
    await settle(350);
    await api.thoughts.delete(brainId, tagId);
    expect(await eventually(() => raw("types"), (r) => !Array.isArray(r))).toEqual(NONE.types);
    expect(await eventually(() => raw("tags"), (r) => !Array.isArray(r))).toEqual(NONE.tags);

    // Pins: a brain's home thought is pinned, so they are taken off and put back.
    const pinned = await api.thoughts.listPinned(brainId);
    try {
      for (const t of pinned) await api.thoughts.unpin(brainId, t.id);
      expect(await eventually(() => raw("pins"), (r) => !Array.isArray(r))).toEqual(NONE.pins);
      expect(await api.thoughts.listPinned(brainId)).toEqual([]);
    } finally {
      for (const t of pinned) await api.thoughts.pin(brainId, t.id);
    }
    const back = await eventually(
      () => api.thoughts.listPinned(brainId),
      (list) => list.length === pinned.length,
    );
    expect(back.map((t) => t.id).sort()).toEqual(pinned.map((t) => t.id).sort());

    // What does fail is told apart by its status, and is no empty list: a
    // brainId that is no brain. No failure that answers 400 could be produced.
    const noBrain = crypto.randomUUID();
    for (const list of [
      () => api.thoughts.listTypes(noBrain),
      () => api.thoughts.listTags(noBrain),
      () => api.thoughts.listPinned(noBrain),
    ]) {
      await expect(list()).rejects.toMatchObject({ kind: "unknown_brain", status: 401 });
    }
  }, 30_000);

  it("the sweep after this run starts past everything the brain logged before it, and passes over the home thought", async () => {
    // It used to start a minute before the run's first request. A brain made
    // in that minute had its home thought's `101` in the window, and two
    // sweeps deleted two home thoughts on 2026-10-14; anything else written
    // in that minute went the same way. Read-only: what the window holds now.
    const window = await api.brains.allModifications(brainId, { since: madeFrom });
    if (before !== undefined) {
      expect(window.map(logEntryKey)).not.toContain(logEntryKey(before));
      for (const l of window) expect(compareLogTime(logTime(l), logTime(before))).toBeGreaterThan(0);
    }
    expect([...replayThoughtIds(window)]).not.toContain(home);
    expect(sweepTargets(window, [home, ...created], home)).not.toContain(home);
  });

  it("a freshly created thought reads back immediately by identifier", async () => {
    const id = await make("basic");
    const t = await api.thoughts.get(brainId, id);
    expect(t.id).toBe(id);
    expect(t.name).toBe(`${PREFIX}basic`);
  });

  it("an update via flat fields lands", async () => {
    const id = await make("to-edit");
    await api.thoughts.update(brainId, id, {
      name: `${PREFIX}renamed`,
      foregroundColor: "#ff7145",
    });
    // Wait for both fields, not just the name: they land a moment apart, and
    // waiting on one while asserting the other is a race the test used to lose.
    const after = await eventually(
      () => api.thoughts.get(brainId, id),
      (t) => t.name === `${PREFIX}renamed` && t.foregroundColor === "#ff7145",
    );
    expect(after.name).toBe(`${PREFIX}renamed`);
    expect(after.foregroundColor).toBe("#ff7145");
  });

  it(
    "findByName catches up with creation, but not instantly — about 5 seconds",
    async () => {
      const name = `${PREFIX}by-name-${Date.now()}`;
      const id = await api.thoughts.create(brainId, { name });
      created.push(id);

      // Immediately after creation, name lookup cannot see the thought yet.
      expect(await api.thoughts.findByName(brainId, name)).toBeNull();

      const found = await eventually(
        () => api.thoughts.findByName(brainId, name),
        (t) => t !== null,
      );
      expect(found?.id).toBe(id);
    },
    20_000,
  );

  it("a nonexistent name yields null rather than an exception", async () => {
    await expect(
      api.thoughts.findByName(brainId, `${PREFIX}definitely-absent-12345`),
    ).resolves.toBeNull();
  });

  it("the type does not appear among the graph parents", async () => {
    const typeId = await make("Type", ThoughtKind.Type);
    const id = await make("typed");
    await api.thoughts.update(brainId, id, { typeId });
    await settle();

    const graph = await api.thoughts.getGraph(brainId, id);
    expect(graph.type?.id).toBe(typeId);
    expect(graph.parents.map((p) => p.id)).not.toContain(typeId);
  });

  it("a tag is attached, read back and removed", async () => {
    const tagId = await make("tag", ThoughtKind.Tag);
    const id = await make("tagged");

    await api.links.attachTag(brainId, id, tagId);
    await settle();
    const withTag = await api.thoughts.getGraph(brainId, id);
    expect(withTag.tags.map((t) => t.id)).toContain(tagId);
    // A tag must not be mixed in with ordinary parents.
    expect(withTag.parents.map((p) => p.id)).not.toContain(tagId);

    const removed = await api.links.detachTag(brainId, id, tagId);
    expect(removed).toBe(true);
    await settle();
    const without = await api.thoughts.getGraph(brainId, id);
    expect(without.tags.map((t) => t.id)).not.toContain(tagId);
  });

  it("a tag's graph lists the thoughts it marks as children", async () => {
    // The indexer's graph walk relies on this to reach thoughts whose only
    // connection is a shared tag.
    const tagId = await make("walk-tag", ThoughtKind.Tag);
    const id = await make("walk-tagged");
    await api.links.attachTag(brainId, id, tagId);

    const tagGraph = await eventually(
      () => api.thoughts.getGraph(brainId, tagId),
      (g) => g.children.some((c) => c.id === id),
    );
    expect(tagGraph.children.map((c) => c.id)).toContain(id);
    expect(neighbourIds(tagGraph)).toContain(id);
  }, 30_000);

  it("a type's graph lists its instances", async () => {
    // The walk reaches thoughts whose only connection is a shared type through
    // this. A measurement on a real brain once claimed the opposite; this test
    // settled it.
    const typeId = await make("walk-type", ThoughtKind.Type);
    const id = await make("walk-typed");
    await api.thoughts.update(brainId, id, { typeId });

    const graph = await eventually(
      () => api.thoughts.getGraph(brainId, id),
      (g) => g.type?.id === typeId,
    );
    expect(neighbourIds(graph)).toContain(typeId);

    const typeGraph = await eventually(
      () => api.thoughts.getGraph(brainId, typeId),
      (g) => neighbourIds(g).includes(id),
    );
    expect(neighbourIds(typeGraph)).toContain(id);
    // `children`, as with a tag; a failure shows all four lists.
    const holds = (list: readonly { id: string }[]): boolean => list.some((t) => t.id === id);
    expect({
      parents: holds(typeGraph.parents),
      children: holds(typeGraph.children),
      jumps: holds(typeGraph.jumps),
      tags: holds(typeGraph.tags),
    }).toEqual({ parents: false, children: true, jumps: false, tags: false });
  }, 30_000);

  it("every thought a graph lists or a search finds carries its kind, and each a graph lists its aliases as a list", async () => {
    // The read tools mark a type or a tag from this, at no request of their
    // own: a list that came without kinds would pass both off as ordinary.
    const stamp = `kind${Date.now()}`;
    const typeId = await make(`${stamp} type`, ThoughtKind.Type);
    const tagId = await make(`${stamp} tag`, ThoughtKind.Tag);
    const strayTypeId = await make(`${stamp} stray type`, ThoughtKind.Type);
    const strayTagId = await make(`${stamp} stray tag`, ThoughtKind.Tag);
    const parentId = await make(`${stamp} parent`);
    const id = await api.thoughts.create(brainId, {
      name: `${PREFIX}${stamp} plain`,
      sourceThoughtId: parentId,
      typeId,
    });
    created.push(id);
    await api.links.attachTag(brainId, id, tagId);
    // Ordinary links both: a type put under a thought, and a jump to a tag.
    await api.links.create(brainId, {
      thoughtIdA: parentId,
      thoughtIdB: strayTypeId,
      relation: Relation.Child,
    });
    await api.links.create(brainId, {
      thoughtIdA: id,
      thoughtIdB: strayTagId,
      relation: Relation.Jump,
    });

    const kinds = (list: readonly ThoughtDto[]): Record<string, number> =>
      Object.fromEntries(list.map((t) => [t.id, t.kind]));
    const graph = await eventually(
      () => api.thoughts.getGraph(brainId, id, { includeSiblings: true }),
      (g) => g.tags.length === 1 && g.jumps.length === 1 && g.siblings.length === 1,
    );
    expect(graph.thought.kind).toBe(ThoughtKind.Normal);
    expect(graph.type?.kind).toBe(ThoughtKind.Type);
    expect(kinds(graph.tags)).toEqual({ [tagId]: ThoughtKind.Tag });
    expect(kinds(graph.parents)).toEqual({ [parentId]: ThoughtKind.Normal });
    expect(kinds(graph.jumps)).toEqual({ [strayTagId]: ThoughtKind.Tag });
    expect(kinds(graph.siblings)).toEqual({ [strayTypeId]: ThoughtKind.Type });
    const above = await api.thoughts.getGraph(brainId, parentId);
    expect(kinds(above.children)).toEqual({
      [id]: ThoughtKind.Normal,
      [strayTypeId]: ThoughtKind.Type,
    });
    // And its aliases, as a list: `[]` where there are none, never null and
    // never absent. Builds before 15.0.621 have no aliases and send no field.
    // The read-only suite checks the home thought, which in a throwaway brain
    // has nothing around it.
    if ("aliases" in graph.thought) {
      const listed = [graph.thought, graph.type!, ...graph.tags, ...graph.parents];
      listed.push(...graph.jumps, ...graph.siblings, ...above.children);
      for (const t of listed) expect(t.aliases, t.id).toEqual([]);
    }

    // TheBrain's own search, which is what brain_search runs on with no index.
    const wanted = [typeId, tagId, id];
    const hits = await eventually(
      () => api.search.inBrain(brainId, PREFIX + stamp, { maxResults: 20 }),
      (found) => wanted.every((want) => found.some((h) => h.thought.id === want)),
      { timeoutMs: 25_000, stepMs: 500 },
    );
    const found = kinds(hits.map((h) => h.thought));
    expect(found[typeId]).toBe(ThoughtKind.Type);
    expect(found[tagId]).toBe(ThoughtKind.Tag);
    expect(found[id]).toBe(ThoughtKind.Normal);
  }, 40_000);

  it("every thought a graph lists, and every type and tag the brain lists, carries its label", async () => {
    // brain_get_thought prints a neighbour's label, and brain_list_types_and_tags
    // a type's and a tag's, from this, at no request of their own.
    const stamp = `label${Date.now()}`;
    const labelled = async (
      name: string,
      label: string,
      under: { sourceThoughtId: string; relation?: Relation; typeId?: string },
    ): Promise<string> => {
      const made = await api.thoughts.create(brainId, {
        name: `${PREFIX}${stamp} ${name}`,
        label,
        ...under,
      });
      created.push(made);
      return made;
    };
    // A type renamed: the label is the name it was made under (L38). Given
    // in the create, which waits for no read-back of the thought's own.
    const typeName = `${PREFIX}${stamp} type`;
    const typeId = await make(`${stamp} type`, ThoughtKind.Type);
    await api.thoughts.update(brainId, typeId, { name: `${typeName} renamed` });
    await eventually(
      () => api.thoughts.get(brainId, typeId),
      (t) => t.name === `${typeName} renamed`,
    );
    const parentId = await make(`${stamp} parent`);
    const id = await labelled("thought", "its caption", { sourceThoughtId: parentId, typeId });
    const childId = await labelled("child", "a child's caption", { sourceThoughtId: id });
    const siblingId = await labelled("sibling", "a sibling's caption", {
      sourceThoughtId: parentId,
    });
    const jumpId = await labelled("jump", "a jump's caption", {
      sourceThoughtId: id,
      relation: Relation.Jump,
    });
    // A tag is given no label, and takes one written to it.
    const tagId = await make(`${stamp} tag`, ThoughtKind.Tag);
    await api.thoughts.update(brainId, tagId, { label: "a tag's caption" });
    await api.links.attachTag(brainId, id, tagId);

    const labels = (list: readonly ThoughtDto[]): Record<string, string | null> =>
      Object.fromEntries(list.map((t) => [t.id, t.label]));
    const graph = await eventually(
      () => api.thoughts.getGraph(brainId, id, { includeSiblings: true }),
      (g) =>
        g.children.length === 1 &&
        g.jumps.length === 1 &&
        g.siblings.length === 1 &&
        g.tags[0]?.label === "a tag's caption" &&
        g.type?.name === `${typeName} renamed`,
      { timeoutMs: 20_000, stepMs: 250 },
    );
    expect(graph.thought.label).toBe("its caption");
    expect(labels(graph.parents)).toEqual({ [parentId]: null });
    expect(labels(graph.children)).toEqual({ [childId]: "a child's caption" });
    expect(labels(graph.jumps)).toEqual({ [jumpId]: "a jump's caption" });
    expect(labels(graph.siblings)).toEqual({ [siblingId]: "a sibling's caption" });
    expect(labels(graph.tags)).toEqual({ [tagId]: "a tag's caption" });
    expect(graph.type?.label).toBe(typeName);
    const above = await eventually(
      () => api.thoughts.getGraph(brainId, parentId),
      (g) => g.children.length === 2,
      { timeoutMs: 20_000, stepMs: 250 },
    );
    expect(labels(above.children)).toEqual({
      [id]: "its caption",
      [siblingId]: "a sibling's caption",
    });

    // The lists of the brain's vocabulary, a copy behind a write (L39), and
    // further behind with another session at work in TheBrain: in one full
    // run beside it, /types did not list the type within 12 s.
    const types = await eventually(
      () => api.thoughts.listTypes(brainId),
      (list) => list.some((t) => t.id === typeId && t.name === `${typeName} renamed`),
      { timeoutMs: 20_000, stepMs: 250 },
    );
    expect(types.find((t) => t.id === typeId)?.label).toBe(typeName);
    const tags = await eventually(
      () => api.thoughts.listTags(brainId),
      (list) => list.some((t) => t.id === tagId && t.label !== null),
      { timeoutMs: 20_000, stepMs: 250 },
    );
    expect(tags.find((t) => t.id === tagId)?.label).toBe("a tag's caption");
  }, 90_000);

  it("append creates the note when absent and extends it afterwards", async () => {
    const id = await make("with-note");

    await api.notes.append(brainId, id, "first part");
    const first = await eventually(
      () => api.notes.get(brainId, id),
      (t) => t.length > 0,
    );
    expect(first).toBe("first part");

    await api.notes.append(brainId, id, "second part");
    const both = await eventually(
      () => api.notes.get(brainId, id),
      (t) => t.includes("second"),
    );
    expect(both).toBe("first part\n\nsecond part");
  });

  it("a note is an attachment flagged isNotes, and the log keys it by that attachment", async () => {
    // This is what the semantic indexer relies on. It cost a real bug: note
    // events name the attachment in sourceId, so reading sourceId as the
    // thought silently kept every note out of the index.
    const id = await make("note-signal");

    const bare = await api.thoughts.getGraph(brainId, id);
    expect(bare.attachments.some((a) => a.isNotes)).toBe(false);

    await api.notes.set(brainId, id, "furniture hanging from the ceiling");
    const withNote = await eventually(
      () => api.thoughts.getGraph(brainId, id),
      (g) => g.attachments.some((a) => a.isNotes),
    );
    expect(withNote.attachments.some((a) => a.isNotes)).toBe(true);

    const logs = await eventually(
      () => newestLogs(200),
      (entries) => entries.some((l) => isNoteMod(l.modType) && l.extraAId === id),
    );
    const event = logs.find((l) => isNoteMod(l.modType) && l.extraAId === id);
    expect(event).toBeDefined();
    expect(event!.sourceType).toBe(4); // attachment, not thought
    expect(event!.sourceId).not.toBe(id);
    expect(event!.extraAType).toBe(2); // the thought lives here
    expect(logThoughtId(event!)).toBe(id);
    expect(subjectIds(event!)).toEqual([id]);
  }, 30_000);

  it("after a note is changed its graph lists no Notes attachment for a moment, while the note reads", async () => {
    // What the semantic indexer must not go by alone (docs/api-map.md, L32).
    // Measured on 15.0.640, the graph read about every 10 ms for 0.4 s after
    // each change: after 44 of 60 `update`s and 27 of 60 `append`s one read
    // listed no Notes attachment, 0 to 183 ms after the change, and the
    // thought's own attachment list had it each time. The note's read had the
    // new text at its first read 200 times of 200. Read at that moment, the
    // thought was indexed as one with no note.
    //
    // This asked for one such read in 25 changes, whatever the app was doing.
    // Measured again on 2026-10-14, 40 changes each: no read without the note
    // after 9 of them with the app to itself, and after 22 with another
    // contract run at work in it. So it changes the note until one change
    // shows the gap, and gives up at forty: were seven changes in ten to show
    // none, which nothing measured came near, all forty would be one run in
    // a million. Every change it makes still has to read back.
    const id = await make("note-graph-gap");
    await api.notes.set(brainId, id, "one");
    const listsNote = (g: { attachments: Array<{ isNotes: boolean }> }): boolean =>
      g.attachments.some((a) => a.isNotes);
    await eventually(() => api.thoughts.getGraph(brainId, id), listsNote);

    const TRIES = 40;
    const WATCH_MS = 250;
    let gap = -1;
    for (let i = 0; i < TRIES && gap < 0; i++) {
      await api.notes.set(brainId, id, `text ${i}`);
      const changed = performance.now();
      while (performance.now() - changed < WATCH_MS) {
        if (!listsNote(await api.thoughts.getGraph(brainId, id))) {
          gap = i;
          // The copy the graph answers from, not the thought: its own list has the note.
          const own = await api.attachments.ofThought(brainId, id);
          expect(own.some((a) => a.isNotes)).toBe(true);
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      // The note itself reads, with the text just written.
      const text = await eventually(
        () => api.notes.get(brainId, id),
        (t) => t === `text ${i}`,
        { stepMs: 20 },
      );
      expect(text).toBe(`text ${i}`);
      // And the graph lists it again once the moment has passed.
      const again = await eventually(() => api.thoughts.getGraph(brainId, id), listsNote, {
        stepMs: 20,
      });
      expect(listsNote(again)).toBe(true);
    }
    expect(
      gap,
      `the graph listed the note at every read after ${TRIES} changes of ${TRIES}: either the ` +
        "app was busy at every one of them, or the graph is no longer behind a note (L32)",
    ).toBeGreaterThanOrEqual(0);
  }, 60_000);

  describe("a run of note changes in the log", () => {
    // Measured on TheBrain 15.0.640: the log is not append-only. While a
    // note's 803 is the newest entry TheBrain has logged, the next change to
    // the note takes that entry out and files it again under the new time.
    // "Newest" counts every brain the app holds: an entry logged in another
    // brain ends the run as surely as one in this brain. So a run here can be
    // cut short by someone working in TheBrain meanwhile, and each test that
    // needs a whole run tries again when it was. The tests read no other
    // brain, so they do not see that entry: they check that this brain logged
    // nothing in between, which leaves only one elsewhere (L20).
    const ATTEMPTS = 8;

    const changesIn = (entries: ModificationLogDto[]): ModificationLogDto[] =>
      entries.filter((l) => l.modType === ModType.NoteChanged);

    /** The note entries about one thought since `since`, oldest first. */
    const noteLog = async (id: string, since: string): Promise<ModificationLogDto[]> =>
      (await api.brains.modifications(brainId, { maxLogs: 1000, since }))
        .filter((l) => isNoteMod(l.modType) && l.extraAId === id)
        .reverse();

    /** Writes, then returns the note entries once the newest 803 is later than `than`. */
    const afterChange = async (
      id: string,
      since: string,
      write: () => Promise<unknown>,
      than?: ModificationLogDto,
    ): Promise<ModificationLogDto[]> => {
      await write();
      return eventually(
        () => noteLog(id, since),
        (entries) => {
          const last = changesIn(entries).at(-1);
          if (last === undefined) return false;
          return than === undefined || compareLogTime(logTime(last), logTime(than)) > 0;
        },
      );
    };

    /** A thought whose note has been written once: an 801 and no 803 yet. */
    const withNote = async (name: string, since: string): Promise<string> => {
      const id = await make(name);
      await api.notes.set(brainId, id, "one");
      const first = await eventually(
        () => noteLog(id, since),
        (entries) => entries.length > 0,
      );
      expect(first.map((l) => l.modType)).toEqual([ModType.NoteCreated]);
      return id;
    };

    /** What this brain logged between two of its entries, neither of them included. */
    const loggedBetween = async (
      after: ModificationLogDto,
      before: ModificationLogDto,
    ): Promise<ModificationLogDto[]> => {
      const range = await api.brains.modifications(brainId, {
        maxLogs: 10,
        since: logTime(after),
        until: logTime(before),
      });
      return range.filter(
        (l) =>
          compareLogTime(logTime(l), logTime(after)) > 0 &&
          compareLogTime(logTime(l), logTime(before)) < 0,
      );
    };

    it("changes with nothing logged between them share one 803, filed again under the time of the last", async () => {
      // Measured: 8 appends 150 ms, 1 s and 3 s apart, 60 appends, 60 whole
      // replacements, and changes 5 s, 15 s and 61 s apart each left a single
      // 803. Reads in between do not end a run, of this note or of anything
      // else: 48 of 48. `append` here reads the note before each write.
      const since = new Date().toISOString();
      const id = await withNote("note-run", since);
      const [created] = await noteLog(id, since);

      let text = "two";
      const second = await afterChange(id, since, () => api.notes.set(brainId, id, text));
      expect(second.map((l) => l.modType)).toEqual([ModType.NoteCreated, ModType.NoteChanged]);
      let changes = changesIn(second);

      const append = async (more: string): Promise<void> => {
        await api.notes.append(brainId, id, more);
        text += `\n\n${more}`;
      };
      const writes: Array<[string, (attempt: number) => Promise<void>]> = [
        ["an append", (n) => append(`more ${n}`)],
        [
          // A write that logs nothing does not end the run.
          "an append after a rename to the name the thought already has",
          async (n) => {
            await api.thoughts.update(brainId, id, { name: `${PREFIX}note-run` });
            await append(`again ${n}`);
          },
        ],
        // The entry moves even when the note does not change.
        ["the note written again with the text it has", () => api.notes.set(brainId, id, text)],
      ];
      for (const [what, write] of writes) {
        let gathered = false;
        for (let attempt = 0; attempt < ATTEMPTS && !gathered; attempt++) {
          const previous = changes.at(-1)!;
          const entries = await afterChange(id, since, () => write(attempt), previous);
          expect(entries[0], what).toEqual(created); // the 801 stays where it was
          const now = changesIn(entries);
          const moved = now.at(-1)!;
          if (now.length > changes.length) {
            // A new entry: then something was logged in between, and nothing
            // in this brain was. The entry left behind stays as it was.
            expect(await loggedBetween(previous, moved), what).toEqual([]);
            expect(now.slice(0, -1), what).toEqual(changes);
          } else {
            gathered = true;
            expect(now.slice(0, -1), what).toEqual(changes.slice(0, -1));
            // Both timestamps moved: the entry was filed again, not given a
            // later modification time on top of its old creation time.
            expect(compareLogTime(moved.creationDateTime, logTime(previous)), what).toBeGreaterThan(0);
            // And nothing is left in its old place.
            const oldPlace = await api.brains.modifications(brainId, {
              maxLogs: 100,
              since: logTime(previous),
              until: logTime(previous),
            });
            expect(oldPlace.filter((l) => l.extraAId === id), what).toEqual([]);
          }
          changes = now;
        }
        expect(gathered, `${what}: another brain logged between every two changes`).toBe(true);
      }

      const stored = await eventually(
        () => api.notes.get(brainId, id),
        (t) => t === text,
      );
      expect(stored).toBe(text); // no write was lost on the way
    }, 60_000);

    it("any entry logged in between ends the run, and an 803 with an entry above it never moves", async () => {
      // The log reader pages backwards and relies on the second half: the
      // pages it has yet to read do not change under it. The rule is not per
      // note: two notes changed in turn log every change.
      const since = new Date().toISOString();
      const id = await withNote("note-run-ended", since);
      const otherNote = await withNote("note-run-other-note", since);
      const bare = await make("note-run-bare");
      const run = await afterChange(id, since, () => api.notes.set(brainId, id, "two"));
      const stays: ModificationLogDto[] = [changesIn(run)[0]!];

      const interruptions: Array<[string, () => Promise<unknown>]> = [
        [
          "the same thought renamed",
          () => api.thoughts.update(brainId, id, { name: `${PREFIX}note-run-ended-2` }),
        ],
        ["a label on the same thought", () => api.thoughts.update(brainId, id, { label: "x" })],
        ["another thought created", () => make("note-run-other")],
        [
          "another thought renamed",
          () => api.thoughts.update(brainId, bare, { name: `${PREFIX}note-run-bare-2` }),
        ],
        ["another note written for the first time", () => api.notes.set(brainId, bare, "one")],
        ["another note changed", () => api.notes.set(brainId, otherNote, "two")],
        ["another thought pinned", () => api.thoughts.pin(brainId, bare)],
      ];
      for (const [what, interrupt] of interruptions) {
        await interrupt();
        // The premise: the interruption is in the log, above the note's 803.
        const [top] = await newestLogs(1);
        expect(logEntryKey(top!), what).not.toBe(logEntryKey(stays.at(-1)!));
        const entries = changesIn(
          await afterChange(id, since, () => api.notes.append(brainId, id, what), stays.at(-1)),
        );
        // The earlier entries are where they were, as they were, plus one.
        expect(entries.slice(0, -1), what).toEqual(stays);
        expect(entries, what).toHaveLength(stays.length + 1);
        stays.push(entries.at(-1)!);
      }
      await api.thoughts.unpin(brainId, bare);
    }, 30_000);

    it("sync reads a note changed again after the entry it had already passed", async () => {
      // What keeps the index right: the entry a sync read is gone from its
      // place, but it comes back under the time of the latest change, which is
      // after any watermark set before that change.
      const since = new Date().toISOString();
      const id = await withNote("note-run-sync", since);

      const documents: string[] = [];
      const embedder: Embedder = {
        id: "contract@v1",
        dimensions: 1,
        embedDocuments: async (texts) => {
          documents.push(...texts);
          return texts.map(() => new Float32Array([1]));
        },
        embedQuery: async () => new Float32Array([1]),
      };
      const { store, indexer } = await indexedSince(since, embedder);
      expect(store.contentHashes().has(id)).toBe(true);

      let changes = changesIn(
        await afterChange(id, since, () => api.notes.set(brainId, id, "two")),
      );
      let moved = false;
      for (let attempt = 0; attempt < ATTEMPTS && !moved; attempt++) {
        const passed = changes.at(-1)!;
        // As a sync leaves it that has read the log up to and including the entry.
        const watermark = shiftMicros(logTime(passed), 1);
        store.setSyncedThrough(watermark);
        const sinceWatermark = async (): Promise<ModificationLogDto[]> =>
          (await api.brains.modifications(brainId, { maxLogs: 1000, since: watermark })).filter(
            (l) => logThoughtId(l) === id,
          );
        expect(await sinceWatermark()).toEqual([]);

        const word = `word${attempt}`;
        await api.notes.append(brainId, id, word);
        const after = await eventually(sinceWatermark, (entries) => entries.length > 0);
        expect(after.map((l) => l.modType)).toEqual([ModType.NoteChanged]);
        const now = changesIn(await noteLog(id, since));
        // The case this test is for: the same entry, moved past the watermark.
        // A new one means another brain logged in between; then try again.
        moved = now.length === changes.length;
        if (!moved) expect(await loggedBetween(passed, now.at(-1)!)).toEqual([]);
        changes = now;
        await eventually(
          () => api.notes.get(brainId, id),
          (t) => t.includes(word),
        );

        const from = documents.length;
        const synced = await indexer.sync(brainId);
        // A read that failed is named here, where it used to be an empty note.
        expect(synced.unread).toEqual([]);
        const embedded = documents.slice(from);
        expect(embedded).toHaveLength(1);
        expect(embedded[0]).toContain(word);
      }
      expect(moved, "another brain logged between every two changes").toBe(true);
      store.close();
    }, 60_000);
  });

  it("a link event names both ends in extraA and extraB, and the link in sourceId", async () => {
    // brain_recent_changes names both thoughts of a link event from here.
    const a = await make("log-link-A");
    const b = await make("log-link-B");
    const linkId = await api.links.create(brainId, { thoughtIdA: a, thoughtIdB: b });

    const logs = await eventually(
      () => newestLogs(200),
      (entries) => entries.some((l) => l.sourceId === linkId),
    );
    const event = logs.find((l) => l.sourceId === linkId && l.modType === ModType.Created);
    expect(event).toBeDefined();
    expect(event!.sourceType).toBe(EntityType.Link);
    expect(event!.extraAType).toBe(EntityType.Thought);
    expect(event!.extraBType).toBe(EntityType.Thought);
    expect([event!.extraAId, event!.extraBId].sort()).toEqual([a, b].sort());
    expect(subjectIds(event!).sort()).toEqual([a, b].sort());
    expect(describeChange(event!)).toBe("link created");
  }, 30_000);

  it("an attachment event names its thought in extraA", async () => {
    // Notes are covered above; a URL is an ordinary attachment.
    const id = await make("log-attachment");
    await api.attachments.attachUrl(brainId, id, "https://example.com/zz-it-probe", {
      name: `${PREFIX}probe`,
      deduplicate: false,
    });

    const isOurs = (l: ModificationLogDto): boolean =>
      l.sourceType === EntityType.Attachment && l.extraAId === id && !isNoteMod(l.modType);
    const logs = await eventually(
      () => newestLogs(200),
      (entries) => entries.some(isOurs),
    );
    const event = logs.find((l) => isOurs(l) && l.modType === ModType.Created);
    expect(event).toBeDefined();
    expect(event!.sourceId).not.toBe(id);
    expect(event!.extraAType).toBe(EntityType.Thought);
    expect(subjectIds(event!)).toEqual([id]);
    expect(describeChange(event!)).toBe("attachment created");
  }, 30_000);

  /**
   * What incremental sync of the semantic index reads from the log: a thought's
   * label, type and tags are all in its document. Measured on TheBrain
   * 15.0.640; the spec describes none of it.
   */
  describe("label, type and tags in the log", () => {
    const mentions =
      (id: string) =>
      (l: ModificationLogDto): boolean =>
        [l.sourceId, l.extraAId, l.extraBId].includes(id);

    /** The matching entries, oldest first, once there are at least `atLeast`. */
    const logged = async (
      matches: (l: ModificationLogDto) => boolean,
      atLeast = 1,
    ): Promise<ModificationLogDto[]> => {
      const logs = await eventually(
        () => newestLogs(300),
        (entries) => entries.filter(matches).length >= atLeast,
      );
      return logs
        .filter(matches)
        .sort((a, b) => compareLogTime(logTime(a), logTime(b)));
    };

    const expectThoughtEvent = (event: ModificationLogDto, id: string): void => {
      expect({ sourceType: event.sourceType, sourceId: event.sourceId }).toEqual({
        sourceType: EntityType.Thought,
        sourceId: id,
      });
      expect(event.extraAType).toBe(EntityType.Unknown);
      expect(logThoughtId(event)).toBe(id);
    };

    it("a label set, changed or cleared is logged as 202 against the thought itself", async () => {
      const id = await make("log-label");
      const labelled = (label: string | null): Promise<unknown> =>
        eventually(
          () => api.thoughts.get(brainId, id),
          (t) => t.label === label,
        );

      await api.thoughts.update(brainId, id, { label: "first" });
      await labelled("first");
      await api.thoughts.update(brainId, id, { label: "second" });
      await labelled("second");
      await api.thoughts.update(brainId, id, { label: null });
      await labelled(null);

      // Found by code and by the id in any position, so a failure below shows
      // how the entry is really keyed.
      const events = await logged(
        (l) => l.modType === ModType.LabelChanged && mentions(id)(l),
        3,
      );
      expect(events.map((l) => [l.oldValue, l.newValue])).toEqual([
        [null, "first"],
        ["first", "second"],
        ["second", null],
      ]);
      for (const event of events) expectThoughtEvent(event, id);
      expect(describeChange(events[0]!)).toBe("label changed");
    }, 30_000);

    it("a type set, changed or lost is logged as 203 against the thought itself", async () => {
      const first = await make("log-type-1", ThoughtKind.Type);
      const second = await make("log-type-2", ThoughtKind.Type);
      const id = await make("log-typed");
      const typed = (typeId: string | null): Promise<unknown> =>
        eventually(
          () => api.thoughts.get(brainId, id),
          (t) => t.typeId === typeId,
        );

      await api.thoughts.update(brainId, id, { typeId: first });
      await typed(first);
      await api.thoughts.update(brainId, id, { typeId: second });
      await typed(second);
      // A thought loses its type when the type is deleted.
      await api.thoughts.delete(brainId, second);
      await typed(null);

      const events = await logged((l) => l.modType === ModType.TypeSet && mentions(id)(l), 4);
      // The values are type names. A change is two entries: the old type goes,
      // then the new one comes.
      expect(events.map((l) => [l.oldValue, l.newValue])).toEqual([
        [null, `${PREFIX}log-type-1`],
        [`${PREFIX}log-type-1`, null],
        [null, `${PREFIX}log-type-2`],
        [`${PREFIX}log-type-2`, null],
      ]);
      for (const event of events) expectThoughtEvent(event, id);
    }, 30_000);

    it("a tag link is logged with the tag in extraA and the thought in extraB, exactly like a parent link", async () => {
      const tagId = await make("log-tag", ThoughtKind.Tag);
      const parentId = await make("log-parent");
      const id = await make("log-tagged");
      const tagLink = await api.links.attachTag(brainId, id, tagId);
      // The same request against an ordinary thought makes that thought a parent.
      const parentLink = await api.links.create(brainId, {
        thoughtIdA: id,
        thoughtIdB: parentId,
        relation: Relation.Parent,
      });

      const born = await logged(
        (l) => l.modType === ModType.Created && [tagLink, parentLink].includes(l.sourceId),
        2,
      );
      const tagEvent = born.find((l) => l.sourceId === tagLink)!;
      const parentEvent = born.find((l) => l.sourceId === parentLink)!;
      expect(tagEvent).toMatchObject({
        sourceType: EntityType.Link,
        extraAId: tagId,
        extraAType: EntityType.Thought,
        extraBId: id,
        extraBType: EntityType.Thought,
        oldValue: null,
        newValue: null,
      });
      // No thought event comes with it: the link's entry is the only trace.
      expect(logThoughtId(tagEvent)).toBeNull();
      expect(linkEndIds(tagEvent)).toEqual([tagId, id]);

      // Take away what must differ, the ids and the time, and nothing is left
      // to tell the tag link's entry from the parent link's.
      const anonymous = (l: ModificationLogDto): ModificationLogDto => ({
        ...l,
        sourceId: "",
        extraAId: "",
        creationDateTime: "",
        modificationDateTime: "",
      });
      expect(parentEvent.extraAId).toBe(parentId);
      expect(anonymous(tagEvent)).toEqual(anonymous(parentEvent));

      expect(await api.links.detachTag(brainId, id, tagId)).toBe(true);
      const [gone] = await logged((l) => l.modType === ModType.Deleted && l.sourceId === tagLink);
      expect(gone).toMatchObject({ sourceType: EntityType.Link, oldValue: null, newValue: null });
      expect(linkEndIds(gone!)).toEqual([tagId, id]);
    }, 30_000);

    it("deleting a tag in use logs the end of its link to each thought", async () => {
      const tagId = await make("log-tag-doomed", ThoughtKind.Tag);
      const id = await make("log-tag-bereft");
      const link = await api.links.attachTag(brainId, id, tagId);
      await eventually(
        () => api.thoughts.getGraph(brainId, id),
        (g) => g.tags.some((t) => t.id === tagId),
      );
      await api.thoughts.delete(brainId, tagId);

      const [event] = await logged((l) => l.modType === ModType.Deleted && l.sourceId === link);
      expect(event, "the tag link's deletion is not in the log").toBeDefined();
      expect(linkEndIds(event!)).toEqual([tagId, id]);
    }, 30_000);

    it("renaming a tag or a type logs its own 103 and nothing about the thoughts that carry it", async () => {
      const tagId = await make("log-tag-old", ThoughtKind.Tag);
      const typeId = await make("log-type-old", ThoughtKind.Type);
      const id = await make("log-carrier");
      await api.links.attachTag(brainId, id, tagId);
      await api.thoughts.update(brainId, id, { typeId });
      // Created, tag link, type link, type set.
      const before = await logged(mentions(id), 4);

      await api.thoughts.update(brainId, tagId, { name: `${PREFIX}log-tag-new` });
      await api.thoughts.update(brainId, typeId, { name: `${PREFIX}log-type-new` });

      const renames = await logged(
        (l) => l.modType === ModType.NameChanged && [tagId, typeId].includes(l.sourceId),
        2,
      );
      expect(renames.map((l) => l.sourceId).sort()).toEqual([tagId, typeId].sort());
      for (const event of renames) expectThoughtEvent(event, event.sourceId);

      // The carrier's document now holds both new names...
      const carrier = await eventually(
        () => api.thoughts.getGraph(brainId, id),
        (g) =>
          g.type?.name === `${PREFIX}log-type-new` &&
          g.tags.some((t) => t.name === `${PREFIX}log-tag-new`),
      );
      expect(carrier.type?.name).toBe(`${PREFIX}log-type-new`);
      expect(carrier.tags.map((t) => t.name)).toEqual([`${PREFIX}log-tag-new`]);

      // ...and the log has said nothing more about it. Sync finds it through
      // the graphs of the tag and the type, which list it as a child.
      const after = await logged(mentions(id), before.length);
      expect(after.map(logEntryKey)).toEqual(before.map(logEntryKey));
    }, 30_000);

    it("a moved tag link is logged as 402 and names its new ends only", async () => {
      const tagId = await make("log-tag-moved", ThoughtKind.Tag);
      const from = await make("log-move-from");
      const to = await make("log-move-to");
      const link = await api.links.attachTag(brainId, from, tagId);
      await api.client.patch(`/api/links/${brainId}/${link}`, {
        jsonPatch: [{ op: "replace", path: "/thoughtIdB", value: to }],
      });

      const [moved] = await logged((l) => l.modType === ModType.LinkMoved && l.sourceId === link);
      expect(moved, "no 402 entry for the link").toBeDefined();
      expect(moved).toMatchObject({
        sourceType: EntityType.Link,
        oldValue: null,
        newValue: null,
      });
      // The thought that lost the tag is not in the entry at all.
      expect(linkEndIds(moved!)).toEqual([tagId, to]);

      const loser = await eventually(
        () => api.thoughts.getGraph(brainId, from),
        (g) => g.tags.length === 0,
      );
      expect(loser.tags).toEqual([]);
      const gainer = await eventually(
        () => api.thoughts.getGraph(brainId, to),
        (g) => g.tags.length > 0,
      );
      expect(gainer.tags.map((t) => t.id)).toEqual([tagId]);
    }, 30_000);

    it("a tag turned into an ordinary thought logs 404 against each of its links", async () => {
      const tagId = await make("log-tag-demoted", ThoughtKind.Tag);
      const id = await make("log-tag-demoted-carrier");
      const link = await api.links.attachTag(brainId, id, tagId);
      await api.thoughts.update(brainId, tagId, { kind: ThoughtKind.Normal });

      const [event] = await logged(
        (l) => l.modType === ModType.LinkMeaningChanged && l.sourceId === link,
      );
      expect(event, "no 404 entry for the link").toBeDefined();
      expect(event).toMatchObject({
        sourceType: EntityType.Link,
        oldValue: "HasTag",
        newValue: "Normal",
      });
      expect(linkEndIds(event!)).toEqual([tagId, id]);

      // The thought keeps the link and loses the tag: it is a parent now.
      const graph = await eventually(
        () => api.thoughts.getGraph(brainId, id),
        (g) => g.tags.length === 0,
      );
      expect(graph.tags).toEqual([]);
      expect(graph.parents.map((p) => p.id)).toContain(tagId);
    }, 30_000);

    it("sync re-embeds a thought after each of these, read from the live log", async () => {
      // The whole path, not its parts: the entries above are only worth
      // anything if sync turns them into the right thoughts to read again.
      const since = new Date().toISOString();
      const tagId = await make("sync-tag", ThoughtKind.Tag);
      const typeId = await make("sync-type", ThoughtKind.Type);
      const id = await make("sync-thought");
      const name = `${PREFIX}sync-thought`;

      const documents: string[] = [];
      const embedder: Embedder = {
        id: "contract@v1",
        dimensions: 1,
        embedDocuments: async (texts) => {
          documents.push(...texts);
          return texts.map(() => new Float32Array([1]));
        },
        embedQuery: async () => new Float32Array([1]),
      };
      const { store, indexer } = await indexedSince(since, embedder);
      expect(documents).toContain(name);

      /** What sync embeds once the thought's graph shows the change. */
      const embeddedAfter = async (
        change: () => Promise<unknown>,
        shown: (graph: CleanGraph) => boolean,
      ): Promise<string[]> => {
        // So that the entry of this change is all the sync has to go by.
        await caughtUp(store);
        await change();
        await eventually(() => api.thoughts.getGraph(brainId, id), shown);
        const from = documents.length;
        await indexer.sync(brainId);
        return documents.slice(from);
      };

      expect(
        await embeddedAfter(
          () => api.thoughts.update(brainId, id, { label: "caption" }),
          (g) => g.thought.label === "caption",
        ),
      ).toEqual([`${name}\ncaption`]);

      expect(
        await embeddedAfter(
          () => api.thoughts.update(brainId, id, { typeId }),
          (g) => g.type?.id === typeId,
        ),
      ).toEqual([`${name}\ncaption\ntype: ${PREFIX}sync-type`]);

      expect(
        await embeddedAfter(
          () => api.links.attachTag(brainId, id, tagId),
          (g) => g.tags.some((t) => t.id === tagId),
        ),
      ).toEqual([`${name}\ncaption\ntype: ${PREFIX}sync-type\ntags: ${PREFIX}sync-tag`]);

      // A rename is logged against the tag or the type alone. Sync embeds two
      // documents: the renamed one's own, and the thought that carries it.
      const tagRenamed = await embeddedAfter(
        () => api.thoughts.update(brainId, tagId, { name: `${PREFIX}sync-tag-2` }),
        (g) => g.tags.some((t) => t.name === `${PREFIX}sync-tag-2`),
      );
      expect(tagRenamed).toHaveLength(2);
      expect(tagRenamed).toContain(
        `${name}\ncaption\ntype: ${PREFIX}sync-type\ntags: ${PREFIX}sync-tag-2`,
      );

      const typeRenamed = await embeddedAfter(
        () => api.thoughts.update(brainId, typeId, { name: `${PREFIX}sync-type-2` }),
        (g) => g.type?.name === `${PREFIX}sync-type-2`,
      );
      expect(typeRenamed).toHaveLength(2);
      expect(typeRenamed).toContain(
        `${name}\ncaption\ntype: ${PREFIX}sync-type-2\ntags: ${PREFIX}sync-tag-2`,
      );

      expect(
        await embeddedAfter(
          () => api.links.detachTag(brainId, id, tagId),
          (g) => g.tags.length === 0,
        ),
      ).toEqual([`${name}\ncaption\ntype: ${PREFIX}sync-type-2`]);
      store.close();
    }, 60_000);

    it("a sync that runs before the graph shows a tag does not lose it", async () => {
      // The link's entry is in the log at once; `graph.tags` follows 0.1–0.5 s
      // later. A sync in between reads the old graph. Measured: one tag in
      // four, each followed at once by a sync, and with the watermark at the
      // sync's own start that tag stayed out of the index until a rebuild.
      const since = new Date().toISOString();
      const tagId = await make("race-tag", ThoughtKind.Tag);
      const ids = [await make("race-0"), await make("race-1"), await make("race-2")];

      const documents: string[] = [];
      const embedder: Embedder = {
        id: "contract@v1",
        dimensions: 1,
        embedDocuments: async (texts) => {
          documents.push(...texts);
          return texts.map(() => new Float32Array([1]));
        },
        embedQuery: async () => new Float32Array([1]),
      };
      const { store, indexer } = await indexedSince(since, embedder);
      const from = documents.length;
      expect(documents).toEqual(
        expect.arrayContaining([0, 1, 2].map((i) => `${PREFIX}race-${i}`)),
      );

      for (const id of ids) {
        await api.links.attachTag(brainId, id, tagId);
        await indexer.sync(brainId);
      }
      for (const id of ids) {
        await eventually(
          () => api.thoughts.getGraph(brainId, id),
          (g) => g.tags.some((t) => t.id === tagId),
        );
      }
      await indexer.sync(brainId);

      // Each of them exactly once, whichever sync saw its tag first.
      expect(documents.slice(from).sort()).toEqual(
        [0, 1, 2].map((i) => `${PREFIX}race-${i}\ntags: ${PREFIX}race-tag`),
      );
      store.close();
    }, 60_000);
  });

  /**
   * What the log keeps of a thought's name. `brain_recent_changes` names a
   * deleted thought by it, and a thought it does not read (docs/api-map.md,
   * L37). Measured on TheBrain 15.0.640, over the 159,451 entries of one
   * brain's log: 48,013 `101`s, 639 `103`s and 48,012 `102`s of a thought,
   * every one with the name where these tests look for it.
   */
  describe("a thought's name in the log", () => {
    /** A thought's own entries, oldest first, once there are `atLeast` of them. */
    const own = async (id: string, atLeast: number): Promise<ModificationLogDto[]> => {
      const mine = (l: ModificationLogDto): boolean =>
        l.sourceType === EntityType.Thought && l.sourceId === id;
      const logs = await eventually(
        () => newestLogs(300),
        (entries) => entries.filter(mine).length >= atLeast,
      );
      return logs.filter(mine).sort((a, b) => compareLogTime(logTime(a), logTime(b)));
    };
    /** An entry as its code and its two values. */
    const shape = (l: ModificationLogDto): [number, string | null, string | null] => [
      l.modType,
      l.oldValue,
      l.newValue,
    ];
    const named = async (id: string, name: string): Promise<ThoughtDto> =>
      eventually(
        () => api.thoughts.get(brainId, id),
        (t) => t.name === name,
      );
    const KINDS = [
      ["an ordinary thought", ThoughtKind.Normal],
      ["a type", ThoughtKind.Type],
      ["a tag", ThoughtKind.Tag],
    ] as const;

    it.each(KINDS)(
      "%s: its 101 has the name it was created with, its 103 the old and the new, its 102 the last",
      async (_, kind) => {
        const first = `${PREFIX}log-name-${kind}`;
        const second = `${PREFIX}log-name-${kind} renamed`;
        const id = await make(`log-name-${kind}`, kind);

        // Created: the name, and nothing else of the thought. Not its kind.
        const born = await own(id, 1);
        expect(born.map(shape)).toEqual([[ModType.Created, null, first]]);
        expect(born[0]).toMatchObject({
          extraAType: EntityType.Unknown,
          extraBType: EntityType.Unknown,
        });
        expect(loggedThoughts(born).get(id)).toEqual({ name: first, cut: false, deleted: false });

        // Created and renamed: the newest name is the one the thought reads with.
        await api.thoughts.update(brainId, id, { name: second });
        const renamed = await own(id, 2);
        expect(renamed.map(shape)).toEqual([
          [ModType.Created, null, first],
          [ModType.NameChanged, first, second],
        ]);
        expect((await named(id, second)).name).toBe(loggedThoughts(renamed).get(id)?.name);

        // Renamed, then deleted: the name it had last, not the one it was made with.
        await api.thoughts.delete(brainId, id);
        const gone = await own(id, 3);
        expect(gone.map(shape)).toEqual([
          [ModType.Created, null, first],
          [ModType.NameChanged, first, second],
          [ModType.Deleted, second, null],
        ]);
        expect(loggedThoughts(gone).get(id)).toEqual({ name: second, cut: false, deleted: true });
        // And the 102 alone is enough, as when the rest is past the limit of a read.
        expect(loggedThoughts(gone.slice(-1)).get(id)).toEqual({
          name: second,
          cut: false,
          deleted: true,
        });
      },
      30_000,
    );

    it("a thought deleted with no rename has one name in its 101 and its 102", async () => {
      const id = await make("log-name-plain");
      await api.thoughts.delete(brainId, id);
      expect((await own(id, 2)).map(shape)).toEqual([
        [ModType.Created, null, `${PREFIX}log-name-plain`],
        [ModType.Deleted, `${PREFIX}log-name-plain`, null],
      ]);
    }, 30_000);

    it("the name logged is the name as the thought reads, not as it was sent", async () => {
      // A name is stored with a tab or a line feed as a space and the blanks
      // after it dropped (3 of 3 each), and that is what the log has.
      const sent = `${PREFIX}log-name\ttab\nfeed  `;
      const id = await api.thoughts.create(brainId, { name: sent });
      created.push(id);
      const stored = (await api.thoughts.get(brainId, id)).name;
      expect(stored).toBe(`${PREFIX}log-name tab feed`);

      const [born] = await own(id, 1);
      expect(born!.newValue).toBe(stored);
    }, 30_000);

    it("a rename is in the log when its request is answered", async () => {
      // So the newest name the log has is the thought's name: a read of the
      // log holds every rename made before it. The thought's own read is
      // behind for a moment (L28), which the log is not: 20 of 20.
      for (let i = 0; i < 5; i++) {
        const id = await make(`log-name-at-once-${i}`);
        const to = `${PREFIX}log-name-at-once-${i} renamed`;
        await api.thoughts.update(brainId, id, { name: to });
        const logs = await newestLogs(50);
        expect(loggedThoughts(logs).get(id)?.name, `rename ${i}`).toBe(to);
      }
    }, 30_000);

    it("the log keeps the first 140 UTF-16 code units of a name, and the thought the whole of it", async () => {
      expect(LOG_NAME_LIMIT).toBe(140);
      const long = (length: number): string => PREFIX + "n".repeat(length - PREFIX.length);
      const cases = [
        { length: LOG_NAME_LIMIT - 1, cut: false },
        // As long as the log keeps one: whole, and not to be told from one cut.
        { length: LOG_NAME_LIMIT, cut: true },
        { length: LOG_NAME_LIMIT + 1, cut: true },
        { length: 300, cut: true },
      ];
      for (const { length, cut } of cases) {
        const name = long(length);
        const id = await api.thoughts.create(brainId, { name });
        created.push(id);
        expect((await api.thoughts.get(brainId, id)).name, `read at ${length}`).toBe(name);

        const renamedTo = `${name.slice(0, -1)}Z`;
        await api.thoughts.update(brainId, id, { name: renamedTo });
        await named(id, renamedTo);
        await api.thoughts.delete(brainId, id);

        const kept = (text: string): string => text.slice(0, LOG_NAME_LIMIT);
        const entries = await own(id, 3);
        expect(entries.map(shape), `log at ${length}`).toEqual([
          [ModType.Created, null, kept(name)],
          [ModType.NameChanged, kept(name), kept(renamedTo)],
          [ModType.Deleted, kept(renamedTo), null],
        ]);
        expect(loggedThoughts(entries).get(id), `flag at ${length}`).toEqual({
          name: kept(renamedTo),
          cut,
          deleted: true,
        });
      }

      // By code unit, not by character: a pair across the cut is halved.
      const across = `${long(LOG_NAME_LIMIT - 1)}🦔 and more`;
      const id = await api.thoughts.create(brainId, { name: across });
      created.push(id);
      expect((await api.thoughts.get(brainId, id)).name).toBe(across);
      const [born] = await own(id, 1);
      expect(born!.newValue).toHaveLength(LOG_NAME_LIMIT);
      expect(born!.newValue!.slice(0, LOG_NAME_LIMIT - 1)).toBe(long(LOG_NAME_LIMIT - 1));
      expect(across.startsWith(born!.newValue!)).toBe(false);
    }, 60_000);

    it("no other entry about a thought carries its name", async () => {
      // A label, a note, a link at either end and a type: the thought is in
      // `sourceId` or in an `extra`, and its name in neither value.
      const name = `${PREFIX}log-name-elsewhere`;
      const typeId = await make("log-name-its-type", ThoughtKind.Type);
      const otherId = await make("log-name-other-end");
      const id = await make("log-name-elsewhere");
      await api.thoughts.update(brainId, id, { label: "a label" });
      await api.notes.set(brainId, id, "a note");
      await api.links.create(brainId, {
        thoughtIdA: id,
        thoughtIdB: otherId,
        relation: Relation.Jump,
        name: "a link",
      });
      await api.thoughts.update(brainId, id, { typeId });

      // Every entry that names the thought, but for its own `101`.
      const about = (l: ModificationLogDto): boolean =>
        [l.sourceId, l.extraAId, l.extraBId].includes(id) &&
        !(l.sourceType === EntityType.Thought && l.modType === ModType.Created);
      const logs = await eventually(
        () => newestLogs(300),
        (entries) => entries.filter(about).length >= 6,
      );
      const others = logs.filter(about);
      // The label, the type set, the jump and the type's link, the jump's
      // label, and the note.
      expect(others.map((l) => `${l.sourceType}/${l.modType}`).sort()).toEqual([
        `${EntityType.Thought}/${ModType.LabelChanged}`,
        `${EntityType.Thought}/${ModType.TypeSet}`,
        `${EntityType.Link}/${ModType.Created}`,
        `${EntityType.Link}/${ModType.Created}`,
        `${EntityType.Link}/${ModType.NameChanged}`,
        `${EntityType.Attachment}/${ModType.NoteCreated}`,
      ]);
      for (const l of others) {
        expect([l.oldValue, l.newValue], `entry ${l.modType}`).not.toContain(name);
      }
      // So only the thoughts with an entry of their own are named: the three made here.
      const mine = loggedThoughts(logs.filter((l) => [id, otherId, typeId].includes(l.sourceId)));
      expect(mine.get(id)).toEqual({ name, cut: false, deleted: false });
      expect(loggedThoughts(others).size).toBe(0);
    }, 30_000);
  });

  /**
   * What `PATCH /kind` does to a thought, to what is under it and to the log.
   * The semantic index keeps a thought's kind beside its document and leaves
   * types and tags out of a search by it, so sync has to hear of the change.
   * Measured on TheBrain 15.0.640; the spec says only that `kind` is patched.
   */
  describe("a thought that changes kind", () => {
    const { Normal, Type, Tag } = ThoughtKind;
    /** A kind as a `304` writes it. */
    const KIND_NAME: Record<number, string> = { [Normal]: "Normal", [Type]: "Type", [Tag]: "Tag" };
    /** What a `404` calls a link under a thought of that kind. */
    const UNDER: Record<number, string> = {
      [Normal]: "Normal",
      [Type]: "InstanceOf",
      [Tag]: "HasTag",
    };
    const CHANGES = (
      [
        [Normal, Tag],
        [Tag, Normal],
        [Normal, Type],
        [Type, Normal],
        [Type, Tag],
        [Tag, Type],
      ] as const
    ).map(([from, to]) => ({ from, to, named: `${KIND_NAME[from]} → ${KIND_NAME[to]}` }));

    /** Every entry that names one of `ids`, in any position, oldest first. */
    const about = async (ids: readonly string[]): Promise<ModificationLogDto[]> =>
      (await newestLogs(300))
        .filter((l) => [l.sourceId, l.extraAId, l.extraBId].some((id) => ids.includes(id)))
        .sort((a, b) => compareLogTime(logTime(a), logTime(b)));

    /**
     * Changes the kind of `id` and returns what the log gained about `ids`,
     * oldest first. A write is in the log when its request is answered, so
     * what was there before the patch is what made the fixture.
     */
    const turn = async (
      id: string,
      to: number,
      ids: readonly string[] = [id],
    ): Promise<ModificationLogDto[]> => {
      const made = await about(ids);
      const boundary = logTime(made.at(-1)!);
      const later = (l: ModificationLogDto): boolean => compareLogTime(logTime(l), boundary) > 0;
      await api.thoughts.update(brainId, id, { kind: to });
      const entries = await eventually(
        () => about(ids),
        (found) =>
          found.some((l) => later(l) && l.modType === ModType.KindChanged && l.sourceId === id),
      );
      return entries.filter(later);
    };

    /** An entry as code, whom it is about by role, and its two values. */
    const shapeOf =
      (roles: ReadonlyMap<string, string>) =>
      (l: ModificationLogDto): [number, string, string | null, string | null] => [
        l.modType,
        l.sourceType === EntityType.Thought
          ? (roles.get(l.sourceId) ?? l.sourceId)
          : `${roles.get(l.extraAId) ?? l.extraAId}>${roles.get(l.extraBId) ?? l.extraBId}`,
        l.oldValue,
        l.newValue,
      ];

    /** Puts `id` under `x` the way a thought is under one of that kind. */
    const putUnder = async (x: string, kind: number, id: string): Promise<void> => {
      if (kind === Type) await api.thoughts.update(brainId, id, { typeId: x });
      else if (kind === Tag) await api.links.attachTag(brainId, id, x);
      else {
        await api.links.create(brainId, {
          thoughtIdA: x,
          thoughtIdB: id,
          relation: Relation.Child,
        });
      }
    };

    /** An embedder that records what it is given and ranks nothing. */
    const recorder = (): { embedder: Embedder; documents: string[] } => {
      const documents: string[] = [];
      const embedder: Embedder = {
        id: "contract@v1",
        dimensions: 1,
        embedDocuments: async (texts) => {
          documents.push(...texts);
          return texts.map(() => new Float32Array([1]));
        },
        embedQuery: async () => new Float32Array([1]),
      };
      return { embedder, documents };
    };

    it.each(CHANGES)(
      "$named is one 304 against the thought, the kinds by name, and no other entry",
      async ({ from, to }) => {
        const name = `kind-${KIND_NAME[from]}-${KIND_NAME[to]}`.toLowerCase();
        const id = await make(name, from);

        const entries = await turn(id, to);
        expect(entries.map(shapeOf(new Map([[id, "x"]])))).toEqual([
          [ModType.KindChanged, "x", KIND_NAME[from]!, KIND_NAME[to]!],
        ]);
        const [event] = entries;
        expect(event).toMatchObject({
          sourceType: EntityType.Thought,
          sourceId: id,
          extraAType: EntityType.Unknown,
          extraBType: EntityType.Unknown,
        });
        expect(logThoughtId(event!)).toBe(id);
        expect(linkEndIds(event!)).toEqual([]);
        expect(describeChange(event!)).toBe("kind changed");

        // The read and the graph follow, up to a quarter of a second later.
        const read = await eventually(
          () => api.thoughts.get(brainId, id),
          (t) => t.kind === to,
        );
        expect(read.kind).toBe(to);
        const graph = await eventually(
          () => api.thoughts.getGraph(brainId, id),
          (g) => g.thought.kind === to,
        );
        expect(graph.thought.kind).toBe(to);
        // The label is in the document, and it changes with no 202: a thought
        // with none of its own reads with its name for one while it is a type.
        expect(graph.thought.label).toBe(to === Type ? `${PREFIX}${name}` : null);
      },
      30_000,
    );

    it.each(CHANGES)(
      "$named turns every link under the thought, a 404 each, with a 203 for a type gained or lost",
      async ({ from, to }) => {
        const tail = `${KIND_NAME[from]}-${KIND_NAME[to]}`.toLowerCase();
        const x = await make(`kind-over-${tail}`, from);
        const c = await make(`kind-under-${tail}-c`);
        const d = await make(`kind-under-${tail}-d`);
        const name = `${PREFIX}kind-over-${tail}`;
        await putUnder(x, from, c);
        await putUnder(x, from, d);
        await eventually(
          () => api.thoughts.getGraph(brainId, x),
          (g) => g.children.length === 2,
        );

        const entries = await turn(x, to, [x, c, d]);
        const shapes = entries.map(
          shapeOf(
            new Map([
              [x, "x"],
              [c, "c"],
              [d, "d"],
            ]),
          ),
        );
        const key = (shape: unknown): string => JSON.stringify(shape);
        const link = (id: string): unknown => [
          ModType.LinkMeaningChanged,
          `x>${id}`,
          UNDER[from]!,
          UNDER[to]!,
        ];
        const lost = (id: string): unknown => [ModType.TypeSet, id, name, null];
        const gained = (id: string): unknown => [ModType.TypeSet, id, null, name];
        const own = [ModType.KindChanged, "x", KIND_NAME[from]!, KIND_NAME[to]!];
        expect(shapes.map(key).sort()).toEqual(
          [
            ...(from === Type ? [lost("c"), lost("d")] : []),
            link("c"),
            link("d"),
            ...(to === Type ? [gained("c"), gained("d")] : []),
            own,
          ]
            .map(key)
            .sort(),
        );

        // The thought's own entry is the last. The children come in any order;
        // a type lost is logged ahead of every link, a type gained straight
        // after its own link.
        const at = (shape: unknown): number => shapes.map(key).indexOf(key(shape));
        expect(at(own)).toBe(shapes.length - 1);
        for (const id of ["c", "d"]) {
          if (from === Type) expect(at(lost(id))).toBeLessThan(2);
          if (to === Type) expect(at(gained(id))).toBe(at(link(id)) + 1);
        }
        // Each link's entry names both ends, which is how sync finds what is
        // under the thought: nothing else in the log says its document changed
        // when it gains or loses a tag.
        const links = entries.filter((l) => l.modType === ModType.LinkMeaningChanged);
        expect(links.map(linkEndIds).sort()).toEqual([[x, c], [x, d]].sort());
        // One request, and each of its entries has a time of its own.
        expect(new Set(entries.map(logTime)).size).toBe(entries.length);

        for (const id of [c, d]) {
          const graph = await eventually(
            () => api.thoughts.getGraph(brainId, id),
            (g) =>
              to === Type
                ? g.type?.id === x
                : to === Tag
                  ? g.tags.some((t) => t.id === x)
                  : g.parents.some((p) => p.id === x),
          );
          expect({
            type: graph.type?.id ?? null,
            tags: graph.tags.map((t) => t.id),
            parents: graph.parents.map((p) => p.id),
          }).toEqual({
            type: to === Type ? x : null,
            tags: to === Tag ? [x] : [],
            parents: to === Normal ? [x] : [],
          });
        }
      },
      30_000,
    );

    it("a thought turned into a tag loses its type, and keeps the tag it had", async () => {
      const t = await make("kind-own-type-1", Type);
      const g = await make("kind-own-tag-1", Tag);
      const x = await make("kind-typed-to-tag");
      await api.thoughts.update(brainId, x, { typeId: t });
      await api.links.attachTag(brainId, x, g);
      await eventually(
        () => api.thoughts.getGraph(brainId, x),
        (graph) => graph.type?.id === t && graph.tags.length === 1,
      );

      const entries = await turn(x, Tag, [x, t, g]);
      const roles = new Map([
        [x, "x"],
        [t, "t"],
        [g, "g"],
      ]);
      // The type's link is deleted and the type cleared, each with its entry,
      // so this change was read by sync before it read 304.
      expect(entries.map(shapeOf(roles))).toEqual([
        [ModType.Deleted, "t>x", null, null],
        [ModType.TypeSet, "x", `${PREFIX}kind-own-type-1`, null],
        [ModType.LinkMeaningChanged, "g>x", "HasTag", "SubTagOf"],
        [ModType.KindChanged, "x", "Normal", "Tag"],
      ]);

      const graph = await eventually(
        () => api.thoughts.getGraph(brainId, x),
        (now) => now.thought.kind === Tag && now.type === null,
      );
      expect(graph.thought.typeId).toBeNull();
      expect(graph.type).toBeNull();
      expect(graph.tags.map((tag) => tag.id)).toEqual([g]);
    }, 30_000);

    it("a thought turned into a type keeps its type and its tag", async () => {
      const t = await make("kind-own-type-2", Type);
      const g = await make("kind-own-tag-2", Tag);
      const x = await make("kind-typed-to-type");
      await api.thoughts.update(brainId, x, { typeId: t });
      await api.links.attachTag(brainId, x, g);
      await eventually(
        () => api.thoughts.getGraph(brainId, x),
        (graph) => graph.type?.id === t && graph.tags.length === 1,
      );

      const entries = await turn(x, Type, [x, t, g]);
      const roles = new Map([
        [x, "x"],
        [t, "t"],
        [g, "g"],
      ]);
      expect(entries.map(shapeOf(roles))).toEqual([
        [ModType.LinkMeaningChanged, "t>x", "InstanceOf", "TypeOf"],
        [ModType.KindChanged, "x", "Normal", "Type"],
      ]);

      const graph = await eventually(
        () => api.thoughts.getGraph(brainId, x),
        (now) => now.thought.kind === Type,
      );
      expect(graph.type?.id).toBe(t);
      expect(graph.tags.map((tag) => tag.id)).toEqual([g]);
    }, 30_000);

    it("a child with a type of its own loses it to a parent turned into a type, and keeps it under one turned into a tag", async () => {
      const fixture = async (tail: string) => {
        const x = await make(`kind-over-typed-${tail}`);
        const c = await make(`kind-typed-child-${tail}`);
        const t = await make(`kind-child-type-${tail}`, Type);
        await putUnder(x, Normal, c);
        await api.thoughts.update(brainId, c, { typeId: t });
        await eventually(
          () => api.thoughts.getGraph(brainId, c),
          (g) => g.type?.id === t && g.parents.some((p) => p.id === x),
        );
        const roles = new Map([
          [x, "x"],
          [c, "c"],
          [t, "t"],
        ]);
        return { x, c, t, roles };
      };

      const typed = await fixture("type");
      const own = `${PREFIX}kind-child-type-type`;
      // The second 203 has the old type for its old value, though the first
      // has cleared it. Both name the child, so sync reads it again.
      expect((await turn(typed.x, Type, [typed.x, typed.c, typed.t])).map(shapeOf(typed.roles))).toEqual([
        [ModType.Deleted, "t>c", null, null],
        [ModType.TypeSet, "c", own, null],
        [ModType.LinkMeaningChanged, "x>c", "Normal", "InstanceOf"],
        [ModType.TypeSet, "c", own, `${PREFIX}kind-over-typed-type`],
        [ModType.KindChanged, "x", "Normal", "Type"],
      ]);
      const instance = await eventually(
        () => api.thoughts.getGraph(brainId, typed.c),
        (g) => g.type?.id === typed.x,
      );
      expect(instance.type?.id).toBe(typed.x);

      const tagged = await fixture("tag");
      expect((await turn(tagged.x, Tag, [tagged.x, tagged.c, tagged.t])).map(shapeOf(tagged.roles))).toEqual([
        [ModType.LinkMeaningChanged, "x>c", "Normal", "HasTag"],
        [ModType.KindChanged, "x", "Normal", "Tag"],
      ]);
      const carrier = await eventually(
        () => api.thoughts.getGraph(brainId, tagged.c),
        (g) => g.tags.some((tag) => tag.id === tagged.x),
      );
      expect(carrier.type?.id).toBe(tagged.t);
      expect(carrier.tags.map((tag) => tag.id)).toEqual([tagged.x]);
    }, 30_000);

    it.each([
      { to: Tag, named: "a tag" },
      { to: Type, named: "a type" },
    ])("a thought turned into $named keeps its label, its note, its parent and its jump", async ({ to }) => {
      const tail = KIND_NAME[to]!.toLowerCase();
      const x = await api.thoughts.create(brainId, {
        name: `${PREFIX}kind-kept-${tail}`,
        label: "a caption",
      });
      created.push(x);
      const p = await make(`kind-kept-parent-${tail}`);
      const j = await make(`kind-kept-jump-${tail}`);
      await api.links.create(brainId, { thoughtIdA: x, thoughtIdB: p, relation: Relation.Parent });
      await api.links.create(brainId, { thoughtIdA: x, thoughtIdB: j, relation: Relation.Jump });
      await api.notes.set(brainId, x, "a note of its own");
      await eventually(
        () => api.thoughts.getGraph(brainId, x),
        (g) => g.parents.length === 1 && g.jumps.length === 1 && g.attachments.some((a) => a.isNotes),
      );

      // Neither link turns: the 304 is all the log has.
      const entries = await turn(x, to, [x, p, j]);
      expect(entries.map((l) => l.modType)).toEqual([ModType.KindChanged]);

      const graph = await eventually(
        () => api.thoughts.getGraph(brainId, x),
        (g) => g.thought.kind === to,
      );
      expect(graph.thought.label).toBe("a caption");
      expect(graph.parents.map((t) => t.id)).toEqual([p]);
      expect(graph.jumps.map((t) => t.id)).toEqual([j]);
      expect(graph.attachments.some((a) => a.isNotes)).toBe(true);
      expect(await api.notes.get(brainId, x)).toBe("a note of its own");
    }, 30_000);

    it("only an ordinary thought, a type and a tag can be asked for, and asking for what it is logs nothing", async () => {
      const id = await make("kind-refused");
      const patched = (op: Record<string, unknown>): Promise<unknown> =>
        api.client
          .patch(`/api/thoughts/${brainId}/${id}`, {
            jsonPatch: [{ path: "/kind", ...op } as never],
          })
          .then(
            () => "accepted",
            (error: unknown) => error,
          );

      // 3 is the spec's Event and 5 its System: no request makes either.
      for (const value of [0, 3, 5, 6, 99, -1]) {
        expect(await patched({ op: "replace", value }), `kind ${value}`).toMatchObject({
          kind: "bad_request",
          status: 400,
          message: "'kind' value is not valid.",
        });
      }
      // What is no whole number is the 403 that names no cause.
      for (const value of [null, 1.5, "tag", true]) {
        expect(await patched({ op: "replace", value }), `kind ${String(value)}`).toMatchObject({
          kind: "forbidden",
          status: 403,
        });
      }
      for (const op of ["remove", "add"]) {
        expect(await patched({ op, value: Tag }), op).toMatchObject({
          kind: "bad_request",
          status: 400,
          message: "Only 'replace' operation is allowed for 'kind' path.",
        });
      }
      for (const kind of [3, 5]) {
        const born = await api.thoughts.create(brainId, { name: `${PREFIX}kind-born-${kind}`, kind }).then(
          (made) => {
            created.push(made);
            return "accepted";
          },
          (error: unknown) => error,
        );
        expect(born, `a thought created with kind ${kind}`).toMatchObject({
          kind: "bad_request",
          status: 400,
          message: `Invalid 'Kind' value: ${kind}.`,
        });
      }

      // The kind it has is a 200 and no entry: the one 304 below is the tag's.
      expect(await patched({ op: "replace", value: Normal })).toBe("accepted");
      expect((await api.thoughts.get(brainId, id)).kind).toBe(Normal);
      const entries = await turn(id, Tag);
      expect(entries.map((l) => [l.modType, l.oldValue, l.newValue])).toEqual([
        [ModType.KindChanged, "Normal", "Tag"],
      ]);

      // The number as a string is taken for the number.
      expect(await patched({ op: "replace", value: String(Type) })).toBe("accepted");
      const read = await eventually(
        () => api.thoughts.get(brainId, id),
        (t) => t.kind === Type,
      );
      expect(read.kind).toBe(Type);
    }, 30_000);

    it("sync and rebuild give the row its kind, read from the live log, and a search leaves it out or takes it in", async () => {
      // The whole path, on rows whose documents do not change and on those
      // whose do. Each row used to keep the kind it was first indexed with.
      const plain = await make("kind-sync-plain");
      const tag = await make("kind-sync-tag", Tag);
      const captioned = await api.thoughts.create(brainId, {
        name: `${PREFIX}kind-sync-captioned`,
        label: "a caption",
      });
      created.push(captioned);
      const type = await make("kind-sync-type", Type);
      const parent = await make("kind-sync-parent");
      const child = await make("kind-sync-child");
      await putUnder(parent, Normal, child);

      const { embedder, documents } = recorder();
      const store = new VectorStore(":memory:");
      const indexer = new SemanticIndexer(api, store, embedder);
      const search = new SemanticSearch(api, store, embedder);
      // A rebuild, here and below, because the second half is about one: it
      // is set against an index of the whole brain, which only a rebuild
      // makes. Each reads the whole log and walks the brain.
      await indexer.rebuild(brainId);
      // As an index synced some time ago: the watermark is past everything
      // that made these thoughts, so a sync hears of them from the kind
      // change alone. A rebuild leaves it ten seconds back.
      await caughtUp(store);

      const kinds = (): Record<string, number | undefined> => {
        const rows = store.kinds();
        return {
          plain: rows.get(plain),
          tag: rows.get(tag),
          captioned: rows.get(captioned),
          type: rows.get(type),
          parent: rows.get(parent),
        };
      };
      /** Which of them a search returns: every row scores the same here. */
      const found = async (includeAuxiliary: boolean): Promise<string[]> => {
        const names = new Map([
          [plain, "plain"],
          [tag, "tag"],
          [captioned, "captioned"],
          [type, "type"],
          [parent, "parent"],
        ]);
        const { matches, mode } = await search.find(brainId, "anything", {
          limit: store.size(),
          includeAuxiliary,
        });
        expect(mode).toBe("vector");
        return matches.flatMap((m) => names.get(m.thoughtId) ?? []).sort();
      };
      expect(kinds()).toEqual({ plain: 1, tag: 4, captioned: 1, type: 2, parent: 1 });
      expect(await found(false)).toEqual(["captioned", "parent", "plain"]);

      const turned = async (changes: Array<[string, number]>): Promise<void> => {
        for (const [id, to] of changes) await api.thoughts.update(brainId, id, { kind: to });
        for (const [id, to] of changes) {
          await eventually(
            () => api.thoughts.getGraph(brainId, id),
            (g) => g.thought.kind === to,
          );
        }
      };
      await turned([
        [plain, Tag],
        [tag, Normal],
        [captioned, Type],
        [type, Normal],
        [parent, Tag],
      ]);
      await eventually(
        () => api.thoughts.getGraph(brainId, child),
        (g) => g.tags.some((t) => t.id === parent),
      );
      let from = documents.length;
      const synced = await indexer.sync(brainId);

      expect(kinds()).toEqual({ plain: 4, tag: 1, captioned: 2, type: 1, parent: 4 });
      expect(await found(false)).toEqual(["tag", "type"]);
      expect(await found(true)).toEqual(["captioned", "parent", "plain", "tag", "type"]);
      // Encoded again: the one whose document changed, a type that read with
      // its name for a label and reads with none now, and the thought under
      // the new tag. The other four rows got their kind and nothing else.
      expect(documents.slice(from).sort()).toEqual(
        [`${PREFIX}kind-sync-type`, `${PREFIX}kind-sync-child\ntags: ${PREFIX}kind-sync-parent`].sort(),
      );
      expect(synced).toMatchObject({ indexed: 2, kindUpdated: 4, skipped: 0, removed: 0 });

      // A rebuild with no sync before it: it compared hashes alone, and these
      // two documents are the ones they were.
      await turned([
        [plain, Normal],
        [captioned, Tag],
      ]);
      from = documents.length;
      const rebuilt = await indexer.rebuild(brainId);

      expect(kinds()).toEqual({ plain: 1, tag: 1, captioned: 4, type: 1, parent: 4 });
      expect(await found(false)).toEqual(["plain", "tag", "type"]);
      expect(documents.slice(from)).toEqual([]);
      expect(rebuilt).toMatchObject({ indexed: 0, kindUpdated: 2, removed: 0 });
      store.close();
    }, 180_000);

    it("a sync that runs before the graph shows the kind does not lose it", async () => {
      // The 304 is in the log when the patch is answered, and a graph that
      // has been read before shows the kind up to a quarter of a second later.
      const since = new Date().toISOString();
      const ids = [await make("kind-race-0"), await make("kind-race-1"), await make("kind-race-2")];
      const { embedder } = recorder();
      const { store, indexer } = await indexedSince(since, embedder);
      expect(ids.map((id) => store.kinds().get(id))).toEqual([Normal, Normal, Normal]);

      for (const id of ids) {
        await api.thoughts.update(brainId, id, { kind: Tag });
        const [event] = (await about([id])).filter((l) => l.modType === ModType.KindChanged);
        expect(event, "the 304 is not in the log when the patch is answered").toBeDefined();
        await indexer.sync(brainId);
      }
      for (const id of ids) {
        await eventually(
          () => api.thoughts.getGraph(brainId, id),
          (g) => g.thought.kind === Tag,
        );
      }
      await indexer.sync(brainId);

      const rows = store.kinds();
      expect(ids.map((id) => rows.get(id))).toEqual([Tag, Tag, Tag]);
      store.close();
    }, 60_000);
  });

  /**
   * The label of a type. Measured on TheBrain 15.0.640, 2026-10-13, 5 of 5
   * for each step (docs/api-map.md, L38). A thought with no label is given
   * its name for one when it becomes a type, born or turned, and a label
   * that is still its name is taken away when it stops being one. Neither is
   * logged. Nothing else touches it: a rename does not, so a type that was
   * renamed keeps the name it became a type under as its label, and keeps
   * it as an ordinary thought after. It is a label like any other: `remove`
   * clears it, and TheBrain's own search finds the type by it.
   */
  describe("the label a type is given", () => {
    const { Normal, Type, Tag } = ThoughtKind;
    const named = (word: string): string => `${PREFIX}type-label-${word}`;
    const renamed = async (id: string, name: string): Promise<ThoughtDto> => {
      await api.thoughts.update(brainId, id, { name });
      return eventually(() => api.thoughts.get(brainId, id), (t) => t.name === name);
    };
    const turned = async (id: string, kind: number): Promise<ThoughtDto> => {
      await api.thoughts.update(brainId, id, { kind });
      return eventually(() => api.thoughts.get(brainId, id), (t) => t.kind === kind);
    };
    /** What the log has of one thought, oldest first, as `modType old→new`. */
    const logged = async (id: string): Promise<string[]> =>
      (await newestLogs(1000))
        .filter((l) => l.sourceId === id)
        .sort((x, y) => compareLogTime(logTime(x), logTime(y)))
        .map((l) => `${l.modType} ${l.oldValue}→${l.newValue}`);

    it("a type with no label of its own has the name it became a type under for one, through every rename, and as an ordinary thought after", async () => {
      const born = await make("type-label-born", Type);
      const made = await make("type-label-made");
      expect((await api.thoughts.get(brainId, made)).label).toBeNull();
      await turned(made, Type);

      for (const [id, first] of [
        [born, named("born")],
        [made, named("made")],
      ] as const) {
        expect((await api.thoughts.get(brainId, id)).label, first).toBe(first);

        // A rename leaves it where it was, the first time and the second.
        expect((await renamed(id, `${first} two`)).label, first).toBe(first);
        const third = await renamed(id, `${first} three`);
        expect([third.label, third.cleanedUpName], first).toEqual([first, `${first} three`]);
        // The same in the list of types, and for a thought of that type.
        const listed = (await api.thoughts.listTypes(brainId)).find((t) => t.id === id);
        expect([listed?.name, listed?.label], first).toEqual([`${first} three`, first]);
        const instance = await api.thoughts.create(brainId, {
          name: `${first} instance`,
          typeId: id,
        });
        created.push(instance);
        const graph = await eventually(
          () => api.thoughts.getGraph(brainId, instance),
          (g) => g.type?.id === id,
        );
        expect(graph.type?.label, first).toBe(first);
        await api.links.detachType(brainId, instance, id);

        // No longer its name, so it stays when the thought stops being a type...
        expect((await turned(id, Normal)).label, first).toBe(first);
        expect((await turned(id, Tag)).label, first).toBe(first);
        expect((await turned(id, Type)).label, first).toBe(first);
        // ...and goes once it is the name again.
        expect((await renamed(id, first)).label, first).toBe(first);
        expect((await turned(id, Normal)).label, first).toBeNull();
        // Given again under the name the thought has now.
        await renamed(id, `${first} four`);
        expect((await turned(id, Type)).label, first).toBe(`${first} four`);
      }

      // None of it is in the log: no 202 beside the renames and the kinds.
      const entries = await logged(born);
      expect(entries.filter((e) => e.startsWith(`${ModType.LabelChanged} `))).toEqual([]);
      expect(entries.map((e) => Number(e.split(" ")[0]))).toEqual([
        ModType.Created,
        ModType.NameChanged,
        ModType.NameChanged,
        ModType.KindChanged,
        ModType.KindChanged,
        ModType.KindChanged,
        ModType.NameChanged,
        ModType.KindChanged,
        ModType.NameChanged,
        ModType.KindChanged,
      ]);
    }, 60_000);

    it("a patch of another field does not keep it, a label of the thought's own is left alone, and one removed stays away while the thought is a type", async () => {
      // Whatever else is patched while it is a type, the label is the name
      // and goes with the kind: it is not written by the patch.
      const coloured = await make("type-label-coloured", Type);
      await api.thoughts.update(brainId, coloured, { foregroundColor: "#ff7145" });
      await eventually(() => api.thoughts.get(brainId, coloured), (t) => t.foregroundColor !== null);
      expect((await api.thoughts.get(brainId, coloured)).label).toBe(named("coloured"));
      expect((await turned(coloured, Normal)).label).toBeNull();

      // A label it was given: through a rename and out of the kind.
      const own = await api.thoughts.create(brainId, {
        name: named("own"),
        kind: Type,
        label: "a caption",
      });
      created.push(own);
      expect((await eventually(() => api.thoughts.get(brainId, own), (t) => t.label !== named("own"))).label).toBe("a caption");
      expect((await renamed(own, named("own two"))).label).toBe("a caption");
      expect((await turned(own, Normal)).label).toBe("a caption");
      // The log has it as a change from the name the type was born with.
      expect(await logged(own)).toContain(`${ModType.LabelChanged} ${named("own")}→a caption`);

      // Removed, the name the type was renamed from is gone for good: null
      // while it is a type, through a rename, and as an ordinary thought.
      const cleared = await make("type-label-cleared", Type);
      await renamed(cleared, named("cleared two"));
      expect((await api.thoughts.get(brainId, cleared)).label).toBe(named("cleared"));
      await api.thoughts.update(brainId, cleared, { label: null });
      const gone = await eventually(() => api.thoughts.get(brainId, cleared), (t) => t.label === null);
      expect([gone.kind, gone.label]).toEqual([Type, null]);
      expect(await logged(cleared)).toContain(`${ModType.LabelChanged} ${named("cleared")}→null`);
      expect((await renamed(cleared, named("cleared three"))).label).toBeNull();
      expect((await turned(cleared, Normal)).label).toBeNull();
      // Only the kind gives it a label again, under the name it has by then.
      expect((await turned(cleared, Type)).label).toBe(named("cleared three"));

      // A tag has none, born or renamed.
      const tag = await make("type-label-tag", Tag);
      expect((await api.thoughts.get(brainId, tag)).label).toBeNull();
      expect((await renamed(tag, named("tag two"))).label).toBeNull();
    }, 60_000);

    it("the document a renamed type is embedded from holds its old name, and TheBrain's own search finds the type by it", async () => {
      // Why the label stays in the document (ARCHITECTURE.md §8): it is what
      // TheBrain stores for the type and finds it by, and a read cannot tell
      // it from a caption someone wrote. `brain_update_thought` with
      // `label: null` is what takes it away.
      const since = new Date().toISOString();
      const stamp = Date.now();
      const [was, is] = [`${PREFIX}formerly${stamp}`, `${PREFIX}presently${stamp}`];
      const id = await api.thoughts.create(brainId, { name: was, kind: Type });
      created.push(id);
      const plain = await api.thoughts.create(brainId, { name: `${PREFIX}plainly${stamp}` });
      created.push(plain);
      // Both are in the search's index before they are renamed.
      const found = async (word: string): Promise<string[]> =>
        (await api.search.inBrain(brainId, word, { maxResults: 10 })).map((h) => h.thought.id);
      await eventually(() => found(`plainly${stamp}`), (ids) => ids.includes(plain), {
        timeoutMs: 20_000,
        stepMs: 250,
      });
      await renamed(id, is);
      await renamed(plain, `${PREFIX}lately${stamp}`);

      /** The document of a thought with no aliases, type, tags or note, as the indexer builds it. */
      const documentOf = ({ id, name, kind, label }: ThoughtDto): string =>
        buildDocument({ id, name: name ?? "", kind, label });
      const graph = await api.thoughts.getGraph(brainId, id);
      expect(documentOf(graph.thought)).toBe(`${is}\n${was}`);
      const documents: string[] = [];
      const { store } = await indexedSince(since, {
        id: "contract@v1",
        dimensions: 1,
        embedDocuments: async (texts) => {
          documents.push(...texts);
          return texts.map(() => new Float32Array([1]));
        },
        embedQuery: async () => new Float32Array([1]),
      });
      expect(documents).toContain(`${is}\n${was}`);
      store.close();

      // Once the search has the renames, the old name of the type still
      // finds it, by its label, and the old name of the other finds nothing.
      await eventually(() => found(`lately${stamp}`), (ids) => ids.includes(plain), {
        timeoutMs: 20_000,
        stepMs: 250,
      });
      expect(await found(`plainly${stamp}`)).toEqual([]);
      const hits = await api.search.inBrain(brainId, `formerly${stamp}`, { maxResults: 10 });
      expect(hits.map((h) => [h.thought.id, h.thought.name, h.thought.label])).toEqual([[id, is, was]]);
      expect(await found(`presently${stamp}`)).toEqual([id]);

      // Cleared, the document is the name alone.
      await api.thoughts.update(brainId, id, { label: null });
      const cleared = await eventually(
        () => api.thoughts.getGraph(brainId, id),
        (g) => g.thought.label === null,
      );
      expect(documentOf(cleared.thought)).toBe(is);
    }, 90_000);
  });

  it("the log returns the newest entries first and truncates at maxLogs", async () => {
    // brain_recent_changes filters out settings before applying its limit
    // because of this: the newest entries can all be settings.
    const since = new Date().toISOString();
    for (const n of [1, 2, 3]) await make(`log-order-${n}`);
    const last = await make("log-order-4");
    // Both reads below must see the same log, so wait for the last write.
    const range = await eventually(
      () => api.brains.modifications(brainId, { maxLogs: 1000, since }),
      (entries) => entries.some((l) => l.sourceId === last),
    );
    // Nothing is written after the four creates, so the newest entries of
    // the brain are the newest of this range. It was the whole log that was
    // read for them, 3.5 s of it at 170,000 entries.
    expect(range.length).toBeGreaterThan(3);

    // No bound here, which is what the claim is about: the three kept are
    // the newest of the whole log, not its first three.
    const few = await api.brains.modifications(brainId, { maxLogs: 3 });
    expect(few).toHaveLength(3);
    const newestFirst = (x: string, y: string): number => compareLogTime(y, x);
    const newest = range.map(logTime).sort(newestFirst).slice(0, 3);
    expect(few.map(logTime).sort(newestFirst)).toEqual(newest); // truncation keeps the newest
    expect(few.map(logTime)).toEqual(newest); // and returns them newest first
    expect(few.map(logEntryKey)).toEqual(range.slice(0, 3).map(logEntryKey));
  }, 30_000);

  /** Creates a thought and returns its `created` log entry. */
  const createdEntry = async (name: string): Promise<ModificationLogDto> => {
    const id = await make(name);
    const logs = await eventually(
      () => newestLogs(50),
      (entries) => entries.some((l) => l.sourceId === id && l.modType === ModType.Created),
    );
    return logs.find((l) => l.sourceId === id && l.modType === ModType.Created)!;
  };

  it("log timestamps carry no offset and mean UTC, and endTime reads them the same way", async () => {
    // The log reader sends an entry's own timestamp back as endTime. Zones
    // differ by hours, so a minute of slack between TheBrain's clock and ours
    // still tells them apart. On a machine whose zone is UTC nothing can.
    const before = Date.now();
    const entry = await createdEntry("log-utc");
    const t = logTime(entry);
    expect(t).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,7})?$/);
    const skew = Math.abs(Date.parse(`${t}Z`) - before);
    expect(skew, `${t} read as UTC is ${skew} ms from the local clock`).toBeLessThan(60_000);

    const includes = async (until: string): Promise<boolean> =>
      (await api.brains.modifications(brainId, { maxLogs: 5, since: runStart, until })).some(
        (l) => logEntryKey(l) === logEntryKey(entry),
      );
    expect(await includes(t)).toBe(true);
    expect(await includes(`${t}Z`)).toBe(true);
    // An offset is honoured, so the agreement above is not the API ignoring
    // zones altogether: an hour east of UTC is an hour earlier.
    expect(await includes(`${t}+01:00`)).toBe(false);
  }, 30_000);

  it("endTime and startTime are inclusive to the microsecond", async () => {
    // Of the entry's modificationDateTime. Its creationDateTime is the same
    // string 49 times in 50, which made this test fail on the fiftieth.
    const entry = await createdEntry("log-bounds");
    const t = logTime(entry);
    const key = logEntryKey(entry);
    // From the start of the run where the range names no start: a range
    // open at that end costs a request the length of the log.
    const within = async (range: { since?: string; until?: string }): Promise<boolean> =>
      (await api.brains.modifications(brainId, { maxLogs: 1000, since: runStart, ...range })).some(
        (l) => logEntryKey(l) === key,
      );

    expect(await within({ until: t })).toBe(true);
    expect(await within({ until: shiftMicros(t, -1) })).toBe(false);
    expect(await within({ since: t })).toBe(true);
    expect(await within({ since: shiftMicros(t, 1) })).toBe(false);

    // Why the reader never passes a boundary through Date: milliseconds cut
    // the entry off. Only observable when the timestamp has sub-millisecond digits.
    const fraction = t.split(".")[1] ?? "";
    if (fraction.length > 3) {
      expect(await within({ until: new Date(`${t}Z`).toISOString() })).toBe(false);
    }
  }, 30_000);

  it("the log is ordered and filtered by modificationDateTime, which can be later than creationDateTime", async () => {
    // Measured over 11,205 entries: 258 were filed a microsecond after their
    // creation and the rest at it, one write at a time as often as in a burst.
    // A type change was up to 10 µs late, a note change up to 56 µs, and five
    // note changes in a working brain 0.8 to 3.9 ms. The log reader pages on
    // the later one because of what this test pins.
    // Among what this run has logged, some thousand entries by now: one in
    // forty is such an entry. The whole log is not read for it.
    const newest = (): Promise<ModificationLogDto[]> => newestLogs(10_000);
    const late = (l: ModificationLogDto): boolean =>
      compareLogTime(l.modificationDateTime, l.creationDateTime) > 0;
    let logs = await newest();
    // A run may have logged none yet. Three hundred creates gave three.
    for (let round = 0; !logs.some(late) && round < 10; round++) {
      const ids = new Set(
        await makeAtOnce(Array.from({ length: 100 }, (_, i) => `log-late-${round}-${i}`)),
      );
      logs = await eventually(
        newest,
        (entries) => entries.filter((l) => ids.has(l.sourceId)).length >= ids.size,
      );
    }
    const entry = logs.find(late);
    expect(entry, "no entry filed later than it was created").toBeDefined();

    expect(logs.filter((l) => compareLogTime(l.modificationDateTime, l.creationDateTime) < 0)).toEqual([]);
    for (let i = 1; i < logs.length; i++) {
      expect(compareLogTime(logTime(logs[i - 1]!), logTime(logs[i]!))).toBeGreaterThanOrEqual(0);
    }

    const key = logEntryKey(entry!);
    const created = entry!.creationDateTime;
    const filed = entry!.modificationDateTime;
    const within = async (range: { since?: string; until?: string }): Promise<boolean> =>
      (await api.brains.modifications(brainId, { maxLogs: 1000, since: runStart, ...range })).some(
        (l) => logEntryKey(l) === key,
      );
    // startTime: compared with creation, this range would start after the entry.
    expect(await within({ since: filed, until: filed })).toBe(true);
    // endTime: compared with creation, this range would still reach the entry.
    expect(await within({ until: created })).toBe(false);
    expect(await within({ since: created, until: created })).toBe(false);
  }, 120_000);

  it("startTime does not change which end truncation keeps", async () => {
    // The OpenAPI description says maxLogs counts "beginning from the
    // startTime". It does not: with startTime the newest entries are still the
    // ones kept, which is what made sync drop the oldest changes.
    const since = new Date().toISOString();
    const names = ["log-since-1", "log-since-2", "log-since-3", "log-since-4"];
    for (const name of names) await make(name);
    const range = await eventually(
      () => api.brains.modifications(brainId, { maxLogs: 1000, since }),
      (entries) => entries.length >= names.length,
    );

    const two = await api.brains.modifications(brainId, { maxLogs: 2, since });
    expect(two.map(logEntryKey)).toEqual(range.slice(0, 2).map(logEntryKey));
    expect(two.map(logEntryKey)).not.toContain(logEntryKey(range.at(-1)!));
  }, 30_000);

  /**
   * A paged read against one request for the same range: every entry once,
   * newest first. Nothing may be written between the two reads. A new entry
   * would be in one of them only, and a note changed again takes its 803 out
   * of its place, as "a run of note changes in the log" pins. Neither caller
   * writes while it reads.
   */
  const sameEntries = (paged: ModificationLogDto[], whole: ModificationLogDto[]): void => {
    expect(paged.map(logEntryKey).sort()).toEqual(whole.map(logEntryKey).sort());
    for (let i = 1; i < paged.length; i++) {
      const order = compareLogTime(logTime(paged[i - 1]!), logTime(paged[i]!));
      expect(order).toBeGreaterThanOrEqual(0);
    }
  };

  it("concurrent writes share timestamps, and paging keeps every tied entry once", async () => {
    // Only concurrency produces them: a single request that logs several
    // entries (a cascade delete, a first note) stamps each one apart. Measured
    // over repeated bursts of concurrent creates: 30 at once shared a timestamp
    // in about half the bursts, 100 at once in 57 bursts of 59, 4 times at the
    // median and 11 at the most. That is with the app to itself. With four
    // writers at work in another brain a burst shared one 2 times in 5, and
    // three rounds, which is what this had, came up empty in a run beside
    // another session's. Hence the eight, of which a quiet app needs one.
    const BURST = 100;
    const ROUNDS = 8;
    // Of the last round alone, so that what is paged below is one burst
    // however many it took.
    let since = "";
    let tied = false;
    for (let round = 0; round < ROUNDS && !tied; round++) {
      since = new Date().toISOString();
      const before = unanswered;
      const made = await makeAtOnce(Array.from({ length: BURST }, (_, i) => `log-tie-${round}-${i}`));
      // A create that got the 403 is logged as well, and may be a moment
      // behind its answer: nothing below may be written between two reads.
      if (unanswered > before) await settle(1000);
      const burst = await eventually(
        () => api.brains.modifications(brainId, { maxLogs: 10_000, since }),
        (entries) => entries.length >= made.length,
      );
      const times = burst.map(logTime);
      tied = new Set(times).size < times.length;
    }
    expect(tied, `no two creates of ${BURST} sent at once shared a timestamp, ${ROUNDS} times`).toBe(
      true,
    );

    // A page of two is bound to split a tie, and often to be filled by one: a
    // pager that dropped the entries stamped at its boundary lost one in each
    // of 32 such bursts read back from the log.
    sameEntries(
      await api.brains.allModifications(brainId, { since, pageSize: 2 }),
      await api.brains.modifications(brainId, { maxLogs: 10_000, since }),
    );
    // The same for the newest thousand entries, whatever wrote them, at
    // another page size. This was the whole log, and a test brain's log only
    // grows: at 52,000 entries it took 2,291 requests and 34 s, and past
    // 100,000 the one request it was compared with would have come back short.
    const recent = await newestLogs(1_000);
    const from = logTime(recent.at(-1)!);
    sameEntries(
      await api.brains.allModifications(brainId, { since: from, pageSize: 25 }),
      await api.brains.modifications(brainId, { maxLogs: 10_000, since: from }),
    );
  }, 120_000);

  it("a page that ends on an entry filed after its creation keeps the one filed beside it", async (ctx) => {
    // What the first pager lost. It took a page's oldest creationDateTime as
    // the next endTime, and a range that ends there leaves out whatever was
    // filed later. That takes an entry filed a microsecond after its creation
    // and listed just ahead of one filed in that same microsecond: 23 pairs
    // among the 336,066 entries of two test brains, every one of them two
    // creates sent at once, about one burst of 100 in twelve. The comparisons
    // above do not show it unless a page happens to end on such a pair: with
    // a copy of that pager they came out equal, at pages of 2 and of 25, over
    // ranges that held one. A pair cannot be had to order: a burst gives one
    // in twelve, and a note changed alongside a burst was filed at its
    // creation 8 times of 8. So this looks back for the nearest one and
    // reads the stretch of the log around it.
    //
    // It looked through the newest 50,000 entries and no further, and on a
    // brain whose nearest pair was 111,039 entries back it skipped itself
    // run after run: the pairs lie 9,000 entries apart in one of those logs
    // and 34,000 in the other. It now looks five times as far, a page at a
    // time, and stops at the first pair. That is the most it reads however
    // long the log is, and a log with no pair in that stretch still cannot
    // show it: a new brain has none.
    const REACH = 250_000;
    const PAGE = 50_000;
    const newest: ModificationLogDto[] = [];
    let at = -1;
    for await (const page of api.brains.modificationPages(brainId, { pageSize: PAGE })) {
      let i = Math.max(newest.length - 1, 0);
      newest.push(...page);
      for (; i < newest.length - 1 && at < 0; i++) {
        if (compareLogTime(logTime(newest[i + 1]!), newest[i]!.creationDateTime) > 0) at = i;
      }
      if (at >= 0 || newest.length >= REACH) break;
    }
    if (at < 0) {
      ctx.skip(
        `no entry filed between another's creation and its filing in the newest ${newest.length}`,
      );
    }
    const last = newest[at]!;
    const since = logTime(newest[at + 1]!);
    // The stretch starts a few entries above the pair, at one that is not
    // tied with the entry before it: a range that ends there begins with it.
    let top = Math.max(at - 3, 0);
    while (top > 0 && compareLogTime(logTime(newest[top - 1]!), logTime(newest[top]!)) === 0) {
      top -= 1;
    }
    const until = logTime(newest[top]!);

    // Read as one range and as pages of it, the first of which ends on the
    // entry filed late. Neither read goes by how far back the pair lies.
    const whole = await api.brains.modifications(brainId, { maxLogs: 10_000, since, until });
    const pages: ModificationLogDto[][] = [];
    for await (const page of api.brains.modificationPages(brainId, {
      since,
      until,
      pageSize: at - top + 1,
    })) {
      pages.push(page);
    }
    // The first page ends where it was aimed, on the entry filed late...
    expect(logEntryKey(pages[0]!.at(-1)!)).toBe(logEntryKey(last));
    // ...and the next one still brings its neighbour.
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat().map(logEntryKey)).toContain(logEntryKey(newest[at + 1]!));
    sameEntries(pages.flat(), whole);
  }, 120_000);

  it("set replaces the note entirely", async () => {
    const id = await make("overwrite");
    await api.notes.set(brainId, id, "before");
    await eventually(
      () => api.notes.get(brainId, id),
      (t) => t === "before",
    );
    await api.notes.set(brainId, id, "after");
    const text = await eventually(
      () => api.notes.get(brainId, id),
      (t) => t === "after",
    );
    expect(text).toBe("after");
  });

  describe("a type and a tag made through the API", () => {
    const { Normal, Type, Tag } = ThoughtKind;
    /** Unique to the run: a tag left by an earlier one would be answered with. */
    const run = Date.now().toString(36);
    const named = (name: string): string => `${PREFIX}vocab-${run}-${name}`;
    /** The create as the API takes it, with none of the client's checks. */
    const rawCreate = async (body: Record<string, unknown>): Promise<string> => {
      const { id } = await api.client.post<{ id: string }>(`/api/thoughts/${brainId}`, {
        json: { acType: 0, ...body },
      });
      created.push(id);
      return id;
    };
    /** A thought's own entries, the ones `createTypeOrTag` reads. */
    const own = (id: string): Promise<ModificationLogDto[]> =>
      api.thoughts.modifications(brainId, id, { maxLogs: 100, includeRelated: false });
    const listOf = (kind: number): Promise<ThoughtDto[]> =>
      kind === Type ? api.thoughts.listTypes(brainId) : api.thoughts.listTags(brainId);

    it("is made with kind 2 or 4 and answered with an identifier alone; it reads at once, with one 101 of its own", async () => {
      for (const kind of [Type, Tag]) {
        const answer = await api.client.post<Record<string, unknown>>(
          `/api/thoughts/${brainId}`,
          { json: { name: named(`made-${kind}`), kind, acType: 0 } },
        );
        const id = answer["id"] as string;
        created.push(id);
        expect(Object.keys(answer)).toEqual(["id"]);
        const read = await api.thoughts.get(brainId, id);
        // A type reads with its name for a label, and no 202 says so.
        expect([read.kind, read.label, read.typeId]).toEqual([
          kind,
          kind === Type ? read.name : null,
          null,
        ]);
        expect((await own(id)).map((l) => [l.modType, l.sourceType, l.newValue])).toEqual([
          [ModType.Created, EntityType.Thought, named(`made-${kind}`)],
        ]);
      }
    });

    it("/types and /tags list a new one a moment after its create, not always at once", async () => {
      // Measured: 10 of 66 at the first read, the last listed 417 ms on; and
      // on 2026-10-14 a type 4 times of 40 with the app to itself and once in
      // 40 with another contract run at work in it. This asked for one of
      // twelve to be late; it makes a type and a tag a round until one is,
      // forty at the most, which seven in ten listed at once would fail one
      // run in a million.
      const TRIES = 20;
      let late = -1;
      for (let i = 0; i < TRIES && late < 0; i++) {
        for (const kind of [Type, Tag]) {
          const id = await rawCreate({ name: named(`listed-${kind}-${i}`), kind });
          if (!(await listOf(kind)).some((t) => t.id === id) && late < 0) late = i;
          const later = await eventually(
            () => listOf(kind),
            (list) => list.some((t) => t.id === id),
            { stepMs: 20 },
          );
          expect(later.some((t) => t.id === id)).toBe(true);
        }
      }
      expect(
        late,
        `${2 * TRIES} creates of ${2 * TRIES} were listed at once: either the app was busy at ` +
          "every one of them, or the lists are no longer a copy behind a create (L39)",
      ).toBeGreaterThanOrEqual(0);
    }, 60_000);

    it("a tag made again under its name is the one there: at once, after another write, in another case, and nothing of it changes", async () => {
      const name = named("again");
      const first = await rawCreate({ name, kind: Tag });
      await api.thoughts.update(brainId, first, { label: "kept", foregroundColor: "#ff0000" });
      const before = await eventually(
        () => api.thoughts.get(brainId, first),
        (t) => t.label === "kept" && t.foregroundColor === "#ff0000",
      );
      const entries = await eventually(
        () => own(first),
        (l) => l.length === 3,
      );

      expect(await rawCreate({ name, kind: Tag })).toBe(first);
      await make("again-between");
      expect(await rawCreate({ name, kind: Tag })).toBe(first);
      expect(await rawCreate({ name: name.toUpperCase(), kind: Tag })).toBe(first);

      await settle(500);
      const after = await api.thoughts.get(brainId, first);
      const kept = (t: ThoughtDto) => [
        t.name,
        t.label,
        t.foregroundColor,
        aliasesOf(t),
        t.modificationDateTime,
      ];
      expect(kept(after)).toEqual(kept(before));
      expect(await own(first)).toEqual(entries);
    });

    it("a label, aliases or a source sent with the name of a tag that is there are written onto that tag", async () => {
      const labelled = await rawCreate({ name: named("onto"), kind: Tag });
      expect(
        await rawCreate({
          name: named("onto"),
          kind: Tag,
          label: "written over",
          aliases: [named("onto-alias")],
        }),
      ).toBe(labelled);
      const read = await eventually(
        () => api.thoughts.get(brainId, labelled),
        (t) => t.label === "written over" && aliasesOf(t).length === 1,
      );
      expect([read.label, aliasesOf(read)]).toEqual(["written over", [named("onto-alias")]]);

      // Under each relation the tag that is there is attached to the source.
      for (const relation of [Relation.Child, Relation.Parent, Relation.Jump]) {
        const tag = await rawCreate({ name: named(`sourced-${relation}`), kind: Tag });
        const source = await make(`vocab-${run}-source-${relation}`);
        expect(
          await rawCreate({
            name: named(`sourced-${relation}`),
            kind: Tag,
            sourceThoughtId: source,
            relation,
          }),
        ).toBe(tag);
        const link = await eventually(
          () => api.links.between(brainId, source, tag),
          (l) => l !== null,
        );
        expect([link?.meaning, link?.thoughtIdA], `relation ${relation}`).toEqual([
          LinkMeaning.Tag,
          tag,
        ]);
      }
    });

    it("a tag deleted is not answered with: its name makes a new one at once", async () => {
      const name = named("deleted");
      const gone = await rawCreate({ name, kind: Tag });
      await settle(300);
      await api.thoughts.delete(brainId, gone);
      const again = await rawCreate({ name, kind: Tag });
      expect(again).not.toBe(gone);
      expect((await api.thoughts.get(brainId, again)).kind).toBe(Tag);
    });

    it("tag names are one when they differ in letter case, in characters that do not show and in the form of a character, and not otherwise", async () => {
      // On 15.0.640 on macOS: 95 pairs, each two or three times, every one
      // the same answer each time. These are some of each.
      const ONE: Array<[string, string]> = [
        ["Tag name", "TAG NAME"],
        ["\u0442\u0435\u0433", "\u0422\u0415\u0413"],
        ["r\u00e9sum\u00e9", "re\u0301sume\u0301"],
        ["tagname", "tag\u200bname"],
        ["tagname", "tag\u0001name"],
        ["tag name", "tag\u00a0name"],
        ["file", "\ufb01le"],
        ["tag 2", "tag \u00b2"],
        ["tag 1", "tag \u0661"],
        ["wait...", "wait\u2026"],
      ];
      const TWO: Array<[string, string]> = [
        ["r\u00e9sum\u00e9", "resume"],
        ["tag name", "tag  name"],
        ["Tag", "\uff34\uff41\uff47"],
        ["co-op", "coop"],
        ["stra\u00dfe", "strasse"],
        ["tagname", "tag\u2800name"],
        ["title", "t\u0131tle"],
        ["\u30ab\u30ca", "\u304b\u306a"],
        ["tag name", "tag\rname"],
      ];
      let i = 0;
      const same = async ([a, b]: [string, string]): Promise<boolean> => {
        const prefix = named(`pair-${(i += 1)}`);
        const first = await rawCreate({ name: `${prefix} ${a}`, kind: Tag });
        return (await rawCreate({ name: `${prefix} ${b}`, kind: Tag })) === first;
      };
      for (const pair of ONE) expect(await same(pair), JSON.stringify(pair)).toBe(true);
      for (const pair of TWO) expect(await same(pair), JSON.stringify(pair)).toBe(false);

      // A name of such characters alone is one name with any other.
      const blank = await rawCreate({ name: "\u200b", kind: Tag });
      expect(await rawCreate({ name: "\ufeff", kind: Tag })).toBe(blank);
      expect(await rawCreate({ name: "\u0001", kind: Tag })).toBe(blank);
      expect((await api.thoughts.get(brainId, blank)).name).toBe("\u200b");
    });

    it("a type is made again under a name a type has, and a tag's name is matched among tags alone", async () => {
      const name = named("namesake");
      const type = await rawCreate({ name, kind: Type });
      const second = await rawCreate({ name, kind: Type });
      expect(second).not.toBe(type);
      expect(await rawCreate({ name: name.toUpperCase(), kind: Type })).not.toBe(second);

      const thought = await rawCreate({ name, kind: Normal });
      const tag = await rawCreate({ name, kind: Tag });
      expect([type, second, thought]).not.toContain(tag);
      expect(await rawCreate({ name, kind: Normal })).not.toBe(thought);
    });

    it("two creates of one new tag name sent at once are now and then two tags", async () => {
      let rounds = 0;
      let split = 0;
      for (; rounds < 8 && split === 0; rounds += 1) {
        const name = named(`at-once-${rounds}`);
        const ids = await Promise.all([1, 2, 3, 4].map(() => rawCreate({ name, kind: Tag })));
        if (new Set(ids).size > 1) split += 1;
      }
      // Measured: two at once made two tags 5 times of 10, four at once more
      // than one 9 times of 10.
      expect(split).toBe(1);
    });

    it("createTypeOrTag tells a tag it made from one it was answered with, one call at a time", async () => {
      const name = named("told");
      const made = await api.thoughts.createTypeOrTag(brainId, { name, kind: Tag });
      created.push(made.id);
      expect([made.created, made.thought?.name, made.thought?.kind]).toEqual([true, name, Tag]);

      // Straight after, with the newest entry of the log its own 101.
      const again = await api.thoughts.createTypeOrTag(brainId, {
        name: name.toUpperCase(),
        kind: Tag,
      });
      expect([again.id, again.created, again.thought?.name]).toEqual([made.id, false, name]);

      // In use: its own entries are its own alone, and its 101 among them.
      for (const n of [1, 2, 3]) await api.links.attachTag(brainId, await make(`told-${n}`), made.id);
      const ownEntries = await own(made.id);
      expect(ownEntries.map((l) => l.modType)).toEqual([ModType.Created]);
      expect(
        (await api.thoughts.modifications(brainId, made.id, { includeRelated: true })).length,
      ).toBeGreaterThan(1);
      expect(
        (await api.thoughts.createTypeOrTag(brainId, { name, kind: Tag })).created,
      ).toBe(false);

      // A type is made every time, and said to be.
      for (const n of [1, 2]) {
        const type = await api.thoughts.createTypeOrTag(brainId, { name, kind: Type });
        created.push(type.id);
        expect([type.created, type.thought?.kind], `type ${n}`).toEqual([true, Type]);
      }

      // Four at once from one process are one tag: the second and later
      // wait for the one ahead, and are answered with what it made.
      for (let round = 0; round < 3; round++) {
        const outcomes = await Promise.all(
          [1, 2, 3, 4].map(() =>
            api.thoughts.createTypeOrTag(brainId, { name: named(`chained-${round}`), kind: Tag }),
          ),
        );
        created.push(...outcomes.map((o) => o.id));
        expect(new Set(outcomes.map((o) => o.id)).size, `round ${round}`).toBe(1);
        expect(outcomes.map((o) => o.created)).toEqual([true, false, false, false]);
      }
    }, 30_000);

    it("a source or a typeId makes a link whose meaning goes by the kinds at its ends", async () => {
      const source: Record<number, string> = {
        [Normal]: await make(`vocab-${run}-src`),
        [Type]: await rawCreate({ name: named("src-type"), kind: Type }),
        [Tag]: await rawCreate({ name: named("src-tag"), kind: Tag }),
      };
      const C = Relation.Child;
      const P = Relation.Parent;
      const J = Relation.Jump;
      /** What a new thought of `kind` made by `how` towards a thought of kind `at` is to it. */
      const CASES: Array<[kind: number, at: number, how: number | "typeId", made: string]> = [
        [Type, Normal, C, "1 r1, the source above"],
        [Type, Normal, P, "2 r1, the new one above; the source's type"],
        [Type, Normal, J, "1 r3, the source above"],
        [Type, Type, C, "403"],
        [Type, Type, P, "3 r1, the new one above; the source's type"],
        [Type, Type, J, "1 r3, the source above"],
        [Type, Tag, C, "5 r1, the source above"],
        [Type, Tag, P, "no link"],
        [Type, Tag, J, "1 r3, the source above"],
        [Type, Normal, "typeId", "1 r1, the source above"],
        [Type, Type, "typeId", "403"],
        [Type, Tag, "typeId", "5 r1, the source above"],
        [Tag, Normal, C, "1 r1, the source above"],
        [Tag, Normal, P, "5 r1, the new one above"],
        [Tag, Normal, J, "1 r3, the source above"],
        [Tag, Type, C, "no link"],
        [Tag, Type, P, "5 r1, the new one above"],
        [Tag, Type, J, "1 r3, the source above"],
        [Tag, Tag, C, "403"],
        [Tag, Tag, P, "7 r1, the new one above"],
        [Tag, Tag, J, "1 r3, the source above"],
        [Tag, Normal, "typeId", "1 r1, the source above"],
        [Tag, Type, "typeId", "no link"],
        [Tag, Tag, "typeId", "403"],
      ];
      const made: Array<{ id: string | null; at: string; name: string }> = [];
      for (const [i, [kind, at, how]] of CASES.entries()) {
        const name = named(`case-${i}`);
        const body =
          how === "typeId"
            ? { name, kind, typeId: source[at]! }
            : { name, kind, sourceThoughtId: source[at]!, relation: how };
        let id: string | null = null;
        try {
          id = await rawCreate(body);
        } catch (error) {
          expect((error as TheBrainError).kind, `case ${i}`).toBe("forbidden");
        }
        made.push({ id, at: source[at]!, name });
      }
      await settle(600);
      const typeOf = new Map<string, string | null>();
      for (const at of [source[Normal]!, source[Type]!]) {
        typeOf.set(at, (await api.thoughts.get(brainId, at)).typeId);
      }
      const listed = new Set(
        [...(await api.thoughts.listTypes(brainId)), ...(await api.thoughts.listTags(brainId))].map(
          (t) => t.name,
        ),
      );
      for (const [i, { id, at, name }] of made.entries()) {
        let seen: string;
        if (id === null) {
          // Nothing of that name was made.
          seen = listed.has(name) ? "403, and made" : "403";
        } else {
          const link = await api.links.between(brainId, at, id);
          seen =
            link === null
              ? "no link"
              : `${link.meaning} r${link.relation}, ` +
                `${link.thoughtIdA === at ? "the source" : "the new one"} above` +
                (typeOf.get(at) === id ? "; the source's type" : "");
        }
        expect(seen, `case ${i}: ${JSON.stringify(CASES[i]!.slice(0, 3))}`).toBe(CASES[i]![3]);
      }
    }, 60_000);

    it("a label and aliases are stored with a new one, colours are not taken, and a name past 1,024 units is cut", async () => {
      for (const kind of [Type, Tag]) {
        const id = await rawCreate({
          name: named(`dressed-${kind}`),
          kind,
          label: "a caption",
          aliases: [named(`dressed-alias-${kind}`)],
          foregroundColor: "#ff0000",
          backgroundColor: "#00ff00",
        });
        // Read until the label and the aliases are there, as aliases are
        // behind a create now and then (*aliases*, below). With another
        // session at work in the app, a first read here had neither, and
        // the test went red on it. Measured on 2026-10-14, 40 creates each:
        // every first read had both with the app to itself, and 39 of 40
        // with another contract run at work in it, the 40th 80 ms later.
        // The colours were not there 0.3 s on either, 80 times of 80.
        const read = await eventually(
          () => api.thoughts.get(brainId, id),
          (t) => t.label === "a caption" && aliasesOf(t).length > 0,
        );
        expect([read.label, aliasesOf(read), read.foregroundColor, read.backgroundColor]).toEqual([
          "a caption",
          [named(`dressed-alias-${kind}`)],
          null,
          null,
        ]);
        const long = await rawCreate({ name: named(`long-${kind}-`).padEnd(1025, "x"), kind });
        expect((await api.thoughts.get(brainId, long)).name).toHaveLength(1024);
      }
    });

    it("a sync gives a type and a tag made through createTypeOrTag rows of their kind, and a default search leaves them out", async () => {
      const since = new Date().toISOString();
      const plain = await make(`vocab-${run}-index-plain`);
      const embedder: Embedder = {
        id: "contract@v1",
        dimensions: 1,
        embedDocuments: async (texts) => texts.map(() => new Float32Array([1])),
        embedQuery: async () => new Float32Array([1]),
      };
      // Filled from the test's start, not rebuilt: the claim is the sync's.
      const { store, indexer } = await indexedSince(since, embedder);
      const search = new SemanticSearch(api, store, embedder);
      // Past the log, so that the creates below are all the sync goes by.
      await caughtUp(store);

      const tag = await api.thoughts.createTypeOrTag(brainId, { name: named("index-tag"), kind: Tag });
      const type = await api.thoughts.createTypeOrTag(brainId, {
        name: named("index-type"),
        kind: Type,
      });
      created.push(tag.id, type.id);
      await indexer.sync(brainId);

      const kinds = store.kinds();
      expect([kinds.get(plain), kinds.get(tag.id), kinds.get(type.id)]).toEqual([Normal, Tag, Type]);
      const found = async (includeAuxiliary: boolean): Promise<string[]> =>
        (
          await search.find(brainId, "anything", { limit: store.size(), includeAuxiliary })
        ).matches.map((m) => m.thoughtId);
      const plainly = await found(false);
      expect(plainly).toContain(plain);
      expect(plainly).not.toContain(tag.id);
      expect(plainly).not.toContain(type.id);
      expect(await found(true)).toEqual(expect.arrayContaining([plain, tag.id, type.id]));
      store.close();
    }, 90_000);
  });

  it("the log reconstructs contents that agree with statistics", async () => {
    // Holds for a brain whose thoughts were all created in it, like a test
    // brain. Imported and old brains fall short, which is why a rebuild also
    // walks the graph (ARCHITECTURE.md §7).
    //
    // The whole log, which the claim is about: 3.5 s of reading at 170,000
    // entries with the app to itself and several times that with another
    // session at it, where the five seconds a test has by default were not
    // enough two runs in three.
    const logs = await api.brains.allModifications(brainId);
    const alive = replayThoughtIds(logs);

    let normal = 0;
    let types = 0;
    for (const id of alive) {
      const t = await api.thoughts.get(brainId, id).catch(() => null);
      if (t === null) continue;
      if (t.kind === ThoughtKind.Normal) normal += 1;
      else if (t.kind === ThoughtKind.Type) types += 1;
    }

    // Statistics counts a thought at the first read after it is made or
    // deleted, and types from a copy that is seconds behind after a burst
    // of writes (*statistics counts…*, below): so it is asked until it
    // agrees, and the test fails when it never does.
    const counted = (s: { thoughts: number; thoughtTypes: number }): number[] => [
      Math.round(s.thoughts),
      Math.round(s.thoughtTypes),
    ];
    const stats = await eventually(
      () => api.brains.statistics(brainId),
      (s) => counted(s).join() === [normal, types].join(),
      { timeoutMs: 20_000, stepMs: 250 },
    );
    expect(counted(stats)).toEqual([normal, types]);
  }, 120_000);

  it("statistics counts a thought, a link, a note and a web link at the first read after the write, and types and tags from a copy that is behind", async () => {
    // Measured on TheBrain 15.0.640, 2026-10-13. `thoughts` was right at the
    // first read after 19 creates and 19 deletes one at a time, after eight
    // bursts of 30 and of 100 creates sent at once, and after eight sweeps
    // of 100 to 350 deletes; `links`, `notes` and `webLinks` 10 times of 10
    // each. `thoughtTypes` and `tags` are another matter: after one type or
    // tag made or deleted the first read was wrong 38 times in 52 and right
    // 0.04 to 0.9 s later; a type and a tag made straight after a burst of
    // 100 creates were counted 2.8 to 6.6 s later (5 of 5), and deleted at
    // the end of a sweep they were still counted at the first read 4 times
    // in 5, for up to 2.2 s.
    type Counts = { thoughts: number; links: number; notes: number; webLinks: number };
    const now = async (): Promise<Counts> => {
      const { thoughts, links, notes, webLinks } = await api.brains.statistics(brainId);
      return { thoughts, links, notes, webLinks };
    };
    const kinds = async (): Promise<number[]> => {
      const s = await api.brains.statistics(brainId);
      return [s.thoughtTypes, s.tags];
    };
    // What the two lagging counts settle at, before anything is added here.
    let was = await kinds();
    for (let same = 0; same < 3; ) {
      await settle(700);
      const next = await kinds();
      same = next.join() === was.join() ? same + 1 : 0;
      was = next;
    }
    const base = await now();

    const a = await make("stats-a");
    expect(await now()).toEqual({ ...base, thoughts: base.thoughts + 1 });
    const b = await make("stats-b");
    const link = await api.links.create(brainId, {
      thoughtIdA: a,
      thoughtIdB: b,
      relation: Relation.Jump,
    });
    expect(await now()).toEqual({ ...base, thoughts: base.thoughts + 2, links: base.links + 1 });
    await api.notes.set(brainId, a, "counted");
    await api.attachments.attachUrl(brainId, a, `https://example.com/${PREFIX}stats-${Date.now()}`, {
      name: `${PREFIX}stats`,
    });
    const full = {
      thoughts: base.thoughts + 2,
      links: base.links + 1,
      notes: base.notes + 1,
      webLinks: base.webLinks + 1,
    };
    expect(await now()).toEqual(full);

    // A type and a tag are no thoughts to it, and are counted in time.
    const typeId = await make("stats-type", ThoughtKind.Type);
    const tagId = await make("stats-tag", ThoughtKind.Tag);
    expect(await now()).toEqual(full);
    const both = [was[0]! + 1, was[1]! + 1];
    expect(
      await eventually(kinds, (k) => k.join() === both.join(), { timeoutMs: 20_000, stepMs: 100 }),
    ).toEqual(both);

    // Deleted, each is gone from its count at the first read as well.
    await api.links.delete(brainId, link);
    expect(await now()).toEqual({ ...full, links: base.links });
    // Not straight after its link: a thought deleted a few milliseconds
    // after a neighbour's delete took a link of its own now and then stays
    // in the search for good (L34). A link deleted alone was not measured
    // apart; the second costs the test nothing it measures.
    await settle(APART_MS);
    await api.thoughts.delete(brainId, b);
    expect(await now()).toEqual({ ...full, links: base.links, thoughts: base.thoughts + 1 });
    await settle(350);
    await api.thoughts.delete(brainId, typeId);
    await settle(350);
    await api.thoughts.delete(brainId, tagId);
    expect(
      await eventually(kinds, (k) => k.join() === was.join(), { timeoutMs: 20_000, stepMs: 100 }),
    ).toEqual(was);
  }, 90_000);

  it("a link between thoughts is created and found", async () => {
    const a = await make("link-A");
    const b = await make("link-B");
    const linkId = await api.links.create(brainId, {
      thoughtIdA: a,
      thoughtIdB: b,
      relation: 3,
      name: "probe",
    });
    const found = await api.links.between(brainId, a, b);
    expect(found?.id).toBe(linkId);
    expect(found?.name).toBe("probe");
    await api.links.delete(brainId, linkId);
    await expect(api.links.between(brainId, a, b)).resolves.toBeNull();
  });

  /**
   * Measured on TheBrain 15.0.640. The matching rules are what the OpenAPI
   * description says. That a location is stored as given, that the API attaches
   * a second copy, and how soon each read sees a new attachment are not in it.
   */
  describe("URL attachments", () => {
    /** Straight through the API, and with a name, so that no page title is fetched. */
    const attach = (id: string, url: string): Promise<unknown> =>
      api.attachments.attachUrl(brainId, id, url, { name: `${PREFIX}link`, deduplicate: false });
    const found = async (location: string): Promise<boolean> =>
      (await api.attachments.byLocation(brainId, location)).length > 0;
    const locations = async (id: string): Promise<string[]> =>
      (await api.attachments.ofThought(brainId, id)).map((a) => a.location ?? "");

    it("by-location ignores the scheme and the trailing slashes, and nothing else", async () => {
      const id = await make("by-location");
      // Unique to the run: the lookup spans the whole brain.
      const page = `example.com/${PREFIX}loc-${Date.now()}/Page`;
      await attach(id, `https://${page}`);
      await attach(id, `https://${page}/Sub?Q=Abc`);

      const spellings = {
        "as stored": `https://${page}`,
        "http": `http://${page}`,
        "no scheme": page,
        "scheme in capitals": `HTTPS://${page}`,
        "a trailing slash": `https://${page}/`,
        "two trailing slashes": `http://${page}//`,
        "a slash after the query": `https://${page}/Sub?Q=Abc/`,
        "host in another case": `https://${page.replace("example.com", "Example.com")}`,
        "path in another case": `https://${page.replace("/Page", "/page")}`,
        "query in another case": `https://${page}/Sub?q=abc`,
        "a slash before the query": `https://${page}/Sub/?Q=Abc`,
        "another scheme": `ftp://${page}`,
      };
      const matched: Record<string, boolean> = {};
      for (const [what, location] of Object.entries(spellings)) {
        matched[what] = await found(location);
      }
      expect(matched).toEqual({
        "as stored": true,
        "http": true,
        "no scheme": true,
        "scheme in capitals": true,
        "a trailing slash": true,
        "two trailing slashes": true,
        "a slash after the query": true,
        "host in another case": false,
        "path in another case": false,
        "query in another case": false,
        "a slash before the query": false,
        "another scheme": false,
      });
    });

    it("a location is stored as given, and the API attaches a second copy of it", async () => {
      // Why `attachUrl` checks first, and why lower-casing the host before the
      // lookup would not be enough: the stored copy may be the one in capitals.
      const id = await make("location-verbatim");
      const mixed = `https://Example.COM/${PREFIX}verbatim-${Date.now()}/Page`;
      const lower = mixed.replace("Example.COM", "example.com");

      await attach(id, mixed);
      expect(await found(mixed)).toBe(true);
      expect(await found(lower)).toBe(false);

      await attach(id, lower);
      await attach(id, lower);
      const stored = await eventually(
        () => locations(id),
        (all) => all.length >= 3,
      );
      expect(stored.sort()).toEqual([lower, lower, mixed].sort());
      expect(await api.attachments.byLocation(brainId, lower)).toHaveLength(2);
    });

    it("by-location finds a new attachment at once; the thought's own list, once read, is behind", async () => {
      // The list is a copy: made when a thought's attachments are first read,
      // brought up to date about every 0.1 s after that. Measured over 300
      // attachments paced as below: by-location had each on the first read; the
      // list had 16, when a refresh fell in the few milliseconds between the
      // write and the read, and the rest at the next refresh or the one after,
      // 7 to 214 ms later with finer polling. Before the first read there is
      // no copy to be behind: 370 new thoughts of 370 listed their first
      // attachment at once, and 1 of 60 whose empty list had been read.
      const id = await make("attachment-lag");
      const PACE = 150;

      const first = `https://example.com/${PREFIX}lag-${Date.now()}-first`;
      await attach(id, first);
      expect(await locations(id)).toContain(first);
      await settle(PACE);

      // Until one is not listed at once, forty at the most. Measured again on
      // 2026-10-14, 40 of 40 were behind at the first read with the app to
      // itself and 40 of 40 with another contract run at work in it; the
      // five rounds this had were enough, and the form is the other tests'.
      const TRIES = 40;
      let behind = -1;
      for (let i = 0; i < TRIES && behind < 0; i++) {
        const url = `https://example.com/${PREFIX}lag-${Date.now()}-${i}`;
        await attach(id, url);
        expect(await found(url)).toBe(true);

        const listed = async (): Promise<boolean> => (await locations(id)).includes(url);
        if (!(await listed())) behind = i;
        // Every round lasts as long, whatever that read said. Left to end as
        // soon as the list had the attachment, a round listed at once ended
        // straight after a refresh, and the write that followed was listed at
        // once 19 times in 79, against 8 in 161 after a round that had to
        // wait. With the first attachment counted as a round, five in a row
        // came up once in 60 runs.
        const [shown] = await Promise.all([eventually(listed, Boolean), settle(PACE)]);
        expect(shown).toBe(true);
      }
      // One read in nineteen, and no more often after another: of 60 runs 45
      // had none at once, 14 had one and 1 had two.
      expect(
        behind,
        `${TRIES} attachments of ${TRIES} were listed at once: either the app was busy at every ` +
          "one of them, or the thought's own list is no longer a copy (L17)",
      ).toBeGreaterThanOrEqual(0);
    }, 60_000);

    it("attachUrl finds the copy under another host case, and tells paths apart", async () => {
      const id = await make("attach-dedupe");
      const stored = `https://Example.com/${PREFIX}dedupe-${Date.now()}/Page`;
      const add = (url: string, through = api) =>
        through.attachments.attachUrl(brainId, id, url, { name: `${PREFIX}link` });

      expect((await add(stored)).created).toBe(true);
      // The same spelling straight away: by-location has it already.
      expect((await add(stored)).created).toBe(false);

      // Another spelling of the host is found in the thought's list, by a
      // process that did not attach it and so has only the list to go by.
      const elsewhere = new TheBrainApi({ apiKey: apiKey! });
      await eventually(
        () => locations(id),
        (all) => all.includes(stored),
      );
      const again = await add(
        stored.replace("https://Example.com", "http://example.com") + "/",
        elsewhere,
      );
      expect(again.created).toBe(false);
      expect(again.existing?.location).toBe(stored);

      expect((await add(stored.replace("/Page", "/page"))).created).toBe(true);
      const all = await eventually(
        () => locations(id),
        (list) => list.length >= 2,
      );
      expect(all).toHaveLength(2);
    });

    it("attachUrl finds the address it attached straight before in another host case, though the list is behind", async () => {
      // Measured through brain_attach_url before this was guarded, a fresh
      // thought each time: the second spelling, sent straight after the
      // first, was attached again 18 times in 20, and sent at once with it 3
      // times of 3. The first attach reads the list before it writes, and
      // the copy made by that read is what the second one met.
      const add = (id: string, url: string) =>
        api.attachments.attachUrl(brainId, id, url, { name: `${PREFIX}link` });
      const spelled = (i: string) => {
        const stored = `https://Example.com/${PREFIX}again-${Date.now()}-${i}/p`;
        return { stored, lower: stored.replace("Example.com", "example.com") };
      };

      for (const i of ["0", "1", "2"]) {
        const id = await make(`attach-again-${i}`);
        const { stored, lower } = spelled(i);
        expect((await add(id, stored)).created).toBe(true);
        const again = await add(id, lower);
        expect(again.created, i).toBe(false);
        expect(again.existing?.location, i).toBe(stored);
        expect(await api.attachments.byLocation(brainId, lower), i).toEqual([]);
      }

      const id = await make("attach-at-once");
      const { stored, lower } = spelled("at-once");
      const both = await Promise.all([add(id, stored), add(id, lower)]);
      expect(both.map((r) => r.created)).toEqual([true, false]);
      expect(await api.attachments.byLocation(brainId, lower)).toEqual([]);

      // Deleted, it is not held against the address: by-location, asked for
      // the spelling this process keeps, no longer finds it (3 of 3 at the
      // first read). The list is a copy, so it is waited for.
      await api.attachments.delete(brainId, both[1]!.existing!.id);
      await eventually(
        () => locations(id),
        (all) => all.length === 0,
      );
      expect((await add(id, lower)).created).toBe(true);
    });
  });

  /**
   * What empties a thought's label, colours and type. Measured on TheBrain
   * 15.0.640; the spec lists the paths a patch may name and says nothing of
   * this. `brain_update_thought` offers null for all four.
   */
  describe("clearing a label, a colour and a type", () => {
    type Op = { op: "replace" | "remove"; path: string; value?: unknown };
    const patch = (id: string, ...ops: Op[]): Promise<unknown> =>
      api.client.patch(`/api/thoughts/${brainId}/${id}`, { jsonPatch: ops });
    /** The error a patch is refused with, or null when it is accepted. */
    const refusal = (id: string, ...ops: Op[]): Promise<TheBrainError | null> =>
      patch(id, ...ops).then(
        () => null,
        (error: unknown) => error as TheBrainError,
      );
    const makeWith = async (
      name: string,
      extra: { label?: string; typeId?: string },
    ): Promise<string> => {
      const id = await api.thoughts.create(brainId, { name: PREFIX + name, ...extra });
      created.push(id);
      return id;
    };
    const read = (id: string, ok: (t: ThoughtDto) => boolean): Promise<ThoughtDto> =>
      eventually(() => api.thoughts.get(brainId, id), ok);

    it("a label is cleared by remove or by an empty string; replace with null is a 403", async () => {
      const id = await makeWith("clear-label", { label: "caption" });

      // The same 403 a thought that does not exist gets, not a 400.
      const refused = await refusal(id, { op: "replace", path: "/label", value: null });
      expect(refused?.kind).toBe("forbidden");
      await settle();
      expect((await api.thoughts.get(brainId, id)).label).toBe("caption");

      await patch(id, { op: "remove", path: "/label" });
      expect((await read(id, (t) => t.label === null)).label).toBeNull();
      // Removing what is not there is accepted.
      expect(await refusal(id, { op: "remove", path: "/label" })).toBeNull();

      await api.thoughts.update(brainId, id, { label: "again" });
      await read(id, (t) => t.label === "again");
      await patch(id, { op: "replace", path: "/label", value: "" });
      expect((await read(id, (t) => t.label === null)).label).toBeNull();

      // The flat facade the tools use.
      await api.thoughts.update(brainId, id, { label: "once more" });
      await read(id, (t) => t.label === "once more");
      await api.thoughts.update(brainId, id, { label: null });
      expect((await read(id, (t) => t.label === null)).label).toBeNull();
    });

    it("a colour is cleared by remove alone; null and an empty string are a 400", async () => {
      const id = await make("clear-colour");
      const colours = (t: ThoughtDto): unknown[] => [t.foregroundColor, t.backgroundColor];
      const set = ["#ff7145", "#1a2b3c"];
      await api.thoughts.update(brainId, id, {
        foregroundColor: set[0],
        backgroundColor: set[1],
      });
      await read(id, (t) => colours(t).join() === set.join());

      for (const path of ["/foregroundColor", "/backgroundColor"]) {
        for (const value of [null, ""]) {
          const refused = await refusal(id, { op: "replace", path, value });
          expect(refused?.kind, `${path} = ${JSON.stringify(value)}`).toBe("bad_request");
          expect(refused?.message).toMatch(/malformed/i);
        }
      }
      await settle();
      expect(colours(await api.thoughts.get(brainId, id))).toEqual(set);

      await api.thoughts.update(brainId, id, { foregroundColor: null, backgroundColor: null });
      const cleared = await read(id, (t) => colours(t).every((c) => c === null));
      expect(colours(cleared)).toEqual([null, null]);
      // Removing what is not there is accepted.
      await api.thoughts.update(brainId, id, { foregroundColor: null, backgroundColor: null });
    });

    it("no patch takes a type away: null and an empty string change nothing, remove is a 403", async () => {
      const typeId = await make("clear-type", ThoughtKind.Type);
      const id = await makeWith("clear-typed", { typeId });
      await read(id, (t) => t.typeId === typeId);

      // Accepted, and that is the trap: the type stays.
      expect(await refusal(id, { op: "replace", path: "/typeId", value: null })).toBeNull();
      expect(await refusal(id, { op: "replace", path: "/typeId", value: "" })).toBeNull();
      const nobody = "00000000-0000-0000-0000-000000000000";
      for (const op of [
        { op: "remove", path: "/typeId" },
        { op: "replace", path: "/typeId", value: nobody },
      ] as const) {
        expect((await refusal(id, op))?.kind, JSON.stringify(op)).toBe("forbidden");
      }
      await settle();
      expect((await api.thoughts.get(brainId, id)).typeId).toBe(typeId);
    });

    it("a type goes when the link from it is deleted, which is what update does for null", async () => {
      const typeId = await make("drop-type", ThoughtKind.Type);
      const id = await makeWith("drop-typed", { typeId });
      await read(id, (t) => t.typeId === typeId);

      // One link, whichever end is named first, and `meaning` marks it.
      const link = await api.links.between(brainId, typeId, id);
      expect(link, "no link between the type and the thought").not.toBeNull();
      expect(isTypeLink(link!)).toBe(true);
      expect([link!.thoughtIdA, link!.thoughtIdB]).toEqual([typeId, id]);
      expect(link!.relation).toBe(Relation.Child);
      expect((await api.links.between(brainId, id, typeId))?.id).toBe(link!.id);

      await api.thoughts.update(brainId, id, { typeId: null });
      // No waiting here: by the time the call returned, a read agreed.
      expect((await api.thoughts.get(brainId, id)).typeId).toBeNull();
      expect(await api.links.between(brainId, typeId, id)).toBeNull();
      const graph = await eventually(
        () => api.thoughts.getGraph(brainId, id),
        (g) => g.type === null,
      );
      expect(graph.type).toBeNull();
      expect(graph.parents.map((p) => p.id)).not.toContain(typeId);

      // Logged as the link's deletion and as the thought losing its type.
      const lostType = (l: ModificationLogDto): boolean =>
        l.modType === ModType.TypeSet && l.sourceId === id && l.newValue === null;
      const linkDeleted = (l: ModificationLogDto): boolean =>
        l.modType === ModType.Deleted && l.sourceId === link!.id;
      const logs = await eventually(
        () => newestLogs(200),
        (entries) => entries.some(lostType) && entries.some(linkDeleted),
      );
      expect(logs.find(lostType)?.oldValue).toBe(`${PREFIX}drop-type`);
      expect(logs.find(linkDeleted)?.sourceType).toBe(EntityType.Link);

      // Nothing is left to remove, and the thought takes a type again.
      expect(await api.thoughts.removeType(brainId, id)).toBe(false);
      await api.thoughts.update(brainId, id, { typeId });
      expect((await read(id, (t) => t.typeId === typeId)).typeId).toBe(typeId);
    }, 30_000);

    it("a read straight after a type's link is deleted still returns the type", async () => {
      // Measured over 13 removals: the first read had the type every time, and
      // lost it 20–210 ms later. `removeType` waits for that read.
      //
      // This asked for one such read in five. Measured again on 2026-10-14,
      // 40 removals each: the first read had lost the type already 2 times
      // with the app to itself and 15 with another contract run at work in
      // it, where five in a row is one run in 140. So it removes until one
      // first read still has the type, and gives up at forty: were seven
      // first reads in ten to have lost it already, which nothing measured
      // came near, all forty would be one run in a million.
      const TRIES = 40;
      const typeId = await make("lag-type", ThoughtKind.Type);
      let stale = -1;
      for (let i = 0; i < TRIES && stale < 0; i++) {
        const id = await makeWith(`lag-typed-${i}`, { typeId });
        await read(id, (t) => t.typeId === typeId);
        expect(await api.links.detachType(brainId, id, typeId)).toBe(true);
        if ((await api.thoughts.get(brainId, id)).typeId === typeId) stale = i;
        expect((await read(id, (t) => t.typeId === null)).typeId).toBeNull();
      }
      expect(
        stale,
        `the type was gone at the first read after ${TRIES} removals of ${TRIES}: either the ` +
          "app was busy at every one of them, or a read is no longer behind the removal",
      ).toBeGreaterThanOrEqual(0);
    }, 60_000);

    it("a refused patch keeps what it wrote before the operation it refused", async () => {
      // So an update that throws may have landed in part.
      const id = await make("partial");
      const renamed = `${PREFIX}partial-renamed`;
      const refused = await refusal(
        id,
        { op: "replace", path: "/name", value: renamed },
        { op: "replace", path: "/foregroundColor", value: null },
        { op: "replace", path: "/label", value: "never written" },
      );
      expect(refused?.kind).toBe("bad_request");

      expect((await read(id, (t) => t.name === renamed)).name).toBe(renamed);
      await settle();
      expect((await api.thoughts.get(brainId, id)).label).toBeNull();
    });

    it("fields patched one to a request, one after another, are each written or refused alone", async () => {
      // What `brain_update_thought` sends, so that it can say which fields a
      // call wrote. Measured: 60 thoughts patched a field at a time, four or
      // five fields each, read back whole every time; a colour that is not
      // `#rrggbb` refused 9 times of 9, in three spellings.
      const id = await make("field-by-field");
      const renamed = `${PREFIX}field-by-field-renamed`;
      await api.thoughts.update(brainId, id, { name: renamed });
      await api.thoughts.update(brainId, id, { label: "caption" });
      const refused = await api.thoughts.update(brainId, id, { foregroundColor: "red" }).then(
        () => null,
        (error: unknown) => error as TheBrainError,
      );
      expect(refused?.kind).toBe("bad_request");
      expect(refused?.message).toMatch(/^Color format is malformed/);
      await api.thoughts.update(brainId, id, { backgroundColor: "#112233" });

      const after = await read(
        id,
        (t) => t.name === renamed && t.label === "caption" && t.backgroundColor !== null,
      );
      expect([after.name, after.label, after.backgroundColor?.toLowerCase()]).toEqual([
        renamed,
        "caption",
        "#112233",
      ]);
      expect(after.foregroundColor).toBeNull();
    });
  });

  /**
   * What the API does with a `typeId` that names no type, and what `update`
   * and `create` do about it. Measured on TheBrain 15.0.640. The spec calls
   * the field "the ID of the thought type" and says nothing of other thoughts.
   */
  describe("a typeId that is not a type", () => {
    /** The patch as the API takes it, with none of the client's checks. */
    const patchType = (id: string, value: string): Promise<TheBrainError | null> =>
      api.client
        .patch(`/api/thoughts/${brainId}/${id}`, {
          jsonPatch: [{ op: "replace", path: "/typeId", value }],
        })
        .then(
          () => null,
          (error: unknown) => error as TheBrainError,
        );
    /** And the create. */
    const rawCreate = async (name: string, typeId: string): Promise<string> => {
      const { id } = await api.client.post<{ id: string }>(`/api/thoughts/${brainId}`, {
        json: { name: PREFIX + name, kind: ThoughtKind.Normal, acType: 0, typeId },
      });
      created.push(id);
      return id;
    };
    const makeTyped = async (name: string, typeId: string, parent?: string): Promise<string> => {
      const id = await api.thoughts.create(brainId, {
        name: PREFIX + name,
        typeId,
        ...(parent !== undefined ? { sourceThoughtId: parent } : {}),
      });
      created.push(id);
      return id;
    };
    const typeOf = async (id: string): Promise<string | null> =>
      (await api.thoughts.get(brainId, id)).typeId;
    const linked = (a: string, b: string) =>
      eventually(
        () => api.links.between(brainId, a, b),
        (link) => link !== null,
      );

    it("a patch takes an ordinary thought or a tag for a type, and makes a parent or a tag of it", async () => {
      const typeId = await make("kept-type", ThoughtKind.Type);
      const plain = await make("not-a-type");
      const tagId = await make("not-a-type-tag", ThoughtKind.Tag);

      // On a thought with no type, and on one that has a type to lose.
      const bare = await make("patched-bare");
      const typed = await makeTyped("patched-typed", typeId);
      for (const id of [bare, typed]) {
        // Accepted, and that is the trap.
        expect(await patchType(id, plain)).toBeNull();
        expect(await patchType(id, tagId)).toBeNull();

        const graph = await eventually(
          () => api.thoughts.getGraph(brainId, id),
          (g) => g.parents.some((p) => p.id === plain) && g.tags.some((t) => t.id === tagId),
        );
        expect(graph.parents.map((p) => p.id)).toEqual([plain]);
        expect(graph.tags.map((t) => t.id)).toEqual([tagId]);
        // The links an ordinary parent and a tag have, and nothing of a type's.
        const parentLink = await api.links.between(brainId, plain, id);
        expect([parentLink?.thoughtIdA, parentLink?.relation, parentLink?.meaning]).toEqual([
          plain,
          Relation.Child,
          LinkMeaning.Normal,
        ]);
        expect((await api.links.between(brainId, tagId, id))?.meaning).toBe(LinkMeaning.Tag);
      }
      await settle();
      expect(await typeOf(bare)).toBeNull();
      expect(await typeOf(typed)).toBe(typeId);
    }, 30_000);

    it("a create takes them the same way, and the thought it makes has no type", async () => {
      const plain = await make("create-not-a-type");
      const tagId = await make("create-not-a-type-tag", ThoughtKind.Tag);
      const underPlain = await rawCreate("created-under-plain", plain);
      const tagged = await rawCreate("created-tagged", tagId);

      const parentLink = await linked(plain, underPlain);
      expect([parentLink?.thoughtIdA, parentLink?.relation, parentLink?.meaning]).toEqual([
        plain,
        Relation.Child,
        LinkMeaning.Normal,
      ]);
      expect((await linked(tagId, tagged))?.meaning).toBe(LinkMeaning.Tag);
      await settle();
      expect(await typeOf(underPlain)).toBeNull();
      expect(await typeOf(tagged)).toBeNull();
    });

    it("an identifier nobody has is a 403 in a patch and a 400 in a create, which creates nothing", async () => {
      const id = await make("patched-nobody");
      expect((await patchType(id, crypto.randomUUID()))?.kind).toBe("forbidden");

      const ghost = `ghost-${Date.now()}`;
      const refused = await rawCreate(ghost, crypto.randomUUID()).then(
        () => null,
        (error: unknown) => error as TheBrainError,
      );
      expect(refused?.kind).toBe("bad_request");
      expect(refused?.message).toMatch(/Could not create thought/);

      // The log has every thought created since, and the ghost is not one.
      const marker = await make("after-ghost");
      const logs = await eventually(
        () => newestLogs(50),
        (entries) => entries.some((l) => l.modType === ModType.Created && l.sourceId === marker),
      );
      const born = logs.filter(
        (l) => l.modType === ModType.Created && l.sourceType === EntityType.Thought,
      );
      const names = await Promise.all(
        born.map((l) =>
          api.thoughts.get(brainId, l.sourceId).then(
            (t) => t.name,
            () => null,
          ),
        ),
      );
      expect(names).toContain(`${PREFIX}after-ghost`);
      expect(names).not.toContain(PREFIX + ghost);
      await settle();
      expect(await typeOf(id)).toBeNull();
    });

    it("update and create refuse all three before anything is written", async () => {
      const plain = await make("refused-plain");
      const tagId = await make("refused-tag", ThoughtKind.Tag);
      const id = await make("refused-update");

      for (const [typeId, message] of [
        [plain, new RegExp(`it is the thought "${PREFIX}refused-plain"`)],
        [tagId, new RegExp(`it is the tag "${PREFIX}refused-tag"`)],
        [crypto.randomUUID(), /no thought in this brain has that identifier/],
      ] as const) {
        await expect(
          api.thoughts.update(brainId, id, { label: "never written", typeId }),
        ).rejects.toMatchObject({ kind: "not_a_type", message: expect.stringMatching(message) });
        await expect(
          api.thoughts.create(brainId, { name: `${PREFIX}never-created`, typeId }),
        ).rejects.toMatchObject({ kind: "not_a_type" });
      }

      await settle();
      const graph = await api.thoughts.getGraph(brainId, id);
      expect(graph.thought.label).toBeNull();
      expect(graph.parents).toEqual([]);
      expect(graph.tags).toEqual([]);
    });

    it("a type set by update has read back when it returns, so a removal straight after finds it", async () => {
      const first = await make("set-type-1", ThoughtKind.Type);
      const second = await make("set-type-2", ThoughtKind.Type);
      const id = await make("set-typed");

      // No waiting here: each call returns once a read agrees.
      await api.thoughts.update(brainId, id, { typeId: first });
      expect(await typeOf(id)).toBe(first);
      await api.thoughts.update(brainId, id, { typeId: second });
      expect(await typeOf(id)).toBe(second);
      // One type at a time: the first one's link went with it.
      const old = await eventually(
        () => api.links.between(brainId, first, id),
        (link) => link === null,
      );
      expect(old).toBeNull();

      await api.thoughts.update(brainId, id, { typeId: null });
      expect(await typeOf(id)).toBeNull();
    });

    it("a read straight after a patch sets a type usually does not show it yet", async () => {
      // Measured over 160 sets on a quiet brain: the first read had the type 24
      // times; otherwise it showed up to 107 ms later. `update` waits for it.
      // Again on 2026-10-14, 40 sets each: at the first read 0 times with the
      // app to itself and 5 with another contract run at work in it. It sets
      // until one first read lacks the type, forty at the most, which seven
      // first reads in ten with the type would fail one run in a million.
      const TRIES = 40;
      const typeId = await make("lag-set-type", ThoughtKind.Type);
      let stale = -1;
      for (let i = 0; i < TRIES && stale < 0; i++) {
        const id = await make(`lag-set-${i}`);
        expect(await patchType(id, typeId)).toBeNull();
        if ((await typeOf(id)) === null) stale = i;
        const seen = await eventually(
          () => typeOf(id),
          (t) => t === typeId,
        );
        expect(seen).toBe(typeId);
      }
      expect(
        stale,
        `the type read back at once after ${TRIES} patches of ${TRIES}: either the app was ` +
          "busy at every one of them, or a read is no longer behind a patch of the type",
      ).toBeGreaterThanOrEqual(0);
    }, 60_000);

    it("straight after a burst of writes a type takes several times longer to read back", async () => {
      // Writes queue up. Measured, for the first patch after thoughts created
      // six at a time, as ingest creates them: 0.6–0.8 s after 150, and after
      // thoughts created with a type, which is two writes each, 2.6 s after
      // 300 and 5.3 s after 600. On a quiet brain it is 0.1 s. The wait inside
      // `update` gives up after 2 s, and says why it may have.
      const typeId = await make("burst-type", ThoughtKind.Type);
      const id = await make("burst-patched");
      let next = 0;
      await Promise.all(
        Array.from({ length: 6 }, async () => {
          while (next < 150) await makeInBurst(`burst-${next++}`);
        }),
      );

      expect(await patchType(id, typeId)).toBeNull();
      const started = Date.now();
      const seen = await eventually(
        () => typeOf(id),
        (t) => t === typeId,
        { stepMs: 20 },
      );
      expect(seen).toBe(typeId);
      expect(Date.now() - started).toBeGreaterThan(300);
    }, 30_000);

    it("a thought created with a type reads back with it on the first read", async () => {
      // Measured over 340 creations, 180 of them six at a time: not one first
      // read came back without the type. So `create` does not wait.
      const typeId = await make("born-type", ThoughtKind.Type);
      const parent = await make("born-parent");
      for (let i = 0; i < 6; i++) {
        const id = await makeTyped(`born-typed-${i}`, typeId, i % 2 === 1 ? parent : undefined);
        expect(await typeOf(id), `creation ${i}`).toBe(typeId);
      }
    });

    it("a thought named as its own type is a 200 that sets nothing, and update refuses it unsent", async () => {
      // A type too, which the check of its kind lets through, so `update`
      // refuses this one before it reads anything.
      for (const kind of [ThoughtKind.Type, ThoughtKind.Normal]) {
        const raw = await make(`self-raw-${kind}`, kind);
        // The label goes ahead of the type, to show the patch was applied.
        await api.client.patch(`/api/thoughts/${brainId}/${raw}`, {
          jsonPatch: [
            { op: "replace", path: "/label", value: "written" },
            { op: "replace", path: "/typeId", value: raw },
          ],
        });
        const patched = await eventually(
          () => api.thoughts.get(brainId, raw),
          (t) => t.label === "written",
        );
        expect(patched.label).toBe("written");

        const id = await make(`self-update-${kind}`, kind);
        // Not null for a type: one reads back with its name for a label.
        const { label } = await api.thoughts.get(brainId, id);
        await expect(
          api.thoughts.update(brainId, id, { label: "never written", typeId: id }),
        ).rejects.toMatchObject({
          kind: "not_a_type",
          message: expect.stringMatching(/a thought cannot be its own type/),
        });

        await settle();
        expect(await typeOf(raw), `kind ${kind}`).toBeNull();
        // No patch went out: the label ahead of the type is as it was.
        expect((await api.thoughts.get(brainId, id)).label, `kind ${kind}`).toBe(label);
      }
    }, 30_000);
  });

  /**
   * What each request answers for an identifier nothing in the brain has, and
   * for a `brainId` that is no brain: L3 and L28 in docs/api-map.md. Reads and
   * refused writes, which add nothing to the brain; the note the API accepts
   * is removed after. Measured on TheBrain 15.0.640.
   */
  describe("an identifier nobody has, and a brainId that is no brain", () => {
    const CATCH_ALL =
      "To use the TheBrain API, make requests to /api (e.g. /api/brains). " +
      "An API key is required via the Authorization header.";
    const BARE_404 = "404 not_found: Not Found";
    /** How a request was refused: status, the kind made of it, the API's text. */
    const answer = (request: Promise<unknown>): Promise<string> =>
      request.then(
        () => "accepted",
        (e: unknown) =>
          e instanceof TheBrainError ? `${e.status} ${e.kind}: ${e.message}` : String(e),
      );
    /**
     * What the brain holds, by the counts a stray write would move: each is
     * right at the first read after a write. Not the counts of types and
     * tags, which stood here too: they come from a copy that is seconds
     * behind after a burst of writes, and nothing sent below makes either
     * (*statistics counts…*, above).
     */
    const counts = async (): Promise<number[]> => {
      const s = await api.brains.statistics(brainId);
      return [s.thoughts, s.links, s.notes, s.webLinks];
    };

    it("a thought nobody has: the read and a patch are a bare 404, the graph the catch-all 403, and the rest read as empty", async () => {
      const nobody = crypto.randomUUID();
      expect(await answer(api.thoughts.get(brainId, nobody))).toBe(BARE_404);
      expect(await answer(api.thoughts.update(brainId, nobody, { name: "never" }))).toBe(BARE_404);
      expect(await answer(api.thoughts.update(brainId, nobody, { label: null }))).toBe(BARE_404);
      for (const includeSiblings of [false, true]) {
        expect(await answer(api.thoughts.getGraph(brainId, nobody, { includeSiblings }))).toBe(
          `403 forbidden: ${CATCH_ALL}`,
        );
      }
      // Not refused at all: no attachments, no history, and the note of a
      // thought that has none.
      expect(await api.attachments.ofThought(brainId, nobody)).toEqual([]);
      expect(await api.thoughts.modifications(brainId, nobody)).toEqual([]);
      expect(await api.notes.getRaw(brainId, nobody)).toMatchObject({
        sourceId: nobody,
        markdown: "",
        modificationDateTime: "0001-01-01T00:00:00",
      });
      // The same for every identifier that names no thought of this brain.
      // The one of zeros among them, which the resources no longer send:
      // *the identifier of zeros, sent in a request*, below.
      for (const id of ["ffffffff-ffff-ffff-ffff-ffffffffffff", brainId]) {
        expect(await answer(api.thoughts.get(brainId, id)), id).toBe(BARE_404);
        expect(await answer(api.thoughts.getGraph(brainId, id)), id).toBe(
          `403 forbidden: ${CATCH_ALL}`,
        );
      }
    });

    it("a thought of another brain is nobody here", async (ctx) => {
      // Read through this brain only: the other one is not written to, nor
      // asked. Its home thought's identifier is in the list of brains, and
      // the list's word that the thought is there is taken as it stands:
      // reading it in its own brain would be reading that brain.
      const other = (await api.brains.list()).find((b) => b.id !== brainId);
      if (other === undefined) return ctx.skip();
      expect(await answer(api.thoughts.get(brainId, other.homeThoughtId))).toBe(BARE_404);
      expect(await answer(api.thoughts.getGraph(brainId, other.homeThoughtId))).toBe(
        `403 forbidden: ${CATCH_ALL}`,
      );
    });

    it("a write that names one says so in its own words, a create and an attachment with the identifier, and nothing is made", async () => {
      const id = await make("nobody-anchor");
      const nobody = crypto.randomUUID();
      const other = crypto.randomUUID();
      const never = { name: `${PREFIX}never-made`, kind: ThoughtKind.Normal, acType: 0 };
      await settle(400);
      const before = await counts();

      // A new thought: the source is named, the type is not.
      for (const relation of [Relation.Child, Relation.Parent, Relation.Jump]) {
        expect(
          await answer(
            api.thoughts.create(brainId, { name: never.name, sourceThoughtId: nobody, relation }),
          ),
          `relation ${relation}`,
        ).toBe(`404 not_found: Source Thought ${nobody} could not be located`);
      }
      // Past the client, which reads a typeId before it sends one (L21).
      for (const under of [{}, { sourceThoughtId: id, relation: Relation.Child }]) {
        expect(
          await answer(
            api.client.post(`/api/thoughts/${brainId}`, {
              json: { ...never, ...under, typeId: nobody },
            }),
          ),
        ).toBe("400 bad_request: Could not create thought.");
      }
      expect(
        await answer(
          api.client.patch(`/api/thoughts/${brainId}/${id}`, {
            jsonPatch: [{ op: "replace", path: "/typeId", value: nobody }],
          }),
        ),
      ).toBe(`403 forbidden: ${CATCH_ALL}`);

      // A link: a 400 that names the end, the source when both are nobody's.
      const link = (a: string, b: string, relation: Relation): Promise<string> =>
        answer(api.links.create(brainId, { thoughtIdA: a, thoughtIdB: b, relation }));
      for (const relation of [Relation.Child, Relation.Parent, Relation.Jump]) {
        expect(await link(id, nobody, relation)).toBe(
          `400 bad_request: Could not get target thought ${nobody}`,
        );
        expect(await link(nobody, id, relation)).toBe(
          `400 bad_request: Could not get source thought ${nobody}`,
        );
        expect(await link(nobody, other, relation)).toBe(
          `400 bad_request: Could not get source thought ${nobody}`,
        );
      }
      // A link addressed by an identifier no link has, and by ends nobody has.
      expect(await answer(api.links.get(brainId, nobody))).toBe(BARE_404);
      expect(await answer(api.links.update(brainId, nobody, { name: "never" }))).toBe(BARE_404);
      expect(await answer(api.links.delete(brainId, nobody))).toBe("400 bad_request: Bad Request");
      expect(await api.links.attachments(brainId, nobody)).toEqual([]);
      expect(await api.links.between(brainId, id, nobody)).toBeNull();
      expect(await api.links.between(brainId, nobody, id)).toBeNull();
      expect(await api.links.between(brainId, nobody, other)).toBeNull();

      // An attachment, and a pin.
      const thoughtNotFound = `404 not_found: Thought \`${nobody}\` not found.`;
      const url = "https://example.com/zz-it-nobody";
      expect(await answer(api.attachments.attachUrl(brainId, nobody, url))).toBe(thoughtNotFound);
      expect(await answer(api.thoughts.pin(brainId, nobody))).toBe(thoughtNotFound);
      expect(await answer(api.thoughts.unpin(brainId, nobody))).toBe(thoughtNotFound);
      expect(await answer(api.attachments.metadata(brainId, nobody))).toBe(BARE_404);
      expect(await answer(api.attachments.content(brainId, nobody))).toBe(BARE_404);
      // The template, as the API sends it.
      expect(await answer(api.attachments.delete(brainId, nobody))).toBe(
        "400 bad_request: Could not delete attachment {attachmentId}",
      );

      // And one that is not refused: deleting a thought nobody has is a 200.
      expect(await answer(api.thoughts.delete(brainId, nobody))).toBe("accepted");

      await settle(400);
      expect(await counts()).toEqual(before);
    }, 30_000);

    it("a brainId that is no brain: every request is the same 401, in words that are not the key's", async () => {
      const id = await make("no-brain-anchor");
      const noBrain = crypto.randomUUID();
      const nobody = crypto.randomUUID();
      const url = "https://example.com/zz-it-no-brain";
      const name = `${PREFIX}never-made`;
      const requests: Array<[string, () => Promise<unknown>]> = [
        ["brain", () => api.brains.get(noBrain)],
        ["statistics", () => api.brains.statistics(noBrain)],
        ["log", () => api.brains.modifications(noBrain, { maxLogs: 5 })],
        // Not the 400 of an empty list, which is read as one.
        ["types", () => api.thoughts.listTypes(noBrain)],
        ["tags", () => api.thoughts.listTags(noBrain)],
        ["pins", () => api.thoughts.listPinned(noBrain)],
        ["name", () => api.thoughts.findByName(noBrain, name)],
        ["search", () => api.search.inBrain(noBrain, "zz")],
        // A thought that exists elsewhere, and one nobody has: the brain is asked first.
        ["thought", () => api.thoughts.get(noBrain, id)],
        ["thought nobody has", () => api.thoughts.get(noBrain, nobody)],
        ["graph", () => api.thoughts.getGraph(noBrain, id)],
        ["history", () => api.thoughts.modifications(noBrain, id)],
        ["patch", () => api.thoughts.update(noBrain, id, { name })],
        ["delete", () => api.thoughts.delete(noBrain, nobody)],
        ["create", () => api.thoughts.create(noBrain, { name })],
        ["create under", () => api.thoughts.create(noBrain, { name, sourceThoughtId: id })],
        ["a type's read", () => api.thoughts.requireType(noBrain, id)],
        ["a tag's read", () => api.links.requireTag(noBrain, id)],
        ["a parent's read", () => api.links.requireParent(noBrain, id, "parentId")],
        ["link", () => api.links.get(noBrain, nobody)],
        ["link between", () => api.links.between(noBrain, id, nobody)],
        ["link create", () => api.links.create(noBrain, { thoughtIdA: id, thoughtIdB: nobody })],
        ["link patch", () => api.links.update(noBrain, nobody, { name })],
        ["link delete", () => api.links.delete(noBrain, nobody)],
        ["note", () => api.notes.getRaw(noBrain, id)],
        ["note set", () => api.notes.set(noBrain, id, "never")],
        ["note append", () => api.notes.append(noBrain, id, "never")],
        ["attachments", () => api.attachments.ofThought(noBrain, id)],
        ["by-location", () => api.attachments.byLocation(noBrain, url)],
        ["attach", () => api.attachments.attachUrl(noBrain, id, url)],
        ["attachment", () => api.attachments.metadata(noBrain, nobody)],
      ];
      for (const [what, request] of requests) {
        expect(await answer(request()), what).toBe(
          `401 unknown_brain: Access to brain ${noBrain} is unauthorized.`,
        );
      }

      // A rejected key is the other 401, and is asked about before the brain.
      const badKey = new TheBrainApi({ apiKey: "not-the-key" });
      for (const brain of [brainId, noBrain]) {
        expect(await answer(badKey.thoughts.get(brain, id))).toBe("401 auth: Invalid API Key");
      }
    });

    it("a note is written to an identifier nobody has, by an update and by an append, makes no thought, and outlives a delete of it", async () => {
      const text = `${PREFIX}note for nobody`;
      const writes: Array<[string, (id: string) => Promise<unknown>]> = [
        ["update", (id) => api.notes.set(brainId, id, text)],
        // Past `notes.append()`, which reads the note and sends an update when there is none.
        [
          "append",
          (id) => api.client.post(`/api/notes/${brainId}/${id}/append`, { json: { markdown: text } }),
        ],
      ];
      for (const [how, write] of writes) {
        const nobody = crypto.randomUUID();
        const hung = () => api.attachments.ofThought(brainId, nobody);
        try {
          // A 200, and the note is there to read.
          expect(await answer(write(nobody)), how).toBe("accepted");
          const note = await eventually(
            () => api.notes.get(brainId, nobody),
            (markdown) => markdown !== "",
          );
          expect(note, how).toBe(text);
          // An attachment whose thought is the identifier, as any note is (L13).
          const attached = await eventually(hung, (list) => list.length > 0);
          expect(attached, how).toMatchObject([{ isNotes: true, sourceId: nobody, sourceType: 2 }]);

          // No thought came of it, and deleting "it" answers 200 and leaves the note.
          expect(await answer(api.thoughts.get(brainId, nobody)), how).toBe(BARE_404);
          expect(await answer(api.thoughts.getGraph(brainId, nobody)), how).toBe(
            `403 forbidden: ${CATCH_ALL}`,
          );
          await api.thoughts.delete(brainId, nobody);
          await settle(500);
          expect(await api.notes.get(brainId, nobody), how).toBe(text);
        } finally {
          // Only its attachment's deletion removes it: it hangs on no thought
          // the sweep after the suite could find.
          const left = await eventually(hung, (list) => list.length > 0, { timeoutMs: 2000 });
          for (const a of left) await api.attachments.delete(brainId, a.id);
        }
        // For a moment the read of a note whose attachment is gone is the
        // catch-all 403, for a thought that exists too: 12 of 12, up to 0.3 s.
        const first = await answer(api.notes.getRaw(brainId, nobody));
        expect(["accepted", `403 forbidden: ${CATCH_ALL}`], how).toContain(first);
        const gone = await eventually(
          () => api.notes.exists(brainId, nobody).catch(() => true),
          (exists) => !exists,
        );
        expect(gone, how).toBe(false);
      }
    }, 30_000);

    it("the note of a thought that is there reads as the catch-all 403 for a moment after its attachment is deleted, while the thought and its graph read", async () => {
      // 12 of 12: the first read of the note after the deletion was the 403,
      // and the last one came 0 to 162 ms after it; from then on the read
      // was the "no note" sentinel. The thought and its graph were a 200
      // throughout. So this 403 says nothing of the thought or of its
      // identifier, which is what `describeError()` says of it, and a tool
      // that reads a note takes it for a read that failed, not for no note.
      for (let round = 0; round < 3; round += 1) {
        const id = await make(`note-attachment-deleted-${round}`);
        await api.notes.set(brainId, id, "a note");
        const attached = await eventually(
          () => api.attachments.ofThought(brainId, id),
          (list) => list.some((a) => a.isNotes),
        );
        await api.attachments.delete(brainId, attached.find((a) => a.isNotes)!.id);

        const [note, thought, graph] = await Promise.all([
          answer(api.notes.getRaw(brainId, id)),
          answer(api.thoughts.get(brainId, id)),
          answer(api.thoughts.getGraph(brainId, id)),
        ]);
        // Not required to be the 403: the moment can be over by the read.
        expect(["accepted", `403 forbidden: ${CATCH_ALL}`], `round ${round}`).toContain(note);
        expect([thought, graph], `round ${round}`).toEqual(["accepted", "accepted"]);

        const gone = await eventually(
          () => api.notes.exists(brainId, id).catch(() => true),
          (exists) => !exists,
        );
        expect(gone, `round ${round}`).toBe(false);
      }
    }, 30_000);

    it("a thought deleted a moment ago still reads for a moment, and a create under it is the 400 only while it does", async () => {
      // 96 deletions, each followed 0 to 300 ms later by a read and a create.
      // While the read was still a 200 the create was the 400 that names
      // nothing, 27 times, or already the 404, 7 times; once the read was a
      // 404 the create was the 404 too, 62 of 62. From 200 ms on that was
      // every create, and of the 12 sent at once it was 2: so the 400 cannot
      // be pinned to "straight after". The graph was a 403 from the first
      // request.
      const doomed = await make("deleted-a-moment-ago");
      await settle(500);
      await api.thoughts.delete(brainId, doomed);
      const under = { name: `${PREFIX}never-made`, kind: ThoughtKind.Normal, acType: 0 };
      const create = (): Promise<string> =>
        answer(
          api.client
            .post<{ id: string }>(`/api/thoughts/${brainId}`, {
              json: { ...under, sourceThoughtId: doomed, relation: Relation.Child },
            })
            .then(({ id }) => created.push(id)),
        );
      const gone = `404 not_found: Source Thought ${doomed} could not be located`;

      const graph = await answer(api.thoughts.getGraph(brainId, doomed));
      const read = await answer(api.thoughts.get(brainId, doomed));
      const made = await create();
      expect(graph).toBe(`403 forbidden: ${CATCH_ALL}`);
      expect(["accepted", BARE_404]).toContain(read);
      expect(["400 bad_request: Could not create thought.", gone]).toContain(made);
      if (read === BARE_404) expect(made).toBe(gone);

      await settle(500);
      expect(await answer(api.thoughts.get(brainId, doomed))).toBe(BARE_404);
      expect(await create()).toBe(gone);
    });

    it("a malformed identifier in the path is the app's page to a read, and a 400 with no body to a write", async () => {
      // The client refuses such an identifier before the request, so these go past it.
      const bad = "not-a-uuid";
      for (const path of [
        `/api/thoughts/${brainId}/${bad}`,
        `/api/thoughts/${brainId}/${bad}/graph`,
        `/api/thoughts/${bad}/${brainId}`,
        `/api/notes/${brainId}/${bad}`,
        `/api/links/${brainId}/${bad}`,
        `/api/brains/${bad}`,
        // And a path the API does not have at all.
        `/api/thoughts/${brainId}/${brainId}/nonsense`,
      ]) {
        await expect(api.client.get(path), path).rejects.toMatchObject({
          kind: "route_miss",
          status: 200,
        });
      }
      const rename = [{ op: "replace" as const, path: "/name", value: "never" }];
      const writes: Array<[string, () => Promise<unknown>]> = [
        ["PATCH", () => api.client.patch(`/api/thoughts/${brainId}/${bad}`, { jsonPatch: rename })],
        ["DELETE", () => api.client.delete(`/api/thoughts/${brainId}/${bad}`)],
        ["POST", () => api.client.post(`/api/notes/${brainId}/${bad}/update`, { json: {} })],
      ];
      for (const [method, request] of writes) {
        expect(await answer(request()), method).toBe("400 bad_request: (empty response)");
      }
    });
  });

  /**
   * What the search answers for a query it will not take. Measured on TheBrain
   * 15.0.640 (docs/api-map.md, L30); the spec has none of it. Neither of the
   * two refusals for size says a word about size, and `brain_search` with no
   * index took each for a phrasing that found nothing. Reads only.
   */
  describe("a query the search will not take", () => {
    const CATCH_ALL =
      "To use the TheBrain API, make requests to /api (e.g. /api/brains). " +
      "An API key is required via the Authorization header.";
    const answer = (request: Promise<unknown>): Promise<string> =>
      request.then(
        (value) => (Array.isArray(value) ? "answered" : "accepted"),
        (e: unknown) =>
          e instanceof TheBrainError ? `${e.status} ${e.kind}: ${e.message}` : String(e),
      );
    /** The request as the resource sends it, and its failure as the client reads it. */
    const search = (queryText: string, from: TheBrainApi = api, brain = brainId): Promise<string> =>
      answer(
        from.client.get(`/api/search/${brain}`, {
          query: { queryText, maxResults: 15, onlySearchThoughtNames: false },
        }),
      );
    /** Bytes of the request line that are not the query: the same for any brain. */
    const REST_OF_LINE =
      `GET /api/search/${"0".repeat(36)}?queryText=` +
      "&maxResults=15&onlySearchThoughtNames=false HTTP/1.1";
    const words = (count: number, word = "ab"): string => Array(count).fill(word).join(" ");

    it("a queryText that is absent, empty or white space is a 400 that calls the field required", async () => {
      for (const queryText of [undefined, "", " ", "\t\n"]) {
        const refused = await api.client
          .get(`/api/search/${brainId}`, {
            query: { queryText, maxResults: 15, onlySearchThoughtNames: false },
          })
          .then(
            () => null,
            (e: unknown) => e as TheBrainError,
          );
        expect(refused, JSON.stringify(queryText)).toMatchObject({
          status: 400,
          kind: "bad_request",
          message: "One or more validation errors occurred.",
        });
        expect(refused!.body).toContain("The queryText field is required.");
      }
    });

    it("odd characters are not refused: a query of them is answered like any other", async () => {
      // So a phrasing does not fail for what it is written with, only for its size.
      const odd = [
        '"', '"unclosed', "'", "*", "?", "\\", "/", "%", "%%", "#", "&", "+", "-", "!", "~", "^",
        "(", ")", "((", "[", "]", "{", "}", "<", ">", "<script>", ":", "a:b", "AND", "OR", "NOT",
        "a AND", "AND a", "a OR (", "a~2", "a^2", "*a", "?a", "a*", "[a TO b]", "{a TO b}",
        "a && b", "a || b", "\u0000", "a\u0000b", "\u200b", "\ud83d\ude00", "日本語", "привет",
        "a\nb", "a\tb", "a\\", "%00", "../..", "SELECT * FROM x; --", "' OR 1=1 --", "\ufffd",
      ];
      for (const queryText of odd) {
        expect(await search(queryText), JSON.stringify(queryText)).toBe("answered");
      }
    });

    it("a request line past 8,192 bytes, its line ending counted, is a 414 with no body", async () => {
      // 8,190 bytes of line and two of ending are taken; one more is not.
      const room = 8190 - REST_OF_LINE.length;
      expect(room).toBe(8075);
      expect(await search("a".repeat(room))).toBe("answered");
      expect(await search("a".repeat(room + 1))).toBe("414 bad_request: (empty response)");
      // A letter outside ASCII is as many bytes as its UTF-8 has, each as %XX.
      expect(await search("я".repeat(1345))).toBe("answered");
      expect(await search("я".repeat(1346))).toBe("414 bad_request: (empty response)");
      expect(await search("日".repeat(897))).toBe("answered");
      expect(await search("日".repeat(898))).toBe("414 bad_request: (empty response)");
    });

    it("the 414 comes before the key and the brain are looked at, and the 403 after", async () => {
      const long = "a".repeat(9000);
      const wrongKey = new TheBrainApi({ apiKey: "not-the-key" });
      expect(await search("zz", wrongKey)).toBe("401 auth: Invalid API Key");
      expect(await search(long, wrongKey)).toBe("414 bad_request: (empty response)");
      const noBrain = crypto.randomUUID();
      expect(await search("zz", api, noBrain)).toBe(
        `401 unknown_brain: Access to brain ${noBrain} is unauthorized.`,
      );
      expect(await search(long, api, noBrain)).toBe("414 bad_request: (empty response)");
      // The 403 for a count of words does not: there the key and the brain come first.
      expect(await search(words(513), wrongKey)).toBe("401 auth: Invalid API Key");
      expect(await search(words(513), api, noBrain)).toBe(
        `401 unknown_brain: Access to brain ${noBrain} is unauthorized.`,
      );
    });

    it("513 to 1,024 words are the catch-all 403, and 512 and 1,025 are answered", async () => {
      expect(await search(words(512))).toBe("answered");
      expect(await search(words(513))).toBe(`403 forbidden: ${CATCH_ALL}`);
      expect(await search(words(1024))).toBe(`403 forbidden: ${CATCH_ALL}`);
      expect(await search(words(1025))).toBe("answered");
      // Whatever the words are, and however they are parted.
      const distinct = Array.from({ length: 513 }, (_, i) => `lorem${i}ipsum`);
      expect(await search(distinct.join(" "))).toBe(`403 forbidden: ${CATCH_ALL}`);
      expect(await search(distinct.join("  "))).toBe(`403 forbidden: ${CATCH_ALL}`);
      expect(await search(Array(513).fill("ab").join("\n"))).toBe(`403 forbidden: ${CATCH_ALL}`);
    }, 30_000);

    it("a word of one character is not among the 512, and is among the 1,024", async () => {
      expect(await search(words(600, "a"))).toBe("answered");
      expect(await search(`${words(600)} ${words(300, "a")}`)).toBe(`403 forbidden: ${CATCH_ALL}`);
      expect(await search(`${words(600)} ${words(500, "a")}`)).toBe("answered");
      expect(await search(`${words(512)} ${words(600, "a")}`)).toBe("answered");
    }, 30_000);

    it("the resource tells both as a query too long, and answers a shorter one", async () => {
      await expect(api.search.inBrain(brainId, "я".repeat(1346))).rejects.toMatchObject({
        kind: "query_too_long",
        status: 414,
        message: expect.stringContaining("1346 characters, 8076 bytes as the URL carries them"),
      });
      await expect(api.search.inBrain(brainId, words(513))).rejects.toMatchObject({
        kind: "query_too_long",
        status: 403,
        message: expect.stringContaining("the search text is 513 words"),
      });
      expect(Array.isArray(await api.search.inBrain(brainId, "zz"))).toBe(true);
    });
  });

  /**
   * The search answers from an index of its own, refreshed about every five
   * seconds, and a hit is that index's copy of a thought. Measured on TheBrain
   * 15.0.640 (docs/api-map.md, L34): until the next refresh it returns a
   * thought that is gone, and a changed one by its old text and under its old
   * name. `brain_search` listed both as it found them, and `findByName`
   * returned the first.
   *
   * What is not here, because a test cannot wait for it or make it happen: a
   * thought deleted within some tens of milliseconds of a neighbour stayed in
   * that index for good about once in a hundred (7 of 720), and such hits
   * were still returned seventeen hours later.
   *
   * Nor is `GET /api/search/accessible`, which one of these tests used to
   * send twice a run. It searches every brain the key opens, and these tests
   * keep to the one brain they are given. What it showed when it was
   * measured, on 2026-10-11, stands in L34 as a measurement made once: it
   * returned a new thought, and did not return a deleted one.
   */
  describe("a thought the search still returns after it is deleted or changed", () => {
    const hitsFor = (queryText: string): Promise<SearchResultDto[]> =>
      api.client.get<SearchResultDto[]>(`/api/search/${brainId}`, {
        query: { queryText, maxResults: 10, onlySearchThoughtNames: false },
      });
    /** The hit for one thought among what the search returns for a word, if it is there. */
    const hitFor = async (word: string, id: string): Promise<SearchResultDto | null> =>
      (await hitsFor(word)).find((h) => h.sourceThought?.id === id) ?? null;
    /** The lookup by exact name as the API answers it, with nothing read after it. */
    const lookedUp = (nameExact: string): Promise<ThoughtDto | null> =>
      api.client.get<ThoughtDto>(`/api/thoughts/${brainId}`, { query: { nameExact } }).catch(
        (e: unknown) => {
          if (e instanceof TheBrainError && e.kind === "not_found") return null;
          throw e;
        },
      );
    const reads = (id: string): Promise<string> =>
      api.thoughts.get(brainId, id).then(
        (t) => `there as ${t.name}`,
        (e: unknown) => (e instanceof TheBrainError ? e.kind : String(e)),
      );
    /** `brain_search` as it runs with no index: on TheBrain's own search. */
    const fallback = (): SemanticSearch =>
      new SemanticSearch(api, new VectorStore(":memory:"), {
        id: "contract@v1",
        dimensions: 1,
        embedDocuments: async (texts) => texts.map(() => new Float32Array([1])),
        embedQuery: async () => new Float32Array([1]),
      });

    /**
     * Runs `look` until it has looked between two refreshes of the search's
     * index. It returns false when the index caught up before it was done,
     * which a write queued behind another test's burst can bring about, and
     * is then run again, on a thought of its own.
     */
    const betweenRefreshes = async (look: (attempt: number) => Promise<boolean>): Promise<void> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await look(attempt)) return;
        console.warn(`[search] the index caught up before it was asked, attempt ${attempt + 1}`);
      }
      throw new Error(
        "three times of three the search had caught up with the change before it was asked: " +
          "either a refresh fell in between every time, or TheBrain's search no longer " +
          "answers from a copy that is behind (docs/api-map.md, L34)",
      );
    };

    it("a deleted thought is returned by the search and by the name lookup, the hit as it was, while its read is a 404", async () => {
      let word = "";
      let id = "";
      await betweenRefreshes(async (attempt) => {
        word = `gone${Date.now()}x${attempt}`;
        const name = PREFIX + word;
        id = await make(word);
        // The moment the search first returns it follows a refresh, and the
        // next is about five seconds off.
        const hit = await eventually(() => hitFor(word, id), (h) => h !== null, {
          timeoutMs: 20_000,
          stepMs: 50,
        });
        expect(hit, "the search never returned the new thought").not.toBeNull();
        // A hit of the search within one brain names no brain at its root:
        // zeros and no name, with the brain in the thought (L6).
        expect(hit).toMatchObject({
          brainId: "00000000-0000-0000-0000-000000000000",
          brainName: null,
          isFromOtherBrain: false,
          sourceThought: { id, brainId },
        });
        expect((await lookedUp(name))?.id).toBe(id);

        await api.thoughts.delete(brainId, id);
        // The thought itself reads for a moment more: 30 to 206 ms, 80 times of 80.
        const gone = await eventually(() => reads(id), (r) => !r.startsWith("there"), {
          timeoutMs: 5_000,
          stepMs: 10,
        });
        expect(gone).toBe("not_found");

        const before = await hitFor(word, id);
        const byName = await lookedUp(name);
        const found = await api.thoughts.findByName(brainId, name);
        const outcome = await fallback().find(brainId, word);
        const after = await hitFor(word, id);
        if (before === null || after === null) return false;

        // Between two answers of the search that both had it, and with the
        // thought's own read a 404 throughout. The hit is the one it was
        // before the delete, to the last field: nothing in it gives it away.
        expect(before).toEqual(hit);
        expect(after).toEqual(hit);
        expect(byName?.id).toBe(id);
        expect(await reads(id)).toBe("not_found");
        // What the layers above make of it: no thought of that name, and a
        // hit left out and counted.
        expect(found).toBeNull();
        expect(outcome.mode).toBe("keyword");
        expect(outcome.matches.map((m) => m.thoughtId)).not.toContain(id);
        expect(outcome.gone.map((m) => m.thoughtId)).toEqual([id]);
        expect(outcome.unverified).toEqual([]);
        return true;
      });

      // It leaves at the next refresh: 5.0 to 5.2 s after the delete, 11 runs.
      const left = await eventually(() => hitFor(word, id), (h) => h === null, {
        timeoutMs: 15_000,
        stepMs: 250,
      });
      expect(left).toBeNull();
      expect(await lookedUp(PREFIX + word)).toBeNull();
    }, 90_000);

    it("a changed thought is found by its old name, caption, alias and note, under its old name, until the search catches up", async () => {
      let id = "";
      let now = { name: "", caption: "", alias: "", note: "" };
      await betweenRefreshes(async (attempt) => {
        const stamp = `${Date.now()}x${attempt}`;
        // One word each, and no word in common: the search matches by word.
        const was = {
          name: `wasname${stamp}`,
          caption: `wascaption${stamp}`,
          alias: `wasalias${stamp}`,
          note: `wasnote${stamp}`,
        };
        now = {
          name: `nowname${stamp}`,
          caption: `nowcaption${stamp}`,
          alias: `nowalias${stamp}`,
          note: `nownote${stamp}`,
        };
        id = await api.thoughts.create(brainId, {
          name: PREFIX + was.name,
          label: was.caption,
          aliases: [was.alias],
        });
        created.push(id);
        await api.notes.set(brainId, id, `${was.note} is in the note`);
        const foundByAll = async (words: Record<string, string>): Promise<boolean> => {
          const hits = await Promise.all(Object.values(words).map((w) => hitFor(w, id)));
          return hits.every((h) => h !== null);
        };
        expect(
          await eventually(() => foundByAll(was), (all) => all, { timeoutMs: 20_000, stepMs: 50 }),
          "the search never found the new thought by all four",
        ).toBe(true);
        // By its caption and by an alias it is found as by its name. By its
        // note it is a hit of another shape, for the note's attachment, with a
        // thought in it that has no caption or aliases; a search of names
        // leaves that one out, and no other.
        const [byCaption, byAlias, byNote] = await Promise.all(
          [was.caption, was.alias, was.note].map((w) => hitFor(w, id)),
        );
        for (const hit of [byCaption, byAlias]) {
          expect(hit).toMatchObject({ searchResultType: 1, entityType: 2 });
          expect(hit?.sourceThought).toMatchObject({ label: was.caption, aliases: [was.alias] });
        }
        expect(byNote).toMatchObject({ searchResultType: 3, entityType: 4, name: null });
        expect(byNote?.attachmentId).not.toBe("00000000-0000-0000-0000-000000000000");
        expect(byNote?.sourceThought).toMatchObject({ label: null, aliases: [] });
        const amongNames = (queryText: string): Promise<boolean> =>
          api.client
            .get<SearchResultDto[]>(`/api/search/${brainId}`, {
              query: { queryText, maxResults: 10, onlySearchThoughtNames: true },
            })
            .then((hits) => hits.some((h) => h.sourceThought?.id === id));
        expect(await Promise.all(Object.values(was).map(amongNames))).toEqual([
          true,
          true,
          true,
          false,
        ]);

        await api.thoughts.update(brainId, id, {
          name: PREFIX + now.name,
          label: now.caption,
          aliases: [now.alias],
        });
        await api.notes.set(brainId, id, `${now.note} is in the note`);
        const renamed = await eventually(
          () => api.thoughts.get(brainId, id),
          (t) => t.name === PREFIX + now.name && t.label === now.caption,
          { timeoutMs: 5_000, stepMs: 10 },
        );
        expect(renamed).toMatchObject({ name: PREFIX + now.name, label: now.caption });

        const before = await hitFor(was.name, id);
        const byOldText = await Promise.all(
          [was.caption, was.alias, was.note].map((w) => hitFor(w, id)),
        );
        const byNewText = await Promise.all(Object.values(now).map((w) => hitFor(w, id)));
        const lookedOld = await lookedUp(PREFIX + was.name);
        const lookedNew = await lookedUp(PREFIX + now.name);
        const foundOld = await api.thoughts.findByName(brainId, PREFIX + was.name);
        const outcome = await fallback().find(brainId, was.name);
        const after = await hitFor(was.name, id);
        if (before === null || after === null) return false;

        // The hit is the search's copy: the name, the caption and the aliases
        // the thought had, where its own read has the new ones.
        expect(before.sourceThought).toMatchObject({
          name: PREFIX + was.name,
          label: was.caption,
          aliases: [was.alias],
        });
        expect(before.name).toBe(PREFIX + was.name);
        expect(byOldText.map((h) => h?.sourceThought?.id)).toEqual([id, id, id]);
        expect(byNewText).toEqual([null, null, null, null]);
        // The lookup by name answers the same way, old name and all.
        expect(lookedOld).toMatchObject({ id, name: PREFIX + was.name });
        expect(lookedNew).toBeNull();
        // Above it, the thought is not one of that name any more, and a hit
        // for it is listed under the name it has.
        expect(foundOld).toBeNull();
        expect(outcome.matches.find((m) => m.thoughtId === id)).toMatchObject({
          name: PREFIX + now.name,
        });
        expect(outcome).toMatchObject({ gone: [], unverified: [] });
        return true;
      });

      const caughtUp = await eventually(() => hitFor(now.name, id), (h) => h !== null, {
        timeoutMs: 15_000,
        stepMs: 250,
      });
      expect(caughtUp?.sourceThought).toMatchObject({
        name: PREFIX + now.name,
        label: now.caption,
        aliases: [now.alias],
      });
      expect((await api.thoughts.findByName(brainId, PREFIX + now.name))?.id).toBe(id);
    }, 90_000);

    it("the name lookup is exact to the letter case, gives the newer of two namesakes, and goes on giving it once it is gone", async () => {
      // So `findByName` compares the name it reads with the one it was asked
      // for as they stand, and a null from it is less than "no thought has
      // this name": the older namesake is behind the newer one.
      let name = "";
      let older = "";
      await betweenRefreshes(async (attempt) => {
        name = `${PREFIX}Namesake${Date.now()}x${attempt}`;
        older = await api.thoughts.create(brainId, { name });
        const newer = await api.thoughts.create(brainId, { name });
        created.push(older, newer);
        const first = await eventually(() => lookedUp(name), (t) => t?.id === newer, {
          timeoutMs: 20_000,
          stepMs: 50,
        });
        expect(first?.id).toBe(newer);
        for (const other of [name.toLowerCase(), name.toUpperCase(), `${name} `, ` ${name}`]) {
          expect(await lookedUp(other), JSON.stringify(other)).toBeNull();
        }

        await api.thoughts.delete(brainId, newer);
        const gone = await eventually(() => reads(newer), (r) => !r.startsWith("there"), {
          timeoutMs: 5_000,
          stepMs: 10,
        });
        expect(gone).toBe("not_found");
        const before = await lookedUp(name);
        const found = await api.thoughts.findByName(brainId, name);
        const after = await lookedUp(name);
        if (before?.id !== newer || after?.id !== newer) return false;

        // The lookup's one answer is the thought that is gone, with the
        // older one there all the while.
        expect(await reads(older)).toBe(`there as ${name}`);
        expect(found).toBeNull();
        return true;
      });

      const next = await eventually(() => lookedUp(name), (t) => t?.id === older, {
        timeoutMs: 15_000,
        stepMs: 250,
      });
      expect(next?.id).toBe(older);
      expect((await api.thoughts.findByName(brainId, name))?.id).toBe(older);
    }, 90_000);

    it("a vector search leaves out a thought deleted since the last sync, and the next sync takes its row", async () => {
      const since = new Date().toISOString();
      const id = await make(`vector-gone-${Date.now()}`);
      const embedder: Embedder = {
        id: "contract@v1",
        dimensions: 1,
        embedDocuments: async (texts) => texts.map(() => new Float32Array([1])),
        embedQuery: async () => new Float32Array([1]),
      };
      const { store, indexer } = await indexedSince(since, embedder);
      expect(store.contentHashes().has(id)).toBe(true);
      // Past the thought's own `101`: the sync below has the `102` to go by.
      await caughtUp(store);

      await api.thoughts.delete(brainId, id);
      await eventually(() => reads(id), (r) => r === "not_found", { timeoutMs: 5_000, stepMs: 10 });

      // The index knows nothing of the delete, and every row scores the same
      // here: the row is among the hits, and the read of its thought is a 404.
      const outcome = await new SemanticSearch(api, store, embedder).find(brainId, "anything", {
        limit: Math.max(store.size(), 1),
        includeAuxiliary: true,
      });
      expect(outcome.mode).toBe("vector");
      // It was listed like any other hit.
      expect(outcome.matches.map((m) => m.thoughtId)).not.toContain(id);
      expect(outcome.gone.map((m) => m.thoughtId)).toContain(id);
      // A search writes nothing. The delete is in the log, and a sync goes by that.
      expect(store.contentHashes().has(id)).toBe(true);
      const synced = await indexer.sync(brainId);
      expect(store.contentHashes().has(id)).toBe(false);
      expect(synced.removed).toBeGreaterThanOrEqual(1);
      store.close();
    }, 90_000);
  });

  /**
   * A type is a link, and one pair of thoughts has one link. Measured on
   * TheBrain 15.0.640; the spec has none of it. `brain_link` and ingest ask
   * `links.between()` first and leave a link they find as it is.
   */
  describe("one link per pair of thoughts, and links towards a type", () => {
    const makeUnder = async (
      name: string,
      extra: { sourceThoughtId?: string; typeId?: string },
    ): Promise<string> => {
      const id = await api.thoughts.create(brainId, { name: PREFIX + name, ...extra });
      created.push(id);
      return id;
    };
    const graphOf = (id: string, ok: (g: CleanGraph) => boolean): Promise<CleanGraph> =>
      eventually(() => api.thoughts.getGraph(brainId, id), ok);
    const ids = (thoughts: readonly ThoughtDto[]): string[] => thoughts.map((t) => t.id);
    const read = (id: string, ok: (t: ThoughtDto) => boolean): Promise<ThoughtDto> =>
      eventually(() => api.thoughts.get(brainId, id), ok);
    /** A link as the API takes it: `links.create` refuses a type above. */
    const rawLink = (
      thoughtIdA: string,
      thoughtIdB: string,
      relation: number,
    ): Promise<{ id: string }> =>
      api.client.post<{ id: string }>(`/api/links/${brainId}`, {
        json: { thoughtIdA, thoughtIdB, relation },
      });
    /** And a thought created under whatever it names, a type included. */
    const rawUnder = async (name: string, extra: Record<string, unknown>): Promise<string> => {
      const { id } = await api.client.post<{ id: string }>(`/api/thoughts/${brainId}`, {
        json: { name: PREFIX + name, kind: ThoughtKind.Normal, acType: 0, relation: 1, ...extra },
      });
      created.push(id);
      return id;
    };

    it("a second link posted between two thoughts rewrites the first and returns its identifier", async () => {
      const parent = await make("one-link-parent");
      const child = await makeUnder("one-link-child", { sourceThoughtId: parent });
      const hierarchy = await api.links.between(brainId, parent, child);
      expect(hierarchy?.relation).toBe(Relation.Child);

      // No error and no second link: the child stops being a child.
      const jump = await api.links.create(brainId, {
        thoughtIdA: child,
        thoughtIdB: parent,
        relation: Relation.Jump,
      });
      expect(jump).toBe(hierarchy!.id);
      const jumped = await graphOf(parent, (g) => ids(g.jumps).includes(child));
      expect(ids(jumped.jumps)).toContain(child);
      expect(ids(jumped.children)).not.toContain(child);
      expect(jumped.links).toHaveLength(1);

      // And back again.
      const again = await api.links.create(brainId, {
        thoughtIdA: parent,
        thoughtIdB: child,
        relation: Relation.Child,
      });
      expect(again).toBe(hierarchy!.id);
      const restored = await graphOf(parent, (g) => ids(g.children).includes(child));
      expect(ids(restored.children)).toContain(child);
      expect(restored.links).toHaveLength(1);
    }, 30_000);

    it("so a jump posted to a thought's own type or tag takes the type or the tag away", async () => {
      const typeId = await make("jumped-type", ThoughtKind.Type);
      const tagId = await make("jumped-tag", ThoughtKind.Tag);
      const id = await makeUnder("jumped", { typeId });
      await api.links.attachTag(brainId, id, tagId);
      await graphOf(id, (g) => ids(g.tags).includes(tagId));
      const typeLink = await api.links.between(brainId, typeId, id);
      const tagLink = await api.links.between(brainId, tagId, id);
      expect(isTypeLink(typeLink!)).toBe(true);

      for (const [other, link] of [
        [typeId, typeLink],
        [tagId, tagLink],
      ] as const) {
        const jump = await api.links.create(brainId, {
          thoughtIdA: id,
          thoughtIdB: other,
          relation: Relation.Jump,
        });
        expect(jump).toBe(link!.id);
      }

      const graph = await graphOf(id, (g) => g.type === null && g.tags.length === 0);
      expect(graph.type).toBeNull();
      expect(graph.tags).toEqual([]);
      expect(ids(graph.jumps).sort()).toEqual([typeId, tagId].sort());
      const thought = await eventually(
        () => api.thoughts.get(brainId, id),
        (t) => t.typeId === null,
      );
      expect(thought.typeId).toBeNull();
      for (const other of [typeId, tagId]) {
        const link = await api.links.between(brainId, other, id);
        expect([link?.relation, link?.meaning]).toEqual([Relation.Jump, LinkMeaning.Normal]);
      }

      // Setting the type turns that jump back into the type's link.
      await api.thoughts.update(brainId, id, { typeId });
      const back = await api.links.between(brainId, typeId, id);
      expect(back?.id).toBe(typeLink!.id);
      expect(isTypeLink(back!)).toBe(true);
    }, 30_000);

    it("a parent link towards a type sets the type, and replaces the one the thought had", async () => {
      const first = await make("linked-type-1", ThoughtKind.Type);
      const second = await make("linked-type-2", ThoughtKind.Type);
      const id = await make("linked-typed");
      const typed = (want: string): Promise<ThoughtDto> =>
        eventually(
          () => api.thoughts.get(brainId, id),
          (t) => t.typeId === want,
        );

      // The request `attachTag` sends for a tag.
      await rawLink(id, first, Relation.Parent);
      expect((await typed(first)).typeId).toBe(first);
      const link = await api.links.between(brainId, id, first);
      expect([link?.thoughtIdA, link?.relation]).toEqual([first, Relation.Child]);
      expect(isTypeLink(link!)).toBe(true);

      // Named from the type's side it is the same request. The old type goes.
      await rawLink(second, id, Relation.Child);
      expect((await typed(second)).typeId).toBe(second);
      const old = await eventually(
        () => api.links.between(brainId, first, id),
        (found) => found === null,
      );
      expect(old).toBeNull();
      expect((await graphOf(id, (g) => g.type?.id === second)).type?.id).toBe(second);
    }, 30_000);

    it("a thought created under a type has that type; a jump to a type, or the type as a child, is an ordinary link", async () => {
      const typeId = await make("parent-type", ThoughtKind.Type);
      const born = await rawUnder("born-under-type", { sourceThoughtId: typeId });
      expect((await api.thoughts.get(brainId, born)).typeId).toBe(typeId);
      expect(isTypeLink((await api.links.between(brainId, typeId, born))!)).toBe(true);
      // The type is all it has: no parent came of the request.
      const graph = await graphOf(born, (g) => g.type !== null);
      expect(graph.parents).toEqual([]);
      expect(graph.links).toHaveLength(1);

      const jumper = await make("jumps-to-type");
      const holder = await make("holds-type-as-child");
      await api.links.create(brainId, {
        thoughtIdA: jumper,
        thoughtIdB: typeId,
        relation: Relation.Jump,
      });
      await api.links.create(brainId, {
        thoughtIdA: holder,
        thoughtIdB: typeId,
        relation: Relation.Child,
      });
      await settle();
      for (const id of [jumper, holder]) {
        expect((await api.thoughts.get(brainId, id)).typeId, id).toBeNull();
        expect((await api.links.between(brainId, id, typeId))?.meaning).toBe(LinkMeaning.Normal);
      }
    });

    it("a thought created under one type with another for its typeId carries both, and the API's graph can name the wrong one", async () => {
      const older = await make("both-types-older", ThoughtKind.Type);
      const newer = await make("both-types-newer", ThoughtKind.Type);
      const [, higher] = [older, newer].sort();

      for (const [under, typeId] of [
        [older, newer],
        [newer, older],
      ] as const) {
        const id = await rawUnder("both-types", { sourceThoughtId: under, typeId });
        // `typeId` is the one the request called so, from the first read on.
        expect((await api.thoughts.get(brainId, id)).typeId).toBe(typeId);
        // The first read of a graph never read is live, and names the type of
        // the higher identifier whichever is `typeId`: 32 times of 32. Later
        // reads, from the copy, named either, and changed from read to read.
        const raw = await eventually(
          () => api.client.get<ThoughtGraphDto>(`/api/thoughts/${brainId}/${id}/graph`),
          (g) => (g.links ?? []).length === 2,
        );
        expect(raw.type?.id).toBe(higher);
        expect((raw.links ?? []).map((l) => [l.thoughtIdA, l.meaning]).sort()).toEqual(
          [
            [under, LinkMeaning.Type],
            [typeId, LinkMeaning.Type],
          ].sort(),
        );
        // The API lists both among the parents. `getGraph` lists neither: the
        // type is the one `typeId` names, and the other is beside it.
        expect(ids(raw.parents ?? []).sort()).toEqual([under, typeId].sort());
        const graph = await api.thoughts.getGraph(brainId, id);
        expect(graph.parents).toEqual([]);
        expect(graph.type?.id).toBe(typeId);
        expect(ids(graph.otherTypes)).toEqual([under]);

        // Deleting the link from `typeId`, the one way a type goes, leaves
        // the other one's link and a thought that reads as having no type.
        expect(await api.links.detachType(brainId, id, typeId)).toBe(true);
        const bare = await eventually(
          () => api.thoughts.get(brainId, id),
          (t) => t.typeId === null,
        );
        expect(bare.typeId).toBeNull();
        expect(isTypeLink((await api.links.between(brainId, under, id))!)).toBe(true);
        const left = await graphOf(id, (g) => g.links.length === 1);
        expect(left.type?.id).toBe(under);

        // So `removeType` deletes every type's link the thought has.
        await api.thoughts.update(brainId, id, { typeId: null });
        expect(await api.links.between(brainId, under, id)).toBeNull();
        expect((await graphOf(id, (g) => g.type === null)).type).toBeNull();
      }
    }, 30_000);

    it("of two types, deleting either link reads back as no typeId; a patch leaves two links, and only a create makes them", async () => {
      const typeLinks = async (id: string, types: readonly string[]): Promise<string[]> => {
        const found: string[] = [];
        for (const t of types) {
          const link = await api.links.between(brainId, t, id);
          if (link?.meaning === LinkMeaning.Type) found.push(t);
        }
        return found;
      };
      const [first, second, third] = [
        await make("two-types-1", ThoughtKind.Type),
        await make("two-types-2", ThoughtKind.Type),
        await make("two-types-3", ThoughtKind.Type),
      ];
      const both = () => rawUnder("two-types", { sourceThoughtId: first, typeId: second });

      // Either link deleted: `typeId` reads null, and the other link stays.
      for (const gone of [second, first]) {
        const id = await both();
        await read(id, (t) => t.typeId === second);
        await api.client.delete(
          `/api/links/${brainId}/${(await api.links.between(brainId, gone, id))!.id}`,
        );
        expect((await read(id, (t) => t.typeId === null)).typeId).toBeNull();
        const kept = [first, second].filter((t) => t !== gone);
        expect(await typeLinks(id, [first, second])).toEqual(kept);
      }

      // A patch to the other of the two changes nothing.
      const patched = await both();
      await read(patched, (t) => t.typeId === second);
      await api.client.patch(`/api/thoughts/${brainId}/${patched}`, {
        jsonPatch: [{ op: "replace", path: "/typeId", value: first }],
      });
      await settle(600);
      expect((await api.thoughts.get(brainId, patched)).typeId).toBe(second);
      expect(await typeLinks(patched, [first, second])).toEqual([first, second]);

      // To a third, the third comes in and one of the two goes.
      await api.client.patch(`/api/thoughts/${brainId}/${patched}`, {
        jsonPatch: [{ op: "replace", path: "/typeId", value: third }],
      });
      expect((await read(patched, (t) => t.typeId === third)).typeId).toBe(third);
      await settle(600);
      const after = await typeLinks(patched, [first, second, third]);
      expect(after).toHaveLength(2);
      expect(after).toContain(third);

      // A thought made under one type and then given another has one link.
      const moved = await rawUnder("one-type-then-another", { sourceThoughtId: first });
      await api.client.patch(`/api/thoughts/${brainId}/${moved}`, {
        jsonPatch: [{ op: "replace", path: "/typeId", value: second }],
      });
      expect((await read(moved, (t) => t.typeId === second)).typeId).toBe(second);
      await settle(600);
      expect(await typeLinks(moved, [first, second])).toEqual([second]);
    }, 30_000);

    it("a tag linked under a type is a 200 with an identifier of zeros, and no link is made", async () => {
      const typeId = await make("type-over-tag", ThoughtKind.Type);
      const tagId = await make("tag-under-type", ThoughtKind.Tag);

      for (const answer of [
        await rawLink(tagId, typeId, Relation.Parent),
        await rawLink(typeId, tagId, Relation.Child),
      ]) {
        expect(answer.id).toBe("00000000-0000-0000-0000-000000000000");
      }
      await settle(600);
      expect(await api.links.between(brainId, tagId, typeId)).toBeNull();
      expect((await api.thoughts.get(brainId, tagId)).typeId).toBeNull();
    });
  });

  /**
   * A type on a type, a tag on a tag, and a type and a tag on each other: the
   * link each makes, what each end's graph lists, and what takes it apart.
   * Measured on 15.0.640 (docs/api-map.md, L44), 5 of 5 for each way of
   * making one. Raw where the client refuses the request now.
   */
  describe("a type on a type, a tag on a tag, and the two on each other", () => {
    const stamp = `pair${Date.now()}`;
    const ids = (thoughts: readonly ThoughtDto[]): string[] => thoughts.map((t) => t.id);
    const rawGraph = (id: string): Promise<ThoughtGraphDto> =>
      api.client.get<ThoughtGraphDto>(`/api/thoughts/${brainId}/${id}/graph`);
    const rawLink = (thoughtIdA: string, thoughtIdB: string, relation: number) =>
      api.client.post<{ id: string }>(`/api/links/${brainId}`, {
        json: { thoughtIdA, thoughtIdB, relation },
      });
    const patchTypeId = (id: string, typeId: string) =>
      api.client.patch(`/api/thoughts/${brainId}/${id}`, {
        jsonPatch: [{ op: "replace", path: "/typeId", value: typeId }],
      });
    /** A link as [the end at its head, relation, meaning], once there is one. */
    const linkOf = async (a: string, b: string): Promise<unknown[]> => {
      const link = await eventually(
        () => api.links.between(brainId, a, b),
        (found) => found !== null,
        { timeoutMs: 3000 },
      );
      return [link?.thoughtIdA, link?.relation, link?.meaning];
    };

    it("a type set on a type is a link of meaning 3, by a patch, a link from either end or a kind change, and typeId null takes it away", async () => {
      const ways: Array<[string, (lower: string, upper: string) => Promise<unknown>]> = [
        ["patch", (lower, upper) => patchTypeId(lower, upper)],
        ["child link from the upper", (lower, upper) => rawLink(upper, lower, Relation.Child)],
        ["parent link from the lower", (lower, upper) => rawLink(lower, upper, Relation.Parent)],
      ];
      for (const [way, write] of ways) {
        const upper = await make(`${stamp}-tup`, ThoughtKind.Type);
        const lower = await make(`${stamp}-tlow`, ThoughtKind.Type);
        await write(lower, upper);
        expect(await linkOf(lower, upper), way).toEqual([
          upper,
          Relation.Child,
          LinkMeaning.SubType,
        ]);
        const typed = await eventually(
          () => api.thoughts.get(brainId, lower),
          (t) => t.typeId === upper,
        );
        expect(typed.typeId, way).toBe(upper);

        // The lower one's graph has it for its type and among its parents,
        // and the upper one's lists the lower among its children.
        const raw = await eventually(
          () => rawGraph(lower),
          (g) => g.type !== null,
        );
        expect([raw.type?.id, ids(raw.parents ?? [])], way).toEqual([upper, [upper]]);
        const above = await eventually(
          () => rawGraph(upper),
          (g) => (g.children ?? []).length > 0,
        );
        expect(ids(above.children ?? []), way).toEqual([lower]);
        const graph = await api.thoughts.getGraph(brainId, lower);
        expect([graph.type?.id, graph.parents, graph.otherTypes], way).toEqual([upper, [], []]);

        // It was left alone, as a link that is not the type's.
        await api.thoughts.update(brainId, lower, { typeId: null });
        expect((await api.thoughts.get(brainId, lower)).typeId, way).toBeNull();
        expect(await api.links.between(brainId, upper, lower), way).toBeNull();
      }

      // A type set over a type's type replaces it, as for any thought.
      const first = await make(`${stamp}-tup-first`, ThoughtKind.Type);
      const second = await make(`${stamp}-tup-second`, ThoughtKind.Type);
      const retyped = await make(`${stamp}-tlow-retyped`, ThoughtKind.Type);
      await patchTypeId(retyped, first);
      await eventually(
        () => api.thoughts.get(brainId, retyped),
        (t) => t.typeId === first,
      );
      await patchTypeId(retyped, second);
      await eventually(
        () => api.thoughts.get(brainId, retyped),
        (t) => t.typeId === second,
      );
      expect(await linkOf(retyped, second)).toEqual([second, Relation.Child, LinkMeaning.SubType]);
      expect(await api.links.between(brainId, first, retyped)).toBeNull();

      // An ordinary thought of a type, turned into a type: its link turns too.
      const upper = await make(`${stamp}-tup-kind`, ThoughtKind.Type);
      const lower = await api.thoughts.create(brainId, {
        name: `${PREFIX}${stamp}-turned`,
        typeId: upper,
      });
      created.push(lower);
      expect(await linkOf(lower, upper)).toEqual([upper, Relation.Child, LinkMeaning.Type]);
      await api.thoughts.update(brainId, lower, { kind: ThoughtKind.Type });
      const turned = await eventually(
        () => api.links.between(brainId, lower, upper),
        (found) => found?.meaning === LinkMeaning.SubType,
      );
      expect(turned?.meaning).toBe(LinkMeaning.SubType);
      await api.thoughts.update(brainId, lower, { typeId: null });
      expect(await api.links.between(brainId, upper, lower)).toBeNull();
    }, 60_000);

    it("a tag on a tag is a link of meaning 7 whichever request makes it, with the upper end the request's", async () => {
      // The request that attaches a tag and a child link from the upper one
      // are L23's. Here: a patch of typeId naming a tag, and a child link
      // named from the other end, which puts that end above.
      const upper = await make(`${stamp}-gup`, ThoughtKind.Tag);
      const lower = await make(`${stamp}-glow`, ThoughtKind.Tag);
      await patchTypeId(lower, upper);
      expect(await linkOf(lower, upper)).toEqual([upper, Relation.Child, LinkMeaning.SubTag]);
      expect((await api.thoughts.get(brainId, lower)).typeId).toBeNull();
      const raw = await eventually(
        () => rawGraph(lower),
        (g) => (g.tags ?? []).length > 0,
      );
      expect([ids(raw.tags ?? []), ids(raw.parents ?? [])]).toEqual([[upper], [upper]]);
      expect(await api.links.detachTag(brainId, lower, upper)).toBe(true);
      await settle(600);

      await rawLink(lower, upper, Relation.Child);
      expect(await linkOf(lower, upper)).toEqual([lower, Relation.Child, LinkMeaning.SubTag]);
      const flipped = await eventually(
        () => rawGraph(upper),
        (g) => (g.tags ?? []).length > 0,
      );
      expect([ids(flipped.tags ?? []), ids(flipped.parents ?? [])]).toEqual([[lower], [lower]]);
      const graph = await api.thoughts.getGraph(brainId, upper);
      expect([ids(graph.tags), graph.parents]).toEqual([[lower], []]);

      // And a parent link from the one meant to be lower puts the other above.
      expect(await api.links.detachTag(brainId, upper, lower)).toBe(true);
      await settle(600);
      await rawLink(upper, lower, Relation.Parent);
      expect(await linkOf(lower, upper)).toEqual([lower, Relation.Child, LinkMeaning.SubTag]);
    }, 30_000);

    it("a tag on a type is an attached tag, in the type's tags alone; a type on a tag is nothing", async () => {
      const ways: Array<[string, (type: string, tag: string) => Promise<unknown>]> = [
        ["the request that attaches a tag", (type, tag) => rawLink(type, tag, Relation.Parent)],
        ["a child link from the tag", (type, tag) => rawLink(tag, type, Relation.Child)],
        ["a patch of typeId", (type, tag) => patchTypeId(type, tag)],
      ];
      for (const [i, [way, write]] of ways.entries()) {
        const type = await make(`${stamp}-t-tagged`, ThoughtKind.Type);
        // A name of its own each time: a tag made under the name of one
        // that is there is that one (L39).
        const tag = await make(`${stamp}-g-on-type-${i}`, ThoughtKind.Tag);
        await write(type, tag);
        expect(await linkOf(type, tag), way).toEqual([tag, Relation.Child, LinkMeaning.Tag]);
        const raw = await eventually(
          () => rawGraph(type),
          (g) => (g.tags ?? []).length > 0,
        );
        expect([ids(raw.tags ?? []), ids(raw.parents ?? []), raw.type], way).toEqual([
          [tag],
          [],
          null,
        ]);
        // Deleted, it leaves the type as it was.
        expect(await api.links.detachTag(brainId, type, tag), way).toBe(true);
        const bare = await eventually(
          () => rawGraph(type),
          (g) => (g.tags ?? []).length === 0,
        );
        expect([bare.tags ?? [], bare.parents ?? [], bare.links ?? []], way).toEqual([[], [], []]);
      }

      // A type for a tag's typeId: a 200 that sets nothing and links nothing.
      const tag = await make(`${stamp}-g-typed`, ThoughtKind.Tag);
      const type = await make(`${stamp}-t-on-tag`, ThoughtKind.Type);
      await patchTypeId(tag, type);
      await settle(600);
      expect((await api.thoughts.get(brainId, tag)).typeId).toBeNull();
      expect(await api.links.between(brainId, tag, type)).toBeNull();
    }, 30_000);
  });

  /**
   * What `links.create`, `thoughts.create` and ingest do about a type named as
   * a parent, and what they let through. The API facts are in the block above.
   */
  describe("a type named as a parent", () => {
    const graphOf = (id: string, ok: (g: CleanGraph) => boolean): Promise<CleanGraph> =>
      eventually(() => api.thoughts.getGraph(brainId, id), ok);
    const ids = (thoughts: readonly ThoughtDto[]): string[] => thoughts.map((t) => t.id);
    const refusal = (field: string, type: string) => ({
      kind: "not_a_parent",
      message: expect.stringMatching(
        new RegExp(`^${field} \\S+ cannot be a parent: it is the type "${PREFIX}${type}"$`),
      ),
    });

    it("links.create and create refuse a type above, and write nothing", async () => {
      const kept = await make("np-kept-type", ThoughtKind.Type);
      const other = await make("np-other-type", ThoughtKind.Type);
      const bare = await make("np-bare");
      const typed = await api.thoughts.create(brainId, { name: `${PREFIX}np-typed`, typeId: kept });
      created.push(typed);

      for (const id of [bare, typed]) {
        await expect(
          api.links.create(brainId, { thoughtIdA: id, thoughtIdB: other, relation: Relation.Parent }),
        ).rejects.toMatchObject(refusal("thoughtIdB", "np-other-type"));
        await expect(
          api.links.create(brainId, { thoughtIdA: other, thoughtIdB: id, relation: Relation.Child }),
        ).rejects.toMatchObject(refusal("thoughtIdA", "np-other-type"));
      }
      for (const extra of [{}, { typeId: kept }, { typeId: other }]) {
        await expect(
          api.thoughts.create(brainId, {
            name: `${PREFIX}np-never-made`,
            sourceThoughtId: other,
            ...extra,
          }),
        ).rejects.toMatchObject(refusal("sourceThoughtId", "np-other-type"));
      }

      await settle();
      expect((await api.thoughts.getGraph(brainId, bare)).links).toEqual([]);
      // The type it had, and not the one it was to be linked under.
      const graph = await api.thoughts.getGraph(brainId, typed);
      expect(graph.type?.id).toBe(kept);
      expect(graph.links).toHaveLength(1);
      // No thought was made: a type's graph lists its instances as children.
      expect((await api.thoughts.getGraph(brainId, other)).children).toEqual([]);
    });

    it("under a tag a thought is created tagged and with no parent, and nobody's identifier is the API's to answer", async () => {
      const tagId = await make("np-tag", ThoughtKind.Tag);
      // As the API takes it: `create` refuses a tag above, as it does a type.
      const { id } = await api.client.post<{ id: string }>(`/api/thoughts/${brainId}`, {
        json: {
          name: `${PREFIX}np-under-tag`,
          kind: ThoughtKind.Normal,
          acType: 0,
          sourceThoughtId: tagId,
          relation: Relation.Child,
        },
      });
      created.push(id);

      const graph = await graphOf(id, (g) => g.tags.length === 1);
      expect(ids(graph.tags)).toEqual([tagId]);
      expect(graph.parents).toEqual([]);
      expect(isTagLink((await api.links.between(brainId, id, tagId))!)).toBe(true);
      // The tag's graph has it among `children`, which is where a second run
      // of a plan looked for it, and found it.
      const marked = await graphOf(tagId, (g) => ids(g.children).includes(id));
      expect(ids(marked.children)).toEqual([id]);

      // An identifier nobody has is left to the write, which answers for it.
      const nobody = crypto.randomUUID();
      await expect(
        api.thoughts.create(brainId, { name: `${PREFIX}np-never-made`, sourceThoughtId: nobody }),
      ).rejects.toMatchObject({
        kind: "not_found",
        message: `Source Thought ${nobody} could not be located`,
      });
      await expect(
        api.links.create(brainId, { thoughtIdA: id, thoughtIdB: nobody, relation: Relation.Parent }),
      ).rejects.toMatchObject({
        kind: "bad_request",
        message: `Could not get target thought ${nobody}`,
      });
    });

    it("ingest writes no part of a plan that names a type as a parent, by a thought or by a link", async () => {
      const kept = await make("np-plan-kept", ThoughtKind.Type);
      const other = await make("np-plan-type", ThoughtKind.Type);
      const root = await make("np-plan-root");
      const typed = await api.thoughts.create(brainId, {
        name: `${PREFIX}np-plan-typed`,
        typeId: kept,
      });
      created.push(typed);
      const top = { tempId: "top", name: `${PREFIX}np-plan-top`, parent: root };

      await expect(
        ingest(api, brainId, {
          thoughts: [top, { tempId: "leaf", name: `${PREFIX}np-plan-leaf`, parent: other }],
        }),
      ).rejects.toMatchObject(refusal("parent", "np-plan-type"));
      await expect(
        ingest(api, brainId, {
          thoughts: [top],
          links: [{ from: typed, to: other, relation: "parent" }],
        }),
      ).rejects.toMatchObject(refusal("to", "np-plan-type"));
      await expect(
        ingest(api, brainId, {
          thoughts: [top],
          links: [{ from: other, to: "top", relation: "child" }],
        }),
      ).rejects.toMatchObject(refusal("from", "np-plan-type"));

      await settle();
      expect((await api.thoughts.getGraph(brainId, root)).children).toEqual([]);
      expect((await api.thoughts.getGraph(brainId, other)).children).toEqual([]);
      expect((await api.thoughts.get(brainId, typed)).typeId).toBe(kept);
    });

    it("a plan thought that lands on a type its parent holds gets nothing put under it", async () => {
      // A type can be an ordinary child of a thought, and deduplication takes
      // it for the plan's thought of that name. The thought under it used to
      // be created as one of that type and reported as created.
      const root = await make("np-holder");
      const held = await make("np-held-type", ThoughtKind.Type);
      await api.links.create(brainId, {
        thoughtIdA: root,
        thoughtIdB: held,
        relation: Relation.Child,
      });
      await graphOf(root, (g) => ids(g.children).includes(held));

      const outcome = await ingest(api, brainId, {
        thoughts: [
          { tempId: "x", name: `${PREFIX}np-held-type`, parent: root },
          { tempId: "leaf", name: `${PREFIX}np-held-leaf`, parent: "x" },
          { tempId: "deep", name: `${PREFIX}np-held-deep`, parent: "leaf" },
        ],
      });
      for (const c of outcome.created) created.push(c.thoughtId);

      expect(outcome.reused.map((r) => r.thoughtId)).toEqual([held]);
      expect(outcome.created).toEqual([]);
      expect(outcome.failures).toHaveLength(1);
      expect(outcome.failures[0]!.reason).toMatch(/^sourceThoughtId \S+ cannot be a parent: it is the type/);
      // Nor is the thought under the refused one made a root in its place.
      expect(outcome.skipped).toEqual([
        {
          what: `thought "${PREFIX}np-held-deep" (deep)`,
          reason: 'depends on "leaf", which was not created',
        },
      ]);
      await settle();
      expect((await api.thoughts.getGraph(brainId, held)).children).toEqual([]);
    });
  });

  /**
   * A tag named as a parent. What the API does with one is pinned above: a
   * thought linked or created under a tag is tagged, and has no parent for
   * it. `brain_link` reported that as a link created, and
   * `brain_create_thought` and `brain_ingest` as a thought created, five of
   * five each on TheBrain 15.0.640.
   */
  describe("a tag named as a parent", () => {
    const ids = (thoughts: readonly ThoughtDto[]): string[] => thoughts.map((t) => t.id);
    const refusal = (field: string, tag: string) => ({
      kind: "tag_as_parent",
      message: expect.stringMatching(
        new RegExp(`^${field} \\S+ cannot be a parent: it is the tag "${PREFIX}${tag}"$`),
      ),
    });

    it("links.create and create refuse a tag above, and write nothing", async () => {
      const tagId = await make("tp-tag", ThoughtKind.Tag);
      const lowerTag = await make("tp-lower-tag", ThoughtKind.Tag);
      const typeId = await make("tp-type", ThoughtKind.Type);
      const bare = await make("tp-bare");

      // An ordinary thought, a type and another tag: each would be tagged.
      for (const id of [bare, typeId, lowerTag]) {
        await expect(
          api.links.create(brainId, {
            thoughtIdA: id,
            thoughtIdB: tagId,
            relation: Relation.Parent,
          }),
        ).rejects.toMatchObject(refusal("thoughtIdB", "tp-tag"));
        await expect(
          api.links.create(brainId, {
            thoughtIdA: tagId,
            thoughtIdB: id,
            relation: Relation.Child,
          }),
        ).rejects.toMatchObject(refusal("thoughtIdA", "tp-tag"));
      }
      await expect(
        api.thoughts.create(brainId, { name: `${PREFIX}tp-never-made`, sourceThoughtId: tagId }),
      ).rejects.toMatchObject(refusal("sourceThoughtId", "tp-tag"));

      await settle();
      for (const id of [bare, typeId, lowerTag]) {
        expect((await api.thoughts.getGraph(brainId, id)).links, id).toEqual([]);
      }
      // No thought was made: a tag's graph lists what it marks as children.
      expect((await api.thoughts.getGraph(brainId, tagId)).children).toEqual([]);
    });

    it("ingest writes no part of a plan that names a tag as a parent, by a thought or by a link", async () => {
      const tagId = await make("tp-plan-tag", ThoughtKind.Tag);
      const root = await make("tp-plan-root");
      const old = await make("tp-plan-old");
      const top = { tempId: "top", name: `${PREFIX}tp-plan-top`, parent: root };

      await expect(
        ingest(api, brainId, {
          thoughts: [top, { tempId: "leaf", name: `${PREFIX}tp-plan-leaf`, parent: tagId }],
        }),
      ).rejects.toMatchObject(refusal("parent", "tp-plan-tag"));
      await expect(
        ingest(api, brainId, {
          thoughts: [top],
          links: [{ from: old, to: tagId, relation: "parent" }],
        }),
      ).rejects.toMatchObject(refusal("to", "tp-plan-tag"));
      await expect(
        ingest(api, brainId, {
          thoughts: [top],
          links: [{ from: tagId, to: "top", relation: "child" }],
        }),
      ).rejects.toMatchObject(refusal("from", "tp-plan-tag"));

      await settle();
      expect((await api.thoughts.getGraph(brainId, root)).children).toEqual([]);
      expect((await api.thoughts.getGraph(brainId, tagId)).children).toEqual([]);
      expect((await api.thoughts.getGraph(brainId, old)).tags).toEqual([]);

      // What the refusal points at attaches the tag, and says so.
      const outcome = await ingest(api, brainId, { thoughts: [{ ...top, tagIds: [tagId] }] });
      for (const c of outcome.created) created.push(c.thoughtId);
      expect(outcome.tagsAttached).toBe(1);
      const made = outcome.created[0]!.thoughtId;
      const graph = await eventually(
        () => api.thoughts.getGraph(brainId, made),
        (g) => g.tags.length === 1,
      );
      expect(ids(graph.tags)).toEqual([tagId]);
      expect(ids(graph.parents)).toEqual([root]);
    });
  });

  /**
   * A link the API answers with a 200 and makes none of. `links.create()`
   * returned the identifier of zeros as the new link's, `brain_link` answered
   * "link created" with it for a thought linked to itself, and `brain_ingest`
   * counted it under "links created": three of three each on TheBrain
   * 15.0.640.
   */
  describe("a link the API does not make", () => {
    const ZEROS = "00000000-0000-0000-0000-000000000000";
    const KINDS = [ThoughtKind.Normal, ThoughtKind.Type, ThoughtKind.Tag] as const;
    const rawLink = (
      thoughtIdA: string,
      thoughtIdB: string,
      relation: number,
    ): Promise<{ id: string }> =>
      api.client.post<{ id: string }>(`/api/links/${brainId}`, {
        json: { thoughtIdA, thoughtIdB, relation },
      });

    it("a thought linked to itself is a 200 with an identifier of zeros under every relation, whatever its kind", async () => {
      for (const kind of KINDS) {
        const id = await make(`nl-self-${kind}`, kind);
        for (const relation of [Relation.Child, Relation.Parent, Relation.Jump]) {
          expect((await rawLink(id, id, relation)).id, `kind ${kind}, relation ${relation}`).toBe(
            ZEROS,
          );
          // So `links.create` does not send it.
          await expect(
            api.links.create(brainId, { thoughtIdA: id, thoughtIdB: id, relation }),
          ).rejects.toMatchObject({
            kind: "bad_request",
            message: `a thought cannot be linked to itself: both ends of the link are ${id}`,
          });
        }
        await settle(600);
        expect((await api.thoughts.getGraph(brainId, id)).links, `kind ${kind}`).toEqual([]);
      }
    }, 30_000);

    it("of the pairs of kinds, a tag under a type alone is answered with zeros: every other one is linked", async () => {
      // Three thoughts of each kind, and a pair of its own for each of the 27
      // ways to write a link between two kinds: two thoughts share one link.
      const pool = new Map<number, string[]>();
      for (const kind of KINDS) {
        pool.set(kind, [
          await make(`nl-${kind}-0`, kind),
          await make(`nl-${kind}-1`, kind),
          await make(`nl-${kind}-2`, kind),
        ]);
      }
      const pair = (kindA: number, kindB: number, relation: number): [string, string] => {
        const [as, bs] = [pool.get(kindA)!, pool.get(kindB)!];
        if (kindA === kindB) return [as[relation - 1]!, as[relation % 3]!];
        return kindA < kindB ? [as[relation - 1]!, bs[0]!] : [as[1]!, bs[relation - 1]!];
      };
      /**
       * What a parent-child link is, by the kind above and the kind below.
       * A tag above is its attachment (5, and 7 on another tag), a type
       * above a thought its type (2), and a type above a type has a meaning
       * of its own, 3, which `LinkMeaning` does not name.
       */
      const meaning = (upper: number, lower: number): number | null => {
        if (upper === ThoughtKind.Normal) return LinkMeaning.Normal;
        if (upper === ThoughtKind.Tag) {
          return lower === ThoughtKind.Tag ? LinkMeaning.SubTag : LinkMeaning.Tag;
        }
        if (lower === ThoughtKind.Normal) return LinkMeaning.Type;
        return lower === ThoughtKind.Type ? 3 : null;
      };

      const zeros: string[] = [];
      for (const kindA of KINDS) {
        for (const kindB of KINDS) {
          for (const relation of [Relation.Child, Relation.Parent, Relation.Jump]) {
            const cell = `kind ${kindA} to kind ${kindB}, relation ${relation}`;
            const [a, b] = pair(kindA, kindB, relation);
            const { id } = await rawLink(a, b, relation);
            const [upper, upperKind, lowerKind] =
              relation === Relation.Parent ? [b, kindB, kindA] : [a, kindA, kindB];
            const expected =
              relation === Relation.Jump ? LinkMeaning.Normal : meaning(upperKind, lowerKind);
            if (expected === null) {
              expect(id, cell).toBe(ZEROS);
              zeros.push(cell);
              continue;
            }
            expect(id, cell).not.toBe(ZEROS);
            const link = await eventually(
              () => api.links.between(brainId, a, b),
              (found) => found !== null,
            );
            // Stored with relation 1 or 3, never 2, the upper end at its head.
            expect([link?.id, link?.thoughtIdA, link?.relation, link?.meaning], cell).toEqual([
              id,
              upper,
              relation === Relation.Jump ? Relation.Jump : Relation.Child,
              expected,
            ]);
          }
        }
      }

      // The tag under the type, written from either end, and nothing else.
      expect(zeros).toEqual([
        `kind ${ThoughtKind.Type} to kind ${ThoughtKind.Tag}, relation ${Relation.Child}`,
        `kind ${ThoughtKind.Tag} to kind ${ThoughtKind.Type}, relation ${Relation.Parent}`,
      ]);
      await settle(600);
      const [types, tags] = [pool.get(ThoughtKind.Type)!, pool.get(ThoughtKind.Tag)!];
      expect(await api.links.between(brainId, types[0]!, tags[0]!)).toBeNull();
      expect(await api.links.between(brainId, tags[1]!, types[1]!)).toBeNull();
    }, 60_000);

    it("a thought is created with an identifier of its own where the link to its source is not made", async () => {
      // The two creates that ask for a tag under a type. Neither answered
      // with zeros, nor did any other of 28 creates picked to.
      const typeId = await make("nl-source-type", ThoughtKind.Type);
      const tagId = await make("nl-source-tag", ThoughtKind.Tag);
      for (const [what, extra] of [
        ["a tag under a type", { kind: ThoughtKind.Tag, sourceThoughtId: typeId, relation: 1 }],
        ["a type above a tag", { kind: ThoughtKind.Type, sourceThoughtId: tagId, relation: 2 }],
      ] as const) {
        const { id } = await api.client.post<{ id: string }>(`/api/thoughts/${brainId}`, {
          json: { name: `${PREFIX}nl-born`, acType: 0, ...extra },
        });
        created.push(id);
        expect(isUuid(id), what).toBe(true);
        expect(id, what).not.toBe(ZEROS);
        await settle(600);
        const graph = await api.thoughts.getGraph(brainId, id);
        expect(graph.thought.kind, what).toBe(extra.kind);
        expect(graph.links, what).toEqual([]);
      }
    });
  });

  /**
   * A link between two thoughts that something joins already. `brain_link`
   * answered "Link already existed" whatever it was and wrote its label onto
   * it, a tag's attachment and a type's link included; `brain_ingest` called
   * every parent link a mismatch, and a link the other way up, a tag and a
   * type the child link asked for. Three of three each on TheBrain 15.0.640.
   */
  describe("a link already there that is not the one asked for", () => {
    const shape = (link: LinkDto | null): unknown[] => [
      link?.thoughtIdA,
      link?.relation,
      link?.meaning,
      link?.name ?? null,
    ];

    it("ingest names what joins the two, labels an ordinary link alone, and leaves each as it was", async () => {
      const tagId = await make("la-tag", ThoughtKind.Tag);
      const typeId = await make("la-type", ThoughtKind.Type);
      const root = await make("la-root");
      const upper = await make("la-upper");
      const beside = await make("la-beside");
      const id = await api.thoughts.create(brainId, {
        name: `${PREFIX}la-thought`,
        sourceThoughtId: upper,
        typeId,
      });
      created.push(id);
      await api.links.create(brainId, {
        thoughtIdA: id,
        thoughtIdB: beside,
        relation: Relation.Jump,
      });
      await api.links.attachTag(brainId, id, tagId);
      // And a child of its own, for a link asked for the other way up: a
      // plan's second link between one pair is not sent at all (L35), so each
      // link below asks about a pair of its own.
      const under = await api.thoughts.create(brainId, {
        name: `${PREFIX}la-under`,
        sourceThoughtId: id,
      });
      created.push(under);
      await eventually(
        () => api.thoughts.getGraph(brainId, id),
        (g) => g.tags.length === 1 && g.jumps.length === 1 && g.children.length === 1,
      );

      // As the API stores them, which is what the report reads: a parent's
      // link from the upper end, a tag's and a type's from the tag and the type.
      const before = {
        upper: await api.links.between(brainId, id, upper),
        beside: await api.links.between(brainId, id, beside),
        tag: await api.links.between(brainId, id, tagId),
        type: await api.links.between(brainId, id, typeId),
      };
      expect(shape(before.upper)).toEqual([upper, Relation.Child, LinkMeaning.Normal, null]);
      expect(shape(before.beside)).toEqual([id, Relation.Jump, LinkMeaning.Normal, null]);
      expect(shape(before.tag)).toEqual([tagId, Relation.Child, LinkMeaning.Tag, null]);
      expect(shape(before.type)).toEqual([typeId, Relation.Child, LinkMeaning.Type, null]);
      const asked = { from: id, to: upper, fromName: "from", toName: "to" };
      expect(linkFound(before.upper!, { ...asked, relation: "parent" }).asAsked).toBe(true);
      expect(linkFound(before.upper!, { ...asked, relation: "child" }).asAsked).toBe(false);

      const outcome = await ingest(api, brainId, {
        thoughts: [{ tempId: "new", name: `${PREFIX}la-new`, parent: root, relation: "parent" }],
        links: [
          // Exactly what is there, the second of them made by this plan.
          { from: id, to: upper, relation: "parent", name: "belongs to" },
          { from: root, to: "new", relation: "parent", name: "sits under" },
          // Another kind, and the other way up.
          { from: id, to: beside, relation: "child", name: "holds" },
          { from: id, to: under, relation: "parent" },
          // No link at all between two thoughts.
          { from: id, to: tagId, name: "about" },
          { from: id, to: typeId, relation: "jump", name: "an example of" },
        ],
      });
      for (const c of outcome.created) created.push(c.thoughtId);

      expect(outcome.failures).toEqual([]);
      expect(outcome.linksCreated).toBe(0);
      const notes = (list: ReadonlyArray<{ from: string; to: string; note: string }>) =>
        Object.fromEntries(list.map((l) => [`${l.from} -> ${l.to}`, l.note]));
      expect(notes(outcome.linksReused)).toEqual({
        [`${id} -> ${upper}`]: "the link already existed, label updated",
        [`${root} -> new`]: "the link already existed, label updated",
        [`${id} -> ${beside}`]:
          `the link already existed as jump, the requested parent-child with ${id} above ` +
          "was not added — only the label was updated",
        [`${id} -> ${under}`]:
          `the link already existed as parent-child with ${id} above, the requested ` +
          `parent-child with ${under} above was not added`,
      });
      const over = "and two thoughts share one link: the requested jump was not added in its place";
      expect(notes(outcome.linksNotAdded)).toEqual({
        [`${id} -> ${tagId}`]: `${tagId} is a tag on ${id}, ${over}, and no label was written`,
        [`${id} -> ${typeId}`]: `${typeId} is the type of ${id}, ${over}, and no label was written`,
      });

      const named = await eventually(
        () => api.links.between(brainId, id, beside),
        (link) => link?.name === "holds",
      );
      expect(shape(named)).toEqual([id, Relation.Jump, LinkMeaning.Normal, "holds"]);
      const labelled = await eventually(
        () => api.links.between(brainId, id, upper),
        (link) => link?.name === "belongs to",
      );
      expect(shape(labelled)).toEqual([upper, Relation.Child, LinkMeaning.Normal, "belongs to"]);
      await settle(600);
      // Neither has a label, and the thought has its tag and its type.
      expect(shape(await api.links.between(brainId, id, tagId))).toEqual(shape(before.tag));
      expect(shape(await api.links.between(brainId, id, typeId))).toEqual(shape(before.type));
      const graph = await api.thoughts.getGraph(brainId, id);
      expect(graph.tags.map((t) => t.id)).toEqual([tagId]);
      expect(graph.type?.id).toBe(typeId);
    }, 30_000);
  });

  /**
   * What ingest leaves behind when a thought of the plan is not created. The
   * thoughts under it used to be created with no parent and reported as
   * created, and every further run of the plan made them again: measured on
   * TheBrain 15.0.640, three batches of three, two more each run.
   */
  describe("a batch that fails part way", () => {
    const needs = (tempId: string): string => `depends on "${tempId}", which was not created`;
    /** The thoughts the log says were created since `since`. */
    const madeSince = async (since: string): Promise<string[]> =>
      (await api.brains.modifications(brainId, { maxLogs: 1000, since }))
        .filter((l) => l.modType === ModType.Created && l.sourceType === EntityType.Thought)
        .map((l) => l.sourceId)
        .sort();

    it("nothing is made under a thought that was not, a second run adds nothing, and the rest lands by identifier", async () => {
      const root = await make("pf-root");
      const tagId = await make("pf-tag", ThoughtKind.Tag);
      // The parent of the branch that fails is there when the plan is checked
      // and deleted before the create under it. One nobody has from the start
      // rejects the plan, and no batch is begun: the next test.
      const doomed = await make("pf-doomed-parent");
      const name = (what: string): string => `${PREFIX}pf-${what}`;
      const top = { tempId: "top", name: name("top"), parent: doomed, note: "top note" };
      const mid = { tempId: "mid", name: name("mid"), parent: "top", tagIds: [tagId] };
      const leaf = { tempId: "leaf", name: name("leaf"), parent: "mid", note: "leaf note" };
      const plan = {
        thoughts: [
          top,
          mid,
          leaf,
          { tempId: "side", name: name("side"), parent: root },
          { tempId: "sideleaf", name: name("sideleaf"), parent: "side", note: "side note" },
        ],
        links: [
          { from: "mid", to: "side", name: "relates" },
          { from: "sideleaf", to: root, name: "back" },
        ],
      };
      const since = new Date().toISOString();

      // The API as a plan meets it then. The first read of `doomed` in a run
      // is the plan's check, and is answered as it was while the thought was
      // there: the first time by the API, with the thought deleted before
      // the plan has the answer, and after that by the same answer again,
      // which is what the API gives for up to 0.15 s after a deletion (L3).
      // Every other request is the API's own, the later reads of `doomed`
      // included: by then they are the 404 of an identifier nobody has, and
      // so is the create under it (L26).
      let there: { status: number; body: string } | undefined;
      const checkedThenGone = (): TheBrainApi => {
        let checked = false;
        return new TheBrainApi({
          apiKey: apiKey!,
          fetchImpl: async (input, init) => {
            const check =
              !checked && new URL(String(input)).pathname === `/api/thoughts/${brainId}/${doomed}`;
            if (!check) return fetch(input, init);
            checked = true;
            if (there === undefined) {
              const response = await fetch(input, init);
              there = { status: response.status, body: await response.text() };
              await api.thoughts.delete(brainId, doomed);
              await eventually(
                () => api.thoughts.get(brainId, doomed).then(
                  () => true,
                  () => false,
                ),
                (reads) => !reads,
                { timeoutMs: 3000, stepMs: 25 },
              );
            }
            return new Response(there.body, {
              status: there.status,
              headers: { "content-type": "application/json; charset=utf-8" },
            });
          },
        });
      };

      const first = await ingest(checkedThenGone(), brainId, plan);
      for (const c of first.created) created.push(c.thoughtId);
      expect(there?.status).toBe(200);
      expect(first.created.map((c) => c.tempId).sort()).toEqual(["side", "sideleaf"]);
      // The API's own answer for a parent nobody has, and no mark on it: it answered.
      expect(first.failures).toEqual([
        {
          of: "thought",
          what: `thought "${name("top")}" (top)`,
          reason: `Source Thought ${doomed} could not be located`,
          error: expect.objectContaining({ kind: "not_found", status: 404 }),
        },
      ]);
      expect(first.skipped).toEqual([
        { what: `thought "${name("mid")}" (mid)`, reason: needs("top") },
        { what: `thought "${name("leaf")}" (leaf)`, reason: needs("top") },
        { what: "link mid -> side", reason: needs("top") },
      ]);
      expect([first.notesWritten, first.tagsAttached, first.linksCreated]).toEqual([1, 0, 1]);
      const side = first.created.find((c) => c.tempId === "side")!.thoughtId;
      const written = first.created.map((c) => c.thoughtId).sort();
      // The log has the two that were reported and no third: a thought made
      // with no parent hangs on nothing a graph could show.
      await eventually(
        () => madeSince(since),
        (ids) => ids.length >= 2,
      );
      await settle();
      expect(await madeSince(since)).toEqual(written);

      const second = await ingest(checkedThenGone(), brainId, plan);
      for (const c of second.created) created.push(c.thoughtId);
      expect(second.created).toEqual([]);
      expect(second.reused.map((r) => r.thoughtId).sort()).toEqual(written);
      expect(second.failures).toEqual(first.failures);
      expect(second.skipped).toEqual(first.skipped);
      await settle();
      expect(await madeSince(since)).toEqual(written);

      // Once the check itself reads that nobody has the parent, the plan is
      // rejected whole, and that run adds nothing either.
      await expect(ingest(api, brainId, plan)).rejects.toBeInstanceOf(IngestMissingError);
      expect(await madeSince(since)).toEqual(written);

      // What the result asks for: the failed and skipped items alone, the
      // cause fixed, and what exists named by its identifier.
      const third = await ingest(api, brainId, {
        thoughts: [{ ...top, parent: root }, mid, leaf],
        links: [{ from: "mid", to: side, name: "relates" }],
      });
      for (const c of third.created) created.push(c.thoughtId);
      expect(third.created.map((c) => c.tempId)).toEqual(["top", "mid", "leaf"]);
      expect([third.failures, third.skipped, third.reused]).toEqual([[], [], []]);
      expect([third.notesWritten, third.tagsAttached, third.linksCreated]).toEqual([2, 1, 1]);

      const made = new Map(third.created.map((c) => [c.tempId, c.thoughtId]));
      const graph = await eventually(
        () => api.thoughts.getGraph(brainId, made.get("mid")!),
        (g) => g.tags.length === 1 && g.jumps.length === 1,
      );
      expect(graph.parents.map((p) => p.id)).toEqual([made.get("top")]);
      expect(graph.jumps.map((j) => j.id)).toEqual([side]);
      expect(graph.children.map((c) => c.id)).toEqual([made.get("leaf")]);
      expect(
        (await api.thoughts.getGraph(brainId, root)).children.map((c) => c.id).sort(),
      ).toEqual([side, made.get("top")!].sort());
      expect(await madeSince(since)).toHaveLength(5);
    }, 30_000);

    it("a parent nobody has is no batch at all: the plan is rejected by the read that checks the parent, and nothing is written", async () => {
      // It used to fail its own thought in the middle of the batch, with the
      // branches beside it written: through the real handler on 15.0.640, 3
      // of 3 for a child, a parent and a jump, in 5 to 19 requests.
      const root = await make("pn-root");
      const other = await make("pn-other");
      const name = (what: string): string => `${PREFIX}pn-${what}`;
      const sent: string[] = [];
      const counting = new TheBrainApi({
        apiKey: apiKey!,
        fetchImpl: async (input, init) => {
          const { pathname } = new URL(String(input));
          sent.push(`${init?.method ?? "GET"} ${pathname.replace(`/${brainId}`, "")}`);
          return fetch(input, init);
        },
      });
      /** What a plan comes to, and the requests it took. */
      const run = async (plan: Parameters<typeof ingest>[2]) => {
        sent.length = 0;
        const outcome = await ingest(counting, brainId, plan).catch((e: unknown) => e as Error);
        if (!(outcome instanceof Error)) for (const c of outcome.created) created.push(c.thoughtId);
        return { outcome, requests: [...sent].sort() };
      };
      const read = (id: string): string => `GET /api/thoughts/${id}`;
      const nobodyHas = (references: string): string =>
        `${references}, and no thought in this brain has that identifier. It may have been ` +
        "deleted, or be another brain's";
      const since = new Date().toISOString();

      // What the rule rests on: the read that checks a parent's kind is a
      // 404 for an identifier nobody has (L3), which comes back as null.
      const nobody = crypto.randomUUID();
      expect(await api.links.requireParent(brainId, nobody, "parent")).toBeNull();
      expect((await api.links.requireParent(brainId, root, "parent"))?.id).toBe(root);

      // Beside a branch that could have been written, and alone.
      const top = { tempId: "top", name: name("top"), parent: nobody, note: "top note" };
      const mid = { tempId: "mid", name: name("mid"), parent: "top" };
      const side = { tempId: "side", name: name("side"), parent: root, note: "side note" };
      const beside = await run({
        thoughts: [top, mid, side],
        links: [{ from: "mid", to: "side", name: "relates" }],
      });
      expect(beside.outcome).toBeInstanceOf(IngestMissingError);
      expect(beside.outcome).toMatchObject({
        message: nobodyHas(`thought "top" references parent ${nobody}`),
        ids: [nobody],
      });
      // One read for each parent the plan names, as before, and no other request.
      expect(beside.requests).toEqual([read(nobody), read(root)].sort());
      const alone = await run({ thoughts: [top, mid] });
      expect(alone.outcome).toBeInstanceOf(IngestMissingError);
      expect(alone.requests).toEqual([read(nobody)]);

      // A thought made as its parent or as its jump: one read, which nothing
      // sent before, in place of the read of the brain.
      for (const relation of ["parent", "jump"] as const) {
        const { outcome, requests } = await run({ thoughts: [{ ...top, relation }, mid] });
        expect(outcome, relation).toBeInstanceOf(IngestMissingError);
        expect((outcome as Error).message, relation).toBe(
          nobodyHas(`thought "top" references parent ${nobody}`),
        );
        expect(requests, relation).toEqual([read(nobody)]);
      }

      // The upper end of a link, whichever way it is written.
      const a = { tempId: "a", name: name("a"), parent: root };
      for (const [link, field] of [
        [{ from: nobody, to: "a", relation: "child" }, "from"],
        [{ from: "a", to: nobody, relation: "parent" }, "to"],
      ] as const) {
        const { outcome, requests } = await run({ thoughts: [a], links: [link] });
        expect(outcome, field).toBeInstanceOf(IngestMissingError);
        const by = `the link ${link.from} -> ${link.to}`;
        expect((outcome as Error).message, field).toBe(
          nobodyHas(`${by} references ${nobody} in its ${field} field`),
        );
        expect(requests, field).toEqual([read(nobody), read(root)].sort());
      }

      // None of it wrote anything.
      await settle();
      expect(await madeSince(since)).toEqual([]);
      expect((await api.thoughts.getGraph(brainId, root)).children).toEqual([]);

      // The lower end of a link and the ends of a jump are not read ahead of
      // the writes. The plan is written, and the link fails alone, in the
      // API's words (L3), with the links beside it made.
      for (const [link, end] of [
        [{ from: "a", to: nobody, relation: "child" }, "target"],
        [{ from: nobody, to: "a", relation: "parent" }, "source"],
        [{ from: "a", to: nobody }, "target"],
        [{ from: nobody, to: "a", relation: "jump" }, "source"],
      ] as const) {
        const what = `link ${link.from} -> ${link.to}`;
        const { outcome, requests } = await run({
          thoughts: [{ ...a, name: name(`a-${end}-${link.relation ?? "none"}`) }],
          links: [link, { from: "a", to: other, name: "beside" }],
        });
        if (outcome instanceof Error) throw outcome;
        expect(outcome.created.map((c) => c.tempId), what).toEqual(["a"]);
        expect(outcome.linksCreated, what).toBe(1);
        expect(outcome.failures, what).toEqual([
          {
            of: "link",
            what,
            reason: `Could not get ${end} thought ${nobody}`,
            error: expect.objectContaining({ kind: "bad_request", status: 400 }),
          },
        ]);
        expect(outcome.skipped, what).toEqual([]);
        expect(requests.filter((r) => r === read(nobody)), what).toEqual([]);
      }
    }, 30_000);

    it("a create whose answer is lost has made the thought: the batch says it may have, and the next run finds it", async () => {
      const root = await make("pf-lost-root");
      const lost = `${PREFIX}pf-lost-mid`;
      // The request reaches TheBrain and its answer is dropped on the way
      // back, which is all a timeout on this side knows.
      const deaf = new TheBrainApi({
        apiKey: apiKey!,
        fetchImpl: async (input, init) => {
          const response = await fetch(input, init);
          if (typeof init?.body === "string" && init.body.includes(lost)) {
            throw new DOMException("timed out", "TimeoutError");
          }
          return response;
        },
      });
      const plan = {
        thoughts: [
          { tempId: "top", name: `${PREFIX}pf-lost-top`, parent: root },
          { tempId: "mid", name: lost, parent: "top", note: "mid note" },
          { tempId: "leaf", name: `${PREFIX}pf-lost-leaf`, parent: "mid" },
        ],
      };

      const first = await ingest(deaf, brainId, plan);
      for (const c of first.created) created.push(c.thoughtId);
      expect(first.created.map((c) => c.tempId)).toEqual(["top"]);
      expect(first.failures).toMatchObject([
        {
          of: "thought",
          what: `thought "${lost}" (mid)`,
          reason: "request exceeded 30000 ms",
          unanswered: true,
        },
      ]);
      expect(first.skipped).toEqual([
        { what: `thought "${PREFIX}pf-lost-leaf" (leaf)`, reason: needs("mid") },
      ]);

      // It is there all the same, under its parent, with no note.
      const top = first.created[0]!.thoughtId;
      const { children } = await eventually(
        () => api.thoughts.getGraph(brainId, top),
        (g) => g.children.length > 0,
      );
      for (const c of children) created.push(c.id);
      expect(children.map((c) => c.name)).toEqual([lost]);
      expect(await api.notes.get(brainId, children[0]!.id)).toBe("");

      const second = await ingest(api, brainId, plan);
      for (const c of second.created) created.push(c.thoughtId);
      expect(second.reused.map((r) => r.thoughtId).sort()).toEqual([top, children[0]!.id].sort());
      expect(second.created.map((c) => c.tempId)).toEqual(["leaf"]);
      expect([second.failures, second.skipped]).toEqual([[], []]);
      await settle();
      expect((await api.thoughts.getGraph(brainId, top)).children).toHaveLength(1);
    }, 30_000);

    it("a create under a thought deleted a moment ago is refused in other words, and makes nothing either", async () => {
      // Straight after the deletion of a thought that had lived 0.4 s or more
      // the answer is a 400 that names nothing: 15 of 15. From 0.3 s on it is
      // the 404 of an identifier nobody has, 6 of 6, and at once for a
      // thought deleted as soon as it was made, 3 of 3.
      const doomed = await make("pf-doomed");
      await settle(500);
      const since = new Date().toISOString();
      await api.thoughts.delete(brainId, doomed);
      const answer = (): Promise<string> =>
        api.thoughts
          .create(brainId, { name: `${PREFIX}pf-never-made`, sourceThoughtId: doomed })
          .then(
            (id) => (created.push(id), `created ${id}`),
            (e: unknown) => (e instanceof TheBrainError ? `${e.status} ${e.message}` : String(e)),
          );
      const gone = `404 Source Thought ${doomed} could not be located`;

      expect(["400 Could not create thought.", gone]).toContain(await answer());
      await settle();
      expect(await answer()).toBe(gone);
      await settle();
      expect(await madeSince(since)).toEqual([]);
    });
  });

  /**
   * Where a graph lists a thought created with each relation, how soon, and
   * what a second run of a plan finds of the first. Ingest looked for a
   * thought among its parent's `children` alone: one made as a parent or as
   * a jump was made again by every run (24 of 24), and a child by a run sent
   * straight after the first (5 of 6). Measured on TheBrain 15.0.640.
   */
  describe("a second run of a plan", () => {
    const RELATIONS = ["child", "parent", "jump"] as const;
    const NUMBER = { child: Relation.Child, parent: Relation.Parent, jump: Relation.Jump };
    const LIST = { child: "children", parent: "parents", jump: "jumps" } as const;
    /** Where the source is in the graph of the thought created next to it. */
    const BACK = { child: "parents", parent: "children", jump: "jumps" } as const;
    const lists = (g: CleanGraph, id: string): string[] =>
      (["children", "parents", "jumps"] as const).filter((l) => g[l].some((t) => t.id === id));

    it("a graph lists a thought created as a child, a parent or a jump in the list of that name, and one link joins the two", async () => {
      for (const relation of RELATIONS) {
        const source = await make(`sr-source-${relation}`);
        const id = await api.thoughts.create(brainId, {
          name: `${PREFIX}sr-${relation}`,
          sourceThoughtId: source,
          relation: NUMBER[relation],
        });
        created.push(id);

        // Neither graph was read before, so both reads are live.
        expect(lists(await api.thoughts.getGraph(brainId, source), id), relation).toEqual([
          LIST[relation],
        ]);
        expect(lists(await api.thoughts.getGraph(brainId, id), source), relation).toEqual([
          BACK[relation],
        ]);
        // A parent's link is a parent link from the new thought; a jump's is
        // from the source, as a child's is.
        const link = await api.links.between(brainId, source, id);
        const upper = relation === "parent" ? id : source;
        expect(
          [link?.thoughtIdA === upper, link?.relation, link?.meaning],
          relation,
        ).toEqual([true, relation === "jump" ? Relation.Jump : Relation.Child, LinkMeaning.Normal]);
      }
    });

    it("a graph that has been read lacks a thought created next to it for a moment; one never read has it at once", async () => {
      // A graph is answered from a copy, made when it is first read and
      // brought up to date about every 0.1 s. Over 120 creates, 40 of each
      // relation, each next to a thought whose graph had been read: the read
      // straight after the answer lacked the new thought 112 times, and had
      // it 10 to 205 ms later, about 80 ms at the median. The copy was still
      // the one answered a minute after it was made (19 of 20). Measured
      // again three days on, that did not hold: read straight before the
      // create the graph lacked the thought 355 times in 400, read 0.3 s
      // before it 37 in 600, and a second before it 0 in 36. So the graph
      // is read straight before the create here. Next to a thought whose
      // graph nothing had read, the same read had it 60 times of 60.
      //
      // This asked for one such read in six, a child, a parent and a jump
      // twice over. On 2026-10-14, 40 children each, the read had the new one
      // 15 times with the app to itself and 12 with another contract run at
      // work in it: six in a row one run in 360. So it goes round the three
      // until one read lacks it, forty at the most, which seven reads in ten
      // with it would fail one run in a million.
      const TRIES = 40;
      let lacked = -1;
      for (let i = 0; i < TRIES && lacked < 0; i++) {
        const relation = RELATIONS[i % RELATIONS.length]!;
        const source = await make(`sr-read-${relation}`);
        await api.thoughts.getGraph(brainId, source);
        const id = await api.thoughts.create(brainId, {
          name: `${PREFIX}sr-read-new`,
          sourceThoughtId: source,
          relation: NUMBER[relation],
        });
        created.push(id);
        const listed = (g: CleanGraph): boolean => g[LIST[relation]].some((t) => t.id === id);

        if (!listed(await api.thoughts.getGraph(brainId, source))) lacked = i;
        const later = await eventually(() => api.thoughts.getGraph(brainId, source), listed, {
          stepMs: 10,
        });
        expect(listed(later), relation).toBe(true);
      }
      expect(
        lacked,
        `the graph had the new thought at once after ${TRIES} creates of ${TRIES}: either the ` +
          "app was busy at every one of them, or a graph read before is no longer a copy (L27)",
      ).toBeGreaterThanOrEqual(0);

      for (const relation of RELATIONS) {
        const source = await make(`sr-unread-${relation}`);
        const id = await api.thoughts.create(brainId, {
          name: `${PREFIX}sr-unread-new`,
          sourceThoughtId: source,
          relation: NUMBER[relation],
        });
        created.push(id);
        expect(lists(await api.thoughts.getGraph(brainId, source), id), relation).toEqual([
          LIST[relation],
        ]);
      }
    }, 60_000);

    it("ingest finds what a run made under every relation, next to an existing thought and next to a tempId, sent straight after it", async () => {
      const root = await make("sr-root");
      const name = (what: string): string => `${PREFIX}sr-${what}`;
      const plan = {
        thoughts: [
          { tempId: "top", name: name("top"), parent: root },
          ...RELATIONS.map((relation) => ({
            tempId: `first-${relation}`,
            name: name(`first-${relation}`),
            parent: root,
            relation,
          })),
          ...RELATIONS.map((relation) => ({
            tempId: `deep-${relation}`,
            name: name(`deep-${relation}`),
            parent: "top",
            relation,
          })),
        ],
      };

      const first = await ingest(api, brainId, plan);
      for (const c of first.created) created.push(c.thoughtId);
      expect(first.created).toHaveLength(7);
      expect([first.failures, first.skipped]).toEqual([[], []]);
      const made = new Map(first.created.map((c) => [c.tempId, c.thoughtId]));

      // No pause: the first run returned once the graphs listed what it made.
      const second = await ingest(api, brainId, plan);
      for (const c of second.created) created.push(c.thoughtId);
      expect(second.created).toEqual([]);
      expect(second.reused.map((r) => r.thoughtId).sort()).toEqual([...made.values()].sort());
      expect([second.failures, second.skipped]).toEqual([[], []]);
      expect(first.unlisted).toBe(0);

      const ids = (list: ThoughtDto[]): string[] => list.map((t) => t.id).sort();
      const around = await api.thoughts.getGraph(brainId, root);
      expect(ids(around.children)).toEqual([made.get("top")!, made.get("first-child")!].sort());
      expect(ids(around.parents)).toEqual([made.get("first-parent")]);
      expect(ids(around.jumps)).toEqual([made.get("first-jump")]);
      const under = await api.thoughts.getGraph(brainId, made.get("top")!);
      expect(ids(under.children)).toEqual([made.get("deep-child")]);
      expect(ids(under.parents)).toEqual([root, made.get("deep-parent")!].sort());
      expect(ids(under.jumps)).toEqual([made.get("deep-jump")]);
    }, 30_000);

    it("ingest neither reuses nor makes again a thought of the same name under another relation", async () => {
      // There as a child it used to be listed as existing, for a plan that
      // asked for a jump; there as a jump it was not seen, and a second
      // thought of the name was made as the child (2 of 2 each).
      const root = await make("sr-namesake-root");
      const there = await api.thoughts.create(brainId, {
        name: `${PREFIX}sr-namesake`,
        sourceThoughtId: root,
        relation: Relation.Jump,
      });
      created.push(there);
      const plan = {
        thoughts: [
          { tempId: "x", name: `${PREFIX}sr-namesake`, parent: root, relation: "child" as const },
          { tempId: "leaf", name: `${PREFIX}sr-namesake-leaf`, parent: "x" },
        ],
      };

      const outcome = await ingest(api, brainId, plan);
      for (const c of outcome.created) created.push(c.thoughtId);
      expect([outcome.created, outcome.reused]).toEqual([[], []]);
      expect(outcome.failures).toHaveLength(1);
      expect(outcome.failures[0]!.reason).toContain(
        `${root} already has a thought of this name as its jump, ${there}, ` +
          "and the plan asks for a child",
      );
      expect(outcome.skipped.map((s) => s.what)).toEqual([
        `thought "${PREFIX}sr-namesake-leaf" (leaf)`,
      ]);
      await settle(300);
      const around = await api.thoughts.getGraph(brainId, root);
      expect([around.children, around.jumps.map((t) => t.id)]).toEqual([[], [there]]);

      // Named by its identifier, as the failure says, it is what the leaf goes under.
      const named = await ingest(api, brainId, {
        thoughts: [{ ...plan.thoughts[1]!, parent: there }],
      });
      for (const c of named.created) created.push(c.thoughtId);
      expect(named.created.map((c) => c.tempId)).toEqual(["leaf"]);
    }, 30_000);

    it("ingest finds what another call of this process wrote a moment ago, though the graph it looks in is the copy from before it", async () => {
      // The tools that write one thing return at once, and a plan sent
      // straight after one read the copy from before it. Through the real
      // handlers, 20 times each at 0 to 150 ms after the write: after
      // brain_create_thought the thought was made again 8 times in 100,
      // after brain_link 14, after a rename 3. So `ingest()` waits out what
      // is left of 300 ms since this client's last write, and for a while
      // that was all: 0 of 360. It is no bound. Read once 250 ms after a
      // create, the graph of a thought read 0.3 s earlier still lacked the
      // new thought 4 times in 600; read on every 10 ms, it first had it
      // more than 300 ms after the answer 7 times in 1,800, 364 ms at the
      // latest, all while the app was slow to answer. The test that stood
      // here, eight tries behind that wait, went red in one run of ten on
      // one day and in none of 160 on the next: it measured the day, and
      // said nothing of the code when it was green.
      //
      // So the clock is taken out of the way here, and the worst case is
      // made: the graph is read straight before the write, where the read
      // straight after it lacked the new thought 197 times in 200. By the
      // clock the write is long past, as it is for a copy that is further
      // behind than the wait. What `ingest()` has left is what the client
      // kept of the write, and it reads until the graph shows that. Without
      // it every try below makes the thought a second time.
      const name = (what: string): string => `${PREFIX}sr-after-${what}`;
      /** One thing written next to `root` by a call of its own, and the thought a plan then names. */
      const WRITES = {
        async child(root: string, title: string) {
          return api.thoughts.create(brainId, { name: title, sourceThoughtId: root });
        },
        async parent(root: string, title: string) {
          return api.thoughts.create(brainId, {
            name: title,
            sourceThoughtId: root,
            relation: Relation.Parent,
          });
        },
        async jump(root: string, title: string) {
          return api.thoughts.create(brainId, {
            name: title,
            sourceThoughtId: root,
            relation: Relation.Jump,
          });
        },
        // An existing thought put under the root, as brain_link does.
        async linked(root: string, title: string) {
          const id = await api.thoughts.create(brainId, { name: title });
          created.push(id);
          await api.thoughts.getGraph(brainId, root);
          await api.links.create(brainId, {
            thoughtIdA: root,
            thoughtIdB: id,
            relation: Relation.Child,
          });
          return id;
        },
        // A child the graph lists already, renamed, as brain_update_thought does.
        async renamed(root: string, title: string) {
          const id = await api.thoughts.create(brainId, {
            name: `${title}-before`,
            sourceThoughtId: root,
          });
          created.push(id);
          await eventually(
            () => api.thoughts.getGraph(brainId, root),
            (g) => g.children.some((t) => t.id === id),
          );
          await api.thoughts.getGraph(brainId, root);
          await api.thoughts.update(brainId, id, { name: title });
          return id;
        },
      };
      const RELATION_OF = { child: "child", parent: "parent", jump: "jump" } as const;
      const clock = vi
        .spyOn(api.client, "sinceLastWrite")
        .mockReturnValue(Number.POSITIVE_INFINITY);
      try {
        for (const [i, how] of (
          ["child", "parent", "jump", "linked", "renamed", "child", "linked", "renamed"] as const
        ).entries()) {
          const root = await make(`sr-after-root-${i}`);
          // The copy the plan will be answered from, made straight before the write.
          await api.thoughts.getGraph(brainId, root);
          const made = await WRITES[how](root, name(`${how}-${i}`));
          created.push(made);

          const outcome = await ingest(api, brainId, {
            thoughts: [
              {
                tempId: "x",
                name: name(`${how}-${i}`),
                parent: root,
                relation: how in RELATION_OF ? RELATION_OF[how as keyof typeof RELATION_OF] : "child",
              },
            ],
          });
          for (const c of outcome.created) created.push(c.thoughtId);
          // All three at once: a red run then says whether a thought was
          // made again or a read failed.
          expect(
            {
              reused: outcome.reused.map((r) => r.thoughtId),
              created: outcome.created.map((c) => c.thoughtId),
              failures: outcome.failures.map((f) => f.reason),
            },
            `${how} (${i})`,
          ).toEqual({ reused: [made], created: [], failures: [] });
        }
      } finally {
        clock.mockRestore();
      }
    }, 30_000);

    it("the graphs come to show what the client keeps of a create, a link and a rename, on both sides", async () => {
      // `RecentWrites` holds a graph to these, and a graph that never came
      // to show one would fail every plan next to that thought for ten
      // seconds. Each is in the other's graph in the list the relation puts
      // it in, for a thought created next to another as for two joined by a
      // link, and a renamed thought is listed under its name as stored.
      const EMPTY = { children: [], parents: [], jumps: [] };
      const lacking = async (id: string): Promise<string[]> =>
        api.client.written
          .notShownBy(brainId, id, await api.thoughts.getGraph(brainId, id))
          .map((f) => (f.of === "listed" ? `${f.thoughtId} in ${f.list}` : `${f.thoughtId} named`));
      const shown = async (...ids: string[]): Promise<string[][]> =>
        eventually(
          () => Promise.all(ids.map(lacking)),
          (all) => all.every((none) => none.length === 0),
          { timeoutMs: 5000, stepMs: 25 },
        );

      for (const relation of [Relation.Child, Relation.Parent, Relation.Jump]) {
        const root = await make(`sr-kept-root-${relation}`);
        const loose = await make(`sr-kept-loose-${relation}`);
        // Both graphs read, so that each is a copy to be behind.
        await api.thoughts.getGraph(brainId, root);
        await api.thoughts.getGraph(brainId, loose);

        const made = await api.thoughts.create(brainId, {
          name: `${PREFIX}sr-kept-made-${relation}`,
          sourceThoughtId: root,
          relation,
        });
        created.push(made);
        await api.links.create(brainId, { thoughtIdA: root, thoughtIdB: loose, relation });
        // Two of the root's, and the root from each of the others.
        expect(api.client.written.notShownBy(brainId, root, EMPTY), String(relation)).toHaveLength(2);
        expect(api.client.written.notShownBy(brainId, made, EMPTY), String(relation)).toHaveLength(1);
        expect(api.client.written.notShownBy(brainId, loose, EMPTY), String(relation)).toHaveLength(1);

        expect(await shown(root, made, loose), String(relation)).toEqual([[], [], []]);
      }

      const root = await make("sr-kept-renamed-root");
      const child = await api.thoughts.create(brainId, {
        name: `${PREFIX}sr-kept-before`,
        sourceThoughtId: root,
      });
      created.push(child);
      expect(await shown(root)).toEqual([[]]);
      await api.thoughts.update(brainId, child, { name: ` ${PREFIX}sr-kept\tafter\n` });
      expect(await shown(root)).toEqual([[]]);
      const listed = (await api.thoughts.getGraph(brainId, root)).children.map((t) => t.name);
      expect(listed).toEqual([`${PREFIX}sr-kept after`]);
    }, 30_000);

    it("a create whose answer is lost is found by the same plan sent at once", async () => {
      // A batch waits for the graphs to list what it made, and of this
      // thought it has no identifier to wait for: the plan sent again
      // straight after it made the thought a second time, 6 times of 6.
      const root = await make("sr-lost-root");
      await api.thoughts.getGraph(brainId, root);
      const lost = `${PREFIX}sr-lost`;
      let deafTo = lost;
      const deaf = new TheBrainApi({
        apiKey: apiKey!,
        fetchImpl: async (input, init) => {
          const response = await fetch(input, init);
          if (typeof init?.body === "string" && init.body.includes(`"${deafTo}"`)) {
            throw new DOMException("timed out", "TimeoutError");
          }
          return response;
        },
      });
      const plan = { thoughts: [{ tempId: "x", name: lost, parent: root }] };

      const first = await ingest(deaf, brainId, plan);
      expect(first.failures).toMatchObject([{ of: "thought", unanswered: true }]);
      deafTo = "nothing";
      const second = await ingest(deaf, brainId, plan);
      for (const c of second.created) created.push(c.thoughtId);

      await settle(400);
      const { children } = await api.thoughts.getGraph(brainId, root);
      for (const c of children) created.push(c.id);
      expect(children.map((c) => c.name)).toEqual([lost]);
      expect(second.reused.map((r) => r.thoughtId)).toEqual([children[0]!.id]);
      expect(second.created).toEqual([]);
    }, 30_000);
  });

  /**
   * What ingest does with the note of a thought that was there, and the API
   * facts it goes by. The plan's note used to be written over it on every
   * run, a first one that landed on the thought included: 6 times of 6 for
   * each relation through the real handler, and a note edited between two
   * runs was gone after the second, 6 of 6. Measured on TheBrain 15.0.640.
   */
  describe("the note of a thought a plan finds in place", () => {
    const HUMAN = "A person wrote this.\n\nSecond paragraph, by hand.";
    const read = (id: string, text: string): Promise<string> =>
      eventually(
        () => api.notes.get(brainId, id),
        (note) => note === text,
        { timeoutMs: 2000, stepMs: 50 },
      );

    it("a note reads back as it was written, but for its line ends, which come back as \\n", async () => {
      // What "the plan's text" is compared with. Nineteen samples of
      // Markdown read back to the character, 19 of 19: headings, the three
      // kinds of list, emphasis, links, indented code, a table, a quote,
      // blank lines and blanks at either end. A twentieth, sent with "\r\n",
      // came back with "\n".
      const samples = [
        "One paragraph.\n\nAnother.",
        "  padded, with a trailing line end  \n",
        "# Title\n\n- one\n- two\n\n1. first\n2. second\n\n* star",
        "Some **bold**, *italic*, `code` and [a link](https://example.com/a?b=1).",
        "Code:\n\n    const a = 1;\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted",
        "three\n\n\n\nblank lines, «кавычки» — and a < b && c > d",
      ];
      const ids: string[] = [];
      for (const [i, text] of samples.entries()) {
        const id = await make(`note-roundtrip-${i}`);
        await api.notes.set(brainId, id, text);
        ids.push(id);
      }
      for (const [i, text] of samples.entries()) expect(await read(ids[i]!, text), text).toBe(text);

      const crlf = await make("note-roundtrip-crlf");
      await api.notes.set(brainId, crlf, "line one\r\nline two\r\n\r\npara two");
      expect(await read(crlf, "line one\nline two\n\npara two")).toBe(
        "line one\nline two\n\npara two",
      );
    }, 30_000);

    it("a first note reads back as no note for a moment after it is written, when the note had been read before", async () => {
      // The read that decides whether a thought has a note is behind a first
      // write as a graph is behind a create (L27). Of 52 thoughts whose
      // empty note had been read, the read straight after the write still
      // answered "no note" for 33, and polled it had the text within 102 ms.
      // Read once after a pause it was stale 2 times in 20 at 150 ms and
      // never from 200 ms on (0 of 60). A note that replaced another read
      // back at once, 12 of 12. Ingest reads a note no sooner than 300 ms
      // after this client's last write.
      //
      // Again on 2026-10-14, 40 notes each: the read straight after had the
      // text 4 times with the app to itself and 5 with another contract run
      // at work in it. It writes until one such read answers "no note",
      // forty at the most, which seven reads in ten with the text would fail
      // one run in a million.
      const TRIES = 40;
      let stale = -1;
      for (let i = 0; i < TRIES && stale < 0; i += 1) {
        const id = await make(`note-first-${i}`);
        expect(await api.notes.get(brainId, id)).toBe("");
        await api.notes.set(brainId, id, "first text");
        if ((await api.notes.get(brainId, id)) === "") stale = i;
        expect(await read(id, "first text")).toBe("first text");
      }
      expect(
        stale,
        `a first note read back at once ${TRIES} times of ${TRIES}: either the app was busy at ` +
          "every one of them, or the read of a note is no longer behind its first write",
      ).toBeGreaterThanOrEqual(0);
    }, 60_000);

    it("ingest keeps a note that is there and writes one where there is none, under each relation, and a second run changes neither", async () => {
      const NUMBER = { child: Relation.Child, parent: Relation.Parent, jump: Relation.Jump };
      for (const relation of ["child", "parent", "jump"] as const) {
        const root = await make(`note-kept-root-${relation}`);
        const name = (what: string): string => `${PREFIX}note-kept-${relation}-${what}`;
        const there = async (what: string): Promise<string> => {
          const id = await api.thoughts.create(brainId, {
            name: name(what),
            sourceThoughtId: root,
            relation: NUMBER[relation],
          });
          created.push(id);
          return id;
        };
        const held = await there("held");
        const same = await there("same");
        const bare = await there("bare");
        await api.notes.set(brainId, held, HUMAN);
        await api.notes.set(brainId, same, "the plan's");
        await read(held, HUMAN);
        await read(same, "the plan's");
        // A thought with no note reads as an empty text, with a 200.
        expect(await api.notes.get(brainId, bare)).toBe("");

        const plan = {
          thoughts: ["held", "same", "bare", "new"].map((what) => ({
            tempId: what,
            name: name(what),
            parent: root,
            relation,
            note: "the plan's",
          })),
        };
        const first = await ingest(api, brainId, plan);
        for (const c of first.created) created.push(c.thoughtId);
        const made = first.created[0]!.thoughtId;

        expect(first.created.map((c) => c.tempId), relation).toEqual(["new"]);
        expect([first.failures, first.skipped], relation).toEqual([[], []]);
        expect(first.notesWrittenFor.sort(), relation).toEqual(["bare", "new"]);
        const byTempId = (a: { tempId: string }, b: { tempId: string }): number =>
          a.tempId.localeCompare(b.tempId);
        expect(first.notesKept.sort(byTempId), relation).toEqual([
          { tempId: "held", thoughtId: held, same: false },
          { tempId: "same", thoughtId: same, same: true },
        ]);
        expect(await read(bare, "the plan's"), relation).toBe("the plan's");
        expect(await read(made, "the plan's"), relation).toBe("the plan's");
        expect(await api.notes.get(brainId, held), relation).toBe(HUMAN);

        const second = await ingest(api, brainId, plan);
        for (const c of second.created) created.push(c.thoughtId);
        expect([second.created, second.failures, second.notesWrittenFor], relation).toEqual([
          [],
          [],
          [],
        ]);
        expect(second.notesKept.sort(byTempId), relation).toEqual([
          { tempId: "bare", thoughtId: bare, same: true },
          { tempId: "held", thoughtId: held, same: false },
          { tempId: "new", thoughtId: made, same: true },
          { tempId: "same", thoughtId: same, same: true },
        ]);
        await settle(400);
        expect(await api.notes.get(brainId, held), relation).toBe(HUMAN);
      }
    }, 60_000);

    it("a note changed between two runs of a plan is still there after the second", async () => {
      const root = await make("note-edited-root");
      const plan = {
        thoughts: [
          { tempId: "x", name: `${PREFIX}note-edited`, parent: root, note: "the plan's" },
        ],
      };
      const first = await ingest(api, brainId, plan);
      for (const c of first.created) created.push(c.thoughtId);
      const made = first.created[0]!.thoughtId;
      await read(made, "the plan's");

      const edited = "the plan's\n\nand a line added by hand";
      await api.notes.set(brainId, made, edited);
      await read(made, edited);
      const second = await ingest(api, brainId, plan);
      for (const c of second.created) created.push(c.thoughtId);

      expect(second.notesKept).toEqual([{ tempId: "x", thoughtId: made, same: false }]);
      expect([second.created, second.notesWritten, second.failures]).toEqual([[], 0, []]);
      await settle(400);
      expect(await api.notes.get(brainId, made)).toBe(edited);
    }, 30_000);
  });

  /**
   * What TheBrain keeps of a note's Markdown, and what it shows of it. L5 had
   * it that a Markdown round trip loses the closing fence of a code block,
   * and the tools warned of that under every note with one. A block that is
   * closed reads back to the character. What TheBrain does delete, with a
   * 200, is a line that begins with three backticks and has no partner, and
   * a block with nothing in it. Measured on 15.0.640, 2026-10-13.
   */
  describe("a note's Markdown as it is stored", () => {
    const F = "```";
    /** The note once it reads as `text`: a first note can be behind its write. */
    const read = (id: string, text: string): Promise<string> =>
      eventually(
        () => api.notes.get(brainId, id),
        (note) => note === text,
        { timeoutMs: 2000, stepMs: 50 },
      );
    /** The bare requests, with nothing of `NotesResource` around them. */
    const rawAppend = (id: string, markdown: string): Promise<unknown> =>
      api.client.post(`/api/notes/${brainId}/${id}/append`, { json: { markdown } });
    const form = async (id: string, which: "html" | "text"): Promise<string> =>
      (await api.client.get<NotesDto>(`/api/notes/${brainId}/${id}/${which}`))[which] ?? "";
    /** Whether `marker` stands inside a `<pre>` of the HTML form. */
    const inPre = (html: string, marker: string): boolean => {
      const at = html.indexOf(marker);
      return at >= 0 && html.lastIndexOf("<pre", at) > html.lastIndexOf("</pre>", at);
    };

    /** Notes whose code blocks are each closed, and notes with a fence that is none to TheBrain. */
    const KEPT: readonly string[] = [
      `before\n\n${F}\ncode = 1;\n${F}`,
      `before\n\n${F}\ncode = 1;\n${F}\n`,
      `before\n\n${F}js\ncode = 1;\n${F}`,
      `before\n\n${F}js\ncode = 1;\n${F}\n`,
      `before\n\n${F}\ncode = 1;\n${F}\n\nafter`,
      `before\n\n${F}js\ncode = 1;\n${F}\n\nafter`,
      `before\n${F}\ncode = 1;\n${F}\nafter`,
      `before\n\n${F}python title="x.py"\ncode = 1\n${F}\n\nafter`,
      `${F}\ncode = 1;\n${F}`,
      `${F}js\ncode = 1;\n${F}\n`,
      `one\n\n${F}js\ncode = 1;\n${F}\n\nmiddle\n\n${F}sh\necho two\n${F}\n\nafter`,
      `${F}\none\n${F}\n${F}\ntwo\n${F}`,
      `before\n\n${F}py\ndef f():\n\n    return 1\n\t# tab\n\n${F}\n\nafter`,
      `before\n\n${F}html\n<div class="c">&amp; *not bold* # no heading</div>\n${F}\n\nafter`,
      `# Title\n\n${F}js\ncode = 1;\n${F}\n\n## Next\n\n- one\n- two\n\n**bold** end`,
      `до\n\n${F}\ncode = "привет";\n${F}\n\nпосле`,
      // A block of one blank line, a closing fence that is longer or has
      // blanks after it, and a fence of four backticks.
      `a\n\n${F}\n\n${F}\n\nend`,
      `a\n\n${F}\ncode\n${F}${F}\n\nend`,
      `a\n\n${F}\ncode\n${F}   \n\nend`,
      `a\n\n${F}\`\ncode\n${F}\`\n\nend`,
      `before\n\n${F}\`md\n${F}js\ncode = 1;\n${F}\n${F}\`\n\nafter`,
      // No fence to TheBrain: of tildes, indented, in a list item, in a quote.
      "before\n\n~~~\ncode = 1;\n~~~\n\nafter",
      "before\n\n~~~js\ncode = 1;\n~~~",
      `before\n\n   ${F}\n   code = 1;\n   ${F}\n\nafter`,
      `- item one\n\n  ${F}js\n  code = 1;\n  ${F}\n\n- item two\n\nafter`,
      `> quoted\n>\n> ${F}js\n> code = 1;\n> ${F}\n\nafter`,
      // Left open, and still kept: a fence that is not at the start of a line.
      `a\n\n    ${F}\n    code\n\nend`,
      `a\n\n\t${F}\ncode\n\nend`,
      "a\n\n~~~\ncode\n\nend",
      `a ${F}inline${F} b and a lone ${F} too`,
    ];

    /** Sent, and what TheBrain keeps of it: the last fence of an odd number is gone. */
    const UNPAIRED: ReadonlyArray<readonly [string, string]> = [
      // A block left open loses the fence that opened it.
      [`before\n\n${F}js\ncode();\n\nafter`, "before\n\ncode();\n\nafter"],
      [`before\n\n${F}\n`, "before\n\n"],
      [`${F}js\ncode\nmore`, "code\nmore"],
      // Of three it is the third, and of five the fifth.
      [`a\n\n${F}\none\n${F}\n\nb\n\n${F}\ntwo\n\nend`, `a\n\n${F}\none\n${F}\n\nb\n\ntwo\n\nend`],
      [`${F}\n1\n${F}\n2\n${F}\n3\n${F}\n4\n${F}\n5`, `${F}\n1\n${F}\n2\n${F}\n3\n${F}\n4\n5`],
      // A block whose first fence is not at the start of its line loses the
      // fence that closes it.
      [`intro ${F}js\ncode\n${F}\n\nend`, `intro ${F}js\ncode\n\nend`],
      [`\ufeff${F}\ncode\n${F}\n\nend`, `\ufeff${F}\ncode\n\nend`],
      // Whatever follows the backticks on the line goes with them.
      [`a\n\n${F}x${F} is inline code\n\nend`, "a\n\n\nend"],
      [`a\n\n${F}some words here\ncode\n\nend`, "a\n\ncode\n\nend"],
      [`a\n\n${F}\`\ncode\n\nend`, "a\n\ncode\n\nend"],
      // A fence of tildes is none, so the one of backticks inside is alone.
      [`a\n\n~~~\n${F}\n~~~\n\nend`, "a\n\n~~~\n~~~\n\nend"],
      [`a\r\n\r\n${F}js\r\ncode\r\n\r\nend\r\n`, "a\n\ncode\n\nend\n"],
    ];

    /** Sent, and what TheBrain keeps of it: a block with nothing in it is gone. */
    const EMPTY: ReadonlyArray<readonly [string, string]> = [
      [`a\n\n${F}\n${F}\n\nend`, "a\n\n\nend"],
      [`a\n\n${F}js\n${F}\n\nend`, "a\n\n\nend"],
      [`a\n\n${F}\n${F}`, "a\n"],
      [`a\n${F}\n${F}\nb`, "a\nb"],
      [`a\n\n${F}\ncode\n${F}\n\nb\n\n${F}\n${F}\n\nend`, `a\n\n${F}\ncode\n${F}\n\nb\n\n\nend`],
      // The fences pair up in order: the block with nothing in it is the last two.
      [`${F}\n${F}js\n${F}\n${F}`, `${F}\n${F}js`],
      // A longer fence around a bare one is such a block: its first two lines.
      [`${F}\`md\n${F}\nnested\n${F}\n${F}\``, `nested\n${F}\n${F}\``],
      // Both rules in one note: the odd fence, then the pair left.
      [`a\n\n${F}\`\n${F}\n${F}\`\n\nend`, "a\n\n\nend"],
    ];

    it("a code block that is closed reads back to the character, at once and a second later", async () => {
      // 23 of these forms were written 20 times each as a first note and 10
      // times each over a note, and read at once, after 1 s and after 5 s:
      // 2,070 reads of 2,070 to the character.
      const ids: string[] = [];
      for (const [i, text] of KEPT.entries()) {
        const id = await make(`note-fence-kept-${i}`);
        await api.notes.set(brainId, id, text);
        ids.push(id);
        expect(await read(id, text), text).toBe(text);
        expect(noteLinesDropped(text), text).toEqual([]);
      }
      await settle(1000);
      for (const [i, text] of KEPT.entries()) {
        expect(await api.notes.get(brainId, ids[i]!), text).toBe(text);
      }
      // Written again as it was read, it is the same again.
      const again = ids[5]!;
      await api.notes.set(brainId, again, await api.notes.get(brainId, again));
      await settle(300);
      expect(await api.notes.get(brainId, again)).toBe(KEPT[5]);
    }, 60_000);

    it("with an odd number of lines that begin with three backticks the last one is deleted, whole", async () => {
      for (const [i, [sent, stored]] of UNPAIRED.entries()) {
        const id = await make(`note-fence-odd-${i}`);
        await api.notes.set(brainId, id, sent);
        expect(await read(id, stored), sent).toBe(stored);
        expect(noteAsStored(sent), sent).toBe(stored);
        expect(noteLinesDropped(sent).map((d) => d.why), sent).toEqual(["unpaired"]);
      }
    }, 60_000);

    it("a block with nothing between its two fences is deleted, both lines", async () => {
      for (const [i, [sent, stored]] of EMPTY.entries()) {
        const id = await make(`note-fence-empty-${i}`);
        await api.notes.set(brainId, id, sent);
        expect(await read(id, stored), sent).toBe(stored);
        expect(noteAsStored(sent), sent).toBe(stored);
      }
    }, 60_000);

    it("a text that comes to nothing leaves no note, and takes away the one that was there", async () => {
      for (const [i, sent] of [F, `${F}js\n${F}`, `${F}\n${F}\n${F}`].entries()) {
        expect(noteAsStored(sent), sent).toBe("");
        const id = await make(`note-fence-nothing-${i}`);
        await api.notes.set(brainId, id, sent);
        await settle(400);
        expect(await api.notes.exists(brainId, id), sent).toBe(false);
        expect(await api.attachments.ofThought(brainId, id), sent).toEqual([]);

        // Over a note: the read is the catch-all 403 for a moment after the
        // note's attachment goes (L3), and then the answer for no note.
        await api.notes.set(brainId, id, "a note that is there");
        expect(await read(id, "a note that is there")).toBe("a note that is there");
        await api.notes.set(brainId, id, sent);
        const after = await eventually(
          () => api.notes.getRaw(brainId, id).catch(() => null),
          (note) => note !== null && note.markdown === "",
          { timeoutMs: 10_000, stepMs: 50 },
        );
        expect(after?.modificationDateTime, sent).toBe("0001-01-01T00:00:00");
        await settle(400);
        expect(await api.attachments.ofThought(brainId, id), sent).toEqual([]);
      }
    }, 60_000);

    it("line ends come back as \\n, nothing else is touched, and the stored file is the text that is read", async () => {
      const samples: ReadonlyArray<readonly [string, string]> = [
        ["a\r\nb\r\n\r\nc\r\n", "a\nb\n\nc\n"],
        // Kept: a carriage return alone, blank lines and blanks at either
        // end, tabs, a no-break space, a byte order mark, a zero width space,
        // the Unicode line separators, a decomposed letter and raw HTML.
        ["a\rb\r\rc\r", "a\rb\r\rc\r"],
        ["\n\n\na\n\n\n", "\n\n\na\n\n\n"],
        ["   a   \nb\t\n\t\tc  ", "   a   \nb\t\n\t\tc  "],
        ["\ufeffa\u00a0b\u200bc\u2028d\u2029e\u0085f", "\ufeffa\u00a0b\u200bc\u2028d\u2029e\u0085f"],
        ["e\u0301 a <b>bold</b> &amp; c", "e\u0301 a <b>bold</b> &amp; c"],
        // A fence after a carriage return alone is not at the start of a line.
        [`a\r${F}\rcode`, `a\r${F}\rcode`],
      ];
      for (const [i, [sent, stored]] of samples.entries()) {
        const id = await make(`note-as-stored-${i}`);
        await api.notes.set(brainId, id, sent);
        expect(await read(id, stored), JSON.stringify(sent)).toBe(stored);
        expect(noteAsStored(sent), JSON.stringify(sent)).toBe(stored);
      }

      // The file behind the note is `Notes.md`: a byte order mark and the
      // Markdown, with the fence that had no partner already gone from it.
      const id = await make("note-as-stored-file");
      await api.notes.set(brainId, id, `привет\r\n\r\n${F}js\r\ncode();`);
      expect(await read(id, "привет\n\ncode();")).toBe("привет\n\ncode();");
      const [file] = await eventually(
        () => api.attachments.ofThought(brainId, id),
        (list) => list.length === 1,
      );
      expect([file?.isNotes, file?.location]).toEqual([true, "Notes.md"]);
      const bytes = Buffer.from(await api.attachments.content(brainId, file!.id));
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(bytes.subarray(3).toString("utf8")).toBe("привет\n\ncode();");
    }, 60_000);

    it("a note of white space alone is stored, and reads as no note", async () => {
      const id = await make("note-as-stored-blank");
      await api.notes.set(brainId, id, "  \n ");
      await settle(400);
      const note = await api.notes.getRaw(brainId, id);
      expect(note.markdown).toBe("");
      expect(note.modificationDateTime).not.toBe("0001-01-01T00:00:00");
      expect(await api.notes.exists(brainId, id)).toBe(false);
      expect((await api.attachments.ofThought(brainId, id)).map((a) => a.isNotes)).toEqual([true]);
    }, 30_000);

    it("the bare append joins its text to the note's last line, and a block appended so loses its closing fence; notes.append() keeps it", async () => {
      // 60 of 60 for the bare request, with the block after text and after a
      // note that ends in a fence; none of 100 with a line end between, 40
      // of them with the blank line `notes.append()` puts there.
      const BLOCK = `${F}js\ncode = 1;\n${F}`;
      for (const [i, [held, stored]] of (
        [
          ["intro", `intro${F}js\ncode = 1;`],
          [`a\n\n${F}\nfirst\n${F}`, `a\n\n${F}\nfirst\n${F}${F}js\ncode = 1;`],
        ] as const
      ).entries()) {
        const bare = await make(`note-append-bare-${i}`);
        await api.notes.set(brainId, bare, held);
        expect(await read(bare, held)).toBe(held);
        await rawAppend(bare, BLOCK);
        expect(await read(bare, stored), held).toBe(stored);
        expect(noteAsStored(held + BLOCK), held).toBe(stored);

        const kept = await make(`note-append-kept-${i}`);
        await api.notes.set(brainId, kept, held);
        expect(await read(kept, held)).toBe(held);
        const whole = await api.notes.append(brainId, kept, BLOCK);
        expect(whole, held).toBe(`${held}\n\n${BLOCK}`);
        expect(await read(kept, whole), held).toBe(whole);
        expect(noteLinesDropped(whole), held).toEqual([]);
      }
    }, 60_000);

    it("an append is gone over as the whole note, not as the text added", async () => {
      // Two halves that are no fence apart and one together: kept, though
      // the text added has one fence. And a block that is closed, after a
      // line it is joined to: its closing fence is the odd one of the note.
      const halves = await make("note-append-halves");
      await api.notes.set(brainId, halves, "intro\n``");
      expect(await read(halves, "intro\n``")).toBe("intro\n``");
      await rawAppend(halves, `\`\ncode\n${F}`);
      expect(await read(halves, `intro\n${F}\ncode\n${F}`)).toBe(`intro\n${F}\ncode\n${F}`);

      // An addition that is left open, through `notes.append()`: the line
      // that goes is counted in the whole note.
      const open = await make("note-append-open");
      await api.notes.set(brainId, open, "intro");
      expect(await read(open, "intro")).toBe("intro");
      const whole = await api.notes.append(brainId, open, `${F}js\ncode();`);
      expect(noteLinesDropped(whole)).toEqual([{ line: 3, text: `${F}js`, why: "unpaired" }]);
      expect(await read(open, "intro\n\ncode();")).toBe("intro\n\ncode();");
      expect(noteAsStored(whole)).toBe("intro\n\ncode();");
    }, 30_000);

    it("the HTML form has a closed block in a <pre> and the text after it outside; a fence that is not at the start of a line is ordinary text there", async () => {
      // What the app's editor is given. The other way, from the editor back
      // to Markdown, is not something the API shows.
      const shown = async (name: string, markdown: string): Promise<string> => {
        const id = await make(name);
        await api.notes.set(brainId, id, markdown);
        expect(await read(id, noteAsStored(markdown))).toBe(noteAsStored(markdown));
        return form(id, "html");
      };

      const block = await shown("note-html-block", `before\n\n${F}js\nCODE = 1;\n${F}\n\nTAIL after`);
      expect([inPre(block, "CODE"), inPre(block, "TAIL"), block.includes("TAIL")]).toEqual([true, false, true]);
      // The language is not in it.
      expect(block).not.toContain("js");

      // Code indented by four spaces is a block there too, its indent kept
      // inside it.
      const indented = await shown("note-html-indented", "before\n\n    CODE = 1;\n\nTAIL after");
      expect([inPre(indented, "    CODE"), inPre(indented, "TAIL")]).toEqual([true, false]);

      // No block to TheBrain: a fence of tildes, an indented one, one in a
      // list item and one in a quote.
      for (const [i, markdown] of [
        "before\n\n~~~\nCODE = 1;\n~~~\n\nTAIL after",
        `before\n\n   ${F}\n   CODE = 1;\n   ${F}\n\nTAIL after`,
        `- item\n\n  ${F}js\n  CODE = 1;\n  ${F}\n\nTAIL after`,
        `> quoted\n>\n> ${F}js\n> CODE = 1;\n> ${F}\n\nTAIL after`,
      ].entries()) {
        const html = await shown(`note-html-none-${i}`, markdown);
        expect([html.includes("CODE"), html.includes("<pre")], markdown).toEqual([true, false]);
      }

      // Text on the line of a closing fence is kept in the Markdown and is
      // not in the HTML form at all.
      const id = await make("note-html-joined");
      await api.notes.set(brainId, id, `a\n\n${F}\nCODE\n${F}`);
      expect(await read(id, `a\n\n${F}\nCODE\n${F}`)).toBe(`a\n\n${F}\nCODE\n${F}`);
      await rawAppend(id, "TAIL more");
      expect(await read(id, `a\n\n${F}\nCODE\n${F}TAIL more`)).toBe(`a\n\n${F}\nCODE\n${F}TAIL more`);
      const joined = await form(id, "html");
      expect([inPre(joined, "CODE"), joined.includes("TAIL")]).toEqual([true, false]);
    }, 60_000);

    it("a plan's note with a fence left open is the plan's text on the second run", async () => {
      // Stored without the fence, it read as another text than the plan's:
      // "kept: another text" for the note the first run had written.
      const root = await make("note-fence-plan-root");
      const OPEN = `intro\n\n${F}js\ncode();`;
      const plan = {
        thoughts: [{ tempId: "x", name: `${PREFIX}note-fence-plan`, parent: root, note: OPEN }],
      };
      const first = await ingest(api, brainId, plan);
      for (const c of first.created) created.push(c.thoughtId);
      const made = first.created[0]!.thoughtId;
      expect(first.notesWrittenFor).toEqual(["x"]);
      expect(await read(made, "intro\n\ncode();")).toBe("intro\n\ncode();");
      // The second run looks for the thought in its parent's graph, a copy.
      await eventually(
        () => api.thoughts.getGraph(brainId, root),
        (graph) => graph.children.some((c) => c.id === made),
      );

      const second = await ingest(api, brainId, plan);
      for (const c of second.created) created.push(c.thoughtId);
      expect([second.created, second.failures, second.notesWritten]).toEqual([[], [], 0]);
      expect(second.notesKept).toEqual([{ tempId: "x", thoughtId: made, same: true }]);
    }, 30_000);
  });

  /**
   * Two thoughts of one name in one list of a graph. Ingest took the one the
   * graph listed last for the plan's thought, and its result said nothing of
   * the other: 8 times of 8. Which is last is not the order they were made
   * in, and not the same from one read to the next. Measured on 15.0.640.
   */
  describe("two thoughts of one name next to one thought", () => {
    it("a graph lists both, and ingest takes neither for the plan's thought", async () => {
      const root = await make("twins-root");
      const name = `${PREFIX}twins`;
      const twins: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        twins.push(await api.thoughts.create(brainId, { name, sourceThoughtId: root }));
      }
      created.push(...twins);
      const { children } = await api.thoughts.getGraph(brainId, root);
      expect(children.map((c) => c.id).sort()).toEqual([...twins].sort());
      expect(children.map((c) => c.name)).toEqual([name, name]);

      const outcome = await ingest(api, brainId, {
        thoughts: [
          { tempId: "x", name, parent: root, note: "mine" },
          { tempId: "leaf", name: `${PREFIX}twins-leaf`, parent: "x" },
        ],
      });
      for (const c of outcome.created) created.push(c.thoughtId);

      expect([outcome.created, outcome.reused]).toEqual([[], []]);
      expect(outcome.failures).toHaveLength(1);
      expect(outcome.failures[0]!.reason).toContain(`${root} has 2 thoughts of this name as its child: `);
      for (const id of twins) expect(outcome.failures[0]!.reason).toContain(id);
      expect(outcome.skipped.map((s) => s.what)).toEqual([`thought "${PREFIX}twins-leaf" (leaf)`]);
      await settle(400);
      expect((await api.thoughts.getGraph(brainId, root)).children).toHaveLength(2);
      for (const id of twins) expect(await api.notes.get(brainId, id)).toBe("");
    }, 30_000);
  });

  /**
   * What the request that attaches a tag does when it names no tag, which
   * links a thought and a tag can share, and what `attachTag`, `detachTag` and
   * ingest do about it. Measured on TheBrain 15.0.640; the spec has none of it.
   */
  describe("an identifier that is not a tag", () => {
    /** The request `attachTag` sends, with none of its checks. */
    const rawAttach = (thoughtId: string, other: string): Promise<{ id: string }> =>
      api.client.post<{ id: string }>(`/api/links/${brainId}`, {
        json: { thoughtIdA: thoughtId, thoughtIdB: other, relation: Relation.Parent },
      });
    const makeUnder = async (
      name: string,
      extra: { sourceThoughtId?: string; typeId?: string },
    ): Promise<string> => {
      const id = await api.thoughts.create(brainId, { name: PREFIX + name, ...extra });
      created.push(id);
      return id;
    };
    const graphOf = (id: string, ok: (g: CleanGraph) => boolean): Promise<CleanGraph> =>
      eventually(() => api.thoughts.getGraph(brainId, id), ok);
    const ids = (thoughts: readonly ThoughtDto[]): string[] => thoughts.map((t) => t.id);
    /** A link as [the thought at its head, relation, meaning]. */
    const shape = (link: LinkDto | null): unknown[] => [
      link?.thoughtIdA,
      link?.relation,
      link?.meaning,
    ];

    it("the request that attaches a tag makes a parent of an ordinary thought, and is a 400 for an identifier nobody has", async () => {
      // Named a type it sets the thought's type: "a parent link towards a type
      // sets the type" above is this request.
      const plain = await make("nt-plain");
      const id = await make("nt-raw");

      // Accepted, and that is the trap.
      const { id: linkId } = await rawAttach(id, plain);
      const graph = await graphOf(id, (g) => ids(g.parents).includes(plain));
      expect(ids(graph.parents)).toEqual([plain]);
      expect(graph.tags).toEqual([]);
      const parentLink = await api.links.between(brainId, id, plain);
      expect(parentLink?.id).toBe(linkId);
      expect(shape(parentLink)).toEqual([plain, Relation.Child, LinkMeaning.Normal]);

      const nobody = crypto.randomUUID();
      const refused = await rawAttach(id, nobody).then(
        () => null,
        (error: unknown) => error as TheBrainError,
      );
      expect(refused?.kind).toBe("bad_request");
      expect(refused?.message).toBe(`Could not get target thought ${nobody}`);
      await settle();
      expect((await api.thoughts.getGraph(brainId, id)).links).toHaveLength(1);

      // The read `requireTag` makes is a 404 for that identifier, where its
      // graph is a 403.
      await expect(api.thoughts.get(brainId, nobody)).rejects.toMatchObject({ kind: "not_found" });
      await expect(api.thoughts.getGraph(brainId, nobody)).rejects.toMatchObject({
        kind: "forbidden",
      });
    });

    it("a thought named as its own tag is a 200 with an identifier of zeros, and no link is made", async () => {
      for (const kind of [ThoughtKind.Normal, ThoughtKind.Tag, ThoughtKind.Type]) {
        const id = await make(`nt-self-${kind}`, kind);
        expect((await rawAttach(id, id)).id, `kind ${kind}`).toBe(
          "00000000-0000-0000-0000-000000000000",
        );
        await settle(600);
        expect((await api.thoughts.getGraph(brainId, id)).links, `kind ${kind}`).toEqual([]);
        expect(await api.links.between(brainId, id, id)).toBeNull();
      }
    });

    it("a tag attached to a tag is a link of meaning 7, and the API lists it among the tag's parents as well as its tags", async () => {
      const upper = await make("nt-upper-tag", ThoughtKind.Tag);
      const lower = await make("nt-lower-tag", ThoughtKind.Tag);

      const linkId = await api.links.attachTag(brainId, lower, upper);
      const graph = await graphOf(lower, (g) => ids(g.tags).includes(upper));
      expect(ids(graph.tags)).toEqual([upper]);
      // `getGraph` takes it out of the parents: a parent is the upper end of
      // an ordinary link.
      expect(graph.parents).toEqual([]);
      const raw = await api.client.get<ThoughtGraphDto>(`/api/thoughts/${brainId}/${lower}/graph`);
      expect(ids(raw.parents ?? [])).toEqual([upper]);
      const above = await graphOf(upper, (g) => ids(g.children).includes(lower));
      expect(ids(above.children)).toEqual([lower]);
      const link = await api.links.between(brainId, lower, upper);
      expect(shape(link)).toEqual([upper, Relation.Child, LinkMeaning.SubTag]);
      expect(isTagLink(link!)).toBe(true);

      // Asked the wrong way round, the link stays: the lower tag is not on the
      // upper one.
      expect(await api.links.detachTag(brainId, upper, lower)).toBe(false);
      await settle(600);
      expect((await api.links.between(brainId, lower, upper))?.id).toBe(linkId);

      expect(await api.links.detachTag(brainId, lower, upper)).toBe(true);
      const bare = await graphOf(lower, (g) => g.tags.length === 0);
      expect(bare.tags).toEqual([]);
      expect(bare.parents).toEqual([]);

      // Posted from the upper tag's side it is the same link again. Raw:
      // `links.create` refuses a tag above.
      await api.client.post(`/api/links/${brainId}`, {
        json: { thoughtIdA: upper, thoughtIdB: lower, relation: Relation.Child },
      });
      const again = await eventually(
        () => api.links.between(brainId, lower, upper),
        (found) => found !== null,
      );
      expect(shape(again)).toEqual([upper, Relation.Child, LinkMeaning.SubTag]);

      // The log has the name of that meaning: turned into an ordinary thought,
      // the lower tag keeps the link, which becomes the one a tag has to a thought.
      await api.thoughts.update(brainId, lower, { kind: ThoughtKind.Normal });
      const changed = await eventually(
        async () =>
          (await newestLogs(50)).find(
            (l) => l.modType === ModType.LinkMeaningChanged && l.sourceId === again!.id,
          ),
        (entry) => entry !== undefined,
      );
      expect([changed?.oldValue, changed?.newValue]).toEqual(["SubTagOf", "HasTag"]);
      const demoted = await eventually(
        () => api.links.between(brainId, lower, upper),
        (found) => found?.meaning === LinkMeaning.Tag,
      );
      expect(shape(demoted)).toEqual([upper, Relation.Child, LinkMeaning.Tag]);
    }, 30_000);

    it("a thought and a tag can be linked with the tag not on it, and attaching the tag rewrites that link", async () => {
      const jumpTag = await make("nt-jump-tag", ThoughtKind.Tag);
      const childTag = await make("nt-child-tag", ThoughtKind.Tag);
      const id = await make("nt-linked-to-tags");
      const jump = await api.links.create(brainId, {
        thoughtIdA: id,
        thoughtIdB: jumpTag,
        relation: Relation.Jump,
      });
      const child = await api.links.create(brainId, {
        thoughtIdA: id,
        thoughtIdB: childTag,
        relation: Relation.Child,
      });

      const graph = await graphOf(
        id,
        (g) => ids(g.jumps).includes(jumpTag) && ids(g.children).includes(childTag),
      );
      expect(graph.tags).toEqual([]);
      expect(ids(graph.jumps)).toEqual([jumpTag]);
      expect(ids(graph.children)).toEqual([childTag]);
      expect(shape(await api.links.between(brainId, id, jumpTag))).toEqual([
        id,
        Relation.Jump,
        LinkMeaning.Normal,
      ]);
      expect(shape(await api.links.between(brainId, id, childTag))).toEqual([
        id,
        Relation.Child,
        LinkMeaning.Normal,
      ]);

      // Neither is the tag's link, so neither is deleted.
      expect(await api.links.detachTag(brainId, id, jumpTag)).toBe(false);
      expect(await api.links.detachTag(brainId, id, childTag)).toBe(false);
      await settle(600);
      expect((await api.thoughts.getGraph(brainId, id)).links).toHaveLength(2);

      // One link per pair: attaching the tag turns either into the tag's link.
      expect(await api.links.attachTag(brainId, id, jumpTag)).toBe(jump);
      expect(await api.links.attachTag(brainId, id, childTag)).toBe(child);
      const tagged = await graphOf(id, (g) => g.tags.length === 2);
      expect(ids(tagged.tags).sort()).toEqual([jumpTag, childTag].sort());
      expect(tagged.jumps).toEqual([]);
      expect(tagged.children).toEqual([]);
      for (const tagId of [jumpTag, childTag]) {
        expect(shape(await api.links.between(brainId, id, tagId))).toEqual([
          tagId,
          Relation.Child,
          LinkMeaning.Tag,
        ]);
      }
    }, 30_000);

    it("attachTag refuses a type, an ordinary thought, an identifier nobody has and the thought itself, and links nothing", async () => {
      const kept = await make("nt-kept-type", ThoughtKind.Type);
      const other = await make("nt-other-type", ThoughtKind.Type);
      const plain = await make("nt-refused-plain");
      const bare = await make("nt-refused-bare");
      const typed = await makeUnder("nt-refused-typed", { typeId: kept });

      for (const id of [bare, typed]) {
        for (const [tagId, message] of [
          [other, new RegExp(`it is the type "${PREFIX}nt-other-type"`)],
          [plain, new RegExp(`it is the thought "${PREFIX}nt-refused-plain"`)],
          [crypto.randomUUID(), /no thought in this brain has that identifier/],
          [id, /a thought cannot be its own tag/],
        ] as const) {
          await expect(api.links.attachTag(brainId, id, tagId)).rejects.toMatchObject({
            kind: "not_a_tag",
            message: expect.stringMatching(message),
          });
        }
      }

      await settle();
      expect((await api.thoughts.getGraph(brainId, bare)).links).toEqual([]);
      // The type it had, and not the one it was offered for a tag.
      const graph = await api.thoughts.getGraph(brainId, typed);
      expect(graph.type?.id).toBe(kept);
      expect(graph.links).toHaveLength(1);
    });

    it("detachTag leaves a thought's type, parent, child and jump where they are", async () => {
      // It used to delete whichever of them it was given for a tag: `between`
      // returns the one link a pair of thoughts has, whatever it is.
      const typeId = await make("nt-own-type", ThoughtKind.Type);
      const parent = await make("nt-own-parent");
      const side = await make("nt-own-jump");
      const id = await makeUnder("nt-keeps-links", { sourceThoughtId: parent, typeId });
      const child = await makeUnder("nt-own-child", { sourceThoughtId: id });
      await api.links.create(brainId, {
        thoughtIdA: id,
        thoughtIdB: side,
        relation: Relation.Jump,
      });
      await graphOf(id, (g) => g.links.length === 4);

      for (const other of [typeId, parent, child, side]) {
        expect(await api.links.detachTag(brainId, id, other), other).toBe(false);
      }

      await settle();
      const graph = await api.thoughts.getGraph(brainId, id);
      expect(graph.type?.id).toBe(typeId);
      expect(ids(graph.parents)).toEqual([parent]);
      expect(ids(graph.children)).toEqual([child]);
      expect(ids(graph.jumps)).toEqual([side]);
      expect(graph.links).toHaveLength(4);
    }, 30_000);

    it("ingest writes no thought of a plan that names a tag which is not one", async () => {
      const tagId = await make("nt-plan-tag", ThoughtKind.Tag);
      const typeId = await make("nt-plan-type", ThoughtKind.Type);
      const root = await make("nt-plan-root");

      await expect(
        ingest(api, brainId, {
          thoughts: [
            { tempId: "top", name: `${PREFIX}nt-plan-top`, parent: root, tagIds: [tagId] },
            { tempId: "leaf", name: `${PREFIX}nt-plan-leaf`, parent: "top", tagIds: [typeId] },
          ],
        }),
      ).rejects.toMatchObject({
        kind: "not_a_tag",
        message: expect.stringMatching(new RegExp(`it is the type "${PREFIX}nt-plan-type"`)),
      });

      await settle();
      expect((await api.thoughts.getGraph(brainId, root)).children).toEqual([]);
    });
  });

  /**
   * What the API does with `00000000-0000-0000-0000-000000000000` where an
   * identifier goes. Measured on TheBrain 15.0.640, 2026-10-11, five times
   * of five each. Where it can, a create takes it for no identifier given
   * and answers 200; elsewhere it is an identifier nobody has. `assertUuid`
   * refuses it ahead of every request, so the requests here go out by the
   * client, past the resources.
   */
  describe("the identifier of zeros, sent in a request", () => {
    const ZEROS = "00000000-0000-0000-0000-000000000000";
    const answer = (request: Promise<unknown>): Promise<string> =>
      request.then(
        () => "accepted",
        (e: unknown) =>
          e instanceof TheBrainError ? `${e.status} ${e.kind}: ${e.message}` : String(e),
      );
    const rawCreate = async (extra: Record<string, unknown>): Promise<string> => {
      const { id } = await api.client.post<{ id: string }>(`/api/thoughts/${brainId}`, {
        json: { name: `${PREFIX}zeros`, kind: ThoughtKind.Normal, acType: 0, ...extra },
      });
      created.push(id);
      return id;
    };

    it("a create with it for a source is a 200 and a thought linked to nothing, under each relation", async () => {
      // A random identifier nobody has is a 404 here, and makes no thought.
      for (const relation of [Relation.Child, Relation.Parent, Relation.Jump]) {
        const id = await rawCreate({ sourceThoughtId: ZEROS, relation });
        expect(id, `relation ${relation}`).not.toBe(ZEROS);
        const graph = await api.thoughts.getGraph(brainId, id);
        expect(
          [graph.parents, graph.children, graph.jumps, graph.links].map((l) => l.length),
          `relation ${relation}`,
        ).toEqual([0, 0, 0, 0]);
      }
    });

    it("a create with it for a type is a 200 and a thought with no type, where a random one is a 400", async () => {
      const source = await make("zeros-source");
      const alone = await rawCreate({ typeId: ZEROS });
      const under = await rawCreate({ typeId: ZEROS, sourceThoughtId: source, relation: 1 });
      expect((await api.thoughts.get(brainId, alone)).typeId).toBeNull();
      const graph = await api.thoughts.getGraph(brainId, under);
      expect(graph.thought.typeId).toBeNull();
      expect(graph.type).toBeNull();
      // The source it was given beside the zeros is its parent all the same.
      expect(graph.parents.map((p) => p.id)).toEqual([source]);

      expect(
        await answer(
          api.client.post(`/api/thoughts/${brainId}`, {
            json: { name: `${PREFIX}never`, kind: 1, acType: 0, typeId: crypto.randomUUID() },
          }),
        ),
      ).toBe("400 bad_request: Could not create thought.");
    });

    it("everywhere else it is an identifier nobody has: a 404, the catch-all 403, the link's 400, a brain's 401", async () => {
      const id = await make("zeros-anchor");
      const get = (path: string): Promise<string> => answer(api.client.get(path));
      expect(await get(`/api/thoughts/${brainId}/${ZEROS}`)).toBe("404 not_found: Not Found");
      expect(await get(`/api/thoughts/${brainId}/${ZEROS}/graph`)).toMatch(/^403 forbidden: /);
      expect(await get(`/api/links/${brainId}/${ZEROS}`)).toBe("404 not_found: Not Found");
      expect(await get(`/api/links/${brainId}/${id}/${ZEROS}`)).toBe("404 not_found: Not Found");
      expect(
        await answer(
          api.client.patch(`/api/thoughts/${brainId}/${ZEROS}`, {
            jsonPatch: [{ op: "replace", path: "/name", value: "never" }],
          }),
        ),
      ).toBe("404 not_found: Not Found");
      const link = (thoughtIdA: string, thoughtIdB: string): Promise<string> =>
        answer(
          api.client.post(`/api/links/${brainId}`, {
            json: { thoughtIdA, thoughtIdB, relation: Relation.Jump },
          }),
        );
      expect(await link(id, ZEROS)).toBe(
        `400 bad_request: Could not get target thought ${ZEROS}`,
      );
      expect(await link(ZEROS, id)).toBe(
        `400 bad_request: Could not get source thought ${ZEROS}`,
      );
      expect(await get(`/api/brains/${ZEROS}`)).toBe(
        `401 unknown_brain: Access to brain ${ZEROS} is unauthorized.`,
      );
      await settle(400);
      expect((await api.thoughts.getGraph(brainId, id)).links).toEqual([]);
    });

    it("its history is a 200 with other thoughts' entries, where a random identifier's is empty", async () => {
      await make("zeros-logged");
      const history = (id: string): Promise<ModificationLogDto[]> =>
        api.client.get<ModificationLogDto[]>(`/api/thoughts/${brainId}/${id}/modifications`, {
          query: { maxLogs: 20, includeRelatedLogs: true },
        });
      const entries = await history(ZEROS);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some((e) => e.sourceId !== ZEROS)).toBe(true);
      expect(await history(crypto.randomUUID())).toEqual([]);
    });

    it("a note written to it is a 200 and an attachment that no read of the note returns", async () => {
      // A note written to a random identifier nobody has reads back (L3).
      const attachments = (): Promise<Array<{ id: string; isNotes: boolean }>> =>
        api.client.get(`/api/thoughts/${brainId}/${ZEROS}/attachments`);
      const note = (): Promise<{ markdown: string | null }> =>
        api.client.get(`/api/notes/${brainId}/${ZEROS}`);
      try {
        await api.client.post(`/api/notes/${brainId}/${ZEROS}/update`, {
          json: { markdown: `${PREFIX}note for nobody` },
        });
        const stored = await eventually(attachments, (list) => list.length > 0, {
          timeoutMs: 3000,
          stepMs: 50,
        });
        expect(stored.map((a) => a.isNotes)).toEqual([true]);
        // Not a lag: asked for a second, it is still the note of no thought.
        const read = await eventually(note, (n) => (n.markdown ?? "") !== "", {
          timeoutMs: 1000,
          stepMs: 50,
        });
        expect(read.markdown ?? "").toBe("");
      } finally {
        for (const a of await attachments()) {
          await api.client.delete(`/api/attachments/${brainId}/${a.id}`).catch(() => undefined);
        }
      }
      await eventually(attachments, (list) => list.length === 0, { timeoutMs: 3000 });
      expect(await attachments()).toEqual([]);
    }, 20_000);

    it("the resources send none of it: each refuses ahead of the request, and nothing is made", async () => {
      const id = await make("zeros-refused");
      await settle(400);
      const before = await api.brains.statistics(brainId);
      const refused = { kind: "invalid_uuid", status: undefined };
      for (const [what, send] of [
        ["a source", () => api.thoughts.create(brainId, { name: "never", sourceThoughtId: ZEROS })],
        [
          "a source to jump to",
          () =>
            api.thoughts.create(brainId, {
              name: "never",
              sourceThoughtId: ZEROS,
              relation: Relation.Jump,
            }),
        ],
        ["a type", () => api.thoughts.create(brainId, { name: "never", typeId: ZEROS })],
        ["a note", () => api.notes.set(brainId, ZEROS, "never")],
        ["a note to add to", () => api.notes.append(brainId, ZEROS, "never")],
        ["a link's end", () => api.links.create(brainId, { thoughtIdA: id, thoughtIdB: ZEROS })],
        ["a thought to tag", () => api.links.attachTag(brainId, ZEROS, id)],
        ["a brain", () => api.thoughts.get(ZEROS, id)],
      ] as const) {
        await expect(send(), what).rejects.toMatchObject(refused);
      }
      // A plan names its item, and is rejected before it reads anything.
      await expect(
        ingest(api, brainId, { thoughts: [{ tempId: "a", name: "never", parent: ZEROS }] }),
      ).rejects.toBeInstanceOf(IngestMissingError);
      await expect(
        ingest(api, brainId, {
          thoughts: [{ tempId: "a", name: `${PREFIX}zeros-never`, parent: id }],
          links: [{ from: "a", to: ZEROS }],
        }),
      ).rejects.toBeInstanceOf(IngestMissingError);

      await settle(400);
      const after = await api.brains.statistics(brainId);
      expect([after.thoughts, after.links, after.notes]).toEqual([
        before.thoughts,
        before.links,
        before.notes,
      ]);
      expect((await api.thoughts.getGraph(brainId, id)).children).toEqual([]);
    });
  });

  /**
   * What the API does when it is asked for what is there already, and for
   * the same pair twice at once. Measured on TheBrain 15.0.640, 2026-10-11,
   * through the API alone; the spec says of `POST /api/links` only that it
   * "creates a new link". It is what `ingest()` goes by when a plan is sent
   * a second time, and when a plan names one pair in two of its links.
   */
  describe("a link, a label and a tag that are there already", () => {
    const pair = async (name: string): Promise<{ a: string; b: string }> => ({
      a: await make(`${name}-A`),
      b: await make(`${name}-B`),
    });
    const post = (body: Record<string, unknown>): Promise<{ id: string }> =>
      api.client.post<{ id: string }>(`/api/links/${brainId}`, { json: body });
    /** The log's entries about one link, oldest first, as `modType old→new`. */
    const logged = async (linkId: string, atLeast: number): Promise<string[]> => {
      const ours = (entries: ModificationLogDto[]): ModificationLogDto[] =>
        entries.filter((l) => l.sourceId === linkId);
      const entries = await eventually(
        () => newestLogs(300),
        (all) => ours(all).length >= atLeast,
        { timeoutMs: 3000, stepMs: 100 },
      );
      return ours(entries)
        .sort((x, y) => compareLogTime(logTime(x), logTime(y)))
        .map((l) =>
          l.oldValue === null && l.newValue === null
            ? String(l.modType)
            : `${l.modType} ${JSON.stringify(l.oldValue)}→${JSON.stringify(l.newValue)}`,
        );
    };
    /** The links a thought's graph has between it and another. */
    const joining = async (a: string, b: string): Promise<LinkDto[]> =>
      (await api.thoughts.getGraph(brainId, a)).links.filter(
        (l) => [l.thoughtIdA, l.thoughtIdB].includes(a) && [l.thoughtIdA, l.thoughtIdB].includes(b),
      );

    it("a name a link has already is a 200 that logs nothing; another logs a 103 with both", async () => {
      const { a, b } = await pair("there-name");
      const { id } = await post({ thoughtIdA: a, thoughtIdB: b, relation: 3, name: "old" });
      expect(await logged(id, 2)).toEqual(["101", '103 null→"old"']);

      // Sent the name it has: accepted, and the log is as it was.
      await api.links.update(brainId, id, { name: "old" });
      await settle(500);
      expect(await logged(id, 2)).toEqual(["101", '103 null→"old"']);
      expect((await api.links.get(brainId, id)).name).toBe("old");

      // The lookup of the pair has the new name straight after the patch,
      // 20 times of 20, where the read of the link by its own identifier
      // still had the old one, 20 of 20, for 9 to 134 ms (L22). It is what
      // the tools read a label by.
      expect((await api.links.between(brainId, a, b))?.name).toBe("old");
      await api.links.update(brainId, id, { name: "new" });
      expect((await api.links.between(brainId, a, b))?.name).toBe("new");
      expect(await logged(id, 3)).toEqual(["101", '103 null→"old"', '103 "old"→"new"']);
    }, 30_000);

    it("a link's name is stored as a thought's is: a tab and a line feed as spaces, no white space at its ends, cut at 1,024 units, by a post as by a patch", async () => {
      // Measured on 15.0.640, 2026-10-13: 164 names, each twice by a POST and
      // twice by a PATCH, every one stored the same by both. It is the rule
      // of a thought's name (L36) to the code point: each of the 25 of
      // Unicode's White_Space is dropped at an end, and of 27 code points
      // next to them none is. `linkNameAsStored()` went by `trim()`, which
      // keeps a next line (U+0085) and drops a byte order mark (U+FEFF).
      const x = (n: number): string => "x".repeat(n);
      const samples = [
        "plain",
        "  padded  ",
        "two  spaces",
        "tab\tinside",
        "line\nbreak",
        "crlf\r\nbreak",
        "\nleading and trailing\n",
        "\u00a0nbsp ends\u00a0",
        // Each white space code point at both ends.
        ...WHITE_SPACE.map((c, i) => `${c}ws ${i}${c}`),
        // No white space, so kept at an end: a byte order mark, a zero width
        // space, controls, the two code points either side of a next line.
        "\ufeffbom\ufeff",
        " \ufeff both \ufeff ",
        "\u200bzero width\u200b",
        "\u001ccontrol\u001f",
        "\u0084beside\u0086",
        // Inside a name only a tab and a line feed change.
        "next\u0085line",
        "separator\u2028inside",
        "nbsp\u00a0inside",
        "cr\rinside",
        "a \n b",
        // 1,024 UTF-16 units are kept. The ends go before the cut and nothing
        // after it, and a cut inside an emoji leaves U+FFFD for its half.
        x(1024),
        x(1025),
        ` ${x(1024)}y`,
        `${x(1023)} y`,
        `${x(1023)}\u0085y`,
        `${x(1023)}😀`,
        "😀".repeat(600),
      ];
      /** A name short enough to read in a failure, or its length and its end. */
      const told = (name: string): string => {
        const units = (text: string): string =>
          Array.from(text, (_, i) => text.charCodeAt(i).toString(16)).join(" ");
        return name.length > 40 ? `${name.length} units ending ${units(name.slice(-3))}` : units(name);
      };
      // One pair for the posts, its link deleted after each, and one link
      // for the patches. Each is read through its pair, which is not behind
      // a write.
      const { a, b } = await pair("there-stored");
      const other = await pair("there-stored-p");
      const patched = await post({ thoughtIdA: other.a, thoughtIdB: other.b, relation: 3 });
      for (const [i, sent] of samples.entries()) {
        const stored = linkNameAsStored(sent);
        const posted = await post({ thoughtIdA: a, thoughtIdB: b, relation: 3, name: sent });
        expect((await api.links.between(brainId, a, b))?.name, `POST ${told(sent)}`).toBe(stored);
        await api.links.delete(brainId, posted.id);
        // From another name each time: the name a link has is not written.
        await api.links.update(brainId, patched.id, { name: `seed ${i}` });
        await api.links.update(brainId, patched.id, { name: sent });
        expect(
          (await api.links.between(brainId, other.a, other.b))?.name,
          `PATCH ${told(sent)}`,
        ).toBe(stored);
      }
      expect(linkNameAsStored(x(1025))).toHaveLength(1024);
      expect(linkNameAsStored(`${x(1023)}😀`).endsWith("\ufffd")).toBe(true);

      // White space alone is no name: posted, the link has none, and patched
      // onto a link it clears the name that was there.
      for (const blank of [" ", "\t\n", " \u00a0\u0085\u3000"]) {
        expect(linkNameAsStored(blank)).toBe("");
        const posted = await post({ thoughtIdA: a, thoughtIdB: b, relation: 3, name: blank });
        expect((await api.links.between(brainId, a, b))?.name, told(blank)).toBeNull();
        await api.links.delete(brainId, posted.id);
        await api.links.update(brainId, patched.id, { name: "there" });
        await api.links.update(brainId, patched.id, { name: blank });
        expect((await api.links.between(brainId, other.a, other.b))?.name, told(blank)).toBe("");
      }
    }, 120_000);

    it("a link posted over the pair's own answers its identifier and logs a 402, changed or not; a name it does not send stays", async () => {
      const { a, b } = await pair("there-post");
      // The lookup is answered before the write, and has the link straight
      // after it: it is not a copy that is behind, as a graph is.
      expect(await api.links.between(brainId, a, b)).toBeNull();
      const { id } = await post({ thoughtIdA: a, thoughtIdB: b, relation: 3, name: "kept" });
      expect((await api.links.between(brainId, a, b))?.id).toBe(id);
      expect(await logged(id, 2)).toEqual(["101", '103 null→"kept"']);

      // The same link again, with its name and without one: nothing changes.
      for (const [n, body] of [
        [3, { thoughtIdA: a, thoughtIdB: b, relation: 3, name: "kept" }],
        [4, { thoughtIdA: a, thoughtIdB: b, relation: 3 }],
        // From the other end too.
        [5, { thoughtIdA: b, thoughtIdB: a, relation: 3 }],
      ] as const) {
        expect((await post(body)).id).toBe(id);
        expect((await logged(id, n)).slice(2)).toEqual(Array.from({ length: n - 2 }, () => "402"));
        expect((await api.links.get(brainId, id)).name).toBe("kept");
      }
      expect(await joining(a, b)).toHaveLength(1);

      // With another name it takes that name, and with another relation that.
      expect((await post({ thoughtIdA: a, thoughtIdB: b, relation: 1, name: "next" })).id).toBe(id);
      expect((await logged(id, 7)).slice(5)).toEqual(["402", '103 "kept"→"next"']);
      const link = await eventually(
        () => api.links.get(brainId, id),
        (l) => l.relation === Relation.Child,
      );
      expect([link.relation, link.name]).toEqual([Relation.Child, "next"]);
    }, 30_000);

    it("a tag attached a second time is a 200 with the attachment's identifier and a 402 in the log, and the pair lookup is not behind either write", async () => {
      const id = await make("there-tagged");
      const tagId = await make("there-tag", ThoughtKind.Tag);
      // Asked before the write, as a plan asks: a lookup answered earlier.
      expect(await api.links.hasTag(brainId, id, tagId)).toBe(false);
      await api.thoughts.getGraph(brainId, id);

      const first = await api.links.attachTag(brainId, id, tagId);
      expect(await api.links.hasTag(brainId, id, tagId)).toBe(true);
      expect(await logged(first, 1)).toEqual(["101"]);

      const second = await api.links.attachTag(brainId, id, tagId);
      expect(second).toBe(first);
      expect(await logged(first, 2)).toEqual(["101", "402"]);
      const graph = await eventually(
        () => api.thoughts.getGraph(brainId, id),
        (g) => g.tags.length === 1,
      );
      expect(graph.tags.map((t) => t.id)).toEqual([tagId]);
      expect(graph.links).toHaveLength(1);

      expect(await api.links.detachTag(brainId, id, tagId)).toBe(true);
      expect(await api.links.hasTag(brainId, id, tagId)).toBe(false);
    }, 30_000);

    it("two links posted at once for a pair with none can both be made, and then the pair lookup is a 404 and a further post a 400", async () => {
      // Over 60 pairs: two links 51 times, each with an identifier of its
      // own, both read by it and both in the graph; one link the other 9,
      // one of the two identifiers answered then naming no link. So a pair
      // is tried until it comes to two, which the first or the second does.
      let doubled: { a: string; b: string; ids: string[] } | null = null;
      for (let attempt = 0; attempt < 20 && doubled === null; attempt += 1) {
        const { a, b } = await pair(`there-twice-${attempt}`);
        const [x, y] = await Promise.all([
          post({ thoughtIdA: a, thoughtIdB: b, relation: 3 }),
          post({ thoughtIdA: a, thoughtIdB: b, relation: 3 }),
        ]);
        await settle(600);
        const links = await joining(a, b);
        expect([1, 2], `attempt ${attempt}`).toContain(links.length);
        if (links.length === 2) doubled = { a, b, ids: [x.id, y.id] };
      }
      expect(doubled, "no pair came to two links in twenty tries").not.toBeNull();
      const { a, b, ids } = doubled!;

      expect(new Set(ids).size).toBe(2);
      expect((await joining(a, b)).map((l) => l.id).sort()).toEqual([...ids].sort());
      // Two links the same way: the lookup finds neither, from either end.
      expect(await api.links.between(brainId, a, b)).toBeNull();
      expect(await api.links.between(brainId, b, a)).toBeNull();
      // And nothing further can be posted between the two, whichever way.
      for (const body of [
        { thoughtIdA: a, thoughtIdB: b, relation: 3 },
        { thoughtIdA: b, thoughtIdB: a, relation: 3 },
        { thoughtIdA: a, thoughtIdB: b, relation: 1 },
      ]) {
        await expect(post(body)).rejects.toMatchObject({
          status: 400,
          message: "Link could not be created.",
        });
      }
      // One of the two deleted, and the pair has its one link again.
      await api.links.delete(brainId, ids[0]!);
      const left = await eventually(
        () => api.links.between(brainId, a, b),
        (l) => l !== null,
        { timeoutMs: 3000, stepMs: 50 },
      );
      expect(left?.id).toBe(ids[1]);
    }, 90_000);

    it("ingest sends one link for a pair its plan names twice, the first, on a first run and on a second", async () => {
      // Both used to be posted at once and counted under "links created: 2",
      // and two links between the pair is what 14 plans of 20 left.
      const root = await make("there-plan-root");
      const p = await make("there-plan-P");
      const q = await make("there-plan-Q");
      const name = (what: string): string => `${PREFIX}there-plan-${what}`;
      const plan = {
        thoughts: [
          { tempId: "a", name: name("a"), parent: root },
          { tempId: "b", name: name("b"), parent: root },
        ],
        links: [
          { from: "a", to: "b", name: "first" },
          { from: "b", to: "a", relation: "child" as const, name: "second" },
          { from: p, to: q, relation: "child" as const },
          { from: q.toUpperCase(), to: p.toUpperCase() },
        ],
      };
      for (const run of [1, 2]) {
        const outcome = await ingest(api, brainId, plan);
        outcome.created.forEach((c) => created.push(c.thoughtId));
        expect(outcome.failures, `run ${run}`).toEqual([]);
        expect(outcome.linksCreated, `run ${run}`).toBe(run === 1 ? 2 : 0);
        // The pairs are written six at a time, so in no set order.
        expect(
          outcome.linksNotAdded.map((l) => `${l.from} -> ${l.to}`).sort(),
          `run ${run}`,
        ).toEqual([`${q.toUpperCase()} -> ${p.toUpperCase()}`, `b -> a`].sort());
        expect(outcome.linksNotAdded.find((l) => l.from === "b")!.note).toBe(
          "the plan has a link between the same two thoughts ahead of this one, a -> b, and " +
            'two thoughts share one link: this one was not sent, and its label "second" was ' +
            "not written",
        );
      }
      await settle(600);
      const [a, b] = (await api.thoughts.getGraph(brainId, root)).children
        .filter((c) => [name("a"), name("b")].includes(c.name ?? ""))
        .sort((x, y) => (x.name ?? "").localeCompare(y.name ?? ""))
        .map((c) => c.id) as [string, string];
      const ab = await joining(a, b);
      expect(ab.map((l) => [l.thoughtIdA, l.relation, l.name])).toEqual([
        [a, Relation.Jump, "first"],
      ]);
      const pq = await joining(p, q);
      expect(pq.map((l) => [l.thoughtIdA, l.relation])).toEqual([[p, Relation.Child]]);
    }, 60_000);

    it("a second run of a plan logs nothing for its tags and its labels, and a label changed by hand is replaced and quoted", async () => {
      const root = await make("there-run-root");
      const tagId = await make("there-run-tag", ThoughtKind.Tag);
      const name = (what: string): string => `${PREFIX}there-run-${what}`;
      const plan = {
        thoughts: [
          { tempId: "top", name: name("top"), parent: root, tagIds: [tagId] },
          { tempId: "leaf", name: name("leaf"), parent: "top", tagIds: [tagId] },
          { tempId: "side", name: name("side"), parent: "top" },
        ],
        links: [
          { from: "leaf", to: "side", name: " motivates\n" },
          { from: "top", to: "leaf", name: "has part" },
        ],
      };
      const first = await ingest(api, brainId, plan);
      first.created.forEach((c) => created.push(c.thoughtId));
      expect(first).toMatchObject({ tagsAttached: 2, tagsAlreadyThere: 0, linksCreated: 1 });
      const at = (tempId: string): string =>
        first.created.find((c) => c.tempId === tempId)!.thoughtId;
      const tagLinks = [
        (await api.links.between(brainId, at("top"), tagId))!.id,
        (await api.links.between(brainId, at("leaf"), tagId))!.id,
      ];
      const jump = (await api.links.between(brainId, at("leaf"), at("side")))!;
      expect(jump.name).toBe("motivates");
      const hierarchy = (await api.links.between(brainId, at("top"), at("leaf")))!;
      const about = [...tagLinks, jump.id, hierarchy.id];
      const entries = async (): Promise<number> => {
        await settle(700);
        const all = await newestLogs(300);
        return all.filter((l) => about.includes(l.sourceId)).length;
      };
      const before = await entries();

      const second = await ingest(api, brainId, plan);
      expect(second).toMatchObject({
        created: [],
        tagsAttached: 0,
        tagsAlreadyThere: 2,
        linksCreated: 0,
        failures: [],
      });
      expect(second.linksReused.map((l) => l.note).sort()).toEqual([
        "the link already existed as parent-child with top above, the requested jump was not " +
          'added, and its label is already "has part"',
        'the link already existed, label already "motivates"',
      ]);
      // It used to add a 402 for each tag.
      expect(await entries()).toBe(before);

      // A person renames the label, and the plan is sent a third time.
      await api.links.update(brainId, jump.id, { name: "by hand" });
      await eventually(
        () => api.links.get(brainId, jump.id),
        (l) => l.name === "by hand",
      );
      const third = await ingest(api, brainId, plan);
      expect(third.linksReused.map((l) => l.note)).toContain(
        'the link already existed, label updated: it was "by hand" and is now "motivates"',
      );
      const renamed = await eventually(
        () => api.links.get(brainId, jump.id),
        (l) => l.name === "motivates",
      );
      expect(renamed.name).toBe("motivates");
    }, 60_000);
  });

  /**
   * What `brain_link` with replace and `brain_unlink` stand on
   * (docs/api-map.md, L43): a post over the one link a pair has, a link's
   * deletion, and the pairs that posts sent at once leave.
   */
  describe("a link changed or removed", () => {
    const pair = async (
      name: string,
      kindB: number = ThoughtKind.Normal,
    ): Promise<{ a: string; b: string }> => ({
      a: await make(`${name}-A`),
      b: await make(`${name}-B`, kindB),
    });
    const post = (body: Record<string, unknown>): Promise<{ id: string }> =>
      api.client.post<{ id: string }>(`/api/links/${brainId}`, { json: body });
    /** The links a thought's graph has between it and another. */
    const joining = async (a: string, b: string): Promise<LinkDto[]> =>
      (await api.thoughts.getGraph(brainId, a)).links.filter(
        (l) => [l.thoughtIdA, l.thoughtIdB].includes(a) && [l.thoughtIdA, l.thoughtIdB].includes(b),
      );
    /** The log's entries about one link, oldest first, as `modType` and its values. */
    const logged = async (linkId: string, atLeast: number): Promise<ModificationLogDto[]> => {
      const ours = (entries: ModificationLogDto[]): ModificationLogDto[] =>
        entries.filter((l) => l.sourceId === linkId);
      const entries = await eventually(
        () => newestLogs(300),
        (all) => ours(all).length >= atLeast,
        { timeoutMs: 3000, stepMs: 100 },
      );
      return ours(entries).sort((x, y) => compareLogTime(logTime(x), logTime(y)));
    };
    /**
     * A pair that `bodies`, posted at once, left with `count` links or more,
     * and the pairs tried before it, whose links are deleted. Two at once
     * came to two links 51 times in 60 (L35), and three to three 8 times in
     * 10; so a pair is tried until it comes to them.
     */
    const atOnce = async (
      name: string,
      bodies: (a: string, b: string) => Array<Record<string, unknown>>,
      count: number,
      kindB: number = ThoughtKind.Normal,
    ): Promise<{ a: string; b: string; links: LinkDto[] }> => {
      for (let attempt = 0; attempt < 15; attempt += 1) {
        const { a, b } = await pair(`${name}-${attempt}`, kindB);
        await Promise.all(bodies(a, b).map(post));
        await settle(600);
        const links = await joining(a, b);
        if (links.length >= count) return { a, b, links };
        for (const l of links) await api.links.delete(brainId, l.id);
      }
      throw new Error(`no pair came to ${count} links in fifteen tries`);
    };

    it("a link posted over with another relation is rewritten under its identifier, keeps its label, colour, thickness and direction, and logs a 402 alone", async () => {
      // 144 of 144 by script, two posts to each change, three times each;
      // here one post to each. The lookup had the new kind at its first
      // read every time; a jump kept the end it was first posted from.
      const STATES = {
        jump: (a: string, b: string) => ({ thoughtIdA: a, thoughtIdB: b, relation: 3 }),
        jumpBack: (a: string, b: string) => ({ thoughtIdA: b, thoughtIdB: a, relation: 3 }),
        aAbove: (a: string, b: string) => ({ thoughtIdA: a, thoughtIdB: b, relation: 1 }),
        bAbove: (a: string, b: string) => ({ thoughtIdA: b, thoughtIdB: a, relation: 1 }),
      };
      // Each target by a post that names its ends one way or the other.
      const TARGETS = {
        jump: (a: string, b: string) => ({ thoughtIdA: b, thoughtIdB: a, relation: 3 }),
        aAbove: (a: string, b: string) => ({ thoughtIdA: b, thoughtIdB: a, relation: 2 }),
        bAbove: (a: string, b: string) => ({ thoughtIdA: b, thoughtIdB: a, relation: 1 }),
      };
      // A type or a tag below is an ordinary link; above, it is not one.
      for (const kindB of [ThoughtKind.Normal, ThoughtKind.Type, ThoughtKind.Tag]) {
        const { a, b } = await pair(`changed-${kindB}`, kindB);
        for (const [state, made] of Object.entries(STATES)) {
          if (kindB !== ThoughtKind.Normal && state === "bAbove") continue;
          for (const [target, sent] of Object.entries(TARGETS)) {
            if (kindB !== ThoughtKind.Normal && target === "bAbove") continue;
            const cell = `kind ${kindB}: ${state} to ${target}`;
            const { id } = await post(made(a, b));
            await api.links.update(brainId, id, {
              name: "kept",
              color: "#123456",
              thickness: 3,
              direction: 2,
            });
            const before = await eventually(
              () => api.links.between(brainId, a, b),
              (l) => l?.name === "kept" && l.color === "#123456" && l.direction === 2,
            );
            expect(before?.thickness, cell).toBe(300);
            const first = before!.thoughtIdA;

            expect((await post(sent(a, b))).id, cell).toBe(id);
            const [relation, upper] =
              target === "jump"
                ? [Relation.Jump, first]
                : target === "aAbove"
                  ? [Relation.Child, a]
                  : [Relation.Child, b];
            const after = await eventually(
              () => api.links.between(brainId, a, b),
              (l) => l?.relation === relation && l.thoughtIdA === upper,
              { timeoutMs: 2000, stepMs: 20 },
            );
            expect(after, cell).toMatchObject({
              id,
              relation,
              thoughtIdA: upper,
              meaning: LinkMeaning.Normal,
              name: "kept",
              color: "#123456",
              thickness: 300,
              direction: 2,
            });
            // Its 101, a 103 and a 201, 401 and 403 for the patch, and one
            // 402 for the post; nothing names the relation.
            const entries = await logged(id, 6);
            expect(entries.map((l) => l.modType).sort(), cell).toEqual([101, 103, 201, 401, 402, 403]);
            await api.links.delete(brainId, id);
          }
        }
      }
    }, 120_000);

    it("a link deleted is gone from the lookup at once and from its own read soon after; deleted again it is a 400, as an identifier no link has is; the log has a 102 with both ends and its name", async () => {
      const { a, b } = await pair("deleted");
      const { id } = await post({ thoughtIdA: a, thoughtIdB: b, relation: 3, name: "gone" });
      expect((await api.links.between(brainId, a, b))?.id).toBe(id);

      await api.links.delete(brainId, id);
      // Measured at the first read 20 times of 20, 2 to 4 ms after the answer.
      const lookup = await eventually(
        () => api.links.between(brainId, a, b),
        (l) => l === null,
        { timeoutMs: 1000, stepMs: 20 },
      );
      expect(lookup).toBeNull();
      // The read by its identifier is behind, by 4 to 216 ms.
      const read = await eventually(
        () => api.links.get(brainId, id).then(() => "there", (e: TheBrainError) => e.kind),
        (r) => r !== "there",
        { timeoutMs: 3000, stepMs: 50 },
      );
      expect(read).toBe("not_found");

      for (const linkId of [id, "12345678-1234-4234-8234-123456789abc"]) {
        await expect(api.links.delete(brainId, linkId)).rejects.toMatchObject({
          kind: "bad_request",
          status: 400,
          message: "Bad Request",
        });
      }

      const entries = await logged(id, 3);
      const gone = entries.find((l) => l.modType === ModType.Deleted);
      expect(gone).toMatchObject({
        sourceType: EntityType.Link,
        extraAId: a,
        extraBId: b,
        oldValue: "gone",
        newValue: null,
      });
      // Each end is linked to nothing now.
      const graph = await eventually(
        () => api.thoughts.getGraph(brainId, b),
        (g) => g.links.length === 0,
      );
      expect([graph.parents, graph.children, graph.jumps].map((l) => l.length)).toEqual([0, 0, 0]);
    }, 30_000);

    it("two links that go each way: the lookup gives each by the end named first, any further post is the bare 400, and both graphs list both", async () => {
      // Two jumps sent at once from each end came to two links 3 times in 5,
      // and a jump and a parent link, stored from the other end, 2 in 5.
      const { a, b, links } = await atOnce(
        "each-way",
        (a, b) => [
          { thoughtIdA: a, thoughtIdB: b, relation: 3 },
          { thoughtIdA: b, thoughtIdB: a, relation: 3 },
        ],
        2,
      );
      const fromA = links.find((l) => l.thoughtIdA === a)!;
      const fromB = links.find((l) => l.thoughtIdA === b)!;
      expect((await api.links.between(brainId, a, b))?.id).toBe(fromA.id);
      expect((await api.links.between(brainId, b, a))?.id).toBe(fromB.id);
      expect((await joining(b, a)).map((l) => l.id).sort()).toEqual([fromA.id, fromB.id].sort());
      expect(
        linksOfPair(a, b, (await api.thoughts.getGraph(brainId, a)).links, fromA).map((l) => l.id),
      ).toEqual([fromA.id, fromB.id]);

      for (const body of [
        { thoughtIdA: a, thoughtIdB: b, relation: 3 },
        { thoughtIdA: b, thoughtIdB: a, relation: 3 },
        { thoughtIdA: a, thoughtIdB: b, relation: 1 },
        { thoughtIdA: a, thoughtIdB: b, relation: 2 },
      ]) {
        await expect(post(body)).rejects.toMatchObject({
          status: 400,
          message: "Link could not be created.",
        });
      }
      expect(await joining(a, b)).toHaveLength(2);

      // One deleted, and the other is the pair's to the lookup from each end
      // at once, where a graph read before lists both still: 12 of 12 for
      // both graphs, for 26 to 211 ms. The two lookups are what tells the
      // pair's one link from a graph behind.
      await api.links.delete(brainId, fromA.id);
      const graphs = [
        ...(await api.thoughts.getGraph(brainId, a)).links,
        ...(await api.thoughts.getGraph(brainId, b)).links,
      ];
      const [ab, ba] = await eventually(
        async () => [await api.links.between(brainId, a, b), await api.links.between(brainId, b, a)],
        ([x, y]) => x?.id === fromB.id && y?.id === fromB.id,
        { timeoutMs: 1000, stepMs: 20 },
      );
      expect([ab?.id, ba?.id]).toEqual([fromB.id, fromB.id]);
      expect(linksOfPair(a, b, graphs, ab!, ba!).map((l) => l.id)).toEqual([fromB.id]);
      // And it takes a post again: rewritten, under its identifier.
      expect((await post({ thoughtIdA: a, thoughtIdB: b, relation: 1 })).id).toBe(fromB.id);
    }, 120_000);

    it("three links posted at once the same way: the lookup has none until one is left, and every post between them is the bare 400", async () => {
      const { a, b, links } = await atOnce(
        "three",
        (a, b) => [1, 2, 3].map(() => ({ thoughtIdA: a, thoughtIdB: b, relation: 3 })),
        3,
      );
      expect(linksOfPair(a, b, links, null).map((l) => l.id)).toEqual(links.map((l) => l.id));
      for (const [i, link] of links.entries()) {
        const left = links.length - i;
        if (left === 1) {
          expect((await api.links.between(brainId, a, b))?.id).toBe(link.id);
          expect((await api.links.between(brainId, b, a))?.id).toBe(link.id);
          break;
        }
        expect(await api.links.between(brainId, a, b), `${left} left`).toBeNull();
        expect(await api.links.between(brainId, b, a), `${left} left`).toBeNull();
        await expect(post({ thoughtIdA: a, thoughtIdB: b, relation: 3 })).rejects.toMatchObject({
          status: 400,
          message: "Link could not be created.",
        });
        await api.links.delete(brainId, link.id);
        await settle(100);
      }
    }, 120_000);

    it("a tag attached twice: the lookup has neither, attached again or jumped to it is the bare 400, and the graph lists the tag once", async () => {
      // 7 of 10 attaches sent at once came to two attachments.
      const attach = (a: string, b: string) => ({ thoughtIdA: a, thoughtIdB: b, relation: 2 });
      const { a, b, links } = await atOnce("tag-twice", (a, b) => [attach(a, b), attach(a, b)], 2, ThoughtKind.Tag);
      expect(links.map((l) => [l.meaning, l.thoughtIdA])).toEqual([
        [LinkMeaning.Tag, b],
        [LinkMeaning.Tag, b],
      ]);
      expect(await api.links.between(brainId, a, b)).toBeNull();
      expect(await api.links.hasTag(brainId, a, b)).toBe(false);
      for (const body of [attach(a, b), { thoughtIdA: a, thoughtIdB: b, relation: 3 }]) {
        await expect(post(body)).rejects.toMatchObject({
          status: 400,
          message: "Link could not be created.",
        });
      }
      expect((await api.thoughts.getGraph(brainId, a)).tags.map((t) => t.id)).toEqual([b]);
    }, 120_000);

    it("a post towards an end deleted a moment ago is the 400 that names it, not the bare one", async () => {
      // 20 of 20, 0 to 1,500 ms after the delete.
      const a = await make("gone-end-A");
      const b = await api.thoughts.create(brainId, { name: `${PREFIX}gone-end-B` });
      await api.thoughts.delete(brainId, b);
      await expect(post({ thoughtIdA: a, thoughtIdB: b, relation: 3 })).rejects.toMatchObject({
        status: 400,
        message: `Could not get target thought ${b}`,
      });
    }, 30_000);

    it("a thought's graph lists its parent's link, its type's and its tag's among its links", async () => {
      const parent = await make("links-parent");
      const type = await make("links-type", ThoughtKind.Type);
      const tag = await make("links-tag", ThoughtKind.Tag);
      const id = await api.thoughts.create(brainId, {
        name: `${PREFIX}links-thought`,
        sourceThoughtId: parent,
        relation: Relation.Child,
        typeId: type,
      });
      created.push(id);
      await api.links.attachTag(brainId, id, tag);
      const graph = await eventually(
        () => api.thoughts.getGraph(brainId, id),
        (g) => g.links.length === 3,
      );
      expect(
        graph.links
          .map((l): [number, string] => [l.meaning, l.thoughtIdA])
          .sort((x, y) => x[0] - y[0]),
      ).toEqual([
        [LinkMeaning.Normal, parent],
        [LinkMeaning.Type, type],
        [LinkMeaning.Tag, tag],
      ]);
    }, 30_000);
  });

  /**
   * What a patch does to a link, path by path. Measured on TheBrain 15.0.640;
   * the spec says "Updates a link using JSON Patch" and no more. No tool sends
   * anything but a name, so this pins what `links.update()` may promise.
   */
  describe("patching a link", () => {
    type Op = { op: "add" | "replace" | "remove"; path: string; value?: unknown };
    /** A jump between two new thoughts, from `a` to `b`. */
    const linked = async (
      name: string,
      label?: string,
    ): Promise<{ id: string; a: string; b: string }> => {
      const a = await make(`${name}-A`);
      const b = await make(`${name}-B`);
      const id = await api.links.create(brainId, {
        thoughtIdA: a,
        thoughtIdB: b,
        relation: Relation.Jump,
        ...(label !== undefined ? { name: label } : {}),
      });
      return { id, a, b };
    };
    const patch = (id: string, ...ops: Op[]): Promise<unknown> =>
      api.client.patch(`/api/links/${brainId}/${id}`, { jsonPatch: ops });
    /** The error a patch is refused with, or null when it is accepted. */
    const refusal = (id: string, ...ops: Op[]): Promise<TheBrainError | null> =>
      patch(id, ...ops).then(
        () => null,
        (error: unknown) => error as TheBrainError,
      );
    const read = (id: string, ok: (l: LinkDto) => boolean): Promise<LinkDto> =>
      eventually(() => api.links.get(brainId, id), ok);

    it("a name is cleared by remove or by an empty string, to \"\"; replace with null is a 200 that changes nothing", async () => {
      const { id } = await linked("link-name", "probe");

      // Accepted, and that is the trap: the name stays.
      expect(await refusal(id, { op: "replace", path: "/name", value: null })).toBeNull();
      await settle();
      expect((await api.links.get(brainId, id)).name).toBe("probe");

      await patch(id, { op: "remove", path: "/name" });
      expect((await read(id, (l) => l.name !== "probe")).name).toBe("");
      // Removing what is not there is accepted.
      expect(await refusal(id, { op: "remove", path: "/name" })).toBeNull();

      await api.links.update(brainId, id, { name: "again" });
      await read(id, (l) => l.name === "again");
      await patch(id, { op: "replace", path: "/name", value: "" });
      expect((await read(id, (l) => l.name !== "again")).name).toBe("");

      // The flat facade.
      await api.links.update(brainId, id, { name: "once more" });
      await read(id, (l) => l.name === "once more");
      await api.links.update(brainId, id, { name: null });
      expect((await read(id, (l) => l.name !== "once more")).name).toBe("");

      // A link never named reads null, and cleared it reads "" like the rest.
      const bare = await linked("link-unnamed");
      expect((await api.links.get(brainId, bare.id)).name).toBeNull();
      await api.links.update(brainId, bare.id, { name: null });
      expect((await read(bare.id, (l) => l.name !== null)).name).toBe("");
    }, 30_000);

    it("a colour is cleared by remove alone; null, an empty string and anything but #rrggbb are a 400", async () => {
      const { id } = await linked("link-colour");
      await api.links.update(brainId, id, { color: "#ff7145" });
      // It reads back in capitals.
      expect((await read(id, (l) => l.color !== null)).color).toBe("#FF7145");

      for (const value of [null, "", "ff7145", "#f71", "red"]) {
        const refused = await refusal(id, { op: "replace", path: "/color", value });
        expect(refused?.kind, JSON.stringify(value)).toBe("bad_request");
        expect(refused?.message).toMatch(/malformed/i);
      }
      await settle();
      expect((await api.links.get(brainId, id)).color).toBe("#FF7145");

      await api.links.update(brainId, id, { color: null });
      expect((await read(id, (l) => l.color === null)).color).toBeNull();
      // Removing what is not there is accepted.
      await api.links.update(brainId, id, { color: null });
    });

    it("thickness takes replace with a whole number alone, reads back a hundred times it, and never returns to the -1 of a new link", async () => {
      const { id } = await linked("link-thickness");
      expect((await api.links.get(brainId, id)).thickness).toBe(-1);

      const refusals: Array<[Op, string, RegExp]> = [
        [{ op: "replace", path: "/thickness", value: null }, "bad_request", /not specified/],
        [{ op: "replace", path: "/thickness", value: "" }, "bad_request", /not specified/],
        [{ op: "remove", path: "/thickness" }, "bad_request", /only 'replace'/i],
        [{ op: "add", path: "/thickness", value: 2 }, "bad_request", /only 'replace'/i],
        // The 403 a thought that does not exist gets, not a 400.
        [{ op: "replace", path: "/thickness", value: 1.5 }, "forbidden", /./],
      ];
      for (const [op, kind, message] of refusals) {
        const refused = await refusal(id, op);
        expect(refused?.kind, JSON.stringify(op)).toBe(kind);
        expect(refused?.message, JSON.stringify(op)).toMatch(message);
      }
      await settle();
      expect((await api.links.get(brainId, id)).thickness).toBe(-1);

      await api.links.update(brainId, id, { thickness: 3 });
      expect((await read(id, (l) => l.thickness !== -1)).thickness).toBe(300);

      // What looks like the way back is not: -1 is one more width, and so is 0.
      await api.links.update(brainId, id, { thickness: -1 });
      expect((await read(id, (l) => l.thickness !== 300)).thickness).toBe(-100);
      await api.links.update(brainId, id, { thickness: 0 });
      expect((await read(id, (l) => l.thickness !== -100)).thickness).toBe(0);

      // So the facade offers no null, and refuses one before it sends the name.
      for (const thickness of [null as unknown as number, 1.5]) {
        await expect(
          api.links.update(brainId, id, { name: "never written", thickness }),
        ).rejects.toMatchObject({ kind: "bad_request" });
      }
      await settle();
      const after = await api.links.get(brainId, id);
      expect([after.name, after.thickness]).toEqual([null, 0]);
    }, 30_000);

    it("direction takes 0 to 7 and not the -1 of a new link; relation 4 changes nothing, and 2 swaps the ends each time", async () => {
      const { id, a, b } = await linked("link-ends");
      const ends = (l: LinkDto): unknown[] => [l.relation, l.thoughtIdA, l.thoughtIdB];
      // As the API takes it: `update` refuses a relation, for what follows.
      const relate = (value: number): Promise<unknown> =>
        patch(id, { op: "replace", path: "/relation", value });
      const fresh = await api.links.get(brainId, id);
      expect(fresh.direction).toBe(-1);
      expect(ends(fresh)).toEqual([Relation.Jump, a, b]);

      for (const direction of [7, 0]) {
        await api.links.update(brainId, id, { direction });
        expect((await read(id, (l) => l.direction === direction)).direction).toBe(direction);
      }
      for (const value of [-1, 8]) {
        const refused = await refusal(id, { op: "replace", path: "/direction", value });
        expect(refused?.kind, `direction ${value}`).toBe("bad_request");
        expect(refused?.message).toMatch(/invalid 'direction'/i);
      }

      // Accepted, with nothing to show for it: 4 is the spec's "Sibling".
      await relate(4);
      await settle();
      const still = await api.links.get(brainId, id);
      expect(still.direction).toBe(0);
      expect(ends(still)).toEqual([Relation.Jump, a, b]);

      await relate(Relation.Child);
      expect(ends(await read(id, (l) => l.relation === Relation.Child))).toEqual([
        Relation.Child,
        a,
        b,
      ]);
      // A parent is stored as a child link the other way round, so the same
      // patch sent again puts the ends back.
      await relate(Relation.Parent);
      expect(ends(await read(id, (l) => l.thoughtIdA === b))).toEqual([Relation.Child, b, a]);
      await relate(Relation.Parent);
      expect(ends(await read(id, (l) => l.thoughtIdA === a))).toEqual([Relation.Child, a, b]);
      // And the sibling that changed a jump into nothing does as much for a child.
      await relate(4);
      // Past the four the spec lists a patch is refused, where a create is not.
      for (const value of [0, 5, -1]) {
        const refused = await refusal(id, { op: "replace", path: "/relation", value });
        expect(refused?.kind, `relation ${value}`).toBe("bad_request");
        expect(refused?.message).toMatch(/invalid 'relation'/i);
      }
      await settle();
      expect(ends(await api.links.get(brainId, id))).toEqual([Relation.Child, a, b]);

      await relate(Relation.Jump);
      expect(ends(await read(id, (l) => l.relation === Relation.Jump))).toEqual([
        Relation.Jump,
        a,
        b,
      ]);
    }, 30_000);

    it("a link's kind is not what it means: only 1 is taken as it stands, 2 asks for a typeId and is not kept, and meaning stays", async () => {
      // `PATCH /kind` on a link, which is not the `kind` of a thought (L31):
      // a link's says whether it is a link or a link type, and what a link
      // is between two thoughts is its `meaning`, which no patch sets.
      // Measured on 15.0.640, 3 of 3 for each answer on a jump, a child's
      // link, a type's and a tag's, each patch sent to a link of its own.
      const ZEROS = "00000000-0000-0000-0000-000000000000";
      const kind = (value: unknown): Op => ({ op: "replace", path: "/kind", value });
      const jump = (await linked("link-kind")).id;
      const tagId = await make("link-kind-tag", ThoughtKind.Tag);
      const tagLink = await api.links.attachTag(brainId, await make("link-kind-tagged"), tagId);

      for (const [id, meaning] of [
        [jump, LinkMeaning.Normal],
        [tagLink, LinkMeaning.Tag],
      ] as const) {
        const fresh = await read(id, (l) => l.meaning === meaning);
        expect([fresh.kind, fresh.meaning, fresh.typeId]).toEqual([1, meaning, null]);

        const refused = async (op: Op): Promise<string> => {
          const e = await refusal(id, op);
          return e === null ? "accepted" : `${e.status} ${e.kind}: ${e.message}`;
        };
        for (const value of [-1, 0, 3, 4, 5, 6, 99]) {
          expect(await refused(kind(value)), `kind ${value}`).toBe(
            "400 bad_request: Invalid 'kind' specified.",
          );
        }
        // A link with no typeId: the number and the number as a string alike.
        for (const value of [2, "2"]) {
          expect(await refused(kind(value)), `kind ${JSON.stringify(value)}`).toBe(
            "400 bad_request: Link 'typeId' must be specified if setting 'kind' to '2'.",
          );
        }
        // The catch-all 403 for what is no whole number.
        for (const value of [null, 1.5, "tag", true]) {
          expect((await refusal(id, kind(value)))?.kind, `kind ${JSON.stringify(value)}`).toBe(
            "forbidden",
          );
        }
        for (const op of [{ op: "remove", path: "/kind" }, { ...kind(1), op: "add" }] as Op[]) {
          expect(await refused(op), op.op).toBe(
            "400 bad_request: Only 'replace' operations are allowed for 'kind' path.",
          );
        }
        // `meaning` is accepted and ignored, whatever is sent.
        for (const value of [1, 2, 5, 7]) {
          expect(await refused({ op: "replace", path: "/meaning", value }), `meaning ${value}`).toBe(
            "accepted",
          );
        }
        await settle(500);
        expect(await api.links.get(brainId, id)).toEqual(fresh);

        // 1 is accepted, and writes after all: the link reads a typeId of
        // zeros from then on, where it had none.
        expect(await refused(kind(1))).toBe("accepted");
        const one = await read(id, (l) => l.typeId !== null);
        expect([one.kind, one.meaning, one.typeId]).toEqual([1, meaning, ZEROS]);
        // With a typeId, zeros for one, 2 is accepted. The link reads kind 2
        // at once and kind 1 again 22 to 344 ms later (18 of 18): not kept.
        expect(await refused(kind(2))).toBe("accepted");
        await settle(800);
        const two = await api.links.get(brainId, id);
        expect([two.kind, two.meaning]).toEqual([1, meaning]);
      }
    }, 60_000);

    it("a read straight after a link is patched can still return the old value", async () => {
      // The read of a link by its identifier is behind a patch of it, as a
      // graph is behind a create: of 300 patches of a name, 60 each of five
      // spacings, the first read after the answer had the old name 288
      // times, and the new one showed 10 to 368 ms after the answer. The 12
      // that had it at once were answered in 3 to 72 ms, where a read took
      // 1.5 ms at the median: a read that is answered late can come after
      // the copy is brought up to date.
      //
      // This asked for one old read in five patches, and went red in one run
      // in five while another session was at work in the same app. With the
      // app kept busy by reads of another brain's log, the first read had
      // the new name 10 times in 120. So it patches until one read is old,
      // which is the first patch 24 times in 25, and gives up at forty. Were
      // seven first reads in ten to come at once, which nothing measured
      // came near, all forty would be one run in a million; and they are
      // what a build that answers a patched link at once would give.
      const TRIES = 40;
      const { id } = await linked("link-lag");
      let old = -1;
      for (let i = 0; i < TRIES && old < 0; i++) {
        const name = `lag ${i}`;
        await api.links.update(brainId, id, { name });
        if ((await api.links.get(brainId, id)).name !== name) old = i;
        // Whatever that read said, the name is there before long. It took
        // 4.7 s behind bursts of writes to another brain, and once more than 5.
        expect((await read(id, (l) => l.name === name)).name).toBe(name);
      }
      expect(
        old,
        `${TRIES} patches of ${TRIES} read back at once: either the app was busy at every ` +
          "one of them, or the read of a link is no longer behind a patch (docs/api-map.md, L22)",
      ).toBeGreaterThanOrEqual(0);
    }, 60_000);

    it("a refused patch keeps what it wrote before the operation it refused", async () => {
      // So an update that throws may have landed in part, as for a thought.
      const { id } = await linked("link-partial", "probe");
      const refused = await refusal(
        id,
        { op: "replace", path: "/name", value: "renamed" },
        { op: "replace", path: "/color", value: null },
        { op: "replace", path: "/thickness", value: 2 },
      );
      expect(refused?.kind).toBe("bad_request");

      expect((await read(id, (l) => l.name === "renamed")).name).toBe("renamed");
      await settle();
      expect((await api.links.get(brainId, id)).thickness).toBe(-1);
    });

    it("a relation patched to child or parent with a type left above sets the thought's type", async () => {
      // What `links.create` refuses for a new link (a type is never a parent),
      // a patch does to one that is there: one more reason `update` takes none.
      const typeId = await make("link-patched-type", ThoughtKind.Type);
      for (const [name, typeFirst, value] of [
        ["link-patched-child", true, Relation.Child],
        ["link-patched-parent", false, Relation.Parent],
      ] as const) {
        const id = await make(name);
        const link = await api.links.create(brainId, {
          thoughtIdA: typeFirst ? typeId : id,
          thoughtIdB: typeFirst ? id : typeId,
          relation: Relation.Jump,
        });
        expect((await api.thoughts.get(brainId, id)).typeId, name).toBeNull();

        await patch(link, { op: "replace", path: "/relation", value });
        const typed = await eventually(
          () => api.thoughts.get(brainId, id),
          (t) => t.typeId === typeId,
        );
        expect(typed.typeId, name).toBe(typeId);
        const after = await read(link, (l) => l.meaning === LinkMeaning.Type);
        expect([after.thoughtIdA, after.relation, after.meaning], name).toEqual([
          typeId,
          Relation.Child,
          LinkMeaning.Type,
        ]);
      }
    });

    it("update refuses a relation, and writes none of the fields beside it", async () => {
      const { id, a, b } = await linked("link-no-relation");
      for (const relation of [Relation.Child, Relation.Parent, 4]) {
        await expect(
          api.links.update(brainId, id, { name: "never written", relation } as never),
        ).rejects.toMatchObject({ kind: "bad_request", message: /relation/ });
      }
      await settle();
      const after = await api.links.get(brainId, id);
      expect([after.name, after.relation, after.thoughtIdA, after.thoughtIdB]).toEqual([
        null,
        Relation.Jump,
        a,
        b,
      ]);
    });

    it("create rewrites the link two thoughts share and names both ends, so sent twice it leaves the same link", async () => {
      // What `update` points to instead: no end is named by its place in the
      // link, so a parent's link does not swap back on the second send.
      const { id, a, b } = await linked("link-twice", "kept");
      const ends = (l: LinkDto): unknown[] => [l.relation, l.thoughtIdA, l.thoughtIdB];
      for (const [relation, want] of [
        [Relation.Parent, [Relation.Child, b, a]],
        [Relation.Child, [Relation.Child, a, b]],
        [Relation.Jump, [Relation.Jump, a, b]],
      ] as const) {
        const input = { thoughtIdA: a, thoughtIdB: b, relation };
        expect(await api.links.create(brainId, input)).toBe(id);
        expect(ends(await read(id, (l) => ends(l).join() === want.join()))).toEqual(want);
        expect(await api.links.create(brainId, input)).toBe(id);
        await settle(600);
        expect(ends(await api.links.get(brainId, id)), `relation ${relation}`).toEqual(want);
      }
      expect((await api.links.get(brainId, id)).name).toBe("kept");
    }, 30_000);
  });

  /**
   * The spec's fourth relation, `Sibling = 4`. It names it for a new thought
   * and gives a link's `relation` no values at all. Measured on TheBrain
   * 15.0.640: nothing is written with it, and nothing in the API links two
   * siblings. What a patch does with it is in the block above.
   */
  describe("the sibling relation", () => {
    const SIBLING = 4;
    const ids = (thoughts: readonly ThoughtDto[]): string[] => thoughts.map((t) => t.id);
    const under = async (name: string, parent: string): Promise<string> => {
      const id = await api.thoughts.create(brainId, {
        name: PREFIX + name,
        sourceThoughtId: parent,
      });
      created.push(id);
      return id;
    };
    /** A thought as the API creates it, whatever relation it is sent with, or none. */
    const rawUnder = async (name: string, extra: Record<string, unknown>): Promise<string> => {
      const { id } = await api.client.post<{ id: string }>(`/api/thoughts/${brainId}`, {
        json: { name: PREFIX + name, kind: ThoughtKind.Normal, acType: 0, ...extra },
      });
      created.push(id);
      return id;
    };
    /** The error a link is refused with, or null when it is made. */
    const refusal = (
      thoughtIdA: string,
      thoughtIdB: string,
      relation?: number,
    ): Promise<TheBrainError | null> =>
      api.client
        .post(`/api/links/${brainId}`, {
          json: { thoughtIdA, thoughtIdB, ...(relation === undefined ? {} : { relation }) },
        })
        .then(
          () => null,
          (error: unknown) => error as TheBrainError,
        );

    it("a link is refused as a sibling's from either end, under one parent or under none, and a link already there stays as it was", async () => {
      const parent = await make("sib-parent");
      const a = await under("sib-a", parent);
      const b = await under("sib-b", parent);
      const lone = await make("sib-lone");
      const other = await make("sib-other");
      const refused = { kind: "bad_request", status: 400, message: "Invalid link relation 4" };

      for (const [from, to] of [
        [a, b],
        [b, a],
        // No parent in common: these two have none at all.
        [lone, other],
        [other, lone],
      ] as const) {
        expect(await refusal(from, to, SIBLING)).toMatchObject(refused);
      }
      await settle(600);
      expect(await api.links.between(brainId, a, b)).toBeNull();
      expect(await api.links.between(brainId, lone, other)).toBeNull();

      // Linked already, by a jump and by a parent's link: the same answer.
      const jump = await api.links.create(brainId, {
        thoughtIdA: lone,
        thoughtIdB: other,
        relation: Relation.Jump,
      });
      expect(await refusal(lone, other, SIBLING)).toMatchObject(refused);
      expect(await refusal(a, parent, SIBLING)).toMatchObject(refused);
      await settle(600);
      const kept = await api.links.between(brainId, lone, other);
      expect([kept?.id, kept?.relation]).toEqual([jump, Relation.Jump]);
      const above = await api.links.between(brainId, a, parent);
      expect([above?.thoughtIdA, above?.relation]).toEqual([parent, Relation.Child]);
    });

    it("a link takes 1, 2 or 3 and has no default: any other number, and none, is the same 400", async () => {
      const a = await make("rel-a");
      const b = await make("rel-b");
      for (const relation of [0, 5, -1]) {
        expect((await refusal(a, b, relation))?.message).toBe(`Invalid link relation ${relation}`);
      }
      expect(await refusal(a, b)).toMatchObject({
        kind: "bad_request",
        message: "Invalid link relation 0",
      });
      await settle(600);
      expect(await api.links.between(brainId, a, b)).toBeNull();
    });

    it("a thought created as a sibling of its source is linked to nothing", async () => {
      // A 200 and an identifier, as for any thought: the answer does not say.
      const parent = await make("sib-source-parent");
      const source = await under("sib-source", parent);
      const typeId = await make("sib-new-type", ThoughtKind.Type);
      const bare = await rawUnder("sib-new", { sourceThoughtId: source, relation: SIBLING });
      const typed = await rawUnder("sib-new-typed", {
        sourceThoughtId: source,
        relation: SIBLING,
        typeId,
      });

      await settle();
      const alone = await api.thoughts.getGraph(brainId, bare, { includeSiblings: true });
      expect(alone.links).toEqual([]);
      expect(alone.siblings).toEqual([]);
      // A type beside it is set, and is all the thought has.
      const graph = await api.thoughts.getGraph(brainId, typed);
      expect(graph.links.map((l) => [l.thoughtIdA, l.meaning])).toEqual([
        [typeId, LinkMeaning.Type],
      ]);
      expect(graph.parents).toEqual([]);

      // Nor did the source gain a sibling, or its parent a child.
      const from = await api.thoughts.getGraph(brainId, source, { includeSiblings: true });
      expect(from.links.map((l) => l.thoughtIdA)).toEqual([parent]);
      expect(from.siblings).toEqual([]);
      expect(ids((await api.thoughts.getGraph(brainId, parent)).children)).toEqual([source]);
    });

    it("a thought's relation to its source has no default either, and a number past the three is written on a link no list shows", async () => {
      const source = await make("rel-source");
      const unlinked = [
        await rawUnder("rel-none", { sourceThoughtId: source }),
        await rawUnder("rel-null", { sourceThoughtId: source, relation: null }),
        await rawUnder("rel-0", { sourceThoughtId: source, relation: 0 }),
      ];
      const odd: Array<[string, number]> = [];
      for (const relation of [5, -1]) {
        const id = await rawUnder(`rel-${relation}`, { sourceThoughtId: source, relation });
        odd.push([id, relation]);
      }

      await settle();
      for (const id of unlinked) {
        expect((await api.thoughts.getGraph(brainId, id)).links).toEqual([]);
      }
      for (const [id, relation] of odd) {
        const graph = await api.thoughts.getGraph(brainId, id);
        expect(graph.links.map((l) => [l.thoughtIdA, l.thoughtIdB, l.relation])).toEqual([
          [source, id, relation],
        ]);
        expect([...graph.parents, ...graph.children, ...graph.jumps]).toEqual([]);
      }
      const graph = await api.thoughts.getGraph(brainId, source);
      expect([...graph.parents, ...graph.children, ...graph.jumps]).toEqual([]);
      expect(graph.links.map((l) => l.relation).sort()).toEqual([-1, 5]);
    });

    it("siblings are thoughts with a parent in common: a graph lists them when asked, and no link joins them", async () => {
      const parent = await make("sibs-parent");
      const a = await under("sibs-a", parent);
      const b = await under("sibs-b", parent);

      const asked = await eventually(
        () => api.thoughts.getGraph(brainId, a, { includeSiblings: true }),
        (g) => g.siblings.length === 1,
      );
      expect(ids(asked.siblings)).toEqual([b]);
      // Each one's link is from the parent, and there is none between them.
      expect(asked.links.length).toBeGreaterThan(0);
      expect(asked.links.every((l) => l.thoughtIdA === parent)).toBe(true);
      expect(await api.links.between(brainId, a, b)).toBeNull();

      // Not asked for, the list is not sent at all.
      const unasked = await api.client.get<ThoughtGraphDto>(
        `/api/thoughts/${brainId}/${a}/graph`,
        { query: { includeSiblings: false } },
      );
      expect(unasked.siblings).toBeNull();
      expect(ids(unasked.parents ?? [])).toEqual([parent]);
    });

    it("a sibling that is also the thought's parent, child or jump is listed there, and not among its siblings", async () => {
      // A graph lists a thought once. Measured 10 of 10 for each line below
      // (docs/api-map.md, L40): of four thoughts under one parent beside the
      // active one, the one it jumps to, the one that jumps to it and the
      // one that is its child as well are under `jumps` and `children`, and
      // `siblings` is left with the fourth. `brain_get_thought` prints the
      // lists as they come, so nothing is lost: it stands under the other.
      const parent = await make("sibs-once-parent");
      const active = await under("sibs-once-active", parent);
      const jumpedTo = await under("sibs-once-jumped-to", parent);
      const jumpsHere = await under("sibs-once-jumps-here", parent);
      const childToo = await under("sibs-once-child-too", parent);
      const plain = await under("sibs-once-plain", parent);
      const link = (thoughtIdA: string, thoughtIdB: string, relation: Relation): Promise<string> =>
        api.links.create(brainId, { thoughtIdA, thoughtIdB, relation });
      const jump = await link(active, jumpedTo, Relation.Jump);
      await link(jumpsHere, active, Relation.Jump);
      await link(active, childToo, Relation.Child);

      const around = (id: string): Promise<CleanGraph> =>
        api.thoughts.getGraph(brainId, id, { includeSiblings: true });
      const lists = (g: CleanGraph): Record<string, string[]> => ({
        parents: ids(g.parents).sort(),
        children: ids(g.children).sort(),
        jumps: ids(g.jumps).sort(),
        siblings: ids(g.siblings).sort(),
      });
      const graph = await eventually(
        () => around(active),
        (g) => g.jumps.length === 2 && g.children.length === 1,
      );
      expect(lists(graph)).toEqual({
        parents: [parent],
        children: [childToo],
        jumps: [jumpedTo, jumpsHere].sort(),
        siblings: [plain],
      });
      // From the other side of each: the active thought is under the list
      // its link puts it in, and the other three are siblings still.
      const fromChild = await eventually(() => around(childToo), (g) => g.parents.length === 2);
      expect(lists(fromChild)).toEqual({
        parents: [parent, active].sort(),
        children: [],
        jumps: [],
        siblings: [jumpedTo, jumpsHere, plain].sort(),
      });
      const fromJump = await eventually(() => around(jumpedTo), (g) => g.jumps.length === 1);
      expect(lists(fromJump)).toEqual({
        parents: [parent],
        children: [],
        jumps: [active],
        siblings: [jumpsHere, childToo, plain].sort(),
      });

      // With the jump gone, the thought is a sibling again.
      await api.links.delete(brainId, jump);
      const after = await eventually(() => around(active), (g) => g.jumps.length === 1);
      expect(lists(after).siblings).toEqual([jumpedTo, plain].sort());
    }, 30_000);

    it("create refuses a relation that is none of the three, and ingest a plan that names one, before anything is written", async () => {
      const source = await make("sib-refused-source");
      for (const relation of [SIBLING, 0, 5]) {
        await expect(
          api.thoughts.create(brainId, {
            name: `${PREFIX}sib-never-made`,
            sourceThoughtId: source,
            relation: relation as Relation,
          }),
        ).rejects.toMatchObject({ kind: "bad_request", message: /^relation must be 1 \(child\)/ });
      }

      // The name the plan once had for it, past the type that has dropped it.
      const sibling = "sibling" as never;
      const top = { tempId: "top", name: `${PREFIX}sib-plan-top`, parent: source };
      const leaf = { tempId: "leaf", name: `${PREFIX}sib-plan-leaf`, parent: "top" };
      await expect(
        ingest(api, brainId, { thoughts: [top, { ...leaf, relation: sibling }] }),
      ).rejects.toThrowError(IngestValidationError);
      await expect(
        ingest(api, brainId, {
          thoughts: [top, leaf],
          links: [{ from: "leaf", to: source, relation: sibling }],
        }),
      ).rejects.toThrowError(IngestValidationError);

      await settle();
      expect((await api.thoughts.getGraph(brainId, source)).links).toEqual([]);
    });
  });

  /**
   * Measured on TheBrain 15.0.640, 2026-10-11 (docs/api-map.md, L36). The
   * spec says of a name that it is a string, and nothing of any of this.
   */
  describe("a thought's name: what is refused, what is ignored, and what is stored", () => {
    const BLANK = ["", "   ", "\t\n", "\r\n", " \u00a0\t\u3000\u0085\n", ...WHITE_SPACE];
    /**
     * Characters that do not show and are no white space: zero width, a byte
     * order mark, a braille blank, a word joiner, a combining mark and a
     * variation selector on their own, a Mongolian vowel separator, a control.
     */
    const UNSEEN = ["\u200b", "\ufeff", "\u2800", "\u2060", "\u0301", "\ufe0f", "\u180e", "\u001c"];
    const KINDS = [ThoughtKind.Normal, ThoughtKind.Type, ThoughtKind.Tag];
    const hex = (text: string): string =>
      [...text].map((c) => `U+${c.codePointAt(0)!.toString(16)}`).join(" ");

    const answer = (request: Promise<unknown>): Promise<string> =>
      request.then(
        () => "accepted",
        (e: unknown) =>
          e instanceof TheBrainError ? `${e.status} ${e.kind}: ${e.message}` : String(e),
      );
    /** A create as the API takes it, the name whatever it is, or left out. */
    const rawCreate = async (name: unknown, kind: number = ThoughtKind.Normal): Promise<string> => {
      const { id } = await api.client.post<{ id: string }>(`/api/thoughts/${brainId}`, {
        json: { ...(name === undefined ? {} : { name }), kind, acType: 0 },
      });
      created.push(id);
      return id;
    };
    const rawRename = (id: string, value: unknown): Promise<unknown> =>
      api.client.patch(`/api/thoughts/${brainId}/${id}`, {
        jsonPatch: [{ op: "replace", path: "/name", value }],
      });
    const nameOf = async (id: string): Promise<string | null> =>
      (await api.thoughts.get(brainId, id)).name;
    /**
     * How long a rename is given to read back. Measured on 2026-10-14: about
     * 0.1 s with the app to itself, 102 ms at the most of 40, and 130 ms of
     * 40 with another contract run at work in it. But a rename reads back
     * behind whatever else the app was given to write: beside bursts of 300
     * creates in another brain it took 1 to 30 s, longer with each burst, 24
     * renames in four minutes, and the first after the bursts 13.7 s. One
     * burst of 600 held a patch back 5.3 s (*a typeId that is not a type*).
     * Three seconds were not enough once beside another session; polled, a
     * longer bound costs nothing when the rename is quick.
     */
    const RENAMED_MS = 20_000;
    /** The thought's name once it reads `name`, or the last one it read. */
    const renamedTo = (id: string, name: string): Promise<string | null> =>
      eventually(() => nameOf(id), (n) => n === name, { timeoutMs: RENAMED_MS, stepMs: 50 });
    /** The thought's own log entries, oldest first, as `101 "name"` or `103 "old"→"new"`. */
    const logged = async (id: string): Promise<string[]> =>
      (await api.thoughts.modifications(brainId, id, { includeRelated: false }))
        .filter((l) => l.sourceId === id)
        .reverse()
        .map((l) =>
          l.modType === ModType.Created
            ? `101 ${JSON.stringify(l.newValue)}`
            : `${l.modType} ${JSON.stringify(l.oldValue)}→${JSON.stringify(l.newValue)}`,
        );

    it("a create with a name of white space alone is a 400, for each of the 25 code points, and so is no name", async () => {
      for (const name of BLANK) {
        expect(await answer(rawCreate(name)), hex(name)).toBe(
          "400 bad_request: A name is required",
        );
        // The server's rule is the API's: it refuses what the API refuses.
        expect(nameRefusal(name, "name"), hex(name)).not.toBeNull();
      }
      for (const kind of [ThoughtKind.Type, ThoughtKind.Tag]) {
        for (const name of ["", " ", "\u00a0", "\u0085", "\u3000\t"]) {
          expect(await answer(rawCreate(name, kind)), `kind ${kind}, ${hex(name)}`).toBe(
            "400 bad_request: A name is required",
          );
        }
      }
      // With null for a name, and with none, the 400 is the validator's.
      for (const kind of KINDS) {
        for (const name of [null, undefined]) {
          expect(await answer(rawCreate(name, kind)), `kind ${kind}, ${String(name)}`).toMatch(
            /^400 bad_request: One or more validation errors occurred/,
          );
        }
      }
    }, 60_000);

    it("a rename to one is a 200 that leaves the name as it was and logs nothing", async () => {
      for (const kind of KINDS) {
        const name = `${PREFIX}name-kept-${kind}`;
        const id = await rawCreate(name, kind);
        // All 25 for an ordinary thought, a handful for a type and a tag.
        const blanks = kind === ThoughtKind.Normal ? BLANK : ["", " ", "\u00a0", "\u0085", "\u3000\t"];
        // And null, and a `replace` that carries no value at all.
        for (const blank of [...blanks, null, undefined]) {
          expect(await answer(rawRename(id, blank)), `kind ${kind}, ${hex(blank ?? "none")}`).toBe(
            "accepted",
          );
        }
        // A rename reads back within 0.2 s: one that had gone through would show.
        await settle(500);
        expect(await nameOf(id), `kind ${kind}`).toBe(name);
        expect(await logged(id), `kind ${kind}`).toEqual([`101 ${JSON.stringify(name)}`]);
      }
    }, 60_000);

    it("only replace is taken for a name: remove and add are a 400", async () => {
      const id = await make("name-ops");
      for (const op of [
        { op: "remove", path: "/name" },
        { op: "add", path: "/name", value: `${PREFIX}added` },
      ] as const) {
        expect(
          await answer(api.client.patch(`/api/thoughts/${brainId}/${id}`, { jsonPatch: [op] })),
          op.op,
        ).toBe("400 bad_request: Only 'replace' operation is allowed for 'name' path.");
      }
      expect(await nameOf(id)).toBe(`${PREFIX}name-ops`);
    });

    it("a name of one character that does not show is stored as it was given, by a create and by a rename", async () => {
      for (const kind of [ThoughtKind.Normal, ThoughtKind.Type]) {
        const renamed = await rawCreate(`${PREFIX}name-unseen-${kind}`, kind);
        for (const name of UNSEEN) {
          const where = `kind ${kind}, ${hex(name)}`;
          // Not white space, so the server does not refuse it either.
          expect(nameRefusal(name, "name"), where).toBeNull();
          expect(thoughtNameAsStored(name), where).toBe(name);

          const made = await rawCreate(name, kind);
          expect(await nameOf(made), where).toBe(name);
          expect(await logged(made), where).toEqual([`101 ${JSON.stringify(name)}`]);

          await rawRename(renamed, name);
          expect(await renamedTo(renamed, name), where).toBe(name);
        }
        // Left under a name the sweep of leftovers can find.
        await rawRename(renamed, `${PREFIX}name-unseen-${kind}`);
      }
    }, 60_000);

    it("a name is stored with a tab and a line feed as spaces and no white space at its ends, by a create as by a rename", async () => {
      const n = `${PREFIX}name`;
      const samples = [
        `  ${n} padded  `,
        `\t${n} tabs\t`,
        `\r\n${n} crlf\r\n`,
        // No white space, so kept: a byte order mark, a zero width space, a control.
        `\ufeff${n} bom\ufeff`,
        `\u200b${n} zero width\u200b`,
        `\u001c${n} control\u001f`,
        ` \u200b${n} both `,
        // Inside a name only a tab and a line feed change.
        `${n} tab\tinside`,
        `${n} line\nbreak`,
        `${n} crlf\r\nbreak`,
        `${n} cr\rinside`,
        `${n} two  spaces`,
        `${n} nbsp\u00a0inside`,
        `${n} next\u0085line`,
        `${n} separator\u2028inside`,
        `${n} a \n b`,
        // Each white space code point at both ends.
        ...WHITE_SPACE.map((c, i) => `${c}${n} ws-${i}${c}`),
      ];
      // A thought of its own to rename for each, every one renamed before
      // any is read back: the waits run side by side, and an app slow to
      // read a rename back costs the test that once, not 41 times.
      const renamed: string[] = [];
      for (const sent of samples) {
        const stored = thoughtNameAsStored(sent);
        const made = await rawCreate(sent);
        expect(await nameOf(made), hex(sent)).toBe(stored);
        // The log has the name as it is stored, too.
        expect(await logged(made), hex(sent)).toEqual([`101 ${JSON.stringify(stored)}`]);

        const target = await make(`name-stored-${renamed.length}`);
        await rawRename(target, sent);
        renamed.push(target);
      }
      for (const [i, sent] of samples.entries()) {
        const stored = thoughtNameAsStored(sent);
        expect(await renamedTo(renamed[i]!, stored), hex(sent)).toBe(stored);
      }
      // What `trim()` would have made of two of them is not what is stored.
      expect(thoughtNameAsStored(`\u0085${n}\u0085`)).toBe(n);
      expect(thoughtNameAsStored(`\ufeff${n}`)).toBe(`\ufeff${n}`);
    }, 120_000);

    it("a rename to the name a thought has, in other white space, is a 200 that logs nothing", async () => {
      const name = `${PREFIX}name same`;
      const id = await rawCreate(name);
      for (const again of [name, `${name} `, `\t${name}\n`, `\u00a0${name}\u3000`, name.replace(" same", "\nsame")]) {
        expect(thoughtNameAsStored(again), hex(again)).toBe(name);
        await rawRename(id, again);
      }
      await settle(500);
      expect(await nameOf(id)).toBe(name);
      expect(await logged(id)).toEqual([`101 ${JSON.stringify(name)}`]);
      // Another name is logged, with the old one beside it. Case alone is another name.
      await rawRename(id, name.toUpperCase());
      await renamedTo(id, name.toUpperCase());
      expect(await logged(id)).toEqual([
        `101 ${JSON.stringify(name)}`,
        `103 ${JSON.stringify(name)}→${JSON.stringify(name.toUpperCase())}`,
      ]);
    }, 30_000);

    it("a name of 1,024 UTF-16 units is kept whole, and of a longer one the first 1,024, with a 200", async () => {
      const long = (units: number, tail = ""): string => {
        const head = `${PREFIX}name-long-`;
        return head + "a".repeat(units - head.length - tail.length) + tail;
      };
      const renamed = await make("name-long-renamed");
      for (const [sent, kept] of [
        [long(1024), long(1024)],
        [long(1025), long(1025).slice(0, 1024)],
        [long(4000), long(4000).slice(0, 1024)],
        // Units, not characters or bytes: an emoji is two, a Cyrillic letter one.
        [long(1026, "яяя"), long(1026, "яяя").slice(0, 1024)],
        [long(1026, "🧠🧠"), long(1026, "🧠🧠").slice(0, 1024)],
        // The ends are dropped before the cut, so they are not counted,
        [`  ${long(1024)}\n`, long(1024)],
        // and nothing is dropped after it: this one is stored ending in a space.
        [`${long(1023)} b`, `${long(1023)} `],
        // A cut that falls inside an emoji leaves U+FFFD for its first half.
        [long(1025, "🧠"), `${long(1025, "🧠").slice(0, 1023)}\ufffd`],
      ] as const) {
        const where = `${sent.length} units`;
        expect(kept.length, where).toBeLessThanOrEqual(1024);
        const made = await rawCreate(sent);
        expect(await nameOf(made), where).toBe(kept);

        await rawRename(renamed, sent);
        expect(await renamedTo(renamed, kept), where).toBe(kept);
        // The server refuses exactly the ones that are cut.
        expect(nameRefusal(sent, "name") === null, where).toBe(thoughtNameAsStored(sent) === kept);
      }
      // The log keeps less of a name: the first 140 units.
      const made = await rawCreate(long(1024));
      expect(await logged(made)).toEqual([`101 ${JSON.stringify(long(1024).slice(0, 140))}`]);
    }, 60_000);

    it("a plan thought sent with a tab or white space around its name is found by the name it was stored by", async () => {
      // Looked for as it was sent, each of these was made again by every run
      // of the plan (1 of 1 each, through the tool as it was).
      const root = await make("name-plan-root");
      const names = [`${PREFIX}plan tab\tinside`, `${PREFIX}plan line\nbreak`, `\u0085${PREFIX}plan next line\u0085`];
      const plan = {
        thoughts: names.map((name, i) => ({ tempId: `t${i}`, name, parent: root })),
      };
      const first = await ingest(api, brainId, plan);
      created.push(...first.created.map((c) => c.thoughtId));
      expect(first.failures).toEqual([]);
      expect(first.created).toHaveLength(3);

      const second = await ingest(api, brainId, plan);
      created.push(...second.created.map((c) => c.thoughtId));
      expect(second.created).toEqual([]);
      expect(second.reused.map((r) => r.thoughtId).sort()).toEqual(
        first.created.map((c) => c.thoughtId).sort(),
      );
      const graph = await api.thoughts.getGraph(brainId, root);
      expect(graph.children.map((c) => c.name).sort()).toEqual(names.map(thoughtNameAsStored).sort());
    }, 30_000);

    it("the resource refuses a name the API would not store as asked, and sends nothing", async () => {
      const id = await make("name-refused");
      for (const name of ["", " ", "\u00a0", "\u0085", "a".repeat(1025)]) {
        await expect(api.thoughts.update(brainId, id, { name }), hex(name.slice(0, 4))).rejects.toMatchObject({
          kind: "bad_request",
          status: undefined,
        });
        await expect(api.thoughts.create(brainId, { name }), hex(name.slice(0, 4))).rejects.toMatchObject({
          kind: "bad_request",
          status: undefined,
        });
      }
      expect(await nameOf(id)).toBe(`${PREFIX}name-refused`);
      expect(await logged(id)).toEqual([`101 ${JSON.stringify(`${PREFIX}name-refused`)}`]);
    });
  });

  /**
   * Measured on TheBrain 15.0.640. Most of it is what the OpenAPI description
   * says; the read-back delay and the keying of the log entry are not in it.
   * How aliases read when there are none is in test/integration.test.ts, for
   * the home thought, and in *every thought a graph lists…*, for a graph.
   */
  describe("aliases", () => {
    let supported: boolean | undefined;
    /** Builds before 15.0.621 have no aliases; there is nothing to test on them. */
    const requireAliases = async (ctx: TestContext): Promise<void> => {
      if (supported === undefined) {
        const probe = await api.thoughts.get(brainId, await make("alias-probe"));
        supported = "aliases" in probe;
      }
      if (!supported) ctx.skip();
    };

    const makeWith = async (name: string, aliases: string[]): Promise<string> => {
      const id = await api.thoughts.create(brainId, { name: PREFIX + name, aliases });
      created.push(id);
      return id;
    };
    const stored = (id: string, ok: (aliases: string[]) => boolean): Promise<string[]> =>
      eventually(
        async () => aliasesOf(await api.thoughts.get(brainId, id)),
        ok,
      );
    const sameSet = (expected: string[]) => (aliases: string[]): boolean =>
      [...aliases].sort().join("\n") === [...expected].sort().join("\n");
    const patch = (id: string, op: "add" | "replace" | "remove", path: string, value?: unknown) =>
      api.client.patch(`/api/thoughts/${brainId}/${id}`, {
        jsonPatch: [{ op, path, ...(value === undefined ? {} : { value }) }],
      });

    it("a renamed thought keeps its old name as an alias, sent before the new name reads back", async (ctx) => {
      await requireAliases(ctx);
      // Measured: the read between the rename and the alias still had the old
      // name 19 times of 20, and the API kept the alias 20 times of 20. An
      // alias edit that compared with that read dropped it as the name's own:
      // through brain_update_thought the old name was lost 10 times of 10.
      const old = `${PREFIX}alias-renamed-from`;
      const renamed = `${PREFIX}alias-renamed-to`;
      const id = await makeWith("alias-renamed-from", []);
      await settle(300);

      await api.thoughts.update(brainId, id, { name: renamed });
      const outcome = await api.thoughts.changeAliases(
        brainId,
        id,
        { add: [old, renamed] },
        { name: renamed },
      );
      // The new name is the one an alias cannot repeat.
      expect(outcome.added).toEqual([old]);

      expect(await stored(id, sameSet([old]))).toEqual([old]);
      expect((await api.thoughts.get(brainId, id)).name).toBe(renamed);
    });

    it("aliases given at creation are stored, and the graph carries them too", async (ctx) => {
      await requireAliases(ctx);
      // Not asserted as immediate, because it is not quite: over 60 creations
      // the thought itself read back at once every time, and 3 times without
      // its aliases, which followed within 0.15 s. A single try says "at once".
      const wanted = [`${PREFIX}alias-one`, `${PREFIX}alias-two`];
      const id = await makeWith("alias-create", wanted);

      expect(await stored(id, sameSet(wanted))).toEqual(wanted);
      const graph = await api.thoughts.getGraph(brainId, id);
      expect(aliasesOf(graph.thought)).toEqual(wanted);
    });

    it("replace and add both set the whole list, and remove clears it", async (ctx) => {
      await requireAliases(ctx);
      const id = await makeWith("alias-patch", [`${PREFIX}first`]);

      await patch(id, "replace", "/aliases", [`${PREFIX}second`]);
      expect(await stored(id, sameSet([`${PREFIX}second`]))).toEqual([`${PREFIX}second`]);

      // `add` does not append: it sets the list, as `replace` does.
      await patch(id, "add", "/aliases", [`${PREFIX}third`]);
      expect(await stored(id, sameSet([`${PREFIX}third`]))).toEqual([`${PREFIX}third`]);

      await patch(id, "remove", "/aliases");
      expect(await stored(id, (a) => a.length === 0)).toEqual([]);

      // The flat facade the tools use, both ways.
      await api.thoughts.update(brainId, id, { aliases: [`${PREFIX}fourth`] });
      expect(await stored(id, sameSet([`${PREFIX}fourth`]))).toEqual([`${PREFIX}fourth`]);
      await api.thoughts.update(brainId, id, { aliases: [] });
      expect(await stored(id, (a) => a.length === 0)).toEqual([]);
    });

    it("an element path is refused and leaves the list alone", async (ctx) => {
      await requireAliases(ctx);
      const before = [`${PREFIX}kept`];
      const id = await makeWith("alias-element", before);
      await stored(id, sameSet(before));

      for (const [op, path] of [
        ["replace", "/aliases/0"],
        ["add", "/aliases/-"],
        ["remove", "/aliases/0"],
      ] as const) {
        const refused = await patch(
          id,
          op,
          path,
          op === "remove" ? undefined : `${PREFIX}other`,
        ).catch((error: unknown) => error);
        expect(refused, `${op} ${path}`).toBeInstanceOf(TheBrainError);
        expect((refused as TheBrainError).kind, `${op} ${path}`).toBe("bad_request");
      }
      await settle();
      expect(aliasesOf(await api.thoughts.get(brainId, id))).toEqual(before);
    });

    it("aliases are trimmed, deduplicated ignoring case, and dropped when equal to the name", async (ctx) => {
      await requireAliases(ctx);
      const name = `${PREFIX}alias-rules`;
      const id = await make("alias-rules");
      await api.thoughts.update(brainId, id, {
        aliases: [`  ${PREFIX}Spaced  `, `${PREFIX}spaced`, name, `${PREFIX}other`],
      });

      // Of two spellings the first survives, and the order is kept.
      expect(await stored(id, (a) => a.length > 0)).toEqual([`${PREFIX}Spaced`, `${PREFIX}other`]);

      // The name is dropped in another case too, which the spec does not say.
      // `changeAliases` relies on it to tell that such an alias changes nothing.
      await api.thoughts.update(brainId, id, {
        aliases: [name.toUpperCase(), `${PREFIX}another`],
      });
      expect(await stored(id, sameSet([`${PREFIX}another`]))).toEqual([`${PREFIX}another`]);
    });

    it(`a list longer than ${MAX_ALIASES} keeps its first ${MAX_ALIASES}, with no error`, async (ctx) => {
      await requireAliases(ctx);
      const id = await make("alias-cap");
      const many = Array.from({ length: MAX_ALIASES + 5 }, (_, i) => `${PREFIX}cap-${i}`);
      // Through the client: `changeAliases` refuses a list this long itself,
      // because the API cuts it without saying so.
      await patch(id, "replace", "/aliases", many);

      expect(await stored(id, (a) => a.length > 0)).toEqual(many.slice(0, MAX_ALIASES));
    });

    it("an alias change is logged as 211 against the thought itself", async (ctx) => {
      await requireAliases(ctx);
      // The semantic index re-embeds a thought on this entry. It finds the
      // thought through `logThoughtId`, which reads `sourceId` for everything
      // but notes. Notes once taught this project not to assume that.
      const id = await make("alias-log");
      await api.thoughts.update(brainId, id, { aliases: [`${PREFIX}logged`] });

      const mentions = (l: ModificationLogDto): boolean =>
        l.modType === ModType.AliasesChanged && [l.sourceId, l.extraAId, l.extraBId].includes(id);
      const logs = await eventually(
        () => newestLogs(200),
        (entries) => entries.some(mentions),
      );
      // Found by code and by the id in any position, so a failure below shows
      // how the entry is really keyed.
      const event = logs.find(mentions);
      expect(event, "no 211 entry mentions the thought").toBeDefined();
      expect({ sourceType: event!.sourceType, sourceId: event!.sourceId }).toEqual({
        sourceType: EntityType.Thought,
        sourceId: id,
      });
      expect(event!.extraAType).toBe(EntityType.Unknown);
      expect(logThoughtId(event!)).toBe(id);
      expect(subjectIds(event!)).toEqual([id]);
      expect(describeChange(event!)).toBe("aliases changed");

      // A thought created with aliases logs its own 211 after the `created`.
      const born = await makeWith("alias-log-born", [`${PREFIX}born`]);
      const later = await eventually(
        () => newestLogs(200),
        (entries) =>
          entries.some((l) => l.modType === ModType.AliasesChanged && l.sourceId === born),
      );
      const kinds = later.filter((l) => l.sourceId === born).map((l) => l.modType);
      expect(kinds.sort()).toEqual([ModType.Created, ModType.AliasesChanged]);
    }, 30_000);

    it("changeAliases adds to a stored list and removes from it", async (ctx) => {
      await requireAliases(ctx);
      const id = await makeWith("alias-change", [`${PREFIX}kept`, `${PREFIX}gone`]);
      await stored(id, (a) => a.length === 2);

      const outcome = await api.thoughts.changeAliases(brainId, id, {
        add: [`${PREFIX}new`, `${PREFIX}KEPT`],
        remove: [`${PREFIX}GONE`],
      });
      expect(outcome.added).toEqual([`${PREFIX}new`]);
      expect(outcome.removed).toEqual([`${PREFIX}gone`]);

      const wanted = [`${PREFIX}kept`, `${PREFIX}new`];
      expect((await stored(id, sameSet(wanted))).sort()).toEqual(wanted);
      // What it reported is what the API holds.
      expect([...outcome.aliases].sort()).toEqual(wanted);
    });

    it("a read straight after a write usually still returns the old list", async (ctx) => {
      await requireAliases(ctx);
      // Measured over 82 writes: the first read already had the new list 7
      // times; otherwise it showed up 50–100 ms later, 0.2 s at the most. A
      // rename behaves the same. Again on 2026-10-14, 40 writes each: the new
      // list at once 2 times with the app to itself and 2 with another
      // contract run at work in it. It writes until one first read has the
      // old list, forty at the most, which seven reads in ten with the new
      // one would fail one run in a million.
      const TRIES = 40;
      const id = await make("alias-lag");
      let previous: string[] = [];
      let stale = -1;
      for (let i = 0; i < TRIES && stale < 0; i++) {
        const next = [`${PREFIX}lag-${i}`];
        await api.thoughts.update(brainId, id, { aliases: next });
        const atOnce = aliasesOf(await api.thoughts.get(brainId, id));
        if (sameSet(previous)(atOnce)) stale = i;
        else expect(atOnce).toEqual(next);
        expect(await stored(id, sameSet(next))).toEqual(next);
        previous = next;
      }
      expect(
        stale,
        `the new list read back at once ${TRIES} times of ${TRIES}: either the app was busy at ` +
          "every one of them, or a read is no longer behind a write of aliases",
      ).toBeGreaterThanOrEqual(0);
    }, 60_000);

    it("two changeAliases calls in a row both land", async (ctx) => {
      await requireAliases(ctx);
      // Without the wait inside `changeAliases` the second call reads the old,
      // empty list and writes only its own alias: measured, the first was lost.
      const id = await make("alias-twice");
      const first = await api.thoughts.changeAliases(brainId, id, { add: [`${PREFIX}one`] });
      const second = await api.thoughts.changeAliases(brainId, id, { add: [`${PREFIX}two`] });

      expect(first.readBack).toBe(true);
      expect(second.readBack).toBe(true);
      // No waiting here: by the time the call returned, a read agreed.
      expect(aliasesOf(await api.thoughts.get(brainId, id))).toEqual([
        `${PREFIX}one`,
        `${PREFIX}two`,
      ]);
    });

    it("TheBrain's own search finds a thought by an alias", async (ctx) => {
      await requireAliases(ctx);
      // The tool descriptions and the skills say so, on the spec's word. The
      // search is prefix-based, and a new thought is in its index at the next
      // refresh, 3.7 to 5.5 s after the create.
      const alias = `${PREFIX}aka${Date.now()}`;
      const id = await makeWith("alias-search", [alias]);

      const hits = await eventually(
        () => api.search.inBrain(brainId, alias, { maxResults: 10 }),
        (found) => found.some((h) => h.thought.id === id),
        { timeoutMs: 25_000, stepMs: 500 },
      );
      expect(hits.map((h) => h.thought.id)).toContain(id);
    }, 40_000);
  });
});
