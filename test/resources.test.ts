import { describe, expect, it, vi } from "vitest";

import { TheBrainApi } from "../src/api/index.js";
import {
  LOG_PAGE_SIZE,
  compareLogTime,
  logEntryKey,
  logTime,
  normalizeAliases,
  replayThoughtIds,
  urlKey,
  warnIfFencedCode,
} from "../src/api/index.js";
import {
  Relation,
  aliasesOf,
  type AttachmentDto,
  type ModificationLogDto,
  type ThoughtDto,
} from "../src/api/types.js";

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

  it("null clears a label or a colour with remove", async () => {
    // Measured: `replace` with null is a 403 for a label and a 400 for a colour.
    const { api, calls } = apiWith([["PATCH /api/thoughts", () => 200]]);
    await api.thoughts.update(BRAIN, THOUGHT, {
      name: "kept",
      label: null,
      foregroundColor: null,
      backgroundColor: null,
    });
    expect(calls[0]!.body).toEqual([
      { op: "replace", path: "/name", value: "kept" },
      { op: "remove", path: "/label" },
      { op: "remove", path: "/foregroundColor" },
      { op: "remove", path: "/backgroundColor" },
    ]);
  });

  it("an empty change set issues no request", async () => {
    const { api, fetchImpl } = apiWith([["PATCH /api/thoughts", () => 200]]);
    await api.thoughts.update(BRAIN, THOUGHT, {});
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a typeId that is not a UUID is refused before any request, the empty string too", async () => {
    // The API answers 200 to an empty typeId and changes nothing.
    const { api, fetchImpl } = apiWith([["PATCH /api/thoughts", () => 200]]);
    for (const typeId of ["", "Constraint"]) {
      await expect(api.thoughts.update(BRAIN, THOUGHT, { typeId })).rejects.toMatchObject({
        kind: "invalid_uuid",
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("removing a type", () => {
  const LINK = "eeeeeeee-0000-4000-8000-000000000005";

  /**
   * A thought of type TYPE. Deleting the link between them takes the type
   * away, but as measured on the live API the reads that follow still return
   * it for a while: `staleReads` of them here.
   */
  const typed = (options: { staleReads?: number; meaning?: number; linked?: boolean } = {}) => {
    const { staleReads = 0, meaning = 2, linked = true } = options;
    let typeId: string | null = TYPE;
    let stale = 0;
    return apiWith([
      [
        "/api/thoughts/",
        () => {
          if (typeId !== null || stale === 0) return thought(THOUGHT, "typed", { typeId });
          stale -= 1;
          return thought(THOUGHT, "typed", { typeId: TYPE });
        },
      ],
      ["PATCH /api/thoughts/", () => 200],
      [
        "/api/links/",
        () =>
          linked && typeId !== null
            ? { id: LINK, thoughtIdA: TYPE, thoughtIdB: THOUGHT, relation: 1, meaning }
            : 404,
      ],
      [
        "DELETE /api/links/",
        () => {
          typeId = null;
          stale = staleReads;
          return 200;
        },
      ],
    ]);
  };
  const sent = (calls: Array<{ method: string; url: URL }>, method: string): string[] =>
    calls.filter((c) => c.method === method).map((c) => c.url.pathname);

  it("deletes the link from the type, since no patch clears typeId", async () => {
    // Measured: `replace /typeId` with null answers 200 and changes nothing,
    // and `remove` is a 403.
    const { api, calls } = typed();
    await api.thoughts.update(BRAIN, THOUGHT, { typeId: null });
    expect(sent(calls, "PATCH")).toEqual([]);
    expect(sent(calls, "GET")).toContain(`/api/links/${BRAIN}/${TYPE}/${THOUGHT}`);
    expect(sent(calls, "DELETE")).toEqual([`/api/links/${BRAIN}/${LINK}`]);
  });

  it("goes after the other fields, which still travel as one patch", async () => {
    const { api, calls } = typed();
    await api.thoughts.update(BRAIN, THOUGHT, { typeId: null, label: "pattern" });
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => c.method)).toEqual(["PATCH", "DELETE"]);
    expect(writes[0]!.body).toEqual([{ op: "replace", path: "/label", value: "pattern" }]);
  });

  it("returns only once the thought reads back without its type", async () => {
    const { api, calls } = typed({ staleReads: 3 });
    await expect(api.thoughts.removeType(BRAIN, THOUGHT)).resolves.toBe(true);
    // One read to learn the type, three stale ones, and the one that agrees.
    expect(sent(calls, "GET").filter((path) => path.includes("/api/thoughts/"))).toHaveLength(5);
  });

  it("a thought with no type is left alone", async () => {
    const { api, calls } = apiWith([["/api/thoughts/", () => thought(THOUGHT, "plain")]]);
    await expect(api.thoughts.removeType(BRAIN, THOUGHT)).resolves.toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("throws when the type is still there after its link was deleted", async () => {
    vi.useFakeTimers();
    try {
      const { api } = typed({ staleReads: Infinity });
      const pending = api.thoughts.update(BRAIN, THOUGHT, { typeId: null });
      const outcome = expect(pending).rejects.toMatchObject({
        kind: "server",
        message: expect.stringMatching(/still reads back with its type/),
      });
      await vi.advanceTimersByTimeAsync(5000);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes nothing, and throws, when the link to the type is not the type link", async () => {
    vi.useFakeTimers();
    try {
      for (const options of [{ meaning: 1 }, { linked: false }]) {
        const { api, calls } = typed(options);
        const pending = api.thoughts.removeType(BRAIN, THOUGHT);
        const outcome = expect(pending).rejects.toMatchObject({
          kind: "server",
          message: expect.stringMatching(/still in place/),
        });
        await vi.advanceTimersByTimeAsync(5000);
        await outcome;
        expect(sent(calls, "DELETE")).toEqual([]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("a removal that follows another one finds nothing left to remove", async () => {
    // The first read may still show the type an earlier removal took away.
    const { api, calls } = typed({ staleReads: 1 });
    await api.links.detachType(BRAIN, THOUGHT, TYPE);
    await expect(api.thoughts.removeType(BRAIN, THOUGHT)).resolves.toBe(false);
    expect(sent(calls, "DELETE")).toHaveLength(1);
  });
});

describe("a typeId that is not a type", () => {
  const PLAIN = "eeeeeeee-0000-4000-8000-000000000005";
  const NOBODY = "ffffffff-0000-4000-8000-000000000006";
  const LINK = "99999999-0000-4000-8000-000000000009";

  /**
   * A brain with a type, a tag and an ordinary thought in it, and THOUGHT to
   * write to. A typeId is taken as the live API takes it: a patch naming a
   * thought is a 200 whatever its kind, only a type becomes the type, and a
   * read shows it `staleReads` reads later.
   */
  const brain = (options: { staleReads?: number } = {}) => {
    const others: Record<string, ThoughtDto> = {
      [TYPE]: thought(TYPE, "Constraint", { kind: 2 }),
      [TAG]: thought(TAG, "gotcha", { kind: 4 }),
      [PLAIN]: thought(PLAIN, "API constraints"),
    };
    let typeId: string | null = null;
    let stale = 0;
    return apiWith([
      [
        "/api/thoughts/",
        (url) => {
          const id = url.pathname.split("/").pop()!;
          // A thought that does not exist is a 403.
          if (id !== THOUGHT) return others[id] ?? 403;
          if (stale === 0) return thought(THOUGHT, "written to", { typeId });
          stale -= 1;
          return thought(THOUGHT, "written to");
        },
      ],
      [
        "PATCH /api/thoughts/",
        (_url, init) => {
          const ops = JSON.parse(String(init?.body)) as Array<{ path: string; value?: string }>;
          for (const op of ops) {
            if (op.path !== "/typeId") continue;
            const named = others[op.value ?? ""];
            if (named === undefined) return 403;
            if (named.kind !== 2) continue;
            typeId = named.id;
            stale = options.staleReads ?? 0;
          }
          return 200;
        },
      ],
      ["POST /api/thoughts/", () => ({ id: THOUGHT })],
      [
        "/api/links/",
        () =>
          typeId === null
            ? 404
            : { id: LINK, thoughtIdA: typeId, thoughtIdB: THOUGHT, relation: 1, meaning: 2 },
      ],
      ["DELETE /api/links/", () => ((typeId = null), 200)],
    ]);
  };
  const writes = (calls: Array<{ method: string }>): string[] =>
    calls.filter((c) => c.method !== "GET").map((c) => c.method);
  const refused = [
    [PLAIN, /is not a type: it is the thought "API constraints"/],
    [TAG, /is not a type: it is the tag "gotcha"/],
    [NOBODY, /is not a type: no thought in this brain has that identifier/],
  ] as const;

  it("update refuses an ordinary thought, a tag and an identifier nobody has, and sends nothing", async () => {
    // Measured: the API answers 200 to the first two, makes a parent or a tag
    // of what it was given and leaves typeId as it was.
    for (const [typeId, message] of refused) {
      const { api, calls } = brain();
      await expect(
        api.thoughts.update(BRAIN, THOUGHT, { name: "renamed", typeId }),
      ).rejects.toMatchObject({ kind: "not_a_type", message: expect.stringMatching(message) });
      expect(writes(calls)).toEqual([]);
    }
  });

  it("create refuses the same three, and creates nothing", async () => {
    for (const [typeId, message] of refused) {
      const { api, calls } = brain();
      await expect(
        api.thoughts.create(BRAIN, { name: "new", sourceThoughtId: PLAIN, typeId }),
      ).rejects.toMatchObject({ kind: "not_a_type", message: expect.stringMatching(message) });
      expect(writes(calls)).toEqual([]);
    }
  });

  it("a type is read first and sent after", async () => {
    const { api, calls } = brain();
    await api.thoughts.update(BRAIN, THOUGHT, { typeId: TYPE });
    await api.thoughts.create(BRAIN, { name: "new", typeId: TYPE });

    const sent = calls.map((c) => `${c.method} ${c.url.pathname}`);
    expect(sent.slice(0, 2)).toEqual([
      `GET /api/thoughts/${BRAIN}/${TYPE}`,
      `PATCH /api/thoughts/${BRAIN}/${THOUGHT}`,
    ]);
    expect(calls[1]!.body).toEqual([{ op: "replace", path: "/typeId", value: TYPE }]);
    expect(sent.slice(-2)).toEqual([
      `GET /api/thoughts/${BRAIN}/${TYPE}`,
      `POST /api/thoughts/${BRAIN}`,
    ]);
    expect(calls.at(-1)!.body).toMatchObject({ name: "new", typeId: TYPE });
  });

  it("update returns only once the thought reads back with the type", async () => {
    // Measured: a type set by a patch shows on a read up to 107 ms later.
    const { api, calls } = brain({ staleReads: 3 });
    await api.thoughts.update(BRAIN, THOUGHT, { typeId: TYPE });
    const reads = calls.filter((c) => c.method === "GET" && c.url.pathname.endsWith(THOUGHT));
    // Three stale reads and the one that agrees.
    expect(reads).toHaveLength(4);
  });

  it("so a removal straight after finds the type it is to remove", async () => {
    // `removeType` trusts its first read. Before `update` waited, that read
    // came back without the type, nothing was removed, and the type stayed.
    const { api, calls } = brain({ staleReads: 3 });
    await api.thoughts.update(BRAIN, THOUGHT, { typeId: TYPE });
    await api.thoughts.update(BRAIN, THOUGHT, { typeId: null });
    expect(writes(calls)).toEqual(["PATCH", "DELETE"]);
    expect((await api.thoughts.get(BRAIN, THOUGHT)).typeId).toBeNull();
  });

  it("throws when the type is accepted and never reads back", async () => {
    vi.useFakeTimers();
    try {
      const { api } = brain({ staleReads: Infinity });
      const pending = api.thoughts.update(BRAIN, THOUGHT, { typeId: TYPE });
      const outcome = expect(pending).rejects.toMatchObject({
        kind: "server",
        message: expect.stringMatching(/does not read back with it/),
      });
      await vi.advanceTimersByTimeAsync(5000);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a thought named as its own type is refused before any request, a type too", async () => {
    // Measured: a 200 that sets nothing. A type passes the check of its kind,
    // and left to the read-back it cost the whole timeout to be told, wrongly,
    // that the type might yet show.
    for (const id of [THOUGHT, TYPE]) {
      const { api, fetchImpl } = brain();
      await expect(
        api.thoughts.update(BRAIN, id, { name: "renamed", typeId: id.toUpperCase() }),
      ).rejects.toMatchObject({
        kind: "not_a_type",
        message: expect.stringMatching(/a thought cannot be its own type/),
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("a failure to read the type stays what it was", async () => {
    // Only "no such thought" means "not a type". A rejected key is not that.
    const { api } = apiWith([["/api/thoughts/", () => 401]]);
    await expect(api.thoughts.requireType(BRAIN, TYPE)).rejects.toMatchObject({ kind: "auth" });
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
  const PLAIN = "eeeeeeee-0000-4000-8000-000000000005";
  const NOBODY = "ffffffff-0000-4000-8000-000000000006";
  const LINK = "99999999-0000-4000-8000-000000000009";

  /**
   * A brain with a tag, a type and an ordinary thought in it, and THOUGHT to
   * tag. `link` is the one link between THOUGHT and whichever of them is asked
   * about. As on the live API, a link is posted with a 200 whatever it names,
   * and a delete takes any link it is given.
   */
  const brain = (
    link: { a: string; b: string; relation: number; meaning: number } | null = null,
  ) => {
    const others: Record<string, ThoughtDto> = {
      [TAG]: thought(TAG, "gotcha", { kind: 4 }),
      [TYPE]: thought(TYPE, "Constraint", { kind: 2 }),
      [PLAIN]: thought(PLAIN, "API constraints"),
    };
    return apiWith([
      // A thought that does not exist is a 404 to this read.
      ["/api/thoughts/", (url) => others[url.pathname.split("/").pop()!] ?? 404],
      ["POST /api/links", () => ({ id: LINK })],
      [
        "/api/links/",
        () =>
          link === null
            ? 404
            : {
                id: LINK,
                thoughtIdA: link.a,
                thoughtIdB: link.b,
                relation: link.relation,
                meaning: link.meaning,
              },
      ],
      ["DELETE /api/links/", () => 200],
    ]);
  };
  const sent = (calls: Array<{ method: string; url: URL }>): string[] =>
    calls.map((c) => `${c.method} ${c.url.pathname}`);
  const writes = (calls: Array<{ method: string }>): string[] =>
    calls.filter((c) => c.method !== "GET").map((c) => c.method);

  it("are attached via relation=2 rather than directly, once the tag is read", async () => {
    const { api, calls } = brain();
    await api.links.attachTag(BRAIN, THOUGHT, TAG);
    expect(sent(calls)).toEqual([
      `GET /api/thoughts/${BRAIN}/${TAG}`,
      `POST /api/links/${BRAIN}`,
    ]);
    expect(calls[1]!.body).toEqual({
      thoughtIdA: THOUGHT,
      thoughtIdB: TAG,
      relation: 2,
    });
  });

  it("attaching refuses a type, an ordinary thought and an identifier nobody has, and sends nothing", async () => {
    // Measured: the API answers 200 to the first two, and sets the thought's
    // type or gives it one more parent.
    for (const [tagId, message] of [
      [TYPE, /tagId \S+ is not a tag: it is the type "Constraint"/],
      [PLAIN, /is not a tag: it is the thought "API constraints"/],
      [NOBODY, /is not a tag: no thought in this brain has that identifier/],
    ] as const) {
      const { api, calls } = brain();
      await expect(api.links.attachTag(BRAIN, THOUGHT, tagId)).rejects.toMatchObject({
        kind: "not_a_tag",
        message: expect.stringMatching(message),
      });
      expect(writes(calls)).toEqual([]);
    }
  });

  it("a thought named as its own tag is refused before any request, a tag too", async () => {
    // Measured: a 200 with an identifier of zeros, for a link that is not
    // made. A tag passes the check of its kind.
    for (const id of [THOUGHT, TAG]) {
      const { api, fetchImpl } = brain();
      await expect(api.links.attachTag(BRAIN, id, id.toUpperCase())).rejects.toMatchObject({
        kind: "not_a_tag",
        message: expect.stringMatching(/a thought cannot be its own tag/),
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("a failure to read the tag stays what it was", async () => {
    // Only "no such thought" means "not a tag". A rejected key is not that.
    const { api } = apiWith([["/api/thoughts/", () => 401]]);
    await expect(api.links.requireTag(BRAIN, TAG)).rejects.toMatchObject({ kind: "auth" });
  });

  it("removing an absent tag returns false instead of throwing", async () => {
    const { api } = apiWith([["GET /api/links", () => 404]]);
    await expect(api.links.detachTag(BRAIN, THOUGHT, TAG)).resolves.toBe(false);
  });

  it("removing deletes the tag's link to the thought, a tag's link to a tag too", async () => {
    // Meaning 5 on a thought, 7 on another tag; the tag is `thoughtIdA` in both.
    for (const meaning of [5, 7]) {
      const { api, calls } = brain({ a: TAG, b: THOUGHT, relation: 1, meaning });
      await expect(api.links.detachTag(BRAIN, THOUGHT, TAG.toUpperCase())).resolves.toBe(true);
      expect(sent(calls).at(-1)).toBe(`DELETE /api/links/${BRAIN}/${LINK}`);
    }
  });

  it("removing leaves any other link between the two where it is", async () => {
    // Two thoughts share one link, and the lookup returns it whatever it is.
    // Each of these used to be deleted, and reported as a tag removed.
    for (const [what, other, link] of [
      ["the thought's type", TYPE, { a: TYPE, b: THOUGHT, relation: 1, meaning: 2 }],
      ["a parent", PLAIN, { a: PLAIN, b: THOUGHT, relation: 1, meaning: 1 }],
      ["a child", PLAIN, { a: THOUGHT, b: PLAIN, relation: 1, meaning: 1 }],
      ["a jump to a tag", TAG, { a: THOUGHT, b: TAG, relation: 3, meaning: 1 }],
      ["a tag made the thought's child", TAG, { a: THOUGHT, b: TAG, relation: 1, meaning: 1 }],
      ["a tag this one is attached to", TAG, { a: THOUGHT, b: TAG, relation: 1, meaning: 7 }],
      ["a thought this one is a tag of", PLAIN, { a: THOUGHT, b: PLAIN, relation: 1, meaning: 5 }],
    ] as const) {
      const { api, calls } = brain(link);
      await expect(api.links.detachTag(BRAIN, THOUGHT, other), what).resolves.toBe(false);
      expect(writes(calls), what).toEqual([]);
    }
  });
});

describe("a type named as a parent", () => {
  const PLAIN = "eeeeeeee-0000-4000-8000-000000000005";
  const NOBODY = "ffffffff-0000-4000-8000-000000000006";
  const LINK = "99999999-0000-4000-8000-000000000009";

  /**
   * A brain with a type, a tag and an ordinary thought in it. As on the live
   * API, a link is posted and a thought created with a 200 whatever they name.
   */
  const brain = () => {
    const others: Record<string, ThoughtDto> = {
      [TYPE]: thought(TYPE, "Constraint", { kind: 2 }),
      [TAG]: thought(TAG, "gotcha", { kind: 4 }),
      [PLAIN]: thought(PLAIN, "API constraints"),
      [THOUGHT]: thought(THOUGHT, "linked"),
    };
    return apiWith([
      // A thought that does not exist is a 404 to this read.
      ["/api/thoughts/", (url) => others[url.pathname.split("/").pop()!] ?? 404],
      ["POST /api/thoughts/", () => ({ id: THOUGHT })],
      ["POST /api/links", () => ({ id: LINK })],
    ]);
  };
  const sent = (calls: Array<{ method: string; url: URL }>): string[] =>
    calls.map((c) => `${c.method} ${c.url.pathname}`);
  const read = (id: string): string => `GET /api/thoughts/${BRAIN}/${id}`;
  const postLink = `POST /api/links/${BRAIN}`;
  const postThought = `POST /api/thoughts/${BRAIN}`;

  it("a parent/child link with a type above is refused, and nothing is sent", async () => {
    // Measured: the API answers 200 and makes the type the lower thought's
    // type, in place of the one it had.
    for (const [input, field] of [
      [{ thoughtIdA: THOUGHT, thoughtIdB: TYPE, relation: 2 }, "thoughtIdB"],
      [{ thoughtIdA: TYPE, thoughtIdB: THOUGHT, relation: 1 }, "thoughtIdA"],
      // A child link is what `create` sends when no relation is given.
      [{ thoughtIdA: TYPE, thoughtIdB: THOUGHT }, "thoughtIdA"],
    ] as const) {
      const { api, calls } = brain();
      await expect(api.links.create(BRAIN, input)).rejects.toMatchObject({
        kind: "not_a_parent",
        message: `${field} ${TYPE} cannot be a parent: it is the type "Constraint"`,
      });
      expect(sent(calls), field).toEqual([read(TYPE)]);
    }
  });

  it("a link reads its upper end alone, and a jump reads nothing", async () => {
    for (const [what, input, reads] of [
      ["under a thought", { thoughtIdA: THOUGHT, thoughtIdB: PLAIN, relation: 2 }, [PLAIN]],
      ["a thought above", { thoughtIdA: PLAIN, thoughtIdB: THOUGHT, relation: 1 }, [PLAIN]],
      // Measured: both of these are ordinary links.
      ["a jump to a type", { thoughtIdA: THOUGHT, thoughtIdB: TYPE, relation: 3 }, []],
      ["a type below", { thoughtIdA: THOUGHT, thoughtIdB: TYPE, relation: 1 }, [THOUGHT]],
      ["a type below", { thoughtIdA: TYPE, thoughtIdB: THOUGHT, relation: 2 }, [THOUGHT]],
    ] as const) {
      const { api, calls } = brain();
      await expect(api.links.create(BRAIN, input), what).resolves.toBe(LINK);
      expect(sent(calls), what).toEqual([...reads.map(read), postLink]);
      expect(calls.at(-1)!.body, what).toEqual(input);
    }
  });

  it("only a type is refused: a tag above, and an identifier nobody has, go to the API", async () => {
    // Under a tag the thought is tagged, which takes nothing from it. The API
    // answers for the identifier, with a 400.
    for (const upper of [TAG, NOBODY]) {
      const { api, calls } = brain();
      await api.links.create(BRAIN, { thoughtIdA: THOUGHT, thoughtIdB: upper, relation: 2 });
      expect(sent(calls)).toEqual([read(upper), postLink]);
      await api.thoughts.create(BRAIN, { name: "new", sourceThoughtId: upper });
      expect(sent(calls).slice(2)).toEqual([read(upper), postThought]);
    }
  });

  it("attaching a tag does not read it again for a parent", async () => {
    const { api, calls } = brain();
    await api.links.attachTag(BRAIN, THOUGHT, TAG);
    expect(sent(calls)).toEqual([read(TAG), postLink]);
  });

  it("a thought is not created under a type, with a typeId or without", async () => {
    // Measured: the API creates it as one of that type, with no parent, and
    // with another type for its typeId as a thought that carries both.
    for (const extra of [{}, { relation: 1 }, { typeId: TYPE }, { typeId: PLAIN }] as const) {
      const { api, calls } = brain();
      await expect(
        api.thoughts.create(BRAIN, { name: "new", sourceThoughtId: TYPE, ...extra }),
      ).rejects.toMatchObject({
        kind: "not_a_parent",
        message: `sourceThoughtId ${TYPE} cannot be a parent: it is the type "Constraint"`,
      });
      expect(sent(calls)).toEqual([read(TYPE)]);
    }
  });

  it("a thought created under another is read for first; one made above a type or beside it is not", async () => {
    for (const [what, input, reads] of [
      ["under a thought", { sourceThoughtId: PLAIN }, [PLAIN]],
      ["above a type", { sourceThoughtId: TYPE, relation: 2 }, []],
      ["beside a type", { sourceThoughtId: TYPE, relation: 3 }, []],
      ["on its own", {}, []],
    ] as const) {
      const { api, calls } = brain();
      await api.thoughts.create(BRAIN, { name: "new", ...input });
      expect(sent(calls), what).toEqual([...reads.map(read), postThought]);
    }
  });

  it("a malformed end is refused before any request, a read included", async () => {
    const { api, fetchImpl } = brain();
    await expect(
      api.links.create(BRAIN, { thoughtIdA: TYPE, thoughtIdB: "not-a-uuid", relation: 1 }),
    ).rejects.toMatchObject({ kind: "invalid_uuid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a failure to read the parent stays what it was", async () => {
    // Only "no such thought" is left to the write. A rejected key is not that.
    const { api, calls } = apiWith([["/api/thoughts/", () => 401]]);
    await expect(api.links.requireParent(BRAIN, PLAIN, "parentId")).rejects.toMatchObject({
      kind: "auth",
    });
    await expect(
      api.links.create(BRAIN, { thoughtIdA: THOUGHT, thoughtIdB: PLAIN, relation: 2 }),
    ).rejects.toMatchObject({ kind: "auth" });
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});

describe("updating a link: flat fields become JSON Patch", () => {
  const LINK = "eeeeeeee-0000-4000-8000-000000000005";

  it("builds operations only from the fields provided", async () => {
    const { api, calls } = apiWith([["PATCH /api/links", () => 200]]);
    await api.links.update(BRAIN, LINK, { name: "supports", color: undefined, thickness: 3 });
    expect(calls[0]!.body).toEqual([
      { op: "replace", path: "/name", value: "supports" },
      { op: "replace", path: "/thickness", value: 3 },
    ]);
  });

  it("null clears a name or a colour with remove", async () => {
    // Measured: `replace` with null is a 400 for a colour, and for a name a 200
    // that leaves the name where it was.
    const { api, calls } = apiWith([["PATCH /api/links", () => 200]]);
    await api.links.update(BRAIN, LINK, { direction: 1, name: null, color: null });
    expect(calls[0]!.body).toEqual([
      { op: "replace", path: "/direction", value: 1 },
      { op: "remove", path: "/name" },
      { op: "remove", path: "/color" },
    ]);
  });

  it("a thickness that is not a whole number is refused before any request, null too", async () => {
    // A fraction is a 403 and null a 400, and by then the fields ahead of the
    // thickness are written. Nothing clears a thickness, so the type offers no null.
    const { api, fetchImpl } = apiWith([["PATCH /api/links", () => 200]]);
    for (const thickness of [1.5, Number.NaN, null as unknown as number]) {
      await expect(
        api.links.update(BRAIN, LINK, { name: "never written", thickness }),
      ).rejects.toMatchObject({ kind: "bad_request", message: /whole number/ });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an empty change set issues no request", async () => {
    const { api, fetchImpl } = apiWith([["PATCH /api/links", () => 200]]);
    await api.links.update(BRAIN, LINK, { name: undefined });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a relation is refused before any request, and the fields beside it with it", async () => {
    // Measured: patched to 4 a link answers 200 and stays as it was, to 2 it
    // swaps its ends every time, and to 1 with a type above it sets a type.
    // The type has no such field, so each of these is one forced past it.
    const { api, fetchImpl } = apiWith([["PATCH /api/links", () => 200]]);
    for (const relation of [4, 2, 1, 3]) {
      await expect(
        api.links.update(BRAIN, LINK, { name: "never written", relation } as never),
      ).rejects.toMatchObject({
        kind: "bad_request",
        message: /does not change a link's relation.*create\(\)/s,
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("a relation that is none of the three", () => {
  const SOURCE = "eeeeeeee-0000-4000-8000-000000000005";
  const brain = () =>
    apiWith([
      ["/api/thoughts/", () => thought(SOURCE, "source")],
      ["POST /api/thoughts/", () => ({ id: THOUGHT })],
    ]);

  it("the spec's Sibling is not one of the relations there are to send", () => {
    expect(Relation).toEqual({ Child: 1, Parent: 2, Jump: 3 });
  });

  it("create refuses it before any request", async () => {
    // Measured: the API answers 200 to any number and creates the thought.
    // With 4 or 0 it is linked to nothing; with 5 or -1 by a link that
    // carries the number and that no list of the graph shows.
    const { api, fetchImpl } = brain();
    for (const relation of [4, 0, 5, -1]) {
      await expect(
        api.thoughts.create(BRAIN, {
          name: "new",
          sourceThoughtId: SOURCE,
          relation: relation as Relation,
        }),
      ).rejects.toMatchObject({
        kind: "bad_request",
        message: expect.stringContaining(
          `relation must be 1 (child), 2 (parent) or 3 (jump), got ${relation}.`,
        ),
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("create sends each of the three as it is, and a child's when given none", async () => {
    for (const [relation, sentAs] of [
      [Relation.Child, 1],
      [Relation.Parent, 2],
      [Relation.Jump, 3],
      [undefined, 1],
    ] as const) {
      const { api, calls } = brain();
      await api.thoughts.create(BRAIN, {
        name: "new",
        sourceThoughtId: SOURCE,
        ...(relation !== undefined ? { relation } : {}),
      });
      expect(calls.at(-1)!.body).toMatchObject({ sourceThoughtId: SOURCE, relation: sentAs });
    }
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
  /** An entry the log files under `filed`, which is not always when it was created. */
  const entry = (id: string, created: number, filed = created): ModificationLogDto => ({
    ...log(id, 101, at(created)),
    modificationDateTime: at(filed),
  });
  // [created, filed], as measured: most entries are filed at the microsecond
  // they were created, about one in fifty a microsecond later, a changed note
  // up to milliseconds later. Ties of two, three and four, entries a
  // microsecond apart, one with no fraction at all, and late entries on either
  // side of a tie and in the middle of a run.
  const STAMPS: Array<[number, number]> = [
    [0, 0], [1, 1], [2, 2], [2, 2],
    [99, 100], [100, 100], [100, 100], [100, 100], [100, 101], [101, 101],
    [1000, 1000], [1001, 1001], [1001, 1001],
    [5000, 5000], [5001, 5001], [1200, 5002], [5002, 5002], [5003, 5003],
    [90000, 90000], [90000, 90000], [90000, 90001], [90001, 90001],
    [500000, 500000], [500001, 500001], [500000, 500001],
    [600000, 600000], [600000, 600000], [600000, 600000], [999999, 999999],
  ];
  const entries = STAMPS.map(([created, filed], i) => entry(`t-${i}`, created, filed));

  /**
   * Behaves as measured on the live API: the log is ordered by
   * `modificationDateTime`, both bounds compare against it and are inclusive
   * to the microsecond, and truncation keeps the newest, newest first.
   */
  const serve = (stored: ModificationLogDto[]) => {
    const newestFirst = [...stored]
      .reverse()
      .sort((a, b) => compareLogTime(b.modificationDateTime, a.modificationDateTime));
    const route = (url: URL): ModificationLogDto[] => {
      const maxLogs = Number(url.searchParams.get("maxLogs"));
      const start = url.searchParams.get("startTime");
      const end = url.searchParams.get("endTime");
      return newestFirst
        .filter((l) => start === null || compareLogTime(l.modificationDateTime, start) >= 0)
        .filter((l) => end === null || compareLogTime(l.modificationDateTime, end) <= 0)
        .slice(0, maxLogs);
    };
    return { newestFirst, route };
  };
  const { newestFirst, route: logRoute } = serve(entries);

  it("pages on modificationDateTime, the field the API orders and filters by", async () => {
    // `late` was created at .000099 and filed at .0001, beside `tied`. A page
    // that ends on `late` must ask for everything up to .0001: up to .000099,
    // its creation, the API leaves `tied` out and nothing ever returns it.
    const stored = [entry("older", 50), entry("tied", 100), entry("late", 99, 100), entry("newer", 200)];
    const { newestFirst: expected, route } = serve(stored);
    expect(expected.map((l) => l.sourceId)).toEqual(["newer", "late", "tied", "older"]);

    const { api, calls } = apiWith([["/modifications", route]]);
    const all = await api.brains.allModifications(BRAIN, { pageSize: 2 });
    expect(all.map((l) => l.sourceId)).toEqual(["newer", "late", "tied", "older"]);
    expect(calls.map((c) => c.url.searchParams.get("endTime"))).not.toContain(at(99));
  });

  it("keeps the entries filed while a slower one was being written", async () => {
    // A changed note can be filed milliseconds after its creation. Paging on
    // creation from a page that ends on it would jump back those milliseconds
    // and drop everything filed in between.
    const stored = [
      entry("before", 1000),
      entry("during-1", 3000),
      entry("during-2", 4000),
      entry("note", 1200, 5000),
      entry("after", 6000),
    ];
    const { api } = apiWith([["/modifications", serve(stored).route]]);
    for (const pageSize of [1, 2, 3]) {
      const all = await api.brains.allModifications(BRAIN, { pageSize });
      expect(all.map((l) => l.sourceId), `pageSize ${pageSize}`).toEqual([
        "after",
        "note",
        "during-2",
        "during-1",
        "before",
      ]);
    }
  });

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
      expect(entries.map(logTime)).toContain(bound);
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
      newestFirst.filter((l) => compareLogTime(logTime(l), since) >= 0).map(logEntryKey),
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
  const attached = (location: string, extra: Partial<AttachmentDto> = {}): AttachmentDto => ({
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
    location,
    ...extra,
  });
  const ON_THOUGHT = `${THOUGHT}/attachments`;

  it("deduplication avoids a second copy of the same URL", async () => {
    const { api, calls } = apiWith([["/by-location", () => [attached("https://example.com/")]]]);
    const res = await api.attachments.attachUrl(BRAIN, THOUGHT, "https://example.com/");
    expect(res.created).toBe(false);
    expect(res.existing?.name).toBe("already there");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("creates the attachment when there is no duplicate", async () => {
    const { api, calls } = apiWith([
      ["/by-location", () => []],
      [ON_THOUGHT, () => []],
      ["POST /api/attachments", () => 200],
    ]);
    const res = await api.attachments.attachUrl(BRAIN, THOUGHT, "https://new.example");
    expect(res.created).toBe(true);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url.searchParams.get("url")).toBe("https://new.example");
  });

  it("a URL already on the thought under another host case is not attached again", async () => {
    // by-location compares the host by case, so it misses this one.
    const { api, calls } = apiWith([
      ["/by-location", () => []],
      [
        ON_THOUGHT,
        () => [
          attached("Notes.md", { id: "note", type: 1, isNotes: true, name: null }),
          attached("http://Example.COM/Path/", { id: "att-2" }),
        ],
      ],
    ]);
    const res = await api.attachments.attachUrl(BRAIN, THOUGHT, "https://example.com/Path");
    expect(res.created).toBe(false);
    expect(res.existing?.id).toBe("att-2");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("a path in another case is another URL, and is sent as it was given", async () => {
    const { api, calls } = apiWith([
      ["/by-location", () => []],
      [ON_THOUGHT, () => [attached("https://example.com/Path")]],
      ["POST /api/attachments", () => 200],
    ]);
    const res = await api.attachments.attachUrl(BRAIN, THOUGHT, "https://Example.com/path");
    expect(res.created).toBe(true);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url.searchParams.get("url")).toBe("https://Example.com/path");
  });

  it("an attachment of another thought is not a duplicate", async () => {
    const elsewhere = attached("https://example.com/", { sourceId: TYPE });
    const { api } = apiWith([
      ["/by-location", () => [elsewhere]],
      [ON_THOUGHT, () => []],
      ["POST /api/attachments", () => 200],
    ]);
    const res = await api.attachments.attachUrl(BRAIN, THOUGHT, "https://example.com/");
    expect(res.created).toBe(true);
  });

  it("with deduplication off nothing is read first", async () => {
    const { api, calls } = apiWith([["POST /api/attachments", () => 200]]);
    await api.attachments.attachUrl(BRAIN, THOUGHT, "https://example.com/", {
      deduplicate: false,
    });
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
  });
});

describe("urlKey", () => {
  it("is the same for every spelling of one web address", () => {
    for (const spelling of [
      "https://example.com/Path",
      "http://example.com/Path",
      "HTTPS://example.com/Path",
      "https://example.com/Path/",
      "https://example.com/Path//",
      "https://EXAMPLE.com/Path",
      "http://Example.Com/Path/",
    ]) {
      expect(urlKey(spelling), spelling).toBe("example.com/Path");
    }
    expect(urlKey("https://Example.com")).toBe(urlKey("http://example.com/"));
  });

  it("keeps the case of everything after the host", () => {
    const key = urlKey("https://example.com/Path?Q=Abc#Frag");
    for (const other of [
      "https://example.com/path?Q=Abc#Frag",
      "https://example.com/Path?q=abc#Frag",
      "https://example.com/Path?Q=Abc#frag",
      "https://example.com/Path?Q=Abc",
      "https://example.com/Path/?Q=Abc#Frag",
      "https://www.example.com/Path?Q=Abc#Frag",
    ]) {
      expect(urlKey(other), other).not.toBe(key);
    }
  });

  it("lower-cases the host alone, not the credentials before it", () => {
    expect(urlKey("https://User:Pass@Example.COM:8080/Path")).toBe(
      "User:Pass@example.com:8080/Path",
    );
    expect(urlKey("https://Example.COM?Next=/A")).toBe("example.com?Next=/A");
  });

  it("leaves anything that is not http(s) untouched", () => {
    // Here an identifier stands where a host would, and its case may matter.
    for (const location of [
      "x-devonthink-item://4F2A-9C",
      "ftp://Example.com/Path/",
      "Example.com/Path",
      "/Users/Me/Notes.md",
    ]) {
      expect(urlKey(location)).toBe(location);
    }
  });
});
