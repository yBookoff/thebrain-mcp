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
  MAX_ALIASES,
  ModType,
  Relation,
  TheBrainApi,
  TheBrainError,
  ThoughtKind,
  aliasesOf,
  compareLogTime,
  isTypeLink,
  isUuid,
  logEntryKey,
  logTime,
  replayThoughtIds,
  type CleanGraph,
  type ModificationLogDto,
  type ThoughtDto,
} from "../src/api/index.js";
import { describeChange, subjectIds } from "../src/operations/changes.js";
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
        .sort((a, b) => compareLogTime(a.creationDateTime, b.creationDateTime));
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

  it("concurrent writes share timestamps, and paging keeps every tied entry once", async () => {
    // Only concurrency produces them: a single request that logs several
    // entries (a cascade delete, a first note) stamps each one apart. Measured
    // over repeated bursts of concurrent creates: 30 at once shared a timestamp
    // in about half the bursts, 100 at once in every burst, 2 to 5 times.
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

    const sameEntries = (paged: ModificationLogDto[], whole: ModificationLogDto[]): void => {
      expect(paged.map(logEntryKey).sort()).toEqual(whole.map(logEntryKey).sort());
      for (let i = 1; i < paged.length; i++) {
        const order = compareLogTime(logTime(paged[i - 1]!), logTime(paged[i]!));
        expect(order).toBeGreaterThanOrEqual(0);
      }
    };
    // A page of two is bound to split a tie, and often to be filled by one.
    sameEntries(
      await api.brains.allModifications(brainId, { since, pageSize: 2 }),
      await api.brains.modifications(brainId, { maxLogs: 10_000, since }),
    );
    sameEntries(
      await api.brains.allModifications(brainId, { pageSize: 25 }),
      await api.brains.modifications(brainId, { maxLogs: 100_000 }),
    );
  }, 90_000);

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

    it("by-location finds a new attachment at once; the thought's own list is behind", async () => {
      // Measured over 30 attachments: by-location had each on the first read,
      // the thought's list had none, and showed it 80–115 ms later.
      const id = await make("attachment-lag");
      const ROUNDS = 5;
      let listedAtOnce = 0;
      for (let i = 0; i < ROUNDS; i++) {
        const url = `https://example.com/${PREFIX}lag-${Date.now()}-${i}`;
        await attach(id, url);
        expect(await found(url)).toBe(true);

        const listed = async (): Promise<boolean> => (await locations(id)).includes(url);
        if (await listed()) listedAtOnce += 1;
        expect(await eventually(listed, Boolean)).toBe(true);
      }
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
