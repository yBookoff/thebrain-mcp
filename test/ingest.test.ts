import { describe, expect, it, vi } from "vitest";

import {
  READ_BACK,
  RecentWrites,
  TheBrainError,
  WRITTEN_KEPT_MS,
  noteAsStored,
  type TheBrainApi,
} from "../src/api/index.js";
import {
  IngestBehindError,
  IngestMissingError,
  IngestReadError,
  IngestValidationError,
  ingest,
  linkFound,
  planLevels,
  type IngestOutcome,
  type IngestPlan,
} from "../src/operations/ingest.js";

/** The wait for the graphs, which is `READ_BACK`'s, and past it by a margin. */
const WAIT = READ_BACK.timeoutMs;
const PAST_THE_WAIT = WAIT + 1000;

/**
 * A batch's failures as they read: what failed, why, and the mark of a write
 * that got no answer. Each carries what was thrown beside that, for a caller
 * that explains failures in its own words, and what the write was to make.
 */
const said = (outcome: Pick<IngestOutcome, "failures">) =>
  outcome.failures.map(({ of: _of, error: _error, ...line }) => line);

const BRAIN = "aaaaaaaa-0000-4000-8000-000000000001";
const ROOT = "bbbbbbbb-0000-4000-8000-000000000002";
const TAG = "eeeeeeee-0000-4000-8000-000000000005";

/** What the API answers for the graph of an identifier nobody has, and for much else. */
const GENERIC_403 =
  "To use the TheBrain API, make requests to /api (e.g. /api/brains). " +
  "An API key is required via the Authorization header.";

/** In-memory fake brain: keeps what was created and lists it as a graph does. */
function fakeBrain(
  existing: Array<{
    id: string;
    name: string;
    /** The thought this one is a child of, */
    parent?: string;
    /** a parent of, */
    parentOf?: string;
    /** or a jump of. */
    jumpOf?: string;
    aliases?: string[];
    typeId?: string;
    /** Tags it carries from the start. */
    tags?: string[];
    /** The note it has from the start; none when absent. */
    note?: string;
  }> = [],
) {
  let counter = 0;
  const thoughts = new Map(
    existing.map(({ parentOf: _parentOf, jumpOf: _jumpOf, ...e }) => [
      e.id,
      { ...e, note: e.note ?? "", tags: [...(e.tags ?? [])], aliases: e.aliases ?? [] },
    ]),
  );
  /** Whole-list alias writes after creation: the only kind the API offers. */
  const aliasWrites: Array<{ id: string; aliases: string[] }> = [];
  /**
   * Thoughts, by name, whose alias writes TheBrain accepts and no read shows,
   * as after a burst of writes. `aliasWaits` has the wait each write and each
   * look for one was given.
   */
  const aliasesLag = new Set<string>();
  const aliasWaits: Array<{ of: "write" | "look"; ms: number }> = [];
  /**
   * Thoughts created here whose aliases do not read back yet. On the live API
   * that happens now and then for a moment; here, to every new thought until
   * `settle()`, which is the case the code has to survive.
   */
  const unsettled = new Set<string>();
  /** Flip `aliases` off to stand in for a build from before 15.0.621. */
  const build = { aliases: true };
  /**
   * A link as the API stores it: `a` is `thoughtIdA`, the upper end of a
   * parent-child link, and `relation` is 1 or 3, never 2. A tag's attachment
   * has the tag at `a` and `meaning: 5`, a type's link the type and 2; an
   * ordinary link has no `meaning` here and reads back with 1.
   */
  type Link = { a: string; b: string; relation: number; name?: string; meaning?: number };
  /** Links made since the brain was set up, */
  const links: Link[] = [];
  /** and the ones it had from the start: `between` finds both. */
  const given: Link[] = [];
  const joining = (a: string, b: string): Link | undefined =>
    [...given, ...links].find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  const linkId = (link: Link): string => `link-${[...given, ...links].indexOf(link)}`;
  const failOn = new Set<string>();
  /** By name: what a create throws in place of making the thought. */
  const failWith = new Map<string, Error>();
  /**
   * Creates whose answer is lost on the way back: the thought is made, and the
   * caller gets what the client makes of a timeout.
   */
  const lostOn = new Set<string>();
  /** The brain's types, and each read that asked whether something is one. */
  const types = new Set<string>();
  const typeReads: string[] = [];
  /** The same for tags. TAG is one from the start. */
  const tags = new Set<string>([TAG]);
  const tagReads: string[] = [];
  /** Each lookup that asked whether a tag is on a thought, and each attach sent. */
  const tagLooks: string[] = [];
  const tagAttaches: string[] = [];
  /** Each label sent to a link that was there. */
  const labelWrites: Array<{ id: string; name: string }> = [];
  /** Each read that asked whether something named as a parent is a type. */
  const parentReads: string[] = [];
  /** Each read of a thought by its identifier. */
  const thoughtReads: string[] = [];
  /**
   * Thoughts deleted between a plan's checks and its writes: each is there
   * for the first read that asks for it, and nobody has it from then on.
   */
  const vanishing = new Set<string>();
  const vanish = (id: string): void => {
    if (vanishing.delete(id)) thoughts.delete(id);
  };
  // As the real check: neither a type nor a tag is a parent, and anything
  // else passes.
  const refuseAsParent = (id: string, field: string): void => {
    if (types.has(id)) {
      throw new TheBrainError("not_a_parent", `${field} ${id} cannot be a parent: it is a type`);
    }
    if (tags.has(id)) {
      throw new TheBrainError("tag_as_parent", `${field} ${id} cannot be a parent: it is a tag`);
    }
  };
  const known = (id: string): boolean => thoughts.has(id) || types.has(id) || tags.has(id);

  /**
   * What each thought's graph lists, as the API fills it: a thought made as a
   * child is among its source's `children`, one made as a parent among its
   * `parents`, a jump among its `jumps`, and the source is in the matching
   * list of the new thought. The fake used to keep one `parent` whatever the
   * relation, and to list it under `children`: a second run that made every
   * parent and jump again passed for one that found them.
   */
  type Lists = { children: string[]; parents: string[]; jumps: string[] };
  const lists = new Map<string, Lists>();
  const listsOf = (id: string): Lists => {
    const has = lists.get(id) ?? { children: [], parents: [], jumps: [] };
    lists.set(id, has);
    return has;
  };
  /**
   * A graph that has been read is answered from a copy. On the live API the
   * copy is brought up to date about every 0.1 s, so a read straight after a
   * create misses the new thought; here it misses it for the next
   * `lag.reads` reads, and for `lag.ms` by the clock, which is how the API
   * goes and what a wait that polls nothing can be tested by. A graph not
   * read before is read live, as there.
   */
  const lag = { reads: 1, ms: 0 };
  const copies = new Map<string, { graph: unknown; stale: number; until: number }>();
  const list = (of: string, where: keyof Lists, id: string): void => {
    listsOf(of)[where].push(id);
    const copy = copies.get(of);
    if (copy !== undefined) {
      copy.stale = lag.reads;
      copy.until = Date.now() + lag.ms;
    }
  };
  /** `relation` is what `id` is to `source`, as in a create and in a link. */
  const relate = (source: string, id: string, relation: number): void => {
    const [there, back] = (
      { 1: ["children", "parents"], 2: ["parents", "children"], 3: ["jumps", "jumps"] } as const
    )[relation as 1 | 2 | 3];
    list(source, there, id);
    list(id, back, source);
  };
  for (const e of existing) {
    if (e.parent !== undefined) relate(e.parent, e.id, 1);
    if (e.parentOf !== undefined) relate(e.parentOf, e.id, 2);
    if (e.jumpOf !== undefined) relate(e.jumpOf, e.id, 3);
    // One link for each, as in a brain: a parent's from the upper end.
    if (e.parent !== undefined) given.push({ a: e.parent, b: e.id, relation: 1 });
    if (e.parentOf !== undefined) given.push({ a: e.id, b: e.parentOf, relation: 1 });
    if (e.jumpOf !== undefined) given.push({ a: e.jumpOf, b: e.id, relation: 3 });
    if (e.typeId !== undefined) given.push({ a: e.typeId, b: e.id, relation: 1, meaning: 2 });
    for (const tag of e.tags ?? []) {
      given.push({ a: tag, b: e.id, relation: 1, meaning: 5 });
      // A tag's graph lists the thoughts it marks as children.
      list(tag, "children", e.id);
    }
  }
  /** Every graph read, by thought, and by thought what the next reads throw. */
  const graphReads: string[] = [];
  const failGraph = new Map<string, Error[]>();
  /** Thoughts whose graph gets no answer from now on: the read never comes back. */
  const hungGraph = new Set<string>();
  /** Every note read and every note written, by thought, and what the next reads throw. */
  const noteReads: string[] = [];
  const noteWrites: Array<{ id: string; markdown: string }> = [];
  const failNote = new Map<string, Error[]>();
  /**
   * How long ago the client had its last write come back. The real client
   * goes by the clock; here the calls of a test follow one another with no
   * time between them, where a model takes seconds, so it is "long ago"
   * unless a test says otherwise.
   */
  const idle = { ms: Number.POSITIVE_INFINITY };
  /**
   * What the client keeps of its writes for a reader of a graph. The real
   * resources fill it as a create or a link is answered, and so do the two
   * here: without it a graph that is behind reads as one that is not.
   */
  const written = new RecentWrites();
  /** How many times the brain itself was read, and whether it is there to read. */
  const brain = { reads: 0, there: true };
  // As the API: every request to a brain that is not there is this 401.
  const noBrain = (): TheBrainError =>
    new TheBrainError("unknown_brain", `Access to brain ${BRAIN} is unauthorized.`, {
      status: 401,
    });

  const api = {
    client: { sinceLastWrite: () => idle.ms, written },
    brains: {
      async get(_b: string) {
        brain.reads += 1;
        if (!brain.there) throw noBrain();
        return { id: BRAIN };
      },
    },
    thoughts: {
      async create(
        _b: string,
        input: {
          name: string;
          sourceThoughtId?: string;
          relation?: number;
          aliases?: readonly string[];
          typeId?: string;
        },
      ) {
        if (!brain.there) throw noBrain();
        if (failOn.has(input.name)) throw new Error("server refused");
        if (failWith.has(input.name)) throw failWith.get(input.name)!;
        // As the real method: a thought is not made the child of a type.
        if (input.sourceThoughtId !== undefined && (input.relation ?? 1) === 1) {
          refuseAsParent(input.sourceThoughtId, "sourceThoughtId");
        }
        // As the API: a source no thought has is a 404, and nothing is made.
        if (input.sourceThoughtId !== undefined && !known(input.sourceThoughtId)) {
          throw new TheBrainError(
            "not_found",
            `Source Thought ${input.sourceThoughtId} could not be located`,
            { status: 404 },
          );
        }
        counter += 1;
        const id = `new-${counter}`;
        const source = input.sourceThoughtId;
        const relation = input.relation ?? 1;
        thoughts.set(id, {
          id,
          name: input.name,
          // Only a child has the source for its parent.
          ...(source !== undefined && relation === 1 ? { parent: source } : {}),
          ...(input.typeId !== undefined ? { typeId: input.typeId } : {}),
          note: "",
          tags: [],
          aliases: [...(input.aliases ?? [])],
        });
        unsettled.add(id);
        // The real API creates a link alongside the thought — without this
        // the fake diverges from reality on link deduplication. As measured:
        // a jump's from the source, and a parent's from the new thought, as
        // the parent link it is.
        if (source !== undefined) {
          relate(source, id, relation);
          links.push(
            relation === 2
              ? { a: id, b: source, relation: 1 }
              : { a: source, b: id, relation },
          );
        }
        if (lostOn.has(input.name)) {
          throw new TheBrainError("network", "request exceeded 30000 ms");
        }
        // As the real method: an answered create is kept, with where the
        // source's graph lists it. One that got no answer has no identifier.
        if (source !== undefined) written.linked(BRAIN, source, id, relation as 1 | 2 | 3);
        return id;
      },
      // As the API: 404 for an identifier nobody has.
      async get(_b: string, id: string) {
        thoughtReads.push(id);
        if (!brain.there) throw noBrain();
        if (!known(id)) throw new TheBrainError("not_found", "Not Found", { status: 404 });
        const read = { id, name: thoughts.get(id)?.name ?? "" };
        vanish(id);
        return read;
      },
      async getGraph(_b: string, id: string) {
        graphReads.push(id);
        if (hungGraph.has(id)) await new Promise(() => undefined);
        const failure = failGraph.get(id)?.shift();
        if (failure !== undefined) throw failure;
        // As the API: the graph of an identifier nobody has is the generic 403.
        if (!known(id)) throw new TheBrainError("forbidden", GENERIC_403, { status: 403 });
        const copy = copies.get(id);
        if (copy !== undefined && (copy.stale > 0 || Date.now() < copy.until)) {
          copy.stale = Math.max(copy.stale - 1, 0);
          return copy.graph;
        }
        // As the API: every thought in a graph's lists carries its kind.
        const named = (ids: string[]) =>
          ids.map((i) => ({
            id: i,
            name: thoughts.get(i)?.name ?? "",
            kind: types.has(i) ? 2 : tags.has(i) ? 4 : 1,
          }));
        const has = listsOf(id);
        const graph = {
          thought: { id, name: thoughts.get(id)?.name ?? "" },
          children: named(has.children),
          parents: named(has.parents),
          jumps: named(has.jumps),
          tags: named(thoughts.get(id)?.tags ?? []),
        };
        copies.set(id, { graph, stale: 0, until: 0 });
        return graph;
      },
      async supportsAliases() {
        return build.aliases;
      },
      // As the real method: throws unless the identifier names a type.
      async requireType(_b: string, typeId: string) {
        typeReads.push(typeId);
        if (!types.has(typeId)) {
          throw new TheBrainError("not_a_type", `typeId ${typeId} is not a type`);
        }
        return { id: typeId, kind: 2 };
      },
      // As the real method: reads the list, adds what is new ignoring case,
      // and writes only when something was.
      async changeAliases(
        _b: string,
        id: string,
        changes: { add?: readonly string[] },
        _known: unknown,
        waitMs?: number,
      ) {
        const t = thoughts.get(id)!;
        aliasWaits.push({ of: "write", ms: waitMs ?? Infinity });
        if (failOn.has(`aliases of ${t.name}`)) throw new Error("server refused");
        // The read comes back empty for an unsettled thought, and the write
        // that follows replaces whatever the thought really had.
        if (unsettled.delete(id)) t.aliases = [];
        const has = new Set(t.aliases.map((a) => a.toLowerCase()));
        const added = (changes.add ?? []).filter((a) => {
          if (has.has(a.toLowerCase())) return false;
          has.add(a.toLowerCase());
          return true;
        });
        if (added.length > 0) {
          t.aliases = [...t.aliases, ...added];
          aliasWrites.push({ id, aliases: t.aliases });
        }
        const readBack = added.length === 0 || !aliasesLag.has(t.name);
        return { aliases: t.aliases, added, removed: [], readBack };
      },
      // As the real method: waits out `waitMs` for a list that does not show.
      async aliasesReadBack(_b: string, id: string, waitMs: number) {
        aliasWaits.push({ of: "look", ms: waitMs });
        if (!aliasesLag.has(thoughts.get(id)!.name)) return true;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return false;
      },
    },
    notes: {
      // As the API: the note's text, and "" for a thought that has none, which
      // is a 200 there too. So is the note of an identifier nobody has.
      async get(_b: string, id: string) {
        noteReads.push(id);
        const failure = failNote.get(id)?.shift();
        if (failure !== undefined) throw failure;
        return thoughts.get(id)?.note ?? "";
      },
      async set(_b: string, id: string, markdown: string) {
        // By its text: two thoughts of one name are told apart by their notes.
        if (failOn.has(`note: ${markdown}`)) throw new Error("server refused");
        if (failWith.has(`note: ${markdown}`)) throw failWith.get(`note: ${markdown}`)!;
        noteWrites.push({ id, markdown });
        const t = thoughts.get(id);
        // As the API keeps it: without a fence that has no partner (L5).
        if (t !== undefined) t.note = noteAsStored(markdown);
        // As a create whose answer is lost: the note is written all the same.
        if (lostOn.has(`note: ${markdown}`)) {
          throw new TheBrainError("network", "request exceeded 30000 ms", {
            method: "POST",
            path: `/api/notes/${BRAIN}/${id}/update`,
          });
        }
      },
    },
    links: {
      // As the API: the one link a pair has, whatever it is, in its own terms.
      async between(_b: string, a: string, b: string) {
        const found = joining(a, b);
        return found === undefined
          ? null
          : {
              id: linkId(found),
              thoughtIdA: found.a,
              thoughtIdB: found.b,
              relation: found.relation,
              meaning: found.meaning ?? 1,
              name: found.name ?? null,
            };
      },
      async create(
        _b: string,
        input: { thoughtIdA: string; thoughtIdB: string; relation: number; name?: string },
      ) {
        // As the real method: no thought is linked to itself, which the API
        // answers with an identifier of zeros,
        if (input.thoughtIdA === input.thoughtIdB) {
          throw new TheBrainError("bad_request", "a thought cannot be linked to itself");
        }
        // and no parent/child link has a type or a tag for its upper end.
        if (input.relation === 1) refuseAsParent(input.thoughtIdA, "thoughtIdA");
        if (input.relation === 2) refuseAsParent(input.thoughtIdB, "thoughtIdB");
        // As the API: an end no thought has is a 400 that names it, the
        // source when both are nobody's.
        for (const [end, id] of [
          ["source", input.thoughtIdA],
          ["target", input.thoughtIdB],
        ] as const) {
          if (!known(id)) {
            throw new TheBrainError("bad_request", `Could not get ${end} thought ${id}`, {
              status: 400,
            });
          }
        }
        // As the API: a parent's link is stored as a child's from the other end.
        const [a, b] =
          input.relation === 2
            ? [input.thoughtIdB, input.thoughtIdA]
            : [input.thoughtIdA, input.thoughtIdB];
        const made: Link = {
          a,
          b,
          relation: input.relation === 2 ? 1 : input.relation,
          ...(input.name !== undefined ? { name: input.name } : {}),
        };
        links.push(made);
        relate(input.thoughtIdA, input.thoughtIdB, input.relation);
        // As the real method, for a reader of either end's graph.
        written.linked(BRAIN, input.thoughtIdA, input.thoughtIdB, input.relation as 1 | 2 | 3);
        return linkId(made);
      },
      async update(_b: string, id: string, changes: { name?: string }) {
        const link = [...given, ...links].find((l) => linkId(l) === id);
        if (changes.name !== undefined) labelWrites.push({ id, name: changes.name });
        if (link !== undefined && changes.name !== undefined) link.name = changes.name;
      },
      // As the real method: the pair's one link is the tag's, with the tag at
      // its head. One read, and no write.
      async hasTag(_b: string, thoughtId: string, tagId: string) {
        tagLooks.push(`${tagId} on ${thoughtId}`);
        if (failWith.has(`look for tag on ${thoughtId}`)) {
          throw failWith.get(`look for tag on ${thoughtId}`)!;
        }
        const found = joining(thoughtId, tagId);
        return found !== undefined && found.meaning === 5 && found.a === tagId;
      },
      // As the real method: throws unless the identifier names a tag.
      async requireTag(_b: string, tagId: string) {
        tagReads.push(tagId);
        if (!tags.has(tagId)) {
          throw new TheBrainError("not_a_tag", `tagId ${tagId} is not a tag`);
        }
        return { id: tagId, kind: 4 };
      },
      // As the API: the tag's attachment is the pair's one link, with the tag
      // at its head, and the tag's graph lists the thought as a child.
      async attachTag(_b: string, thoughtId: string, tagId: string) {
        if (failOn.has(`tag on ${thoughtId}`)) throw new Error("server refused");
        if (failWith.has(`tag on ${thoughtId}`)) throw failWith.get(`tag on ${thoughtId}`)!;
        tagAttaches.push(`${tagId} on ${thoughtId}`);
        const carried = thoughts.get(thoughtId)?.tags;
        if (carried !== undefined && !carried.includes(tagId)) carried.push(tagId);
        const there = joining(thoughtId, tagId);
        const link = there ?? { a: tagId, b: thoughtId, relation: 1 };
        Object.assign(link, { a: tagId, b: thoughtId, relation: 1, meaning: 5 });
        if (there === undefined) {
          links.push(link);
          list(tagId, "children", thoughtId);
        }
        return linkId(link);
      },
      // As the real method: the thought it read, or null for an identifier
      // nobody has, which it leaves to the write.
      async requireParent(_b: string, id: string, field: string) {
        parentReads.push(id);
        refuseAsParent(id, field);
        const read = known(id) ? { id, name: thoughts.get(id)?.name ?? "" } : null;
        vanish(id);
        return read;
      },
    },
  };
  const settle = (): void => unsettled.clear();
  /**
   * A rename as another tool makes it. The copies that list the thought keep
   * its old name for as long as they lack a new thought, and the client keeps
   * the name it wrote, as `thoughts.update()` has it do.
   */
  const rename = (id: string, name: string): void => {
    thoughts.get(id)!.name = name;
    for (const copy of copies.values()) {
      copy.stale = lag.reads;
      copy.until = Date.now() + lag.ms;
    }
    written.named(BRAIN, id, name);
  };
  return {
    api: api as unknown as TheBrainApi,
    rename,
    thoughts,
    links,
    given,
    failOn,
    failWith,
    lostOn,
    types,
    typeReads,
    tags,
    tagReads,
    tagLooks,
    tagAttaches,
    labelWrites,
    parentReads,
    thoughtReads,
    vanishing,
    aliasWrites,
    aliasesLag,
    aliasWaits,
    build,
    settle,
    lists,
    lag,
    graphReads,
    failGraph,
    hungGraph,
    noteReads,
    noteWrites,
    failNote,
    idle,
    written,
    brain,
  };
}

