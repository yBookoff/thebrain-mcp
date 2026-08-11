import { describe, expect, it, vi } from "vitest";

import { TheBrainApi } from "../src/api/index.js";
import { replayThoughtIds, warnIfFencedCode } from "../src/api/index.js";
import type { ModificationLogDto, ThoughtDto } from "../src/api/types.js";

const BRAIN = "aaaaaaaa-0000-4000-8000-000000000001";
const THOUGHT = "bbbbbbbb-0000-4000-8000-000000000002";
const TYPE = "cccccccc-0000-4000-8000-000000000003";
const TAG = "dddddddd-0000-4000-8000-000000000004";

type Route = (url: URL, init: RequestInit | undefined) => unknown;

/** Tiny router: matches by path substring and method. */
function apiWith(routes: Array<[string, Route]>) {
  const calls: Array<{ method: string; url: URL; body: unknown }> = [];
  const fetchImpl = vi.fn(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const url = input instanceof URL ? input : new URL(String(input));
      const method = init?.method ?? "GET";
      const rawBody = typeof init?.body === "string" ? init.body : undefined;
      calls.push({
        method,
        url,
        body: rawBody === undefined ? undefined : JSON.parse(rawBody),
      });
      for (const [needle, handler] of routes) {
        const [wantMethod, path] = needle.includes(" ")
          ? (needle.split(" ") as [string, string])
          : ["GET", needle];
        if (method === wantMethod && url.pathname.includes(path)) {
          const value = handler(url, init as RequestInit | undefined);
          const status = typeof value === "number" ? value : 200;
          const payload = typeof value === "number" ? "" : JSON.stringify(value);
          return new Response(payload, {
            status,
            headers: { "content-type": "application/json" },
          });
        }
      }
      return new Response(JSON.stringify(`no stub for ${method} ${url.pathname}`), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  );
  const api = new TheBrainApi({
    apiKey: "k",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { api, calls, fetchImpl };
}

const thought = (id: string, name: string, extra: Partial<ThoughtDto> = {}): ThoughtDto => ({
  id,
  brainId: BRAIN,
  creationDateTime: "2026-08-11T09:00:00",
  modificationDateTime: "2026-08-11T09:00:00",
  name,
  cleanedUpName: name,
  typeId: null,
  displayModificationDateTime: null,
  forgottenDateTime: null,
  linksModificationDateTime: null,
  acType: 0,
  kind: 1,
  label: null,
  foregroundColor: null,
  backgroundColor: null,
  ...extra,
});

describe("thought graph", () => {
  it("strips the type out of parents — the API returns it twice", async () => {
    const { api } = apiWith([
      [
        "/graph",
        () => ({
          activeThought: thought(THOUGHT, "Prefix-only search", { typeId: TYPE }),
          parents: [thought(TYPE, "Constraint", { kind: 2 }), thought("p", "API constraints")],
          children: [],
          jumps: [],
          siblings: [],
          tags: [thought(TAG, "gotcha", { kind: 4 })],
          type: thought(TYPE, "Constraint", { kind: 2 }),
          links: [],
          attachments: [],
        }),
      ],
    ]);
    const g = await api.thoughts.getGraph(BRAIN, THOUGHT);
    expect(g.parents.map((p) => p.name)).toEqual(["API constraints"]);
    expect(g.type?.name).toBe("Constraint");
    expect(g.tags.map((t) => t.name)).toEqual(["gotcha"]);
  });

  it("turns null arrays into empty ones", async () => {
    const { api } = apiWith([
      [
        "/graph",
        () => ({
          activeThought: thought(THOUGHT, "lonely"),
          parents: null,
          children: null,
          jumps: null,
          siblings: null,
          tags: null,
          type: null,
          links: null,
          attachments: null,
        }),
      ],
    ]);
    const g = await api.thoughts.getGraph(BRAIN, THOUGHT);
    expect(g.parents).toEqual([]);
    expect(g.children).toEqual([]);
    expect(g.tags).toEqual([]);
  });
});

describe("updating a thought: flat fields become JSON Patch", () => {
  it("builds operations only from the fields provided", async () => {
    const { api, calls } = apiWith([["PATCH /api/thoughts", () => 200]]);
    await api.thoughts.update(BRAIN, THOUGHT, {
      name: "new name",
      label: undefined,
      foregroundColor: "#ff7145",
    });
    expect(calls[0]!.body).toEqual([
      { op: "replace", path: "/name", value: "new name" },
      { op: "replace", path: "/foregroundColor", value: "#ff7145" },
    ]);
  });

  it("null passes through — that is how a field is cleared", async () => {
    const { api, calls } = apiWith([["PATCH /api/thoughts", () => 200]]);
    await api.thoughts.update(BRAIN, THOUGHT, { label: null });
    expect(calls[0]!.body).toEqual([{ op: "replace", path: "/label", value: null }]);
  });

  it("an empty change set issues no request", async () => {
    const { api, fetchImpl } = apiWith([["PATCH /api/thoughts", () => 200]]);
    await api.thoughts.update(BRAIN, THOUGHT, {});
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("type and tag lists", () => {
  it("a 400 on an empty brain becomes an empty list", async () => {
    const { api } = apiWith([["/types", () => 400]]);
    await expect(api.thoughts.listTypes(BRAIN)).resolves.toEqual([]);
  });

  it("a non-empty list passes through unchanged", async () => {
    const { api } = apiWith([["/tags", () => [thought(TAG, "gotcha", { kind: 4 })]]]);
    const tags = await api.thoughts.listTags(BRAIN);
    expect(tags.map((t) => t.name)).toEqual(["gotcha"]);
  });
});

describe("exact name lookup", () => {
  it("404 means \"no such thought\" rather than an error", async () => {
    const { api } = apiWith([["/api/thoughts/", () => 404]]);
    await expect(api.thoughts.findByName(BRAIN, "no such thought")).resolves.toBeNull();
  });

  it("a found thought is returned", async () => {
    const { api } = apiWith([["/api/thoughts/", () => thought(THOUGHT, "present")]]);
    const found = await api.thoughts.findByName(BRAIN, "present");
    expect(found?.name).toBe("present");
  });
});

describe("notes", () => {
  const noNote = {
    brainId: BRAIN,
    sourceId: THOUGHT,
    sourceType: 2,
    modificationDateTime: "0001-01-01T00:00:00",
    markdown: "",
    html: null,
    text: null,
  };
  const withNote = { ...noNote, modificationDateTime: "2026-08-11T09:00:00", markdown: "beginning" };

  it("append on a note-less thought falls back to a full write", async () => {
    const { api, calls } = apiWith([
      ["GET /api/notes", () => noNote],
      ["POST /api/notes", () => 200],
    ]);
    await api.notes.append(BRAIN, THOUGHT, "text");
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url.pathname).toMatch(/\/update$/);
    expect(posts[0]!.body).toEqual({ markdown: "text" });
  });

  it("append on an existing note inserts a separator", async () => {
    const { api, calls } = apiWith([
      ["GET /api/notes", () => withNote],
      ["POST /api/notes", () => 200],
    ]);
    await api.notes.append(BRAIN, THOUGHT, "continued");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url.pathname).toMatch(/\/append$/);
    expect(post.body).toEqual({ markdown: "\n\ncontinued" });
  });

  it("does not double a separator that is already there", async () => {
    const { api, calls } = apiWith([
      ["GET /api/notes", () => ({ ...withNote, markdown: "beginning\n\n" })],
      ["POST /api/notes", () => 200],
    ]);
    await api.notes.append(BRAIN, THOUGHT, "next");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ markdown: "next" });
  });

  it("exists distinguishes an empty note from a missing one", async () => {
    const a = apiWith([["GET /api/notes", () => noNote]]);
    await expect(a.api.notes.exists(BRAIN, THOUGHT)).resolves.toBe(false);
    const b = apiWith([["GET /api/notes", () => withNote]]);
    await expect(b.api.notes.exists(BRAIN, THOUGHT)).resolves.toBe(true);
  });
});

describe("markdown fenced-code warning", () => {
  it("stays quiet on ordinary text", () => {
    expect(warnIfFencedCode("just text\n\nand more")).toBeNull();
  });

  it("warns about a triple backtick", () => {
    expect(warnIfFencedCode("text\n```js\nconst a = 1\n```\n")).toMatch(/closing/);
  });
});

describe("tags", () => {
  it("are attached via relation=2 rather than directly", async () => {
    const { api, calls } = apiWith([["POST /api/links", () => ({ id: "link-1" })]]);
    await api.links.attachTag(BRAIN, THOUGHT, TAG);
    expect(calls[0]!.body).toEqual({
      thoughtIdA: THOUGHT,
      thoughtIdB: TAG,
      relation: 2,
    });
  });

  it("removing an absent tag returns false instead of throwing", async () => {
    const { api } = apiWith([["GET /api/links", () => 404]]);
    await expect(api.links.detachTag(BRAIN, THOUGHT, TAG)).resolves.toBe(false);
  });
});

describe("search", () => {
  it("takes brainId from sourceThought — the root value is zeroes", async () => {
    const { api } = apiWith([
      [
        "/api/search/",
        () => [
          {
            sourceThought: thought(THOUGHT, "brain-mcp"),
            sourceLink: null,
            searchResultType: 1,
            isFromOtherBrain: false,
            name: "brain-mcp",
            attachmentId: "00000000-0000-0000-0000-000000000000",
            brainName: null,
            brainId: "00000000-0000-0000-0000-000000000000",
            entityType: 2,
            sourceType: 0,
          },
        ],
      ],
    ]);
    const hits = await api.search.inBrain(BRAIN, "brain");
    expect(hits[0]!.brainId).toBe(BRAIN);
    expect(hits[0]!.thought.name).toBe("brain-mcp");
  });

  it("results without a thought are discarded", async () => {
    const { api } = apiWith([
      [
        "/api/search/",
        () => [
          {
            sourceThought: null,
            sourceLink: null,
            searchResultType: 3,
            isFromOtherBrain: false,
            name: "attachment",
            attachmentId: "x",
            brainName: null,
            brainId: "0",
            entityType: 4,
            sourceType: 0,
          },
        ],
      ],
    ]);
    await expect(api.search.inBrain(BRAIN, "anything")).resolves.toEqual([]);
  });
});

describe("reconstructing a brain from the log", () => {
  const log = (
    sourceId: string,
    modType: number,
    at: string,
    sourceType = 2,
  ): ModificationLogDto => ({
    sourceId,
    sourceType,
    extraAId: "",
    extraAType: -1,
    extraBId: "",
    extraBType: -1,
    modType,
    oldValue: null,
    newValue: null,
    userId: "u",
    brainId: BRAIN,
    creationDateTime: at,
    modificationDateTime: at,
    syncUpdateDateTime: null,
  });

  it("created minus deleted gives the current contents", () => {
    const alive = replayThoughtIds([
      log("a", 101, "2026-08-11T09:00:00"),
      log("b", 101, "2026-08-11T09:01:00"),
      log("a", 102, "2026-08-11T09:02:00"),
      log("c", 101, "2026-08-11T09:03:00"),
    ]);
    expect([...alive].sort()).toEqual(["b", "c"]);
  });

  it("does not depend on input ordering", () => {
    const alive = replayThoughtIds([
      log("a", 102, "2026-08-11T09:02:00"),
      log("a", 101, "2026-08-11T09:00:00"),
    ]);
    expect([...alive]).toEqual([]);
  });

  it("re-creation after deletion is accounted for", () => {
    const alive = replayThoughtIds([
      log("a", 101, "2026-08-11T09:00:00"),
      log("a", 102, "2026-08-11T09:01:00"),
      log("a", 101, "2026-08-11T09:02:00"),
    ]);
    expect([...alive]).toEqual(["a"]);
  });

  it("non-thought events are ignored", () => {
    const alive = replayThoughtIds([
      log("link-1", 101, "2026-08-11T09:00:00", 3),
      log("t-1", 101, "2026-08-11T09:01:00", 2),
    ]);
    expect([...alive]).toEqual(["t-1"]);
  });
});

describe("attachments", () => {
  it("deduplication avoids a second copy of the same URL", async () => {
    const { api, calls } = apiWith([
      [
        "/by-location",
        () => [
          {
            id: "att-1",
            brainId: BRAIN,
            sourceId: THOUGHT,
            sourceType: 2,
            creationDateTime: "",
            modificationDateTime: "",
            name: "already there",
            position: 0,
            fileModificationDateTime: null,
            type: 3,
            isNotes: false,
            dataLength: null,
            location: "https://example.com/",
          },
        ],
      ],
    ]);
    const res = await api.attachments.attachUrl(BRAIN, THOUGHT, "https://example.com/");
    expect(res.created).toBe(false);
    expect(res.existing?.name).toBe("already there");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("creates the attachment when there is no duplicate", async () => {
    const { api, calls } = apiWith([
      ["/by-location", () => []],
      ["POST /api/attachments", () => 200],
    ]);
    const res = await api.attachments.attachUrl(BRAIN, THOUGHT, "https://new.example");
    expect(res.created).toBe(true);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url.searchParams.get("url")).toBe("https://new.example");
  });
});
