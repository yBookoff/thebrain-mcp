import { describe, expect, it } from "vitest";

import { TheBrainError, type TheBrainApi } from "../src/api/index.js";
import {
  IngestValidationError,
  ingest,
  planLevels,
  type IngestPlan,
} from "../src/operations/ingest.js";

const BRAIN = "aaaaaaaa-0000-4000-8000-000000000001";
const ROOT = "bbbbbbbb-0000-4000-8000-000000000002";
const TAG = "eeeeeeee-0000-4000-8000-000000000005";

/** In-memory fake brain: keeps what was created and can list children. */
function fakeBrain(
  existing: Array<{
    id: string;
    name: string;
    parent?: string;
    aliases?: string[];
    typeId?: string;
  }> = [],
) {
  let counter = 0;
  const thoughts = new Map(
    existing.map((e) => [
      e.id,
      { ...e, note: "", tags: [] as string[], aliases: e.aliases ?? [] },
    ]),
  );
  /** Whole-list alias writes after creation: the only kind the API offers. */
  const aliasWrites: Array<{ id: string; aliases: string[] }> = [];
  /**
   * Thoughts created here whose aliases do not read back yet. On the live API
   * that happens now and then for a moment; here, to every new thought until
   * `settle()`, which is the case the code has to survive.
   */
  const unsettled = new Set<string>();
  /** Flip `aliases` off to stand in for a build from before 15.0.621. */
  const build = { aliases: true };
  const links: Array<{ a: string; b: string; relation: number; name?: string }> = [];
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
  /** Each read that asked whether something named as a parent is a type. */
  const parentReads: string[] = [];
  // As the real check: a type is no parent, and anything else passes.
  const refuseTypeAsParent = (id: string, field: string): void => {
    if (types.has(id)) {
      throw new TheBrainError("not_a_parent", `${field} ${id} cannot be a parent: it is a type`);
    }
  };
  const known = (id: string): boolean => thoughts.has(id) || types.has(id) || tags.has(id);

  const api = {
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
        if (failOn.has(input.name)) throw new Error("server refused");
        if (failWith.has(input.name)) throw failWith.get(input.name)!;
        // As the real method: a thought is not made the child of a type.
        if (input.sourceThoughtId !== undefined && (input.relation ?? 1) === 1) {
          refuseTypeAsParent(input.sourceThoughtId, "sourceThoughtId");
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
        thoughts.set(id, {
          id,
          name: input.name,
          ...(input.sourceThoughtId !== undefined ? { parent: input.sourceThoughtId } : {}),
          ...(input.typeId !== undefined ? { typeId: input.typeId } : {}),
          note: "",
          tags: [],
          aliases: [...(input.aliases ?? [])],
        });
        unsettled.add(id);
        // The real API creates a parent link alongside the thought — without
        // this the fake diverges from reality on link deduplication.
        if (input.sourceThoughtId !== undefined) {
          links.push({ a: input.sourceThoughtId, b: id, relation: 1 });
        }
        if (lostOn.has(input.name)) {
          throw new TheBrainError("network", "request exceeded 30000 ms");
        }
        return id;
      },
      async getGraph(_b: string, id: string) {
        return {
          thought: { id, name: thoughts.get(id)?.name ?? "" },
          children: [...thoughts.values()]
            .filter((t) => t.parent === id)
            .map((t) => ({ id: t.id, name: t.name })),
        };
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
      async changeAliases(_b: string, id: string, changes: { add?: readonly string[] }) {
        const t = thoughts.get(id)!;
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
        return { aliases: t.aliases, added, removed: [], readBack: true };
      },
    },
    notes: {
      async set(_b: string, id: string, markdown: string) {
        const t = thoughts.get(id);
        if (t !== undefined) t.note = markdown;
      },
    },
    links: {
      async between(_b: string, a: string, b: string) {
        const found = links.find(
          (l) => (l.a === a && l.b === b) || (l.a === b && l.b === a),
        );
        return found === undefined ? null : { id: `link-${links.indexOf(found)}`, ...found };
      },
      async create(
        _b: string,
        input: { thoughtIdA: string; thoughtIdB: string; relation: number; name?: string },
      ) {
        // As the real method: no parent/child link with a type for its upper end.
        if (input.relation === 1) refuseTypeAsParent(input.thoughtIdA, "thoughtIdA");
        if (input.relation === 2) refuseTypeAsParent(input.thoughtIdB, "thoughtIdB");
        links.push({
          a: input.thoughtIdA,
          b: input.thoughtIdB,
          relation: input.relation,
          ...(input.name !== undefined ? { name: input.name } : {}),
        });
        return `link-${links.length - 1}`;
      },
      async update() {
        return undefined;
      },
      // As the real method: throws unless the identifier names a tag.
      async requireTag(_b: string, tagId: string) {
        tagReads.push(tagId);
        if (!tags.has(tagId)) {
          throw new TheBrainError("not_a_tag", `tagId ${tagId} is not a tag`);
        }
        return { id: tagId, kind: 4 };
      },
      async attachTag(_b: string, thoughtId: string, tagId: string) {
        thoughts.get(thoughtId)?.tags.push(tagId);
        return "tag-link";
      },
      async requireParent(_b: string, id: string, field: string) {
        parentReads.push(id);
        refuseTypeAsParent(id, field);
      },
    },
  };
  const settle = (): void => unsettled.clear();
  return {
    api: api as unknown as TheBrainApi,
    thoughts,
    links,
    failOn,
    failWith,
    lostOn,
    types,
    typeReads,
    tags,
    tagReads,
    parentReads,
    aliasWrites,
    build,
    settle,
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
      /empty name/,
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
    // Deduplication looks among a parent's children, and here there is none
    // to look under. It is why a batch written in part asks for the rest alone.
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

describe("a thought that fails in the middle of a batch", () => {
  const NOBODY = "99999999-0000-4000-8000-000000000009";
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
    expect(outcome.failures).toEqual([{ what: 'thought "Top" (top)', reason: "server refused" }]);
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
    expect(outcome.failures).toEqual([{ what: 'thought "Mid" (mid)', reason: "server refused" }]);
    expect(outcome.skipped).toEqual([
      { what: 'thought "Leaf" (leaf)', reason: needs("mid") },
      { what: "link mid -> side", reason: needs("mid") },
      { what: "link leaf -> top", reason: needs("mid") },
    ]);
    expect(outcome.notesWritten).toBe(2);
    expect(outcome.tagsAttached).toBe(0);
  });

  it("a parent nobody has fails its children with the API's words, and theirs are skipped", async () => {
    // Read ahead of the writes it passes for a parent: it is no type.
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    const outcome = await ingest(fake.api, BRAIN, plan(NOBODY));

    expect(roots(fake)).toEqual(["root"]);
    expect(outcome.failures).toEqual([
      { what: 'thought "Top" (top)', reason: `Source Thought ${NOBODY} could not be located` },
    ]);
    expect(outcome.skipped.map((s) => s.what)).toEqual([
      'thought "Mid" (mid)',
      'thought "Leaf" (leaf)',
      "link mid -> side",
      "link leaf -> top",
    ]);
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

  it("two plan items for one thought fail together, and what is under either is skipped", async () => {
    const fake = fakeBrain([{ id: ROOT, name: "root" }]);
    fake.failOn.add("Same");
    const outcome = await ingest(fake.api, BRAIN, {
      thoughts: [
        { tempId: "x", name: "Same", parent: ROOT },
        { tempId: "y", name: "Same", parent: ROOT },
        { tempId: "under", name: "Leaf", parent: "y" },
      ],
    });

    expect(names(fake)).toEqual(["root"]);
    expect(outcome.failures.map((f) => f.what)).toEqual(['thought "Same" (x)', 'thought "Same" (y)']);
    expect(outcome.skipped).toEqual([{ what: 'thought "Leaf" (under)', reason: needs("y") }]);
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
    expect(outcome.failures).toEqual([
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
    expect(outcome.failures).toEqual([
      { what: 'thought "Top" (top)', reason: "could not reach http://localhost:11522" },
      { what: 'thought "Side" (side)', reason: "boom" },
    ]);
  });
});

describe("aliases in a batch", () => {
  const RAG = "cccccccc-0000-4000-8000-000000000003";
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

  it("a failed alias write shows in the report and stops nothing else", async () => {
    const { api, failOn } = fakeBrain([
      { id: ROOT, name: "root" },
      { id: RAG, name: "RAG", parent: ROOT },
    ]);
    failOn.add("aliases of RAG");
    const outcome = await ingest(api, BRAIN, plan);

    expect(outcome.created).toHaveLength(1);
    expect(outcome.aliasesWritten).toBe(0);
    expect(outcome.failures).toEqual([{ what: 'aliases for "RAG"', reason: "server refused" }]);
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
      links: [
        { from: "a", to: TYPE },
        { from: OTHER, to: TYPE, relation: "jump" },
        { from: OTHER, to: TYPE, relation: "child" },
        { from: TYPE, to: "above", relation: "parent" },
      ],
    });

    expect(outcome.failures).toEqual([]);
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

    expect(outcome.reused).toEqual([{ tempId: "x", thoughtId: TYPE, name: "Pattern" }]);
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

describe("reporting links that already existed", () => {
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
    expect(second.linksReused[0]!.note).toMatch(/label updated/);
    expect(second.linksReused[0]!.note).not.toMatch(/not added/);
  });
});