describe("plan validation before any write", () => {
  it("an empty list is rejected", () => {
    expect(() => planLevels({ thoughts: [] })).toThrowError(IngestValidationError);
  });

  it("a duplicate tempId is rejected", () => {
    expect(() =>
      planLevels({
        thoughts: [
          { tempId: "a", name: "one" },
          { tempId: "a", name: "two" },
        ],
      }),
    ).toThrowError(/appears twice/);
  });

  it("an empty name is rejected", () => {
    expect(() => planLevels({ thoughts: [{ tempId: "a", name: "   " }] })).toThrowError(
      /the name of thought "a" is white space alone/,
    );
  });

  it("a name is empty by the API's rule, not by trim(): the plan item is named, and why", () => {
    const refused = (name: string): string | null => {
      try {
        planLevels({ thoughts: [{ tempId: "ok", name: "one" }, { tempId: "t1", name }] });
        return null;
      } catch (error) {
        expect(error).toBeInstanceOf(IngestValidationError);
        return (error as Error).message;
      }
    };
    const NO_NAME = ", and a thought has to have a name";
    expect(refused("")).toBe(`the name of thought "t1" is empty${NO_NAME}`);
    expect(refused(" \t")).toBe(
      `the name of thought "t1" is white space alone (U+0020 U+0009)${NO_NAME}`,
    );
    expect(refused("\u00a0\u3000")).toBe(
      `the name of thought "t1" is white space alone (U+00A0 U+3000)${NO_NAME}`,
    );
    // A next line is white space to the API, and `trim()` leaves it: the
    // thought went on to be refused in the middle of the batch.
    expect(refused("\u0085")).toBe(
      `the name of thought "t1" is white space alone (U+0085)${NO_NAME}`,
    );
    // A byte order mark is none, and `trim()` drops it: the API stores a
    // name of one, and the plan used to be rejected for an empty name.
    for (const name of ["\ufeff", "\u200b", "\u2800", "\u0301", "🧠", "."]) {
      expect(refused(name), JSON.stringify(name)).toBeNull();
    }
  });

  it("a name too long to keep is rejected: stored cut, it was made again by every run", () => {
    const plan = (name: string): IngestPlan => ({ thoughts: [{ tempId: "t1", name }] });
    expect(() => planLevels(plan("a".repeat(1024)))).not.toThrow();
    expect(() => planLevels(plan(` ${"a".repeat(1024)}\n`))).not.toThrow();
    expect(() => planLevels(plan("a".repeat(1025)))).toThrowError(
      'the name of thought "t1" is 1025 UTF-16 units long, and TheBrain keeps the first ' +
        "1024 of a name and drops the rest with a 200",
    );
  });

  it("a reference to an unknown tempId is rejected, naming the culprit", () => {
    expect(() =>
      planLevels({
        thoughts: [{ tempId: "a", name: "one", parent: "typo" }],
      }),
    ).toThrowError(/"a".*"typo"/s);
  });

  it("a real UUID as parent is allowed — grafting onto what exists", () => {
    const levels = planLevels({
      thoughts: [{ tempId: "a", name: "one", parent: ROOT }],
    });
    expect(levels).toHaveLength(1);
  });

  it("a cycle in parents is detected rather than hanging the walk", () => {
    expect(() =>
      planLevels({
        thoughts: [
          { tempId: "a", name: "one", parent: "b" },
          { tempId: "b", name: "two", parent: "a" },
        ],
      }),
    ).toThrowError(/cycle/);
  });

  it("a broken reference in links is caught before any write", () => {
    expect(() =>
      planLevels({
        thoughts: [{ tempId: "a", name: "one" }],
        links: [{ from: "a", to: "no-such-thing" }],
      }),
    ).toThrowError(/no-such-thing/);
  });

  it("a link from a thought to itself is rejected, by tempId and by UUID", () => {
    // The API answers one with a 200 and an identifier of zeros, and makes no
    // link. It used to be counted as a link created.
    for (const ref of ["a", ROOT]) {
      expect(() =>
        planLevels({
          thoughts: [{ tempId: "a", name: "one", parent: ROOT }],
          links: [{ from: ref, to: ref, name: "itself" }],
        }),
      ).toThrowError(new RegExp(`the link ${ref} -> ${ref} joins a thought to itself`));
    }
  });

  it("a relation that is none of the three is rejected, on a thought and on a link", () => {
    // `sibling` was one of the names, and the API writes nothing with it.
    // Looked up now it gives no number, which `create` would take for a child.
    const sibling = "sibling" as never;
    expect(() =>
      planLevels({ thoughts: [{ tempId: "a", name: "one", parent: ROOT, relation: sibling }] }),
    ).toThrowError(/thought "a" has the relation "sibling".*child, parent or jump/);
    expect(() =>
      planLevels({
        thoughts: [{ tempId: "a", name: "one" }],
        links: [{ from: "a", to: ROOT, relation: sibling }],
      }),
    ).toThrowError(new RegExp(`the link a -> ${ROOT} has the relation "sibling"`));
    // Nor a name that every object answers to.
    expect(() =>
      planLevels({ thoughts: [{ tempId: "a", name: "one", relation: "toString" as never }] }),
    ).toThrowError(IngestValidationError);
  });

  it("a relation with no parent is rejected, whichever of the three it is", () => {
    // It used to be dropped: the thought was created with no link, and listed
    // as created.
    for (const relation of ["child", "parent", "jump"] as const) {
      expect(() =>
        planLevels({ thoughts: [{ tempId: "a", name: "one", relation }] }),
      ).toThrowError(new RegExp(`thought "a" has the relation "${relation}" and no parent`));
    }
    expect(() =>
      planLevels({ thoughts: [{ tempId: "a", name: "one", relation: "jump" }] }),
    ).toThrowError(IngestValidationError);
  });

  it("each of the three relations passes, and so does none", () => {
    const levels = planLevels({
      thoughts: [
        { tempId: "a", name: "one", parent: ROOT, relation: "child" },
        { tempId: "b", name: "two", parent: ROOT, relation: "parent" },
        { tempId: "c", name: "three", parent: ROOT, relation: "jump" },
        { tempId: "d", name: "four", parent: ROOT },
      ],
      links: [
        { from: "a", to: "b", relation: "child" },
        { from: "a", to: "c", relation: "parent" },
        { from: "a", to: "d", relation: "jump" },
        { from: "b", to: "c" },
      ],
    });
    expect(levels).toHaveLength(1);
  });

  it("levels are laid out by depth regardless of input order", () => {
    const levels = planLevels({
      thoughts: [
        { tempId: "grandchild", name: "grandchild", parent: "child" },
        { tempId: "root", name: "root" },
        { tempId: "child", name: "child", parent: "root" },
      ],
    });
    expect(levels.map((l) => l.map((t) => t.tempId))).toEqual([
      ["root"],
      ["child"],
      ["grandchild"],
    ]);
  });
});

describe("writing a batch", () => {
  const plan: IngestPlan = {
    thoughts: [
      { tempId: "root", name: "Article", parent: ROOT, note: "summary" },
      { tempId: "a", name: "Idea A", parent: "root", note: "first" },
      { tempId: "b", name: "Idea B", parent: "root", tagIds: [TAG] },
    ],
    links: [{ from: "a", to: "b", name: "contradicts" }],
  };

  it("creates the tree, notes, tags and links in one call", async () => {
    const { api, thoughts, links } = fakeBrain([{ id: ROOT, name: "root" }]);
    const outcome = await ingest(api, BRAIN, plan);

    expect(outcome.created).toHaveLength(3);
    expect(outcome.notesWritten).toBe(2);
    expect(outcome.tagsAttached).toBe(1);
    expect(outcome.linksCreated).toBe(1);
    expect(outcome.failures).toEqual([]);

    const created = new Map(outcome.created.map((c) => [c.tempId, c.thoughtId]));
    expect(thoughts.get(created.get("a")!)?.parent).toBe(created.get("root"));
    expect(links.find((l) => l.name === "contradicts")).toBeDefined();
  });

  it("a relation that is none of the three stops the plan before its first write", async () => {
    // A thought sent as a sibling used to be created with no link and listed
    // as created, and a link sent as one failed with the rest written.
    const sibling = "sibling" as never;
    const { api, thoughts, links } = fakeBrain([{ id: ROOT, name: "root" }]);
    const beside = { tempId: "c", name: "Idea C", parent: "a", relation: sibling };
    await expect(
      ingest(api, BRAIN, { ...plan, thoughts: [...plan.thoughts, beside] }),
    ).rejects.toThrowError(IngestValidationError);
    await expect(
      ingest(api, BRAIN, {
        ...plan,
        links: [...plan.links!, { from: "b", to: "a", relation: sibling }],
      }),
    ).rejects.toThrowError(IngestValidationError);

    expect([...thoughts.keys()]).toEqual([ROOT]);
    expect(links).toEqual([]);
  });

  it("a relation with no parent stops the plan before its first write", async () => {
    const { api, thoughts, links, graphReads } = fakeBrain([{ id: ROOT, name: "root" }]);
    const loose = { tempId: "c", name: "Idea C", relation: "jump" as const };
    await expect(
      ingest(api, BRAIN, { ...plan, thoughts: [...plan.thoughts, loose] }),
    ).rejects.toThrowError(/thought "c" has the relation "jump" and no parent/);

    expect([...thoughts.keys()]).toEqual([ROOT]);
    expect(links).toEqual([]);
    expect(graphReads).toEqual([]);
  });

  it("links resolve through returned identifiers, not names", async () => {
    const { api, links } = fakeBrain([{ id: ROOT, name: "root" }]);
    const outcome = await ingest(api, BRAIN, plan);
    const created = new Map(outcome.created.map((c) => [c.tempId, c.thoughtId]));
    const explicit = links.find((l) => l.name === "contradicts")!;
    expect(explicit.a).toBe(created.get("a"));
    expect(explicit.b).toBe(created.get("b"));
  });

  it("a repeat run duplicates nothing", async () => {
    const { api, thoughts } = fakeBrain([{ id: ROOT, name: "root" }]);
    await ingest(api, BRAIN, plan);
    const sizeAfterFirst = thoughts.size;

    const second = await ingest(api, BRAIN, plan);
    expect(second.created).toHaveLength(0);
    expect(second.reused).toHaveLength(3);
    expect(thoughts.size).toBe(sizeAfterFirst);
  });

  it("with deduplication off, duplicates are created deliberately", async () => {
    const { api, thoughts } = fakeBrain([{ id: ROOT, name: "root" }]);
    await ingest(api, BRAIN, plan);
    const sizeAfterFirst = thoughts.size;
    const second = await ingest(api, BRAIN, { ...plan, deduplicate: false });
    expect(second.created).toHaveLength(3);
    expect(thoughts.size).toBe(sizeAfterFirst + 3);
  });

  it("two identical thoughts in one batch do not create a duplicate", async () => {
    const { api } = fakeBrain([{ id: ROOT, name: "root" }]);
    const outcome = await ingest(api, BRAIN, {
      thoughts: [
        { tempId: "x", name: "The very same", parent: ROOT },
        { tempId: "y", name: "The very same", parent: ROOT },
      ],
    });
    expect(outcome.created.length + outcome.reused.length).toBe(2);
    expect(outcome.created).toHaveLength(1);
    expect(outcome.reused).toHaveLength(1);
  });

  it("one failed thought does not cancel the rest but shows in the report", async () => {
    const { api, failOn } = fakeBrain([{ id: ROOT, name: "root" }]);
    failOn.add("Idea B");
    const outcome = await ingest(api, BRAIN, plan);

    expect(outcome.created).toHaveLength(2);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]!.what).toMatch(/Idea B/);
    // Its link was not tried, which is not a failure of the link.
    expect(outcome.skipped).toEqual([
      { what: "link a -> b", reason: 'depends on "b", which was not created' },
    ]);
  });

  it("no note is written for a thought that failed to be created", async () => {
    const { api, failOn } = fakeBrain([{ id: ROOT, name: "root" }]);
    failOn.add("Idea A");
    const outcome = await ingest(api, BRAIN, plan);
    expect(outcome.notesWritten).toBe(1); // root only
  });

  it("a parentless thought is created orphaned rather than failing", async () => {
    const { api } = fakeBrain();
    const outcome = await ingest(api, BRAIN, {
      thoughts: [{ tempId: "single", name: "Orphan" }],
    });
    expect(outcome.created).toHaveLength(1);
  });

  it("a parentless thought is found by no later run: a second makes it again", async () => {
    // Deduplication looks next to the thought a plan item hangs on, and here
    // there is none to look next to. It is why a batch written in part asks
    // for the rest alone.
    const { api, thoughts } = fakeBrain();
    const lone: IngestPlan = { thoughts: [{ tempId: "single", name: "Orphan" }] };
    await ingest(api, BRAIN, lone);
    const second = await ingest(api, BRAIN, lone);
    expect(second.created).toHaveLength(1);
    expect(second.reused).toEqual([]);
    expect(thoughts.size).toBe(2);
  });

  it("an existing link is not duplicated", async () => {
    const { api, links } = fakeBrain([{ id: ROOT, name: "root" }]);
    await ingest(api, BRAIN, plan);
    const afterFirst = links.length;
    const second = await ingest(api, BRAIN, plan);
    expect(links).toHaveLength(afterFirst);
    expect(second.linksCreated).toBe(0);
    expect(second.linksReused).toHaveLength(1);
  });
});

describe("the note of a thought that was there", () => {
  const THERE = "dddddddd-0000-4000-8000-000000000004";
  const RELATIONS = ["child", "parent", "jump"] as const;
  const HUMAN = "A person wrote this.\n\nBy hand.";
  /** A brain where ROOT has "Held" next to it, as its `have`, with `note` or with none. */
  const brain = (note?: string, have: (typeof RELATIONS)[number] = "child") =>
    fakeBrain([
      { id: ROOT, name: "root" },
      {
        id: THERE,
        name: "Held",
        ...(have === "child" && { parent: ROOT }),
        ...(have === "parent" && { parentOf: ROOT }),
        ...(have === "jump" && { jumpOf: ROOT }),
        ...(note !== undefined && { note }),
      },
    ]);
  const plan = (note?: string, relation?: (typeof RELATIONS)[number]): IngestPlan => ({
    thoughts: [
      {
        tempId: "held",
        name: "Held",
        parent: ROOT,
        ...(relation !== undefined && { relation }),
        ...(note !== undefined && { note }),
      },
    ],
  });

  it("is kept when the plan has another, on a first run and on a second, whatever the relation", async () => {
    // The plan's note used to be written over it, on every run: on a live
    // TheBrain 6 times of 6 for each relation, and nothing in the result
    // said that a note had been there.
    for (const relation of RELATIONS) {
      const fake = brain(HUMAN, relation);
      for (const run of ["first", "second"]) {
        const outcome = await ingest(fake.api, BRAIN, plan("the plan's", relation));
        const where = `${relation}, ${run} run`;

        expect(fake.thoughts.get(THERE)?.note, where).toBe(HUMAN);
        expect(outcome.reused.map((r) => r.thoughtId), where).toEqual([THERE]);
        expect(outcome.notesKept, where).toEqual([
          { tempId: "held", thoughtId: THERE, same: false },
        ]);
        expect([outcome.notesWritten, outcome.notesWrittenFor], where).toEqual([0, []]);
        expect([outcome.failures, outcome.skipped], where).toEqual([[], []]);
      }
      expect(fake.noteWrites, relation).toEqual([]);
    }
  });

  it("is kept, and said to be the plan's text, when it is: line ends and the blanks around it aside", async () => {
    // What a second run of a plan finds. A note reads back as it was written
    // but for its line ends, which come back as "\n".
    for (const [held, planned] of [
      [HUMAN, HUMAN],
      ["one\ntwo\n\nthree", "one\r\ntwo\r\n\r\nthree"],
      ["text", "  text\n"],
      // A code block that is closed is kept to the character.
      ["a\n\n```js\ncode();\n```\n\nend", "a\n\n```js\ncode();\n```\n\nend"],
      // A fence with no partner is not kept, nor a block with nothing in it:
      // the note the plan's text was stored as is the plan's text.
      ["intro\n\ncode();", "intro\n\n```js\ncode();"],
      ["a\n\n\nend", "a\n\n```\n```\n\nend"],
    ] as const) {
      const fake = brain(held);
      const outcome = await ingest(fake.api, BRAIN, plan(planned));

      expect(outcome.notesKept, planned).toEqual([
        { tempId: "held", thoughtId: THERE, same: true },
      ]);
      expect(fake.noteWrites, planned).toEqual([]);
      expect(fake.thoughts.get(THERE)?.note, planned).toBe(held);
    }

    // The fence is not set aside: a block the plan closes is another text
    // than the same lines with no block.
    const fake = brain("intro\n\ncode();");
    const outcome = await ingest(fake.api, BRAIN, plan("intro\n\n```js\ncode();\n```"));
    expect(outcome.notesKept).toEqual([{ tempId: "held", thoughtId: THERE, same: false }]);
  });

  it("a plan's note that TheBrain did not keep whole is the plan's text on the next run", async () => {
    // A note with a fence left open is stored without that line. Compared
    // as it was sent, the second run read "kept: another text" for the note
    // the first run had written, and asked for it to be appended.
    const OPEN = "intro\n\n```js\ncode();";
    const fake = brain(undefined);
    const first = await ingest(fake.api, BRAIN, plan(OPEN));
    expect(first.notesWrittenFor).toEqual(["held"]);
    // Sent as it was given, and stored as TheBrain stores it.
    expect(fake.noteWrites).toEqual([{ id: THERE, markdown: OPEN }]);
    expect(fake.thoughts.get(THERE)?.note).toBe("intro\n\ncode();");

    const second = await ingest(fake.api, BRAIN, plan(OPEN));
    expect(second.notesKept).toEqual([{ tempId: "held", thoughtId: THERE, same: true }]);
    expect(fake.noteWrites).toHaveLength(1);
  });

  it("a thought with no note is given the plan's, and the next run finds it there", async () => {
    // Nothing is lost by it, and a batch that failed at the note is finished
    // by the run that follows. A note of blanks alone is no note either.
    for (const held of [undefined, " \n"]) {
      const fake = brain(held);
      const first = await ingest(fake.api, BRAIN, plan("the plan's"));

      expect(fake.thoughts.get(THERE)?.note).toBe("the plan's");
      expect([first.notesWritten, first.notesWrittenFor, first.notesKept]).toEqual([
        1,
        ["held"],
        [],
      ]);
      // Read once, then written once.
      expect([fake.noteReads, fake.noteWrites]).toEqual([
        [THERE],
        [{ id: THERE, markdown: "the plan's" }],
      ]);

      const second = await ingest(fake.api, BRAIN, plan("the plan's"));
      expect(second.notesKept).toEqual([{ tempId: "held", thoughtId: THERE, same: true }]);
      expect(second.notesWritten).toBe(0);
      expect(fake.noteWrites).toHaveLength(1);
    }
  });

  it("a note a person changed between two runs is still there after the second", async () => {
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    const first = await ingest(fake.api, BRAIN, plan("the plan's"));
    const made = first.created[0]!.thoughtId;
    expect(fake.thoughts.get(made)?.note).toBe("the plan's");

    const edited = "the plan's\n\nand a line added by hand";
    fake.thoughts.get(made)!.note = edited;
    const second = await ingest(fake.api, BRAIN, plan("the plan's"));

    expect(fake.thoughts.get(made)?.note).toBe(edited);
    expect(second.notesKept).toEqual([{ tempId: "held", thoughtId: made, same: false }]);
    expect(second.failures).toEqual([]);
  });

  it("a thought the batch made is not read: its note is written as it was", async () => {
    // A plan that lands on nothing sends what it sent, a request for a request.
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    const outcome = await ingest(fake.api, BRAIN, {
      thoughts: [
        { tempId: "top", name: "Top", parent: ROOT, note: "summary" },
        { tempId: "leaf", name: "Leaf", parent: "top", note: "body" },
      ],
    });

    expect(fake.noteReads).toEqual([]);
    expect(fake.noteWrites.map((w) => w.markdown).sort()).toEqual(["body", "summary"]);
    expect([outcome.notesWritten, outcome.notesKept]).toEqual([2, []]);
  });

  it("a plan with no note for it reads none", async () => {
    const fake = brain(HUMAN);
    const outcome = await ingest(fake.api, BRAIN, plan());

    expect(fake.noteReads).toEqual([]);
    expect([outcome.notesKept, outcome.notesWritten]).toEqual([[], 0]);
    expect(fake.thoughts.get(THERE)?.note).toBe(HUMAN);
  });

  it("a note that cannot be read is not written over: it fails, by the thought's identifier", async () => {
    // A failed read is not the answer "no note", which is a 200.
    const boom = new TheBrainError("server", "boom", { status: 500 });
    const fake = brain(HUMAN);
    fake.failNote.set(THERE, [boom]);
    const outcome = await ingest(fake.api, BRAIN, plan("the plan's"));

    expect(fake.noteWrites).toEqual([]);
    expect(fake.thoughts.get(THERE)?.note).toBe(HUMAN);
    expect(outcome.failures).toEqual([
      {
        of: "note",
        what: `note for "Held" (${THERE})`,
        reason:
          "not written, because the note this thought has could not be read and a note " +
          "is not written over one that was not: boom",
        error: expect.any(IngestReadError),
      },
    ]);
    expect((outcome.failures[0]!.error as IngestReadError).cause).toBe(boom);
    expect([outcome.notesKept, outcome.notesWritten]).toEqual([[], 0]);

    // The read answers again: the next run sees the note, and keeps it.
    const second = await ingest(fake.api, BRAIN, plan("the plan's"));
    expect(second.failures).toEqual([]);
    expect(second.notesKept).toEqual([{ tempId: "held", thoughtId: THERE, same: false }]);
  });

  it("two plan items that are one thought: the first one's note is written, and the second finds it there", async () => {
    // Both used to be written at once, and which the thought kept was not
    // the plan's to say.
    for (const [first, second, same] of [
      ["one", "another", false],
      ["one", "one", true],
      // The first one's note as it is stored, with its open fence gone.
      ["one\n```js\ncode();", "one\n```js\ncode();", true],
      ["one\n```js\ncode();", "one\ncode();", true],
    ] as const) {
      const fake = fakeBrain([{ id: ROOT, name: "root" }]);
      const outcome = await ingest(fake.api, BRAIN, {
        thoughts: [
          { tempId: "x", name: "Same", parent: ROOT, note: first },
          { tempId: "y", name: "Same", parent: ROOT, note: second },
        ],
      });
      const made = outcome.created[0]!.thoughtId;

      expect(fake.noteWrites, second).toEqual([{ id: made, markdown: first }]);
      expect(outcome.notesWrittenFor, second).toEqual(["x"]);
      expect(outcome.notesKept, second).toEqual([{ tempId: "y", thoughtId: made, same }]);
      // Made here, so not read.
      expect(fake.noteReads, second).toEqual([]);
    }
  });

  it("two plan items that land on one thought with a note read it once, and both are kept", async () => {
    const fake = brain(HUMAN);
    const outcome = await ingest(fake.api, BRAIN, {
      thoughts: [
        { tempId: "x", name: "Held", parent: ROOT, note: "one" },
        { tempId: "y", name: "Held", parent: ROOT, note: HUMAN },
      ],
    });

    expect(fake.noteReads).toEqual([THERE]);
    expect(fake.noteWrites).toEqual([]);
    expect(outcome.notesKept).toEqual([
      { tempId: "x", thoughtId: THERE, same: false },
      { tempId: "y", thoughtId: THERE, same: true },
    ]);
  });

  it("a type or a tag the plan landed on keeps its note like any other thought", async () => {
    const fake = brain(HUMAN);
    fake.types.add(THERE);
    const outcome = await ingest(fake.api, BRAIN, plan("the plan's"));

    expect(outcome.reused).toEqual([{ tempId: "held", thoughtId: THERE, name: "Held", kind: 2 }]);
    expect(fake.thoughts.get(THERE)?.note).toBe(HUMAN);
    expect(outcome.notesKept).toEqual([{ tempId: "held", thoughtId: THERE, same: false }]);
  });
});

