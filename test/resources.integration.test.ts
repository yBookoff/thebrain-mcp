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
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";

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
  logEntryKey,
  logTime,
  replayThoughtIds,
  type CleanGraph,
  type LinkDto,
  type ModificationLogDto,
  type ThoughtDto,
} from "../src/api/index.js";
import { describeChange, subjectIds } from "../src/operations/changes.js";
import { ingest } from "../src/operations/ingest.js";
import type { Embedder } from "../src/semantic/embedder.js";
import {
  SemanticIndexer,
  isNoteMod,
  linkEndIds,
  logThoughtId,
  neighbourIds,
} from "../src/semantic/indexer.js";
import { VectorStore } from "../src/semantic/store.js";

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

suite("resource layer against the live API", () => {
  let api: TheBrainApi;
  let brainId: string;
  const created: string[] = [];

  const make = async (name: string, kind: number = ThoughtKind.Normal): Promise<string> => {
    const id = await api.thoughts.create(brainId, { name: PREFIX + name, kind });
    created.push(id);
    return id;
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
    const stats = await api.brains.statistics(brainId);
    if (stats.thoughts > MAX_THOUGHTS_IN_TEST_BRAIN) {
      throw new Error(
        `brain "${stats.brainName}" holds ${stats.thoughts} thoughts, which does ` +
          `not look like a throwaway test brain. These tests write, so refusing. ` +
          `Create a separate brain and point THEBRAIN_TEST_BRAIN_ID at it.`,
      );
    }
  });

  afterAll(async () => {
    for (const id of created) {
      await api.thoughts.delete(brainId, id).catch(() => undefined);
    }

    // Sweep up debris from earlier failed runs. The API has no "list all"
    // endpoint, but everything these tests create is in the log.
    const leftovers: string[] = [];
    for (const id of replayThoughtIds(await api.brains.allModifications(brainId))) {
      const t = await api.thoughts.get(brainId, id).catch(() => null);
      if (t?.name?.startsWith(PREFIX)) leftovers.push(id);
    }
    for (const id of leftovers) {
      await api.thoughts.delete(brainId, id).catch(() => undefined);
    }
    if (leftovers.length > 0) {
      console.warn(`[cleanup] removed leftovers from earlier runs: ${leftovers.length}`);
    }
  }, 60_000);

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
      () => api.brains.modifications(brainId, { maxLogs: 200 }),
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

  describe("a run of note changes in the log", () => {
    // Measured on TheBrain 15.0.640: the log is not append-only. While a
    // note's 803 is the newest entry TheBrain has logged, the next change to
    // the note takes that entry out and files it again under the new time.
    // "Newest" counts every brain the app holds: an entry logged in another
    // brain ends the run as surely as one in this brain. So a run here can be
    // cut short by someone working in TheBrain meanwhile, and each test that
    // needs a whole run tries again when another brain got in the way.
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
      write: () => Promise<void>,
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

    /** Whether any other brain logged an entry between two entries of this one. */
    const loggedElsewhere = async (
      after: ModificationLogDto,
      before: ModificationLogDto,
    ): Promise<boolean> => {
      for (const brain of await api.brains.list()) {
        if (brain.id === brainId) continue;
        const range = await api.brains.modifications(brain.id, {
          maxLogs: 10,
          since: logTime(after),
          until: logTime(before),
        });
        const inside = (l: ModificationLogDto): boolean =>
          compareLogTime(logTime(l), logTime(after)) > 0 &&
          compareLogTime(logTime(l), logTime(before)) < 0;
        if (range.some(inside)) return true;
      }
      return false;
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
            expect(await loggedElsewhere(previous, moved), what).toBe(true);
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
        const [top] = await api.brains.modifications(brainId, { maxLogs: 1 });
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
      const store = new VectorStore(":memory:");
      const indexer = new SemanticIndexer(api, store, embedder);
      await indexer.rebuild(brainId);

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
        if (!moved) expect(await loggedElsewhere(passed, now.at(-1)!)).toBe(true);
        changes = now;
        await eventually(
          () => api.notes.get(brainId, id),
          (t) => t.includes(word),
        );

        const from = documents.length;
        await indexer.sync(brainId);
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
      () => api.brains.modifications(brainId, { maxLogs: 200 }),
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
      () => api.brains.modifications(brainId, { maxLogs: 200 }),
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
        () => api.brains.modifications(brainId, { maxLogs: 300 }),
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
      const store = new VectorStore(":memory:");
      const indexer = new SemanticIndexer(api, store, embedder);
      await indexer.rebuild(brainId);

      /** What sync embeds once the thought's graph shows the change. */
      const embeddedAfter = async (
        change: () => Promise<unknown>,
        shown: (graph: CleanGraph) => boolean,
      ): Promise<string[]> => {
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
      const store = new VectorStore(":memory:");
      const indexer = new SemanticIndexer(api, store, embedder);
      await indexer.rebuild(brainId);
      const from = documents.length;

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

  it("the log returns the newest entries first and truncates at maxLogs", async () => {
    // brain_recent_changes filters out settings before applying its limit
    // because of this: the newest entries can all be settings.
    for (const n of [1, 2, 3]) await make(`log-order-${n}`);
    const last = await make("log-order-4");
    // Both reads below must see the same log, so wait for the last write.
    await eventually(
      () => api.brains.modifications(brainId, { maxLogs: 50 }),
      (entries) => entries.some((l) => l.sourceId === last),
    );

    const newestFirst = (x: string, y: string): number => compareLogTime(y, x);
    const all = await api.brains.allModifications(brainId);
    const few = await api.brains.modifications(brainId, { maxLogs: 3 });

    expect(all.length).toBeGreaterThan(3);
    expect(few).toHaveLength(3);
    const newest = all.map(logTime).sort(newestFirst).slice(0, 3);
    expect(few.map(logTime).sort(newestFirst)).toEqual(newest); // truncation keeps the newest
    expect(few.map(logTime)).toEqual(newest); // and returns them newest first
  }, 30_000);

  /** Creates a thought and returns its `created` log entry. */
  const createdEntry = async (name: string): Promise<ModificationLogDto> => {
    const id = await make(name);
    const logs = await eventually(
      () => api.brains.modifications(brainId, { maxLogs: 50 }),
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
      (await api.brains.modifications(brainId, { maxLogs: 5, until })).some(
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
    const within = async (range: { since?: string; until?: string }): Promise<boolean> =>
      (await api.brains.modifications(brainId, { maxLogs: 1000, ...range })).some(
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
    const newest = (): Promise<ModificationLogDto[]> =>
      api.brains.modifications(brainId, { maxLogs: 10_000 });
    const late = (l: ModificationLogDto): boolean =>
      compareLogTime(l.modificationDateTime, l.creationDateTime) > 0;
    let logs = await newest();
    // A new brain may hold none yet. Three hundred creates gave three.
    for (let round = 0; !logs.some(late) && round < 10; round++) {
      const ids = new Set(
        await Promise.all(Array.from({ length: 100 }, (_, i) => make(`log-late-${round}-${i}`))),
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
      (await api.brains.modifications(brainId, { maxLogs: 1000, ...range })).some(
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
    // median and 11 at the most. Hence the three rounds.
    const BURST = 100;
    const since = new Date().toISOString();
    let tied = false;
    for (let round = 0; round < 3 && !tied; round++) {
      await Promise.all(Array.from({ length: BURST }, (_, i) => make(`log-tie-${round}-${i}`)));
      const burst = await eventually(
        () => api.brains.modifications(brainId, { maxLogs: 10_000, since }),
        (entries) => entries.length >= BURST * (round + 1),
      );
      const times = burst.map(logTime);
      tied = new Set(times).size < times.length;
    }
    expect(tied).toBe(true);

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
    const recent = await api.brains.modifications(brainId, { maxLogs: 1_000 });
    const from = logTime(recent.at(-1)!);
    sameEntries(
      await api.brains.allModifications(brainId, { since: from, pageSize: 25 }),
      await api.brains.modifications(brainId, { maxLogs: 10_000, since: from }),
    );
  }, 90_000);

  it("a page that ends on an entry filed after its creation keeps the one filed beside it", async (ctx) => {
    // What the first pager lost. It took a page's oldest creationDateTime as
    // the next endTime, and a range that ends there leaves out whatever was
    // filed later. That takes an entry filed a microsecond after its creation
    // and listed just ahead of one filed in that same microsecond: 6 pairs
    // among 68,967 entries of two test brains, all from concurrent creates,
    // about one burst of 100 in twelve. The comparisons above do not show it
    // unless a page happens to end on such a pair: with a copy of that pager
    // they came out equal, at pages of 2 and of 25, over ranges that held one.
    // A pair cannot be had to order: a burst gives one in twelve, and a note
    // changed alongside a burst was filed at its creation 8 times of 8. So
    // this looks for the nearest and ends a page on it. A log with none in
    // its newest 50,000 entries cannot show it, and that many is all this
    // reads, however long the log.
    const WINDOW = 50_000;
    const newest = await api.brains.modifications(brainId, { maxLogs: WINDOW });
    const at = newest.findIndex((entry, i) => {
      const next = newest[i + 1];
      return next !== undefined && compareLogTime(logTime(next), entry.creationDateTime) > 0;
    });
    if (at < 0) ctx.skip("no entry filed between another's creation and its filing");
    const last = newest[at]!;
    const since = logTime(newest[at + 1]!);

    const whole = await api.brains.modifications(brainId, { maxLogs: 2 * WINDOW, since });
    const pages: ModificationLogDto[][] = [];
    for await (const page of api.brains.modificationPages(brainId, { since, pageSize: at + 1 })) {
      pages.push(page);
    }
    // The first page ends where it was aimed, on the entry filed late...
    expect(logEntryKey(pages[0]!.at(-1)!)).toBe(logEntryKey(last));
    // ...and the next one still brings its neighbour.
    sameEntries(pages.flat(), whole);
  }, 30_000);

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

  it("type and tag lists never throw on any brain", async () => {
    for (const brain of await api.brains.list()) {
      await expect(api.thoughts.listTypes(brain.id)).resolves.toBeInstanceOf(Array);
      await expect(api.thoughts.listTags(brain.id)).resolves.toBeInstanceOf(Array);
    }
  });

  it("the log reconstructs contents that agree with statistics", async () => {
    // Holds for a brain whose thoughts were all created in it, like a test
    // brain. Imported and old brains fall short, which is why a rebuild also
    // walks the graph (ARCHITECTURE.md §7).
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

    const stats = await api.brains.statistics(brainId);
    expect(normal).toBe(Math.round(stats.thoughts));
    expect(types).toBe(Math.round(stats.thoughtTypes));
  });

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

      const ROUNDS = 5;
      let listedAtOnce = 0;
      for (let i = 0; i < ROUNDS; i++) {
        const url = `https://example.com/${PREFIX}lag-${Date.now()}-${i}`;
        await attach(id, url);
        expect(await found(url)).toBe(true);

        const listed = async (): Promise<boolean> => (await locations(id)).includes(url);
        if (await listed()) listedAtOnce += 1;
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
      // had none at once, 14 had one and 1 had two. All five at once is one
      // run in a million.
      expect(listedAtOnce).toBeLessThan(ROUNDS);
    });

    it("attachUrl finds the copy under another host case, and tells paths apart", async () => {
      const id = await make("attach-dedupe");
      const stored = `https://Example.com/${PREFIX}dedupe-${Date.now()}/Page`;
      const add = (url: string) =>
        api.attachments.attachUrl(brainId, id, url, { name: `${PREFIX}link` });

      expect((await add(stored)).created).toBe(true);
      // The same spelling straight away: by-location has it already.
      expect((await add(stored)).created).toBe(false);

      // Another spelling of the host is found in the thought's list.
      await eventually(
        () => locations(id),
        (all) => all.includes(stored),
      );
      const again = await add(stored.replace("https://Example.com", "http://example.com") + "/");
      expect(again.created).toBe(false);
      expect(again.existing?.location).toBe(stored);

      expect((await add(stored.replace("/Page", "/page"))).created).toBe(true);
      const all = await eventually(
        () => locations(id),
        (list) => list.length >= 2,
      );
      expect(all).toHaveLength(2);
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
        () => api.brains.modifications(brainId, { maxLogs: 200 }),
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
      const typeId = await make("lag-type", ThoughtKind.Type);
      let stale = 0;
      for (let i = 0; i < 5; i++) {
        const id = await makeWith(`lag-typed-${i}`, { typeId });
        await read(id, (t) => t.typeId === typeId);
        expect(await api.links.detachType(brainId, id, typeId)).toBe(true);
        if ((await api.thoughts.get(brainId, id)).typeId === typeId) stale += 1;
        expect((await read(id, (t) => t.typeId === null)).typeId).toBeNull();
      }
      expect(stale).toBeGreaterThan(0);
    }, 30_000);

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
        () => api.brains.modifications(brainId, { maxLogs: 50 }),
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
      const typeId = await make("lag-set-type", ThoughtKind.Type);
      let stale = 0;
      for (let i = 0; i < 8; i++) {
        const id = await make(`lag-set-${i}`);
        expect(await patchType(id, typeId)).toBeNull();
        if ((await typeOf(id)) === null) stale += 1;
        const seen = await eventually(
          () => typeOf(id),
          (t) => t === typeId,
        );
        expect(seen).toBe(typeId);
      }
      expect(stale).toBeGreaterThan(0);
    }, 30_000);

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
          while (next < 150) await make(`burst-${next++}`);
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

    it("a thought created under one type with another for its typeId carries both, and its graph can name the wrong one", async () => {
      const older = await make("both-types-older", ThoughtKind.Type);
      const newer = await make("both-types-newer", ThoughtKind.Type);
      const graphTypes: Array<string | undefined> = [];

      for (const [under, typeId] of [
        [older, newer],
        [newer, older],
      ] as const) {
        const id = await rawUnder("both-types", { sourceThoughtId: under, typeId });
        // `typeId` is the one the request called so, from the first read on.
        expect((await api.thoughts.get(brainId, id)).typeId).toBe(typeId);
        const graph = await graphOf(id, (g) => g.links.length === 2);
        expect(graph.links.map((l) => [l.thoughtIdA, l.meaning]).sort()).toEqual(
          [
            [under, LinkMeaning.Type],
            [typeId, LinkMeaning.Type],
          ].sort(),
        );
        // The other type is left among the parents: only `typeId` is filtered.
        expect(ids(graph.parents)).toEqual([under]);
        graphTypes.push(graph.type?.id);

        // Taking the type away, as `removeType` does, leaves the other one's
        // link and a thought that reads as having no type.
        expect(await api.links.detachType(brainId, id, typeId)).toBe(true);
        const bare = await eventually(
          () => api.thoughts.get(brainId, id),
          (t) => t.typeId === null,
        );
        expect(bare.typeId).toBeNull();
        expect(isTypeLink((await api.links.between(brainId, under, id))!)).toBe(true);
      }

      // `graph.type` named the same type both times, so once it was not the
      // thought's `typeId`.
      expect(graphTypes[0]).toBe(graphTypes[1]);
      expect([older, newer]).toContain(graphTypes[0]);
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

    it("only a type is refused: under a tag a thought is created tagged, and nobody's identifier is the API's to answer", async () => {
      const tagId = await make("np-tag", ThoughtKind.Tag);
      const id = await api.thoughts.create(brainId, {
        name: `${PREFIX}np-under-tag`,
        sourceThoughtId: tagId,
      });
      created.push(id);

      const graph = await graphOf(id, (g) => g.tags.length === 1);
      expect(ids(graph.tags)).toEqual([tagId]);
      expect(graph.parents).toEqual([]);
      expect(isTagLink((await api.links.between(brainId, id, tagId))!)).toBe(true);

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
        ],
      });
      for (const c of outcome.created) created.push(c.thoughtId);

      expect(outcome.reused.map((r) => r.thoughtId)).toEqual([held]);
      expect(outcome.created).toEqual([]);
      expect(outcome.failures).toHaveLength(1);
      expect(outcome.failures[0]!.reason).toMatch(/^sourceThoughtId \S+ cannot be a parent: it is the type/);
      await settle();
      expect((await api.thoughts.getGraph(brainId, held)).children).toEqual([]);
    });
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

    it("a tag attached to a tag is a link of meaning 7, and stands among the tag's parents as well as its tags", async () => {
      const upper = await make("nt-upper-tag", ThoughtKind.Tag);
      const lower = await make("nt-lower-tag", ThoughtKind.Tag);

      const linkId = await api.links.attachTag(brainId, lower, upper);
      const graph = await graphOf(lower, (g) => ids(g.tags).includes(upper));
      expect(ids(graph.tags)).toEqual([upper]);
      expect(ids(graph.parents)).toEqual([upper]);
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

      // Posted from the upper tag's side it is the same link again.
      await api.links.create(brainId, {
        thoughtIdA: upper,
        thoughtIdB: lower,
        relation: Relation.Child,
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
          (await api.brains.modifications(brainId, { maxLogs: 50 })).find(
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

      // Accepted, with nothing to show for it.
      await api.links.update(brainId, id, { relation: Relation.Sibling });
      await settle();
      const still = await api.links.get(brainId, id);
      expect(still.direction).toBe(0);
      expect(ends(still)).toEqual([Relation.Jump, a, b]);

      await api.links.update(brainId, id, { relation: Relation.Child });
      expect(ends(await read(id, (l) => l.relation === Relation.Child))).toEqual([
        Relation.Child,
        a,
        b,
      ]);
      // A parent is stored as a child link the other way round, so the same
      // patch sent again puts the ends back.
      await api.links.update(brainId, id, { relation: Relation.Parent });
      expect(ends(await read(id, (l) => l.thoughtIdA === b))).toEqual([Relation.Child, b, a]);
      await api.links.update(brainId, id, { relation: Relation.Parent });
      expect(ends(await read(id, (l) => l.thoughtIdA === a))).toEqual([Relation.Child, a, b]);
      // And the sibling that changed a jump into nothing does as much for a child.
      await api.links.update(brainId, id, { relation: Relation.Sibling });
      await settle();
      expect(ends(await api.links.get(brainId, id))).toEqual([Relation.Child, a, b]);

      await api.links.update(brainId, id, { relation: Relation.Jump });
      expect(ends(await read(id, (l) => l.relation === Relation.Jump))).toEqual([
        Relation.Jump,
        a,
        b,
      ]);
    }, 30_000);

    it("a read straight after a link is patched still returns the old value", async () => {
      // Measured over 360 patches, thirty each of twelve kinds: a name, a
      // colour, a thickness, a direction and a relation, set or cleared. Not one
      // was there on the first read. They showed 6–205 ms later, about 100 ms
      // at the median.
      const { id } = await linked("link-lag");
      let stale = 0;
      for (let i = 0; i < 5; i++) {
        const name = `lag ${i}`;
        await api.links.update(brainId, id, { name });
        if ((await api.links.get(brainId, id)).name !== name) stale += 1;
        expect((await read(id, (l) => l.name === name)).name).toBe(name);
      }
      expect(stale).toBeGreaterThan(0);
    });

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
  });

  /**
   * Measured on TheBrain 15.0.640. Most of it is what the OpenAPI description
   * says; the read-back delay and the keying of the log entry are not in it.
   * How aliases read when there are none is in test/integration.test.ts.
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
        () => api.brains.modifications(brainId, { maxLogs: 200 }),
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
        () => api.brains.modifications(brainId, { maxLogs: 200 }),
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
      // rename behaves the same.
      const id = await make("alias-lag");
      let previous: string[] = [];
      let stale = 0;
      for (let i = 0; i < 10; i++) {
        const next = [`${PREFIX}lag-${i}`];
        await api.thoughts.update(brainId, id, { aliases: next });
        const atOnce = aliasesOf(await api.thoughts.get(brainId, id));
        if (sameSet(previous)(atOnce)) stale += 1;
        else expect(atOnce).toEqual(next);
        expect(await stored(id, sameSet(next))).toEqual(next);
        previous = next;
      }
      expect(stale).toBeGreaterThan(0);
    });

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
      // search is prefix-based and its index lags by up to 15 seconds.
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
