import { describe, expect, it } from "vitest";

import { TheBrainError, type CleanGraph, type TheBrainApi } from "../src/api/index.js";
import { traverse } from "../src/operations/traverse.js";

const BRAIN = "aaaaaaaa-0000-4000-8000-000000000001";

/**
 * In-memory fake brain for a walk: `children` says what hangs under what, and
 * a graph lists a thought's children and its parents, as the API's does.
 * `failing` holds, by thought, what the read of its graph throws.
 */
function fakeBrain(children: Record<string, string[]>) {
  const reads: string[] = [];
  const failing = new Map<string, Error>();
  const named = (id: string) => ({ id, name: id.toUpperCase(), kind: 1 });
  const api = {
    thoughts: {
      async getGraph(_b: string, id: string): Promise<CleanGraph> {
        reads.push(id);
        const failure = failing.get(id);
        if (failure !== undefined) throw failure;
        const above = Object.keys(children).filter((p) => children[p]!.includes(id));
        return {
          thought: named(id),
          children: (children[id] ?? []).map(named),
          parents: above.map(named),
          jumps: [],
          siblings: [],
          tags: [],
          type: null,
          links: [],
          attachments: [],
        } as unknown as CleanGraph;
      },
    },
  };
  return { api: api as unknown as TheBrainApi, reads, failing };
}

/** root over a and b; a over a1 and a2; b over b1 and, as a does, a2. */
const TREE = { root: ["a", "b"], a: ["a1", "a2"], b: ["b1", "a2"] };
const boom = new TheBrainError("server", "boom", { status: 500, method: "GET", path: "/graph" });

describe("a graph that fails to read during a walk", () => {
  it("is named in the outcome, and the walk goes on without it", async () => {
    // The failure used to be dropped: `a` stood among the nodes like any
    // other, and read as a thought with nothing next to it.
    const fake = fakeBrain(TREE);
    fake.failing.set("a", boom);
    const result = await traverse(fake.api, BRAIN, "root", { depth: 2, follow: ["child"] });

    expect(result.unread).toEqual([{ id: "a", name: "A", error: boom }]);
    // `a` is still a thought the walk reached, and `a2` is reached through `b`.
    expect(result.nodes.map((n) => n.id)).toEqual(["root", "a", "b", "b1", "a2"]);
    // What only `a` led to is not there.
    expect(result.nodes.map((n) => n.id)).not.toContain("a1");
    expect(result.edges.map((e) => `${e.from}>${e.to}`)).toEqual([
      "root>a",
      "root>b",
      "b>b1",
      "b>a2",
    ]);
    expect(result.truncated).toBe(false);
  });

  it("every graph that failed is named, each with its own failure", async () => {
    const fake = fakeBrain(TREE);
    const lost = new TheBrainError("network", "request exceeded 30000 ms");
    fake.failing.set("a", boom);
    fake.failing.set("b", lost);
    const result = await traverse(fake.api, BRAIN, "root", { depth: 2, follow: ["child"] });

    expect(result.unread).toEqual([
      { id: "a", name: "A", error: boom },
      { id: "b", name: "B", error: lost },
    ]);
    expect(result.nodes.map((n) => n.id)).toEqual(["root", "a", "b"]);
  });

  it("is asked once: a read that failed is not sent again within the walk", async () => {
    const fake = fakeBrain(TREE);
    fake.failing.set("a", boom);
    await traverse(fake.api, BRAIN, "root", { depth: 3, follow: ["child", "parent"] });

    expect(fake.reads.filter((id) => id === "a")).toEqual(["a"]);
  });

  it("the starting thought's is the walk's own failure: there is no result to name it in", async () => {
    const fake = fakeBrain(TREE);
    fake.failing.set("root", boom);

    await expect(traverse(fake.api, BRAIN, "root")).rejects.toBe(boom);
    expect(fake.reads).toEqual(["root"]);
  });

  it("a walk that reads every graph has nothing unread, and is what it was", async () => {
    const fake = fakeBrain(TREE);
    const result = await traverse(fake.api, BRAIN, "root", { depth: 2, follow: ["child"] });

    expect(result.unread).toEqual([]);
    expect(result.nodes.map((n) => [n.id, n.depth, n.path])).toEqual([
      ["root", 0, []],
      ["a", 1, ["ROOT"]],
      ["b", 1, ["ROOT"]],
      ["a1", 2, ["ROOT", "A"]],
      ["a2", 2, ["ROOT", "A"]],
      ["b1", 2, ["ROOT", "B"]],
    ]);
    expect(result.edges).toHaveLength(6);
    // The thoughts of the last hop are listed and not looked around.
    expect(fake.reads).toEqual(["root", "a", "b"]);
  });

  it("a thought past the last hop is not read, and so is never among the unread", async () => {
    const fake = fakeBrain(TREE);
    fake.failing.set("a1", boom);
    const result = await traverse(fake.api, BRAIN, "root", { depth: 2, follow: ["child"] });

    expect(result.unread).toEqual([]);
    expect(result.nodes.map((n) => n.id)).toContain("a1");
  });
});