describe("a second run of a plan, by relation", () => {
  const RELATIONS = ["child", "parent", "jump"] as const;
  /** One thought of each relation next to ROOT, and one of each next to a thought of the plan. */
  const plan: IngestPlan = {
    thoughts: [
      { tempId: "top", name: "Top", parent: ROOT },
      ...RELATIONS.map((relation) => ({
        tempId: `first-${relation}`,
        name: `First ${relation}`,
        parent: ROOT,
        relation,
      })),
      ...RELATIONS.map((relation) => ({
        tempId: `deep-${relation}`,
        name: `Deep ${relation}`,
        parent: "top",
        relation,
      })),
    ],
  };
  const namesOf = (fake: ReturnType<typeof fakeBrain>, ids: string[]): string[] =>
    ids.map((id) => fake.thoughts.get(id)?.name ?? id);

  it("a thought made as a parent or as a jump is listed where the API lists it", async () => {
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    const outcome = await ingest(fake.api, BRAIN, plan);
    const top = outcome.created.find((c) => c.tempId === "top")!.thoughtId;

    expect(outcome.created).toHaveLength(7);
    expect(namesOf(fake, fake.lists.get(ROOT)!.children)).toEqual(["Top", "First child"]);
    expect(namesOf(fake, fake.lists.get(ROOT)!.parents)).toEqual(["First parent"]);
    expect(namesOf(fake, fake.lists.get(ROOT)!.jumps)).toEqual(["First jump"]);
    expect(namesOf(fake, fake.lists.get(top)!.children)).toEqual(["Deep child"]);
    expect(namesOf(fake, fake.lists.get(top)!.parents)).toEqual(["root", "Deep parent"]);
    expect(namesOf(fake, fake.lists.get(top)!.jumps)).toEqual(["Deep jump"]);
  });

  it("it finds what the first made under every relation, next to an existing thought and next to a tempId", async () => {
    // Looked for among `children` alone, each parent and each jump was made
    // again by every run: 24 of 24 on the live API.
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    fake.lag.reads = 0;
    const first = await ingest(fake.api, BRAIN, plan);
    const sizeAfterFirst = fake.thoughts.size;

    const second = await ingest(fake.api, BRAIN, plan);
    expect(second.created).toEqual([]);
    expect(second.reused.map((r) => r.thoughtId).sort()).toEqual(
      first.created.map((c) => c.thoughtId).sort(),
    );
    expect(fake.thoughts.size).toBe(sizeAfterFirst);
    expect([second.failures, second.skipped]).toEqual([[], []]);
  });

  it("sent straight after the first it still finds them: the batch returns once the graphs list what it made", async () => {
    // The graph of a thought that has been read is a copy, behind a create
    // for a moment. A second run sent then made the children again as well:
    // 5 of 6 on the live API.
    for (const reads of [1, 3]) {
      const fake = fakeBrain([{ id: ROOT, name: "root" }]);
      fake.lag.reads = reads;
      const first = await ingest(fake.api, BRAIN, plan);
      const sizeAfterFirst = fake.thoughts.size;

      const second = await ingest(fake.api, BRAIN, plan);
      expect(second.created, `copy stale for ${reads} reads`).toEqual([]);
      expect(second.reused).toHaveLength(7);
      expect(fake.thoughts.size).toBe(sizeAfterFirst);
      expect(first.unlisted).toBe(0);
    }
  });

  it("with deduplication off the batch waits for the graphs all the same", async () => {
    // The copy may be from a read made before the batch, by anything.
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    await fake.api.thoughts.getGraph(BRAIN, ROOT);
    await ingest(fake.api, BRAIN, { ...plan, deduplicate: false });
    const sizeAfterFirst = fake.thoughts.size;

    const second = await ingest(fake.api, BRAIN, plan);
    expect(second.created).toEqual([]);
    expect(fake.thoughts.size).toBe(sizeAfterFirst);
  });

  it("each existing thought is read once to look next to it, and a thought the batch created never", async () => {
    // Nothing can be next to a thought made a moment ago, and a read that
    // can find nothing could only fail the thoughts under it.
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    fake.lag.reads = 0;
    await ingest(fake.api, BRAIN, plan);
    // Once to look for the four thoughts next to ROOT, once to see them listed.
    expect(fake.graphReads).toEqual([ROOT, ROOT]);

    // A second run reads each thought it found, since something may be there.
    fake.graphReads.length = 0;
    const second = await ingest(fake.api, BRAIN, plan);
    const top = second.reused.find((r) => r.tempId === "top")!.thoughtId;
    expect(fake.graphReads).toEqual([ROOT, top]);
  });

  it("a graph that never lists what was made is waited for six seconds, and the outcome says how many it lacks", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeBrain([{ id: ROOT, name: "root" }]);
      fake.lag.reads = Infinity;
      const pending = ingest(fake.api, BRAIN, plan);
      await vi.advanceTimersByTimeAsync(PAST_THE_WAIT);
      const outcome = await pending;

      // The four next to ROOT. Those next to "top" hang on a thought made
      // here, whose graph nothing has read.
      expect(outcome.unlisted).toBe(4);
      expect(outcome.created).toHaveLength(7);
      expect(outcome.failures).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the same name under two thoughts is two thoughts, each found again", async () => {
    // A thought is looked for next to its own parent alone. One thought in
    // two places is one plan item and a link.
    const A = "aaaaaaaa-1111-4000-8000-00000000000a";
    const B = "bbbbbbbb-1111-4000-8000-00000000000b";
    const fake = fakeBrain([
      { id: A, name: "A" },
      { id: B, name: "B" },
    ]);
    const both: IngestPlan = {
      thoughts: [
        { tempId: "x", name: "Same", parent: A, relation: "child" },
        { tempId: "y", name: "Same", parent: B, relation: "jump" },
      ],
    };
    const first = await ingest(fake.api, BRAIN, both);
    expect(first.created).toHaveLength(2);

    const second = await ingest(fake.api, BRAIN, both);
    expect(second.created).toEqual([]);
    expect(second.reused.map((r) => r.thoughtId)).toEqual(first.created.map((c) => c.thoughtId));
  });
});

describe("a thought of the same name under another relation", () => {
  const THERE = "dddddddd-0000-4000-8000-000000000004";
  const RELATIONS = ["child", "parent", "jump"] as const;
  /** A brain where ROOT has a thought named "Same" as its `have`. */
  const brain = (have: (typeof RELATIONS)[number]) =>
    fakeBrain([
      { id: ROOT, name: "root" },
      {
        id: THERE,
        name: "Same",
        ...(have === "child" && { parent: ROOT }),
        ...(have === "parent" && { parentOf: ROOT }),
        ...(have === "jump" && { jumpOf: ROOT }),
      },
    ]);
  const refusal = (tempId: string, asked: string, found: string, id: string = THERE): string =>
    `${ROOT} already has a thought of this name as its ${found}, ${id}, and the plan asks ` +
    `for a ${asked}. It was not taken for the same thought, and no second one was made. ` +
    `To use it, name ${id} where the plan has "${tempId}"; to make another of that name, ` +
    "send this thought in a plan with deduplicate set to false";

  it("is neither reused nor made a second time: the thought fails with the identifier, and what hangs on it is skipped", async () => {
    // What was there as a child used to be taken for the plan's parent or
    // jump, without a word. What was there as a parent or a jump was not
    // seen, and a second thought of the name was made.
    for (const have of RELATIONS) {
      for (const asked of RELATIONS.filter((r) => r !== have)) {
        const fake = brain(have);
        const outcome = await ingest(fake.api, BRAIN, {
          thoughts: [
            { tempId: "x", name: " Same ", parent: ROOT, relation: asked, note: "mine" },
            { tempId: "leaf", name: "Leaf", parent: "x" },
            { tempId: "side", name: "Side", parent: ROOT },
          ],
        });
        const where = `there as ${have}, asked for as ${asked}`;

        expect(said(outcome), where).toEqual([
          { what: 'thought " Same " (x)', reason: refusal("x", asked, have) },
        ]);
        expect(outcome.skipped, where).toEqual([
          { what: 'thought "Leaf" (leaf)', reason: 'depends on "x", which was not created' },
        ]);
        expect(outcome.reused, where).toEqual([]);
        expect(outcome.created.map((c) => c.tempId), where).toEqual(["side"]);
        expect(fake.thoughts.get(THERE)?.note, where).toBe("");
        expect(fake.thoughts.size, where).toBe(3);
      }
    }
  });

  it("the same relation is the same thought, as before", async () => {
    for (const have of RELATIONS) {
      const fake = brain(have);
      const outcome = await ingest(fake.api, BRAIN, {
        thoughts: [{ tempId: "x", name: "Same", parent: ROOT, relation: have }],
      });
      expect(outcome.reused, have).toEqual([
        { tempId: "x", thoughtId: THERE, name: "Same", kind: 1 },
      ]);
      expect(outcome.failures, have).toEqual([]);
    }
  });

  it("two plan items of one name under one thought: the first is made, the other fails naming it, on every run", async () => {
    // Two thoughts share one link, so a thought is not a child and a jump of
    // the same one. The second item used to be listed as existing, whichever
    // of the two had won the race to be created.
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    const twice: IngestPlan = {
      thoughts: [
        { tempId: "x", name: "Same", parent: ROOT, relation: "jump" },
        { tempId: "y", name: "Same", parent: ROOT, relation: "child" },
        { tempId: "z", name: "Same", parent: ROOT, relation: "jump" },
      ],
    };
    const first = await ingest(fake.api, BRAIN, twice);
    const made = first.created[0]!.thoughtId;
    expect(first.created.map((c) => c.tempId)).toEqual(["x"]);
    expect(first.reused).toEqual([{ tempId: "z", thoughtId: made, name: "Same" }]);
    expect(said(first)).toEqual([
      { what: 'thought "Same" (y)', reason: refusal("y", "child", "jump", made) },
    ]);
    expect(fake.lists.get(ROOT)).toEqual({ children: [], parents: [], jumps: [made] });

    const second = await ingest(fake.api, BRAIN, twice);
    expect(second.created).toEqual([]);
    expect(second.reused.map((r) => r.tempId)).toEqual(["x", "z"]);
    expect(second.failures).toEqual(first.failures);
    expect(fake.thoughts.size).toBe(2);
  });

  it("with deduplication off the second one is made, as asked", async () => {
    const fake = brain("jump");
    const outcome = await ingest(fake.api, BRAIN, {
      thoughts: [{ tempId: "x", name: "Same", parent: ROOT, relation: "child" }],
      deduplicate: false,
    });
    expect(outcome.created).toHaveLength(1);
    expect(outcome.failures).toEqual([]);
    expect(fake.lists.get(ROOT)!.children).toEqual([outcome.created[0]!.thoughtId]);
    expect(fake.lists.get(ROOT)!.jumps).toEqual([THERE]);
  });
});

describe("two thoughts of one name in one list", () => {
  const ONE = "dddddddd-0000-4000-8000-000000000004";
  const TWO = "dddddddd-0000-4000-8000-000000000044";
  const RELATIONS = ["child", "parent", "jump"] as const;
  /** A brain where ROOT has two thoughts named "Same" as its `have`. */
  const brain = (have: (typeof RELATIONS)[number]) =>
    fakeBrain(
      [ONE, TWO].map((id) => ({
        id,
        name: "Same",
        ...(have === "child" && { parent: ROOT }),
        ...(have === "parent" && { parentOf: ROOT }),
        ...(have === "jump" && { jumpOf: ROOT }),
      })).concat([{ id: ROOT, name: "root" }]),
    );
  const plan = (relation: (typeof RELATIONS)[number]): IngestPlan => ({
    thoughts: [
      { tempId: "x", name: "Same", parent: ROOT, relation, note: "mine", aliases: ["S"] },
      { tempId: "leaf", name: "Leaf", parent: "x" },
      { tempId: "side", name: "Side", parent: ROOT },
    ],
  });

  it("under the plan's relation neither is taken and no third is made: the thought fails with both identifiers", async () => {
    // The last the graph listed used to be taken, with the plan's children,
    // aliases and note, and the result said nothing of the other.
    for (const relation of RELATIONS) {
      const fake = brain(relation);
      for (const run of ["first", "second"]) {
        const outcome = await ingest(fake.api, BRAIN, plan(relation));
        const where = `${relation}, ${run} run`;

        expect(said(outcome), where).toEqual([
          {
            what: 'thought "Same" (x)',
            reason:
              `${ROOT} has 2 thoughts of this name as its ${relation}: ${ONE} and ${TWO}. ` +
              "Which of them the plan means was not decided: none was taken, and no further " +
              "one was made. To use one of them, name its identifier where the plan has " +
              '"x"; to make another of that name, send this thought in a plan with ' +
              "deduplicate set to false",
          },
        ]);
        expect(outcome.skipped, where).toEqual([
          { what: 'thought "Leaf" (leaf)', reason: 'depends on "x", which was not created' },
        ]);
        // "Side" hangs on neither: made by the first run, found by the second.
        expect(
          [outcome.created.map((c) => c.tempId), outcome.reused.map((r) => r.tempId)],
          where,
        ).toEqual(run === "first" ? [["side"], []] : [[], ["side"]]);
      }
      // Neither was given the plan's note or alias, and "Leaf" was made under neither.
      for (const id of [ONE, TWO]) {
        expect([fake.thoughts.get(id)?.note, fake.thoughts.get(id)?.aliases], relation).toEqual([
          "",
          [],
        ]);
      }
      expect([...fake.thoughts.values()].map((t) => t.name).sort(), relation).toEqual([
        "Same",
        "Same",
        "Side",
        "root",
      ]);
    }
  });

  it("the way out it names works: named by its identifier, one of them takes what the plan hangs on it", async () => {
    const fake = brain("child");
    const outcome = await ingest(fake.api, BRAIN, {
      thoughts: [{ tempId: "leaf", name: "Leaf", parent: TWO }],
    });

    expect(outcome.failures).toEqual([]);
    expect(fake.lists.get(TWO)?.children).toEqual([outcome.created[0]!.thoughtId]);
  });

  it("with deduplication off a third is made, as asked", async () => {
    const fake = brain("child");
    const outcome = await ingest(fake.api, BRAIN, {
      thoughts: [{ tempId: "x", name: "Same", parent: ROOT }],
      deduplicate: false,
    });

    expect(outcome.failures).toEqual([]);
    expect(fake.lists.get(ROOT)!.children).toEqual([ONE, TWO, outcome.created[0]!.thoughtId]);
  });

  it("two of the name under another relation are both named, and neither is taken", async () => {
    const fake = brain("jump");
    const outcome = await ingest(fake.api, BRAIN, plan("child"));

    expect(said(outcome)).toEqual([
      {
        what: 'thought "Same" (x)',
        reason:
          `${ROOT} already has 2 thoughts of this name as its jump, ${ONE} and ${TWO}, and ` +
          "the plan asks for a child. None was taken for the same thought, and no further " +
          'one was made. To use one of them, name its identifier where the plan has "x"; ' +
          "to make another of that name, send this thought in a plan with deduplicate set " +
          "to false",
      },
    ]);
    expect(outcome.reused).toEqual([]);
    expect(fake.lists.get(ROOT)!.children.map((id) => fake.thoughts.get(id)?.name)).toEqual([
      "Side",
    ]);
  });

  it("one of the name under the plan's relation is the plan's thought, whatever else is named so elsewhere", async () => {
    // As it was: the plan's own relation is looked in first.
    const fake = fakeBrain([
      { id: ROOT, name: "root" },
      { id: ONE, name: "Same", parent: ROOT },
      { id: TWO, name: "Same", jumpOf: ROOT },
    ]);
    const outcome = await ingest(fake.api, BRAIN, {
      thoughts: [{ tempId: "x", name: "Same", parent: ROOT }],
    });

    expect(outcome.reused.map((r) => r.thoughtId)).toEqual([ONE]);
    expect(outcome.failures).toEqual([]);
  });
});

