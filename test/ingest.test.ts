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
  /** The brain's types, and each read that asked whether something is one. */
  const types = new Set<string>();
  const typeReads: string[] = [];
  /** The same for tags. TAG is one from the start. */
  const tags = new Set<string>([TAG]);
  const tagReads: string[] = [];

  const api = {
    thoughts: {
      async create(
        _b: string,
        input: {
          name: string;
          sourceThoughtId?: string;
          aliases?: readonly string[];
          typeId?: string;
        },
      ) {
        if (failOn.has(input.name)) throw new Error("server refused");
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
    },
  };
  const settle = (): void => unsettled.clear();
  return {
    api: api as unknown as TheBrainApi,
    thoughts,
    links,
    failOn,
    types,
    typeReads,
    tags,
    tagReads,
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
    expect(outcome.failures).toHaveLength(2); // the thought itself and its link
    expect(outcome.failures[0]!.what).toMatch(/Idea B/);
    expect(outcome.failures.some((f) => f.reason.includes("was not created"))).toBe(true);
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
    // Refused at its own turn instead, the thought would leave those under it
    // created with no parent.
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
