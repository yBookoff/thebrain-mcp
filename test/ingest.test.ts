import { describe, expect, it } from "vitest";

import type { TheBrainApi } from "../src/api/index.js";
import {
  IngestValidationError,
  ingest,
  planLevels,
  type IngestPlan,
} from "../src/operations/ingest.js";

const BRAIN = "aaaaaaaa-0000-4000-8000-000000000001";
const ROOT = "bbbbbbbb-0000-4000-8000-000000000002";

/** In-memory fake brain: keeps what was created and can list children. */
function fakeBrain(
  existing: Array<{ id: string; name: string; parent?: string }> = [],
) {
  let counter = 0;
  const thoughts = new Map(
    existing.map((e) => [e.id, { ...e, note: "", tags: [] as string[] }]),
  );
  const links: Array<{ a: string; b: string; relation: number; name?: string }> = [];
  const failOn = new Set<string>();

  const api = {
    thoughts: {
      async create(_b: string, input: { name: string; sourceThoughtId?: string }) {
        if (failOn.has(input.name)) throw new Error("server refused");
        counter += 1;
        const id = `new-${counter}`;
        thoughts.set(id, {
          id,
          name: input.name,
          ...(input.sourceThoughtId !== undefined ? { parent: input.sourceThoughtId } : {}),
          note: "",
          tags: [],
        });
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
      async attachTag(_b: string, thoughtId: string, tagId: string) {
        thoughts.get(thoughtId)?.tags.push(tagId);
        return "tag-link";
      },
    },
  };
  return { api: api as unknown as TheBrainApi, thoughts, links, failOn };
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
      { tempId: "b", name: "Idea B", parent: "root", tagIds: ["tag-1"] },
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