describe("a plan sent straight after another write of this process", () => {
  /**
   * A brain where the graph of ROOT has been read, and a thought named "New"
   * was made under it a moment ago by another tool: the copy that graph is
   * answered from lacks it for 200 ms, as the API's does for up to 205.
   */
  const brain = async () => {
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    Object.assign(fake.lag, { reads: 0, ms: 200 });
    await fake.api.thoughts.getGraph(BRAIN, ROOT);
    const made = await fake.api.thoughts.create(BRAIN, { name: "New", sourceThoughtId: ROOT });
    fake.graphReads.length = 0;
    return { fake, made };
  };
  const plan: IngestPlan = { thoughts: [{ tempId: "n", name: "New", parent: ROOT }] };
  const run = async (fake: ReturnType<typeof fakeBrain>, of: IngestPlan = plan) => {
    const pending = ingest(fake.api, BRAIN, of);
    await vi.advanceTimersByTimeAsync(PAST_THE_WAIT);
    return pending;
  };

  it("waits out the time a graph's copy can be behind before it looks, and finds the thought", async () => {
    // brain_create_thought, brain_link and a rename return at once, and a
    // plan sent straight after one read the copy from before it: the thought
    // was made a second time, on a live TheBrain 25 times in 300.
    vi.useFakeTimers();
    try {
      const { fake, made } = await brain();
      fake.idle.ms = 0;
      const pending = ingest(fake.api, BRAIN, plan);
      // Not before the 300 ms are over,
      await vi.advanceTimersByTimeAsync(299);
      expect(fake.graphReads).toEqual([]);
      // and then at once.
      await vi.advanceTimersByTimeAsync(1);
      const outcome = await pending;

      expect(outcome.reused.map((r) => r.thoughtId)).toEqual([made]);
      expect(outcome.created).toEqual([]);
      expect(fake.thoughts.size).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits only for what is left of that time", async () => {
    vi.useFakeTimers();
    try {
      const { fake } = await brain();
      fake.idle.ms = 220;
      const pending = ingest(fake.api, BRAIN, plan);
      await vi.advanceTimersByTimeAsync(79);
      expect(fake.graphReads).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(fake.graphReads.length).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(PAST_THE_WAIT);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a write that came back long enough ago costs no wait", async () => {
    vi.useFakeTimers();
    try {
      for (const ms of [300, 5000, Number.POSITIVE_INFINITY]) {
        const { fake } = await brain();
        fake.idle.ms = ms;
        // The copy has had its time by then too.
        await vi.advanceTimersByTimeAsync(200);
        const waiting = vi.getTimerCount();
        const outcome = await ingest(fake.api, BRAIN, plan);

        expect(vi.getTimerCount(), String(ms)).toBe(waiting);
        expect(outcome.created, String(ms)).toEqual([]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("a plan that looks next to no existing thought does not wait, nor one with deduplication off", async () => {
    vi.useFakeTimers();
    try {
      for (const of of [
        // Nothing is looked for: a thought with no parent, and what hangs on it.
        { thoughts: [{ tempId: "top", name: "Top" }, { tempId: "n", name: "New", parent: "top" }] },
        { ...plan, deduplicate: false },
      ] satisfies IngestPlan[]) {
        const { fake } = await brain();
        fake.idle.ms = 0;
        const started = Date.now();
        const sentAt: number[] = [];
        const create = fake.api.thoughts.create.bind(fake.api.thoughts);
        vi.spyOn(fake.api.thoughts, "create").mockImplementation((...args) => {
          sentAt.push(Date.now() - started);
          return create(...args);
        });
        const outcome = await run(fake, of);

        expect(outcome.failures).toEqual([]);
        // No 300 ms ahead of the first write: it went out at once.
        expect(sentAt[0]).toBe(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("a create that got no answer is found by the run that follows at once", async () => {
    // A batch waits for the graphs to list what it knows it made, and of
    // this thought it has no identifier: the same plan sent again read the
    // copy from before it, and made the thought a second time, 6 times of 6.
    vi.useFakeTimers();
    try {
      const fake = fakeBrain([{ id: ROOT, name: "root" }]);
      Object.assign(fake.lag, { reads: 0, ms: 200 });
      fake.lostOn.add("New");
      // It has nothing to wait for, and returns with no time gone by.
      const first = await ingest(fake.api, BRAIN, plan);
      expect(said(first)).toEqual([
        { what: 'thought "New" (n)', reason: "request exceeded 30000 ms", unanswered: true },
      ]);

      fake.lostOn.clear();
      // What the client says straight after that request came back.
      fake.idle.ms = 0;
      const second = await run(fake);
      expect(second.created).toEqual([]);
      expect(second.reused).toHaveLength(1);
      expect(fake.thoughts.size).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a graph that is behind a write of this process for longer than the wait by the clock", () => {
  // The wait was the whole of the guard: 300 ms from the last write, and the
  // copy a graph is answered from can be further behind: on a live TheBrain
  // it was first seen to list a new thought 364 ms after the create's
  // answer. Then the plan does not see the thought another call made a
  // moment before, and makes it again. What this process wrote next to a
  // thought is known to it, so the graph is read until it shows that.
  const OTHER = "cccccccc-0000-4000-8000-000000000003";
  const THERE = "dddddddd-0000-4000-8000-000000000004";
  const plan: IngestPlan = { thoughts: [{ tempId: "n", name: "New", parent: ROOT }] };
  /** A brain whose graphs, once read, lack a write for `ms`; ROOT's has been read. */
  const brain = async (ms: number, existing: Parameters<typeof fakeBrain>[0] = []) => {
    const fake = fakeBrain([{ id: ROOT, name: "root" }, ...existing]);
    Object.assign(fake.lag, { reads: 0, ms });
    await fake.api.thoughts.getGraph(BRAIN, ROOT);
    return fake;
  };
  /** The plan run to its end, with how long it took by the clock. */
  const timed = async (fake: ReturnType<typeof fakeBrain>, of: IngestPlan = plan) => {
    fake.graphReads.length = 0;
    const started = Date.now();
    let took = -1;
    const pending = ingest(fake.api, BRAIN, of).then((outcome) => {
      took = Date.now() - started;
      return outcome;
    });
    await vi.advanceTimersByTimeAsync(20_000);
    return { outcome: await pending, took };
  };
  const readsOf = (fake: ReturnType<typeof fakeBrain>, id: string): number =>
    fake.graphReads.filter((read) => read === id).length;

  it("is read again until it lists the thought another call made, and the thought is found", async () => {
    vi.useFakeTimers();
    try {
      const fake = await brain(900);
      const made = await fake.api.thoughts.create(BRAIN, { name: "New", sourceThoughtId: ROOT });
      fake.idle.ms = 0;
      const { outcome, took } = await timed(fake);

      expect(outcome.reused.map((r) => r.thoughtId)).toEqual([made]);
      expect([outcome.created, outcome.failures]).toEqual([[], []]);
      expect(fake.thoughts.size).toBe(2);
      // First at 300 ms, by the clock, and then a step apart until 900.
      expect(took).toBe(900);
      expect(readsOf(fake, ROOT)).toBe(1 + 600 / 25);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is known for one by what it lacks, not by the clock: with the last write long past it is read again all the same", async () => {
    // What the clock stands for is this process's last write, and a copy
    // can be behind an older one.
    vi.useFakeTimers();
    try {
      const fake = await brain(150);
      const made = await fake.api.thoughts.create(BRAIN, { name: "New", sourceThoughtId: ROOT });
      fake.idle.ms = Number.POSITIVE_INFINITY;
      const { outcome, took } = await timed(fake);

      expect(outcome.reused.map((r) => r.thoughtId)).toEqual([made]);
      expect(outcome.created).toEqual([]);
      expect(took).toBe(150);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is read again for a thought another call made a parent or a jump of it, in the list that relation puts it in", async () => {
    vi.useFakeTimers();
    try {
      for (const [relation, number] of [
        ["parent", 2],
        ["jump", 3],
      ] as const) {
        const fake = await brain(900);
        const made = await fake.api.thoughts.create(BRAIN, {
          name: "New",
          sourceThoughtId: ROOT,
          relation: number,
        });
        fake.idle.ms = 0;
        const { outcome, took } = await timed(fake, {
          thoughts: [{ tempId: "n", name: "New", parent: ROOT, relation }],
        });

        expect(outcome.reused.map((r) => r.thoughtId), relation).toEqual([made]);
        expect(outcome.created, relation).toEqual([]);
        expect(took, relation).toBe(900);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("is read again for a thought another call linked there, from either end", async () => {
    // After brain_link the thought was made again 14 times in 100.
    vi.useFakeTimers();
    try {
      for (const ends of ["root first", "root second"] as const) {
        const fake = await brain(900, [{ id: THERE, name: "New" }]);
        await fake.api.links.create(
          BRAIN,
          ends === "root first"
            ? { thoughtIdA: ROOT, thoughtIdB: THERE, relation: 1 }
            : { thoughtIdA: THERE, thoughtIdB: ROOT, relation: 2 },
        );
        fake.idle.ms = 0;
        const { outcome, took } = await timed(fake);

        expect(outcome.reused.map((r) => r.thoughtId), ends).toEqual([THERE]);
        expect(outcome.created, ends).toEqual([]);
        expect(took, ends).toBe(900);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("is read again while it lists a thought under the name it had before another call renamed it", async () => {
    // After a rename the thought was made again under its new name 3 times in 100.
    vi.useFakeTimers();
    try {
      const fake = await brain(900, [{ id: THERE, name: "Old", parent: ROOT }]);
      // The copy lists it, under the name it has.
      await vi.advanceTimersByTimeAsync(1000);
      await fake.api.thoughts.getGraph(BRAIN, ROOT);
      fake.rename(THERE, "New");
      fake.idle.ms = 0;
      const { outcome, took } = await timed(fake);

      expect(outcome.reused.map((r) => r.thoughtId)).toEqual([THERE]);
      expect(outcome.created).toEqual([]);
      expect(took).toBe(900);
      expect(fake.thoughts.size).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still behind when the wait for it runs out, it is not taken at its word: the thought fails, and nothing is made next to it", async () => {
    vi.useFakeTimers();
    try {
      // Behind past the wait, and not past the minute a write is kept.
      const fake = await brain(9000, [
        { id: OTHER, name: "other" },
        { id: THERE, name: "Side", parent: OTHER },
      ]);
      const made = await fake.api.thoughts.create(BRAIN, { name: "New", sourceThoughtId: ROOT });
      fake.idle.ms = 0;
      const { outcome, took } = await timed(fake, {
        thoughts: [
          ...plan.thoughts,
          { tempId: "leaf", name: "Leaf", parent: "n" },
          { tempId: "side", name: "Side", parent: OTHER },
        ],
      });

      expect(outcome.failures).toHaveLength(1);
      expect(outcome.failures[0]!.error).toBeInstanceOf(IngestBehindError);
      expect(said(outcome)).toEqual([
        {
          what: 'thought "New" (n)',
          reason:
            `${ROOT} was read for ${WAIT} ms to look for a thought of this name next to it, ` +
            "and its graph still does not show what this server wrote a moment ago: " +
            `${made} among its children. TheBrain answers a graph from a copy, and this ` +
            "one is behind, so a thought of this name may be there unseen: nothing was " +
            "created. Send this thought again in a few seconds",
        },
      ]);
      expect(outcome.skipped).toEqual([
        { what: 'thought "Leaf" (leaf)', reason: 'depends on "n", which was not created' },
      ]);
      // What hangs on another thought goes on, and nothing is made under ROOT.
      expect(outcome.reused.map((r) => [r.tempId, r.thoughtId])).toEqual([["side", THERE]]);
      expect(outcome.created).toEqual([]);
      expect(fake.lists.get(ROOT)!.children).toEqual([made]);
      // The 300 ms by the clock and the 6 s the graph is asked for, the pause
      // doubling each second from 25 ms to 400: 40, 20, 10, 5, 3 and 2 reads,
      // and one at the end, as many as two seconds at 25 ms were.
      expect(took).toBe(300 + WAIT);
      expect(readsOf(fake, ROOT)).toBe(40 + 20 + 10 + 5 + 3 + 2 + 1);

      // Sent again once the copy has caught up, it finds the thought.
      await vi.advanceTimersByTimeAsync(4000);
      fake.idle.ms = Number.POSITIVE_INFINITY;
      const again = await timed(fake);
      expect(again.outcome.reused.map((r) => r.thoughtId)).toEqual([made]);
      expect(again.outcome.created).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it("a graph behind for longer than ten seconds still fails the thought, and does not make it twice", async () => {
    // Reads have lagged writes 1 to 30 s while another brain took bursts of
    // them. The client kept a write for ten seconds, and a plan sent past
    // them took the graph at its word and made the thought a second time.
    vi.useFakeTimers();
    try {
      const fake = await brain(30_000);
      const made = await fake.api.thoughts.create(BRAIN, { name: "New", sourceThoughtId: ROOT });
      await vi.advanceTimersByTimeAsync(20_000);
      fake.idle.ms = Number.POSITIVE_INFINITY;
      const { outcome } = await timed(fake);

      expect(outcome.failures.map((f) => f.error)).toEqual([expect.any(IngestBehindError)]);
      expect(outcome.created).toEqual([]);
      expect(fake.lists.get(ROOT)!.children).toEqual([made]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("costs no read when the first one shows the write, and none for a write next to another thought", async () => {
    vi.useFakeTimers();
    try {
      // The copy has caught up by the time the clock lets the plan look.
      const fake = await brain(200, [{ id: OTHER, name: "other" }]);
      const made = await fake.api.thoughts.create(BRAIN, { name: "New", sourceThoughtId: ROOT });
      fake.idle.ms = 0;
      const first = await timed(fake);
      expect(first.outcome.reused.map((r) => r.thoughtId)).toEqual([made]);
      expect([first.took, readsOf(fake, ROOT)]).toEqual([300, 1]);

      // A write next to OTHER, whose graph stays behind: ROOT's is not held to it.
      Object.assign(fake.lag, { reads: 0, ms: 6000 });
      await fake.api.thoughts.getGraph(BRAIN, OTHER);
      await fake.api.thoughts.create(BRAIN, { name: "Else", sourceThoughtId: OTHER });
      fake.idle.ms = Number.POSITIVE_INFINITY;
      const second = await timed(fake);
      expect(second.outcome.reused.map((r) => r.thoughtId)).toEqual([made]);
      expect([second.took, readsOf(fake, ROOT)]).toEqual([0, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is not held to a thought this process deleted since, nor to a write it has stopped keeping", async () => {
    // A plan that lands on a thought the copy has, so that nothing is made
    // and the batch has no graph of its own to wait for.
    const lands: IngestPlan = { thoughts: [{ tempId: "t", name: "There", parent: ROOT }] };
    const there = [{ id: THERE, name: "There", parent: ROOT }];
    vi.useFakeTimers();
    try {
      // Deleted by another call: `thoughts.delete()` has the client forget it.
      const fake = await brain(6000, there);
      const gone = await fake.api.thoughts.create(BRAIN, { name: "Gone", sourceThoughtId: ROOT });
      fake.written.forget(BRAIN, gone);
      fake.idle.ms = Number.POSITIVE_INFINITY;
      const first = await timed(fake, lands);
      expect(first.outcome.reused.map((r) => r.thoughtId)).toEqual([THERE]);
      expect(first.outcome.failures).toEqual([]);
      expect([first.took, readsOf(fake, ROOT)]).toEqual([0, 1]);

      // Kept for a minute, and no longer: past that a graph is believed.
      const late = await brain(2 * WRITTEN_KEPT_MS, there);
      await late.api.thoughts.create(BRAIN, { name: "New", sourceThoughtId: ROOT });
      await vi.advanceTimersByTimeAsync(WRITTEN_KEPT_MS + 1);
      late.idle.ms = Number.POSITIVE_INFINITY;
      const second = await timed(late, lands);
      expect(second.outcome.reused.map((r) => r.thoughtId)).toEqual([THERE]);
      expect(second.outcome.failures).toEqual([]);
      expect([second.took, readsOf(late, ROOT)]).toEqual([0, 1]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a read that fails while a thought is looked for", () => {
  const THERE = "dddddddd-0000-4000-8000-000000000004";
  const OTHER = "cccccccc-0000-4000-8000-000000000003";
  const brain = () =>
    fakeBrain([
      { id: ROOT, name: "root" },
      { id: OTHER, name: "other" },
      { id: THERE, name: "Top", parent: ROOT },
    ]);
  const plan: IngestPlan = {
    thoughts: [
      { tempId: "top", name: "Top", parent: ROOT, note: "summary" },
      { tempId: "leaf", name: "Leaf", parent: "top" },
      { tempId: "side", name: "Side", parent: OTHER },
    ],
    links: [{ from: "leaf", to: "side" }],
  };
  const unread = (words: string): string =>
    `${ROOT} could not be read to look for a thought of this name next to it, ` +
    `so nothing was created: ${words}`;

  it("does not pass for nothing found: the thought fails, what hangs on it is skipped, and the next run finds the one that was there", async () => {
    // The failure used to be swallowed and read as "no children", and the
    // thought was created beside the one of its name.
    const fake = brain();
    fake.failGraph.set(ROOT, [new TheBrainError("server", "boom", { status: 500 })]);
    const first = await ingest(fake.api, BRAIN, plan);

    expect(said(first)).toEqual([{ what: 'thought "Top" (top)', reason: unread("boom") }]);
    expect(first.skipped).toEqual([
      { what: 'thought "Leaf" (leaf)', reason: 'depends on "top", which was not created' },
      { what: "link leaf -> side", reason: 'depends on "top", which was not created' },
    ]);
    // The branch that hangs on another thought is written.
    expect(first.created.map((c) => c.tempId)).toEqual(["side"]);
    expect(fake.lists.get(ROOT)!.children).toEqual([THERE]);
    expect(fake.thoughts.get(THERE)?.note).toBe("");

    const second = await ingest(fake.api, BRAIN, plan);
    expect(second.reused.map((r) => [r.tempId, r.thoughtId])).toContainEqual(["top", THERE]);
    expect(second.created.map((c) => c.tempId)).toEqual(["leaf"]);
    expect(second.failures).toEqual([]);
    expect(fake.lists.get(ROOT)!.children).toEqual([THERE]);
  });

  it("the generic 403 for a thought that is there is a failed read, not an identifier nobody has", async () => {
    // The graph of an identifier nobody has answers with these words, and so
    // does a request the API drops under load. The thought itself tells them
    // apart: it reads, so nobody has said it is not there.
    const fake = brain();
    fake.failGraph.set(ROOT, [new TheBrainError("forbidden", GENERIC_403, { status: 403 })]);
    const outcome = await ingest(fake.api, BRAIN, plan);

    expect(said(outcome)).toEqual([
      { what: 'thought "Top" (top)', reason: unread(GENERIC_403) },
    ]);
    expect(fake.lists.get(ROOT)!.children).toEqual([THERE]);
  });

  it("every thought that was waiting on the read fails with it, and none is created", async () => {
    const fake = brain();
    fake.failGraph.set(ROOT, [new TheBrainError("server", "boom", { status: 500 })]);
    const outcome = await ingest(fake.api, BRAIN, {
      thoughts: [
        { tempId: "a", name: "A", parent: ROOT },
        { tempId: "b", name: "B", parent: ROOT, relation: "jump" },
      ],
    });

    expect(outcome.failures.map((f) => f.what)).toEqual(['thought "A" (a)', 'thought "B" (b)']);
    expect(outcome.created).toEqual([]);
    expect(fake.graphReads).toEqual([ROOT]);
    expect(fake.thoughts.size).toBe(3);
  });

  it("a failed read is not kept: the next thought there asks again", async () => {
    const fake = brain();
    fake.lag.reads = 0;
    fake.failGraph.set(THERE, [new TheBrainError("server", "boom", { status: 500 })]);
    // "top" lands on THERE. "again" asks for its graph first and fails with
    // the read; "leaf", a level later, has it read anew.
    const outcome = await ingest(fake.api, BRAIN, {
      thoughts: [
        { tempId: "again", name: "Again", parent: THERE },
        { tempId: "top", name: "Top", parent: ROOT },
        { tempId: "leaf", name: "Leaf", parent: "top" },
      ],
    });

    expect(outcome.failures.map((f) => f.what)).toEqual(['thought "Again" (again)']);
    expect(outcome.created.map((c) => c.tempId)).toEqual(["leaf"]);
    // The read that failed, the one that did not, and the one that saw "Leaf" listed.
    expect(fake.graphReads.filter((id) => id === THERE)).toHaveLength(3);
  });
});

describe("a read that fails while the batch waits for the graphs", () => {
  const OTHER = "cccccccc-0000-4000-8000-000000000003";
  const boom = new TheBrainError("server", "boom", { status: 500 });
  const plan: IngestPlan = {
    thoughts: [
      { tempId: "a", name: "A", parent: ROOT },
      { tempId: "b", name: "B", parent: ROOT, relation: "jump" },
      { tempId: "c", name: "C", parent: OTHER },
    ],
  };
  const brain = () =>
    fakeBrain([
      { id: ROOT, name: "root" },
      { id: OTHER, name: "other" },
    ]);
  /** What the reads of one graph throw: nothing for the first `answered`, then `error` each time. */
  const failingAfter = (answered: number, error: Error, times = Infinity): Error[] => {
    let reads = 0;
    return Object.assign([] as Error[], {
      shift: () => ((reads += 1) > answered && reads <= answered + times ? error : undefined),
    });
  };

  it("a graph that cannot be read to the end of the wait is named as that, and not counted as one that lists nothing", async () => {
    // A read that failed used to count as a graph that had answered and
    // listed nothing: `unlisted` was 2, of a graph nothing had read.
    vi.useFakeTimers();
    try {
      const fake = brain();
      // Read once, to look for "A" and "B"; every read after the writes fails.
      fake.failGraph.set(ROOT, failingAfter(1, boom));
      const pending = ingest(fake.api, BRAIN, plan);
      await vi.advanceTimersByTimeAsync(PAST_THE_WAIT);
      const outcome = await pending;

      expect(outcome.listingUnread).toEqual([{ thoughtId: ROOT, made: 2, error: boom }]);
      // "C" is listed next to OTHER, whose graph answered.
      expect(outcome.unlisted).toBe(0);
      // Nothing the plan asked for failed by it.
      expect(outcome.created.map((c) => c.tempId)).toEqual(["a", "b", "c"]);
      expect([outcome.failures, outcome.skipped]).toEqual([[], []]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a graph that answers and does not list is counted as it was, beside one that could not be read", async () => {
    vi.useFakeTimers();
    try {
      const fake = brain();
      // Every graph that has been read stays as it was read, to the end.
      fake.lag.reads = Infinity;
      fake.failGraph.set(OTHER, failingAfter(1, boom));
      const pending = ingest(fake.api, BRAIN, plan);
      await vi.advanceTimersByTimeAsync(PAST_THE_WAIT);
      const outcome = await pending;

      expect(outcome.unlisted).toBe(2);
      expect(outcome.listingUnread).toEqual([{ thoughtId: OTHER, made: 1, error: boom }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a read that fails and is then answered is a wait like any other", async () => {
    // The wait goes on past a failure, as it did: the next read may get through.
    const fake = brain();
    fake.failGraph.set(ROOT, failingAfter(1, boom, 2));
    const outcome = await ingest(fake.api, BRAIN, plan);

    expect(outcome.unlisted).toBe(0);
    expect(outcome.listingUnread).toEqual([]);
    // Looked next to, failed twice, read from the copy, then read with them listed.
    expect(fake.graphReads.filter((id) => id === ROOT).length).toBeGreaterThanOrEqual(4);
  });

  it("with every graph read there is nothing unread", async () => {
    const outcome = await ingest(brain().api, BRAIN, plan);
    expect(outcome.unlisted).toBe(0);
    expect(outcome.listingUnread).toEqual([]);
  });

  /** When each read of ROOT's graph was sent, in ms from the start of the batch. */
  const readsOfRoot = (fake: ReturnType<typeof brain>): number[] => {
    const started = Date.now();
    const at: number[] = [];
    const getGraph = fake.api.thoughts.getGraph.bind(fake.api.thoughts);
    vi.spyOn(fake.api.thoughts, "getGraph").mockImplementation((b, id) => {
      if (id === ROOT) at.push(Date.now() - started);
      return getGraph(b, id);
    });
    return at;
  };

  it("a graph that fails is asked again after twice the pause each time, to the end of the wait", async () => {
    // Asked again a step later every time, it was read 74 to 78 times in the
    // two seconds: 76 times of 76 on a live TheBrain with a 500 put in.
    vi.useFakeTimers();
    try {
      const fake = brain();
      fake.failGraph.set(ROOT, failingAfter(1, boom));
      const at = readsOfRoot(fake);
      const pending = ingest(fake.api, BRAIN, plan);
      await vi.advanceTimersByTimeAsync(PAST_THE_WAIT);
      const outcome = await pending;

      // The first read looks next to ROOT; the others wait for its graph.
      expect(at).toEqual([
        0, 0, 50, 150, 350, 750, 1150, 1550, 1950, 2350, 2750, 3150, 3550, 3950, 4350, 4750,
        5150, 5550, 5950, 6000,
      ]);
      expect(outcome.listingUnread).toEqual([{ thoughtId: ROOT, made: 2, error: boom }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a graph that answers and does not list yet is asked again a step later, as it was", async () => {
    vi.useFakeTimers();
    try {
      const fake = brain();
      fake.lag.reads = 3;
      const at = readsOfRoot(fake);
      const pending = ingest(fake.api, BRAIN, plan);
      await vi.advanceTimersByTimeAsync(PAST_THE_WAIT);
      const outcome = await pending;

      expect(at).toEqual([0, 0, 25, 50, 75]);
      expect([outcome.unlisted, outcome.listingUnread]).toEqual([0, []]);
    } finally {
      vi.useRealTimers();
    }
  });

  /** A batch whose graphs stop answering once the last of its `creates` thoughts is sent. */
  const hungAfterTheWrites = (
    fake: ReturnType<typeof fakeBrain>,
    anchors: string[],
    creates: number,
  ): void => {
    let sent = 0;
    const create = fake.api.thoughts.create.bind(fake.api.thoughts);
    vi.spyOn(fake.api.thoughts, "create").mockImplementation((...args) => {
      if ((sent += 1) === creates) for (const id of anchors) fake.hungGraph.add(id);
      return create(...args);
    });
  };
  const NO_ANSWER =
    `the graph had not answered when the ${WAIT} ms a batch waits for the graphs to list ` +
    "what it made ran out";

  it("a graph that does not answer is given up on when the wait is over, and the batch returns", async () => {
    // The read used to be waited for to its own end. With the answer held
    // back 10 s on the way from a live TheBrain, a batch whose writes were
    // done took 10 s to say so, and the request's own limit is 30 s.
    vi.useFakeTimers();
    try {
      const fake = brain();
      hungAfterTheWrites(fake, [ROOT], 3);
      let outcome: IngestOutcome | undefined;
      void ingest(fake.api, BRAIN, plan).then((o) => (outcome = o));
      await vi.advanceTimersByTimeAsync(WAIT - 1);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);

      expect(outcome?.listingUnread).toEqual([
        { thoughtId: ROOT, made: 2, error: expect.objectContaining({ message: NO_ANSWER }) },
      ]);
      expect(outcome?.listingUnread[0]!.error).toBeInstanceOf(TheBrainError);
      // "C" is listed next to OTHER, whose graph answered, and no write failed.
      expect([outcome?.unlisted, outcome?.failures]).toEqual([0, []]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the wait is over for every graph at once, however many there are", async () => {
    // Six are asked at a time, and each used to have a wait of its own.
    vi.useFakeTimers();
    try {
      const anchors = Array.from({ length: 8 }, (_, i) => `cccccccc-0000-4000-8000-0000000000a${i}`);
      const fake = fakeBrain(anchors.map((id) => ({ id, name: `anchor ${id}` })));
      hungAfterTheWrites(fake, anchors, 8);
      let outcome: IngestOutcome | undefined;
      void ingest(fake.api, BRAIN, {
        thoughts: anchors.map((parent, i) => ({ tempId: `t${i}`, name: `T${i}`, parent })),
      }).then((o) => (outcome = o));
      await vi.advanceTimersByTimeAsync(WAIT - 1);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2);

      expect(outcome?.listingUnread.map((u) => u.thoughtId).sort()).toEqual(anchors);
      expect(outcome?.created).toHaveLength(8);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a thought that fails in the middle of a batch", () => {
  const OTHER = "dddddddd-0000-4000-8000-000000000004";
  const plan = (topParent: string = ROOT): IngestPlan => ({
    thoughts: [
      { tempId: "top", name: "Top", parent: topParent, note: "summary" },
      { tempId: "mid", name: "Mid", parent: "top", note: "body" },
      { tempId: "leaf", name: "Leaf", parent: "mid", tagIds: [TAG], aliases: ["L"] },
      { tempId: "side", name: "Side", parent: ROOT },
      { tempId: "sideleaf", name: "Side leaf", parent: "side", note: "kept" },
    ],
    links: [
      { from: "mid", to: "side", name: "relates" },
      { from: "leaf", to: "top" },
      { from: "sideleaf", to: ROOT, name: "back" },
    ],
  });
  const needs = (tempId: string): string => `depends on "${tempId}", which was not created`;
  type Fake = ReturnType<typeof fakeBrain>;
  /** The thoughts that hang under nothing, by name. */
  const roots = ({ thoughts }: Fake): string[] =>
    [...thoughts.values()].filter((t) => t.parent === undefined).map((t) => t.name);
  const names = ({ thoughts }: Fake): string[] => [...thoughts.values()].map((t) => t.name).sort();

  it("nothing is made under a thought that was not: what hangs on it is skipped, the rest written", async () => {
    // The thoughts under it used to be created with no parent and listed as
    // created, notes, tags and links to them included.
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    fake.failOn.add("Top");
    const outcome = await ingest(fake.api, BRAIN, plan());

    expect(roots(fake)).toEqual(["root"]);
    expect(names(fake)).toEqual(["Side", "Side leaf", "root"]);
    expect(outcome.created.map((c) => c.tempId)).toEqual(["side", "sideleaf"]);
    expect(said(outcome)).toEqual([{ what: 'thought "Top" (top)', reason: "server refused" }]);
    expect(outcome.skipped).toEqual([
      { what: 'thought "Mid" (mid)', reason: needs("top") },
      { what: 'thought "Leaf" (leaf)', reason: needs("top") },
      { what: "link mid -> side", reason: needs("top") },
      { what: "link leaf -> top", reason: needs("top") },
    ]);
    // The branch beside it is whole: its note, and its link to what exists.
    expect(outcome.notesWritten).toBe(1);
    expect(outcome.tagsAttached).toBe(0);
    expect(outcome.aliasesWritten).toBe(0);
    expect(outcome.linksCreated).toBe(1);
    expect(fake.links.map((l) => l.name)).toContain("back");
  });

  it("a failure at the second level takes only what is under it", async () => {
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    fake.failOn.add("Mid");
    const outcome = await ingest(fake.api, BRAIN, plan());

    expect(roots(fake)).toEqual(["root"]);
    expect(outcome.created.map((c) => c.tempId)).toEqual(["top", "side", "sideleaf"]);
    expect(said(outcome)).toEqual([{ what: 'thought "Mid" (mid)', reason: "server refused" }]);
    expect(outcome.skipped).toEqual([
      { what: 'thought "Leaf" (leaf)', reason: needs("mid") },
      { what: "link mid -> side", reason: needs("mid") },
      { what: "link leaf -> top", reason: needs("mid") },
    ]);
    expect(outcome.notesWritten).toBe(2);
    expect(outcome.tagsAttached).toBe(0);
  });

  it("a parent deleted since the plan was checked fails its thought with the API's words, and what hangs on it is skipped", async () => {
    // Read ahead of the writes it was there, and the plan was let through.
    // By the time the thought is looked for next to it nobody has it: its
    // graph is the generic 403 and its read a 404, so the create goes out to
    // be refused. A parent nobody had from the start never comes this far.
    const fake = fakeBrain([
      { id: ROOT, name: "root" },
      { id: OTHER, name: "doomed" },
    ]);
    fake.vanishing.add(OTHER);
    const outcome = await ingest(fake.api, BRAIN, plan(OTHER));

    expect(fake.parentReads).toContain(OTHER);
    expect(fake.thoughts.has(OTHER)).toBe(false);
    expect(roots(fake)).toEqual(["root"]);
    expect(said(outcome)).toEqual([
      { what: 'thought "Top" (top)', reason: `Source Thought ${OTHER} could not be located` },
    ]);
    expect(outcome.skipped.map((s) => s.what)).toEqual([
      'thought "Mid" (mid)',
      'thought "Leaf" (leaf)',
      "link mid -> side",
      "link leaf -> top",
    ]);
    expect(outcome.created.map((c) => c.tempId)).toEqual(["side", "sideleaf"]);
  });

  it("so does a thought the plan jumps to, deleted since it was read", async () => {
    const fake = fakeBrain([
      { id: ROOT, name: "root" },
      { id: OTHER, name: "doomed" },
    ]);
    fake.vanishing.add(OTHER);
    const outcome = await ingest(fake.api, BRAIN, {
      thoughts: [
        { tempId: "top", name: "Top", parent: OTHER, relation: "jump" },
        { tempId: "mid", name: "Mid", parent: "top" },
        { tempId: "side", name: "Side", parent: ROOT },
      ],
    });

    expect(said(outcome)).toEqual([
      { what: 'thought "Top" (top)', reason: `Source Thought ${OTHER} could not be located` },
    ]);
    expect(outcome.skipped).toEqual([{ what: 'thought "Mid" (mid)', reason: needs("top") }]);
    expect(outcome.created.map((c) => c.tempId)).toEqual(["side"]);
  });

  it("a second run adds nothing while the failure lasts, and finishes the plan once it is gone", async () => {
    // Each run used to leave one more "Mid" with no parent, and a "Leaf" under it.
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    fake.failOn.add("Top");
    const first = await ingest(fake.api, BRAIN, plan());
    const afterFirst = names(fake);

    const second = await ingest(fake.api, BRAIN, plan());
    expect(second.created).toEqual([]);
    expect(second.reused.map((r) => r.tempId)).toEqual(["side", "sideleaf"]);
    expect(second.failures).toEqual(first.failures);
    expect(second.skipped).toEqual(first.skipped);
    expect(names(fake)).toEqual(afterFirst);

    fake.failOn.clear();
    const third = await ingest(fake.api, BRAIN, plan());
    expect(third.created.map((c) => c.tempId)).toEqual(["top", "mid", "leaf"]);
    expect(third.failures).toEqual([]);
    expect(third.skipped).toEqual([]);
    expect(names(fake)).toEqual(["Leaf", "Mid", "Side", "Side leaf", "Top", "root"]);
    expect(roots(fake)).toEqual(["root"]);
  });

  const twins: IngestPlan = {
    thoughts: [
      { tempId: "x", name: "Same", parent: ROOT, note: "one" },
      { tempId: "y", name: "Same", parent: ROOT },
      { tempId: "under", name: "Leaf", parent: "y" },
    ],
  };
  /** The creates sent, by the name asked for. */
  const createsOf = ({ api }: Fake): string[] =>
    vi.mocked(api.thoughts.create).mock.calls.map(([, input]) => input.name);

  it("two plan items for one thought are one create: one fails, and the other is skipped as the same thought", async () => {
    // Both used to be listed as failed, with the one reason, though the
    // second was never sent.
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    vi.spyOn(fake.api.thoughts, "create");
    fake.failOn.add("Same");
    const outcome = await ingest(fake.api, BRAIN, twins);

    expect(names(fake)).toEqual(["root"]);
    expect(createsOf(fake)).toEqual(["Same"]);
    expect(said(outcome)).toEqual([{ what: 'thought "Same" (x)', reason: "server refused" }]);
    expect(outcome.skipped).toEqual([
      { what: 'thought "Same" (y)', reason: 'is the same thought as "x", which was not created' },
      // What hangs on either names the one that was tried.
      { what: 'thought "Leaf" (under)', reason: needs("x") },
    ]);
    expect(outcome.notesWritten).toBe(0);
  });

  it("the second of two is not sent on its own when the first got no answer: it would be made twice", async () => {
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    vi.spyOn(fake.api.thoughts, "create");
    fake.lostOn.add("Same");
    const outcome = await ingest(fake.api, BRAIN, twins);

    // The one create went through, with no identifier to report.
    expect(names(fake)).toEqual(["Same", "root"]);
    expect(createsOf(fake)).toEqual(["Same"]);
    expect(said(outcome)).toEqual([
      { what: 'thought "Same" (x)', reason: "request exceeded 30000 ms", unanswered: true },
    ]);
    expect(outcome.skipped.map((s) => s.what)).toEqual(['thought "Same" (y)', 'thought "Leaf" (under)']);

    // The next run finds it, for both items, and finishes the plan: once
    // the parent's graph lists it, which the batch could not wait for.
    fake.lostOn.clear();
    await fake.api.thoughts.getGraph(BRAIN, ROOT);
    const second = await ingest(fake.api, BRAIN, twins);
    expect(second.reused.map((r) => r.tempId)).toEqual(["x", "y"]);
    expect(second.created.map((c) => c.tempId)).toEqual(["under"]);
    expect(names(fake)).toEqual(["Leaf", "Same", "root"]);
  });

  it("once the cause is gone the same plan makes the thought once, for both items", async () => {
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    fake.failOn.add("Same");
    await ingest(fake.api, BRAIN, twins);
    fake.failOn.clear();
    const second = await ingest(fake.api, BRAIN, twins);

    expect(second.created.map((c) => c.tempId)).toEqual(["x", "under"]);
    expect(second.reused.map((r) => r.tempId)).toEqual(["y"]);
    expect(second.failures).toEqual([]);
    expect(second.skipped).toEqual([]);
    expect(names(fake)).toEqual(["Leaf", "Same", "root"]);
  });

  it("a namesake under another relation waits on the same create, and is skipped as a namesake", async () => {
    // Made, the first would stop it as a namesake. Not made, it is not sent:
    // it used to be listed as failed with the first one's reason.
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    vi.spyOn(fake.api.thoughts, "create");
    fake.failOn.add("Same");
    const outcome = await ingest(fake.api, BRAIN, {
      thoughts: [
        { tempId: "x", name: "Same", parent: ROOT },
        { tempId: "y", name: "Same", parent: ROOT, relation: "jump" },
      ],
    });

    expect(createsOf(fake)).toEqual(["Same"]);
    expect(outcome.failures.map((f) => f.what)).toEqual(['thought "Same" (x)']);
    expect(outcome.skipped).toEqual([
      { what: 'thought "Same" (y)', reason: 'is a namesake of "x", which was not created' },
    ]);
  });

  it("a link between two branches that both failed names both", async () => {
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    fake.failOn.add("A").add("B");
    const outcome = await ingest(fake.api, BRAIN, {
      thoughts: [
        { tempId: "a", name: "A", parent: ROOT },
        { tempId: "b", name: "B", parent: ROOT },
        { tempId: "under", name: "Leaf", parent: "b" },
      ],
      links: [
        { from: "a", to: "under" },
        { from: "b", to: "under" },
      ],
    });

    expect(outcome.skipped).toEqual([
      { what: 'thought "Leaf" (under)', reason: needs("b") },
      { what: "link a -> under", reason: 'depends on "a" and "b", which were not created' },
      { what: "link b -> under", reason: needs("b") },
    ]);
    expect(fake.links).toEqual([]);
  });

  it("a tempId that reads as a UUID is still a tempId: nothing lands on the thought that has it", async () => {
    // Left unresolved, it used to be taken for the identifier it spells: the
    // thought under it went under whatever the brain had there, and so did
    // the link.
    const fake = fakeBrain([
      { id: ROOT, name: "root" },
      { id: OTHER, name: "Existing", parent: ROOT },
    ]);
    fake.failOn.add("Top");
    const outcome = await ingest(fake.api, BRAIN, {
      thoughts: [
        { tempId: OTHER, name: "Top", parent: ROOT },
        { tempId: "leaf", name: "Leaf", parent: OTHER },
      ],
      links: [{ from: ROOT, to: OTHER, name: "about" }],
    });

    expect(names(fake)).toEqual(["Existing", "root"]);
    expect(fake.links).toEqual([]);
    expect(outcome.created).toEqual([]);
    expect(outcome.linksCreated).toBe(0);
    expect(outcome.skipped).toEqual([
      { what: 'thought "Leaf" (leaf)', reason: needs(OTHER) },
      { what: `link ${ROOT} -> ${OTHER}`, reason: needs(OTHER) },
    ]);
  });

  it("a create that got no answer is marked: the thought may be there, and the next run finds it", async () => {
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    fake.lostOn.add("Mid");
    const outcome = await ingest(fake.api, BRAIN, plan());

    expect(roots(fake)).toEqual(["root"]);
    expect(said(outcome)).toEqual([
      { what: 'thought "Mid" (mid)', reason: "request exceeded 30000 ms", unanswered: true },
    ]);
    expect(outcome.skipped.map((s) => s.what)).toContain('thought "Leaf" (leaf)');
    // It is there all the same, under its parent, and no identifier came back.
    const top = outcome.created.find((c) => c.tempId === "top")!.thoughtId;
    const mid = [...fake.thoughts.values()].find((t) => t.name === "Mid")!;
    expect(mid.parent).toBe(top);
    expect(mid.note).toBe("");

    fake.lostOn.clear();
    const second = await ingest(fake.api, BRAIN, plan());
    expect(second.reused.map((r) => r.thoughtId)).toContain(mid.id);
    expect(second.created.map((c) => c.tempId)).toEqual(["leaf"]);
    expect(fake.thoughts.get(mid.id)?.note).toBe("body");
    expect(names(fake)).toEqual(["Leaf", "Mid", "Side", "Side leaf", "Top", "root"]);
  });

  it("only a request that may have gone out is marked: not a refused connection, nor an answer", async () => {
    const refused = new TheBrainError("network", "could not reach http://localhost:11522", {
      cause: new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      }),
    });
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    fake.failWith.set("Top", refused).set("Side", new TheBrainError("server", "boom", { status: 500 }));
    const outcome = await ingest(fake.api, BRAIN, plan());

    expect(names(fake)).toEqual(["root"]);
    expect(said(outcome)).toEqual([
      { what: 'thought "Top" (top)', reason: "could not reach http://localhost:11522" },
      { what: 'thought "Side" (side)', reason: "boom" },
    ]);
  });
});

describe("what a failed note, tag or alias is listed as", () => {
  const A = "cccccccc-0000-4000-8000-000000000003";
  const B = "dddddddd-0000-4000-8000-000000000004";
  /** Two thoughts of one title, under two parents: only an identifier tells them apart. */
  const plan: IngestPlan = {
    thoughts: [
      { tempId: "one", name: "Same", parent: A, note: "first", tagIds: [TAG] },
      { tempId: "two", name: "Same", parent: B, note: "second", tagIds: [TAG] },
    ],
  };
  const brain = () =>
    fakeBrain([
      { id: A, name: "A" },
      { id: B, name: "B" },
    ]);

  it("a note that fails names its thought by identifier, not by a title two thoughts share", async () => {
    // It used to read `note for "Same"`, for either of them.
    const fake = brain();
    fake.failOn.add("note: second");
    const outcome = await ingest(fake.api, BRAIN, plan);

    const two = outcome.created.find((c) => c.tempId === "two")!.thoughtId;
    expect(said(outcome)).toEqual([
      { what: `note for "Same" (${two})`, reason: "server refused" },
    ]);
    expect(fake.thoughts.get(two)?.note).toBe("");
  });

  it("a tag that fails names its thought by identifier too", async () => {
    const fake = brain();
    vi.spyOn(fake.api.links, "attachTag").mockImplementationOnce(async () => {
      throw new Error("server refused");
    });
    const outcome = await ingest(fake.api, BRAIN, plan);

    const failed = vi.mocked(fake.api.links.attachTag).mock.calls[0]![1];
    expect(outcome.created.map((c) => c.thoughtId)).toContain(failed);
    expect(said(outcome)).toEqual([
      { what: `tag ${TAG} on "Same" (${failed})`, reason: "server refused" },
    ]);
    expect(outcome.tagsAttached).toBe(1);
  });

  it("the outcome names the thoughts whose note was written, and no other", async () => {
    // What the report's warning about code fences goes by: it used to list
    // every plan thought with a fenced note, written or not.
    const fake = brain();
    fake.failOn.add("note: first").add("Gone");
    const outcome = await ingest(fake.api, BRAIN, {
      thoughts: [
        ...plan.thoughts,
        { tempId: "gone", name: "Gone", parent: A, note: "never" },
        { tempId: "bare", name: "Bare", parent: A },
        { tempId: "blank", name: "Blank", parent: A, note: "  " },
      ],
    });

    expect(outcome.notesWrittenFor).toEqual(["two"]);
    expect(outcome.notesWritten).toBe(1);
  });

  it("each failure says what the write was to make, and carries what was thrown", async () => {
    // For a caller that explains a failure in its own words: the lines of a
    // batch's report used to have the API's alone.
    const DOOMED = "ffffffff-0000-4000-8000-000000000006";
    const refused = new TheBrainError("server", "boom", { status: 500 });
    const fake = fakeBrain([
      { id: A, name: "A" },
      { id: B, name: "B" },
      { id: DOOMED, name: "doomed" },
    ]);
    // There for the plan's check, and deleted before the create under it.
    fake.vanishing.add(DOOMED);
    fake.failWith.set("note: first", refused);
    fake.failWith.set(`tag on new-2`, refused);
    vi.spyOn(fake.api.links, "create").mockRejectedValueOnce(refused);
    const outcome = await ingest(fake.api, BRAIN, {
      thoughts: [...plan.thoughts, { tempId: "gone", name: "Gone", parent: DOOMED }],
      links: [{ from: "one", to: "two" }],
    });

    const byWhat = new Map(outcome.failures.map((f) => [f.of, f]));
    expect([...byWhat.keys()].sort()).toEqual(["link", "note", "tag", "thought"]);
    for (const of of ["link", "note", "tag"] as const) {
      expect([byWhat.get(of)!.error, byWhat.get(of)!.reason], of).toEqual([refused, "boom"]);
    }
    expect(byWhat.get("thought")!.error).toMatchObject({
      kind: "not_found",
      message: `Source Thought ${DOOMED} could not be located`,
    });
    // An answer, whatever it says, is no write that may have landed.
    expect(outcome.failures.map((f) => f.unanswered)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("a note, a tag and a link that got no answer are marked as a create is: each may have been carried out", async () => {
    // Only a create was marked, and a note write with no answer stood among
    // the failures as one that had been refused.
    const lost = (): TheBrainError =>
      new TheBrainError("network", "request exceeded 30000 ms", { method: "POST" });
    const fake = brain();
    fake.lostOn.add("note: first");
    fake.failWith.set("tag on new-2", lost());
    vi.spyOn(fake.api.links, "create").mockRejectedValueOnce(lost());
    const outcome = await ingest(fake.api, BRAIN, { ...plan, links: [{ from: "one", to: "two" }] });

    expect(
      outcome.failures.map((f) => [f.of, f.unanswered, f.reason]).sort(),
    ).toEqual([
      ["link", true, "request exceeded 30000 ms"],
      ["note", true, "request exceeded 30000 ms"],
      ["tag", true, "request exceeded 30000 ms"],
    ]);
    // The note is there all the same, and is not among the ones known written.
    const one = outcome.created.find((c) => c.tempId === "one")!.thoughtId;
    expect(fake.thoughts.get(one)?.note).toBe("first");
    expect(outcome.notesWrittenFor).toEqual(["two"]);
  });
});

describe("a brain that is not there", () => {
  const TYPE = "cccccccc-0000-4000-8000-000000000003";
  const nothingNamed: IngestPlan = {
    thoughts: [
      { tempId: "a", name: "A" },
      { tempId: "b", name: "B", parent: "a", note: "n" },
      { tempId: "c", name: "C" },
    ],
    links: [{ from: "a", to: "c" }],
  };

  it("stops a plan that names nothing in it once, ahead of the first write", async () => {
    // Such a plan read nothing before its writes, and each create at its top
    // was refused in turn: a failure a thought, with nothing to say which
    // identifier was wrong.
    const fake = fakeBrain();
    vi.spyOn(fake.api.thoughts, "create");
    fake.brain.there = false;

    const refusal = await ingest(fake.api, BRAIN, nothingNamed).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(TheBrainError);
    expect((refusal as TheBrainError).kind).toBe("unknown_brain");
    expect(fake.brain.reads).toBe(1);
    expect(fake.api.thoughts.create).not.toHaveBeenCalled();
  });

  it("that plan reads the brain once when it is there, and is written as before", async () => {
    const fake = fakeBrain();
    const outcome = await ingest(fake.api, BRAIN, nothingNamed);

    expect(fake.brain.reads).toBe(1);
    expect(outcome.created.map((c) => c.tempId)).toEqual(["a", "c", "b"]);
    expect(outcome.failures).toEqual([]);
  });

  it("a plan that names a parent, a type or a tag has read it already, and sends no read more", async () => {
    // Each of those reads is refused for such a brain, and the plan with it.
    for (const named of [{ parent: ROOT }, { typeId: TYPE }, { tagIds: [TAG] }]) {
      const fake = fakeBrain([{ id: ROOT, name: "root" }]);
      fake.types.add(TYPE);
      const outcome = await ingest(fake.api, BRAIN, {
        thoughts: [{ tempId: "a", name: "A", ...named }],
      });
      expect(outcome.created, JSON.stringify(named)).toHaveLength(1);
      expect(fake.brain.reads, JSON.stringify(named)).toBe(0);
    }
  });

  it("a thought the plan only jumps to is read ahead of the writes too, in place of the brain", async () => {
    // It has no kind to be refused by, and was not read: the brain was. It
    // is read now for whether it is there, which a brain that is not there
    // refuses as it does any read.
    const jumping: IngestPlan = {
      thoughts: [{ tempId: "a", name: "A", parent: ROOT, relation: "jump" }],
    };
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    await ingest(fake.api, BRAIN, jumping);
    expect(fake.parentReads).toEqual([]);
    expect(fake.thoughtReads).toEqual([ROOT]);
    expect(fake.brain.reads).toBe(0);

    const gone = fakeBrain([{ id: ROOT, name: "root" }]);
    vi.spyOn(gone.api.thoughts, "create");
    gone.brain.there = false;
    await expect(ingest(gone.api, BRAIN, jumping)).rejects.toMatchObject({ kind: "unknown_brain" });
    expect(gone.thoughtReads).toEqual([ROOT]);
    expect(gone.api.thoughts.create).not.toHaveBeenCalled();
  });
});

describe("a parent nobody has in a batch", () => {
  const NOBODY = "99999999-0000-4000-8000-000000000009";
  const OTHER = "dddddddd-0000-4000-8000-000000000004";
  const nobodyHas = (references: string): string =>
    `${references}, and no thought in this brain has that identifier. It may have been ` +
    "deleted, or be another brain's";
  /** A branch under nobody's identifier beside one under ROOT, with all a plan can carry. */
  const plan = (relation?: "child" | "parent" | "jump"): IngestPlan => ({
    thoughts: [
      { tempId: "top", name: "Top", parent: NOBODY, note: "summary", relation },
      { tempId: "mid", name: "Mid", parent: "top", note: "body" },
      { tempId: "side", name: "Side", parent: ROOT, tagIds: [TAG], aliases: ["S"] },
      { tempId: "sideleaf", name: "Side leaf", parent: "side", note: "kept" },
    ],
    links: [
      { from: "mid", to: "side", name: "relates" },
      { from: "sideleaf", to: ROOT, name: "back" },
    ],
  });
  type Fake = ReturnType<typeof fakeBrain>;
  const brain = (): Fake => {
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    vi.spyOn(fake.api.thoughts, "create");
    vi.spyOn(fake.api.links, "create");
    vi.spyOn(fake.api.links, "attachTag");
    return fake;
  };
  const refusal = (fake: Fake, sent: IngestPlan): Promise<unknown> =>
    ingest(fake.api, BRAIN, sent).then(
      () => null,
      (error: unknown) => error,
    );
  /** Nothing went out that writes, and the brain is as it was. */
  const nothingWritten = (fake: Fake): void => {
    expect(fake.api.thoughts.create).not.toHaveBeenCalled();
    expect(fake.api.links.create).not.toHaveBeenCalled();
    expect(fake.api.links.attachTag).not.toHaveBeenCalled();
    expect([...fake.thoughts.keys()]).toEqual([ROOT]);
    expect([fake.noteWrites, fake.aliasWrites, fake.links]).toEqual([[], [], []]);
  };

  it("rejects the plan before any write, the branches beside it included, and names the identifier and the plan item", async () => {
    // It used to fail its own thought in the middle of the batch: "side" and
    // "sideleaf" were written, "top" stood under the failures with the API's
    // 404, and "mid" and its link were skipped.
    const fake = brain();
    const error = await refusal(fake, plan());

    expect(error).toBeInstanceOf(IngestMissingError);
    expect(error).toBeInstanceOf(IngestValidationError);
    expect((error as IngestMissingError).message).toBe(
      nobodyHas(`thought "top" references parent ${NOBODY}`),
    );
    expect((error as IngestMissingError).ids).toEqual([NOBODY]);
    nothingWritten(fake);
  });

  it("at no read more: the read that checks a parent's kind is the one that says nobody has it", async () => {
    const fake = brain();
    await refusal(fake, plan());

    expect(fake.parentReads.sort()).toEqual([NOBODY, ROOT].sort());
    expect([fake.thoughtReads, fake.graphReads, fake.brain.reads]).toEqual([[], [], 0]);

    // And a plan whose parents are all there reads what it read before.
    const whole = brain();
    const outcome = await ingest(whole.api, BRAIN, {
      thoughts: [
        { tempId: "a", name: "A", parent: ROOT },
        { tempId: "b", name: "B", parent: "a" },
      ],
      links: [{ from: "b", to: ROOT, relation: "parent" }],
    });
    expect(outcome.failures).toEqual([]);
    expect([whole.parentReads, whole.thoughtReads, whole.brain.reads]).toEqual([[ROOT], [], 0]);
  });

  it("a thought made as a parent or as a jump of it rejects the plan too, by one read of its own", async () => {
    // No kind is refused there, so nothing read it ahead of the writes, and
    // the branch was lost in the middle of the batch as a child's was.
    for (const relation of ["parent", "jump"] as const) {
      const fake = brain();
      const error = await refusal(fake, plan(relation));

      expect(error, relation).toBeInstanceOf(IngestMissingError);
      expect((error as Error).message, relation).toBe(
        nobodyHas(`thought "top" references parent ${NOBODY}`),
      );
      expect([fake.thoughtReads, fake.graphReads], relation).toEqual([[NOBODY], []]);
      nothingWritten(fake);
    }
  });

  it("each such thought is read once, and not at all when the plan names it as a parent as well", async () => {
    const fake = fakeBrain([
      { id: ROOT, name: "root" },
      { id: OTHER, name: "other" },
    ]);
    const outcome = await ingest(fake.api, BRAIN, {
      thoughts: [
        { tempId: "a", name: "A", parent: OTHER, relation: "jump" },
        { tempId: "b", name: "B", parent: OTHER, relation: "parent" },
        { tempId: "c", name: "C", parent: ROOT, relation: "jump" },
        { tempId: "d", name: "D", parent: ROOT },
        { tempId: "e", name: "E", parent: "a", relation: "jump" },
      ],
    });

    expect(outcome.failures).toEqual([]);
    expect(outcome.created).toHaveLength(5);
    expect(fake.thoughtReads).toEqual([OTHER]);
    expect(fake.parentReads).toEqual([ROOT]);
  });

  it("at the upper end of a link it rejects the plan, whichever way the link is written", async () => {
    const thoughts = [{ tempId: "a", name: "A", parent: ROOT }];
    for (const [link, field] of [
      [{ from: NOBODY, to: "a", relation: "child" }, "from"],
      [{ from: "a", to: NOBODY, relation: "parent" }, "to"],
    ] as const) {
      const fake = brain();
      const error = await refusal(fake, { thoughts, links: [link] });

      expect(error, field).toBeInstanceOf(IngestMissingError);
      expect((error as Error).message, field).toBe(
        nobodyHas(`the link ${link.from} -> ${link.to} references ${NOBODY} in its ${field} field`),
      );
      expect(fake.thoughtReads, field).toEqual([]);
      nothingWritten(fake);
    }
  });

  it("the lower end of a link and the ends of a jump are not read: the plan is written, and the link fails alone in the API's words", async () => {
    // A link that fails takes nothing with it, and what is left to send is
    // that link. Reading each such end would cost every plan a request for
    // it, to send the whole plan again in place of one link.
    for (const [link, end] of [
      [{ from: "a", to: NOBODY, relation: "child" }, "target"],
      [{ from: NOBODY, to: "a", relation: "parent" }, "source"],
      [{ from: "a", to: NOBODY }, "target"],
      [{ from: NOBODY, to: "a", relation: "jump" }, "source"],
    ] as const) {
      const fake = fakeBrain([
        { id: ROOT, name: "root" },
        { id: OTHER, name: "other" },
      ]);
      const outcome = await ingest(fake.api, BRAIN, {
        thoughts: [{ tempId: "a", name: "A", parent: ROOT, note: "n" }],
        links: [link, { from: "a", to: OTHER, name: "beside" }],
      });
      const what = `link ${link.from} -> ${link.to}`;

      expect(outcome.created.map((c) => c.tempId), what).toEqual(["a"]);
      expect([outcome.notesWritten, outcome.linksCreated], what).toEqual([1, 1]);
      expect(said(outcome), what).toEqual([
        { what, reason: `Could not get ${end} thought ${NOBODY}` },
      ]);
      expect(outcome.skipped, what).toEqual([]);
      expect([fake.parentReads, fake.thoughtReads], what).toEqual([[ROOT], []]);
    }
  });

  it("every identifier nobody has is named, each with the first plan item that names it", async () => {
    const ALSO = "88888888-0000-4000-8000-000000000008";
    const THIRD = "77777777-0000-4000-8000-000000000007";
    const fake = brain();
    const error = await refusal(fake, {
      thoughts: [
        { tempId: "a", name: "A", parent: NOBODY },
        { tempId: "b", name: "B", parent: NOBODY },
        { tempId: "c", name: "C", parent: ROOT },
        { tempId: "d", name: "D", parent: THIRD, relation: "jump" },
      ],
      links: [
        { from: "c", to: ALSO, relation: "parent" },
        { from: NOBODY, to: "c", relation: "child" },
      ],
    });

    expect((error as Error).message).toBe(
      `thought "a" references parent ${NOBODY}, ` +
        `the link c -> ${ALSO} references ${ALSO} in its to field, ` +
        `thought "d" references parent ${THIRD}, ` +
        "and no thought in this brain has those identifiers. Each may have been deleted, " +
        "or be another brain's",
    );
    expect((error as IngestMissingError).ids).toEqual([NOBODY, ALSO, THIRD]);
    // Each read once, however many plan items name it.
    expect(fake.parentReads.sort()).toEqual([ALSO, NOBODY, ROOT].sort());
    expect(fake.thoughtReads).toEqual([THIRD]);
    nothingWritten(fake);
  });

  it("a read that fails is not an identifier nobody has: the plan fails by it as it did, and nothing is written", async () => {
    const boom = new TheBrainError("server", "boom", { status: 500 });
    const fake = brain();
    vi.spyOn(fake.api.thoughts, "get").mockRejectedValueOnce(boom);
    const error = await refusal(fake, {
      thoughts: [{ tempId: "a", name: "A", parent: ROOT, relation: "jump" }],
    });

    expect(error).toBe(boom);
    nothingWritten(fake);
  });

  it("a type named as a parent is refused as it was, whatever else nobody has", async () => {
    const TYPE = "cccccccc-0000-4000-8000-000000000003";
    const fake = brain();
    fake.types.add(TYPE);
    const error = await refusal(fake, {
      thoughts: [
        { tempId: "a", name: "A", parent: NOBODY },
        { tempId: "b", name: "B", parent: TYPE },
      ],
    });

    expect(error).toMatchObject({ kind: "not_a_parent" });
    nothingWritten(fake);
  });

  it("a tempId is not looked for in the brain, one that reads as a UUID included", async () => {
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    const outcome = await ingest(fake.api, BRAIN, {
      thoughts: [
        { tempId: NOBODY, name: "Top", parent: ROOT },
        { tempId: "leaf", name: "Leaf", parent: NOBODY, relation: "jump" },
      ],
      links: [{ from: NOBODY, to: "leaf", relation: "child", name: "holds" }],
    });

    expect(outcome.failures).toEqual([]);
    expect(outcome.created.map((c) => c.tempId)).toEqual([NOBODY, "leaf"]);
    expect([fake.parentReads, fake.thoughtReads]).toEqual([[ROOT], []]);
  });
});

describe("aliases in a batch", () => {
  const RAG = "cccccccc-0000-4000-8000-000000000003";
  const OTHER = "dddddddd-0000-4000-8000-000000000004";
  const plan: IngestPlan = {
    thoughts: [
      { tempId: "rag", name: "RAG", parent: ROOT, aliases: ["Retrieval-augmented generation"] },
      { tempId: "plain", name: "No aliases", parent: ROOT },
    ],
  };

  it("a new thought is created with its aliases, in the same request", async () => {
    const { api, thoughts, aliasWrites } = fakeBrain([{ id: ROOT, name: "root" }]);
    const outcome = await ingest(api, BRAIN, plan);

    const id = outcome.created.find((c) => c.tempId === "rag")!.thoughtId;
    expect(thoughts.get(id)?.aliases).toEqual(["Retrieval-augmented generation"]);
    expect(aliasWrites).toEqual([]);
    expect(outcome.aliasesWritten).toBe(1);
  });

  it("a thought that already existed keeps its aliases and gains the plan's", async () => {
    const { api, thoughts } = fakeBrain([
      { id: ROOT, name: "root" },
      { id: RAG, name: "RAG", parent: ROOT, aliases: ["R.A.G."] },
    ]);
    const outcome = await ingest(api, BRAIN, plan);

    expect(outcome.reused.map((r) => r.thoughtId)).toEqual([RAG]);
    expect(thoughts.get(RAG)?.aliases).toEqual(["R.A.G.", "Retrieval-augmented generation"]);
    expect(outcome.aliasesWritten).toBe(1);
  });

  it("a repeat run writes no alias twice", async () => {
    const { api, aliasWrites, settle } = fakeBrain([{ id: ROOT, name: "root" }]);
    await ingest(api, BRAIN, plan);
    settle();
    const second = await ingest(api, BRAIN, plan);

    expect(second.reused).toHaveLength(2);
    expect(second.aliasesWritten).toBe(0);
    expect(aliasWrites).toEqual([]);
  });

  it("two plan items for one thought add their aliases in a single write", async () => {
    // The API replaces the whole list, so two writes racing each other would
    // leave whichever landed last.
    const { api, thoughts, aliasWrites } = fakeBrain([
      { id: ROOT, name: "root" },
      { id: RAG, name: "RAG", parent: ROOT },
    ]);
    const outcome = await ingest(api, BRAIN, {
      thoughts: [
        { tempId: "x", name: "RAG", parent: ROOT, aliases: ["one"] },
        { tempId: "y", name: "RAG", parent: ROOT, aliases: ["two", " "] },
      ],
    });

    expect(aliasWrites).toHaveLength(1);
    expect(thoughts.get(RAG)?.aliases).toEqual(["one", "two"]);
    expect(outcome.aliasesWritten).toBe(1);
  });

  it("a thought created and then repeated in the same batch keeps both sets of aliases", async () => {
    // The new thought does not read back with its aliases yet. Adding the
    // second item's to what the read shows would leave "two" alone.
    const { api, thoughts } = fakeBrain([{ id: ROOT, name: "root" }]);
    const outcome = await ingest(api, BRAIN, {
      thoughts: [
        { tempId: "x", name: "RAG", parent: ROOT, aliases: ["one"] },
        { tempId: "y", name: "RAG", parent: ROOT, aliases: ["two"] },
      ],
    });

    const id = outcome.created[0]!.thoughtId;
    expect(outcome.reused.map((r) => r.thoughtId)).toEqual([id]);
    expect([...thoughts.get(id)!.aliases].sort()).toEqual(["one", "two"]);
    expect(outcome.aliasesWritten).toBe(1);
  });

  it("a build without aliases rejects the plan before any write", async () => {
    const { api, thoughts, build } = fakeBrain([{ id: ROOT, name: "root" }]);
    build.aliases = false;
    await expect(ingest(api, BRAIN, plan)).rejects.toThrowError(IngestValidationError);
    await expect(ingest(api, BRAIN, plan)).rejects.toThrowError(/15\.0\.621/);
    expect(thoughts.size).toBe(1);

    // The same plan without aliases is none of that build's business.
    const plain = { thoughts: plan.thoughts.map(({ aliases: _aliases, ...t }) => t) };
    expect((await ingest(api, BRAIN, plain)).created).toHaveLength(2);
  });

  it("aliases TheBrain accepted and no read showed are listed as that, and not counted as written", async () => {
    // They were counted in `aliasesWritten`, and the batch read as done.
    const { api, aliasesLag } = fakeBrain([
      { id: ROOT, name: "root" },
      { id: RAG, name: "RAG", parent: ROOT, aliases: ["R.A.G."] },
      { id: OTHER, name: "Other", parent: ROOT },
    ]);
    aliasesLag.add("RAG");
    vi.useFakeTimers();
    try {
      const pending = ingest(api, BRAIN, {
        thoughts: [...plan.thoughts, { tempId: "o", name: "Other", parent: ROOT, aliases: ["O"] }],
      });
      await vi.advanceTimersByTimeAsync(PAST_THE_WAIT);
      const outcome = await pending;

      expect(outcome.aliasesWritten).toBe(1);
      expect(outcome.aliasesNotReadBack).toEqual([
        {
          thoughtId: RAG,
          name: "RAG",
          added: ["Retrieval-augmented generation"],
          aliases: ["R.A.G.", "Retrieval-augmented generation"],
        },
      ]);
      expect([outcome.failures, outcome.skipped]).toEqual([[], []]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a thought made with aliases whose second item's do not read back is not counted either", async () => {
    const { api, aliasesLag } = fakeBrain([{ id: ROOT, name: "root" }]);
    aliasesLag.add("RAG");
    vi.useFakeTimers();
    try {
      const pending = ingest(api, BRAIN, {
        thoughts: [
          { tempId: "x", name: "RAG", parent: ROOT, aliases: ["one"] },
          { tempId: "y", name: "RAG", parent: ROOT, aliases: ["two"] },
        ],
      });
      await vi.advanceTimersByTimeAsync(PAST_THE_WAIT);
      const outcome = await pending;

      expect(outcome.aliasesWritten).toBe(0);
      expect(outcome.aliasesNotReadBack.map((u) => u.thoughtId)).toEqual([
        outcome.created[0]!.thoughtId,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the lists are written with no wait and waited for together: thirteen that never show take one wait", async () => {
    // Each waited for in turn, six at a time, they took three waits, and a
    // batch of 200 took 34.
    const names = Array.from({ length: 13 }, (_, i) => `T${i}`);
    const fake = fakeBrain([
      { id: ROOT, name: "root" },
      ...names.map((name, i) => ({
        id: `cccccccc-0000-4000-8000-0000000001${10 + i}`,
        name,
        parent: ROOT,
      })),
    ]);
    for (const name of names) fake.aliasesLag.add(name);
    vi.useFakeTimers();
    try {
      const started = Date.now();
      let took = -1;
      const pending = ingest(fake.api, BRAIN, {
        thoughts: names.map((name) => ({ tempId: name, name, parent: ROOT, aliases: ["a"] })),
      }).then((outcome) => ((took = Date.now() - started), outcome));
      await vi.advanceTimersByTimeAsync(3 * PAST_THE_WAIT);
      const outcome = await pending;

      // One wait, and not three: the reads before the writes take their time too.
      expect(took).toBeGreaterThanOrEqual(WAIT);
      expect(took).toBeLessThan(WAIT + 100);
      expect(outcome.aliasesNotReadBack).toHaveLength(13);
      expect(fake.aliasWaits.filter((w) => w.of === "write").map((w) => w.ms)).toEqual(
        names.map(() => 0),
      );
      // The first six are given the wait, and those after them what is left of it.
      expect(fake.aliasWaits.filter((w) => w.of === "look").map((w) => w.ms)).toEqual([
        ...Array(6).fill(WAIT),
        ...Array(7).fill(0),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed alias write shows in the report and stops nothing else", async () => {
    const { api, failOn } = fakeBrain([
      { id: ROOT, name: "root" },
      { id: RAG, name: "RAG", parent: ROOT },
    ]);
    failOn.add("aliases of RAG");
    const outcome = await ingest(api, BRAIN, plan);

    expect(outcome.created).toHaveLength(1);
    expect(outcome.aliasesWritten).toBe(0);
    expect(said(outcome)).toEqual([
      { what: `aliases for "RAG" (${RAG})`, reason: "server refused" },
    ]);
  });
});

describe("types in a batch", () => {
  const TYPE = "cccccccc-0000-4000-8000-000000000003";
  const OTHER = "dddddddd-0000-4000-8000-000000000004";
  const plan = (leafType: string): IngestPlan => ({
    thoughts: [
      { tempId: "top", name: "Retrieval", parent: ROOT, typeId: TYPE, note: "summary" },
      { tempId: "mid", name: "RAG", parent: "top", typeId: TYPE },
      { tempId: "leaf", name: "Chunking", parent: "mid", typeId: leafType },
    ],
  });

  it("a typeId that is not a type rejects the plan before any write", async () => {
    // The API would take it, with a 200, and make a parent or a tag of it.
    // Refused at its own turn instead, the thought would leave the plan
    // written in part, and nothing under it.
    const { api, thoughts, types } = fakeBrain([{ id: ROOT, name: "root" }]);
    types.add(TYPE);
    await expect(ingest(api, BRAIN, plan(OTHER))).rejects.toMatchObject({
      kind: "not_a_type",
      message: expect.stringContaining(OTHER),
    });
    expect([...thoughts.keys()]).toEqual([ROOT]);
  });

  it("ahead of the writes each type is read once, however many thoughts carry it", async () => {
    const { api, thoughts, types, typeReads } = fakeBrain([{ id: ROOT, name: "root" }]);
    types.add(TYPE).add(OTHER);
    const outcome = await ingest(api, BRAIN, plan(OTHER));

    expect(typeReads.sort()).toEqual([TYPE, OTHER].sort());
    expect(outcome.failures).toEqual([]);
    expect(outcome.created.map((c) => thoughts.get(c.thoughtId)?.typeId)).toEqual([
      TYPE,
      TYPE,
      OTHER,
    ]);
  });

  it("a plan without types reads none", async () => {
    const { api, typeReads } = fakeBrain([{ id: ROOT, name: "root" }]);
    await ingest(api, BRAIN, { thoughts: [{ tempId: "a", name: "A", parent: ROOT }] });
    expect(typeReads).toEqual([]);
  });
});

describe("tags in a batch", () => {
  const OTHER = "dddddddd-0000-4000-8000-000000000004";
  const plan = (leafTag: string): IngestPlan => ({
    thoughts: [
      { tempId: "top", name: "Retrieval", parent: ROOT, tagIds: [TAG], note: "summary" },
      { tempId: "mid", name: "RAG", parent: "top", tagIds: [TAG] },
      { tempId: "leaf", name: "Chunking", parent: "mid", tagIds: [TAG, leafTag] },
    ],
  });

  it("a tagId that is not a tag rejects the plan before any write", async () => {
    // The API would take it, with a 200, and make a type or a parent of it.
    // Tags go on after the thoughts: refused at its own turn, this one would
    // find all three written.
    const { api, thoughts } = fakeBrain([{ id: ROOT, name: "root" }]);
    await expect(ingest(api, BRAIN, plan(OTHER))).rejects.toMatchObject({
      kind: "not_a_tag",
      message: expect.stringContaining(OTHER),
    });
    expect([...thoughts.keys()]).toEqual([ROOT]);
  });

  it("ahead of the writes each tag is read once, however many thoughts carry it", async () => {
    const { api, thoughts, tags, tagReads } = fakeBrain([{ id: ROOT, name: "root" }]);
    tags.add(OTHER);
    const outcome = await ingest(api, BRAIN, plan(OTHER));

    expect(tagReads.sort()).toEqual([OTHER, TAG].sort());
    expect(outcome.failures).toEqual([]);
    expect(outcome.tagsAttached).toBe(4);
    expect(outcome.created.map((c) => thoughts.get(c.thoughtId)?.tags)).toEqual([
      [TAG],
      [TAG],
      [TAG, OTHER],
    ]);
  });

  it("a plan without tags reads none", async () => {
    const { api, tagReads } = fakeBrain([{ id: ROOT, name: "root" }]);
    await ingest(api, BRAIN, { thoughts: [{ tempId: "a", name: "A", parent: ROOT }] });
    expect(tagReads).toEqual([]);
  });
});

describe("a type named as a parent in a batch", () => {
  const TYPE = "cccccccc-0000-4000-8000-000000000003";
  const OTHER = "dddddddd-0000-4000-8000-000000000004";
  const brain = () => {
    const fake = fakeBrain([
      { id: ROOT, name: "root" },
      { id: OTHER, name: "Existing", parent: ROOT },
    ]);
    fake.types.add(TYPE);
    return fake;
  };
  const refusal = (field: string) => ({
    kind: "not_a_parent",
    message: expect.stringContaining(`${field} ${TYPE} cannot be a parent`),
  });

  it("a type as a thought's parent rejects the plan before any write", async () => {
    // The API would take it, with a 200, and make the thought one of that
    // type with no parent. It used to be reported as created under it.
    const { api, thoughts, links } = brain();
    await expect(
      ingest(api, BRAIN, {
        thoughts: [
          { tempId: "top", name: "Retrieval", parent: ROOT, note: "summary" },
          { tempId: "leaf", name: "RAG", parent: TYPE },
        ],
      }),
    ).rejects.toMatchObject(refusal("parent"));
    expect([...thoughts.keys()]).toEqual([ROOT, OTHER]);
    expect(links).toEqual([]);
  });

  it("a type at the upper end of a link rejects the plan, whichever way the link is written", async () => {
    // Either would set the type of the thought at the other end, and replace
    // the one it had. It used to count as a link created.
    for (const [link, field] of [
      [{ from: "a", to: TYPE, relation: "parent" }, "to"],
      [{ from: TYPE, to: "a", relation: "child" }, "from"],
      [{ from: OTHER, to: TYPE, relation: "parent" }, "to"],
      [{ from: TYPE, to: OTHER, relation: "child" }, "from"],
    ] as const) {
      const { api, thoughts, links } = brain();
      await expect(
        ingest(api, BRAIN, {
          thoughts: [{ tempId: "a", name: "A", parent: ROOT, note: "body" }],
          links: [{ from: "a", to: OTHER, name: "related" }, link],
        }),
      ).rejects.toMatchObject(refusal(field));
      expect([...thoughts.keys()], field).toEqual([ROOT, OTHER]);
      expect(links, field).toEqual([]);
    }
  });

  it("a jump to a type, and a type put under a thought, are written as before", async () => {
    // Both are ordinary links on the live API, and neither is read for.
    const { api, links, parentReads } = brain();
    const outcome = await ingest(api, BRAIN, {
      thoughts: [
        { tempId: "a", name: "A", parent: ROOT },
        { tempId: "above", name: "Above", parent: TYPE, relation: "parent" },
        { tempId: "beside", name: "Beside", parent: TYPE, relation: "jump" },
      ],
      // Each between a pair of its own: two links of a plan between one pair
      // are one link, the first.
      links: [
        { from: "a", to: TYPE },
        { from: ROOT, to: TYPE, relation: "jump" },
        { from: OTHER, to: TYPE, relation: "child" },
        { from: TYPE, to: "above", relation: "parent" },
      ],
    });

    expect(outcome.failures).toEqual([]);
    expect(outcome.linksNotAdded).toEqual([]);
    expect(outcome.created).toHaveLength(3);
    const a = outcome.created.find((c) => c.tempId === "a")!.thoughtId;
    expect(links).toContainEqual({ a, b: TYPE, relation: 3 });
    expect(links).toContainEqual({ a: OTHER, b: TYPE, relation: 1 });
    // ROOT for the thought under it, OTHER for the link it is the upper end of.
    expect(parentReads.sort()).toEqual([ROOT, OTHER].sort());
  });

  it("ahead of the writes each parent is read once, and a tempId never", async () => {
    const { api, parentReads } = brain();
    const outcome = await ingest(api, BRAIN, {
      thoughts: [
        { tempId: "top", name: "Top", parent: ROOT },
        { tempId: "mid", name: "Mid", parent: "top" },
        { tempId: "side", name: "Side", parent: ROOT },
      ],
      links: [
        { from: "top", to: "side", relation: "child" },
        { from: "mid", to: OTHER, relation: "parent" },
        { from: OTHER, to: "side", relation: "child" },
        { from: "side", to: ROOT, relation: "parent" },
      ],
    });

    expect(outcome.failures).toEqual([]);
    expect(parentReads.sort()).toEqual([ROOT, OTHER].sort());
  });

  it("a plan without parents reads none", async () => {
    const { api, parentReads } = brain();
    await ingest(api, BRAIN, {
      thoughts: [{ tempId: "a", name: "A" }],
      links: [{ from: "a", to: OTHER }],
    });
    expect(parentReads).toEqual([]);
  });

  it("a plan thought that lands on a type gets nothing put under it", async () => {
    // A type can be an ordinary child of a thought, and deduplication then
    // takes it for the plan's thought of that name. Nothing ahead of the
    // writes can see that; `create` and `links.create` refuse at their turn.
    const { api, thoughts, links, types } = fakeBrain([
      { id: ROOT, name: "root" },
      { id: TYPE, name: "Pattern", parent: ROOT },
      { id: OTHER, name: "Existing", parent: ROOT },
    ]);
    types.add(TYPE);
    const outcome = await ingest(api, BRAIN, {
      thoughts: [
        { tempId: "x", name: "Pattern", parent: ROOT },
        { tempId: "leaf", name: "RAG", parent: "x" },
      ],
      links: [{ from: OTHER, to: "x", relation: "parent" }],
    });

    // With what it is: the graph that listed it gave its kind.
    expect(outcome.reused).toEqual([{ tempId: "x", thoughtId: TYPE, name: "Pattern", kind: 2 }]);
    expect(outcome.created).toEqual([]);
    expect(outcome.linksCreated).toBe(0);
    expect(outcome.failures.map((f) => f.what)).toEqual([
      'thought "RAG" (leaf)',
      `link ${OTHER} -> x`,
    ]);
    for (const failure of outcome.failures) {
      expect(failure.reason).toContain(`${TYPE} cannot be a parent`);
    }
    expect([...thoughts.keys()]).toEqual([ROOT, TYPE, OTHER]);
    expect(links).toEqual([]);
  });
});

describe("a tag named as a parent in a batch", () => {
  const OTHER = "dddddddd-0000-4000-8000-000000000004";
  const brain = () =>
    fakeBrain([
      { id: ROOT, name: "root" },
      { id: OTHER, name: "Existing", parent: ROOT },
    ]);
  const refusal = (field: string) => ({
    kind: "tag_as_parent",
    message: expect.stringContaining(`${field} ${TAG} cannot be a parent`),
  });

  it("a tag as a thought's parent rejects the plan before any write", async () => {
    // The API would take it, with a 200, tag the thought and give it no
    // parent. It was listed as created, beside "tags attached: 0".
    const { api, thoughts, links } = brain();
    await expect(
      ingest(api, BRAIN, {
        thoughts: [
          { tempId: "top", name: "Retrieval", parent: ROOT, note: "summary" },
          { tempId: "leaf", name: "RAG", parent: TAG },
        ],
      }),
    ).rejects.toMatchObject(refusal("parent"));
    expect([...thoughts.keys()]).toEqual([ROOT, OTHER]);
    expect(links).toEqual([]);
  });

  it("a tag at the upper end of a link rejects the plan, whichever way the link is written", async () => {
    // Either would attach the tag to the thought at the other end. It used
    // to count as a link created.
    for (const [link, field] of [
      [{ from: "a", to: TAG, relation: "parent" }, "to"],
      [{ from: TAG, to: "a", relation: "child" }, "from"],
      [{ from: OTHER, to: TAG, relation: "parent" }, "to"],
      [{ from: TAG, to: OTHER, relation: "child" }, "from"],
    ] as const) {
      const { api, thoughts, links } = brain();
      await expect(
        ingest(api, BRAIN, {
          thoughts: [{ tempId: "a", name: "A", parent: ROOT, note: "body" }],
          links: [{ from: "a", to: OTHER, name: "related" }, link],
        }),
      ).rejects.toMatchObject(refusal(field));
      expect([...thoughts.keys()], field).toEqual([ROOT, OTHER]);
      expect(links, field).toEqual([]);
    }
  });

  it("a jump to a tag, a tag put under a thought and a tag in tagIds are written as before", async () => {
    // The first two are ordinary links on the live API, and neither is read
    // for; the third is what attaches a tag.
    const { api, links, thoughts, parentReads } = brain();
    const outcome = await ingest(api, BRAIN, {
      thoughts: [
        { tempId: "a", name: "A", parent: ROOT, tagIds: [TAG] },
        { tempId: "above", name: "Above", parent: TAG, relation: "parent" },
        { tempId: "beside", name: "Beside", parent: TAG, relation: "jump" },
      ],
      links: [
        { from: "beside", to: TAG, relation: "child" },
        { from: OTHER, to: TAG, relation: "jump" },
      ],
    });

    expect(outcome.failures).toEqual([]);
    expect(outcome.created).toHaveLength(3);
    expect(outcome.tagsAttached).toBe(1);
    const a = outcome.created.find((c) => c.tempId === "a")!.thoughtId;
    expect(thoughts.get(a)?.tags).toEqual([TAG]);
    expect(links).toContainEqual({ a: TAG, b: a, relation: 1, meaning: 5 });
    expect(links).toContainEqual({ a: OTHER, b: TAG, relation: 3 });
    // ROOT for the thought under it. "beside" is a tempId, and is not read.
    expect(parentReads).toEqual([ROOT]);
  });

  it("a plan thought that lands on a tag gets nothing put under it", async () => {
    // A tag can be an ordinary child of a thought, and deduplication then
    // takes it for the plan's thought of that name. `create` and
    // `links.create` refuse at their turn, as they do for a type.
    const HELD = "cccccccc-0000-4000-8000-000000000003";
    const { api, thoughts, links, tags } = fakeBrain([
      { id: ROOT, name: "root" },
      { id: HELD, name: "gotcha", parent: ROOT },
      { id: OTHER, name: "Existing", parent: ROOT },
    ]);
    tags.add(HELD);
    const outcome = await ingest(api, BRAIN, {
      thoughts: [
        { tempId: "x", name: "gotcha", parent: ROOT },
        { tempId: "leaf", name: "RAG", parent: "x" },
        { tempId: "deep", name: "Chunking", parent: "leaf" },
      ],
      links: [{ from: OTHER, to: "x", relation: "parent" }],
    });

    expect(outcome.reused).toEqual([{ tempId: "x", thoughtId: HELD, name: "gotcha", kind: 4 }]);
    expect(outcome.created).toEqual([]);
    expect(outcome.linksCreated).toBe(0);
    expect(outcome.failures.map((f) => f.what)).toEqual([
      'thought "RAG" (leaf)',
      `link ${OTHER} -> x`,
    ]);
    for (const failure of outcome.failures) {
      expect(failure.reason).toContain(`${HELD} cannot be a parent: it is a tag`);
    }
    expect(outcome.skipped.map((s) => s.what)).toEqual(['thought "Chunking" (deep)']);
    expect([...thoughts.keys()]).toEqual([ROOT, HELD, OTHER]);
    expect(links).toEqual([]);
  });
});

describe("a link the brain does not make", () => {
  const OTHER = "dddddddd-0000-4000-8000-000000000004";

  it("two references that come to one thought are a failed link, not a link created", async () => {
    // Nothing ahead of the writes can see it: "x" is OTHER only once
    // deduplication has found it. `links.create` refuses a thought linked to
    // itself, which the API answers with a 200 and an identifier of zeros.
    const { api, links } = fakeBrain([
      { id: ROOT, name: "root" },
      { id: OTHER, name: "Existing", parent: ROOT },
    ]);
    const outcome = await ingest(api, BRAIN, {
      thoughts: [{ tempId: "x", name: "Existing", parent: ROOT }],
      links: [{ from: "x", to: OTHER, name: "itself" }],
    });

    expect(outcome.reused.map((r) => r.thoughtId)).toEqual([OTHER]);
    expect(outcome.linksCreated).toBe(0);
    expect(said(outcome)).toEqual([
      { what: `link x -> ${OTHER}`, reason: "a thought cannot be linked to itself" },
    ]);
    expect(links).toEqual([]);
  });

  it("an identifier of zeros from the API is a failed link too", async () => {
    const { api } = fakeBrain([{ id: ROOT, name: "root" }]);
    const zeros = new TheBrainError("zero_id", "no link was made between a and b", { status: 200 });
    (api.links as { create: unknown }).create = async () => {
      throw zeros;
    };
    const outcome = await ingest(api, BRAIN, {
      thoughts: [
        { tempId: "a", name: "A", parent: ROOT },
        { tempId: "b", name: "B", parent: ROOT },
      ],
      links: [{ from: "a", to: "b" }],
    });

    expect(outcome.linksCreated).toBe(0);
    expect(said(outcome)).toEqual([
      { what: "link a -> b", reason: "no link was made between a and b" },
    ]);
  });
});

describe("what joins two thoughts already, set against the link asked for", () => {
  const A = "aaaaaaaa-1111-4000-8000-00000000000a";
  const B = "bbbbbbbb-1111-4000-8000-00000000000b";
  /** A link as the API returns it: stored with relation 1 or 3, head at `thoughtIdA`. */
  const link = (head: string, relation: number, meaning = 1, name: string | null = null) =>
    ({
      id: "link",
      thoughtIdA: head,
      thoughtIdB: head === A ? B : A,
      relation,
      meaning,
      name,
    }) as unknown as Parameters<typeof linkFound>[0];
  const asked = (relation: "child" | "parent" | "jump") => ({
    from: A,
    to: B,
    relation,
    fromName: "from",
    toName: "to",
  });

  it("the link asked for is the same kind, the same way up, whichever end wrote it", () => {
    // A parent's link reads back as a child's from the other end. Compared by
    // the stored relation, every one of them was called a mismatch.
    for (const [relation, found] of [
      ["jump", link(A, 3)],
      ["jump", link(B, 3)],
      ["child", link(A, 1)],
      ["parent", link(B, 1)],
      // Case aside, as the API reads a UUID.
      ["parent", link(B.toUpperCase(), 1)],
    ] as const) {
      expect(linkFound(found, asked(relation))).toEqual({
        asAsked: true,
        ordinary: true,
        note: "the link already existed",
        label: null,
      });
      expect(linkFound(found, asked(relation), "motivates").note).toBe(
        "the link already existed, label updated",
      );
    }
  });

  it("an ordinary link of another kind, or the other way up, is named, and takes the label", () => {
    for (const [relation, found, note] of [
      ["jump", link(A, 1), "as parent-child with from above, the requested jump was not added"],
      ["jump", link(B, 1), "as parent-child with to above, the requested jump was not added"],
      ["child", link(A, 3), "as jump, the requested parent-child with from above was not added"],
      ["parent", link(A, 3), "as jump, the requested parent-child with to above was not added"],
      // The other way up: these two used to pass for the link asked for.
      [
        "child",
        link(B, 1),
        "as parent-child with to above, the requested parent-child with from above was not added",
      ],
      [
        "parent",
        link(A, 1),
        "as parent-child with from above, the requested parent-child with to above was not added",
      ],
      // A relation past the three, which the API writes on a link no list shows.
      ["jump", link(A, 5), "as kind 5, the requested jump was not added"],
    ] as const) {
      expect(linkFound(found, asked(relation))).toEqual({
        asAsked: false,
        ordinary: true,
        note: `the link already existed ${note}`,
        label: null,
      });
      expect(linkFound(found, asked(relation), "motivates").note).toBe(
        `the link already existed ${note} — only the label was updated`,
      );
    }
  });

  it("a tag's attachment and a type's link are neither, and take no label", () => {
    const over = "and two thoughts share one link: the requested";
    for (const [relation, found, note] of [
      ["jump", link(B, 1, 5), `to is a tag on from, ${over} jump was not added in its place`],
      ["jump", link(A, 1, 5), `from is a tag on to, ${over} jump was not added in its place`],
      // A tag attached to a tag.
      ["jump", link(B, 1, 7), `to is a tag on from, ${over} jump was not added in its place`],
      ["jump", link(B, 1, 2), `to is the type of from, ${over} jump was not added in its place`],
      [
        "child",
        link(B, 1, 5),
        `to is a tag on from, ${over} parent-child with from above was not added in its place`,
      ],
      [
        "child",
        link(B, 1, 2),
        `to is the type of from, ${over} parent-child with from above was not added in its place`,
      ],
      // A type set on a type: it read as a link of another kind.
      ["jump", link(A, 1, 3), `from is the type of to, ${over} jump was not added in its place`],
      [
        "jump",
        link(A, 1, 9),
        "the two are joined by a link of another kind (meaning 9), " +
          `${over} jump was not added in its place`,
      ],
    ] as const) {
      expect(linkFound(found, asked(relation))).toEqual({
        asAsked: false,
        ordinary: false,
        note,
        label: null,
      });
      // Named or not, there is no label to write on it.
      expect(linkFound(found, asked(relation), "motivates")).toEqual({
        asAsked: false,
        ordinary: false,
        note: `${note}, and no label was written`,
        label: null,
      });
    }
  });

  it("a label where the link had none is written, and reads as it did", () => {
    // `null` on a link never named, `""` on one whose name was cleared.
    for (const had of [null, ""]) {
      expect(linkFound(link(A, 3, 1, had), asked("jump"), "motivates")).toEqual({
        asAsked: true,
        ordinary: true,
        note: "the link already existed, label updated",
        label: { write: true, said: "label updated" },
      });
      expect(linkFound(link(A, 3, 1, had), asked("child"), "motivates")).toMatchObject({
        note:
          "the link already existed as jump, the requested parent-child with from above " +
          "was not added — only the label was updated",
        label: { write: true, said: "label updated" },
      });
    }
  });

  it("a label that takes another's place is quoted, the one it took and the one it is now", () => {
    // "label updated" was the whole of it, and what had been there was gone
    // with nobody told.
    expect(linkFound(link(A, 3, 1, "contradicts"), asked("jump"), "refines")).toEqual({
      asAsked: true,
      ordinary: true,
      note: 'the link already existed, label updated: it was "contradicts" and is now "refines"',
      label: {
        write: true,
        said: 'label updated: it was "contradicts" and is now "refines"',
      },
    });
    expect(linkFound(link(B, 1, 1, "contradicts"), asked("jump"), "refines")).toMatchObject({
      asAsked: false,
      note:
        "the link already existed as parent-child with to above, the requested jump was not " +
        'added — only the label was updated: it was "contradicts" and is now "refines"',
      label: { write: true },
    });
    // Quoted as JSON quotes it, so a label with a quote in it reads whole.
    expect(linkFound(link(A, 3, 1, 'the "old" one'), asked("jump"), "new").note).toBe(
      'the link already existed, label updated: it was "the \\"old\\" one" and is now "new"',
    );
    // An empty label asked for takes the one that is there away, and says so.
    expect(linkFound(link(A, 3, 1, "contradicts"), asked("jump"), "").label).toEqual({
      write: true,
      said: 'label updated: it was "contradicts" and is now ""',
    });
  });

  it("a label the link has already is not to be written, and is said to be there", () => {
    expect(linkFound(link(A, 3, 1, "motivates"), asked("jump"), "motivates")).toEqual({
      asAsked: true,
      ordinary: true,
      note: 'the link already existed, label already "motivates"',
      label: { write: false, said: 'label already "motivates"' },
    });
    expect(linkFound(link(A, 1, 1, "motivates"), asked("jump"), "motivates")).toMatchObject({
      note:
        "the link already existed as parent-child with from above, the requested jump was " +
        'not added, and its label is already "motivates"',
      label: { write: false },
    });
    // Set against the name as TheBrain stores it: blanks at the ends dropped,
    // a tab and a line feed a space each. Sent as given, each of these would
    // pass for another label on every run.
    for (const sent of [" motivates ", "motivates\n", "\tmotivates"]) {
      expect(
        linkFound(link(A, 3, 1, "motivates"), asked("jump"), sent).label,
        JSON.stringify(sent),
      ).toEqual({ write: false, said: 'label already "motivates"' });
    }
    // And what a new one is said to be is what will be stored.
    expect(linkFound(link(A, 3, 1, "old"), asked("jump"), " a\tb\n").label?.said).toBe(
      'label updated: it was "old" and is now "a b"',
    );
    // Another case is another label.
    expect(linkFound(link(A, 3, 1, "Motivates"), asked("jump"), "motivates").label?.write).toBe(
      true,
    );
    // No label asked for and none there is nothing to write either.
    for (const had of [null, ""]) {
      expect(linkFound(link(A, 3, 1, had), asked("jump"), "").label).toEqual({
        write: false,
        said: 'label already ""',
      });
    }
  });
});

describe("reporting links that already existed", () => {
  const OTHER = "dddddddd-0000-4000-8000-000000000004";
  const TYPE = "cccccccc-0000-4000-8000-000000000003";
  /** Links are looked up six at a time, so a report lists them in no set order. */
  const inOrder = <T extends { note: string }>(notes: readonly T[]): T[] =>
    [...notes].sort((x, y) => x.note.localeCompare(y.note));

  it("a parent link that is there as asked is no mismatch, on the first run or the second", async () => {
    // The create makes the link, stored as a child's from the upper end, and
    // the plan's link then finds it. It was reported as "already existed as
    // parent-child, the requested parent-child was not added".
    const { api, links, labelWrites } = fakeBrain([{ id: ROOT, name: "root" }]);
    const plan: IngestPlan = {
      thoughts: [{ tempId: "up", name: "Above", parent: ROOT, relation: "parent" }],
      links: [{ from: ROOT, to: "up", relation: "parent", name: "belongs to" }],
    };
    // The second run finds the label the first wrote, and writes nothing.
    for (const [outcome, label] of [
      [await ingest(api, BRAIN, plan), "label updated"],
      [await ingest(api, BRAIN, plan), 'label already "belongs to"'],
    ] as const) {
      expect(outcome.linksReused).toEqual([
        { from: ROOT, to: "up", note: `the link already existed, ${label}` },
      ]);
      expect(outcome.linksNotAdded).toEqual([]);
    }
    expect(links).toEqual([{ a: "new-1", b: ROOT, relation: 1, name: "belongs to" }]);
    expect(labelWrites).toEqual([{ id: "link-0", name: "belongs to" }]);
  });

  it("a link the other way up is flagged, and so is a jump where a parent was asked for", async () => {
    // The first used to be "the link already existed", with no word of it.
    const { api, given } = fakeBrain([
      { id: ROOT, name: "root" },
      { id: OTHER, name: "Existing", parent: ROOT },
      { id: TYPE, name: "Beside", jumpOf: ROOT },
    ]);
    const outcome = await ingest(api, BRAIN, {
      thoughts: [{ tempId: "a", name: "A", parent: ROOT }],
      links: [
        { from: ROOT, to: OTHER, relation: "parent", name: "is part of" },
        { from: TYPE, to: ROOT, relation: "parent" },
      ],
    });

    expect(outcome.linksCreated).toBe(0);
    expect(inOrder(outcome.linksReused)).toEqual([
      {
        from: TYPE,
        to: ROOT,
        note:
          "the link already existed as jump, the requested parent-child with " +
          `${ROOT} above was not added`,
      },
      {
        from: ROOT,
        to: OTHER,
        note:
          `the link already existed as parent-child with ${ROOT} above, the requested ` +
          `parent-child with ${OTHER} above was not added — only the label was updated`,
      },
    ]);
    // The label is on the link that is there, and the link is as it was.
    expect(given).toEqual([
      { a: ROOT, b: OTHER, relation: 1, name: "is part of" },
      { a: ROOT, b: TYPE, relation: 3 },
    ]);
  });

  it("a tag on a thought, or its type, is not a link that existed: nothing is added, and no label written", async () => {
    // Each was given the label and reported as "already existed as
    // parent-child", or as the child link asked for.
    const { api, given, links, types } = fakeBrain([
      { id: ROOT, name: "root" },
      { id: OTHER, name: "Existing", parent: ROOT, tags: [TAG], typeId: TYPE },
    ]);
    types.add(TYPE);
    const before = structuredClone(given);
    const thoughts = [{ tempId: "a", name: "A", parent: ROOT, tagIds: [TAG] }];
    const first = await ingest(api, BRAIN, {
      thoughts,
      links: [
        { from: OTHER, to: TAG, name: "about" },
        { from: OTHER, to: TYPE, relation: "jump", name: "an example of" },
        // The tag the plan itself attached a moment ago.
        { from: TAG, to: "a", name: "marks" },
      ],
    });
    // In a plan of its own: a second link between one pair is not sent at all.
    const second = await ingest(api, BRAIN, {
      thoughts,
      links: [{ from: OTHER, to: TAG, relation: "child" }],
    });
    const outcome = {
      failures: [...first.failures, ...second.failures],
      linksCreated: first.linksCreated + second.linksCreated,
      linksReused: [...first.linksReused, ...second.linksReused],
      linksNotAdded: [...first.linksNotAdded, ...second.linksNotAdded],
    };

    expect(outcome.failures).toEqual([]);
    expect(outcome.linksCreated).toBe(0);
    expect(outcome.linksReused).toEqual([]);
    const over = "and two thoughts share one link: the requested";
    const unlabelled = "was not added in its place, and no label was written";
    expect(inOrder(outcome.linksNotAdded)).toEqual(
      inOrder([
        { from: OTHER, to: TAG, note: `${TAG} is a tag on ${OTHER}, ${over} jump ${unlabelled}` },
        {
          from: OTHER,
          to: TYPE,
          note: `${TYPE} is the type of ${OTHER}, ${over} jump ${unlabelled}`,
        },
        {
          from: OTHER,
          to: TAG,
          note:
            `${TAG} is a tag on ${OTHER}, ${over} parent-child with ${OTHER} above ` +
            "was not added in its place",
        },
        { from: TAG, to: "a", note: `${TAG} is a tag on a, ${over} jump ${unlabelled}` },
      ]),
    );
    expect(given).toEqual(before);
    expect(links.filter((l) => l.name !== undefined)).toEqual([]);
  });

  it("a jump between a thought and its parent is flagged as a kind mismatch", async () => {
    const { api } = fakeBrain([{ id: ROOT, name: "root" }]);
    const outcome = await ingest(api, BRAIN, {
      thoughts: [
        { tempId: "p", name: "parent", parent: ROOT },
        { tempId: "c", name: "child", parent: "p" },
      ],
      // Asking for a jump where a hierarchical link already exists.
      links: [{ from: "c", to: "p", relation: "jump", name: "property" }],
    });
    expect(outcome.linksCreated).toBe(0);
    expect(outcome.linksReused).toHaveLength(1);
    expect(outcome.linksReused[0]!.note).toMatch(/parent-child/);
    expect(outcome.linksReused[0]!.note).toMatch(/not added/);
  });

  it("a matching link kind is reported without alarm", async () => {
    const { api } = fakeBrain([{ id: ROOT, name: "root" }]);
    const plan: IngestPlan = {
      thoughts: [
        { tempId: "a", name: "A", parent: ROOT },
        { tempId: "b", name: "B", parent: ROOT },
      ],
      links: [{ from: "a", to: "b", name: "related" }],
    };
    await ingest(api, BRAIN, plan);
    const second = await ingest(api, BRAIN, plan);
    expect(second.linksReused[0]!.note).toBe('the link already existed, label already "related"');
    expect(second.linksReused[0]!.note).not.toMatch(/not added/);
  });
});

describe("a label on a link that was there", () => {
  const A = "dddddddd-0000-4000-8000-000000000004";
  const B = "cccccccc-0000-4000-8000-000000000003";
  /** Two thoughts under ROOT, joined by a jump from A that a person has labelled. */
  const labelled = (name: string) => {
    const fake = fakeBrain([
      { id: ROOT, name: "root" },
      { id: A, name: "Embeddings", parent: ROOT },
      { id: B, name: "Vector store", jumpOf: A },
    ]);
    fake.given.find((l) => l.a === A && l.b === B)!.name = name;
    return fake;
  };
  const plan = (name: string, relation: "jump" | "child" = "jump"): IngestPlan => ({
    thoughts: [{ tempId: "x", name: "X", parent: ROOT }],
    links: [{ from: A, to: B, relation, name }],
  });

  it("is replaced by the plan's, and the outcome quotes the one it took the place of", async () => {
    // It was "the link already existed, label updated", and the label a
    // person had written was gone with nobody told: 3 times of 3 on a live
    // TheBrain 15.0.640, by a plan and by brain_link.
    const { api, given, labelWrites } = labelled("contradicts");
    const outcome = await ingest(api, BRAIN, plan("refines"));

    expect(outcome.linksReused).toEqual([
      {
        from: A,
        to: B,
        note: 'the link already existed, label updated: it was "contradicts" and is now "refines"',
      },
    ]);
    expect(labelWrites).toEqual([{ id: "link-1", name: "refines" }]);
    expect(given.find((l) => l.b === B)).toMatchObject({ name: "refines" });
  });

  it("the same when the link is another kind than the one asked for", async () => {
    const { api, labelWrites } = labelled("contradicts");
    const outcome = await ingest(api, BRAIN, plan("refines", "child"));

    expect(outcome.linksReused.map((l) => l.note)).toEqual([
      `the link already existed as jump, the requested parent-child with ${A} above was not ` +
        'added — only the label was updated: it was "contradicts" and is now "refines"',
    ]);
    expect(labelWrites).toHaveLength(1);
  });

  it("is not written when it is the plan's already, on a first run as on a second", async () => {
    // That write is a 200 that changes nothing and logs nothing, and every
    // run of a plan sent it for every link it had a label for.
    const { api, labelWrites } = labelled("motivates");
    for (const run of [1, 2]) {
      const outcome = await ingest(api, BRAIN, plan("motivates"));
      expect(outcome.linksReused.map((l) => l.note), `run ${run}`).toEqual([
        'the link already existed, label already "motivates"',
      ]);
    }
    expect(labelWrites).toEqual([]);
  });

  it("a label a person changed between two runs is replaced by the second, which says what it was", async () => {
    // Replaced, where a note is kept: a link has one label and no way to add
    // to it, and the one line of it is in the result to be put back.
    const { api, links, labelWrites } = fakeBrain([
      { id: ROOT, name: "root" },
      { id: A, name: "Embeddings", parent: ROOT },
      { id: B, name: "Vector store", parent: ROOT },
    ]);
    const first = await ingest(api, BRAIN, plan("motivates"));
    expect(first.linksCreated).toBe(1);
    expect(first.linksReused).toEqual([]);

    // In TheBrain, by hand.
    links.find((l) => l.a === A && l.b === B)!.name = "is written into";
    const second = await ingest(api, BRAIN, plan("motivates"));
    expect(second.linksReused.map((l) => l.note)).toEqual([
      'the link already existed, label updated: it was "is written into" and is now "motivates"',
    ]);
    expect(labelWrites.map((w) => w.name)).toEqual(["motivates"]);
    expect(links.find((l) => l.a === A && l.b === B)).toMatchObject({ name: "motivates" });
  });
});

describe("a tag that is on its thought already", () => {
  const OTHER = "dddddddd-0000-4000-8000-000000000004";
  const SECOND_TAG = "ffffffff-0000-4000-8000-000000000006";
  const plan: IngestPlan = {
    thoughts: [
      { tempId: "top", name: "Top", parent: ROOT, tagIds: [TAG] },
      { tempId: "leaf", name: "Leaf", parent: "top", tagIds: [TAG, SECOND_TAG] },
    ],
  };
  const brain = () => {
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    fake.tags.add(SECOND_TAG);
    return fake;
  };

  it("is not attached again by a second run, which says it was there", async () => {
    // Attached again it is a 200 with the attachment's own identifier, and a
    // `402` in the log against it each time: 3 for each repeat of a plan with
    // three tags, on a live TheBrain 15.0.640.
    const { api, tagAttaches, tagLooks } = brain();
    const first = await ingest(api, BRAIN, plan);
    expect(first).toMatchObject({ tagsAttached: 3, tagsAlreadyThere: 0, failures: [] });
    expect(tagAttaches).toHaveLength(3);
    // A thought the batch made has no tag, and is not asked about one.
    expect(tagLooks).toEqual([]);

    tagAttaches.length = 0;
    for (const run of [2, 3]) {
      const again = await ingest(api, BRAIN, plan);
      expect(again, `run ${run}`).toMatchObject({
        tagsAttached: 0,
        tagsAlreadyThere: 3,
        failures: [],
      });
    }
    expect(tagAttaches).toEqual([]);
    // One lookup a tag on a thought that was there, each run.
    expect(tagLooks).toHaveLength(6);
  });

  it("a thought that was there without the tag is given it, after the one lookup", async () => {
    const { api, tagAttaches, tagLooks, thoughts } = fakeBrain([
      { id: ROOT, name: "root" },
      { id: OTHER, name: "Top", parent: ROOT },
    ]);
    const outcome = await ingest(api, BRAIN, {
      thoughts: [{ tempId: "top", name: "Top", parent: ROOT, tagIds: [TAG] }],
    });
    expect(outcome).toMatchObject({ tagsAttached: 1, tagsAlreadyThere: 0, failures: [] });
    expect(tagLooks).toEqual([`${TAG} on ${OTHER}`]);
    expect(tagAttaches).toEqual([`${TAG} on ${OTHER}`]);
    expect(thoughts.get(OTHER)!.tags).toEqual([TAG]);
  });

  it("only the tags that are missing are attached", async () => {
    const { api, tagAttaches, tags } = fakeBrain([
      { id: ROOT, name: "root" },
      { id: OTHER, name: "Top", parent: ROOT, tags: [TAG] },
    ]);
    tags.add(SECOND_TAG);
    const outcome = await ingest(api, BRAIN, {
      thoughts: [{ tempId: "top", name: "Top", parent: ROOT, tagIds: [TAG, SECOND_TAG] }],
    });
    expect(outcome).toMatchObject({ tagsAttached: 1, tagsAlreadyThere: 1 });
    expect(tagAttaches).toEqual([`${SECOND_TAG} on ${OTHER}`]);
  });

  it("a lookup that fails is not the answer that the tag is missing: the tag fails, unsent", async () => {
    // A read that failed has shown nothing, here as for a note.
    const { api, tagAttaches, failWith } = fakeBrain([
      { id: ROOT, name: "root" },
      { id: OTHER, name: "Top", parent: ROOT, tags: [TAG] },
    ]);
    failWith.set(`look for tag on ${OTHER}`, new TheBrainError("server", "boom", { status: 500 }));
    const outcome = await ingest(api, BRAIN, {
      thoughts: [{ tempId: "top", name: "Top", parent: ROOT, tagIds: [TAG] }],
    });
    expect(outcome).toMatchObject({ tagsAttached: 0, tagsAlreadyThere: 0 });
    expect(tagAttaches).toEqual([]);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toMatchObject({
      of: "tag",
      what: `tag ${TAG} on "Top" (${OTHER})`,
      reason:
        "not attached, because whether the thought has this tag already could not be read: boom",
    });
    expect(outcome.failures[0]!.error).toBeInstanceOf(IngestReadError);
  });

  it("a tag named twice for one thought is one attach, in one list or by two plan items", async () => {
    // Two attaches of one tag sent at once left two attachments 11 times in
    // 20 on a live TheBrain 15.0.640.
    const { api, tagAttaches } = fakeBrain([{ id: ROOT, name: "root" }]);
    const outcome = await ingest(api, BRAIN, {
      thoughts: [
        { tempId: "a", name: "Same", parent: ROOT, tagIds: [TAG, TAG] },
        { tempId: "b", name: "Same", parent: ROOT, tagIds: [TAG] },
      ],
    });
    expect(outcome.created).toHaveLength(1);
    expect(outcome.reused).toHaveLength(1);
    expect(outcome).toMatchObject({ tagsAttached: 1, tagsAlreadyThere: 0, failures: [] });
    expect(tagAttaches).toEqual([`${TAG} on new-1`]);
  });
});

describe("two links of a plan between the same two thoughts", () => {
  const P = "dddddddd-0000-4000-8000-000000000004";
  const Q = "cccccccc-0000-4000-8000-000000000003";
  const existing = () =>
    fakeBrain([
      { id: ROOT, name: "root" },
      { id: P, name: "P", parent: ROOT },
      { id: Q, name: "Q", parent: ROOT },
    ]);
  const between = (links: ReadonlyArray<{ a: string; b: string }>, x: string, y: string) =>
    links.filter((l) => [l.a, l.b].includes(x) && [l.a, l.b].includes(y));
  const notSent = (first: string, label?: string): string =>
    `the plan has a link between the same two thoughts ahead of this one, ${first}, and two ` +
    "thoughts share one link: this one was not sent" +
    (label === undefined ? "" : `, and its label ${JSON.stringify(label)} was not written`);

  it("are one link, the first in the plan: the other is not sent, on every run", async () => {
    // Both used to look, see no link, and post. Sent at once like that they
    // left two links between the pair 14 times in 20 on a live TheBrain
    // 15.0.640, under "links created: 2".
    for (const [what, second] of [
      ["the other way round", { from: "b", to: "a", name: "y" }],
      ["another relation", { from: "a", to: "b", relation: "child", name: "y" }],
      ["the same link again", { from: "a", to: "b", name: "x" }],
    ] as const) {
      const { api, links, labelWrites } = fakeBrain([{ id: ROOT, name: "root" }]);
      const plan: IngestPlan = {
        thoughts: [
          { tempId: "a", name: "A", parent: ROOT },
          { tempId: "b", name: "B", parent: ROOT },
        ],
        links: [{ from: "a", to: "b", name: "x" }, second],
      };
      const first = await ingest(api, BRAIN, plan);
      expect(first.failures, what).toEqual([]);
      expect(first.linksCreated, what).toBe(1);
      expect(first.linksNotAdded, what).toEqual([
        { from: second.from, to: second.to, note: notSent("a -> b", second.name) },
      ]);
      expect(between(links, "new-1", "new-2"), what).toEqual([
        { a: "new-1", b: "new-2", relation: 3, name: "x" },
      ]);

      // The run after finds the first link and its label, and writes nothing.
      const again = await ingest(api, BRAIN, plan);
      expect(again.linksCreated, what).toBe(0);
      expect(again.linksReused, what).toEqual([
        { from: "a", to: "b", note: 'the link already existed, label already "x"' },
      ]);
      expect(again.linksNotAdded, what).toEqual(first.linksNotAdded);
      expect(between(links, "new-1", "new-2"), what).toHaveLength(1);
      expect(labelWrites, what).toEqual([]);
    }
  });

  it("the same for two existing thoughts, an identifier in capitals included", async () => {
    const { api, links } = existing();
    const outcome = await ingest(api, BRAIN, {
      thoughts: [{ tempId: "x", name: "X", parent: ROOT }],
      links: [
        { from: P, to: Q, relation: "child" },
        { from: Q.toUpperCase(), to: P.toUpperCase(), name: "y" },
        { from: Q, to: P, relation: "parent" },
      ],
    });
    expect(outcome.linksCreated).toBe(1);
    // A reference to an existing thought is taken in lower case, as the API
    // names it, and is given back so.
    expect(outcome.linksNotAdded).toEqual([
      { from: Q, to: P, note: notSent(`${P} -> ${Q}`, "y") },
      { from: Q, to: P, note: notSent(`${P} -> ${Q}`) },
    ]);
    expect(between(links, P, Q)).toEqual([{ a: P, b: Q, relation: 1 }]);
  });

  it("the same when a tempId comes to a thought the plan also names by its identifier", async () => {
    // No look at the plan's references could tell: "p" is P only once the
    // batch has found a thought of that name under ROOT.
    const { api, links } = existing();
    const outcome = await ingest(api, BRAIN, {
      thoughts: [{ tempId: "p", name: "P", parent: ROOT }],
      links: [
        { from: "p", to: Q, name: "x" },
        { from: Q, to: P, name: "y" },
      ],
    });
    expect(outcome.reused.map((r) => r.thoughtId)).toEqual([P]);
    expect(outcome.linksCreated).toBe(1);
    expect(outcome.linksNotAdded).toEqual([
      { from: Q, to: P, note: notSent(`p -> ${Q}`, "y") },
    ]);
    expect(between(links, P, Q)).toEqual([{ a: P, b: Q, relation: 3, name: "x" }]);
  });

  it("the first is the link that is there when one is: the others add nothing, and no label", async () => {
    const { api, links, given, labelWrites } = existing();
    given.push({ a: P, b: Q, relation: 3, name: "old" });
    const outcome = await ingest(api, BRAIN, {
      thoughts: [{ tempId: "x", name: "X", parent: ROOT }],
      links: [
        { from: P, to: Q, name: "first" },
        { from: P, to: Q, relation: "child", name: "second" },
      ],
    });
    expect(outcome.linksCreated).toBe(0);
    expect(outcome.linksReused).toEqual([
      {
        from: P,
        to: Q,
        note: 'the link already existed, label updated: it was "old" and is now "first"',
      },
    ]);
    expect(outcome.linksNotAdded).toEqual([
      { from: P, to: Q, note: notSent(`${P} -> ${Q}`, "second") },
    ]);
    expect(labelWrites.map((w) => w.name)).toEqual(["first"]);
    expect(between(links, P, Q)).toEqual([]);
  });

  it("a link that fails does not hand the pair to the next: that one is still not sent", async () => {
    // A second request for the same pair, and after a first that got no
    // answer it can be the second link.
    const { api, links } = existing();
    const lost = new TheBrainError("network", "request exceeded 30000 ms", {
      method: "POST",
      path: `/api/links/${BRAIN}`,
    });
    vi.spyOn(api.links, "create").mockRejectedValueOnce(lost);
    const outcome = await ingest(api, BRAIN, {
      thoughts: [{ tempId: "x", name: "X", parent: ROOT }],
      links: [
        { from: P, to: Q, name: "first" },
        { from: Q, to: P, name: "second" },
      ],
    });
    expect(said(outcome)).toEqual([
      { what: `link ${P} -> ${Q}`, reason: "request exceeded 30000 ms", unanswered: true },
    ]);
    expect(outcome.linksNotAdded).toEqual([
      { from: Q, to: P, note: notSent(`${P} -> ${Q}`, "second") },
    ]);
    expect(api.links.create).toHaveBeenCalledTimes(1);
    expect(between(links, P, Q)).toEqual([]);
  });

  it("links between different pairs are sent as they were, each once", async () => {
    const { api, links } = existing();
    const outcome = await ingest(api, BRAIN, {
      thoughts: [{ tempId: "x", name: "X", parent: ROOT }],
      links: [
        { from: P, to: Q, name: "pq" },
        { from: "x", to: P },
        { from: "x", to: Q, relation: "parent" },
      ],
    });
    expect(outcome).toMatchObject({ linksCreated: 3, linksNotAdded: [], failures: [] });
    expect(links.filter((l) => l.a !== ROOT)).toHaveLength(3);
  });
});

describe("the identifier of zeros in a plan", () => {
  const ZEROS = "00000000-0000-0000-0000-000000000000";

  it("is rejected for a parent and for an end of a link, before any read", async () => {
    // Measured: a create under it is a 200 and a thought with no parent. A
    // plan's parent was read and found to be nobody's; an end of a link was
    // refused at the link's turn, with everything else written.
    for (const [plan, message] of [
      [
        { thoughts: [{ tempId: "a", name: "A", parent: ZEROS }] },
        `thought "a" references parent ${ZEROS}, the all-zero UUID, which names no thought`,
      ],
      [
        { thoughts: [{ tempId: "a", name: "A", parent: ZEROS, relation: "jump" }] },
        `thought "a" references parent ${ZEROS}, the all-zero UUID, which names no thought`,
      ],
      [
        {
          thoughts: [{ tempId: "a", name: "A", parent: ROOT }],
          links: [{ from: "a", to: ZEROS, name: "x" }],
        },
        `the link a -> ${ZEROS} references ${ZEROS}, the all-zero UUID, in its to field, ` +
          "and it names no thought",
      ],
      [
        {
          thoughts: [{ tempId: "a", name: "A", parent: ROOT }],
          links: [{ from: ZEROS, to: "a", relation: "child" }],
        },
        `the link ${ZEROS} -> a references ${ZEROS}, the all-zero UUID, in its from field, ` +
          "and it names no thought",
      ],
    ] as const) {
      expect(() => planLevels(plan as IngestPlan), message).toThrowError(message);
      const fake = fakeBrain([{ id: ROOT, name: "root" }]);
      const refused = await ingest(fake.api, BRAIN, plan as IngestPlan).catch((e: unknown) => e);
      expect(refused, message).toBeInstanceOf(IngestMissingError);
      expect((refused as IngestMissingError).ids).toEqual([ZEROS]);
      expect([...fake.thoughts.keys()], message).toEqual([ROOT]);
      expect([...fake.parentReads, ...fake.thoughtReads, ...fake.graphReads], message).toEqual([]);
    }
  });

  it("is a tempId like any other when the plan has a thought by that label", () => {
    // A label is whatever the plan calls its thought, and names nothing else.
    expect(() =>
      planLevels({
        thoughts: [
          { tempId: ZEROS, name: "Top", parent: ROOT },
          { tempId: "a", name: "A", parent: ZEROS },
        ],
        links: [{ from: "a", to: ZEROS }],
      }),
    ).not.toThrow();
  });
});

describe("a plan thought's name, set against the name a thought is stored by", () => {
  const THERE = "dddddddd-0000-4000-8000-000000000004";
  const under = (name: string) =>
    fakeBrain([
      { id: ROOT, name: "root" },
      { id: THERE, name, parent: ROOT },
    ]);
  const one = (name: string): IngestPlan => ({ thoughts: [{ tempId: "t1", name, parent: ROOT }] });

  it("a name sent with a tab, a line feed or white space around it finds the thought it was stored as", async () => {
    // TheBrain stores a tab and a line feed as a space each and drops the
    // white space at the ends, a next line included. Looked for as it was
    // sent, the thought was made again by every run of the plan.
    for (const [sent, stored] of [
      ["a\tb", "a b"],
      ["a\nb", "a b"],
      ["\u0085Idea\u0085", "Idea"],
      ["\u00a0 Idea\t", "Idea"],
      ["  Idea  ", "Idea"],
    ] as const) {
      const { api, thoughts } = under(stored);
      for (const run of ["first", "second"]) {
        const outcome = await ingest(api, BRAIN, one(sent));
        const where = `${JSON.stringify(sent)}, ${run} run`;
        expect(outcome.failures, where).toEqual([]);
        expect(outcome.created, where).toEqual([]);
        expect(
          outcome.reused.map((r) => r.thoughtId),
          where,
        ).toEqual([THERE]);
      }
      expect(thoughts.size, JSON.stringify(sent)).toBe(2);
    }
  });

  it("a byte order mark or a zero width space at an end is part of the name, as the API has it", async () => {
    // `trim()` drops the first, so "Idea" used to land on a thought stored
    // as "\ufeffIdea", which is another name.
    for (const [sent, stored] of [
      ["Idea", "\ufeffIdea"],
      ["\ufeffIdea", "Idea"],
      ["Idea", "Idea\u200b"],
    ] as const) {
      const { api } = under(stored);
      const outcome = await ingest(api, BRAIN, one(sent));
      const where = `${JSON.stringify(sent)} beside ${JSON.stringify(stored)}`;
      expect(outcome.reused, where).toEqual([]);
      expect(
        outcome.created.map((c) => c.name),
        where,
      ).toEqual([sent]);
    }
    // The same name, mark and all, is the same thought.
    const { api } = under("\ufeffIdea");
    const outcome = await ingest(api, BRAIN, one("\ufeffIdea"));
    expect(outcome.reused.map((r) => r.thoughtId)).toEqual([THERE]);
  });

  it("two plan items whose names are stored alike are one create", async () => {
    const { api, thoughts } = fakeBrain([{ id: ROOT, name: "root" }]);
    const outcome = await ingest(api, BRAIN, {
      thoughts: [
        { tempId: "t1", name: "a\tb", parent: ROOT },
        { tempId: "t2", name: " a b\n", parent: ROOT },
      ],
    });
    expect(outcome.failures).toEqual([]);
    expect(outcome.created.map((c) => c.tempId)).toEqual(["t1"]);
    expect(outcome.reused.map((r) => r.tempId)).toEqual(["t2"]);
    expect(thoughts.size).toBe(2);
  });
});
