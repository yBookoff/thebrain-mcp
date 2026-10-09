import { describe, expect, it, vi } from "vitest";

import { TheBrainApi } from "../src/api/index.js";
import {
  LOG_PAGE_SIZE,
  compareLogTime,
  logEntryKey,
  normalizeAliases,
  replayThoughtIds,
  warnIfFencedCode,
} from "../src/api/index.js";
import { aliasesOf, type ModificationLogDto, type ThoughtDto } from "../src/api/types.js";

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

describe("aliases", () => {
  const patches = (calls: Array<{ method: string; body: unknown }>): unknown[] =>
    calls.filter((c) => c.method === "PATCH").map((c) => c.body);

  /**
   * A thought whose aliases a PATCH really changes. As measured on the live
   * API, the reads that follow a write still return the old list for a while:
   * `staleReads` of them here.
   */
  const withThought = (dto: ThoughtDto, staleReads = 0) => {
    let current = dto;
    let old = dto;
    let stale = 0;
    return apiWith([
      [
        "/api/thoughts/",
        () => {
          if (stale === 0) return current;
          stale -= 1;
          return old;
        },
      ],
      [
        "PATCH /api/thoughts",
        (_url, init) => {
          const ops = JSON.parse(String(init?.body)) as Array<{
            op: string;
            path: string;
            value?: string[];
          }>;
          for (const op of ops) {
            if (op.path !== "/aliases") continue;
            old = current;
            current = { ...current, aliases: op.op === "remove" ? [] : (op.value ?? []) };
            stale = staleReads;
          }
          return 200;
        },
      ],
    ]);
  };

  /** A brain whose home thought looks the way `home` says, and a create that works. */
  const creatable = (home: ThoughtDto) =>
    apiWith([
      ["/api/brains/", () => ({ id: BRAIN, name: "brain", homeThoughtId: home.id })],
      ["/api/thoughts/", () => home],
      ["POST /api/thoughts", () => ({ id: THOUGHT })],
    ]);
  const posts = (calls: Array<{ method: string; body: unknown }>): unknown[] =>
    calls.filter((c) => c.method === "POST").map((c) => c.body);

  it("go out with the create request", async () => {
    const { api, calls } = creatable(thought(TYPE, "home", { aliases: [] }));
    await api.thoughts.create(BRAIN, { name: "RAG", aliases: ["Retrieval-augmented generation"] });
    expect(posts(calls)).toEqual([
      expect.objectContaining({ name: "RAG", aliases: ["Retrieval-augmented generation"] }),
    ]);
  });

  it("a build without aliases is asked for none: the create is refused first", async () => {
    // What such a build does with the field is unknown. If it ignored it, the
    // thought would exist and its aliases would be reported as written.
    const { api, calls } = creatable(thought(TYPE, "home"));
    await expect(
      api.thoughts.create(BRAIN, { name: "RAG", aliases: ["Retrieval"] }),
    ).rejects.toMatchObject({ kind: "bad_request", message: expect.stringMatching(/15\.0\.621/) });
    expect(posts(calls)).toEqual([]);

    // Without aliases the same build creates thoughts as before.
    await api.thoughts.create(BRAIN, { name: "plain" });
    expect(posts(calls)).toHaveLength(1);
  });

  it("the build is asked once; a yes is remembered", async () => {
    const { api, calls } = creatable(thought(TYPE, "home", { aliases: [] }));
    await api.thoughts.create(BRAIN, { name: "one", aliases: ["a"] });
    await api.thoughts.create(BRAIN, { name: "two", aliases: ["b"] });
    expect(calls.filter((c) => c.url.pathname.includes("/api/brains/"))).toHaveLength(1);
    expect(posts(calls)).toHaveLength(2);
  });

  it("when the build cannot be asked, the create goes ahead", async () => {
    const { api, calls } = apiWith([["POST /api/thoughts", () => ({ id: THOUGHT })]]);
    await api.thoughts.create(BRAIN, { name: "RAG", aliases: ["Retrieval"] });
    expect(posts(calls)).toEqual([expect.objectContaining({ aliases: ["Retrieval"] })]);
  });

  it("stay out of the create request when there are none", async () => {
    // A build without aliases should never be sent the field unasked.
    const { api, calls } = apiWith([["POST /api/thoughts", () => ({ id: THOUGHT })]]);
    await api.thoughts.create(BRAIN, { name: "plain" });
    await api.thoughts.create(BRAIN, { name: "plain", aliases: [] });
    for (const call of calls) expect(call.body).not.toHaveProperty("aliases");
  });

  it("a list replaces the whole of /aliases", async () => {
    const { api, calls } = apiWith([["PATCH /api/thoughts", () => 200]]);
    await api.thoughts.update(BRAIN, THOUGHT, { name: "RAG", aliases: ["a", "b"] });
    expect(calls[0]!.body).toEqual([
      { op: "replace", path: "/name", value: "RAG" },
      { op: "replace", path: "/aliases", value: ["a", "b"] },
    ]);
  });

  it("null and an empty list both clear with remove", async () => {
    const { api, calls } = apiWith([["PATCH /api/thoughts", () => 200]]);
    await api.thoughts.update(BRAIN, THOUGHT, { aliases: null });
    await api.thoughts.update(BRAIN, THOUGHT, { aliases: [] });
    expect(patches(calls)).toEqual([
      [{ op: "remove", path: "/aliases" }],
      [{ op: "remove", path: "/aliases" }],
    ]);
  });

  it("adding keeps what the thought already has", async () => {
    const { api, calls } = withThought(thought(THOUGHT, "RAG", { aliases: ["Retrieval"] }));
    const outcome = await api.thoughts.changeAliases(BRAIN, THOUGHT, { add: [" R.A.G. "] });
    expect(patches(calls)).toEqual([
      [{ op: "replace", path: "/aliases", value: ["Retrieval", "R.A.G."] }],
    ]);
    expect(outcome).toEqual({
      aliases: ["Retrieval", "R.A.G."],
      added: ["R.A.G."],
      removed: [],
      readBack: true,
    });
  });

  it("an alias already there, in any case, is not written again", async () => {
    const { api, calls } = withThought(thought(THOUGHT, "RAG", { aliases: ["Retrieval"] }));
    const outcome = await api.thoughts.changeAliases(BRAIN, THOUGHT, {
      add: ["retrieval", "RETRIEVAL", "  "],
    });
    expect(patches(calls)).toEqual([]);
    expect(outcome).toEqual({ aliases: ["Retrieval"], added: [], removed: [], readBack: true });
  });

  it("an alias equal to the name, in any case, is not written: the API drops it", async () => {
    const { api, calls } = withThought(thought(THOUGHT, "RAG", { aliases: [] }));
    const outcome = await api.thoughts.changeAliases(BRAIN, THOUGHT, { add: [" RAG ", "rag"] });
    expect(patches(calls)).toEqual([]);
    expect(outcome.added).toEqual([]);
  });

  it("returns only once the written list reads back", async () => {
    // Measured: a read straight after the write returns the old list, and a
    // second edit built on it left only the second alias.
    const { api, calls } = withThought(thought(THOUGHT, "RAG", { aliases: [] }), 3);
    const first = await api.thoughts.changeAliases(BRAIN, THOUGHT, { add: ["one"] });
    expect(first.readBack).toBe(true);
    // One read to learn the list, three stale ones, and the one that agrees.
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(5);

    const second = await api.thoughts.changeAliases(BRAIN, THOUGHT, { add: ["two"] });
    expect(second.aliases).toEqual(["one", "two"]);
    expect(patches(calls).at(-1)).toEqual([
      { op: "replace", path: "/aliases", value: ["one", "two"] },
    ]);
  });

  it("says so when the written list never reads back, instead of waiting forever", async () => {
    vi.useFakeTimers();
    try {
      const { api } = withThought(thought(THOUGHT, "RAG", { aliases: [] }), Infinity);
      const pending = api.thoughts.changeAliases(BRAIN, THOUGHT, { add: ["one"] });
      await vi.advanceTimersByTimeAsync(5000);
      await expect(pending).resolves.toMatchObject({ added: ["one"], readBack: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a list that would pass a hundred is refused before anything is written", async () => {
    // The API keeps the first hundred and drops the rest without a word.
    const full = Array.from({ length: 99 }, (_, i) => `alias ${i}`);
    const { api, calls } = withThought(thought(THOUGHT, "RAG", { aliases: full }));
    await expect(
      api.thoughts.changeAliases(BRAIN, THOUGHT, { add: ["one more", "and another"] }),
    ).rejects.toMatchObject({ kind: "bad_request", message: expect.stringMatching(/101/) });
    await expect(
      api.thoughts.changeAliases(BRAIN, THOUGHT, { add: ["one more"] }),
    ).resolves.toMatchObject({ added: ["one more"] });
    expect(patches(calls)).toHaveLength(1);
  });

  it("removal ignores case, and runs before addition so one call can swap", async () => {
    const { api, calls } = withThought(
      thought(THOUGHT, "RAG", { aliases: ["Retreival", "R.A.G."] }),
    );
    const outcome = await api.thoughts.changeAliases(BRAIN, THOUGHT, {
      remove: ["retreival", "never there"],
      add: ["Retrieval"],
    });
    expect(patches(calls)).toEqual([
      [{ op: "replace", path: "/aliases", value: ["R.A.G.", "Retrieval"] }],
    ]);
    expect(outcome.removed).toEqual(["Retreival"]);
    expect(outcome.added).toEqual(["Retrieval"]);
  });

  it("removing the last alias clears the list", async () => {
    const { api, calls } = withThought(thought(THOUGHT, "RAG", { aliases: ["Retrieval"] }));
    await api.thoughts.changeAliases(BRAIN, THOUGHT, { remove: ["Retrieval"] });
    expect(patches(calls)).toEqual([[{ op: "remove", path: "/aliases" }]]);
  });

  it("a thought from a build without aliases reads as having none", async () => {
    // Before 15.0.621 the field is absent altogether; `thought()` omits it too.
    const old = thought(THOUGHT, "RAG");
    expect(old).not.toHaveProperty("aliases");
    expect(aliasesOf(old)).toEqual([]);
    expect(aliasesOf({ aliases: null })).toEqual([]);

    const { api, calls } = withThought(old);
    const outcome = await api.thoughts.changeAliases(BRAIN, THOUGHT, { remove: ["x"] });
    expect(outcome).toEqual({ aliases: [], added: [], removed: [], readBack: true });

    // Adding is another matter: there is nowhere to put it.
    await expect(
      api.thoughts.changeAliases(BRAIN, THOUGHT, { add: ["Retrieval"] }),
    ).rejects.toMatchObject({ kind: "bad_request", message: expect.stringMatching(/15\.0\.621/) });
    expect(patches(calls)).toEqual([]);
  });

  it("normalizeAliases trims, drops blanks and keeps the first of two spellings", () => {
    expect(normalizeAliases([" RAG ", "rag", "", "   ", "Retrieval", "RETRIEVAL"])).toEqual([
      "RAG",
      "Retrieval",
    ]);
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

describe("reconstructing a brain from the log", () => {
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

  it("orders a create and a delete that share a millisecond", () => {
    // Newest first, as the API returns them. Through Date both parse to .617,
    // the sort keeps them as they came, and the thought is replayed back to life.
    const alive = replayThoughtIds([
      log("a", 102, "2026-09-30T13:48:59.617093"),
      log("a", 101, "2026-09-30T13:48:59.617092"),
    ]);
    expect([...alive]).toEqual([]);
  });
});

describe("log timestamps", () => {
  it("order by microseconds that Date would merge", () => {
    expect(compareLogTime("2026-09-30T13:48:59.617092", "2026-09-30T13:48:59.617093")).toBe(-1);
    expect(Date.parse("2026-09-30T13:48:59.617092Z")).toBe(
      Date.parse("2026-09-30T13:48:59.617093Z"),
    );
  });

  it("compare trimmed fractions by value, not by length", () => {
    // The API trims trailing zeros: .61898 is .618980.
    expect(compareLogTime("2026-09-30T13:48:59.61898", "2026-09-30T13:48:59.618886")).toBe(1);
    expect(compareLogTime("2026-09-30T13:48:59", "2026-09-30T13:48:59.000001")).toBe(-1);
    expect(compareLogTime("2026-09-30T13:48:59.5", "2026-09-30T13:48:59.500000")).toBe(0);
  });
});

describe("reading the whole log", () => {
  /** Microseconds past 13:00:00, formatted the way the API trims them. */
  const at = (us: number): string => {
    const fraction = String(us).padStart(6, "0").replace(/0+$/, "");
    return `2026-09-30T13:00:00${fraction === "" ? "" : `.${fraction}`}`;
  };
  // Ties of two, three and four, entries a microsecond apart, and one entry
  // with no fraction at all.
  const MICROS = [
    0, 1, 2, 2, 100, 100, 100, 100, 101, 1000, 1001, 1001, 5000, 5001, 5002, 5003,
    90000, 90000, 90001, 500000, 500001, 600000, 600000, 600000, 999999,
  ];
  const entries = MICROS.map((us, i) => log(`t-${i}`, 101, at(us)));
  const newestFirst = [...entries].reverse();

  /**
   * Behaves as measured on the live API: both bounds inclusive to the
   * microsecond, and truncation keeps the newest, newest first.
   */
  const logRoute = (url: URL): ModificationLogDto[] => {
    const maxLogs = Number(url.searchParams.get("maxLogs"));
    const start = url.searchParams.get("startTime");
    const end = url.searchParams.get("endTime");
    return newestFirst
      .filter((l) => start === null || compareLogTime(l.creationDateTime, start) >= 0)
      .filter((l) => end === null || compareLogTime(l.creationDateTime, end) <= 0)
      .slice(0, maxLogs);
  };

  it("returns every entry exactly once, whatever the page size", async () => {
    for (let pageSize = 1; pageSize <= entries.length + 1; pageSize++) {
      const { api } = apiWith([["/modifications", logRoute]]);
      const all = await api.brains.allModifications(BRAIN, { pageSize });
      expect(all.map(logEntryKey), `pageSize ${pageSize}`).toEqual(newestFirst.map(logEntryKey));
    }
  });

  it("sends the oldest entry's timestamp back unchanged", async () => {
    // Through Date, .500001 would leave as .500Z, and the entry itself would
    // fall outside the next page.
    const { api, calls } = apiWith([["/modifications", logRoute]]);
    await api.brains.allModifications(BRAIN, { pageSize: 4 });
    const bounds = calls.map((c) => c.url.searchParams.get("endTime"));
    expect(bounds[0]).toBeNull();
    expect(bounds.length).toBeGreaterThan(2);
    for (const bound of bounds.slice(1)) {
      expect(entries.map((l) => l.creationDateTime)).toContain(bound);
    }
  });

  it("grows a page that one timestamp fills, instead of asking for it again", async () => {
    const { api, calls } = apiWith([["/modifications", logRoute]]);
    const all = await api.brains.allModifications(BRAIN, { pageSize: 2 });
    expect(all).toHaveLength(entries.length);
    const sizes = calls.map((c) => Number(c.url.searchParams.get("maxLogs")));
    expect(Math.max(...sizes)).toBeGreaterThan(2);
    // A request never repeats: either the boundary moved or the page grew.
    const requests = calls.map((c) => c.url.search);
    expect(new Set(requests).size).toBe(requests.length);
  });

  it("keeps since on every page", async () => {
    const { api, calls } = apiWith([["/modifications", logRoute]]);
    const since = at(1001);
    const all = await api.brains.allModifications(BRAIN, { since, pageSize: 3 });
    expect(all.map(logEntryKey)).toEqual(
      newestFirst.filter((l) => compareLogTime(l.creationDateTime, since) >= 0).map(logEntryKey),
    );
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(c.url.searchParams.get("startTime")).toBe(since);
  });

  it("makes one request when the log fits in a page", async () => {
    const { api, calls } = apiWith([["/modifications", logRoute]]);
    await expect(api.brains.allModifications(BRAIN)).resolves.toHaveLength(entries.length);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("maxLogs")).toBe(String(LOG_PAGE_SIZE));
  });

  it("asks for nothing more once the reader stops", async () => {
    const { api, calls } = apiWith([["/modifications", logRoute]]);
    for await (const page of api.brains.modificationPages(BRAIN, { pageSize: 5 })) {
      expect(page).toHaveLength(5);
      break;
    }
    expect(calls).toHaveLength(1);
  });

  it("drops entries newer than the boundary if the API ever returns them", async () => {
    // An API that ignored endTime would repeat the newest page forever; the
    // page grows until it covers the log, and nothing comes back twice.
    const { api } = apiWith([
      [
        "/modifications",
        (url) => newestFirst.slice(0, Number(url.searchParams.get("maxLogs"))),
      ],
    ]);
    const all = await api.brains.allModifications(BRAIN, { pageSize: 3 });
    expect(all.map(logEntryKey)).toEqual(newestFirst.map(logEntryKey));
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
