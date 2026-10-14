import { describe, expect, it, vi } from "vitest";

import { TheBrainApi } from "../src/api/index.js";
import {
  LOG_PAGE_SIZE,
  MAX_NAME_LENGTH,
  codePoints,
  compareLogTime,
  linkNameAsStored,
  logEntryKey,
  logTime,
  nameRefusal,
  normalizeAliases,
  noteAsStored,
  noteLinesDropped,
  replayThoughtIds,
  thoughtNameAsStored,
  urlKey,
} from "../src/api/index.js";
import {
  Relation,
  aliasesOf,
  type AttachmentDto,
  type LinkDto,
  type ModificationLogDto,
  type ThoughtDto,
} from "../src/api/types.js";
import { neighbourIds } from "../src/semantic/indexer.js";

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

/** A graph as the API sends it, with nothing in it but what is given. Links are taken as given. */
const graphOf = (activeThought: ThoughtDto, extra: Record<string, unknown> = {}) => ({
  activeThought,
  parents: [],
  children: [],
  jumps: [],
  siblings: [],
  tags: [],
  type: null,
  links: [],
  attachments: [],
  ...extra,
});
const TYPE_THOUGHT = thought(TYPE, "Constraint", { kind: 2 });

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
    expect(g.otherTypes).toEqual([]);
  });

  // What is above a thought by a link that is no parent's. The API lists it
  // among the parents as well, measured on 15.0.640 (docs/api-map.md, L40).
  const UPPER = "abababab-0000-4000-8000-00000000000a";
  const OTHER_TYPE = "cdcdcdcd-0000-4000-8000-00000000000c";
  const ABOVE = "efefefef-0000-4000-8000-00000000000e";
  /** The link from `above` down to THOUGHT, as a graph lists it. */
  const from = (above: string, meaning: number): LinkDto =>
    ({
      id: `link-${above}`,
      thoughtIdA: above,
      thoughtIdB: THOUGHT,
      relation: 1,
      meaning,
      name: null,
    }) as unknown as LinkDto;
  const ids = (list: readonly { id: string }[]): string[] => list.map((t) => t.id);

  it("a tag a tag carries is among its tags, and not among its parents", async () => {
    // A link of meaning 7: the lower tag's graph has the upper one in both.
    const upper = thought(UPPER, "measured", { kind: 4 });
    const { api } = apiWith([
      [
        "/graph",
        () =>
          graphOf(thought(THOUGHT, "gotcha", { kind: 4 }), {
            parents: [upper],
            tags: [upper],
            links: [from(UPPER, 7)],
          }),
      ],
    ]);
    const g = await api.thoughts.getGraph(BRAIN, THOUGHT);
    expect(g.parents).toEqual([]);
    expect(ids(g.tags)).toEqual([UPPER]);
    expect(neighbourIds(g)).toEqual([UPPER]);
  });

  it("the type of a type is its type, and not its parent", async () => {
    // A link of meaning 3, where a thought's type has 2.
    const { api } = apiWith([
      [
        "/graph",
        () =>
          graphOf(thought(THOUGHT, "Pattern", { kind: 2, typeId: TYPE }), {
            type: TYPE_THOUGHT,
            parents: [TYPE_THOUGHT],
            links: [from(TYPE, 3)],
          }),
      ],
    ]);
    const g = await api.thoughts.getGraph(BRAIN, THOUGHT);
    expect(g.parents).toEqual([]);
    expect(g.type?.id).toBe(TYPE);
    expect(g.otherTypes).toEqual([]);
  });

  it("of two types, the one typeId names is the type and the other is beside it; neither is a parent", async () => {
    // A thought created under one type with another for its typeId. The API
    // lists both among the parents, and its own `type` named the one typeId
    // does not 17 times of 25.
    const other = thought(OTHER_TYPE, "Pattern", { kind: 2 });
    const above = thought(ABOVE, "API constraints");
    const { api } = apiWith([
      [
        "/graph",
        () =>
          graphOf(thought(THOUGHT, "Prefix-only search", { typeId: TYPE }), {
            type: other,
            parents: [other, TYPE_THOUGHT, above],
            links: [from(OTHER_TYPE, 2), from(TYPE, 2), from(ABOVE, 1)],
          }),
      ],
    ]);
    const g = await api.thoughts.getGraph(BRAIN, THOUGHT);
    expect(g.type?.id).toBe(TYPE);
    expect(ids(g.otherTypes)).toEqual([OTHER_TYPE]);
    expect(ids(g.parents)).toEqual([ABOVE]);
    // The indexer's walk reaches the second type all the same: it used to by the parents.
    expect(neighbourIds(g).sort()).toEqual([ABOVE, OTHER_TYPE, TYPE].sort());
  });

  it("the link decides, not the kind: a thought above by an ordinary link is a parent", async () => {
    const tag = thought(UPPER, "measured", { kind: 4 });
    const { api } = apiWith([
      [
        "/graph",
        () => graphOf(thought(THOUGHT, "RAG"), { parents: [tag], links: [from(UPPER, 1)] }),
      ],
    ]);
    expect(ids((await api.thoughts.getGraph(BRAIN, THOUGHT)).parents)).toEqual([UPPER]);
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

describe("a thought's name", () => {
  /**
   * Unicode's `White_Space`, all 25 code points of it: what the API takes
   * for a blank in a name (contract test). Spelled out, so that the rule is
   * the list that was measured and not whatever the runtime's tables hold.
   */
  const WHITE_SPACE = [
    0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
    0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  ].map((cp) => String.fromCodePoint(cp));
  /** Characters that do not show and are no white space: the API stores a name of one. */
  const UNSEEN = ["\u200b", "\ufeff", "\u2800", "\u2060", "\u0301", "\ufe0f", "\u180e", "\u001c"];
  const BLANK = ["", " ", "   ", "\t\n", "\r\n", "\u00a0", "\u0085", "\u3000", " \u00a0\t\u3000\u0085\n"];

  const creating = () => apiWith([["POST /api/thoughts", () => ({ id: THOUGHT })]]);
  const renaming = () => apiWith([["PATCH /api/thoughts", () => 200]]);

  it("is stored with a tab and a line feed as spaces and no white space at its ends", () => {
    // Each pair as the live API stored it, by a create and by a rename.
    for (const [sent, stored] of [
      ["plain", "plain"],
      ["  ab  ", "ab"],
      ["\tab\t", "ab"],
      ["\nab\n", "ab"],
      ["\r\nab\r\n", "ab"],
      ["\u000bab\u000c", "ab"],
      ["\u0085ab\u0085", "ab"],
      ["\u00a0ab\u00a0", "ab"],
      ["\u2003ab\u2003", "ab"],
      ["\u2028ab\u2029", "ab"],
      ["\u3000ab\u3000", "ab"],
      // No white space: a byte order mark, a zero width space, a control.
      ["\ufeffab\ufeff", "\ufeffab\ufeff"],
      ["\u200bab\u200b", "\u200bab\u200b"],
      ["\u001cab\u001f", "\u001cab\u001f"],
      [" \u200b ", "\u200b"],
      [" \ufeff\t", "\ufeff"],
      // Inside a name only a tab and a line feed change.
      ["a\nb", "a b"],
      ["a\tb", "a b"],
      ["a\r\nb", "a\r b"],
      ["a\rb", "a\rb"],
      ["a  b", "a  b"],
      ["a\u00a0b", "a\u00a0b"],
      ["a\u2028b", "a\u2028b"],
      ["a\u0085b", "a\u0085b"],
      ["a \n b", "a   b"],
    ] as const) {
      expect(thoughtNameAsStored(sent), JSON.stringify(sent)).toBe(stored);
      // What is stored is stored as it is.
      expect(thoughtNameAsStored(stored), JSON.stringify(stored)).toBe(stored);
    }
  });

  it("white space is the Unicode property's 25 code points, which is not what trim() drops", () => {
    for (const c of WHITE_SPACE) {
      const cp = codePoints(c);
      expect(thoughtNameAsStored(`${c}ab${c}`), cp).toBe("ab");
      expect(nameRefusal(c, "name"), cp).toBe(
        `name is white space alone (${cp}), and a thought has to have a name`,
      );
    }
    // The two that differ: `trim()` keeps a next line and drops a byte order mark.
    expect("\u0085".trim()).toBe("\u0085");
    expect(nameRefusal("\u0085", "name")).not.toBeNull();
    expect("\ufeff".trim()).toBe("");
    expect(nameRefusal("\ufeff", "name")).toBeNull();
  });

  it("a name with nothing in it but white space is refused, in the caller's word for it", () => {
    expect(nameRefusal("", "name")).toBe("name is empty, and a thought has to have a name");
    expect(nameRefusal(" \u00a0\t", 'the name of thought "t1"')).toBe(
      'the name of thought "t1" is white space alone (U+0020 U+00A0 U+0009), ' +
        "and a thought has to have a name",
    );
    // A long run of it is not spelled out to the end.
    expect(nameRefusal(" ".repeat(30), "name")).toBe(
      `name is white space alone (${"U+0020 ".repeat(8)}and 22 more), ` +
        "and a thought has to have a name",
    );
  });

  it("a name of characters that do not show is no white space, and is not refused", () => {
    for (const name of [...UNSEEN, "\u200b\ufeff", "RAG", "é", "日本", "🧠", "."]) {
      expect(nameRefusal(name, "name"), codePoints(name)).toBeNull();
      expect(thoughtNameAsStored(name), codePoints(name)).toBe(name);
    }
  });

  it("a name past 1,024 UTF-16 units is refused, counted as it would be stored", () => {
    expect(MAX_NAME_LENGTH).toBe(1024);
    expect(nameRefusal("a".repeat(1024), "name")).toBeNull();
    expect(nameRefusal("a".repeat(1025), "name")).toBe(
      "name is 1025 UTF-16 units long, and TheBrain keeps the first 1024 of a name and " +
        "drops the rest with a 200",
    );
    // The blanks at its ends are dropped before it is cut, so they do not count.
    expect(nameRefusal(` ${"a".repeat(1024)}\n`, "name")).toBeNull();
    // Units, not characters: 512 of these are 1,024 units.
    expect(nameRefusal("🧠".repeat(512), "name")).toBeNull();
    expect(nameRefusal("🧠".repeat(513), "name")).toMatch(/^name is 1026 UTF-16 units long/);
  });

  it("create refuses both before any request", async () => {
    const { api, fetchImpl } = creating();
    for (const name of [...BLANK, "a".repeat(1025)]) {
      await expect(
        // With a source and a type, each of which is read ahead of the create.
        api.thoughts.create(BRAIN, { name, sourceThoughtId: THOUGHT, typeId: TYPE }),
        codePoints(name.slice(0, 8)),
      ).rejects.toMatchObject({ kind: "bad_request", message: nameRefusal(name, "name") });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("update refuses both before any request, the type's read included", async () => {
    // The API answers 200 to such a rename and leaves the name as it was.
    const { api, fetchImpl } = renaming();
    for (const name of [...BLANK, "a".repeat(1025)]) {
      await expect(
        api.thoughts.update(BRAIN, THOUGHT, { name, typeId: TYPE, label: "kept out" }),
        codePoints(name.slice(0, 8)),
      ).rejects.toMatchObject({ kind: "bad_request", message: nameRefusal(name, "name") });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("any other name goes out as it was given, one that does not show and one with blanks around it", async () => {
    for (const name of [...UNSEEN, "  padded\t", "a\nb", "a".repeat(1024)]) {
      const made = creating();
      await made.api.thoughts.create(BRAIN, { name });
      expect(made.calls.map((c) => c.body), codePoints(name.slice(0, 8))).toEqual([
        { name, kind: 1, acType: 0 },
      ]);

      const renamed = renaming();
      await renamed.api.thoughts.update(BRAIN, THOUGHT, { name });
      expect(renamed.calls.map((c) => c.body), codePoints(name.slice(0, 8))).toEqual([
        [{ op: "replace", path: "/name", value: name }],
      ]);
    }
  });

  it("code points are spelled out to the eighth, and the rest counted", () => {
    expect(codePoints("\u200b")).toBe("U+200B");
    expect(codePoints("\t\u00a0\u{e0020}")).toBe("U+0009 U+00A0 U+E0020");
    expect(codePoints("\u200b".repeat(8))).toBe(Array(8).fill("U+200B").join(" "));
    expect(codePoints("\u200b".repeat(9))).toBe(`${Array(8).fill("U+200B").join(" ")} and 1 more`);
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
    const link = () => ({ id: LINK, thoughtIdA: TYPE, thoughtIdB: THOUGHT, relation: 1, meaning });
    return apiWith([
      [
        "/graph",
        () =>
          graphOf(thought(THOUGHT, "typed", { typeId }), {
            ...(typeId === null ? {} : { type: TYPE_THOUGHT, parents: [TYPE_THOUGHT] }),
            ...(linked && typeId !== null ? { links: [link()] } : {}),
          }),
      ],
      [
        "/api/thoughts/",
        () => {
          if (typeId !== null || stale === 0) return thought(THOUGHT, "typed", { typeId });
          stale -= 1;
          return thought(THOUGHT, "typed", { typeId: TYPE });
        },
      ],
      ["PATCH /api/thoughts/", () => 200],
      ["/api/links/", () => (linked && typeId !== null ? link() : 404)],
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
    const reads = sent(calls, "GET").filter((path) => path === `/api/thoughts/${BRAIN}/${THOUGHT}`);
    expect(reads).toHaveLength(5);
  });

  it("a thought with no type is left alone", async () => {
    const { api, calls } = apiWith([
      ["/graph", () => graphOf(thought(THOUGHT, "plain"))],
      ["/api/thoughts/", () => thought(THOUGHT, "plain")],
    ]);
    await expect(api.thoughts.removeType(BRAIN, THOUGHT)).resolves.toBe(false);
    // The thought, and its graph for a type `typeId` does not name.
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
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

  it("a type's type is taken away as well: its link has meaning 3", async () => {
    // It was taken for a link that is not the type's: nothing was deleted,
    // and after two seconds the type was still in place.
    const { api, calls } = typed({ meaning: 3 });
    await expect(api.thoughts.removeType(BRAIN, THOUGHT)).resolves.toBe(true);
    expect(sent(calls, "DELETE")).toEqual([`/api/links/${BRAIN}/${LINK}`]);
  });

  it("a link of meaning 3 with the thought at its head is not the type's, and stays", async () => {
    // There the thought is the type of the other: the link is the other's.
    const { api, calls } = apiWith([
      [
        "/api/links/",
        () => ({ id: LINK, thoughtIdA: THOUGHT, thoughtIdB: TYPE, relation: 1, meaning: 3 }),
      ],
    ]);
    await expect(api.links.detachType(BRAIN, THOUGHT, TYPE)).resolves.toBe(false);
    expect(sent(calls, "DELETE")).toEqual([]);
  });

  /**
   * A thought created under OTHER with TYPE for its typeId: a type's link
   * from each, and an ordinary parent beside them. Deleting either type's
   * link reads back as `typeId: null`, as measured, while the other stays.
   */
  const twoTypes = (options: { typeId?: string | null } = {}) => {
    const OTHER = "cdcdcdcd-0000-4000-8000-00000000000c";
    const ABOVE = "efefefef-0000-4000-8000-00000000000e";
    const other = thought(OTHER, "Pattern", { kind: 2 });
    const above = thought(ABOVE, "API constraints");
    let typeId = options.typeId === undefined ? TYPE : options.typeId;
    const down = (id: string, above: string, meaning: number) =>
      [above, { id, thoughtIdA: above, thoughtIdB: THOUGHT, relation: 1, meaning }] as const;
    const links = new Map([
      down(LINK, TYPE, 2),
      down(`${LINK.slice(0, -1)}6`, OTHER, 2),
      down(`${LINK.slice(0, -1)}7`, ABOVE, 1),
    ]);
    // A type removed before this left OTHER's link and `typeId: null`.
    if (typeId === null) links.delete(TYPE);
    const made = apiWith([
      [
        "/graph",
        () =>
          graphOf(thought(THOUGHT, "typed", { typeId }), {
            // The API's own `type` names the one typeId does not.
            type: links.has(OTHER) ? other : links.has(TYPE) ? TYPE_THOUGHT : null,
            parents: [other, TYPE_THOUGHT, above].filter((t) => links.has(t.id)),
            links: [...links.values()],
          }),
      ],
      ["/api/thoughts/", () => thought(THOUGHT, "typed", { typeId })],
      [
        "DELETE /api/links/",
        (url) => {
          const id = url.pathname.split("/").pop();
          for (const [end, link] of links) if (link.id === id) links.delete(end);
          typeId = null;
          return 200;
        },
      ],
      [
        "/api/links/",
        (url) => {
          const [first = "", second = ""] = url.pathname.split("/").slice(-2);
          return links.get(first) ?? links.get(second) ?? 404;
        },
      ],
    ]);
    return { ...made, links, OTHER, ABOVE };
  };

  it("both types of a thought with two go, and nothing else", async () => {
    // Only the one typeId names used to go: the thought read `typeId: null`,
    // and the other was still its type in the graph and in TheBrain.
    const { api, calls, links, ABOVE } = twoTypes();
    await expect(api.thoughts.removeType(BRAIN, THOUGHT)).resolves.toBe(true);
    expect(sent(calls, "DELETE")).toHaveLength(2);
    expect([...links.keys()]).toEqual([ABOVE]);
  });

  it("a type the graph still has once typeId reads null goes too", async () => {
    // What a removal of one of two types left behind.
    const { api, calls, links, ABOVE } = twoTypes({ typeId: null });
    await expect(api.thoughts.removeType(BRAIN, THOUGHT)).resolves.toBe(true);
    expect(sent(calls, "DELETE")).toHaveLength(1);
    expect([...links.keys()]).toEqual([ABOVE]);
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
    const link = (type: string) => ({
      id: LINK,
      thoughtIdA: type,
      thoughtIdB: THOUGHT,
      relation: 1,
      meaning: 2,
    });
    return apiWith([
      [
        "/graph",
        () =>
          graphOf(
            thought(THOUGHT, "written to", { typeId }),
            typeId === null
              ? {}
              : { type: others[typeId]!, parents: [others[typeId]!], links: [link(typeId)] },
          ),
      ],
      [
        "/api/thoughts/",
        (url) => {
          const id = url.pathname.split("/").pop()!;
          // A thought that does not exist is a 404 to this read.
          if (id !== THOUGHT) return others[id] ?? 404;
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
      ["/api/links/", () => (typeId === null ? 404 : link(typeId))],
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

describe("what the read of a kind takes for no such thought", () => {
  const PLAIN = "eeeeeeee-0000-4000-8000-000000000005";

  /** Every request answered the same way, in the API's own words. */
  const answering = (status: number, body: string, contentType = "application/json") => {
    const calls: string[] = [];
    const fetchImpl = async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      calls.push(init?.method ?? "GET");
      return new Response(body, { status, headers: { "content-type": contentType } });
    };
    const api = new TheBrainApi({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    return { api, calls };
  };
  const checks = (api: TheBrainApi): Array<[string, () => Promise<unknown>]> => [
    ["requireType", () => api.thoughts.requireType(BRAIN, TYPE)],
    ["requireTag", () => api.links.requireTag(BRAIN, TAG)],
    ["requireParent", () => api.links.requireParent(BRAIN, PLAIN, "parentId")],
    // The writes that read first: nothing is sent after a read that settled nothing.
    ["update", () => api.thoughts.update(BRAIN, THOUGHT, { name: "renamed", typeId: TYPE })],
    ["link", () => api.links.create(BRAIN, { thoughtIdA: PLAIN, thoughtIdB: THOUGHT })],
    ["tag", () => api.links.attachTag(BRAIN, THOUGHT, TAG)],
  ];

  it("a brainId that is no brain is not a thought nobody has", async () => {
    // Measured: every request with such a brain in its path is this 401, the
    // read of a thought that exists included.
    const refusal = `Access to brain ${BRAIN} is unauthorized.`;
    const { api, calls } = answering(401, JSON.stringify(refusal));
    for (const [what, check] of checks(api)) {
      await expect(check(), what).rejects.toMatchObject({
        kind: "unknown_brain",
        message: refusal,
      });
    }
    expect(calls.filter((method) => method !== "GET")).toEqual([]);
  });

  it("nor is the catch-all 403: only the read's own 404 is", async () => {
    // Measured: the read of a thought nobody has is a 404, and the 403 is what
    // the API answers when it names no cause. Taken for "no such thought", it
    // would call a type that is there no type, and let a type through as a parent.
    const { api, calls } = answering(
      403,
      "To use the TheBrain API, make requests to /api (e.g. /api/brains). " +
        "An API key is required via the Authorization header.",
      "text/plain",
    );
    for (const [what, check] of checks(api)) {
      await expect(check(), what).rejects.toMatchObject({ kind: "forbidden" });
    }
    expect(calls.filter((method) => method !== "GET")).toEqual([]);
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

describe("creating a type or a tag", () => {
  const NEW = "eeeeeeee-0000-4000-8000-000000000005";
  const NEWEST = "2026-10-13T21:01:39.153181";

  /**
   * A brain whose log's newest entry is `newest`, whose create answers `NEW`,
   * and where that thought's own entries are `own` and it reads as `read`. A
   * route in `first` goes ahead of these.
   */
  const brain = (
    own: () => ModificationLogDto[],
    read: ThoughtDto,
    {
      newest = [log("other", 103, NEWEST)],
      first = [],
    }: { newest?: ModificationLogDto[]; first?: Array<[string, Route]> } = {},
  ) =>
    apiWith([
      ...first,
      ["/api/brains/", () => newest],
      ["POST /api/thoughts/", () => ({ id: NEW })],
      ["/modifications", own],
      ["/api/thoughts/", () => read],
    ]);
  const requests = (calls: Array<{ method: string; url: URL }>): string[] =>
    calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`);

  it("reads the newest log entry, creates with a name and a kind alone, then reads the thought's own entries and the thought", async () => {
    const tag = thought(NEW, "gotcha", { kind: 4 });
    const { api, calls } = brain(() => [log(NEW, 101, "2026-10-13T21:01:40.546889")], tag);
    const outcome = await api.thoughts.createTypeOrTag(BRAIN, { name: "gotcha", kind: 4 });

    expect(requests(calls)).toEqual([
      `GET /api/brains/${BRAIN}/modifications?maxLogs=1`,
      `POST /api/thoughts/${BRAIN}`,
      `GET /api/thoughts/${BRAIN}/${NEW}/modifications?maxLogs=100&includeRelatedLogs=false`,
      `GET /api/thoughts/${BRAIN}/${NEW}`,
    ]);
    // No label, no aliases, no source and no typeId: each does something to
    // a tag that is there, or makes a link the kinds at its ends decide.
    expect(calls[1]!.body).toEqual({ name: "gotcha", kind: 4, acType: 0 });
    expect(outcome).toEqual({ id: NEW, created: true, thought: tag, notRead: null });
  });

  it("a type is asked for with kind 2", async () => {
    const type = thought(NEW, "Pattern", { kind: 2, label: "Pattern" });
    const { api, calls } = brain(() => [log(NEW, 101, "2026-10-13T21:01:40")], type);
    const outcome = await api.thoughts.createTypeOrTag(BRAIN, { name: "Pattern", kind: 2 });
    expect(calls[1]!.body).toEqual({ name: "Pattern", kind: 2, acType: 0 });
    expect(outcome).toMatchObject({ id: NEW, created: true, thought: type });
  });

  it("one whose 101 is not later than the newest entry the log had was there before", async () => {
    // TheBrain answers a tag's create with the tag the brain has under that
    // name, and the answer is an identifier like any other.
    const there = thought(NEW, "Gotcha", { kind: 4 });
    for (const madeAt of [
      "2026-10-01T08:00:00",
      "2026-10-13T21:01:39.15318",
      // The newest entry is this tag's own 101: made by the call before.
      NEWEST,
    ]) {
      const { api } = brain(() => [log(NEW, 202, "2026-10-13T21:00:00"), log(NEW, 101, madeAt)], there);
      const outcome = await api.thoughts.createTypeOrTag(BRAIN, { name: "GOTCHA", kind: 4 });
      expect(outcome, madeAt).toEqual({ id: NEW, created: false, thought: there, notRead: null });
    }
  });

  it("tells the two apart by a microsecond, which Date would not", async () => {
    const tag = thought(NEW, "gotcha", { kind: 4 });
    const made = (at: string) =>
      brain(() => [log(NEW, 101, at)], tag).api.thoughts.createTypeOrTag(BRAIN, {
        name: "gotcha",
        kind: 4,
      });
    expect((await made("2026-10-13T21:01:39.153182")).created).toBe(true);
    // The API trims trailing zeros: .1532 is .153200, later than .153181.
    expect((await made("2026-10-13T21:01:39.1532")).created).toBe(true);
    expect((await made("2026-10-13T21:01:39.15318")).created).toBe(false);
  });

  it("goes by when the entry was filed, as the log is ordered", async () => {
    const tag = thought(NEW, "gotcha", { kind: 4 });
    const entry = {
      ...log(NEW, 101, "2026-10-13T21:01:39.153181"),
      modificationDateTime: "2026-10-13T21:01:39.153182",
    };
    const { api } = brain(() => [entry], tag);
    expect((await api.thoughts.createTypeOrTag(BRAIN, { name: "gotcha", kind: 4 })).created).toBe(
      true,
    );
  });

  it("with no 101 among its own entries it was there before", async () => {
    // A tag with more than a hundred entries of its own, or one from a brain
    // that was imported: a thought made a moment ago has its 101 and no more.
    const there = thought(NEW, "gotcha", { kind: 4 });
    for (const own of [[], [log(NEW, 202, "2026-10-13T21:01:40")]]) {
      const { api } = brain(() => own, there);
      const outcome = await api.thoughts.createTypeOrTag(BRAIN, { name: "gotcha", kind: 4 });
      expect(outcome.created).toBe(false);
    }
  });

  it("an entry about another thought, or of a link, is not its 101", async () => {
    const there = thought(NEW, "gotcha", { kind: 4 });
    const { api } = brain(
      () => [log(TAG, 101, "2026-10-13T21:01:40"), log(NEW, 101, "2026-10-13T21:01:40", 3)],
      there,
    );
    expect((await api.thoughts.createTypeOrTag(BRAIN, { name: "gotcha", kind: 4 })).created).toBe(
      false,
    );
  });

  it("in a brain whose log was empty, a 101 is the call's own", async () => {
    const tag = thought(NEW, "gotcha", { kind: 4 });
    const made = brain(() => [log(NEW, 101, "2026-10-13T21:01:40")], tag, { newest: [] });
    expect(
      (await made.api.thoughts.createTypeOrTag(BRAIN, { name: "gotcha", kind: 4 })).created,
    ).toBe(true);
    const there = brain(() => [], tag, { newest: [] });
    expect(
      (await there.api.thoughts.createTypeOrTag(BRAIN, { name: "gotcha", kind: 4 })).created,
    ).toBe(false);
  });

  it("a read that fails after the create does not fail it: the identifier comes back with what was read", async () => {
    const tag = thought(NEW, "gotcha", { kind: 4 });
    // The thought's own entries are not read: nothing says which it was.
    const noLog = brain(() => [], tag, { first: [[`/${NEW}/modifications`, () => 500]] });
    const first = await noLog.api.thoughts.createTypeOrTag(BRAIN, { name: "gotcha", kind: 4 });
    expect(first).toMatchObject({ id: NEW, created: null, thought: null });
    expect(first.notRead).toMatchObject({ kind: "server", status: 500 });

    // The thought is not read: whether it was made is known all the same.
    const noRead = apiWith([
      ["/api/brains/", () => [log("other", 103, NEWEST)]],
      ["POST /api/thoughts/", () => ({ id: NEW })],
      ["/modifications", () => [log(NEW, 101, "2026-10-13T21:01:40")]],
      ["/api/thoughts/", () => 500],
    ]);
    const second = await noRead.api.thoughts.createTypeOrTag(BRAIN, { name: "gotcha", kind: 4 });
    expect(second).toMatchObject({ id: NEW, created: true, thought: null });
    expect(second.notRead).toMatchObject({ kind: "server", status: 500 });
  });

  it("a log that cannot be read, and a create that is refused, are thrown with nothing after them", async () => {
    const tag = thought(NEW, "gotcha", { kind: 4 });
    const noLog = brain(() => [], tag, { first: [["/api/brains/", () => 500]] });
    await expect(
      noLog.api.thoughts.createTypeOrTag(BRAIN, { name: "gotcha", kind: 4 }),
    ).rejects.toMatchObject({ kind: "server", method: "GET" });
    expect(requests(noLog.calls)).toEqual([`GET /api/brains/${BRAIN}/modifications?maxLogs=1`]);

    const refused = brain(() => [], tag, { first: [["POST /api/thoughts/", () => 400]] });
    await expect(
      refused.api.thoughts.createTypeOrTag(BRAIN, { name: "gotcha", kind: 4 }),
    ).rejects.toMatchObject({ kind: "bad_request", method: "POST" });
    expect(refused.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  it("an answer of zeros is no identifier", async () => {
    const tag = thought(NEW, "gotcha", { kind: 4 });
    const { api, calls } = brain(() => [], tag, {
      first: [["POST /api/thoughts/", () => ({ id: "00000000-0000-0000-0000-000000000000" })]],
    });
    await expect(
      api.thoughts.createTypeOrTag(BRAIN, { name: "gotcha", kind: 4 }),
    ).rejects.toMatchObject({ kind: "zero_id" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  it("sends nothing for a name TheBrain would not keep, for another kind, or for a brainId that is none", async () => {
    const { api, calls } = brain(() => [], thought(NEW, "x", { kind: 4 }));
    const create = (name: string, kind: number, brainId = BRAIN): Promise<unknown> =>
      api.thoughts.createTypeOrTag(brainId, { name, kind: kind as 2 | 4 });

    await expect(create(" \u00a0", 4)).rejects.toMatchObject({
      kind: "bad_request",
      message: "name is white space alone (U+0020 U+00A0), and a thought has to have a name",
    });
    await expect(create("x".repeat(MAX_NAME_LENGTH + 1), 2)).rejects.toMatchObject({
      kind: "bad_request",
    });
    // The API takes 1 here and makes an ordinary thought, and refuses 3 and 5.
    for (const kind of [1, 3, 5]) {
      await expect(create("x", kind)).rejects.toMatchObject({
        kind: "bad_request",
        message: `kind must be 2 (type) or 4 (tag), got ${kind}: an ordinary thought is made by create()`,
      });
    }
    await expect(create("x", 4, "nope")).rejects.toMatchObject({ kind: "invalid_uuid" });
    await expect(create("x", 4, "00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
      kind: "invalid_uuid",
    });
    expect(calls).toEqual([]);
  });

  it("two calls for one brain go one after the other, each from its read of the log to its last read", async () => {
    // Sent at once, two creates of one new tag name are two tags as often as
    // not, and a create that overtook another's read of the log would pass
    // for what that call made.
    const { api, calls } = brain(
      () => [log(NEW, 101, "2026-10-13T21:01:40")],
      thought(NEW, "gotcha", { kind: 4 }),
    );
    await Promise.all([
      api.thoughts.createTypeOrTag(BRAIN, { name: "gotcha", kind: 4 }),
      api.thoughts.createTypeOrTag(BRAIN, { name: "GOTCHA", kind: 4 }),
    ]);
    const steps = calls.map((c) => {
      if (c.method === "POST") return `create ${(c.body as { name: string }).name}`;
      return c.url.pathname.includes("/api/brains/") ? "log" : "read";
    });
    expect(steps).toEqual([
      "log",
      "create gotcha",
      "read",
      "read",
      "log",
      "create GOTCHA",
      "read",
      "read",
    ]);
  });

  it("a call that failed does not hold up the next, and another brain does not wait", async () => {
    const OTHER = "aaaaaaaa-0000-4000-8000-00000000000f";
    let refuse = true;
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const tag = thought(NEW, "gotcha", { kind: 4 });
    const answered: string[] = [];
    const api = new TheBrainApi({
      apiKey: "k",
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(String(input));
        const json = (value: unknown, status = 200): Response =>
          new Response(JSON.stringify(value), {
            status,
            headers: { "content-type": "application/json" },
          });
        if (url.pathname.includes("/api/brains/")) {
          // The other brain's log is not answered until the test lets it be.
          if (url.pathname.includes(OTHER)) await held;
          return json([]);
        }
        if (init?.method === "POST") {
          if (refuse) {
            refuse = false;
            return json("Could not create thought.", 400);
          }
          return json({ id: NEW });
        }
        if (url.pathname.endsWith("/modifications")) return json([]);
        answered.push(url.pathname);
        return json(tag);
      }) as unknown as typeof fetch,
    });

    const stuck = api.thoughts.createTypeOrTag(OTHER, { name: "slow", kind: 4 });
    const failed = api.thoughts.createTypeOrTag(BRAIN, { name: "gotcha", kind: 4 });
    const next = api.thoughts.createTypeOrTag(BRAIN, { name: "gotcha", kind: 4 });
    await expect(failed).rejects.toMatchObject({ kind: "bad_request" });
    await expect(next).resolves.toMatchObject({ id: NEW });
    expect(answered).toEqual([`/api/thoughts/${BRAIN}/${NEW}`]);
    release();
    await expect(stuck).resolves.toMatchObject({ id: NEW });
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

  /**
   * The lookup answers from the index TheBrain's search has, which goes on
   * holding a thought after it is deleted or renamed (docs/api-map.md, L34).
   * `listed` is what the lookup returns, `read` what the thought's own read
   * answers: a thought, or a status.
   */
  const lookup = (listed: ThoughtDto, read: () => unknown) =>
    apiWith([
      [`/api/thoughts/${BRAIN}/${THOUGHT}`, read],
      ["/api/thoughts/", () => listed],
    ]);

  it("a thought the lookup still lists, and that is gone, is not returned", async () => {
    // It was returned: the lookup's 200 was the whole of the answer.
    const { api, calls } = lookup(thought(THOUGHT, "deleted"), () => 404);
    await expect(api.thoughts.findByName(BRAIN, "deleted")).resolves.toBeNull();
    expect(calls.map((c) => c.url.pathname + c.url.search)).toEqual([
      `/api/thoughts/${BRAIN}?nameExact=deleted`,
      `/api/thoughts/${BRAIN}/${THOUGHT}`,
    ]);
  });

  it("nor is a thought the lookup lists under a name it no longer has", async () => {
    const { api } = lookup(thought(THOUGHT, "old name"), () => thought(THOUGHT, "new name"));
    await expect(api.thoughts.findByName(BRAIN, "old name")).resolves.toBeNull();
  });

  it("what is returned is the thought as it reads now, not the lookup's copy", async () => {
    const { api } = lookup(thought(THOUGHT, "present", { label: "old caption" }), () =>
      thought(THOUGHT, "present", { label: "new caption" }),
    );
    const found = await api.thoughts.findByName(BRAIN, "present");
    expect(found?.label).toBe("new caption");
  });

  it.each([
    [500, "server"],
    [403, "forbidden"],
  ])("a read of the answer that fails with a %i is thrown, not taken for no thought", async (status, kind) => {
    const { api } = lookup(thought(THOUGHT, "present"), () => status);
    await expect(api.thoughts.findByName(BRAIN, "present")).rejects.toMatchObject({ kind });
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

  it("append resolves to the whole text it left the note with", async () => {
    // TheBrain goes over the whole note when it deletes a fence, so a caller
    // that says what was not kept needs all of it, not the addition.
    for (const [held, added, whole] of [
      [noNote, "text", "text"],
      [withNote, "continued", "beginning\n\ncontinued"],
      [{ ...withNote, markdown: "beginning\n\n" }, "next", "beginning\n\nnext"],
    ] as const) {
      const { api } = apiWith([
        ["GET /api/notes", () => held],
        ["POST /api/notes", () => 200],
      ]);
      await expect(api.notes.append(BRAIN, THOUGHT, added)).resolves.toBe(whole);
    }
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

/**
 * What TheBrain 15.0.640 keeps of a note it is given, as `noteAsStored()` and
 * `noteLinesDropped()` say it. Every pair here was sent to the live API and
 * read back (contract test: "a note's Markdown as it is stored").
 */
describe("a note's Markdown as TheBrain keeps it", () => {
  const F = "```";

  it("a note with no fence, and one whose blocks are each closed, is kept to the character", () => {
    // The warning the tools gave was for every one of these.
    for (const text of [
      "just text\n\nand more",
      `before\n\n${F}\ncode\n${F}`,
      `before\n\n${F}js\ncode\n${F}\n`,
      `before\n${F}\ncode\n${F}\nafter`,
      `one\n\n${F}js\na\n${F}\n\ntwo\n\n${F}sh\nb\n${F}\n\nend`,
      `${F}\ncode\n${F}`,
      `${F}py\ndef f():\n\n    return 1\n\t# tab\n\n${F}\n\nafter`,
      `${F}${F}\ncode\n${F}${F}`,
      `${F}\`md\n${F}js\ncode\n${F}\n${F}\`\n\nafter`,
      `${F}\none\n${F}\n${F}\ntwo\n${F}`,
      `a ${F}inline${F} b and a lone ${F} too`,
      "~~~\ncode\n~~~",
      `- item\n\n  ${F}js\n  code\n  ${F}\n\n> ${F}\n> quoted\n> ${F}`,
    ]) {
      expect(noteLinesDropped(text), text).toEqual([]);
      expect(noteAsStored(text), text).toBe(text);
    }
  });

  it("with an odd number of lines that begin with a fence, the last one goes, whole", () => {
    for (const [sent, stored] of [
      // A block left open loses the fence that opened it.
      [`before\n\n${F}js\ncode();\n\nafter`, "before\n\ncode();\n\nafter"],
      [`before\n\n${F}`, "before\n"],
      [`before\n\n${F}\n`, "before\n\n"],
      [`${F}js\ncode\nmore`, "code\nmore"],
      // Of three it is the third, whichever block it was meant for.
      [`a\n\n${F}\none\n${F}\n\nb\n\n${F}\ntwo\n\nend`, `a\n\n${F}\none\n${F}\n\nb\n\ntwo\n\nend`],
      [`${F}\n1\n${F}\n2\n${F}\n3\n${F}\n4\n${F}\n5`, `${F}\n1\n${F}\n2\n${F}\n3\n${F}\n4\n5`],
      // A block whose first fence is not at the start of its line loses the
      // fence that closes it: what a block appended with no separator is.
      [`intro${F}js\ncode\n${F}`, `intro${F}js\ncode`],
      [`intro ${F}js\ncode\n${F}\n\nend`, `intro ${F}js\ncode\n\nend`],
      [`\ufeff${F}\ncode\n${F}\n\nend`, `\ufeff${F}\ncode\n\nend`],
      // Whatever follows the backticks goes with them: a sentence too.
      [`a\n\n${F}x${F} is inline code\n\nend`, "a\n\n\nend"],
      [`a\n\n${F}some words here\ncode\n\nend`, "a\n\ncode\n\nend"],
      [`a\n\n${F}${F}\ncode\n\nend`, "a\n\ncode\n\nend"],
      // A fence of tildes is no fence, so the one of backticks inside is alone.
      [`a\n\n~~~\n${F}\n~~~\n\nend`, "a\n\n~~~\n~~~\n\nend"],
    ] as const) {
      expect(noteAsStored(sent), sent).toBe(stored);
      expect(noteLinesDropped(sent).map((d) => d.why), sent).toEqual(["unpaired"]);
    }
  });

  it("a block with nothing in it goes, both of its lines", () => {
    for (const [sent, stored] of [
      [`a\n\n${F}\n${F}\n\nend`, "a\n\n\nend"],
      [`a\n\n${F}js\n${F}\n\nend`, "a\n\n\nend"],
      [`a\n\n${F}  \n${F}\n\nend`, "a\n\n\nend"],
      [`a\n\n${F}\n${F}`, "a\n"],
      [`a\n${F}\n${F}\nb`, "a\nb"],
      [`${F}\n${F}`, ""],
      [`a\n\n${F}\ncode\n${F}\n\nb\n\n${F}\n${F}\n\nend`, `a\n\n${F}\ncode\n${F}\n\nb\n\n\nend`],
      [`${F}\n${F}\nx\n${F}\n${F}`, "x"],
      // The fences pair up in order, so the pair is the last two here.
      [`${F}\n${F}js\n${F}\n${F}`, `${F}\n${F}js`],
      [`${F}\nx\n${F}js\n${F}\n${F}\n\nend`, `${F}\nx\n${F}js\n\nend`],
    ] as const) {
      expect(noteAsStored(sent), sent).toBe(stored);
      expect(new Set(noteLinesDropped(sent).map((d) => d.why)), sent).toEqual(new Set(["empty"]));
    }
    // Not a block with nothing in it: a line between the two, a closing
    // fence that is more than three backticks, and two blocks back to back.
    for (const kept of [
      `a\n\n${F}\n\n${F}\n\nend`,
      `a\n\n${F}\n   \n${F}\n\nend`,
      `a\n${F}\n${F}  \nend`,
      `a\n\n${F}\n${F}js\n\nend`,
      `a\n\n${F}${F}\n${F}${F}\n\nend`,
      `${F}\none\n${F}\n${F}\ntwo\n${F}`,
    ]) {
      expect(noteAsStored(kept), kept).toBe(kept);
    }
  });

  it("both rules can take lines of one note, the odd fence first", () => {
    expect(noteAsStored(`a\n\n${F}${F}\n${F}\n${F}${F}\n\nend`)).toBe("a\n\n\nend");
    expect(noteAsStored(`${F}\n${F}\n${F}`)).toBe("");
    expect(noteLinesDropped(`x\n${F}\n${F}\ny\n${F}tail`)).toEqual([
      { line: 2, text: F, why: "empty" },
      { line: 3, text: F, why: "empty" },
      { line: 5, text: `${F}tail`, why: "unpaired" },
    ]);
  });

  it("only three backticks at the very start of a line are a fence", () => {
    for (const kept of [
      `a\n\n ${F}\ncode\n\nend`,
      `a\n\n    ${F}\ncode\n\nend`,
      `a\n\n\t${F}\ncode\n\nend`,
      `a\n\n> ${F}\n> code\n\nend`,
      `a\n\n- ${F}\n  code\n\nend`,
      "a\n\n~~~\ncode\n\nend",
      "a\n\n``\ncode\n\nend",
      // After a carriage return alone a fence is not at the start of a line.
      `a\r${F}\rcode`,
    ]) {
      expect(noteAsStored(kept), kept).toBe(kept);
    }
  });

  it("line ends: \\r\\n is \\n, and nothing else is touched", () => {
    expect(noteAsStored("a\r\nb\r\n\r\nc\r\n")).toBe("a\nb\n\nc\n");
    expect(noteAsStored(`a\r\n\r\n${F}js\r\ncode\r\n\r\nend\r\n`)).toBe("a\n\ncode\n\nend\n");
    expect(noteLinesDropped(`a\r\n\r\n${F}js\r\ncode`)).toEqual([
      { line: 3, text: `${F}js`, why: "unpaired" },
    ]);
    for (const kept of ["a\rb\r\rc\r", "\n\n\na\n\n\n", "  a   \nb\t\n", "\ufeffa\u00a0b\u200b", "   \n  "]) {
      expect(noteAsStored(kept), JSON.stringify(kept)).toBe(kept);
    }
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

  it("a tag is on a thought when the link they share is the tag's, with the tag at its head", async () => {
    // What `detachTag` deletes, asked about with one read and no write. A
    // second attach is a 200 that logs a `402` against the attachment.
    for (const meaning of [5, 7]) {
      const { api, calls } = brain({ a: TAG, b: THOUGHT, relation: 1, meaning });
      await expect(api.links.hasTag(BRAIN, THOUGHT, TAG.toUpperCase())).resolves.toBe(true);
      expect(sent(calls)).toEqual([`GET /api/links/${BRAIN}/${THOUGHT}/${TAG.toUpperCase()}`]);
    }
    // No link at all, and each link that is not this tag on this thought.
    await expect(brain().api.links.hasTag(BRAIN, THOUGHT, TAG)).resolves.toBe(false);
    for (const [what, other, link] of [
      ["the thought's type", TYPE, { a: TYPE, b: THOUGHT, relation: 1, meaning: 2 }],
      ["a parent", PLAIN, { a: PLAIN, b: THOUGHT, relation: 1, meaning: 1 }],
      ["a jump to a tag", TAG, { a: THOUGHT, b: TAG, relation: 3, meaning: 1 }],
      ["a tag made the thought's child", TAG, { a: THOUGHT, b: TAG, relation: 1, meaning: 1 }],
      ["a thought this one is a tag of", PLAIN, { a: THOUGHT, b: PLAIN, relation: 1, meaning: 5 }],
    ] as const) {
      await expect(brain(link).api.links.hasTag(BRAIN, THOUGHT, other), what).resolves.toBe(false);
    }
  });

  it("a lookup that fails is not the answer that the tag is not there", async () => {
    const { api } = apiWith([["GET /api/links", () => 500]]);
    await expect(api.links.hasTag(BRAIN, THOUGHT, TAG)).rejects.toMatchObject({ kind: "server" });
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
  const OTHER_TAG = "88888888-0000-4000-8000-000000000008";
  const brain = () => {
    const others: Record<string, ThoughtDto> = {
      [TYPE]: thought(TYPE, "Constraint", { kind: 2 }),
      [TAG]: thought(TAG, "gotcha", { kind: 4 }),
      [OTHER_TAG]: thought(OTHER_TAG, "gotcha", { kind: 4 }),
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

  it("an identifier nobody has goes to the API, which answers for it", async () => {
    // With a 400 for a link and a 404 for a create.
    const { api, calls } = brain();
    await api.links.create(BRAIN, { thoughtIdA: THOUGHT, thoughtIdB: NOBODY, relation: 2 });
    expect(sent(calls)).toEqual([read(NOBODY), postLink]);
    await api.thoughts.create(BRAIN, { name: "new", sourceThoughtId: NOBODY });
    expect(sent(calls).slice(2)).toEqual([read(NOBODY), postThought]);
  });

  it("a parent/child link with a tag above is refused, and nothing is sent", async () => {
    // Measured: the API answers 200 and attaches the tag. It used to go out,
    // and come back as a link created.
    for (const [input, field] of [
      [{ thoughtIdA: THOUGHT, thoughtIdB: TAG, relation: 2 }, "thoughtIdB"],
      [{ thoughtIdA: TAG, thoughtIdB: THOUGHT, relation: 1 }, "thoughtIdA"],
      [{ thoughtIdA: TAG, thoughtIdB: THOUGHT }, "thoughtIdA"],
      // A type tagged this way, and a tag attached to a tag.
      [{ thoughtIdA: TYPE, thoughtIdB: TAG, relation: 2 }, "thoughtIdB"],
      [{ thoughtIdA: TAG, thoughtIdB: OTHER_TAG, relation: 2 }, "thoughtIdB"],
    ] as const) {
      const { api, calls } = brain();
      await expect(api.links.create(BRAIN, input)).rejects.toMatchObject({
        kind: "tag_as_parent",
        message: `${field} ${input[field]} cannot be a parent: it is the tag "gotcha"`,
      });
      expect(sent(calls), field).toEqual([read(input[field])]);
    }
  });

  it("a jump to a tag, and a tag below a thought, are ordinary links and go out", async () => {
    for (const [what, input, reads] of [
      ["a jump to a tag", { thoughtIdA: THOUGHT, thoughtIdB: TAG, relation: 3 }, []],
      ["a tag below", { thoughtIdA: THOUGHT, thoughtIdB: TAG, relation: 1 }, [THOUGHT]],
      ["a tag below", { thoughtIdA: TAG, thoughtIdB: THOUGHT, relation: 2 }, [THOUGHT]],
    ] as const) {
      const { api, calls } = brain();
      await expect(api.links.create(BRAIN, input), what).resolves.toBe(LINK);
      expect(sent(calls), what).toEqual([...reads.map(read), postLink]);
    }
  });

  it("a thought is not created under a tag; above one or beside it, it is", async () => {
    // Measured: created under a tag the thought is tagged, and has no parent.
    for (const extra of [{}, { relation: 1 }, { typeId: TYPE }] as const) {
      const { api, calls } = brain();
      await expect(
        api.thoughts.create(BRAIN, { name: "new", sourceThoughtId: TAG, ...extra }),
      ).rejects.toMatchObject({
        kind: "tag_as_parent",
        message: `sourceThoughtId ${TAG} cannot be a parent: it is the tag "gotcha"`,
      });
      expect(sent(calls)).toEqual([read(TAG)]);
    }
    for (const relation of [2, 3] as const) {
      const { api, calls } = brain();
      await api.thoughts.create(BRAIN, { name: "new", sourceThoughtId: TAG, relation });
      expect(sent(calls)).toEqual([postThought]);
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

describe("a link the API does not make", () => {
  const PLAIN = "eeeeeeee-0000-4000-8000-000000000005";
  const ZEROS = "00000000-0000-0000-0000-000000000000";
  const LINK = "99999999-0000-4000-8000-000000000009";

  /**
   * A brain that answers a link or a thought it is sent with `id`. The live
   * API answers a link it does not make with a 200 and an identifier of
   * zeros: a thought with itself, and a tag under a type.
   */
  const answering = (id: string) =>
    apiWith([
      [
        "/api/thoughts/",
        (url) => {
          const named = url.pathname.split("/").pop()!;
          return thought(named, "named", { kind: named === TAG ? 4 : 1 });
        },
      ],
      ["POST /api/links", () => ({ id })],
      ["POST /api/thoughts/", () => ({ id })],
    ]);

  it("a thought linked to itself is refused before any request, whatever the relation", async () => {
    // Measured: a 200 with an identifier of zeros and no link, for each of
    // the three. It used to be returned as the link's identifier.
    for (const relation of [Relation.Child, Relation.Parent, Relation.Jump]) {
      const { api, fetchImpl } = answering(LINK);
      await expect(
        // Case aside: the API reads a UUID in capitals too.
        api.links.create(BRAIN, {
          thoughtIdA: THOUGHT,
          thoughtIdB: THOUGHT.toUpperCase(),
          relation,
        }),
      ).rejects.toMatchObject({
        kind: "bad_request",
        message: `a thought cannot be linked to itself: both ends of the link are ${THOUGHT}`,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("an identifier of zeros is an error, and never the identifier of a link", async () => {
    const { api, calls } = answering(ZEROS);
    const refusal = {
      kind: "zero_id",
      status: 200,
      method: "POST",
      path: `/api/links/${BRAIN}`,
    };
    await expect(
      api.links.create(BRAIN, { thoughtIdA: THOUGHT, thoughtIdB: PLAIN, relation: Relation.Jump }),
    ).rejects.toMatchObject({
      ...refusal,
      message: expect.stringMatching(
        new RegExp(
          `^no link was made between ${THOUGHT} and ${PLAIN}: ` +
            ".*identifier of zeros.*Nothing was written$",
        ),
      ),
    });
    // The request that attaches a tag goes out by the same door.
    await expect(api.links.attachTag(BRAIN, THOUGHT, TAG)).rejects.toMatchObject(refusal);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("nor of a thought", async () => {
    // Not seen from the live API in 28 creates picked to make it. What the
    // zeros would do next is: named as a parent, they are taken for none.
    const { api } = answering(ZEROS);
    await expect(api.thoughts.create(BRAIN, { name: "RAG" })).rejects.toMatchObject({
      kind: "zero_id",
      message: expect.stringMatching(/identifier of zeros for the thought "RAG"/),
    });
    // A name with no character that shows is spelled out, not quoted as `""`.
    await expect(api.thoughts.create(BRAIN, { name: "\u200b" })).rejects.toMatchObject({
      kind: "zero_id",
      message: expect.stringMatching(
        /identifier of zeros for the thought "\(no visible character: U\+200B\)"/,
      ),
    });
  });

  it("any other identifier is returned as it came", async () => {
    const { api } = answering(LINK);
    await expect(
      api.links.create(BRAIN, { thoughtIdA: THOUGHT, thoughtIdB: PLAIN, relation: Relation.Jump }),
    ).resolves.toBe(LINK);
    await expect(api.links.attachTag(BRAIN, THOUGHT, TAG)).resolves.toBe(LINK);
    await expect(api.thoughts.create(BRAIN, { name: "RAG" })).resolves.toBe(LINK);
  });
});

describe("the identifier of zeros, sent by a caller", () => {
  const ZEROS = "00000000-0000-0000-0000-000000000000";
  const LINK = "99999999-0000-4000-8000-000000000009";

  /** A brain that would answer anything with a 200, were it asked. */
  const willing = () =>
    apiWith([
      ["POST /api/", () => ({ id: LINK })],
      ["PATCH /api/", () => 200],
      ["DELETE /api/", () => 200],
      ["/api/", () => thought(THOUGHT, "RAG")],
    ]);

  it("is refused before any request, wherever an identifier goes", async () => {
    // Measured: a create with it for a source or for a type answers 200 and
    // makes the thought with no link and no type; a note written to it is a
    // 200 and a note that never reads back. A well-formed UUID, so the check
    // for a malformed one let it through.
    const { api, fetchImpl } = willing();
    const sends: Array<[string, () => Promise<unknown>]> = [
      ["a brain", () => api.brains.get(ZEROS)],
      ["a brain's statistics", () => api.brains.statistics(ZEROS)],
      ["a brain's log", () => api.brains.modifications(ZEROS, { maxLogs: 1 })],
      ["a brain to open", () => api.app.openBrain(ZEROS)],
      ["a thought to activate", () => api.app.activateThought(BRAIN, ZEROS)],
      ["a search's brain", () => api.search.inBrain(ZEROS, "RAG")],
      ["a thought", () => api.thoughts.get(BRAIN, ZEROS)],
      ["a thought's brain", () => api.thoughts.get(ZEROS, THOUGHT)],
      ["a graph", () => api.thoughts.getGraph(BRAIN, ZEROS)],
      ["a name's brain", () => api.thoughts.findByName(ZEROS, "RAG")],
      ["a source", () => api.thoughts.create(BRAIN, { name: "RAG", sourceThoughtId: ZEROS })],
      [
        "a source to be the parent of",
        () =>
          api.thoughts.create(BRAIN, {
            name: "RAG",
            sourceThoughtId: ZEROS,
            relation: Relation.Parent,
          }),
      ],
      ["a new thought's type", () => api.thoughts.create(BRAIN, { name: "RAG", typeId: ZEROS })],
      [
        // Ahead of the read of the source it stands beside.
        "a type beside a source",
        () => api.thoughts.create(BRAIN, { name: "RAG", sourceThoughtId: THOUGHT, typeId: ZEROS }),
      ],
      ["a thought to update", () => api.thoughts.update(BRAIN, ZEROS, { name: "RAG" })],
      ["a type to set", () => api.thoughts.update(BRAIN, THOUGHT, { typeId: ZEROS })],
      ["a thought's aliases", () => api.thoughts.changeAliases(BRAIN, ZEROS, { add: ["a"] })],
      ["a thought to delete", () => api.thoughts.delete(BRAIN, ZEROS)],
      ["a thought to pin", () => api.thoughts.pin(BRAIN, ZEROS)],
      ["a thought's history", () => api.thoughts.modifications(BRAIN, ZEROS)],
      ["a note to read", () => api.notes.get(BRAIN, ZEROS)],
      ["a note to write", () => api.notes.set(BRAIN, ZEROS, "text")],
      ["a note to add to", () => api.notes.append(BRAIN, ZEROS, "text")],
      ["a link", () => api.links.get(BRAIN, ZEROS)],
      ["a pair's first", () => api.links.between(BRAIN, ZEROS, THOUGHT)],
      ["a pair's second", () => api.links.between(BRAIN, THOUGHT, ZEROS)],
      [
        "a link's source",
        () => api.links.create(BRAIN, { thoughtIdA: ZEROS, thoughtIdB: THOUGHT, relation: 3 }),
      ],
      [
        "a link's target",
        () => api.links.create(BRAIN, { thoughtIdA: THOUGHT, thoughtIdB: ZEROS, relation: 1 }),
      ],
      ["a link to update", () => api.links.update(BRAIN, ZEROS, { name: "x" })],
      ["a link to delete", () => api.links.delete(BRAIN, ZEROS)],
      ["a tag", () => api.links.attachTag(BRAIN, THOUGHT, ZEROS)],
      ["a thought to tag", () => api.links.attachTag(BRAIN, ZEROS, TAG)],
      ["a tag to look for", () => api.links.hasTag(BRAIN, THOUGHT, ZEROS)],
      ["a tag to take off", () => api.links.detachTag(BRAIN, ZEROS, TAG)],
      ["a parent to check", () => api.links.requireParent(BRAIN, ZEROS, "parentId")],
      ["an attachment", () => api.attachments.metadata(BRAIN, ZEROS)],
      ["a thought's attachments", () => api.attachments.ofThought(BRAIN, ZEROS)],
      ["a thought to attach to", () => api.attachments.attachUrl(BRAIN, ZEROS, "https://a.b/")],
      ["an attachment to delete", () => api.attachments.delete(BRAIN, ZEROS)],
    ];
    for (const [what, send] of sends) {
      await expect(send(), what).rejects.toMatchObject({
        kind: "invalid_uuid",
        message: expect.stringMatching(
          new RegExp(`^\\w+ is the all-zero UUID \\(${ZEROS}\\), which names nothing\\. `),
        ),
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is named by the argument it came in", async () => {
    const { api } = willing();
    const field = (send: Promise<unknown>): Promise<string> =>
      send.then(
        () => "nothing thrown",
        (error: unknown) => (error as Error).message.split(" ")[0]!,
      );
    expect(await field(api.thoughts.create(BRAIN, { name: "RAG", sourceThoughtId: ZEROS }))).toBe(
      "sourceThoughtId",
    );
    expect(await field(api.links.requireParent(BRAIN, ZEROS, "parentId"))).toBe("parentId");
    expect(await field(api.thoughts.requireType(BRAIN, ZEROS))).toBe("typeId");
    expect(await field(api.links.requireTag(BRAIN, ZEROS))).toBe("tagId");
    expect(await field(api.notes.set(ZEROS, THOUGHT, "text"))).toBe("brainId");
  });

  it("is not what an answer of zeros is: that one is zero_id, after the request", async () => {
    const { api, fetchImpl } = apiWith([
      ["POST /api/links", () => ({ id: ZEROS })],
      ["/api/", () => thought(THOUGHT, "RAG")],
    ]);
    await expect(
      api.links.create(BRAIN, { thoughtIdA: THOUGHT, thoughtIdB: TAG, relation: 3 }),
    ).rejects.toMatchObject({ kind: "zero_id", status: 200 });
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("any other identifier that names nothing is still sent, for the API to answer", async () => {
    // All of `f`, and a random one: each gets the API's own 404, 403 or 400.
    const { api, calls } = willing();
    await api.thoughts.get(BRAIN, "ffffffff-ffff-ffff-ffff-ffffffffffff");
    await api.thoughts.get(BRAIN, "00000000-0000-0000-0000-000000000001");
    expect(calls).toHaveLength(2);
  });
});

describe("what a write leaves for a reader of a graph", () => {
  // A graph is answered from a copy that is behind a write, and nothing in
  // it says so. The client keeps what an answered write put into the graphs,
  // so that a reader can tell: `ingest()` looks in a copy 0.3 s after
  // another call's create, and one further behind than that lacks the
  // thought, which is then made again.
  const NEW = "eeeeeeee-0000-4000-8000-000000000005";
  const OTHER = "ffffffff-0000-4000-8000-000000000006";
  const LINK = "99999999-0000-4000-8000-000000000009";
  const ZEROS = "00000000-0000-0000-0000-000000000000";

  /** A brain of ordinary thoughts that answers every write, a create with `created`. */
  const brain = (created: unknown = { id: NEW }) =>
    apiWith([
      ["POST /api/thoughts", () => created],
      ["POST /api/links", () => created],
      ["PATCH /api/", () => 200],
      ["DELETE /api/", () => 200],
      [
        "/api/links/",
        () => ({ id: LINK, thoughtIdA: TAG, thoughtIdB: THOUGHT, relation: 1, meaning: 5 }),
      ],
      [
        "/api/thoughts/",
        (url) => {
          const id = url.pathname.split("/").pop()!;
          return thought(id, "any", { kind: id === TAG ? 4 : id === TYPE ? 2 : 1 });
        },
      ],
    ]);
  /** A copy of a graph from before anything was written: it lists nobody. */
  const EMPTY = { children: [], parents: [], jumps: [] };
  /** What the client would have the graph of `id` show that an empty one does not. */
  const asked = (api: TheBrainApi, id: string): string[] =>
    api.client.written
      .notShownBy(BRAIN, id, EMPTY)
      .map((f) => (f.of === "listed" ? `${f.thoughtId} in ${f.list}` : `${f.thoughtId} named`));

  it("a thought created next to another is to be in that thought's graph, where the relation puts it", async () => {
    for (const [relation, there, back] of [
      [undefined, "children", "parents"],
      [Relation.Child, "children", "parents"],
      [Relation.Parent, "parents", "children"],
      [Relation.Jump, "jumps", "jumps"],
    ] as const) {
      const { api } = brain();
      const id = await api.thoughts.create(BRAIN, {
        name: "New",
        sourceThoughtId: THOUGHT,
        ...(relation !== undefined ? { relation } : {}),
      });

      expect(asked(api, THOUGHT), there).toEqual([`${id} in ${there}`]);
      expect(asked(api, id), back).toEqual([`${THOUGHT} in ${back}`]);
      expect(asked(api, OTHER)).toEqual([]);
    }
  });

  it("nothing is kept of a create with no source, of a type or a tag, or of one that was not answered with a thought", async () => {
    const plain = brain();
    await plain.api.thoughts.create(BRAIN, { name: "New" });
    expect([asked(plain.api, THOUGHT), asked(plain.api, NEW)]).toEqual([[], []]);

    // Where a new type or tag is listed next to its source was not measured.
    for (const kind of [2, 4]) {
      const { api } = brain();
      await api.thoughts.create(BRAIN, {
        name: "New",
        kind,
        sourceThoughtId: THOUGHT,
        relation: Relation.Jump,
      });
      expect(asked(api, THOUGHT), String(kind)).toEqual([]);
    }

    const refused = brain(400);
    await expect(
      refused.api.thoughts.create(BRAIN, { name: "New", sourceThoughtId: THOUGHT }),
    ).rejects.toMatchObject({ kind: "bad_request" });
    expect(asked(refused.api, THOUGHT)).toEqual([]);

    const zeros = brain({ id: ZEROS });
    await expect(
      zeros.api.thoughts.create(BRAIN, { name: "New", sourceThoughtId: THOUGHT }),
    ).rejects.toMatchObject({ kind: "zero_id" });
    expect(asked(zeros.api, THOUGHT)).toEqual([]);
  });

  it("a link puts each end into the other's graph, where the relation puts it", async () => {
    for (const [relation, there, back] of [
      [undefined, "children", "parents"],
      [Relation.Child, "children", "parents"],
      [Relation.Parent, "parents", "children"],
      [Relation.Jump, "jumps", "jumps"],
    ] as const) {
      const { api } = brain({ id: LINK });
      await api.links.create(BRAIN, {
        thoughtIdA: THOUGHT,
        thoughtIdB: OTHER,
        ...(relation !== undefined ? { relation } : {}),
      });

      expect(asked(api, THOUGHT), there).toEqual([`${OTHER} in ${there}`]);
      expect(asked(api, OTHER), back).toEqual([`${THOUGHT} in ${back}`]);
    }
  });

  it("nothing is kept of a tag attached, nor of a link that was refused or answered with zeros", async () => {
    // A tag is in neither of the three lists, and its attachment is looked
    // up by the pair, which is not behind a write.
    const tagged = brain({ id: LINK });
    await tagged.api.links.attachTag(BRAIN, THOUGHT, TAG);
    expect([asked(tagged.api, THOUGHT), asked(tagged.api, TAG)]).toEqual([[], []]);

    for (const [answer, kind] of [
      [400, "bad_request"],
      [{ id: ZEROS }, "zero_id"],
    ] as const) {
      const { api } = brain(answer);
      await expect(
        api.links.create(BRAIN, { thoughtIdA: THOUGHT, thoughtIdB: OTHER, relation: Relation.Jump }),
      ).rejects.toMatchObject({ kind });
      expect([asked(api, THOUGHT), asked(api, OTHER)], kind).toEqual([[], []]);
    }
  });

  it("a rename is kept under the name as TheBrain stores it, and nothing of a patch that names nothing", async () => {
    const { api } = brain();
    await api.thoughts.update(BRAIN, NEW, { label: "caption" });
    const lists = (name: string) => ({ children: [{ id: NEW, name }], parents: [], jumps: [] });
    const behind = (name: string) => api.client.written.notShownBy(BRAIN, THOUGHT, lists(name));
    expect(behind("Before")).toEqual([]);

    await api.thoughts.update(BRAIN, NEW, { name: " After\tthat\n" });
    expect(behind("Before")).toMatchObject([{ of: "named", thoughtId: NEW, name: "After that" }]);
    expect(behind("After that")).toEqual([]);

    const refused = apiWith([["PATCH /api/", () => 400]]);
    await expect(refused.api.thoughts.update(BRAIN, NEW, { name: "After" })).rejects.toMatchObject({
      kind: "bad_request",
    });
    expect(refused.api.client.written.notShownBy(BRAIN, THOUGHT, lists("Before"))).toEqual([]);
  });

  it("a thought deleted, or given another kind, is asked of no graph, whatever came of the request", async () => {
    for (const [what, answer, change] of [
      ["deleted", 200, (api: TheBrainApi) => api.thoughts.delete(BRAIN, NEW)],
      // Unanswered or refused, it may be gone all the same.
      ["a delete refused", 500, (api: TheBrainApi) => api.thoughts.delete(BRAIN, NEW)],
      ["another kind", 200, (api: TheBrainApi) => api.thoughts.update(BRAIN, NEW, { kind: 4 })],
      ["a kind refused", 400, (api: TheBrainApi) => api.thoughts.update(BRAIN, NEW, { kind: 4 })],
    ] as const) {
      const { api } = apiWith([
        ["POST /api/thoughts", () => ({ id: NEW })],
        ["DELETE /api/", () => answer],
        ["PATCH /api/", () => answer],
        ["/api/thoughts/", (url) => thought(url.pathname.split("/").pop()!, "any")],
      ]);
      await api.thoughts.create(BRAIN, { name: "New", sourceThoughtId: THOUGHT });
      await api.thoughts.create(BRAIN, { name: "New", sourceThoughtId: OTHER });
      expect(asked(api, THOUGHT), what).toEqual([`${NEW} in children`]);

      await change(api).catch(() => undefined);
      expect([asked(api, THOUGHT), asked(api, OTHER), asked(api, NEW)], what).toEqual([[], [], []]);
    }
  });

  it("a link deleted by its identifier takes every link kept for that brain; a tag or a type taken off takes none", async () => {
    const linked = async () => {
      const made = brain();
      await made.api.thoughts.create(BRAIN, { name: "New", sourceThoughtId: THOUGHT });
      return made;
    };

    const unlinked = await linked();
    await unlinked.api.links.delete(BRAIN, LINK);
    expect(asked(unlinked.api, THOUGHT)).toEqual([]);

    // Neither is a link in one of the three lists.
    const untagged = await linked();
    expect(await untagged.api.links.detachTag(BRAIN, THOUGHT, TAG)).toBe(true);
    expect(untagged.calls.at(-1)).toMatchObject({ method: "DELETE" });
    expect(asked(untagged.api, THOUGHT)).toEqual([`${NEW} in children`]);

    const untyped = apiWith([
      ["POST /api/thoughts", () => ({ id: NEW })],
      ["DELETE /api/", () => 200],
      [
        "/api/links/",
        () => ({ id: LINK, thoughtIdA: TYPE, thoughtIdB: THOUGHT, relation: 1, meaning: 2 }),
      ],
      ["/api/thoughts/", (url) => thought(url.pathname.split("/").pop()!, "any")],
    ]);
    await untyped.api.thoughts.create(BRAIN, { name: "New", sourceThoughtId: THOUGHT });
    expect(await untyped.api.links.detachType(BRAIN, THOUGHT, TYPE)).toBe(true);
    expect(asked(untyped.api, THOUGHT)).toEqual([`${NEW} in children`]);
  });
});

describe("a link's name as TheBrain stores it", () => {
  it("has a tab and a line feed for a space each, and no blanks at either end", () => {
    // Measured on 15.0.640, by a POST and by a PATCH alike (contract test).
    for (const [sent, stored] of [
      ["motivates", "motivates"],
      ["  padded  ", "padded"],
      ["tab\tinside", "tab inside"],
      ["line\nbreak", "line break"],
      ["\nleading and trailing\n", "leading and trailing"],
      ["a \n b", "a   b"],
      ["\u00a0nbsp ends\u00a0", "nbsp ends"],
      // Kept as they are: a run of spaces, a carriage return, a no-break space inside.
      ["two  spaces", "two  spaces"],
      ["crlf\r\nbreak", "crlf\r break"],
      ["nbsp\u00a0inside", "nbsp\u00a0inside"],
      ["", ""],
    ] as const) {
      expect(linkNameAsStored(sent), JSON.stringify(sent)).toBe(stored);
    }
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

  it("create refuses a relation with no source to relate to, before any request", async () => {
    // It used to leave the relation out of the request and create the
    // thought with no link.
    const { api, fetchImpl } = brain();
    for (const relation of [Relation.Child, Relation.Parent, Relation.Jump]) {
      await expect(api.thoughts.create(BRAIN, { name: "new", relation })).rejects.toMatchObject({
        kind: "bad_request",
        message: expect.stringContaining(
          "relation says how the new thought is linked to sourceThoughtId, and none was given",
        ),
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("create with neither sends neither", async () => {
    const { api, calls } = brain();
    await api.thoughts.create(BRAIN, { name: "new" });
    expect(calls.at(-1)!.body).not.toHaveProperty("relation");
    expect(calls.at(-1)!.body).not.toHaveProperty("sourceThoughtId");
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

describe("search: a query the endpoint refuses for its size", () => {
  // Measured (docs/api-map.md, L30): neither answer says a word about size.
  const refusing = (status: number) => apiWith([["/api/search/", () => status]]).api;
  const words = (count: number, word = "ab"): string => Array(count).fill(word).join(" ");

  it("a 414 with no body is told as a query too long, with its size", async () => {
    // It read "(empty response)", as a bad request.
    const query = "я".repeat(1400);
    await expect(refusing(414).search.inBrain(BRAIN, query)).rejects.toMatchObject({
      kind: "query_too_long",
      status: 414,
      method: "GET",
      path: `/api/search/${BRAIN}`,
      message:
        "the search text is too long for one request: 1400 characters, 8400 bytes as the " +
        "URL carries them, where TheBrain takes about 8,000 (a Cyrillic letter is 6 of " +
        "them, a CJK character 9). Shorten it",
      cause: { kind: "bad_request", message: "(empty response)" },
    });
  });

  it("the bytes are counted as the request carries them: a space is one", async () => {
    await expect(refusing(414).search.inBrain(BRAIN, "ab cd")).rejects.toMatchObject({
      message: expect.stringContaining("5 characters, 5 bytes as the URL carries them"),
    });
  });

  it.each([513, 600, 1024])("the 403 for %i words is told as a query too long", async (count) => {
    // It read as an identifier nobody has, and a search carries none.
    await expect(refusing(403).search.inBrain(BRAIN, words(count))).rejects.toMatchObject({
      kind: "query_too_long",
      status: 403,
      message:
        `the search text is ${count} words, and TheBrain's search answers a 403 that ` +
        "names no cause to one of 513 to 1,024 words. Shorten it",
      cause: { kind: "forbidden" },
    });
  });

  it.each([
    ["a few words", "retrieval augmented generation"],
    ["512 words", words(512)],
    ["1,025 words", words(1025)],
    ["600 words of one letter, which the search does not count", words(600, "a")],
    ["513 words, 300 of them of one letter", `${words(213)} ${words(300, "a")}`],
  ])("a 403 for %s is left as the API's catch-all", async (_what, query) => {
    await expect(refusing(403).search.inBrain(BRAIN, query)).rejects.toMatchObject({
      kind: "forbidden",
      status: 403,
    });
  });

  it.each([
    [400, "bad_request"],
    [401, "auth"],
    [500, "server"],
  ])("a %i is passed on as it came, however long the query", async (status, kind) => {
    await expect(refusing(status).search.inBrain(BRAIN, words(600))).rejects.toMatchObject({
      kind,
      status,
    });
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
