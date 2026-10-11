/**
 * Tools end to end: a real MCP client talking to the registered handlers over
 * an in-memory transport, with only HTTP faked.
 */
import { describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { TheBrainApi } from "../src/api/index.js";
import { indexModelId } from "../src/semantic/document.js";
import { EmbedderUnavailableError, type Embedder } from "../src/semantic/embedder.js";
import { SemanticIndexer } from "../src/semantic/indexer.js";
import { SemanticSearch } from "../src/semantic/search.js";
import { VectorStore } from "../src/semantic/store.js";
import type { ServerContext } from "../src/server/context.js";
import { registerIngestTool } from "../src/server/tools/ingest.js";
import { registerReadTools } from "../src/server/tools/read.js";
import { ALIAS_COST, registerWriteTools } from "../src/server/tools/write.js";

const BRAIN = "aaaaaaaa-0000-4000-8000-000000000001";
const THOUGHT = "bbbbbbbb-0000-4000-8000-000000000002";
const PARENT = "cccccccc-0000-4000-8000-000000000003";
const LINK = "dddddddd-0000-4000-8000-000000000004";

type Route = [needle: string, respond: (url: URL, body: unknown) => unknown];

/**
 * Routes match by method and path substring, first match wins. A route
 * answers 200 with what it returns, a bare status for a number, or with the
 * `Response` it builds itself. `context` adds to the server context what a
 * tool needs beside the API.
 *
 * One thing is added to what a route returns: a graph lists the thoughts
 * created next to its thought through this connection, in the list their
 * relation puts them in, as the API's does. `brain_ingest` waits for that.
 */
async function connect(
  routes: Route[],
  context: (api: TheBrainApi) => Record<string, unknown> = () => ({}),
) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const LISTS = { 1: "children", 2: "parents", 3: "jumps" } as const;
  const born: Array<{ id: string; name: string; source: string; list: string }> = [];
  const listing = (method: string, url: URL, body: unknown, value: unknown): unknown => {
    type Create = { name: string; sourceThoughtId?: string; relation?: 1 | 2 | 3 };
    const { name, sourceThoughtId: source, relation = 1 } = (body ?? {}) as Create;
    const id = (value as { id?: string } | null)?.id;
    const creates = method === "POST" && /^\/api\/thoughts\/[^/]+$/.test(url.pathname);
    if (creates && id !== undefined && source !== undefined) {
      born.push({ id, name, source, list: LISTS[relation] });
    }
    const [, of] = /\/([^/]+)\/graph$/.exec(url.pathname) ?? [];
    if (method !== "GET" || of === undefined || typeof value !== "object" || value === null) {
      return value;
    }
    const listed: Record<string, unknown> = { ...value };
    for (const b of born.filter((b) => b.source === of)) {
      const there = (listed[b.list] as unknown[] | null) ?? [];
      listed[b.list] = [...there, { id: b.id, name: b.name }];
    }
    return listed;
  };
  const fetchImpl = vi.fn(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const url = input instanceof URL ? input : new URL(String(input));
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname, body });
      for (const [needle, respond] of routes) {
        const [wantMethod, path] = needle.split(" ") as [string, string];
        if (method !== wantMethod || !url.pathname.includes(path)) continue;
        const answer = respond(url, body);
        if (answer instanceof Response) return answer;
        const value = listing(method, url, body, answer);
        return new Response(typeof value === "number" ? "" : JSON.stringify(value), {
          status: typeof value === "number" ? value : 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(`no stub for ${method} ${url.pathname}`), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  );

  const api = new TheBrainApi({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
  const ctx = { api, ...context(api) } as unknown as ServerContext;
  const server = new McpServer({ name: "thebrain-mcp-test", version: "0" });
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  registerIngestTool(server, ctx);

  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return { text: content.map((c) => c.text).join("\n"), isError: result.isError === true };
  };
  const sent = (method: string): unknown[] =>
    calls.filter((c) => c.method === method).map((c) => c.body);
  return { client, call, calls, sent };
}

/** A thought as the API sends it; `aliases` is absent unless given, as on old builds. */
const thought = (name: string, extra: Record<string, unknown> = {}) => ({
  id: THOUGHT,
  brainId: BRAIN,
  name,
  typeId: null,
  kind: 1,
  label: null,
  ...extra,
});

const graph = (activeThought: unknown) => ({
  activeThought,
  parents: null,
  children: null,
  jumps: null,
  siblings: null,
  tags: null,
  type: null,
  links: null,
  attachments: null,
});

const noNote = { modificationDateTime: "0001-01-01T00:00:00", markdown: "" };

/** What the API answers for the graph of an identifier nobody has, and for much else. */
const GENERIC_403 =
  "To use the TheBrain API, make requests to /api (e.g. /api/brains). " +
  "An API key is required via the Authorization header.";
const generic403 = (): Response =>
  new Response(JSON.stringify(GENERIC_403), {
    status: 403,
    headers: { "content-type": "application/json" },
  });

describe("brain_get_thought", () => {
  const view = async (activeThought: unknown): Promise<string> => {
    const { call } = await connect([
      ["GET /graph", () => graph(activeThought)],
      ["GET /api/notes", () => noNote],
    ]);
    const result = await call("brain_get_thought", { brainId: BRAIN, thoughtId: THOUGHT });
    expect(result.isError).toBe(false);
    return result.text;
  };

  it("lists aliases one per line, so each can be quoted back exactly", async () => {
    const text = await view(thought("RAG", { aliases: ["Retrieval, augmented", "R.A.G."] }));
    expect(text).toContain("## Aliases\n- Retrieval, augmented\n- R.A.G.");
  });

  it("drops the section when there are none, or the build has no aliases at all", async () => {
    expect(await view(thought("RAG", { aliases: [] }))).not.toContain("Aliases");
    expect(await view(thought("RAG", { aliases: null }))).not.toContain("Aliases");
    expect(await view(thought("RAG"))).not.toContain("Aliases");
  });
});

describe("a thought's kind in what the read tools print", () => {
  const TYPE = "eeeeeeee-0000-4000-8000-000000000005";
  const TAG = "ffffffff-0000-4000-8000-000000000006";
  const OTHER = "abababab-0000-4000-8000-000000000007";

  const at = (id: string, name: string, kind = 1, extra: Record<string, unknown> = {}) =>
    thought(name, { id, kind, ...extra });
  const type = at(TYPE, "Pattern", 2);
  const tag = at(TAG, "gotcha", 4);
  const plain = at(OTHER, "Embeddings");

  describe("brain_get_thought", () => {
    const view = async (
      shown: Record<string, unknown>,
      args: Record<string, unknown> = {},
    ): Promise<string> => {
      const { call } = await connect([
        ["GET /graph", () => shown],
        ["GET /api/notes", () => noNote],
      ]);
      const result = await call("brain_get_thought", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        ...args,
      });
      expect(result.isError).toBe(false);
      return result.text;
    };

    it("an ordinary thought among ordinary ones reads as it did, to the character", async () => {
      const text = await view({
        ...graph(thought("RAG")),
        parents: [at(PARENT, "Retrieval")],
        children: [plain],
      });
      expect(text).toBe(
        `# RAG\n${THOUGHT}\n\n## Parents\n- Retrieval — ${PARENT}\n\n## Children\n- Embeddings — ${OTHER}`,
      );
    });

    it("a type and a tag are marked after their identifier", async () => {
      expect(await view(graph(at(THOUGHT, "Pattern", 2)))).toBe(`# Pattern\n${THOUGHT} [type]`);
      expect(await view(graph(at(THOUGHT, "gotcha", 4)))).toBe(`# gotcha\n${THOUGHT} [tag]`);
    });

    it("a type or a tag in any list of neighbours is marked, and the ordinary ones are not", async () => {
      const text = await view(
        {
          ...graph(thought("RAG")),
          parents: [tag],
          children: [type, plain],
          jumps: [tag, type],
          siblings: [type, plain],
        },
        { includeSiblings: true },
      );
      expect(text).toContain(`## Parents\n- gotcha — ${TAG} [tag]\n`);
      expect(text).toContain(`## Children\n- Pattern — ${TYPE} [type]\n- Embeddings — ${OTHER}\n`);
      expect(text).toContain(`## Jumps\n- gotcha — ${TAG} [tag]\n- Pattern — ${TYPE} [type]\n`);
      expect(text).toContain(`## Siblings\n- Pattern — ${TYPE} [type]\n- Embeddings — ${OTHER}`);
    });

    it("a thought's type comes with its identifier, and its tags by name", async () => {
      const text = await view({
        ...graph(thought("RAG", { typeId: TYPE })),
        type,
        // The API lists the type among the parents as well.
        parents: [type, at(PARENT, "Retrieval")],
        tags: [tag, at(OTHER, "measured", 4)],
      });
      expect(text).toContain(`## Type\nPattern — ${TYPE}\n`);
      expect(text).toContain("## Tags\ngotcha, measured\n");
      expect(text).toContain(`## Parents\n- Retrieval — ${PARENT}`);
      expect(text).not.toContain("[type]");
    });

    it("what a type or a tag lists under it is not called its children", async () => {
      // The API's graph has them in `children`: the thoughts of the type, and
      // the thoughts the tag is on.
      expect(await view({ ...graph(at(THOUGHT, "Pattern", 2)), children: [plain] })).toBe(
        `# Pattern\n${THOUGHT} [type]\n\n## Thoughts of this type\n- Embeddings — ${OTHER}`,
      );
      expect(await view({ ...graph(at(THOUGHT, "gotcha", 4)), children: [plain] })).toBe(
        `# gotcha\n${THOUGHT} [tag]\n\n## Thoughts with this tag\n- Embeddings — ${OTHER}`,
      );
    });

    it("only that section is renamed, and only for a type or a tag", async () => {
      const around = { parents: [at(PARENT, "Retrieval")], children: [type, tag], jumps: [plain] };
      const sections = (text: string): string[] =>
        text.split("\n").filter((l) => l.startsWith("## "));

      // A type or a tag among an ordinary thought's children leaves them children.
      expect(sections(await view({ ...graph(thought("RAG")), ...around }))).toEqual([
        "## Parents",
        "## Children",
        "## Jumps",
      ]);
      expect(sections(await view({ ...graph(at(THOUGHT, "Pattern", 2)), ...around }))).toEqual([
        "## Parents",
        "## Thoughts of this type",
        "## Jumps",
      ]);
      // A kind with no name here is not known to hold anything but children.
      expect(sections(await view({ ...graph(at(THOUGHT, "Launch", 3)), ...around }))).toEqual([
        "## Parents",
        "## Children",
        "## Jumps",
      ]);
    });
  });

  describe("brain_search", () => {
    const hit = (t: { name: string }) => ({
      sourceThought: t,
      sourceLink: null,
      searchResultType: 1,
      isFromOtherBrain: false,
      name: t.name,
      attachmentId: "00000000-0000-0000-0000-000000000000",
      brainName: null,
      brainId: "00000000-0000-0000-0000-000000000000",
      entityType: 2,
      sourceType: 2,
    });

    const embedder: Embedder = {
      id: "fake@v1",
      dimensions: 2,
      embedDocuments: async (texts) => texts.map(() => new Float32Array([1, 0])),
      embedQuery: async () => new Float32Array([1, 0]),
    };

    /** A search over `store`: an empty one falls back to TheBrain's own search. */
    const searching = (store: VectorStore) => (api: TheBrainApi) => ({
      search: () => new SemanticSearch(api, store, embedder),
    });

    const indexed = (): VectorStore => {
      const store = new VectorStore(":memory:");
      store.setMeta({
        brainId: BRAIN,
        model: indexModelId(embedder.id),
        dimensions: embedder.dimensions,
        syncedThrough: null,
      });
      const entry = (thoughtId: string, name: string, kind: number, x: number) => ({
        thoughtId,
        name,
        kind,
        contentHash: "h",
        vector: new Float32Array([x, Math.sqrt(1 - x * x)]),
      });
      store.upsert([
        entry(TYPE, "Pattern", 2, 1),
        entry(OTHER, "Embeddings", 1, 0.8),
        entry(TAG, "gotcha", 4, 0.6),
      ]);
      return store;
    };

    /** The table's lines, each cut into cells where two or more spaces part them. */
    const cells = (text: string): string[][] => {
      const lines = text.split("\n");
      const header = lines.findIndex((l) => l.startsWith("Score"));
      const end = lines.findIndex((l, i) => i > header && l === "");
      return lines
        .slice(header, end === -1 ? undefined : end)
        .filter((l) => !l.startsWith("─"))
        .map((l) => l.split(/\s{2,}/));
    };

    const lexical = async (args: Record<string, unknown>): Promise<string> => {
      const { call } = await connect(
        [["GET /api/search", () => [hit(type), hit(plain), hit(tag)]]],
        searching(new VectorStore(":memory:")),
      );
      const result = await call("brain_search", { brainId: BRAIN, query: "RAG", ...args });
      expect(result.isError).toBe(false);
      return result.text;
    };

    const vector = async (args: Record<string, unknown>): Promise<string> => {
      const { call, calls } = await connect([], searching(indexed()));
      const result = await call("brain_search", { brainId: BRAIN, query: "RAG", ...args });
      expect(result.isError).toBe(false);
      // The kind is the one the index keeps: no request is made for it.
      expect(calls).toEqual([]);
      return result.text;
    };

    it("without an index, types and tags asked for are told apart in a Kind column", async () => {
      const text = await lexical({ includeAuxiliary: true });
      expect(text).toContain("## Found by substring");
      expect(cells(text)).toEqual([
        ["Score", "Thought", "Identifier", "Kind", "Matched"],
        ["1.000", "Pattern", TYPE, "type", "RAG"],
        ["0.500", "Embeddings", OTHER, "RAG"],
        ["0.333", "gotcha", TAG, "tag", "RAG"],
      ]);
    });

    it("without an index, a result of ordinary thoughts has no such column", async () => {
      expect(cells(await lexical({}))).toEqual([
        ["Score", "Thought", "Identifier", "Matched"],
        ["0.500", "Embeddings", OTHER, "RAG"],
      ]);
    });

    it("with an index, the kind comes from the index and fills the same column", async () => {
      const text = await vector({ includeAuxiliary: true });
      expect(text).toContain("## Found by meaning");
      expect(cells(text)).toEqual([
        ["Score", "Thought", "Identifier", "Kind", "Matched"],
        ["1.000", "Pattern", TYPE, "type"],
        ["0.800", "Embeddings", OTHER],
        ["0.600", "gotcha", TAG, "tag"],
      ]);
    });

    it("with an index, a result of ordinary thoughts reads as it did, to the character", async () => {
      expect(await vector({})).toBe(
        "## Found by meaning\n" +
          "Score  Thought     Identifier                            Matched\n" +
          "─────  ──────────  ────────────────────────────────────  ───────\n" +
          `0.800  Embeddings  ${OTHER}`,
      );
    });
  });

  describe("brain_traverse", () => {
    const walk = async (root: Record<string, unknown>): Promise<string> => {
      const { call } = await connect([["GET /graph", () => root]]);
      const result = await call("brain_traverse", { brainId: BRAIN, thoughtId: THOUGHT, depth: 1 });
      expect(result.isError).toBe(false);
      return result.text;
    };

    it("a type or a tag met on the way is marked, and an ordinary thought is not", async () => {
      const text = await walk({
        ...graph(thought("RAG")),
        children: [type, plain],
        jumps: [tag],
      });
      expect(text).toBe(
        "# Neighbourhood of: RAG\n\n" +
          "## Hop 1\n" +
          `- Pattern — ${TYPE} [type]  (via RAG)\n` +
          `- Embeddings — ${OTHER}  (via RAG)\n` +
          `- gotcha — ${TAG} [tag]  (via RAG)\n\n` +
          "## Totals\nthoughts 4, links 3",
      );
    });

    it("a walk that starts from a type or a tag says so in its heading", async () => {
      expect(await walk({ ...graph(at(THOUGHT, "Pattern", 2)), children: [plain] })).toContain(
        "# Neighbourhood of: Pattern [type]\n",
      );
      expect(await walk({ ...graph(at(THOUGHT, "gotcha", 4)), children: [plain] })).toContain(
        "# Neighbourhood of: gotcha [tag]\n",
      );
    });
  });

  describe("brain_recent_changes", () => {
    const entry = (second: number, fields: Record<string, unknown>) => ({
      sourceId: THOUGHT,
      sourceType: 2,
      extraAId: "00000000-0000-0000-0000-000000000000",
      extraAType: -1,
      extraBId: "00000000-0000-0000-0000-000000000000",
      extraBType: -1,
      modType: 101,
      oldValue: null,
      newValue: null,
      userId: "00000000-0000-0000-0000-000000000000",
      brainId: BRAIN,
      creationDateTime: `2026-10-10T12:00:0${second}`,
      modificationDateTime: `2026-10-10T12:00:0${second}`,
      syncUpdateDateTime: null,
      ...fields,
    });

    it("a tag attached reads as one, and a type created as a type, at no further request", async () => {
      const known = [thought("RAG"), type, tag];
      const { call, calls } = await connect([
        [
          "GET /modifications",
          () => [
            // A tag attached is logged as a link created, the tag at one end.
            entry(3, {
              sourceId: LINK,
              sourceType: 3,
              extraAId: TAG,
              extraAType: 2,
              extraBId: THOUGHT,
              extraBType: 2,
            }),
            entry(2, { sourceId: TYPE }),
            entry(1, {}),
          ],
        ],
        ["GET /api/thoughts/", (url) => known.find((t) => url.pathname.endsWith(t.id)) ?? 404],
      ]);
      const result = await call("brain_recent_changes", {
        brainId: BRAIN,
        since: "2026-10-10T00:00:00Z",
      });

      expect(result.isError).toBe(false);
      const rows = result.text.split("\n").filter((l) => l.startsWith("2026-10-10 12:00"));
      expect(rows.map((l) => l.split(/\s{2,}/).slice(1))).toEqual([
        ["link created", "gotcha [tag] ↔ RAG"],
        ["created", "Pattern [type]"],
        ["created", "RAG"],
      ]);
      // One read of the log and one of each thought named, as before.
      expect(calls.map((c) => c.path.split("/").at(-1))).toEqual([
        "modifications",
        TAG,
        THOUGHT,
        TYPE,
      ]);
    });
  });
});

describe("brain_recent_changes and a thought it has no name for", () => {
  const GONE = "eeeeeeee-0000-4000-8000-000000000005";
  const NOBODY = "00000000-0000-0000-0000-000000000000";

  /** A log entry as the API sends it: a thought created, unless `fields` say otherwise. */
  const entry = (time: string, fields: Record<string, unknown>) => ({
    sourceId: THOUGHT,
    sourceType: 2,
    extraAId: NOBODY,
    extraAType: -1,
    extraBId: NOBODY,
    extraBType: -1,
    modType: 101,
    oldValue: null,
    newValue: null,
    userId: NOBODY,
    brainId: BRAIN,
    creationDateTime: `2026-10-10T12:${time}`,
    modificationDateTime: `2026-10-10T12:${time}`,
    syncUpdateDateTime: null,
    ...fields,
  });

  /** The table's rows without their time: what happened, and to what. */
  const rows = (text: string): string[][] =>
    text
      .split("\n")
      .filter((l) => l.startsWith("2026-10-10 12:"))
      .map((l) => l.split(/\s{2,}/).slice(1));

  const changes = async (routes: Route[]) => {
    const { call, calls } = await connect(routes);
    const result = await call("brain_recent_changes", {
      brainId: BRAIN,
      since: "2026-10-10T00:00:00Z",
      limit: 500,
    });
    expect(result.isError).toBe(false);
    const read = calls.filter((c) => c.path.includes("/api/thoughts/"));
    return { rows: rows(result.text), read: read.map((c) => c.path.split("/").at(-1)) };
  };

  it("a thought deleted since reads as deleted in every row about it, not as one with no name", async () => {
    // What is there: one with a name, and one the API sends without.
    const known = [thought("RAG"), { ...thought("RAG"), id: PARENT, name: null }];
    const { rows, read } = await changes([
      [
        "GET /modifications",
        () => [
          entry("00:04", { sourceId: GONE, modType: 102 }),
          entry("00:03", {
            sourceId: LINK,
            sourceType: 3,
            modType: 102,
            extraAId: THOUGHT,
            extraAType: 2,
            extraBId: GONE,
            extraBType: 2,
          }),
          entry("00:02", { sourceId: PARENT }),
          entry("00:01", { sourceId: GONE }),
          entry("00:00", {}),
        ],
      ],
      // The read of a thought nobody has is a 404, a deleted one's included.
      ["GET /api/thoughts/", (url) => known.find((t) => url.pathname.endsWith(t.id)) ?? 404],
    ]);

    expect(rows).toEqual([
      ["deleted", "(deleted)"],
      ["link deleted", "RAG ↔ (deleted)"],
      ["created", "(unnamed)"],
      ["created", "(deleted)"],
      ["created", "RAG"],
    ]);
    // One read of each thought named, as before.
    expect(read).toEqual([GONE, THOUGHT, PARENT]);
  });

  it("a read that fails some other way does not make a thought deleted, or unnamed", async () => {
    const { rows } = await changes([
      [
        "GET /modifications",
        () => [
          entry("00:02", { sourceId: PARENT }),
          entry("00:01", { sourceId: GONE }),
          entry("00:00", {}),
        ],
      ],
      [
        "GET /api/thoughts/",
        (url) => {
          if (url.pathname.endsWith(GONE)) return 500;
          // The API's catch-all: it names no cause, and is not the read's
          // answer for a thought nobody has.
          return url.pathname.endsWith(PARENT) ? generic403() : thought("RAG");
        },
      ],
    ]);

    expect(rows).toEqual([
      ["created", "(name not read)"],
      ["created", "(name not read)"],
      ["created", "RAG"],
    ]);
  });

  it("past the cap on names a thought is one whose name was not read, in the same words", async () => {
    const CAP = 60;
    const id = (i: number): string => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000009`;
    const two = (n: number): string => String(n).padStart(2, "0");
    // One thought more than the cap, the newest first, as the API sends them.
    const log = Array.from({ length: CAP + 1 }, (_, i) =>
      entry(`${two(Math.floor((CAP - i) / 60))}:${two((CAP - i) % 60)}`, { sourceId: id(i) }),
    );
    const { rows, read } = await changes([
      ["GET /modifications", () => log],
      ["GET /api/thoughts/", (url) => thought("RAG", { id: url.pathname.split("/").at(-1) })],
    ]);

    expect(read).toHaveLength(CAP);
    expect(rows).toEqual([
      ...Array.from({ length: CAP }, () => ["created", "RAG"]),
      ["created", "(name not read)"],
    ]);
  });
});

describe("brain_update_thought", () => {
  /** A thought whose aliases a PATCH really changes, so a write reads back. */
  const routes = (initial: string[]): Route[] => {
    let aliases = initial;
    return [
      ["GET /api/thoughts/", () => thought("RAG", { aliases })],
      [
        "PATCH /api/thoughts/",
        (_url, body) => {
          for (const op of body as Array<{ op: string; path: string; value?: string[] }>) {
            if (op.path === "/aliases") aliases = op.op === "remove" ? [] : (op.value ?? []);
          }
          return 200;
        },
      ],
    ];
  };

  it("adds aliases to the ones the thought has instead of replacing them", async () => {
    const { call, sent } = await connect(routes(["R.A.G."]));
    const result = await call("brain_update_thought", {
      brainId: BRAIN,
      thoughtId: THOUGHT,
      addAliases: ["Retrieval-augmented generation", "r.a.g."],
    });

    expect(result.isError).toBe(false);
    expect(sent("PATCH")).toEqual([
      [
        {
          op: "replace",
          path: "/aliases",
          value: ["R.A.G.", "Retrieval-augmented generation"],
        },
      ],
    ]);
    expect(result.text).toContain('aliases added: ["Retrieval-augmented generation"]');
    expect(result.text).toContain('aliases now: ["R.A.G.","Retrieval-augmented generation"]');
  });

  it("writes other fields and aliases as separate, ordered requests", async () => {
    const { call, sent } = await connect(routes(["old"]));
    const result = await call("brain_update_thought", {
      brainId: BRAIN,
      thoughtId: THOUGHT,
      label: "pattern",
      removeAliases: ["OLD"],
    });

    expect(sent("PATCH")).toEqual([
      [{ op: "replace", path: "/label", value: "pattern" }],
      [{ op: "remove", path: "/aliases" }],
    ]);
    expect(result.text).toContain('label = "pattern"');
    expect(result.text).toContain('aliases removed: ["old"]');
  });

  it("says so when the aliases asked for change nothing, and writes nothing", async () => {
    const { call, sent } = await connect(routes(["R.A.G."]));
    const result = await call("brain_update_thought", {
      brainId: BRAIN,
      thoughtId: THOUGHT,
      addAliases: ["r.a.g."],
      removeAliases: ["never there"],
    });
    expect(result.isError).toBe(false);
    expect(sent("PATCH")).toEqual([]);
    expect(result.text).toContain("aliases unchanged");
  });

  it("still refuses a call that supplies nothing to change", async () => {
    const { call, calls } = await connect(routes([]));
    const result = await call("brain_update_thought", {
      brainId: BRAIN,
      thoughtId: THOUGHT,
      addAliases: [],
    });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  /** A thought of type PARENT; deleting the link between them takes the type away. */
  const typedRoutes = (link: { meaning: number }): Route[] => {
    let typeId: string | null = PARENT;
    return [
      ["GET /api/thoughts/", () => thought("RAG", { typeId })],
      ["PATCH /api/thoughts/", () => 200],
      ["GET /api/links/", () => ({ id: LINK, thoughtIdA: PARENT, thoughtIdB: THOUGHT, ...link })],
      ["DELETE /api/links/", () => ((typeId = null), 200)],
    ];
  };

  it("null clears a caption and a colour with remove, and a type by deleting its link", async () => {
    const { call, calls, sent } = await connect(typedRoutes({ meaning: 2 }));
    const result = await call("brain_update_thought", {
      brainId: BRAIN,
      thoughtId: THOUGHT,
      label: null,
      backgroundColor: null,
      typeId: null,
    });

    expect(result.isError).toBe(false);
    // One field to a request: a patch refused part way keeps what came
    // before, and does not say how far it got.
    expect(sent("PATCH")).toEqual([
      [{ op: "remove", path: "/label" }],
      [{ op: "remove", path: "/backgroundColor" }],
    ]);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
      `/api/links/${BRAIN}/${LINK}`,
    ]);
    expect(result.text).toContain("typeId = null");
  });

  it("reports an error, not success, when the type is still there afterwards", async () => {
    // What `replace /typeId null` used to do: the API said 200, the type
    // stayed, and the tool listed `typeId = null` under Done.
    vi.useFakeTimers();
    try {
      const { call, calls } = await connect(typedRoutes({ meaning: 1 }));
      const pending = call("brain_update_thought", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        typeId: null,
      });
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;

      expect(result.isError).toBe(true);
      expect(result.text).toContain("the type is still in place");
      expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says that null clears on every argument where it does", async () => {
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    const properties = tools.find((t) => t.name === "brain_update_thought")!.inputSchema
      .properties as Record<string, { description?: string }>;
    for (const name of ["label", "typeId", "foregroundColor", "backgroundColor"]) {
      expect(properties[name]?.description).toMatch(/null (clears|removes)/);
    }
  });
});

/** A brain whose home thought has the `aliases` field, or lacks it as old builds do. */
const brainRoutes = (build: { aliases: boolean }): Route[] => [
  ["GET /api/brains/", () => ({ id: BRAIN, name: "brain", homeThoughtId: PARENT })],
  ["GET /graph", () => graph(thought("parent"))],
  ["GET /api/thoughts/", () => thought("home", build.aliases ? { aliases: [] } : {})],
  ["POST /api/thoughts/", () => ({ id: THOUGHT })],
];

describe("brain_create_thought", () => {
  it("sends aliases with the create request and reports what it sent", async () => {
    const { call, sent } = await connect(brainRoutes({ aliases: true }));
    const result = await call("brain_create_thought", {
      brainId: BRAIN,
      name: "RAG",
      parentId: PARENT,
      aliases: [" Retrieval-augmented generation ", "retrieval-augmented generation"],
    });

    expect(result.isError).toBe(false);
    expect(sent("POST")).toEqual([
      expect.objectContaining({ name: "RAG", aliases: ["Retrieval-augmented generation"] }),
    ]);
    expect(result.text).toContain('aliases: ["Retrieval-augmented generation"]');
  });

  it("sends no aliases field when none were asked for", async () => {
    const { call, sent } = await connect(brainRoutes({ aliases: true }));
    await call("brain_create_thought", { brainId: BRAIN, name: "plain", parentId: PARENT });
    expect(sent("POST")[0]).not.toHaveProperty("aliases");
  });

  it("on a build without aliases it creates nothing and says which build has them", async () => {
    const { call, sent } = await connect(brainRoutes({ aliases: false }));
    const result = await call("brain_create_thought", {
      brainId: BRAIN,
      name: "RAG",
      parentId: PARENT,
      aliases: ["Retrieval"],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("15.0.621");
    expect(sent("POST")).toEqual([]);
  });
});

describe("brain_ingest", () => {
  const routes = brainRoutes({ aliases: true });

  it("on a build without aliases the plan is rejected with nothing written", async () => {
    const { call, sent } = await connect(brainRoutes({ aliases: false }));
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [{ tempId: "rag", name: "RAG", parent: PARENT, aliases: ["Retrieval"] }],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/nothing was written.*15\.0\.621/s);
    expect(sent("POST")).toEqual([]);
  });

  it("counts the thoughts given aliases, and only when the plan had any", async () => {
    const withAliases = await connect(routes);
    const result = await withAliases.call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [{ tempId: "rag", name: "RAG", parent: PARENT, aliases: ["Retrieval"] }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("thoughts given aliases: 1");

    const without = await connect(routes);
    const plain = await without.call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [{ tempId: "rag", name: "RAG", parent: PARENT }],
    });
    expect(plain.text).not.toContain("aliases");
  });

  it("a batch written whole reads as it always did: a table, the counts, the next step", async () => {
    const { call } = await connect(routes);
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [{ tempId: "rag", name: "RAG", parent: PARENT }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      [
        "## Thoughts",
        "Outcome  Title  Identifier",
        "───────  ─────  ────────────────────────────────────",
        `created  RAG    ${THOUGHT}`,
        "",
        "## Also",
        "- links created: 0",
        "- notes written: 0",
        "- tags attached: 0",
        "",
        "## Next",
        "The identifiers above work immediately. To show the result to the user, open the " +
          "root thought with brain_activate. Refresh the semantic index with brain_index " +
          "using action=sync.",
      ].join("\n"),
    );
  });
});

describe("brain_ingest when a thought fails in the middle of a batch", () => {
  const NOBODY = "99999999-0000-4000-8000-000000000009";
  const SIDE = "eeeeeeee-0000-4000-8000-000000000005";
  const TOP = "ffffffff-0000-4000-8000-000000000006";
  type Create = { name: string; sourceThoughtId?: string };

  /**
   * A brain where PARENT is an ordinary thought with no children and nobody
   * has NOBODY. As on the live API, a thought created under an identifier
   * nobody has is a 404 that says so, and the graph of one is the 403 the
   * API has for much else. `create` answers for the rest.
   */
  const routes = (create: (body: Create) => unknown, notes: () => unknown = () => 200): Route[] => [
    ["GET /api/brains/", () => ({ id: BRAIN, name: "brain", homeThoughtId: PARENT })],
    [
      "GET /graph",
      (url) => (url.pathname.includes(NOBODY) ? generic403() : graph(thought("parent"))),
    ],
    [
      "GET /api/thoughts/",
      (url) => (url.pathname.endsWith(NOBODY) ? 404 : thought("Constraints", { aliases: [] })),
    ],
    [
      "POST /api/thoughts/",
      (_url, body) => {
        const asked = body as Create;
        return asked.sourceThoughtId === NOBODY
          ? new Response(JSON.stringify(`Source Thought ${NOBODY} could not be located`), {
              status: 404,
              headers: { "content-type": "application/json" },
            })
          : create(asked);
      },
    ],
    ["POST /api/notes/", notes],
    ["POST /api/links/", () => ({ id: LINK })],
    ["GET /api/links/", () => 404],
  ];
  const made = ({ name }: Create): unknown => ({ id: name === "Top" ? TOP : SIDE });
  const plan = (topParent: string) => ({
    brainId: BRAIN,
    thoughts: [
      { tempId: "top", name: "Top", parent: topParent, note: "summary" },
      { tempId: "mid", name: "Mid", parent: "top", note: "body" },
      { tempId: "leaf", name: "Leaf", parent: "mid" },
      { tempId: "side", name: "Side", parent: PARENT },
    ],
    links: [{ from: "leaf", to: "side", name: "relates" }],
  });
  const names = (posts: unknown[]): string[] =>
    posts.flatMap((body) => ((body as Create | undefined)?.name ?? []) as string | never[]);

  it("the result is an error that lists what was written, what failed and what was skipped for it", async () => {
    // Mid and Leaf used to be created with no parent and listed as created,
    // under "Everything else was written", in a result that was no error.
    const { call, sent } = await connect(routes(made));
    const result = await call("brain_ingest", plan(NOBODY));

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      [
        "## Thoughts",
        "Outcome  Title  Identifier                            tempId",
        "───────  ─────  ────────────────────────────────────  ──────",
        `created  Side   ${SIDE}  side`,
        "",
        "## Also",
        "- links created: 0",
        "- notes written: 0",
        "- tags attached: 0",
        "",
        "## Failed",
        `- thought "Top" (top): Source Thought ${NOBODY} could not be located`,
        "",
        "## Skipped",
        '- thought "Mid" (mid): depends on "top", which was not created',
        '- thought "Leaf" (leaf): depends on "top", which was not created',
        '- link leaf -> side: depends on "top", which was not created',
        "",
        "## Next",
        "The batch was written in part, and nothing is rolled back. The thoughts in the " +
          "table exist, and their identifiers work immediately. What is under Failed and " +
          "Skipped was not written, a listed thought's note, tags and aliases included. " +
          "Fix the cause and write only that: thoughts and links in a new plan, naming " +
          "each thought of the table by its identifier in place of its tempId; a note, tag " +
          "or alias of a thought in the table with brain_set_note, brain_tag or " +
          "brain_update_thought. Do not send the whole plan again: a thought it made with " +
          "no parent would be made twice.",
      ].join("\n"),
    );
    // Asked for once and refused, and nothing was sent for what hangs on it.
    expect(names(sent("POST")).sort()).toEqual(["Side", "Top"]);
    expect(sent("POST")).toHaveLength(2);
  });

  it("with no thought written there is no table, and the plan is what to send again", async () => {
    const { call, sent } = await connect(routes(made));
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [
        { tempId: "top", name: "Top", parent: NOBODY },
        { tempId: "mid", name: "Mid", parent: "top" },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("## Thoughts");
    expect(result.text).toContain('## Skipped\n- thought "Mid" (mid): depends on "top"');
    expect(result.text).toContain(
      "## Next\nNone of the plan's thoughts was written, and nothing is rolled back. " +
        "Fix the cause and send the plan again.",
    );
    expect(names(sent("POST"))).toEqual(["Top"]);
  });

  it("a create that got no answer says the thought may be there all the same", async () => {
    // What the client makes of a timeout: the request may have reached TheBrain.
    const { call, sent } = await connect(
      routes((body) => {
        if (body.name === "Mid") throw new DOMException("timed out", "TimeoutError");
        return made(body);
      }),
    );
    const result = await call("brain_ingest", plan(PARENT));

    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      '- thought "Mid" (mid): request exceeded 30000 ms — no answer came, so TheBrain may ' +
        "have created it all the same: before creating it again, look for it next to its " +
        "parent with brain_get_thought",
    );
    expect(result.text).toContain('- thought "Leaf" (leaf): depends on "mid", which was not created');
    expect(result.text).toContain(
      "a listed thought's note, tags and aliases included, unless its line says it may have been. ",
    );
    expect(names(sent("POST"))).not.toContain("Leaf");
  });

  it("a note that fails on a thought that was created is an error too, with nothing skipped", async () => {
    const { call } = await connect(
      routes(made, () => new Response(JSON.stringify("boom"), { status: 500 })),
    );
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [{ tempId: "top", name: "Top", parent: PARENT, note: "summary" }],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(`created  Top    ${TOP}  top`);
    expect(result.text).toContain(`## Failed\n- note for "Top" (${TOP}): boom`);
    expect(result.text).not.toContain("## Skipped");
    expect(result.text).toContain("nothing is rolled back");
  });
});

describe("brain_ingest and a thought that may be there already", () => {
  const THERE = "eeeeeeee-0000-4000-8000-000000000005";
  type Lists = Partial<
    Record<"children" | "parents" | "jumps", Array<{ id: string; name: string }>>
  >;
  /** A brain where PARENT has `around` next to it; `graphOf` answers for its graph. */
  const routes = (around: Lists, graphOf?: () => unknown): Route[] => [
    ["GET /api/brains/", () => ({ id: BRAIN, name: "brain", homeThoughtId: PARENT })],
    ["GET /graph", graphOf ?? (() => ({ ...graph(thought("parent")), ...around }))],
    ["GET /api/thoughts/", () => thought("parent", { aliases: [] })],
    ["POST /api/thoughts/", () => ({ id: THOUGHT })],
  ];
  const plan = (relation: string) => ({
    brainId: BRAIN,
    thoughts: [
      { tempId: "rag", name: "RAG", parent: PARENT, relation },
      { tempId: "leaf", name: "Chunking", parent: "rag" },
    ],
  });
  const deduplicate = async (): Promise<string> => {
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    const properties = tools.find((t) => t.name === "brain_ingest")!.inputSchema
      .properties as Record<string, { description?: string }>;
    return properties["deduplicate"]!.description!;
  };

  it("a thought made as a parent or a jump is found where a graph lists it, and nothing is created", async () => {
    // Both used to be looked for among the children, and made again.
    for (const [relation, list] of [
      ["child", "children"],
      ["parent", "parents"],
      ["jump", "jumps"],
    ] as const) {
      const { call, sent } = await connect(routes({ [list]: [{ id: THERE, name: "RAG" }] }));
      const { brainId, thoughts } = plan(relation);
      const result = await call("brain_ingest", { brainId, thoughts: [thoughts[0]] });

      expect(result.isError, relation).toBe(false);
      expect(result.text, relation).toContain(`existed  RAG    ${THERE}`);
      expect(sent("POST"), relation).toEqual([]);
    }
  });

  it("one of that name under another relation is an error that names it, and nothing is created", async () => {
    // As a child it used to be listed as existing, whatever the plan asked
    // for; as a parent or a jump it was not seen, and a second was made.
    const { call, sent } = await connect(routes({ jumps: [{ id: THERE, name: "RAG" }] }));
    const result = await call("brain_ingest", plan("child"));

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("## Thoughts");
    expect(result.text).toContain(
      [
        "## Failed",
        `- thought "RAG" (rag): ${PARENT} already has a thought of this name as its jump, ` +
          `${THERE}, and the plan asks for a child. It was not taken for the same thought, ` +
          `and no second one was made. To use it, name ${THERE} where the plan has "rag"; ` +
          "to make another of that name, send this thought in a plan with deduplicate set to false",
        "",
        "## Skipped",
        '- thought "Chunking" (leaf): depends on "rag", which was not created',
      ].join("\n"),
    );
    expect(sent("POST")).toEqual([]);
  });

  it("the way out it names works: with deduplicate false the thought is made", async () => {
    const { call, sent } = await connect(routes({ jumps: [{ id: THERE, name: "RAG" }] }));
    const result = await call("brain_ingest", { ...plan("child"), deduplicate: false });

    expect(result.isError).toBe(false);
    expect(sent("POST")).toHaveLength(2);
  });

  it("a graph that cannot be read is an error, not a thought taken for new", async () => {
    // The failure used to pass for "no children", and the thought was made.
    const { call, sent } = await connect(
      routes({}, () => new Response(JSON.stringify("boom"), { status: 500 })),
    );
    const result = await call("brain_ingest", plan("child"));

    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      `## Failed\n- thought "RAG" (rag): ${PARENT} could not be read to look for a thought of ` +
        "this name next to it, so nothing was created: boom",
    );
    expect(result.text).toContain('- thought "Chunking" (leaf): depends on "rag"');
    expect(sent("POST")).toEqual([]);
  });

  it("a graph that never lists the new thought is said, after the wait, and the batch is no error", async () => {
    // A `Response` is answered as it is: this graph stays as it was read.
    const stale = (): Response =>
      new Response(JSON.stringify(graph(thought("parent"))), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    vi.useFakeTimers();
    try {
      const { call } = await connect(routes({}, stale));
      const pending = call("brain_ingest", plan("child"));
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;

      expect(result.isError).toBe(false);
      // "RAG" alone: "Chunking" hangs on a thought made here.
      expect(result.text).toContain(
        "## Not listed yet\nTheBrain does not yet list 1 of the new thoughts next to the " +
          "thoughts they were attached to. This plan sent again now would not find them and " +
          "would make them a second time: wait a few seconds first.\n\n## Next\n",
      );
      expect(result.text).not.toContain("Listing not read");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a graph that cannot be read after the writes is said as that, and not as one that lists nothing", async () => {
    // The read that failed used to count as a graph that listed nothing: the
    // result said "TheBrain does not yet list 1 of the new thoughts", and to
    // wait a few seconds, of a graph that nothing had read.
    let reads = 0;
    // Read once, to look for the thought; every read after the writes fails.
    const once = (): unknown =>
      (reads += 1) > 1
        ? new Response(JSON.stringify("boom"), { status: 500 })
        : graph(thought("parent"));
    vi.useFakeTimers();
    try {
      const { call, sent } = await connect(routes({}, once));
      const pending = call("brain_ingest", plan("child"));
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;

      // What the plan asked for is written, so the batch is no error.
      expect(result.isError).toBe(false);
      expect(sent("POST")).toHaveLength(2);
      expect(result.text).not.toContain("Not listed yet");
      expect(result.text).toContain(
        "## Listing not read\nWhether TheBrain lists the new thoughts yet could not be read " +
          "for the thoughts they were attached to:\n" +
          `- ${PARENT}, with 1 of them next to it: TheBrain failed with a 500 ` +
          `(GET /api/thoughts/${BRAIN}/${PARENT}/graph): boom. The fault is inside the app, ` +
          "not in the arguments of this call. A read is safe to repeat; before repeating a " +
          "write, check what it left.\n" +
          "No write failed by this. Before sending this plan again, read each of them with " +
          "brain_get_thought and see that it lists them: sent before that, the plan would " +
          "make them a second time.\n\n## Next\n",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("the argument says what counts as the same thought, and what becomes of a namesake", async () => {
    const description = await deduplicate();
    expect(description).toMatch(/its parent already has one of that name under the same relation/);
    expect(description).toMatch(
      /under another relation is neither reused nor made again: it fails/,
    );
  });
});

describe("a relation with nothing to relate to", () => {
  const routes: Route[] = [
    ["GET /api/brains/", () => ({ id: BRAIN, name: "brain", homeThoughtId: PARENT })],
    ["GET /graph", () => graph(thought("parent"))],
    ["GET /api/thoughts/", () => thought("parent", { aliases: [] })],
    ["POST /api/thoughts/", () => ({ id: THOUGHT })],
    ["POST /api/notes/", () => 200],
  ];

  it("brain_create_thought creates nothing and says what the relation wants", async () => {
    // It used to answer "created thought" for a thought linked to nothing.
    for (const relation of ["child", "parent", "jump"]) {
      const { call, calls } = await connect(routes);
      const result = await call("brain_create_thought", {
        brainId: BRAIN,
        name: "RAG",
        relation,
        note: "body",
      });

      expect(result.isError, relation).toBe(true);
      expect(result.text, relation).toBe(
        `relation "${relation}" says how the new thought is linked to parentId, and no ` +
          "parentId was given. Nothing was created. Pass parentId, or leave relation out " +
          "to create a thought with no link.",
      );
      expect(calls, relation).toEqual([]);
    }
  });

  it("brain_ingest rejects the plan with nothing written", async () => {
    // The thought used to be created with no link and listed as created.
    const { call, calls } = await connect(routes);
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [
        { tempId: "top", name: "Retrieval", parent: PARENT, note: "body" },
        { tempId: "rag", name: "RAG", relation: "jump" },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      'Plan rejected, nothing was written: thought "rag" has the relation "jump" and no ' +
        "parent: a relation says how a thought is linked to its parent, so name the parent " +
        "or leave the relation out. Fix it and retry.",
    );
    expect(calls).toEqual([]);
  });

  it("without a relation a thought with no parent is created, as before", async () => {
    const { call, sent } = await connect(routes);
    const created = await call("brain_create_thought", { brainId: BRAIN, name: "RAG" });
    const ingested = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [{ tempId: "rag", name: "RAG" }],
    });

    expect([created.isError, ingested.isError]).toEqual([false, false]);
    expect(sent("POST")).toHaveLength(2);
    for (const body of sent("POST")) expect(body).not.toHaveProperty("relation");
  });

  it("both arguments say so, and a plan's parent what leaving it out costs", async () => {
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    type Argument = { description?: string };
    const properties = (name: string): Record<string, Argument> =>
      tools.find((t) => t.name === name)!.inputSchema.properties as Record<string, Argument>;
    const item = (
      properties("brain_ingest")["thoughts"] as unknown as {
        items: { properties: Record<string, Argument> };
      }
    ).items.properties;

    expect(properties("brain_create_thought")["relation"]!.description).toContain(
      "Refused without parentId",
    );
    expect(item["relation"]!.description).toContain("Refused without a parent");
    expect(item["parent"]!.description).toMatch(
      /left unlinked, and a second run of the plan makes it again/,
    );
  });
});

describe("a typeId that is not a type", () => {
  const TYPE = "eeeeeeee-0000-4000-8000-000000000005";
  const TAG = "ffffffff-0000-4000-8000-000000000006";
  const NOBODY = "99999999-0000-4000-8000-000000000009";

  /**
   * A brain where PARENT is an ordinary thought, TAG a tag and TYPE a type.
   * As on the live API, a write naming any of them as a type is a 200, and
   * only the type becomes one.
   */
  const routes = (): Route[] => {
    const others: Record<string, { name: string; kind: number }> = {
      [PARENT]: { name: "Constraints", kind: 1 },
      [TAG]: { name: "gotcha", kind: 4 },
      [TYPE]: { name: "Pattern", kind: 2 },
    };
    let typeId: string | null = null;
    return [
      ["GET /api/brains/", () => ({ id: BRAIN, name: "brain", homeThoughtId: PARENT })],
      ["GET /graph", () => graph(thought("parent"))],
      [
        "GET /api/thoughts/",
        (url) => {
          const id = url.pathname.split("/").pop()!;
          if (id === THOUGHT) return thought("RAG", { typeId, aliases: [] });
          // A thought that does not exist is a 404 to this read.
          return id in others ? { ...thought("", { aliases: [] }), id, ...others[id] } : 404;
        },
      ],
      [
        "PATCH /api/thoughts/",
        (_url, body) => {
          for (const op of body as Array<{ path: string; value?: string }>) {
            if (op.path === "/typeId" && op.value === TYPE) typeId = TYPE;
          }
          return 200;
        },
      ],
      ["POST /api/thoughts/", () => ({ id: THOUGHT })],
      ["POST /api/notes/", () => 200],
      ["POST /api/links/", () => ({ id: LINK })],
    ];
  };
  const refused = [
    [PARENT, 'it is the thought "Constraints"'],
    [TAG, 'it is the tag "gotcha"'],
    [NOBODY, "no thought in this brain has that identifier"],
  ] as const;

  /** A refusal the model can act on, and not one request that writes. */
  const expectRefused = (
    result: { text: string; isError: boolean },
    calls: Array<{ method: string }>,
    typeId: string,
    what: string,
  ): void => {
    expect(result.isError, what).toBe(true);
    expect(result.text).toContain(`typeId ${typeId} is not a type: ${what}`);
    expect(result.text).toContain("Nothing was written");
    expect(result.text).toContain("brain_list_types_and_tags");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  };

  it("brain_update_thought reports an error, not success, and changes no other field", async () => {
    // It used to list `typeId = "…"` under Done. The API answers 200, makes a
    // parent or a tag of what it was given, and leaves the type as it was.
    for (const [typeId, what] of refused) {
      const { call, calls } = await connect(routes());
      const result = await call("brain_update_thought", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        name: "renamed",
        typeId,
        addAliases: ["R.A.G."],
      });
      expectRefused(result, calls, typeId, what);
    }
  });

  it("brain_update_thought refuses a thought named as its own type without a request", async () => {
    // A 200 that sets nothing, a type included, which the check of its kind
    // would let through.
    for (const id of [THOUGHT, TYPE]) {
      const { call, calls } = await connect(routes());
      const result = await call("brain_update_thought", {
        brainId: BRAIN,
        thoughtId: id,
        name: "renamed",
        typeId: id,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("a thought cannot be its own type");
      expect(result.text).toContain("Nothing was written");
      expect(calls).toEqual([]);
    }
  });

  it("brain_create_thought creates nothing", async () => {
    // Refused after the request, the thought would exist already, and a model
    // told of an error would create it again.
    for (const [typeId, what] of refused) {
      const { call, calls } = await connect(routes());
      const result = await call("brain_create_thought", {
        brainId: BRAIN,
        name: "RAG",
        parentId: PARENT,
        typeId,
        note: "body",
        tagIds: [TAG],
      });
      expectRefused(result, calls, typeId, what);
    }
  });

  it("brain_ingest writes no part of a plan that has one", async () => {
    for (const [typeId, what] of refused) {
      const { call, calls } = await connect(routes());
      const result = await call("brain_ingest", {
        brainId: BRAIN,
        thoughts: [
          { tempId: "top", name: "Retrieval", parent: PARENT, typeId: TYPE, note: "body" },
          { tempId: "rag", name: "RAG", parent: "top", typeId },
        ],
      });
      expectRefused(result, calls, typeId, what);
    }
  });

  it("a type is set, and reported as before", async () => {
    const { call, sent } = await connect(routes());
    const updated = await call("brain_update_thought", {
      brainId: BRAIN,
      thoughtId: THOUGHT,
      typeId: TYPE,
    });
    expect(updated.isError).toBe(false);
    expect(updated.text).toContain(`typeId = "${TYPE}"`);
    expect(sent("PATCH")).toEqual([[{ op: "replace", path: "/typeId", value: TYPE }]]);

    for (const [tool, args] of [
      ["brain_create_thought", { name: "RAG", parentId: PARENT, typeId: TYPE }],
      [
        "brain_ingest",
        { thoughts: [{ tempId: "rag", name: "RAG", parent: PARENT, typeId: TYPE }] },
      ],
    ] as const) {
      const fresh = await connect(routes());
      const result = await fresh.call(tool, { brainId: BRAIN, ...args });
      expect(result.isError, tool).toBe(false);
      expect(fresh.sent("POST"), tool).toEqual([expect.objectContaining({ typeId: TYPE })]);
    }
  });

  it("every argument that takes a type says where its identifier comes from", async () => {
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    const properties = (name: string): Record<string, { description?: string }> =>
      tools.find((t) => t.name === name)!.inputSchema.properties as Record<
        string,
        { description?: string }
      >;
    const item = (
      properties("brain_ingest")["thoughts"] as unknown as {
        items: { properties: Record<string, { description?: string }> };
      }
    ).items.properties;

    for (const argument of [
      properties("brain_create_thought")["typeId"],
      properties("brain_update_thought")["typeId"],
      item["typeId"],
    ]) {
      expect(argument?.description).toContain("brain_list_types_and_tags");
    }
  });
});

describe("an identifier nobody has, and a brainId that is no brain", () => {
  const TYPE = "eeeeeeee-0000-4000-8000-000000000005";
  const TAG = "ffffffff-0000-4000-8000-000000000006";
  const NOBODY = "99999999-0000-4000-8000-000000000009";

  /** The API's answers, in its own words and shapes. */
  const noBrain = (): Response =>
    new Response(JSON.stringify(`Access to brain ${BRAIN} is unauthorized.`), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  const bareNotFound = (): Response =>
    new Response(
      JSON.stringify({
        type: "https://tools.ietf.org/html/rfc9110#section-15.5.5",
        title: "Not Found",
        status: 404,
        traceId: "00-5df1-eb95-00",
      }),
      { status: 404, headers: { "content-type": "application/problem+json" } },
    );
  const said404 = (text: string): Response =>
    new Response(JSON.stringify(text), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  const catchAll = (): Response =>
    new Response(
      "To use the TheBrain API, make requests to /api (e.g. /api/brains). " +
        "An API key is required via the Authorization header.",
      { status: 403 },
    );
  const everyRequest = (answer: () => Response): Route[] =>
    ["GET", "POST", "PATCH", "DELETE"].map((method): Route => [`${method} /api/`, answer]);
  const embedder = { id: "test", dimensions: 3 } as unknown as Embedder;
  const searching = (api: TheBrainApi) => ({
    search: () => new SemanticSearch(api, new VectorStore(":memory:"), embedder),
  });

  describe("a brainId that is no brain", () => {
    // Measured: every request with such a brain in its path is this 401,
    // whatever else it names. The tools called it a rejected key.
    const told =
      `Access to brain ${BRAIN} is unauthorized. The key was accepted: it is brainId that ` +
      "names no brain open to it. Take brainId from brain_list. The other identifiers " +
      "in the call were not looked at.";

    it.each([
      ["brain_get_thought", { thoughtId: THOUGHT }],
      ["brain_traverse", { thoughtId: THOUGHT }],
      ["brain_list_types_and_tags", {}],
      ["brain_recent_changes", {}],
      ["brain_update_thought", { thoughtId: THOUGHT, name: "renamed" }],
      ["brain_update_thought", { thoughtId: THOUGHT, typeId: TYPE }],
      ["brain_create_thought", { name: "RAG" }],
      ["brain_create_thought", { name: "RAG", parentId: PARENT, typeId: TYPE, tagIds: [TAG] }],
      ["brain_set_note", { thoughtId: THOUGHT, markdown: "body" }],
      ["brain_append_note", { thoughtId: THOUGHT, markdown: "body" }],
      ["brain_link", { fromId: THOUGHT, toId: PARENT }],
      ["brain_link", { fromId: THOUGHT, toId: PARENT, relation: "parent" }],
      ["brain_tag", { thoughtId: THOUGHT, add: [TAG] }],
      ["brain_tag", { thoughtId: THOUGHT, remove: [TAG] }],
      ["brain_attach_url", { thoughtId: THOUGHT, url: "https://example.com/p" }],
      ["brain_ingest", { thoughts: [{ tempId: "rag", name: "RAG", parent: PARENT }] }],
      ["brain_ingest", { thoughts: [{ tempId: "rag", name: "RAG", typeId: TYPE }] }],
    ])("%s %j says it is the brainId, and not the key or the thought", async (tool, args) => {
      const { call } = await connect(everyRequest(noBrain));
      const result = await call(tool, { brainId: BRAIN, ...args });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(told);
    });

    it("brain_search does not answer that nothing was found", async () => {
      // With no index it asks TheBrain's search, and used to drop its refusal:
      // an empty result and a note that the index is not built.
      const { call } = await connect(everyRequest(noBrain), searching);
      const result = await call("brain_search", {
        brainId: BRAIN,
        query: "RAG",
        variants: ["retrieval"],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(told);
    });

    it("brain_search with a brainId that is no UUID is refused too, with no request", async () => {
      const { call, calls } = await connect(everyRequest(noBrain), searching);
      const result = await call("brain_search", { brainId: "my-brain", query: "RAG" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('brainId must be a UUID, got "my-brain"');
      expect(calls).toEqual([]);
    });

    it("a phrasing the search itself refuses is still only skipped", async () => {
      const { call } = await connect(
        [
          [
            "GET /api/search",
            (url) =>
              url.searchParams.get("queryText") === "RAG"
                ? [{ sourceThought: thought("RAG"), name: "RAG", isFromOtherBrain: false }]
                : 400,
          ],
        ],
        searching,
      );
      const result = await call("brain_search", {
        brainId: BRAIN,
        query: "RAG",
        variants: ["retrieval"],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain(THOUGHT);
    });
  });

  describe("an identifier nobody has", () => {
    const tail =
      " It may have been deleted, or be another brain's. " +
      "Take identifiers from brain_search or brain_get_thought.";

    it("brain_create_thought keeps the API's words for a parent nobody has", async () => {
      // It used to answer "Resource not found", with no identifier in it.
      const { call, sent } = await connect([
        ["GET /api/thoughts/", bareNotFound],
        ["POST /api/thoughts/", () => said404(`Source Thought ${NOBODY} could not be located`)],
      ]);
      const result = await call("brain_create_thought", {
        brainId: BRAIN,
        name: "RAG",
        parentId: NOBODY,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(`Source Thought ${NOBODY} could not be located.${tail}`);
      // The create is still what answers for it: the read lets it through.
      expect(sent("POST")).toHaveLength(1);
    });

    it("brain_attach_url keeps them for its thought", async () => {
      const { call } = await connect([
        ["GET /api/attachments/", () => []],
        ["GET /api/thoughts/", () => []],
        ["POST /api/attachments/", () => said404(`Thought \`${NOBODY}\` not found.`)],
      ]);
      const result = await call("brain_attach_url", {
        brainId: BRAIN,
        thoughtId: NOBODY,
        url: "https://example.com/p",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(`Thought \`${NOBODY}\` not found.${tail}`);
    });

    it("brain_update_thought names the thought a bare 404 is about", async () => {
      const { call } = await connect([["PATCH /api/thoughts/", bareNotFound]]);
      const result = await call("brain_update_thought", {
        brainId: BRAIN,
        thoughtId: NOBODY,
        name: "renamed",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        `No thought in this brain has the identifier ${NOBODY} ` +
          `(PATCH /api/thoughts/${BRAIN}/${NOBODY}).${tail}`,
      );
    });

    it("brain_get_thought does not call its graph's 403 a matter of access", async () => {
      // The read of such a thought is a 404; its graph, the API's catch-all.
      const { call } = await connect([
        ["GET /graph", catchAll],
        ["GET /api/notes", () => noNote],
      ]);
      const result = await call("brain_get_thought", { brainId: BRAIN, thoughtId: NOBODY });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        "TheBrain answered 403 and named no cause " +
          `(GET /api/thoughts/${BRAIN}/${NOBODY}/graph). That is its answer when an ` +
          `identifier in the call names nothing in this brain.${tail}`,
      );
    });

    it("a 403 where a kind is read is not taken for a thought nobody has", async () => {
      // Only the read's own 404 is. Read as one, the 403 would call a type no
      // type, and let a type through as a parent for the API to set.
      for (const [tool, args] of [
        ["brain_update_thought", { thoughtId: THOUGHT, typeId: TYPE }],
        ["brain_create_thought", { name: "RAG", parentId: PARENT, tagIds: [TAG] }],
        ["brain_link", { fromId: THOUGHT, toId: TYPE, relation: "parent" }],
      ] as const) {
        const { call, calls } = await connect([["GET /api/thoughts/", catchAll]]);
        const result = await call(tool, { brainId: BRAIN, ...args });
        expect(result.isError, tool).toBe(true);
        expect(result.text, tool).toMatch(/^TheBrain answered 403 and named no cause/);
        expect(result.text, tool).not.toMatch(/is not a t|no thought in this brain/);
        expect(calls.filter((c) => c.method !== "GET"), tool).toEqual([]);
      }
    });
  });
});

describe("brain_search when TheBrain's search does not answer", () => {
  const OTHER = "abababab-0000-4000-8000-000000000007";
  const SEARCH = `GET /api/search/${BRAIN}`;

  const hit = (id: string, name: string) => ({
    sourceThought: thought(name, { id }),
    name,
    isFromOtherBrain: false,
  });
  /** What the search finds for each phrasing; one it has no entry for finds nothing. */
  const finds: Record<string, unknown[]> = {
    RAG: [hit(THOUGHT, "RAG")],
    retrieval: [hit(THOUGHT, "RAG"), hit(OTHER, "Retrieval")],
  };
  const answers = (url: URL): unknown => finds[url.searchParams.get("queryText") ?? ""] ?? [];

  const embedder: Embedder = {
    id: "fake@v1",
    dimensions: 2,
    embedDocuments: async (texts) => texts.map(() => new Float32Array([1, 0])),
    embedQuery: async () => new Float32Array([1, 0]),
  };
  /** The package that is not installed: its id and size are known, and nothing embeds. */
  const absent: Embedder = {
    ...embedder,
    embedQuery: async () => {
      throw new EmbedderUnavailableError();
    },
  };
  const indexed = (): VectorStore => {
    const store = new VectorStore(":memory:");
    store.setMeta({
      brainId: BRAIN,
      model: indexModelId(embedder.id),
      dimensions: embedder.dimensions,
      syncedThrough: "2026-10-10T00:00:00.000Z",
    });
    store.upsert([
      {
        thoughtId: OTHER,
        name: "Embeddings",
        kind: 1,
        contentHash: "h",
        vector: new Float32Array([1, 0]),
      },
    ]);
    return store;
  };
  const searching =
    (store: VectorStore = new VectorStore(":memory:"), with_: Embedder = embedder) =>
    (api: TheBrainApi) => ({ search: () => new SemanticSearch(api, store, with_) });

  /** The API's answers, and fetch's own failures, as the client meets them. */
  const text = (status: number, body: string): Response =>
    new Response(body, { status, headers: { "content-type": "text/plain" } });
  const refusedConnection = (): never => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11522"), {
        code: "ECONNREFUSED",
      }),
    });
  };
  const droppedConnection = (): never => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
  };
  const timedOut = (): never => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };

  const NOT_INDEXED =
    "## Warning\n" +
    "Semantic search unavailable: the semantic index has not been built yet — run a rebuild. " +
    "Fell back to substring name search, so recall is lower. " +
    "Build the index with the brain_index tool.";
  const NOTHING_SEARCHED =
    "Nothing was searched, and this is no answer about what the brain holds";
  const RUNNING = " Check that the TheBrain desktop app is running and its local API is enabled.";
  const FAULT =
    " The fault is inside the app, not in the arguments of this call. A read is safe to " +
    "repeat; before repeating a write, check what it left.";

  describe("with no index, and no phrasing answered", () => {
    // Each of these read as an empty result: the warning about the index and
    // nothing else, from a search that never ran.
    it.each<[string, () => unknown, string]>([
      [
        "a key TheBrain rejects",
        () => text(401, "Invalid API Key"),
        "TheBrain rejected the key. Check THEBRAIN_API_KEY: find it under " +
          "Settings > User > Local API Key.",
      ],
      [
        "nothing listening",
        refusedConnection,
        `${NOTHING_SEARCHED}: could not reach http://localhost:11522 or http://localhost:8001 ` +
          `— is TheBrain running?${RUNNING} Each of the 2 phrasings failed this way.`,
      ],
      [
        "a connection that drops",
        droppedConnection,
        `${NOTHING_SEARCHED}: could not reach http://localhost:11522 — is TheBrain running?` +
          `${RUNNING} Each of the 2 phrasings failed this way.`,
      ],
      [
        "no answer in time",
        timedOut,
        `${NOTHING_SEARCHED}: request exceeded 30000 ms.${RUNNING} ` +
          "Each of the 2 phrasings failed this way.",
      ],
      [
        "a 500",
        () => text(500, "Internal Server Error"),
        `${NOTHING_SEARCHED}: TheBrain failed with a 500 (${SEARCH}): Internal Server Error.` +
          `${FAULT} Each of the 2 phrasings failed this way.`,
      ],
      [
        "a 503 with no body",
        () => text(503, ""),
        `${NOTHING_SEARCHED}: TheBrain failed with a 503 (${SEARCH}): (empty response).` +
          `${FAULT} Each of the 2 phrasings failed this way.`,
      ],
    ])("%s is an error that says so, not an empty result", async (_what, answer, told) => {
      const { call } = await connect([["GET /api/search", answer]], searching());
      const result = await call("brain_search", {
        brainId: BRAIN,
        query: "RAG",
        variants: ["retrieval"],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(told);
    });

    it("a query alone that fails is told once, with no count of phrasings", async () => {
      const { call } = await connect([["GET /api/search", () => text(500, "boom")]], searching());
      const result = await call("brain_search", { brainId: BRAIN, query: "RAG" });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        `${NOTHING_SEARCHED}: TheBrain failed with a 500 (${SEARCH}): boom.${FAULT}`,
      );
    });

    it("phrasings that fail each in its own way are listed, each with its reason", async () => {
      const passage = `${"retrieval ".repeat(599)}retrieval`;
      const { call } = await connect(
        [
          [
            "GET /api/search",
            (url) => (url.searchParams.get("queryText") === "RAG" ? text(500, "boom") : 403),
          ],
        ],
        searching(),
      );
      const result = await call("brain_search", {
        brainId: BRAIN,
        query: "RAG",
        variants: [passage],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        `${NOTHING_SEARCHED}. Each of the 2 phrasings failed:\n` +
          `- "RAG": TheBrain failed with a 500 (${SEARCH}): boom.${FAULT}\n` +
          // A passage given for a phrasing is not sent back whole.
          `- "${passage.slice(0, 60)}…" (5999 characters): the search text is 600 words, ` +
          "and TheBrain's search answers a 403 that names no cause to one of 513 to " +
          "1,024 words. Shorten it.",
      );
    });

    it("a query and variants that are all empty are refused, and nothing is asked", async () => {
      // No request went out, and the result was the same empty one.
      const { call, calls } = await connect([["GET /api/search", answers]], searching());
      const result = await call("brain_search", {
        brainId: BRAIN,
        query: "  ",
        variants: ["", " "],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        "query is empty, and so is every variant: there is nothing to search for. " +
          "Say what you are looking for in query.",
      );
      expect(calls).toEqual([]);
    });
  });

  describe("with no index, and some phrasings answered", () => {
    /** The search answers every phrasing but those `failing` names. */
    const partly = (failing: Record<string, () => unknown>): Route[] => [
      [
        "GET /api/search",
        (url) => (failing[url.searchParams.get("queryText") ?? ""] ?? (() => answers(url)))(),
      ],
    ];

    it("the hits are given, and the phrasing that was not searched is named", async () => {
      // It was skipped in silence, and "not found" read as certain.
      const { call } = await connect(
        partly({ embeddings: () => text(500, "Internal Server Error") }),
        searching(),
      );
      const result = await call("brain_search", {
        brainId: BRAIN,
        query: "RAG",
        variants: ["retrieval", "embeddings"],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toBe(
        "## Found by substring\n" +
          "Score  Thought    Identifier                            Matched\n" +
          "─────  ─────────  ────────────────────────────────────  ─────────\n" +
          `2.000  RAG        ${THOUGHT}  RAG\n` +
          `0.500  Retrieval  ${OTHER}  retrieval\n\n` +
          "## Not searched\n" +
          "1 of 3 phrasings got no answer from TheBrain's search, so this result is from " +
          "the other 2 only:\n" +
          `- "embeddings": TheBrain failed with a 500 (${SEARCH}): Internal Server Error.` +
          `${FAULT}\n\n${NOT_INDEXED}`,
      );
    });

    it("nothing found by the phrasings that were answered is said of those only", async () => {
      const { call } = await connect(
        partly({ RAG: timedOut, retrieval: () => 414 }),
        searching(),
      );
      const result = await call("brain_search", {
        brainId: BRAIN,
        query: "RAG",
        variants: ["retrieval", "nothing has this"],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toBe(
        "## Found by substring\n" +
          "Nothing: TheBrain's search matched no thought for the one phrasing it answered.\n\n" +
          "## Not searched\n" +
          "2 of 3 phrasings got no answer from TheBrain's search, so this result is from " +
          "the other one only:\n" +
          `- "RAG": request exceeded 30000 ms.${RUNNING}\n` +
          '- "retrieval": the search text is too long for one request: 9 characters, ' +
          "9 bytes as the URL carries them, where TheBrain takes about 8,000 (a Cyrillic " +
          `letter is 6 of them, a CJK character 9). Shorten it.\n\n${NOT_INDEXED}`,
      );
    });

    it("of four phrasings two answered and found nothing: it says of how many", async () => {
      const { call } = await connect(
        partly({ RAG: () => text(500, "boom"), retrieval: () => text(500, "boom") }),
        searching(),
      );
      const result = await call("brain_search", {
        brainId: BRAIN,
        query: "RAG",
        variants: ["retrieval", "nothing has this", "nor this"],
      });
      expect(result.text).toContain(
        "## Found by substring\n" +
          "Nothing: TheBrain's search matched no thought for any of the 2 phrasings it answered.",
      );
      expect(result.text).toContain("2 of 4 phrasings got no answer");
      expect(result.text).toContain("so this result is from the other 2 only");
    });

    it("a key TheBrain rejects stops the search whatever else answered", async () => {
      const { call } = await connect(
        partly({ retrieval: () => text(401, "Invalid API Key") }),
        searching(),
      );
      const result = await call("brain_search", {
        brainId: BRAIN,
        query: "RAG",
        variants: ["retrieval"],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^TheBrain rejected the key\./);
    });
  });

  describe("with no index, and every phrasing answered", () => {
    it("a result with hits reads as it did, to the character", async () => {
      const { call } = await connect([["GET /api/search", answers]], searching());
      const result = await call("brain_search", {
        brainId: BRAIN,
        query: "RAG",
        variants: ["retrieval"],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toBe(
        "## Found by substring\n" +
          "Score  Thought    Identifier                            Matched\n" +
          "─────  ─────────  ────────────────────────────────────  ─────────\n" +
          `2.000  RAG        ${THOUGHT}  RAG\n` +
          `0.500  Retrieval  ${OTHER}  retrieval\n\n${NOT_INDEXED}`,
      );
    });

    it.each<[string[], string]>([
      [[], "Nothing: TheBrain's search matched no thought."],
      [
        ["nor this", "NOR THIS", ""],
        "Nothing: TheBrain's search matched no thought for any of the 2 phrasings.",
      ],
    ])("nothing found is said in words, variants %j", async (variants, said) => {
      // It was the warning alone, which is also all a search that failed printed.
      const { call, calls } = await connect([["GET /api/search", answers]], searching());
      const result = await call("brain_search", {
        brainId: BRAIN,
        query: "nothing has this",
        variants,
      });
      expect(result.isError).toBe(false);
      expect(result.text).toBe(`## Found by substring\n${said}\n\n${NOT_INDEXED}`);
      // A duplicate and an empty variant are not phrasings: neither is asked, or counted.
      expect(calls).toHaveLength(variants.length === 0 ? 1 : 2);
    });
  });

  describe("with an index", () => {
    it("ranking by vectors makes no request, so nothing TheBrain answers reaches it", async () => {
      const { call, calls } = await connect(
        [["GET /api/", () => text(500, "Internal Server Error")]],
        searching(indexed()),
      );
      const result = await call("brain_search", {
        brainId: BRAIN,
        query: "RAG",
        variants: ["retrieval"],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toBe(
        "## Found by meaning\n" +
          "Score  Thought     Identifier                            Matched\n" +
          "─────  ──────────  ────────────────────────────────────  ───────\n" +
          `1.000  Embeddings  ${OTHER}`,
      );
      expect(calls).toEqual([]);
    });

    it("an empty query is refused there as well", async () => {
      const { call } = await connect([], searching(indexed()));
      const result = await call("brain_search", { brainId: BRAIN, query: "" });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^query is empty, and so is every variant/);
    });

    it("without the embeddings package it still falls back, and says why", async () => {
      const { call } = await connect([["GET /api/search", answers]], searching(indexed(), absent));
      const result = await call("brain_search", { brainId: BRAIN, query: "RAG" });
      expect(result.isError).toBe(false);
      expect(result.text).toContain(`1.000  RAG      ${THOUGHT}  RAG`);
      expect(result.text).toContain("## Found by substring");
      expect(result.text).toContain(
        "Semantic search unavailable: semantic search is off: the @huggingface/transformers " +
          "package is not installed.",
      );
      expect(result.text).not.toContain("## Not searched");
    });

    it("without the package, TheBrain not answering is the error and not the package", async () => {
      const { call } = await connect(
        [["GET /api/search", refusedConnection]],
        searching(indexed(), absent),
      );
      const result = await call("brain_search", { brainId: BRAIN, query: "RAG" });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        `${NOTHING_SEARCHED}: could not reach http://localhost:11522 or ` +
          `http://localhost:8001 — is TheBrain running?${RUNNING}`,
      );
    });
  });
});

describe("brain_index and a brain it has not been shown", () => {
  const BRAINS = `GET /api/brains/${BRAIN}`;

  class FakeEmbedder implements Embedder {
    readonly id = "fake@v1";
    readonly dimensions = 2;
    async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
      return texts.map(() => new Float32Array([1, 0]));
    }
    async embedQuery(): Promise<Float32Array> {
      return new Float32Array([1, 0]);
    }
  }
  /** The package that is not installed: nothing embeds. */
  class AbsentEmbedder extends FakeEmbedder {
    override async embedDocuments(): Promise<Float32Array[]> {
      throw new EmbedderUnavailableError();
    }
  }

  /** The index is opened through this, and `opened` counts how often. */
  const indexing = (store: VectorStore, embedder: Embedder = new FakeEmbedder()) => {
    const opened = { count: 0 };
    const context = (api: TheBrainApi) => ({
      indexer: () => {
        opened.count += 1;
        return new SemanticIndexer(api, store, embedder);
      },
    });
    return { context, opened };
  };

  /** A brain of one thought, as a rebuild reads it. */
  const brain: Route[] = [
    ["GET /modifications", () => []],
    ["GET /api/brains/", () => ({ id: BRAIN, name: "Test brain", homeThoughtId: THOUGHT })],
    ["GET /graph", () => graph(thought("RAG"))],
  ];
  const noBrain = (): Response =>
    new Response(JSON.stringify(`Access to brain ${BRAIN} is unauthorized.`), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  const text = (status: number, body: string): Response =>
    new Response(body, { status, headers: { "content-type": "text/plain" } });

  const ACTIONS = ["status", "rebuild", "sync"] as const;
  const REBUILD = "## What to do\nCall this tool with action=rebuild.";
  const status = (lines: string[]): string =>
    `## Index status\n- brain: Test brain\n${lines.map((l) => `- ${l}`).join("\n")}`;

  describe("a brainId that is no brain", () => {
    it.each(ACTIONS)("%s says so, with one request and the index not opened", async (action) => {
      // status made no request, and answered "built: no" and to call rebuild.
      const { context, opened } = indexing(new VectorStore(":memory:"));
      const { call, calls } = await connect([["GET /api/", noBrain]], context);
      const result = await call("brain_index", { brainId: BRAIN, action });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        `Access to brain ${BRAIN} is unauthorized. The key was accepted: it is brainId that ` +
          "names no brain open to it. Take brainId from brain_list. The other identifiers " +
          "in the call were not looked at.",
      );
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([BRAINS]);
      expect(opened.count).toBe(0);
    });

    it.each(ACTIONS)("%s refuses one that is no UUID with no request at all", async (action) => {
      const { context, opened } = indexing(new VectorStore(":memory:"));
      const { call, calls } = await connect(brain, context);
      const result = await call("brain_index", { brainId: "my-brain", action });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('brainId must be a UUID, got "my-brain"');
      expect(calls).toEqual([]);
      expect(opened.count).toBe(0);
    });
  });

  describe("status when TheBrain does not answer for the brain", () => {
    // It answered all of these "built: no", and to call rebuild.
    it.each<[string, () => unknown, string]>([
      [
        "a key TheBrain rejects",
        () => text(401, "Invalid API Key"),
        "TheBrain rejected the key. Check THEBRAIN_API_KEY: find it under " +
          "Settings > User > Local API Key.",
      ],
      [
        "nothing listening",
        () => {
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
          });
        },
        "could not reach http://localhost:11522 or http://localhost:8001 — is TheBrain " +
          "running? Check that the TheBrain desktop app is running and its local API is enabled.",
      ],
      [
        "a 500",
        () => text(500, "Internal Server Error"),
        `TheBrain failed with a 500 (${BRAINS}): Internal Server Error. The fault is inside ` +
          "the app, not in the arguments of this call. A read is safe to repeat; before " +
          "repeating a write, check what it left.",
      ],
    ])("%s is the answer, and nothing is said of an index", async (_what, answer, told) => {
      const { context, opened } = indexing(new VectorStore(":memory:"));
      const { call } = await connect([["GET /api/", answer]], context);
      const result = await call("brain_index", { brainId: BRAIN, action: "status" });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(told);
      expect(result.text).not.toMatch(/built|rebuild/);
      expect(opened.count).toBe(0);
    });
  });

  describe("status of a brain that is there", () => {
    const fake = new FakeEmbedder();
    const meta = {
      brainId: BRAIN,
      model: indexModelId(fake.id),
      dimensions: fake.dimensions,
      syncedThrough: null,
    };
    const vector = {
      thoughtId: THOUGHT,
      name: "RAG",
      kind: 1,
      contentHash: "h",
      vector: new Float32Array([1, 0]),
    };
    const ask = async (store: VectorStore): Promise<string> => {
      const { call, calls } = await connect(brain, indexing(store).context);
      const result = await call("brain_index", { brainId: BRAIN, action: "status" });
      expect(result.isError).toBe(false);
      // The brain is asked for, and nothing else.
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([BRAINS]);
      return result.text;
    };

    it("names the brain, and with no index says to build one", async () => {
      expect(await ask(new VectorStore(":memory:"))).toBe(
        `${status([
          "built: no",
          "usable: no",
          "thoughts indexed: 0",
          "model: —",
          "synced through: —",
        ])}\n\n${REBUILD}`,
      );
    });

    it("an index that was built and holds thoughts needs nothing done", async () => {
      const store = new VectorStore(":memory:");
      store.setMeta({ ...meta, syncedThrough: "2026-10-10T20:00:00.000Z" });
      store.upsert([vector]);
      expect(await ask(store)).toBe(
        status([
          "built: yes",
          "usable: yes",
          "thoughts indexed: 1",
          "model: fake@v1#doc3",
          "synced through: 2026-10-10T20:00:00.000Z",
        ]),
      );
    });

    it("a build that never finished is not called built, or usable", async () => {
      // A rebuild writes its metadata first. One that failed after that read
      // "built: yes, usable: yes" with no thought indexed, and nothing to do.
      const store = new VectorStore(":memory:");
      store.setMeta(meta);
      expect(await ask(store)).toBe(
        `${status([
          "built: no — a build was started and did not finish",
          "usable: no",
          "thoughts indexed: 0",
          "model: fake@v1#doc3",
          "synced through: —",
        ])}\n\n${REBUILD}`,
      );
    });

    it("an unfinished build that got some thoughts in is what search ranks by, and is to be rebuilt", async () => {
      const store = new VectorStore(":memory:");
      store.setMeta(meta);
      store.upsert([vector]);
      const said = await ask(store);
      expect(said).toContain(
        "- built: no — a build was started and did not finish\n- usable: yes\n",
      );
      expect(said).toContain(REBUILD);
    });

    it("an index built with another model is built, and not usable", async () => {
      const store = new VectorStore(":memory:");
      store.setMeta({ ...meta, model: "other@v2#doc3", syncedThrough: "2026-10-10T20:00:00.000Z" });
      store.upsert([vector]);
      const said = await ask(store);
      expect(said).toContain("- built: yes\n- usable: no\n- thoughts indexed: 1\n");
      expect(said).toContain(REBUILD);
    });
  });

  describe("a rebuild", () => {
    it("asks for the brain first, then builds", async () => {
      const store = new VectorStore(":memory:");
      const { call, calls } = await connect(brain, indexing(store).context);
      const result = await call("brain_index", { brainId: BRAIN, action: "rebuild" });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("## Index built\n- thoughts encoded: 1\n");
      expect(`${calls[0]!.method} ${calls[0]!.path}`).toBe(BRAINS);
      expect(store.size()).toBe(1);
    });

    it("says so when it gave a row its kind and encoded nothing, and only then", async () => {
      // A thought turned into a tag has the document it had. Its row is not
      // encoded again, and is not unchanged either: it was reported as skipped.
      const store = new VectorStore(":memory:");
      const first = await connect(brain, indexing(store).context);
      const built = await first.call("brain_index", { brainId: BRAIN, action: "rebuild" });
      expect(built.text).toContain("- thoughts encoded: 1\n- skipped unchanged: 0\n");

      const turned: Route[] = [
        ["GET /modifications", () => []],
        ["GET /api/brains/", () => ({ id: BRAIN, name: "Test brain", homeThoughtId: THOUGHT })],
        ["GET /graph", () => graph(thought("RAG", { kind: 4 }))],
      ];
      const second = await connect(turned, indexing(store).context);
      const rebuilt = await second.call("brain_index", { brainId: BRAIN, action: "rebuild" });
      expect(rebuilt.isError).toBe(false);
      expect(rebuilt.text).toContain(
        "## Index built\n- thoughts encoded: 0\n- kind updated, nothing to encode: 1\n" +
          "- skipped unchanged: 0\n- removed from index: 0\n",
      );
      expect(store.kinds()).toEqual(new Map([[THOUGHT, 4]]));

      const again = await second.call("brain_index", { brainId: BRAIN, action: "rebuild" });
      expect(again.text).toContain("- thoughts encoded: 0\n- skipped unchanged: 1\n");
    });

    it("without the embeddings package it fails with the reason, and status does not call it built", async () => {
      const store = new VectorStore(":memory:");
      const { call } = await connect(brain, indexing(store, new AbsentEmbedder()).context);
      const rebuilt = await call("brain_index", { brainId: BRAIN, action: "rebuild" });
      expect(rebuilt.isError).toBe(true);
      expect(rebuilt.text).toMatch(/@huggingface\/transformers package is not installed/);

      const after = await call("brain_index", { brainId: BRAIN, action: "status" });
      expect(after.isError).toBe(false);
      expect(after.text).toBe(
        `${status([
          "built: no — a build was started and did not finish",
          "usable: no",
          "thoughts indexed: 0",
          "model: fake@v1#doc3",
          "synced through: —",
        ])}\n\n${REBUILD}`,
      );
    });
  });
});

describe("an identifier that is not a tag", () => {
  const TYPE = "eeeeeeee-0000-4000-8000-000000000005";
  const TAG = "ffffffff-0000-4000-8000-000000000006";
  const NOBODY = "99999999-0000-4000-8000-000000000009";

  /**
   * A brain where PARENT is an ordinary thought, TAG a tag and TYPE a type,
   * and `link` is what joins THOUGHT to whichever of them is asked about. As
   * on the live API, a link posted towards any of them is a 200, and a delete
   * takes any link it is given.
   */
  const routes = (link: Record<string, unknown> | null = null): Route[] => {
    const others: Record<string, { name: string; kind: number }> = {
      [THOUGHT]: { name: "RAG", kind: 1 },
      [PARENT]: { name: "Constraints", kind: 1 },
      [TAG]: { name: "gotcha", kind: 4 },
      [TYPE]: { name: "Pattern", kind: 2 },
    };
    return [
      ["GET /api/brains/", () => ({ id: BRAIN, name: "brain", homeThoughtId: PARENT })],
      ["GET /graph", () => graph(thought("parent"))],
      [
        "GET /api/thoughts/",
        (url) => {
          const id = url.pathname.split("/").pop()!;
          // A thought that does not exist is a 404 to this read.
          return id in others ? { ...thought("", { aliases: [] }), id, ...others[id] } : 404;
        },
      ],
      ["POST /api/thoughts/", () => ({ id: THOUGHT })],
      ["POST /api/notes/", () => 200],
      ["POST /api/links/", () => ({ id: LINK })],
      ["GET /api/links/", () => (link === null ? 404 : { id: LINK, ...link })],
      ["DELETE /api/links/", () => 200],
    ];
  };
  const typeLink = { thoughtIdA: TYPE, thoughtIdB: THOUGHT, relation: 1, meaning: 2 };
  const parentLink = { thoughtIdA: PARENT, thoughtIdB: THOUGHT, relation: 1, meaning: 1 };
  const tagLink = { thoughtIdA: TAG, thoughtIdB: THOUGHT, relation: 1, meaning: 5 };
  const refused = [
    [TYPE, 'it is the type "Pattern"', typeLink],
    [PARENT, 'it is the thought "Constraints"', parentLink],
    [NOBODY, "no thought in this brain has that identifier", null],
  ] as const;

  /** A refusal the model can act on, and not one request that writes. */
  const expectRefused = (
    result: { text: string; isError: boolean },
    calls: Array<{ method: string }>,
    tagId: string,
    what: string,
  ): void => {
    expect(result.isError, what).toBe(true);
    expect(result.text).toContain(`tagId ${tagId} is not a tag: ${what}`);
    expect(result.text).toContain("Nothing was written");
    expect(result.text).toContain("brain_list_types_and_tags");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  };

  it("brain_tag attaches nothing, the tag listed ahead of it included", async () => {
    // It used to answer "attached". The API takes the request with a 200, and
    // sets the thought's type or gives it one more parent.
    for (const [tagId, what] of refused) {
      const { call, calls } = await connect(routes());
      const result = await call("brain_tag", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        add: [TAG, tagId],
      });
      expectRefused(result, calls, tagId, what);
    }
  });

  it("brain_tag removes nothing: a type's link and a parent's stay", async () => {
    // It used to delete whatever link it found between the two, and answer
    // "removed".
    for (const [tagId, what, link] of refused) {
      const { call, calls } = await connect(routes(link));
      const result = await call("brain_tag", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        add: [TAG],
        remove: [tagId],
      });
      expectRefused(result, calls, tagId, what);
    }
  });

  it("brain_tag leaves a link to a tag that does not carry the tag", async () => {
    // A jump between the thought and a tag: the tag is not on the thought.
    const jump = { thoughtIdA: THOUGHT, thoughtIdB: TAG, relation: 3, meaning: 1 };
    const { call, calls } = await connect(routes(jump));
    const result = await call("brain_tag", { brainId: BRAIN, thoughtId: THOUGHT, remove: [TAG] });
    expect(result.isError).toBe(false);
    expect(result.text).toContain(`tag ${TAG} was not on the thought`);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("brain_tag refuses a thought named as its own tag without a request", async () => {
    // A 200 with an identifier of zeros and no link, a tag included, which
    // the check of its kind would let through.
    for (const id of [THOUGHT, TAG]) {
      const { call, calls } = await connect(routes());
      const result = await call("brain_tag", { brainId: BRAIN, thoughtId: id, add: [id] });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("a thought cannot be its own tag");
      expect(result.text).toContain("Nothing was written");
      expect(calls).toEqual([]);
    }
  });

  it("brain_create_thought creates nothing", async () => {
    // Refused after the create, the thought would exist already, and a model
    // told of an error would create it again.
    for (const [tagId, what] of refused) {
      const { call, calls } = await connect(routes());
      const result = await call("brain_create_thought", {
        brainId: BRAIN,
        name: "RAG",
        parentId: PARENT,
        note: "body",
        tagIds: [TAG, tagId],
      });
      expectRefused(result, calls, tagId, what);
    }
  });

  it("brain_ingest writes no part of a plan that has one, or a tempId for a tag", async () => {
    for (const [tagId, what] of refused) {
      const { call, calls } = await connect(routes());
      const result = await call("brain_ingest", {
        brainId: BRAIN,
        thoughts: [
          { tempId: "top", name: "Retrieval", parent: PARENT, tagIds: [TAG], note: "body" },
          { tempId: "rag", name: "RAG", parent: "top", tagIds: [tagId] },
        ],
      });
      expectRefused(result, calls, tagId, what);
    }

    // A plan cannot make a tag, so a tag is never one of its own thoughts.
    const { call, calls } = await connect(routes());
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [
        { tempId: "top", name: "Retrieval", parent: PARENT },
        { tempId: "rag", name: "RAG", parent: "top", tagIds: ["top"] },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('tagId must be a UUID, got "top"');
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("a tag is attached and removed, and reported as before", async () => {
    const { call, calls, sent } = await connect(routes(tagLink));
    const result = await call("brain_tag", {
      brainId: BRAIN,
      thoughtId: THOUGHT,
      add: [TAG],
      remove: [TAG],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain(`attached ${TAG}`);
    expect(result.text).toContain(`removed ${TAG}`);
    expect(sent("POST")).toEqual([{ thoughtIdA: THOUGHT, thoughtIdB: TAG, relation: 2 }]);
    // Each tag is read ahead of the first write, and `attachTag` reads its own
    // once more.
    const tag = `GET /api/thoughts/${BRAIN}/${TAG}`;
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      tag,
      tag,
      tag,
      `POST /api/links/${BRAIN}`,
      `GET /api/links/${BRAIN}/${THOUGHT}/${TAG}`,
      `DELETE /api/links/${BRAIN}/${LINK}`,
    ]);

    for (const [tool, args] of [
      ["brain_create_thought", { name: "RAG", parentId: PARENT, tagIds: [TAG] }],
      [
        "brain_ingest",
        { thoughts: [{ tempId: "rag", name: "RAG", parent: PARENT, tagIds: [TAG] }] },
      ],
    ] as const) {
      const fresh = await connect(routes());
      const made = await fresh.call(tool, { brainId: BRAIN, ...args });
      expect(made.isError, tool).toBe(false);
      expect(made.text, tool).toContain("tags attached: 1");
      expect(fresh.sent("POST").at(-1), tool).toEqual({
        thoughtIdA: THOUGHT,
        thoughtIdB: TAG,
        relation: 2,
      });
    }
  });

  it("every argument that takes tags says where their identifiers come from", async () => {
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    const tool = (name: string) => tools.find((t) => t.name === name)!;
    const properties = (name: string): Record<string, { description?: string }> =>
      tool(name).inputSchema.properties as Record<string, { description?: string }>;
    const item = (
      properties("brain_ingest")["thoughts"] as unknown as {
        items: { properties: Record<string, { description?: string }> };
      }
    ).items.properties;

    for (const text of [
      properties("brain_create_thought")["tagIds"]?.description,
      item["tagIds"]?.description,
      // Its two lists share the sentence in the tool's own description.
      tool("brain_tag").description,
    ]) {
      expect(text).toContain("brain_list_types_and_tags");
    }
  });
});

describe("a type named as a parent", () => {
  const TYPE = "eeeeeeee-0000-4000-8000-000000000005";
  const TAG = "ffffffff-0000-4000-8000-000000000006";

  /**
   * A brain where PARENT and THOUGHT are ordinary thoughts, TAG a tag and
   * TYPE a type, and `link` is what joins the two thoughts a call names. As
   * on the live API, a thought created under any of them and a link posted
   * towards any of them is a 200: under the type that is the type, set or
   * replaced.
   */
  const routes = (link: Record<string, unknown> | null = null): Route[] => {
    const others: Record<string, { name: string; kind: number }> = {
      [PARENT]: { name: "Constraints", kind: 1 },
      [THOUGHT]: { name: "RAG", kind: 1 },
      [TAG]: { name: "gotcha", kind: 4 },
      [TYPE]: { name: "Pattern", kind: 2 },
    };
    return [
      ["GET /api/brains/", () => ({ id: BRAIN, name: "brain", homeThoughtId: PARENT })],
      ["GET /graph", () => graph(thought("parent"))],
      [
        "GET /api/thoughts/",
        (url) => {
          const id = url.pathname.split("/").pop()!;
          return id in others ? { ...thought("", { aliases: [] }), id, ...others[id] } : 404;
        },
      ],
      ["POST /api/thoughts/", () => ({ id: THOUGHT })],
      ["POST /api/notes/", () => 200],
      ["POST /api/links/", () => ({ id: LINK })],
      ["GET /api/links/", () => (link === null ? 404 : { id: LINK, ...link })],
      ["PATCH /api/links/", () => 200],
    ];
  };
  const typeLink = { thoughtIdA: TYPE, thoughtIdB: THOUGHT, relation: 1, meaning: 2 };
  const read = (id: string): string => `GET /api/thoughts/${BRAIN}/${id}`;
  const sequence = (calls: Array<{ method: string; path: string }>): string[] =>
    calls.map((c) => `${c.method} ${c.path}`);

  /** A refusal the model can act on, and not one request that writes. */
  const expectRefused = (
    result: { text: string; isError: boolean },
    calls: Array<{ method: string }>,
    field: string,
  ): void => {
    expect(result.isError, field).toBe(true);
    expect(result.text).toContain(`${field} ${TYPE} cannot be a parent: it is the type "Pattern"`);
    expect(result.text).toContain("Nothing was written");
    // Both ways out: the argument that sets a type, and a parent that is one.
    expect(result.text).toMatch(/typeId to brain_update_thought or brain_create_thought/);
    expect(result.text).toContain("an ordinary thought");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  };

  it("brain_link refuses a parent or child link with a type above, at the cost of one read", async () => {
    // It used to answer "link created". The API takes the request with a 200
    // and makes the type the thought's own, in place of the one it had.
    for (const [args, field] of [
      [{ fromId: THOUGHT, toId: TYPE, relation: "parent" }, "toId"],
      [{ fromId: TYPE, toId: THOUGHT, relation: "child" }, "fromId"],
    ] as const) {
      const { call, calls } = await connect(routes());
      const result = await call("brain_link", { brainId: BRAIN, ...args, name: "is a" });
      expectRefused(result, calls, field);
      expect(sequence(calls)).toEqual([read(TYPE)]);
    }
  });

  it("brain_link refuses it whatever is between the two already, and labels nothing", async () => {
    // The answer does not depend on what the brain holds: the type's own
    // link used to be given the label and reported as a link that existed.
    const { call, calls } = await connect(routes(typeLink));
    const result = await call("brain_link", {
      brainId: BRAIN,
      fromId: THOUGHT,
      toId: TYPE,
      relation: "parent",
      name: "is a",
    });
    expectRefused(result, calls, "toId");
  });

  it("brain_link still jumps to a type and puts a type under a thought", async () => {
    // Measured: both are ordinary links, and neither touches a type.
    for (const [args, relation, reads] of [
      [{ fromId: THOUGHT, toId: TYPE }, 3, []],
      [{ fromId: THOUGHT, toId: TYPE, relation: "jump" }, 3, []],
      [{ fromId: THOUGHT, toId: TYPE, relation: "child" }, 1, [THOUGHT]],
      [{ fromId: TYPE, toId: THOUGHT, relation: "parent" }, 2, [THOUGHT]],
    ] as const) {
      const { call, calls, sent } = await connect(routes());
      const result = await call("brain_link", { brainId: BRAIN, ...args });
      expect(result.isError).toBe(false);
      expect(result.text).toContain(`link created — ${LINK}`);
      expect(sent("POST")).toEqual([
        { thoughtIdA: args.fromId, thoughtIdB: args.toId, relation },
      ]);
      expect(calls.filter((c) => c.path.includes("/api/thoughts/")).map((c) => c.path)).toEqual(
        // Once by the tool, once more by `links.create`.
        reads.flatMap((id) => [`/api/thoughts/${BRAIN}/${id}`, `/api/thoughts/${BRAIN}/${id}`]),
      );
    }
  });

  it("brain_link under an ordinary thought links as before, two reads dearer", async () => {
    const { call, calls } = await connect(routes());
    const result = await call("brain_link", {
      brainId: BRAIN,
      fromId: THOUGHT,
      toId: PARENT,
      relation: "parent",
    });
    expect(result.isError).toBe(false);
    expect(sequence(calls)).toEqual([
      read(PARENT),
      `GET /api/links/${BRAIN}/${THOUGHT}/${PARENT}`,
      read(PARENT),
      `POST /api/links/${BRAIN}`,
    ]);
  });

  it("brain_create_thought creates nothing under a type", async () => {
    // It used to report a thought created. The API makes it one of that type
    // with no parent, and with another typeId beside it gives it both types.
    for (const extra of [
      {},
      { relation: "child" },
      { typeId: TYPE, note: "body", tagIds: [TAG] },
    ] as const) {
      const { call, calls } = await connect(routes());
      const result = await call("brain_create_thought", {
        brainId: BRAIN,
        name: "RAG",
        parentId: TYPE,
        ...extra,
      });
      expectRefused(result, calls, "parentId");
    }
  });

  it("brain_create_thought still makes a thought above a type or beside it", async () => {
    for (const [relation, sentAs] of [
      ["parent", 2],
      ["jump", 3],
    ] as const) {
      const { call, calls, sent } = await connect(routes());
      const result = await call("brain_create_thought", {
        brainId: BRAIN,
        name: "RAG",
        parentId: TYPE,
        relation,
      });
      expect(result.isError, relation).toBe(false);
      expect(sent("POST")).toEqual([
        expect.objectContaining({ sourceThoughtId: TYPE, relation: sentAs }),
      ]);
      expect(sequence(calls)).toEqual([`POST /api/thoughts/${BRAIN}`]);
    }
  });

  it("brain_create_thought under an ordinary thought creates as before, two reads dearer", async () => {
    const { call, calls } = await connect(routes());
    const result = await call("brain_create_thought", {
      brainId: BRAIN,
      name: "RAG",
      parentId: PARENT,
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain(`created thought "RAG" — ${THOUGHT}`);
    // Once by the tool, under its own name for the argument, once by `create`.
    expect(sequence(calls)).toEqual([read(PARENT), read(PARENT), `POST /api/thoughts/${BRAIN}`]);
  });

  it("brain_ingest writes no part of a plan that names a type as a parent", async () => {
    // A thought under it used to be reported as created, and a link towards
    // it as a link: each set a type, and the link replaced the one there was.
    for (const [plan, field] of [
      [{ thoughts: [{ tempId: "rag", name: "RAG", parent: TYPE }] }, "parent"],
      [{ links: [{ from: "top", to: TYPE, relation: "parent" }] }, "to"],
      [{ links: [{ from: TYPE, to: "top", relation: "child" }] }, "from"],
      [{ links: [{ from: THOUGHT, to: TYPE, relation: "parent" }] }, "to"],
    ] as const) {
      const { call, calls } = await connect(routes());
      const result = await call("brain_ingest", {
        brainId: BRAIN,
        thoughts: [
          { tempId: "top", name: "Retrieval", parent: PARENT, note: "body" },
          ...("thoughts" in plan ? plan.thoughts : []),
        ],
        ...("links" in plan ? { links: plan.links } : {}),
      });
      expectRefused(result, calls, field);
    }
  });

  it("brain_ingest still jumps to a type from a plan", async () => {
    const { call, sent } = await connect(routes());
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [{ tempId: "top", name: "Retrieval", parent: PARENT }],
      links: [{ from: "top", to: TYPE, name: "an example of" }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("links created: 1");
    expect(sent("POST").at(-1)).toEqual({
      thoughtIdA: THOUGHT,
      thoughtIdB: TYPE,
      relation: 3,
      name: "an example of",
    });
  });

  it("every argument that can put a thought under another says where a type goes", async () => {
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    const properties = (name: string): Record<string, { description?: string }> =>
      tools.find((t) => t.name === name)!.inputSchema.properties as Record<
        string,
        { description?: string }
      >;
    const item = (
      properties("brain_ingest")["thoughts"] as unknown as {
        items: { properties: Record<string, { description?: string }> };
      }
    ).items.properties;

    for (const argument of [
      properties("brain_create_thought")["parentId"],
      properties("brain_link")["relation"],
      item["parent"],
      properties("brain_ingest")["links"],
    ]) {
      expect(argument?.description).toMatch(/type.*typeId/s);
    }
  });
});

describe("a tag named as a parent", () => {
  const TYPE = "eeeeeeee-0000-4000-8000-000000000005";
  const TAG = "ffffffff-0000-4000-8000-000000000006";

  /**
   * A brain where PARENT and THOUGHT are ordinary thoughts, TAG a tag and
   * TYPE a type, and `link` is what joins the two thoughts a call names. As
   * on the live API, a thought created under any of them and a link posted
   * towards any of them is a 200: under the tag that is the tag attached, and
   * a thought with no parent.
   */
  const routes = (link: Record<string, unknown> | null = null): Route[] => {
    const others: Record<string, { name: string; kind: number }> = {
      [PARENT]: { name: "Constraints", kind: 1 },
      [THOUGHT]: { name: "RAG", kind: 1 },
      [TAG]: { name: "gotcha", kind: 4 },
      [TYPE]: { name: "Pattern", kind: 2 },
    };
    return [
      ["GET /graph", () => graph(thought("parent"))],
      [
        "GET /api/thoughts/",
        (url) => {
          const id = url.pathname.split("/").pop()!;
          return id in others ? { ...thought("", { aliases: [] }), id, ...others[id] } : 404;
        },
      ],
      ["POST /api/thoughts/", () => ({ id: THOUGHT })],
      ["POST /api/notes/", () => 200],
      ["POST /api/links/", () => ({ id: LINK })],
      ["GET /api/links/", () => (link === null ? 404 : { id: LINK, ...link })],
      ["PATCH /api/links/", () => 200],
    ];
  };
  const tagLink = { thoughtIdA: TAG, thoughtIdB: THOUGHT, relation: 1, meaning: 5 };
  const read = (id: string): string => `GET /api/thoughts/${BRAIN}/${id}`;
  const sequence = (calls: Array<{ method: string; path: string }>): string[] =>
    calls.map((c) => `${c.method} ${c.path}`);

  /** A refusal the model can act on, and not one request that writes. */
  const expectRefused = (
    result: { text: string; isError: boolean },
    calls: Array<{ method: string }>,
    field: string,
  ): void => {
    expect(result.isError, field).toBe(true);
    expect(result.text).toContain(`${field} ${TAG} cannot be a parent: it is the tag "gotcha"`);
    expect(result.text).toContain("Nothing was written");
    // Both ways out: the calls that attach a tag, and a parent that is one.
    expect(result.text).toMatch(/brain_tag, or as tagIds to brain_create_thought or brain_ingest/);
    expect(result.text).toContain("an ordinary thought");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  };

  it("brain_link refuses a parent or child link with a tag above, at the cost of one read", async () => {
    // It used to answer "link created". The API takes the request with a 200
    // and attaches the tag: the thought is tagged and has no parent for it.
    for (const [args, field] of [
      [{ fromId: THOUGHT, toId: TAG, relation: "parent" }, "toId"],
      [{ fromId: TAG, toId: THOUGHT, relation: "child" }, "fromId"],
    ] as const) {
      const { call, calls } = await connect(routes());
      const result = await call("brain_link", { brainId: BRAIN, ...args, name: "marks" });
      expectRefused(result, calls, field);
      expect(sequence(calls)).toEqual([read(TAG)]);
    }
  });

  it("brain_link refuses it whatever is between the two already, and labels nothing", async () => {
    // The tag's own attachment used to be given the label, and reported as a
    // link that existed.
    const { call, calls } = await connect(routes(tagLink));
    const result = await call("brain_link", {
      brainId: BRAIN,
      fromId: THOUGHT,
      toId: TAG,
      relation: "parent",
      name: "marks",
    });
    expectRefused(result, calls, "toId");
  });

  it("brain_link still jumps to a tag and puts a tag under a thought", async () => {
    // Measured: both are ordinary links, and neither attaches the tag.
    for (const [args, relation] of [
      [{ fromId: THOUGHT, toId: TAG }, 3],
      [{ fromId: THOUGHT, toId: TAG, relation: "child" }, 1],
      [{ fromId: TAG, toId: THOUGHT, relation: "parent" }, 2],
    ] as const) {
      const { call, sent } = await connect(routes());
      const result = await call("brain_link", { brainId: BRAIN, ...args });
      expect(result.isError).toBe(false);
      expect(result.text).toContain(`link created — ${LINK}`);
      expect(sent("POST")).toEqual([
        { thoughtIdA: args.fromId, thoughtIdB: args.toId, relation },
      ]);
    }
  });

  it("brain_create_thought creates nothing under a tag", async () => {
    // It used to report a thought created. The API makes it, tags it and
    // gives it no parent.
    for (const extra of [
      {},
      { relation: "child" },
      { typeId: TYPE, note: "body", tagIds: [TAG] },
    ] as const) {
      const { call, calls } = await connect(routes());
      const result = await call("brain_create_thought", {
        brainId: BRAIN,
        name: "RAG",
        parentId: TAG,
        ...extra,
      });
      expectRefused(result, calls, "parentId");
    }
  });

  it("brain_create_thought still makes a thought above a tag or beside it", async () => {
    for (const [relation, sentAs] of [
      ["parent", 2],
      ["jump", 3],
    ] as const) {
      const { call, calls, sent } = await connect(routes());
      const result = await call("brain_create_thought", {
        brainId: BRAIN,
        name: "RAG",
        parentId: TAG,
        relation,
      });
      expect(result.isError, relation).toBe(false);
      expect(sent("POST")).toEqual([
        expect.objectContaining({ sourceThoughtId: TAG, relation: sentAs }),
      ]);
      expect(sequence(calls)).toEqual([`POST /api/thoughts/${BRAIN}`]);
    }
  });

  it("brain_ingest writes no part of a plan that names a tag as a parent", async () => {
    // A thought under it used to be reported as created, and a link towards
    // it as a link, each with "tags attached: 0" beside it.
    for (const [plan, field] of [
      [{ thoughts: [{ tempId: "rag", name: "RAG", parent: TAG }] }, "parent"],
      [{ links: [{ from: "top", to: TAG, relation: "parent" }] }, "to"],
      [{ links: [{ from: TAG, to: "top", relation: "child" }] }, "from"],
      [{ links: [{ from: THOUGHT, to: TAG, relation: "parent" }] }, "to"],
    ] as const) {
      const { call, calls } = await connect(routes());
      const result = await call("brain_ingest", {
        brainId: BRAIN,
        thoughts: [
          { tempId: "top", name: "Retrieval", parent: PARENT, note: "body" },
          ...("thoughts" in plan ? plan.thoughts : []),
        ],
        ...("links" in plan ? { links: plan.links } : {}),
      });
      expectRefused(result, calls, field);
    }
  });

  it("the ways out it names attach the tag, and say so", async () => {
    for (const [tool, args, said] of [
      ["brain_tag", { thoughtId: THOUGHT, add: [TAG] }, `attached ${TAG}`],
      [
        "brain_create_thought",
        { name: "RAG", parentId: PARENT, tagIds: [TAG] },
        "tags attached: 1",
      ],
      [
        "brain_ingest",
        { thoughts: [{ tempId: "rag", name: "RAG", parent: PARENT, tagIds: [TAG] }] },
        "tags attached: 1",
      ],
    ] as const) {
      const { call, sent } = await connect(routes());
      const result = await call(tool, { brainId: BRAIN, ...args });
      expect(result.isError, tool).toBe(false);
      expect(result.text, tool).toContain(said);
      expect(sent("POST").at(-1), tool).toEqual({
        thoughtIdA: THOUGHT,
        thoughtIdB: TAG,
        relation: 2,
      });
    }
  });

  it("every argument that can put a thought under another says where a tag goes", async () => {
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    const properties = (name: string): Record<string, { description?: string }> =>
      tools.find((t) => t.name === name)!.inputSchema.properties as Record<
        string,
        { description?: string }
      >;
    const item = (
      properties("brain_ingest")["thoughts"] as unknown as {
        items: { properties: Record<string, { description?: string }> };
      }
    ).items.properties;

    for (const argument of [
      properties("brain_create_thought")["parentId"],
      item["parent"],
      properties("brain_ingest")["links"],
    ]) {
      expect(argument?.description).toMatch(/tag.*tagIds/s);
    }
    expect(properties("brain_link")["relation"]?.description).toMatch(/tag.*brain_tag/s);
  });
});

describe("a link that is not made, or is not the one asked for", () => {
  const TYPE = "eeeeeeee-0000-4000-8000-000000000005";
  const TAG = "ffffffff-0000-4000-8000-000000000006";
  const ROOT = "12121212-0000-4000-8000-000000000012";
  const ZEROS = "00000000-0000-0000-0000-000000000000";

  /**
   * A brain where ROOT, PARENT and THOUGHT are ordinary thoughts, TAG a tag
   * and TYPE a type. `link` is what joins the two thoughts a call names, and
   * `answer` the identifier a posted link comes back with: the live API
   * answers a link it does not make with a 200 and zeros.
   */
  const routes = (link: Record<string, unknown> | null = null, answer = LINK): Route[] => {
    const others: Record<string, { name: string; kind: number }> = {
      [ROOT]: { name: "Reading", kind: 1 },
      [PARENT]: { name: "Constraints", kind: 1 },
      [THOUGHT]: { name: "RAG", kind: 1 },
      [TAG]: { name: "gotcha", kind: 4 },
      [TYPE]: { name: "Pattern", kind: 2 },
    };
    return [
      ["GET /graph", () => graph(thought("parent"))],
      [
        "GET /api/thoughts/",
        (url) => {
          const id = url.pathname.split("/").pop()!;
          return id in others ? { ...thought("", { aliases: [] }), id, ...others[id] } : 404;
        },
      ],
      ["POST /api/thoughts/", () => ({ id: THOUGHT })],
      ["POST /api/links/", () => ({ id: answer })],
      ["GET /api/links/", () => (link === null ? 404 : { id: LINK, ...link })],
      ["PATCH /api/links/", () => 200],
    ];
  };
  // As the API stores them: `thoughtIdA` is the upper end, the tag or the
  // type, and a link written as a parent's reads back as a child's.
  const jump = { thoughtIdA: THOUGHT, thoughtIdB: PARENT, relation: 3, meaning: 1 };
  const toAbove = { thoughtIdA: PARENT, thoughtIdB: THOUGHT, relation: 1, meaning: 1 };
  const fromAbove = { thoughtIdA: THOUGHT, thoughtIdB: PARENT, relation: 1, meaning: 1 };
  const label = [{ op: "replace", path: "/name", value: "contradicts" }];

  it("brain_link does not link a thought to itself, and sends no write", async () => {
    // The API answers 200 with an identifier of zeros and makes no link. It
    // used to read "link created" with the zeros after it.
    for (const relation of [undefined, "jump", "child", "parent"]) {
      const { call, calls } = await connect(routes());
      const result = await call("brain_link", {
        brainId: BRAIN,
        fromId: THOUGHT,
        toId: THOUGHT,
        ...(relation !== undefined ? { relation } : {}),
        name: "itself",
      });
      expect(result.isError, relation).toBe(true);
      expect(result.text).toContain(
        `a thought cannot be linked to itself: both ends of the link are ${THOUGHT}`,
      );
      expect(result.text).not.toContain("link created");
      expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    }
  });

  it("brain_link reports an identifier of zeros as an error, not as a link created", async () => {
    const { call } = await connect(routes(null, ZEROS));
    const result = await call("brain_link", { brainId: BRAIN, fromId: THOUGHT, toId: PARENT });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`no link was made between ${THOUGHT} and ${PARENT}`);
    expect(result.text).toContain("identifier of zeros");
    expect(result.text).toContain("Nothing was written");
    expect(result.text).not.toContain("link created");
  });

  it("brain_ingest rejects a plan that links a thought to itself, with nothing sent", async () => {
    // It used to count under "links created".
    for (const link of [
      { from: "top", to: "top", name: "itself" },
      { from: THOUGHT, to: THOUGHT, relation: "child" },
    ]) {
      const { call, calls } = await connect(routes());
      const result = await call("brain_ingest", {
        brainId: BRAIN,
        thoughts: [{ tempId: "top", name: "Retrieval", parent: ROOT }],
        links: [link],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Plan rejected, nothing was written");
      expect(result.text).toContain(
        `the link ${link.from} -> ${link.to} joins a thought to itself`,
      );
      expect(calls).toEqual([]);
    }
  });

  it("brain_ingest lists a link answered with zeros under Failed, and counts none created", async () => {
    const { call } = await connect(routes(null, ZEROS));
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [{ tempId: "top", name: "Retrieval", parent: ROOT }],
      links: [{ from: "top", to: TYPE, name: "an example of" }],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("links created: 0");
    expect(result.text).toContain(
      `## Failed\n- link top -> ${TYPE}: no link was made between ${THOUGHT} and ${TYPE}`,
    );
  });

  it("brain_link says what joins the two when it is not the link asked for", async () => {
    // It used to answer "Link already existed" and no more, whatever the link.
    for (const [relation, link, note] of [
      ["parent", jump, "as jump, the requested parent-child with toId above was not added"],
      ["child", jump, "as jump, the requested parent-child with fromId above was not added"],
      [undefined, toAbove, "as parent-child with toId above, the requested jump was not added"],
      ["jump", fromAbove, "as parent-child with fromId above, the requested jump was not added"],
      [
        "child",
        toAbove,
        "as parent-child with toId above, the requested parent-child with fromId above " +
          "was not added",
      ],
      [
        "parent",
        fromAbove,
        "as parent-child with fromId above, the requested parent-child with toId above " +
          "was not added",
      ],
    ] as const) {
      const ends = { brainId: BRAIN, fromId: THOUGHT, toId: PARENT };
      const asked = relation !== undefined ? { relation } : {};
      const bare = await connect(routes(link));
      const unnamed = await bare.call("brain_link", { ...ends, ...asked });
      expect(unnamed.isError, note).toBe(false);
      expect(unnamed.text).toBe(
        `## Link already existed\nidentifier ${LINK}: the link already existed ${note}`,
      );
      expect(bare.calls.filter((c) => c.method !== "GET")).toEqual([]);

      // The label goes onto the link that is there, and the result says so.
      const labelled = await connect(routes(link));
      const named = await labelled.call("brain_link", { ...ends, ...asked, name: "contradicts" });
      expect(named.isError, note).toBe(false);
      expect(named.text).toBe(
        `## Link already existed\nidentifier ${LINK}: the link already existed ${note}` +
          " — only the label was updated",
      );
      expect(labelled.sent("PATCH")).toEqual([label]);
      expect(labelled.sent("POST")).toEqual([]);
    }
  });

  it("brain_link answers as it did when the link is the one asked for", async () => {
    for (const [relation, link] of [
      [undefined, jump],
      ["jump", jump],
      // A parent's link is stored from the other end, and is no mismatch.
      ["parent", toAbove],
      ["child", fromAbove],
    ] as const) {
      const ends = { brainId: BRAIN, fromId: THOUGHT, toId: PARENT };
      const asked = relation !== undefined ? { relation } : {};
      const bare = await connect(routes(link));
      expect((await bare.call("brain_link", { ...ends, ...asked })).text).toBe(
        `## Link already existed\nidentifier ${LINK}`,
      );
      expect(bare.calls.filter((c) => c.method !== "GET")).toEqual([]);

      const labelled = await connect(routes(link));
      const named = await labelled.call("brain_link", { ...ends, ...asked, name: "contradicts" });
      expect(named.text).toBe(`## Link already existed\nidentifier ${LINK}, label updated`);
      expect(labelled.sent("PATCH")).toEqual([label]);
    }
  });

  it("brain_link adds nothing over a tag or a type, labels neither, and calls neither a link", async () => {
    // Each used to be given the label and reported as "Link already existed".
    const tagOnThought = { thoughtIdA: TAG, thoughtIdB: THOUGHT, relation: 1, meaning: 5 };
    const typeOfThought = { thoughtIdA: TYPE, thoughtIdB: THOUGHT, relation: 1, meaning: 2 };
    const over = ", and two thoughts share one link: the requested";
    for (const [args, link, note] of [
      [
        { fromId: THOUGHT, toId: TAG },
        tagOnThought,
        `toId is a tag on fromId${over} jump was not added in its place`,
      ],
      [
        { fromId: TAG, toId: THOUGHT, relation: "jump" },
        tagOnThought,
        `fromId is a tag on toId${over} jump was not added in its place`,
      ],
      [
        { fromId: THOUGHT, toId: TAG, relation: "child" },
        tagOnThought,
        `toId is a tag on fromId${over} parent-child with fromId above was not added in its place`,
      ],
      [
        { fromId: THOUGHT, toId: TYPE },
        typeOfThought,
        `toId is the type of fromId${over} jump was not added in its place`,
      ],
      [
        { fromId: THOUGHT, toId: TYPE, relation: "child" },
        typeOfThought,
        `toId is the type of fromId${over} parent-child with fromId above ` +
          "was not added in its place",
      ],
    ] as const) {
      const bare = await connect(routes(link));
      const unnamed = await bare.call("brain_link", { brainId: BRAIN, ...args });
      expect(unnamed.isError, note).toBe(false);
      expect(unnamed.text).toBe(`## No link added\n${note}`);

      const labelled = await connect(routes(link));
      const named = await labelled.call("brain_link", { brainId: BRAIN, ...args, name: "about" });
      expect(named.isError, note).toBe(false);
      expect(named.text).toBe(`## No link added\n${note}, and no label was written`);
      for (const { calls } of [bare, labelled]) {
        expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
      }
    }
  });

  it("brain_ingest says the same of a plan's links, and lists a tag or a type apart", async () => {
    const plan = (link: Record<string, unknown>) => ({
      brainId: BRAIN,
      thoughts: [{ tempId: "top", name: "Retrieval", parent: ROOT }],
      links: [{ from: "top", ...link, name: "contradicts" }],
    });
    // The thought the plan makes comes back as THOUGHT, so "top" is THOUGHT.
    for (const [link, joined, section, note, labelled] of [
      [
        { to: PARENT, relation: "parent" },
        toAbove,
        "Links that already existed",
        "the link already existed, label updated",
        true,
      ],
      [
        { to: PARENT, relation: "child" },
        toAbove,
        "Links that already existed",
        `the link already existed as parent-child with ${PARENT} above, the requested ` +
          "parent-child with top above was not added — only the label was updated",
        true,
      ],
      [
        { to: PARENT, relation: "parent" },
        jump,
        "Links that already existed",
        `the link already existed as jump, the requested parent-child with ${PARENT} above ` +
          "was not added — only the label was updated",
        true,
      ],
      [
        { to: TAG },
        { thoughtIdA: TAG, thoughtIdB: THOUGHT, relation: 1, meaning: 5 },
        "Links not added",
        `${TAG} is a tag on top, and two thoughts share one link: the requested jump was ` +
          "not added in its place, and no label was written",
        false,
      ],
      [
        { to: TYPE },
        { thoughtIdA: TYPE, thoughtIdB: THOUGHT, relation: 1, meaning: 2 },
        "Links not added",
        `${TYPE} is the type of top, and two thoughts share one link: the requested jump ` +
          "was not added in its place, and no label was written",
        false,
      ],
    ] as const) {
      const { call, sent } = await connect(routes(joined));
      const result = await call("brain_ingest", plan(link));
      expect(result.isError, note).toBe(false);
      expect(result.text).toContain(`## ${section}\n- top -> ${link.to}: ${note}\n`);
      expect(result.text).toContain("links created: 0");
      expect(sent("PATCH")).toEqual(labelled ? [label] : []);
    }
  });

  it("brain_link says that two thoughts share one link, and that the result names it", async () => {
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "brain_link")!.description).toMatch(
      /share one link.*nothing is added.*what is there/s,
    );
  });
});

describe("a sibling is no relation", () => {
  /**
   * A brain that answers 200 to what it is sent. The live API does so to a
   * thought created as a sibling, which it links to nothing; a link sent as
   * one it refuses with a 400.
   */
  const routes = (): Route[] => [
    ["GET /api/brains/", () => ({ id: BRAIN, name: "brain", homeThoughtId: PARENT })],
    ["GET /graph", () => graph(thought("parent"))],
    ["GET /api/thoughts/", () => thought("Constraints", { aliases: [] })],
    ["POST /api/thoughts/", () => ({ id: THOUGHT })],
    ["POST /api/notes/", () => 200],
    ["POST /api/links/", () => ({ id: LINK })],
    ["GET /api/links/", () => 404],
  ];
  type Argument = { description?: string; enum?: string[]; $ref?: string };
  /** Every argument of every tool that takes a relation. */
  const relations = async (): Promise<Record<string, Argument>> => {
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    const schema = (name: string) => tools.find((t) => t.name === name)!.inputSchema;
    const properties = (name: string): Record<string, Argument> =>
      schema(name).properties as Record<string, Argument>;
    const item = (list: string): Record<string, Argument> =>
      (
        properties("brain_ingest")[list] as unknown as {
          items: { properties: Record<string, Argument> };
        }
      ).items.properties;
    // A plan's links take their relation from its thoughts', by reference.
    const followed = (argument: Argument): Argument =>
      argument.$ref === undefined
        ? argument
        : (argument.$ref
            .slice(2)
            .split("/")
            .reduce<unknown>(
              (node, key) => (node as Record<string, unknown>)[key],
              schema("brain_ingest"),
            ) as Argument);
    // Nowhere else either: no schema has the word for a value.
    expect(
      tools.filter((t) => JSON.stringify(t.inputSchema).includes('"sibling"')).map((t) => t.name),
    ).toEqual([]);
    return {
      "brain_create_thought.relation": properties("brain_create_thought")["relation"]!,
      "brain_link.relation": properties("brain_link")["relation"]!,
      "brain_ingest.thoughts.relation": item("thoughts")["relation"]!,
      "brain_ingest.links.relation": followed(item("links")["relation"]!),
    };
  };

  it("no tool offers it: a relation is child, parent or jump", async () => {
    for (const [where, argument] of Object.entries(await relations())) {
      expect(argument.enum, where).toEqual(["child", "parent", "jump"]);
    }
  });

  it("sent all the same, it is an error the model reads, and nothing goes out", async () => {
    // brain_create_thought used to answer "created thought" for a thought the
    // API had linked to nothing, and brain_ingest to list it as created.
    // brain_link got the API's 400, and so did a plan's link, with the rest
    // of the plan written by then.
    const relation = "sibling";
    const top = { tempId: "top", name: "Retrieval", parent: PARENT, note: "body" };
    for (const [tool, args] of [
      ["brain_create_thought", { name: "RAG", parentId: PARENT, relation, note: "body" }],
      ["brain_link", { fromId: THOUGHT, toId: PARENT, relation, name: "beside" }],
      [
        "brain_ingest",
        { thoughts: [top, { tempId: "rag", name: "RAG", parent: PARENT, relation }] },
      ],
      ["brain_ingest", { thoughts: [top], links: [{ from: "top", to: PARENT, relation }] }],
    ] as const) {
      const { call, calls } = await connect(routes());
      // A result, not a protocol error: `call` would have thrown on one.
      const result = await call(tool, { brainId: BRAIN, ...args });
      expect(result.isError, tool).toBe(true);
      // It names the argument and the values there are to choose from.
      for (const word of ["relation", "child", "parent", "jump"]) {
        expect(result.text, tool).toContain(word);
      }
      expect(calls, tool).toEqual([]);
    }
  });

  it("the arguments that could be taken for it say where a sibling goes", async () => {
    const described = await relations();
    expect(described["brain_create_thought.relation"]!.description).toMatch(
      /sibling.*that thought's parent as parentId/s,
    );
    expect(described["brain_link.relation"]!.description).toMatch(
      /Siblings are not linked.*parent in common/s,
    );
  });
});

describe("what an alias costs", () => {
  it("is stated on every argument that can write one", async () => {
    // Per TheBrain's spec the first alias raises the version a brain requires
    // on every device. An agent can only put that choice to the user if the
    // argument it is about to fill in says so.
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    const properties = (name: string): Record<string, { description?: string }> => {
      const tool = tools.find((t) => t.name === name)!;
      return tool.inputSchema.properties as Record<string, { description?: string }>;
    };
    const item = (
      properties("brain_ingest")["thoughts"] as unknown as {
        items: { properties: Record<string, { description?: string }> };
      }
    ).items.properties;

    expect(ALIAS_COST).toContain("15.0.621");
    for (const argument of [
      properties("brain_create_thought")["aliases"],
      properties("brain_update_thought")["addAliases"],
      item["aliases"],
    ]) {
      expect(argument?.description).toContain(ALIAS_COST);
    }
  });

  it("more aliases than the API keeps are refused as a readable tool error", async () => {
    const { call, calls } = await connect([]);
    const result = await call("brain_update_thought", {
      brainId: BRAIN,
      thoughtId: THOUGHT,
      addAliases: Array.from({ length: 101 }, (_, i) => `alias ${i}`),
    });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("a call that fails after it has written", () => {
  const TYPE = "eeeeeeee-0000-4000-8000-000000000005";
  const TAG = "ffffffff-0000-4000-8000-000000000006";
  const TAG_B = "ffffffff-0000-4000-8000-00000000000b";
  const TAG_C = "ffffffff-0000-4000-8000-00000000000c";
  const NOBODY = "99999999-0000-4000-8000-000000000009";
  const KINDS: Record<string, number> = {
    [THOUGHT]: 1,
    [PARENT]: 1,
    [TYPE]: 2,
    [TAG]: 4,
    [TAG_B]: 4,
    [TAG_C]: 4,
  };

  const said = (status: number, text: string) => (): Response =>
    new Response(JSON.stringify(text), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  const boom = said(500, "boom");
  /** What that 500 reads as, for the request that got it. */
  const failed500 = (request: string): string =>
    `TheBrain failed with a 500 (${request}): boom. The fault is inside the app, not in the ` +
    "arguments of this call. A read is safe to repeat; before repeating a write, check what it left.";
  /** What a request that got no answer reads as. */
  const NO_ANSWER =
    "request exceeded 30000 ms. Check that the TheBrain desktop app is running and its " +
    "local API is enabled.";
  /** What the API answers for the read of a thought nobody has. */
  const bareNotFound = (): Response =>
    new Response(JSON.stringify({ title: "Not Found", status: 404 }), {
      status: 404,
      headers: { "content-type": "application/problem+json" },
    });
  const noAnswer = (): never => {
    // What the client makes of a timeout: the request may have reached TheBrain.
    throw new DOMException("timed out", "TimeoutError");
  };

  /**
   * A brain of two ordinary thoughts, a type and three tags, which takes
   * every write. `first` goes ahead of its routes, and is where a test puts
   * the answer that fails. A patch is kept, so a type and aliases read back.
   */
  const routes = (first: Route[] = [], link: Record<string, unknown> | null = null): Route[] => {
    const held: { typeId: string | null; aliases: string[] } = { typeId: null, aliases: [] };
    return [
      ...first,
      ["GET /api/brains/", () => ({ id: BRAIN, name: "brain", homeThoughtId: PARENT })],
      ["GET /graph", () => graph(thought("RAG"))],
      [
        "GET /api/thoughts/",
        (url) => {
          const id = url.pathname.split("/").pop()!;
          if (!(id in KINDS)) return bareNotFound();
          return { ...thought("RAG"), id, kind: KINDS[id], ...(id === THOUGHT ? held : { aliases: [] }) };
        },
      ],
      [
        "PATCH /api/thoughts/",
        (_url, body) => {
          for (const op of body as Array<{ op: string; path: string; value?: unknown }>) {
            if (op.path === "/typeId") held.typeId = op.value as string;
            if (op.path === "/aliases") held.aliases = (op.value as string[] | undefined) ?? [];
          }
          return 200;
        },
      ],
      ["POST /api/thoughts/", () => ({ id: THOUGHT })],
      ["POST /api/notes/", () => 200],
      ["GET /api/notes/", () => noNote],
      ["POST /api/links/", () => ({ id: LINK })],
      ["GET /api/links/", () => (link === null ? 404 : { id: LINK, ...link })],
      ["DELETE /api/", () => 200],
    ];
  };
  const requests = (calls: Array<{ method: string; path: string }>): string[] =>
    calls.map((c) => `${c.method} ${c.path}`);
  const writes = (calls: Array<{ method: string; path: string }>): string[] =>
    requests(calls.filter((c) => c.method !== "GET"));

  const AT_FIRST = "The call stopped at its first failure, and nothing is rolled back. ";
  const NOT = "What is under Failed was not, unless its line says otherwise";
  /** The sentences under "Next" when something stands under "Done". */
  const IN_PART = `${AT_FIRST}What is under Done was done. ${NOT}`;
  const STOPPED = ", and what is under Skipped was not tried. ";
  const TAKE = " It may have been deleted, or be another brain's. Take identifiers from brain_search or brain_get_thought.";

  describe("brain_create_thought", () => {
    const EXISTS =
      "The thought exists, and its identifier works immediately: do not create it again. " +
      `Fix the cause and write only the rest to ${THOUGHT}: `;

    it("a note that fails leaves the identifier of the thought it made, and what to finish with", async () => {
      // The result used to be the 500's error alone: the thought
      // was there, and the call sent again made a second.
      const { call, calls } = await connect(routes([["POST /api/notes/", boom]]));
      const result = await call("brain_create_thought", {
        brainId: BRAIN,
        name: "RAG",
        parentId: PARENT,
        note: "body",
        tagIds: [TAG],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        [
          "## Done",
          `- created thought "RAG" — ${THOUGHT}`,
          "",
          "## Failed",
          `- note: ${failed500(`POST /api/notes/${BRAIN}/${THOUGHT}/update`)}`,
          "",
          "## Skipped",
          `- tag ${TAG}`,
          "",
          "## Next",
          `${IN_PART}${STOPPED}${EXISTS}the note with brain_set_note, tags with brain_tag.`,
        ].join("\n"),
      );
      // One thought, and nothing sent past the failure.
      expect(writes(calls)).toEqual([
        `POST /api/thoughts/${BRAIN}`,
        `POST /api/notes/${BRAIN}/${THOUGHT}/update`,
      ]);
    });

    it("a tag that fails leaves what was written by identifier, and does not say that nothing was", async () => {
      // A tag deleted between the check ahead of the create and its own
      // turn. The result used to be that refusal with its "Nothing was
      // written", over a thought with a note and a tag.
      let reads = 0;
      const { call, calls } = await connect(
        routes([
          [`GET /api/thoughts/${BRAIN}/${TAG_B}`, () => ((reads += 1) > 1 ? 404 : thought("b", { id: TAG_B, kind: 4 }))],
        ]),
      );
      const result = await call("brain_create_thought", {
        brainId: BRAIN,
        name: "RAG",
        parentId: PARENT,
        note: "body",
        tagIds: [TAG, TAG_B, TAG_C],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        [
          "## Done",
          `- created thought "RAG" — ${THOUGHT}`,
          "- note written",
          `- tag attached: ${TAG}`,
          "",
          "## Failed",
          `- tag ${TAG_B}: tagId ${TAG_B} is not a tag: no thought in this brain has that ` +
            "identifier. Take tag identifiers from brain_list_types_and_tags.",
          "",
          "## Skipped",
          `- tag ${TAG_C}`,
          "",
          "## Next",
          `${IN_PART}${STOPPED}${EXISTS}tags with brain_tag.`,
        ].join("\n"),
      );
      expect(result.text).not.toContain("Nothing was written");
      expect(writes(calls)).toEqual([
        `POST /api/thoughts/${BRAIN}`,
        `POST /api/notes/${BRAIN}/${THOUGHT}/update`,
        `POST /api/links/${BRAIN}`,
      ]);
    });

    it("the last write failing leaves nothing skipped, and a note that was written keeps its warning", async () => {
      const { call } = await connect(routes([["POST /api/links/", boom]]));
      const result = await call("brain_create_thought", {
        brainId: BRAIN,
        name: "RAG",
        note: "```\ncode\n```\n",
        tagIds: [TAG],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        [
          "## Done",
          `- created thought "RAG" — ${THOUGHT}`,
          "- note written",
          "",
          "## Failed",
          `- tag ${TAG}: ${failed500(`POST /api/links/${BRAIN}`)}`,
          "",
          "## Warning",
          "- this note contains a fenced code block — TheBrain drops the closing ``` on save " +
            "and the rest of the text gets swallowed into the block. Prefer indenting code by " +
            "four spaces",
          "",
          "## Next",
          `${IN_PART}. ${EXISTS}tags with brain_tag.`,
        ].join("\n"),
      );
    });

    it("a write that got no answer is not called unwritten", async () => {
      const { call } = await connect(routes([["POST /api/notes/", noAnswer]]));
      const result = await call("brain_create_thought", { brainId: BRAIN, name: "RAG", note: "body" });

      expect(result.isError).toBe(true);
      expect(result.text).toContain(
        `## Failed\n- note: ${NO_ANSWER} — no answer came, so TheBrain may have carried it out ` +
          "all the same\n",
      );
      expect(result.text).toContain(
        `## Next\n${IN_PART}. ${EXISTS}the note with brain_set_note.`,
      );
    });

    it("a read that got no answer is not a write that may have gone through", async () => {
      const lost = NO_ANSWER;
      // Ahead of the create, the read of the parent: nothing was sent to make a thought.
      const before = await connect(routes([[`GET /api/thoughts/${BRAIN}/${PARENT}`, noAnswer]]));
      const refused = await before.call("brain_create_thought", {
        brainId: BRAIN,
        name: "RAG",
        parentId: PARENT,
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toBe(lost);
      expect(writes(before.calls)).toEqual([]);

      // After it, the tag's own read at its turn: the tag is not attached.
      let reads = 0;
      const after = await connect(
        routes([
          [
            `GET /api/thoughts/${BRAIN}/${TAG}`,
            () => ((reads += 1) > 1 ? noAnswer() : thought("gotcha", { id: TAG, kind: 4 })),
          ],
        ]),
      );
      const result = await after.call("brain_create_thought", {
        brainId: BRAIN,
        name: "RAG",
        tagIds: [TAG],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain(`## Failed\n- tag ${TAG}: ${lost}\n`);
      expect(result.text).not.toContain("no answer came");
      expect(result.text).toContain(`## Next\n${IN_PART}. ${EXISTS}tags with brain_tag.`);
    });

    it("a create that got no answer says the thought may be there, and where to look for it", async () => {
      // It used to be the network's message alone, and the thought was there
      // with no word that it might be.
      const lost =
        `${NO_ANSWER}\n\n## Next\nNo answer came to the create, so TheBrain may have made "RAG" ` +
        "all the same, and there is no identifier to give for it. Before creating it again, look for it ";

      const under = await connect(routes([["POST /api/thoughts/", noAnswer]]));
      const result = await under.call("brain_create_thought", {
        brainId: BRAIN,
        name: "RAG",
        parentId: PARENT,
        note: "body",
        tagIds: [TAG],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        `${lost}next to ${PARENT} with brain_get_thought. Nothing else of the call was written: ` +
          "if the thought is there, write its note with brain_set_note and its tags with brain_tag.",
      );
      expect(writes(under.calls)).toEqual([`POST /api/thoughts/${BRAIN}`]);

      // With no parent there is nothing to look next to.
      const alone = await connect(routes([["POST /api/thoughts/", noAnswer]]));
      expect((await alone.call("brain_create_thought", { brainId: BRAIN, name: "RAG" })).text).toBe(
        `${lost}with brain_search, after brain_index with action=sync where the brain has an ` +
          "index: with no parent it is next to no thought, and TheBrain's own search finds a " +
          "new thought only after some seconds.",
      );
    });

    it("a create that is refused is the error it was, and one refused for no cause says what to read", async () => {
      // The 400 a create gets under a parent deleted a moment ago. It used
      // to be passed on as it came, "Could not create thought. (POST …)".
      const { call, calls } = await connect(
        routes([["POST /api/thoughts/", said(400, "Could not create thought.")]]),
      );
      const result = await call("brain_create_thought", {
        brainId: BRAIN,
        name: "RAG",
        parentId: PARENT,
        note: "body",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        `Could not create thought. TheBrain named no cause (POST /api/thoughts/${BRAIN}). It ` +
          "answers so when the parent named for the new thought was deleted a moment ago, or " +
          "the type named for it is no thought of this brain. Nothing was created. Read the " +
          "parent and the type with brain_get_thought before sending the call again.",
      );
      expect(writes(calls)).toEqual([`POST /api/thoughts/${BRAIN}`]);
    });

    it("written whole it reads as it did, to the character", async () => {
      const { call } = await connect(routes());
      const result = await call("brain_create_thought", {
        brainId: BRAIN,
        name: "RAG",
        parentId: PARENT,
        note: "```\ncode\n```\n",
        tagIds: [TAG, TAG_B],
        aliases: ["R.A.G."],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toBe(
        [
          "## Done",
          `- created thought "RAG" — ${THOUGHT}`,
          '- aliases: ["R.A.G."]',
          "- note written",
          "- tags attached: 2",
          "",
          "## Warning",
          "- this note contains a fenced code block — TheBrain drops the closing ``` on save " +
            "and the rest of the text gets swallowed into the block. Prefer indenting code by " +
            "four spaces",
          "",
          "## Next",
          "The identifier above works immediately. Searching for this thought by name only " +
            "succeeds after a few seconds, so refer to it by identifier.",
        ].join("\n"),
      );
    });
  });

  describe("brain_update_thought", () => {
    const REST = `Fix the cause and send only the rest, in a brain_update_thought call for ${THOUGHT}.`;
    /** As the API: a colour that is not `#rrggbb` is a 400, and the patch stops there. */
    const colours: Route = [
      "PATCH /api/thoughts/",
      (_url, body) =>
        (body as Array<{ path: string; value?: unknown }>).some(
          (op) => op.path.endsWith("Color") && !/^#[0-9a-f]{6}$/i.test(String(op.value)),
        )
          ? said(400, "Color format is malformed - should be like '#123456'.")()
          : 200,
    ];

    it("a field the API refuses leaves the ones before it listed as written, and the rest as not tried", async () => {
      // The fields went in one patch. The API keeps what it wrote before the
      // operation it refuses, so the name was changed, and the result was the
      // colour's error alone.
      const { call, sent } = await connect(routes([colours]));
      const result = await call("brain_update_thought", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        name: "renamed",
        label: "caption",
        foregroundColor: "red",
        backgroundColor: "#112233",
        addAliases: ["R.A.G."],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        [
          "## Done",
          '- name = "renamed"',
          '- label = "caption"',
          "",
          "## Failed",
          "- foregroundColor = \"red\": Color format is malformed - should be like '#123456'. " +
            `(PATCH /api/thoughts/${BRAIN}/${THOUGHT})`,
          "",
          "## Skipped",
          '- backgroundColor = "#112233"',
          "- aliases",
          "",
          "## Next",
          `${IN_PART}${STOPPED}${REST}`,
        ].join("\n"),
      );
      // A field to a request, so what is listed as written is what was sent
      // alone and answered 200, and nothing went out past the refusal.
      expect(sent("PATCH")).toEqual([
        [{ op: "replace", path: "/name", value: "renamed" }],
        [{ op: "replace", path: "/label", value: "caption" }],
        [{ op: "replace", path: "/foregroundColor", value: "red" }],
      ]);
    });

    it("aliases that fail after the fields leave the fields listed as written", async () => {
      // Refused by the limit of a hundred, after the name was changed: the
      // result used to be the limit's sentence alone.
      const { call } = await connect(
        routes([
          [
            `GET /api/thoughts/${BRAIN}/${THOUGHT}`,
            () => thought("RAG", { aliases: Array.from({ length: 99 }, (_, i) => `a${i}`) }),
          ],
        ]),
      );
      const result = await call("brain_update_thought", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        name: "renamed",
        addAliases: ["one more", "and another"],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        [
          "## Done",
          '- name = "renamed"',
          "",
          "## Failed",
          "- aliases: a thought holds at most 100 aliases, and this would make 101. Remove some first",
          "",
          "## Next",
          `${IN_PART}. ${REST}`,
        ].join("\n"),
      );
    });

    it("a patch that got no answer is not called unwritten", async () => {
      let patches = 0;
      const { call } = await connect(
        routes([["PATCH /api/thoughts/", () => ((patches += 1) === 2 ? noAnswer() : 200)]]),
      );
      const result = await call("brain_update_thought", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        name: "renamed",
        label: "caption",
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('## Done\n- name = "renamed"\n');
      expect(result.text).toContain(
        `- label = "caption": ${NO_ANSWER} — no answer came, so TheBrain may have carried it ` +
          "out all the same\n",
      );
      expect(result.text).toContain(`## Next\n${IN_PART}. ${REST}`);
    });

    it("the first write failing says what was not tried after it, with nothing under Done", async () => {
      // Its error alone would say nothing of the fields that were not sent.
      const { call, sent } = await connect(routes([["PATCH /api/thoughts/", boom]]));
      const result = await call("brain_update_thought", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        name: "renamed",
        label: "caption",
        addAliases: ["R.A.G."],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        [
          "## Failed",
          `- name = "renamed": ${failed500(`PATCH /api/thoughts/${BRAIN}/${THOUGHT}`)}`,
          "",
          "## Skipped",
          '- label = "caption"',
          "- aliases",
          "",
          "## Next",
          `${AT_FIRST}${NOT}${STOPPED}${REST}`,
        ].join("\n"),
      );
      expect(sent("PATCH")).toHaveLength(1);
    });

    it("a call with one thing to do fails as it did, to the character", async () => {
      const { call } = await connect(routes([["PATCH /api/thoughts/", boom]]));
      const result = await call("brain_update_thought", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        name: "renamed",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(failed500(`PATCH /api/thoughts/${BRAIN}/${THOUGHT}`));
    });

    it("a refusal ahead of the first write still says that nothing was written, and lists the rest", async () => {
      // True of the call here: nothing stands under Done.
      const { call, calls } = await connect(routes());
      const result = await call("brain_update_thought", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        name: "renamed",
        typeId: PARENT,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        [
          "## Failed",
          `- typeId = "${PARENT}": typeId ${PARENT} is not a type: it is the thought "RAG". ` +
            "Nothing was written. Take type identifiers from brain_list_types_and_tags.",
          "",
          "## Skipped",
          '- name = "renamed"',
          "",
          "## Next",
          `${AT_FIRST}${NOT}${STOPPED}${REST}`,
        ].join("\n"),
      );
      expect(writes(calls)).toEqual([]);
    });

    it("a rename keeps the old name as an alias, though the thought still reads back under it", async () => {
      // The read behind the alias edit returns the old name for a moment
      // after the rename. The alias was dropped as equal to the name, and
      // the result said there was nothing to add: 10 times of 10 live.
      const { call, sent } = await connect(routes());
      const result = await call("brain_update_thought", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        name: "Retrieval",
        addAliases: ["RAG", "retrieval"],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toBe(
        ["## Done", '- name = "Retrieval"', '- aliases added: ["RAG"]', '- aliases now: ["RAG"]'].join(
          "\n",
        ),
      );
      // And the new name is the one an alias cannot repeat.
      expect(sent("PATCH")).toEqual([
        [{ op: "replace", path: "/name", value: "Retrieval" }],
        [{ op: "replace", path: "/aliases", value: ["RAG"] }],
      ]);
    });

    it("aliases written whose read-back fails are listed as written, not as failed", async () => {
      // The read that waits for the new list failed, and its error used to
      // be the step's: "Failed" for aliases that were in the brain.
      vi.useFakeTimers();
      try {
        let reads = 0;
        const { call, sent } = await connect(
          routes([
            [
              `GET /api/thoughts/${BRAIN}/${THOUGHT}`,
              () => ((reads += 1) > 1 ? boom() : thought("RAG", { aliases: [] })),
            ],
          ]),
        );
        const pending = call("brain_update_thought", {
          brainId: BRAIN,
          thoughtId: THOUGHT,
          label: "caption",
          addAliases: ["R.A.G."],
        });
        await vi.advanceTimersByTimeAsync(5000);
        const result = await pending;

        expect(result.isError).toBe(false);
        expect(result.text).toContain('- aliases added: ["R.A.G."]');
        expect(result.text).toContain("the new aliases are written but do not read back yet");
        expect(sent("PATCH")).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("the type goes first, so what refuses it refuses it ahead of every other field", async () => {
      const { call, sent } = await connect(routes());
      const result = await call("brain_update_thought", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        name: "renamed",
        typeId: TYPE,
        backgroundColor: "#112233",
      });
      expect(result.isError).toBe(false);
      expect(sent("PATCH")).toEqual([
        [{ op: "replace", path: "/typeId", value: TYPE }],
        [{ op: "replace", path: "/name", value: "renamed" }],
        [{ op: "replace", path: "/backgroundColor", value: "#112233" }],
      ]);
    });

    it("a type that is accepted and does not read back stops the call, and the fields after it are listed as not tried", async () => {
      // The other fields used to be in the type's patch, and were written.
      // They are not sent now, and the type's error alone would not say so.
      vi.useFakeTimers();
      try {
        const { call, sent } = await connect([
          [
            "GET /api/thoughts/",
            (url) =>
              url.pathname.endsWith(TYPE)
                ? thought("Pattern", { id: TYPE, kind: 2 })
                : thought("RAG", { aliases: [] }),
          ],
          ["PATCH /api/thoughts/", () => 200],
        ]);
        const pending = call("brain_update_thought", {
          brainId: BRAIN,
          thoughtId: THOUGHT,
          name: "renamed",
          typeId: TYPE,
        });
        await vi.advanceTimersByTimeAsync(5000);
        const result = await pending;

        expect(result.isError).toBe(true);
        expect(result.text).toBe(
          [
            "## Failed",
            `- typeId = "${TYPE}": the type was accepted, but the thought does not read back ` +
              "with it yet. After a burst of writes that can take seconds: read the thought " +
              "before setting the type again",
            "",
            "## Skipped",
            '- name = "renamed"',
            "",
            "## Next",
            `${AT_FIRST}${NOT}${STOPPED}${REST}`,
          ].join("\n"),
        );
        expect(sent("PATCH")).toEqual([[{ op: "replace", path: "/typeId", value: TYPE }]]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a type whose read-back fails is told as accepted, not as the read's error", async () => {
      // The patch went through and the read that waits for it failed. The
      // read's error used to be the result, and said nothing of the type.
      vi.useFakeTimers();
      try {
        let patched = false;
        const { call } = await connect([
          [`GET /api/thoughts/${BRAIN}/${TYPE}`, () => thought("Pattern", { id: TYPE, kind: 2 })],
          ["GET /api/thoughts/", () => (patched ? boom() : thought("RAG"))],
          ["PATCH /api/thoughts/", () => ((patched = true), 200)],
        ]);
        const pending = call("brain_update_thought", {
          brainId: BRAIN,
          thoughtId: THOUGHT,
          typeId: TYPE,
        });
        await vi.advanceTimersByTimeAsync(5000);
        const result = await pending;

        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/^the type was accepted, but the thought does not read back/);
      } finally {
        vi.useRealTimers();
      }
    });

    it("written whole it reads as it did, to the character, in the order of the arguments", async () => {
      const { call } = await connect(routes());
      const result = await call("brain_update_thought", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        name: "renamed",
        label: null,
        typeId: TYPE,
        foregroundColor: "#112233",
        addAliases: ["R.A.G."],
        removeAliases: ["never there"],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toBe(
        [
          "## Done",
          '- name = "renamed"',
          "- label = null",
          `- typeId = "${TYPE}"`,
          '- foregroundColor = "#112233"',
          '- aliases added: ["R.A.G."]',
          '- aliases now: ["R.A.G."]',
        ].join("\n"),
      );
    });
  });

  describe("brain_tag", () => {
    const REST = `Fix the cause and send only the rest, in a brain_tag call for ${THOUGHT}.`;
    const NOTE =
      "## Note\nTag changes are not visible in the graph immediately — up to half a second. " +
      "Re-reading the thought right away may still show the old tags.";
    const tagLink = { thoughtIdA: TAG, thoughtIdB: THOUGHT, relation: 1, meaning: 5 };

    it("a write that fails midway leaves the tags before it listed as attached, and the rest as not tried", async () => {
      // The result used to be the error alone, with a tag attached.
      const { call, calls } = await connect(
        routes(
          [
            [
              "POST /api/links/",
              (_url, body) =>
                (body as { thoughtIdB: string }).thoughtIdB === TAG_B ? boom() : { id: LINK },
            ],
          ],
          tagLink,
        ),
      );
      const result = await call("brain_tag", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        add: [TAG, TAG_B, TAG_C],
        remove: [TAG],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        [
          "## Done",
          `- attached ${TAG}`,
          "",
          "## Failed",
          `- attach ${TAG_B}: ${failed500(`POST /api/links/${BRAIN}`)}`,
          "",
          "## Skipped",
          `- attach ${TAG_C}`,
          `- remove ${TAG}`,
          "",
          "## Next",
          `${IN_PART}${STOPPED}${REST}`,
        ].join("\n"),
      );
      expect(writes(calls)).toEqual([`POST /api/links/${BRAIN}`, `POST /api/links/${BRAIN}`]);
    });

    it("a tag deleted since the check is refused at its turn, without a word that nothing was written", async () => {
      let reads = 0;
      const { call } = await connect(
        routes([
          [`GET /api/thoughts/${BRAIN}/${TAG_B}`, () => ((reads += 1) > 1 ? 404 : thought("b", { id: TAG_B, kind: 4 }))],
        ]),
      );
      const result = await call("brain_tag", { brainId: BRAIN, thoughtId: THOUGHT, add: [TAG, TAG_B] });

      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        [
          "## Done",
          `- attached ${TAG}`,
          "",
          "## Failed",
          `- attach ${TAG_B}: tagId ${TAG_B} is not a tag: no thought in this brain has that ` +
            "identifier. Take tag identifiers from brain_list_types_and_tags.",
          "",
          "## Next",
          `${IN_PART}. ${REST}`,
        ].join("\n"),
      );
    });

    it("the first write failing says what was not tried after it, and one tag alone fails as it did", async () => {
      const { call, calls } = await connect(routes([["POST /api/links/", boom]]));
      const result = await call("brain_tag", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        add: [TAG, TAG_B],
        remove: [TAG_C],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        [
          "## Failed",
          `- attach ${TAG}: ${failed500(`POST /api/links/${BRAIN}`)}`,
          "",
          "## Skipped",
          `- attach ${TAG_B}`,
          `- remove ${TAG_C}`,
          "",
          "## Next",
          `${AT_FIRST}${NOT}${STOPPED}${REST}`,
        ].join("\n"),
      );
      expect(writes(calls)).toHaveLength(1);

      const alone = await connect(routes([["POST /api/links/", boom]]));
      const one = await alone.call("brain_tag", { brainId: BRAIN, thoughtId: THOUGHT, add: [TAG] });
      expect(one.isError).toBe(true);
      expect(one.text).toBe(failed500(`POST /api/links/${BRAIN}`));
    });

    it("a tag taken off a thought nobody has is an error, not a tag that was not on it", async () => {
      // The lookup behind a removal is a 404 for such a thought, as for a
      // tag that is not on one, and the answer used to be "was not on the
      // thought", in a result that was no error.
      const gone =
        `No thought in this brain has the identifier ${NOBODY} ` +
        `(GET /api/thoughts/${BRAIN}/${NOBODY}).${TAKE}`;
      const { call, calls } = await connect(routes());
      const result = await call("brain_tag", { brainId: BRAIN, thoughtId: NOBODY, remove: [TAG] });

      expect(result.isError).toBe(true);
      expect(result.text).toBe(gone);
      expect(writes(calls)).toEqual([]);

      // With more to remove, the rest is listed as not tried.
      const more = await connect(routes());
      const two = await more.call("brain_tag", {
        brainId: BRAIN,
        thoughtId: NOBODY,
        remove: [TAG, TAG_B],
      });
      expect(two.isError).toBe(true);
      expect(two.text).toContain(`## Failed\n- remove ${TAG}: ${gone}\n\n## Skipped\n- remove ${TAG_B}\n`);
      expect(two.text).not.toContain("was not on the thought");
      expect(writes(more.calls)).toEqual([]);
    });

    it("a tag that was not on a thought that is there reads as it did, at one read a call", async () => {
      const { call, calls } = await connect(routes());
      const result = await call("brain_tag", { brainId: BRAIN, thoughtId: THOUGHT, remove: [TAG, TAG_B] });

      expect(result.isError).toBe(false);
      expect(result.text).toBe(
        [
          "## Done",
          `- tag ${TAG} was not on the thought`,
          `- tag ${TAG_B} was not on the thought`,
          "",
          NOTE,
        ].join("\n"),
      );
      // The two tags, the first lookup, the thought, the second lookup.
      expect(requests(calls)).toEqual([
        `GET /api/thoughts/${BRAIN}/${TAG}`,
        `GET /api/thoughts/${BRAIN}/${TAG_B}`,
        `GET /api/links/${BRAIN}/${THOUGHT}/${TAG}`,
        `GET /api/thoughts/${BRAIN}/${THOUGHT}`,
        `GET /api/links/${BRAIN}/${THOUGHT}/${TAG_B}`,
      ]);
    });

    it("written whole it reads as it did, to the character, and a removal that finds its tag reads no thought", async () => {
      const { call, calls } = await connect(routes([], tagLink));
      const result = await call("brain_tag", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        add: [TAG_B],
        remove: [TAG],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toBe(
        ["## Done", `- attached ${TAG_B}`, `- removed ${TAG}`, "", NOTE].join("\n"),
      );
      expect(requests(calls)).not.toContain(`GET /api/thoughts/${BRAIN}/${THOUGHT}`);
    });
  });

  describe("brain_delete_thought", () => {
    /** Deletion allowed, and an index that takes a removal or throws on it. */
    const deleting = (remove: () => void) => () => ({
      config: { allowDestructive: true },
      store: () => ({ remove }),
    });
    const deleted = (active: unknown): Route[] => [["GET /graph", () => graph(active)], ...routes()];

    it("an index that fails after the deletion does not read as a deletion that failed", async () => {
      // The index's error used to be the whole result, for a thought that
      // was gone for good.
      const { call, calls } = await connect(
        deleted(thought("RAG")),
        deleting(() => {
          throw new Error("database is locked");
        }),
      );
      const result = await call("brain_delete_thought", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        confirm: true,
      });

      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        [
          "## Done",
          '- "RAG" is gone from the brain',
          "",
          "## Failed",
          "- its entry in the semantic index: database is locked",
          "",
          "## Next",
          `${IN_PART}. The thought is deleted, and is not to be deleted again. Its entry stays ` +
            "in the semantic index until brain_index is run with action=sync.",
        ].join("\n"),
      );
      expect(writes(calls)).toEqual([`DELETE /api/thoughts/${BRAIN}/${THOUGHT}`]);
    });

    it("written whole it reads as it did, to the character", async () => {
      const removed: string[][] = [];
      const { call } = await connect(
        deleted(thought("RAG")),
        deleting((...args: unknown[]) => void removed.push(args[0] as string[])),
      );
      const asked = await call("brain_delete_thought", { brainId: BRAIN, thoughtId: THOUGHT });
      expect(asked.isError).toBe(true);
      expect(asked.text).toMatch(/^Delete the thought "RAG"\?\n\n- links: 0\n- children: 0\n/);

      const result = await call("brain_delete_thought", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        confirm: true,
      });
      expect(result.isError).toBe(false);
      expect(result.text).toBe('## Deleted\n"RAG" is gone from the brain');
      expect(removed).toEqual([[THOUGHT]]);
    });

    it("a type or a tag is marked in the question and in the answer, as a read result marks one", async () => {
      for (const [kind, mark] of [
        [2, "[type]"],
        [4, "[tag]"],
      ] as const) {
        const { call } = await connect(
          deleted(thought("gotcha", { kind })),
          deleting(() => undefined),
        );
        const asked = await call("brain_delete_thought", { brainId: BRAIN, thoughtId: THOUGHT });
        expect(asked.text, mark).toMatch(new RegExp(`^Delete the thought "gotcha" \\${mark}\\?\\n`));

        const result = await call("brain_delete_thought", {
          brainId: BRAIN,
          thoughtId: THOUGHT,
          confirm: true,
        });
        expect(result.text, mark).toBe(`## Deleted\n"gotcha" ${mark} is gone from the brain`);
      }
    });
  });
});

describe("what brain_ingest says of a batch written in part", () => {
  const NOBODY = "99999999-0000-4000-8000-000000000009";
  const TAG = "ffffffff-0000-4000-8000-000000000006";
  const HELD = "eeeeeeee-0000-4000-8000-000000000005";
  const FENCED = "```\ncode\n```\n";
  const WARNING = (names: string) =>
    "## Warning\nTheBrain drops the closing ``` on save, so notes with fenced code blocks " +
    `will be corrupted: ${names}. Prefer indenting code by four spaces.`;
  type Create = { name: string; sourceThoughtId?: string };
  /** The identifier a thought of each name is created with. */
  const ID: Record<string, string> = {
    Kept: "11111111-0000-4000-8000-000000000001",
    Lost: "22222222-0000-4000-8000-000000000002",
    Same: "33333333-0000-4000-8000-000000000003",
  };

  /**
   * A brain where PARENT is an ordinary thought with `children` under it,
   * TAG is a tag and nobody has NOBODY. A thought is created with the
   * identifier `ID` has for its name; `first` goes ahead of the routes.
   */
  const routes = (first: Route[] = [], children: unknown[] = []): Route[] => [
    ...first,
    ["GET /api/brains/", () => ({ id: BRAIN, name: "brain", homeThoughtId: PARENT })],
    [
      "GET /graph",
      (url) =>
        url.pathname.includes(NOBODY)
          ? generic403()
          : { ...graph(thought("parent", { id: PARENT })), children },
    ],
    [
      "GET /api/thoughts/",
      (url) => {
        const id = url.pathname.split("/").pop()!;
        if (id === NOBODY) return 404;
        return { ...thought("Constraints", { aliases: [] }), id, kind: id === TAG ? 4 : 1 };
      },
    ],
    [
      "POST /api/thoughts/",
      (_url, body) => {
        const asked = body as Create;
        return asked.sourceThoughtId === NOBODY
          ? new Response(JSON.stringify(`Source Thought ${NOBODY} could not be located`), {
              status: 404,
              headers: { "content-type": "application/json" },
            })
          : { id: ID[asked.name] ?? THOUGHT };
      },
    ],
    ["POST /api/notes/", () => 200],
    ["PATCH /api/thoughts/", () => 200],
    ["POST /api/links/", () => ({ id: LINK })],
    ["GET /api/links/", () => 404],
  ];
  const boom = (): Response => new Response(JSON.stringify("boom"), { status: 500 });

  it("the warning about code fences names only the notes that were written", async () => {
    // It used to name every plan thought with a fenced note: the one that
    // was not created, and the one whose note failed, as notes that "will be
    // corrupted".
    const { call } = await connect(
      routes([[`POST /api/notes/${BRAIN}/${ID["Lost"]}`, boom]]),
    );
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [
        { tempId: "kept", name: "Kept", parent: PARENT, note: FENCED },
        { tempId: "lost", name: "Lost", parent: PARENT, note: FENCED },
        { tempId: "gone", name: "Gone", parent: NOBODY, note: FENCED },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(`${WARNING("Kept")}\n`);
    expect(result.text).toContain(
      [
        "## Failed",
        `- thought "Gone" (gone): Source Thought ${NOBODY} could not be located`,
        `- note for "Lost" (${ID["Lost"]}): boom`,
      ].join("\n"),
    );
  });

  it("with no fenced note written there is no such warning, and written whole it reads as it did", async () => {
    const none = await connect(routes([["POST /api/notes/", boom]]));
    const failed = await none.call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [{ tempId: "lost", name: "Lost", parent: PARENT, note: FENCED }],
    });
    expect(failed.isError).toBe(true);
    expect(failed.text).not.toContain("## Warning");

    const whole = await connect(routes());
    const result = await whole.call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [
        { tempId: "kept", name: "Kept", parent: PARENT, note: FENCED },
        { tempId: "lost", name: "Lost", parent: PARENT, note: FENCED },
        { tempId: "plain", name: "Plain", parent: PARENT, note: "prose" },
      ],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain(
      `- notes written: 3\n- tags attached: 0\n\n${WARNING("Kept, Lost")}\n\n## Next\n`,
    );
  });

  it("a note, a tag and an alias that fail name their thought by identifier", async () => {
    // By title alone, `note for "Same"`, the line could be either of two
    // plan thoughts, and the tool that writes the note takes an identifier.
    const { call } = await connect(
      routes(
        [
          ["POST /api/notes/", boom],
          ["POST /api/links/", (_url, body) => ((body as { relation: number }).relation === 2 ? boom() : { id: LINK })],
          ["PATCH /api/thoughts/", boom],
        ],
        [{ id: HELD, name: "Held", kind: 1 }],
      ),
    );
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [
        { tempId: "same", name: "Same", parent: PARENT, note: "body", tagIds: [TAG] },
        { tempId: "held", name: "Held", parent: PARENT, aliases: ["H"] },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      [
        "## Failed",
        `- note for "Same" (${ID["Same"]}): boom`,
        `- tag ${TAG} on "Same" (${ID["Same"]}): boom`,
        `- aliases for "Held" (${HELD}): boom`,
      ].join("\n"),
    );
  });

  it("two plan items for one thought that fails are one line under Failed, and the other is skipped", async () => {
    // Both used to stand under Failed with the one reason, as if two
    // requests had been refused.
    const { call, sent } = await connect(routes());
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [
        { tempId: "x", name: "Same", parent: NOBODY },
        { tempId: "y", name: "Same", parent: NOBODY },
        { tempId: "under", name: "Leaf", parent: "y" },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      [
        "## Failed",
        `- thought "Same" (x): Source Thought ${NOBODY} could not be located`,
        "",
        "## Skipped",
        '- thought "Same" (y): is the same thought as "x", which was not created',
        '- thought "Leaf" (under): depends on "x", which was not created',
        "",
        "## Next",
        "None of the plan's thoughts was written",
      ].join("\n"),
    );
    expect(sent("POST")).toHaveLength(1);
  });

  it("a thought the plan found in place that is a type or a tag is marked, and an ordinary one is not", async () => {
    // A type or a tag can hang under a thought as an ordinary child, and
    // the plan's thought of that name lands on it. It was listed like any
    // other, and what the plan put under it was refused.
    const TYPE = "eeeeeeee-0000-4000-8000-00000000000e";
    const { call } = await connect(
      routes(
        [],
        [
          { id: TYPE, name: "Pattern", kind: 2 },
          { id: TAG, name: "gotcha", kind: 4 },
          { id: HELD, name: "Held", kind: 1 },
        ],
      ),
    );
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [
        { tempId: "p", name: "Pattern", parent: PARENT },
        { tempId: "g", name: "gotcha", parent: PARENT },
        { tempId: "h", name: "Held", parent: PARENT },
        { tempId: "k", name: "Kept", parent: PARENT },
      ],
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain(
      [
        "## Thoughts",
        "Outcome  Title    Identifier",
        "───────  ───────  ───────────────────────────────────────────",
        `created  Kept     ${ID["Kept"]}`,
        `existed  Pattern  ${TYPE} [type]`,
        `existed  gotcha   ${TAG} [tag]`,
        `existed  Held     ${HELD}`,
      ].join("\n"),
    );
  });

  it("a brainId that is no brain stops a plan that names nothing there at one request, with no write", async () => {
    // Such a plan reads nothing ahead of its writes, and each thought at its
    // top used to be listed under Failed with the API's 401, with nothing
    // to say that it was the brainId.
    const { call, calls } = await connect(
      ["GET", "POST"].map(
        (method): Route => [
          `${method} /api/`,
          () =>
            new Response(JSON.stringify(`Access to brain ${BRAIN} is unauthorized.`), {
              status: 401,
              headers: { "content-type": "application/json; charset=utf-8" },
            }),
        ],
      ),
    );
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [
        { tempId: "a", name: "A" },
        { tempId: "b", name: "B", parent: "a" },
        { tempId: "c", name: "C" },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      `Access to brain ${BRAIN} is unauthorized. The key was accepted: it is brainId that ` +
        "names no brain open to it. Take brainId from brain_list. The other identifiers " +
        "in the call were not looked at.",
    );
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /api/brains/${BRAIN}`]);
  });
});

describe("a read that fails inside a tool is not an answer that nothing is there", () => {
  const A = "aaaaaaaa-1111-4000-8000-00000000000a";
  const B = "bbbbbbbb-1111-4000-8000-00000000000b";
  const A1 = "aaaaaaaa-1111-4000-8000-0000000000a1";
  const B1 = "bbbbbbbb-1111-4000-8000-0000000000b1";

  const said = (status: number, text: string) => (): Response =>
    new Response(JSON.stringify(text), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  const boom = said(500, "boom");
  const noAnswer = (): never => {
    // What the client makes of a timeout: the request may have reached TheBrain.
    throw new DOMException("timed out", "TimeoutError");
  };
  const dropped = (): never => {
    // A connection that was open and went away, which is not one refused.
    const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    throw new TypeError("fetch failed", { cause });
  };

  /** What each failure reads as, for the request that met it. */
  const failed500 = (request: string): string =>
    `TheBrain failed with a 500 (${request}): boom. The fault is inside the app, not in the ` +
    "arguments of this call. A read is safe to repeat; before repeating a write, check what it left.";
  const APP = " Check that the TheBrain desktop app is running and its local API is enabled.";
  const NO_ANSWER = `request exceeded 30000 ms.${APP}`;
  const UNREACHED = `could not reach http://localhost:11522 — is TheBrain running?${APP}`;
  const catchAll = (request: string): string =>
    `TheBrain answered 403 and named no cause (${request}). ` +
    (request.includes("/api/notes/")
      ? "The read of a note gets that answer for a moment after the note is deleted, and it " +
        "says nothing of the thought or of its identifier."
      : "That is its answer when an identifier in the call names nothing in this brain. It " +
        "may have been deleted, or be another brain's. Take identifiers from brain_search " +
        "or brain_get_thought.");
  /** Each way a read is failed here: its name, the answer, and what that reads as. */
  const FAILURES: Array<[string, () => unknown, (request: string) => string]> = [
    ["a 500", boom, failed500],
    ["no answer", noAnswer, () => NO_ANSWER],
    ["a dropped connection", dropped, () => UNREACHED],
    ["the catch-all 403", generic403, catchAll],
  ];

  const NOTE = `GET /api/notes/${BRAIN}/${THOUGHT}`;
  /** A note as the API sends it, 18 characters of it. */
  const held = { modificationDateTime: "2026-10-10T12:00:00", markdown: "The original note." };
  const requests = (calls: Array<{ method: string; path: string }>): string[] =>
    calls.map((c) => `${c.method} ${c.path}`);
  const writes = (calls: Array<{ method: string; path: string }>): string[] =>
    requests(calls.filter((c) => c.method !== "GET"));
  const MALFORMED =
    'thoughtId must be a UUID, got "nope". Take identifiers from brain_list, brain_search ' +
    "or brain_get_thought — do not invent them.";
  const REJECTED_KEY =
    "TheBrain rejected the key. Check THEBRAIN_API_KEY: find it under Settings > User > Local API Key.";
  const invalidKey = (): Response => new Response("Invalid API Key", { status: 401 });

  describe("brain_get_thought", () => {
    const shown = { ...graph(thought("RAG")), parents: [thought("Retrieval", { id: PARENT })] };
    const HEAD = `# RAG\n${THOUGHT}\n\n## Parents\n- Retrieval — ${PARENT}`;
    const view = async (routes: Route[]) => {
      const { call } = await connect([...routes, ["GET /graph", () => shown]]);
      return call("brain_get_thought", { brainId: BRAIN, thoughtId: THOUGHT });
    };

    it.each(FAILURES)("its note failing to read with %s is not a thought with no note", async (_name, fails, reads) => {
      // The failure used to be dropped: the thought was printed with no Note
      // section and no error, which is what a thought with no note prints.
      const result = await view([["GET /api/notes/", fails]]);

      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        `${HEAD}\n\n## Note not read\nThe read of this thought's note failed, so this result ` +
          `does not say whether it has one: ${reads(NOTE)} The rest is as TheBrain returned ` +
          "it. Call brain_get_thought again before relying on the note or replacing it.",
      );
    });

    it("a thought with no note, and one with a note, read as they did, to the character", async () => {
      expect(await view([["GET /api/notes/", () => noNote]])).toEqual({
        isError: false,
        text: HEAD,
      });
      expect(await view([["GET /api/notes/", () => held]])).toEqual({
        isError: false,
        text: `${HEAD}\n\n## Note\nThe original note.`,
      });
    });

    it("its graph failing to read is the call's own failure, as it was, whatever became of the note", async () => {
      for (const note of [() => noNote, boom]) {
        const result = await view([
          ["GET /graph", boom],
          ["GET /api/notes/", note],
        ]);
        expect(result).toEqual({
          isError: true,
          text: failed500(`GET /api/thoughts/${BRAIN}/${THOUGHT}/graph`),
        });
      }
    });
  });

  describe("brain_set_note", () => {
    /** A thought whose note is `held`, and which takes a write; `first` goes ahead. */
    const set = async (first: Route[] = [], args: Record<string, unknown> = {}) => {
      const { call, calls } = await connect([
        ...first,
        ["GET /api/notes/", () => held],
        ["POST /api/notes/", () => 200],
      ]);
      const result = await call("brain_set_note", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        markdown: "The replacement.",
        ...args,
      });
      return { result, calls };
    };

    it.each(FAILURES)("a note it could not read, with %s, is not written over", async (_name, fails, reads) => {
      // The failure used to be dropped: the note was replaced, and the result
      // was "note created", of a note of 18 characters it had not seen.
      const { result, calls } = await set([["GET /api/notes/", fails]]);

      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        "The note was not replaced, and nothing was written. The note this thought has now " +
          `could not be read, so what a replacement would erase is not known: ${reads(NOTE)} ` +
          "Read it with brain_get_thought, then send this call again.",
      );
      expect(writes(calls)).toEqual([]);
    });

    it("a failure that is about the call, and not about the read, is explained as it was", async () => {
      const malformed = await set([], { thoughtId: "nope" });
      expect(malformed.result).toEqual({ isError: true, text: MALFORMED });
      expect(malformed.calls).toEqual([]);

      const key = await set([["GET /api/notes/", invalidKey]]);
      expect(key.result).toEqual({ isError: true, text: REJECTED_KEY });
      expect(writes(key.calls)).toEqual([]);
    });

    it("a write that got no answer says the note may be replaced, and what it held before", async () => {
      // It used to be the network's message alone, over a note that was gone.
      const next = (before: string): string =>
        `${NO_ANSWER}\n\n## Next\nNo answer came to the write, so TheBrain may have replaced ` +
        `the note all the same. ${before} Read the thought with brain_get_thought to see ` +
        "which text it has. Sent again, this call writes the same text.";

      const over = await set([["POST /api/notes/", noAnswer]]);
      expect(over.result).toEqual({
        isError: true,
        text: next("Before the call the note held 18 characters, and they are gone if it did."),
      });
      expect(writes(over.calls)).toEqual([`POST /api/notes/${BRAIN}/${THOUGHT}/update`]);

      const fresh = await set([
        ["GET /api/notes/", () => noNote],
        ["POST /api/notes/", noAnswer],
      ]);
      expect(fresh.result.text).toBe(next("The thought had no note before the call."));
    });

    it("a write that is answered with a refusal is the error it was", async () => {
      const { result } = await set([["POST /api/notes/", boom]]);
      expect(result).toEqual({
        isError: true,
        text: failed500(`POST /api/notes/${BRAIN}/${THOUGHT}/update`),
      });
    });

    it("written whole it reads as it did, to the character", async () => {
      const over = await set();
      expect(over.result).toEqual({
        isError: false,
        text: "## Done\nnote replaced; the previous text (18 characters) is gone",
      });
      expect(requests(over.calls)).toEqual([NOTE, `POST /api/notes/${BRAIN}/${THOUGHT}/update`]);

      const fresh = await set([["GET /api/notes/", () => noNote]], { markdown: "```\ncode\n```\n" });
      expect(fresh.result).toEqual({
        isError: false,
        text:
          "## Done\nnote created\n\n## Warning\nthis note contains a fenced code block — " +
          "TheBrain drops the closing ``` on save and the rest of the text gets swallowed " +
          "into the block. Prefer indenting code by four spaces",
      });
    });
  });

  describe("brain_append_note", () => {
    const append = async (first: Route[] = [], args: Record<string, unknown> = {}) => {
      const { call, calls, sent } = await connect([
        ...first,
        ["GET /api/notes/", () => held],
        ["POST /api/notes/", () => 200],
      ]);
      const result = await call("brain_append_note", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        markdown: "Appended.",
        ...args,
      });
      return { result, calls, sent };
    };

    it.each(FAILURES)("the read ahead of its write failing with %s says that nothing was appended", async (_name, fails, reads) => {
      // Nothing was sent to write then, as before. The result used to be the
      // read's error alone, which after a timeout is the same sentence a
      // write with no answer gets.
      const { result, calls } = await append([["GET /api/notes/", fails]]);

      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        "Nothing was appended. The note is read before it is added to, and that read " +
          `failed: ${reads(NOTE)} This call can be sent again as it is.`,
      );
      expect(writes(calls)).toEqual([]);
    });

    it("a write that got no answer says the text may be there, and to read the note before sending it again", async () => {
      // The append is the one write whose repeat is not the same write. The
      // result used to be the network's message alone, and the call sent
      // again put the text in the note twice.
      for (const [note, write] of [
        [held, "append"],
        // With no note the text goes out as an update: it may be there as much.
        [noNote, "update"],
      ] as const) {
        const { result, calls } = await append([
          ["GET /api/notes/", () => note],
          ["POST /api/notes/", noAnswer],
        ]);
        expect(result, write).toEqual({
          isError: true,
          text:
            `${NO_ANSWER}\n\n## Next\nNo answer came to the write, so TheBrain may have ` +
            "appended the text all the same. Read the note with brain_get_thought before " +
            "sending this call again: sent again after an append that went through, the " +
            "text would be in the note twice.",
        });
        expect(writes(calls), write).toEqual([`POST /api/notes/${BRAIN}/${THOUGHT}/${write}`]);
      }
    });

    it("a write that is answered with a refusal is the error it was", async () => {
      const failed = await append([["POST /api/notes/", boom]]);
      expect(failed.result).toEqual({
        isError: true,
        text: failed500(`POST /api/notes/${BRAIN}/${THOUGHT}/append`),
      });

      // A refusal in the API's own words is passed on with its request.
      const refusal = `Could not update note for thought ${THOUGHT}`;
      const refused = await append([["POST /api/notes/", said(400, refusal)]]);
      expect(refused.result).toEqual({
        isError: true,
        text: `${refusal} (POST /api/notes/${BRAIN}/${THOUGHT}/append)`,
      });
    });

    it("a failure that is about the call, and not about the read, is explained as it was", async () => {
      const malformed = await append([], { thoughtId: "nope" });
      expect(malformed.result).toEqual({ isError: true, text: MALFORMED });
      expect(malformed.calls).toEqual([]);

      const key = await append([["GET /api/notes/", invalidKey]]);
      expect(key.result).toEqual({ isError: true, text: REJECTED_KEY });
      expect(writes(key.calls)).toEqual([]);
    });

    it("written whole it reads as it did, to the character", async () => {
      const { result, calls, sent } = await append();
      expect(result).toEqual({ isError: false, text: "## Done\ntext appended to the note" });
      expect(requests(calls)).toEqual([NOTE, `POST /api/notes/${BRAIN}/${THOUGHT}/append`]);
      expect(sent("POST")).toEqual([{ markdown: "\n\nAppended." }]);
    });
  });

  describe("brain_delete_thought", () => {
    const deleting = () => ({
      config: { allowDestructive: true },
      store: () => ({ remove: () => undefined }),
    });
    const routes = (first: Route[] = []): Route[] => [
      ...first,
      ["GET /graph", () => graph(thought("RAG"))],
      ["GET /api/notes/", () => held],
      ["DELETE /api/", () => 200],
    ];
    const ASK =
      "This client cannot display a confirmation form. Ask the user yourself and, once they " +
      "agree, repeat the call with confirm=true. Never do this without explicit human consent.";

    it.each(FAILURES)("its note failing to read with %s puts no question to the person, and deletes nothing", async (_name, fails, reads) => {
      // The failure used to be dropped: the question had no line for the
      // note, and with confirm the thought was deleted, its note with it.
      for (const confirm of [false, true]) {
        const { call, calls } = await connect(routes([["GET /api/notes/", fails]]), deleting);
        const result = await call("brain_delete_thought", {
          brainId: BRAIN,
          thoughtId: THOUGHT,
          confirm,
        });

        expect(result.isError, `confirm ${confirm}`).toBe(true);
        expect(result.text, `confirm ${confirm}`).toBe(
          "Nothing was deleted. The thought's note could not be read, so the question for " +
            `the person could not say whether a note goes with it: ${reads(NOTE)} Call ` +
            "brain_delete_thought again.",
        );
        expect(writes(calls), `confirm ${confirm}`).toEqual([]);
      }
    });

    it("with the note read the question is what it was, to the character, and so is the deletion", async () => {
      const question = (lines: string[]): string =>
        `Delete the thought "RAG"?\n\n${lines.join("\n")}\n\nThis cannot be undone.\n\n${ASK}`;

      const noted = await connect(routes(), deleting);
      const asked = await noted.call("brain_delete_thought", { brainId: BRAIN, thoughtId: THOUGHT });
      expect(asked).toEqual({
        isError: true,
        text: question(["- links: 0", "- children: 0", "- note: 18 characters"]),
      });
      const result = await noted.call("brain_delete_thought", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        confirm: true,
      });
      expect(result).toEqual({ isError: false, text: '## Deleted\n"RAG" is gone from the brain' });
      expect(writes(noted.calls)).toEqual([`DELETE /api/thoughts/${BRAIN}/${THOUGHT}`]);

      // A thought with no note has no such line, as before.
      const bare = await connect(routes([["GET /api/notes/", () => noNote]]), deleting);
      expect(
        (await bare.call("brain_delete_thought", { brainId: BRAIN, thoughtId: THOUGHT })).text,
      ).toBe(question(["- links: 0", "- children: 0"]));
    });
  });

  describe("brain_traverse", () => {
    const at = (id: string, name: string) => thought(name, { id });
    /** RAG over Retrieval and Generation, each over one thought of its own. */
    const GRAPHS: Record<string, unknown> = {
      [THOUGHT]: { ...graph(thought("RAG")), children: [at(A, "Retrieval"), at(B, "Generation")] },
      [A]: { ...graph(at(A, "Retrieval")), children: [at(A1, "Chunking")] },
      [B]: { ...graph(at(B, "Generation")), children: [at(B1, "Prompting")] },
    };
    const graphOf = (id: string): string => `GET /api/thoughts/${BRAIN}/${id}/graph`;
    /** A walk two hops down, with the graphs of `failing` answered by what it has for them. */
    const walk = async (failing: Record<string, () => unknown> = {}) => {
      const { call } = await connect([
        [
          "GET /graph",
          (url) => {
            const id = url.pathname.split("/").at(-2)!;
            return (failing[id] ?? (() => GRAPHS[id]))();
          },
        ],
      ]);
      return call("brain_traverse", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        depth: 2,
        follow: ["child"],
      });
    };
    const HOP_1 =
      "# Neighbourhood of: RAG\n\n## Hop 1\n" +
      `- Retrieval — ${A}  (via RAG)\n- Generation — ${B}  (via RAG)`;
    const UNDER_B = `- Prompting — ${B1}  (via RAG -> Generation)`;
    const ONE =
      "The graph of one thought on the way could not be read, so what lies beyond it is " +
      "missing from this result";
    const TWO =
      "The graphs of 2 thoughts on the way could not be read, so what lies beyond them is " +
      "missing from this result";

    it.each(FAILURES)("a graph on the way failing to read with %s is named, and the rest is walked", async (_name, fails, reads) => {
      // The failure used to be dropped. "Retrieval" stood in its hop like any
      // other, with nothing under it and nothing to say why.
      const result = await walk({ [A]: fails });

      expect(result.isError).toBe(false);
      expect(result.text).toBe(
        [
          HOP_1,
          `## Hop 2\n${UNDER_B}`,
          `## Not read\n${ONE}: ${reads(graphOf(A))}\n- Retrieval — ${A}`,
          "## Totals\nthoughts 4, links 3 (1 not read, there may be more beyond)",
        ].join("\n\n"),
      );
    });

    it("one reason for several is given once, and reasons that differ each on its line", async () => {
      const shared = await walk({ [A]: noAnswer, [B]: noAnswer });
      expect(shared.isError).toBe(false);
      expect(shared.text).toBe(
        [
          HOP_1,
          `## Not read\n${TWO}: ${NO_ANSWER}\n- Retrieval — ${A}\n- Generation — ${B}`,
          "## Totals\nthoughts 3, links 2 (2 not read, there may be more beyond)",
        ].join("\n\n"),
      );

      const apart = await walk({ [A]: boom, [B]: noAnswer });
      expect(apart.text).toContain(
        `## Not read\n${TWO}:\n- Retrieval — ${A}: ${failed500(graphOf(A))}\n` +
          `- Generation — ${B}: ${NO_ANSWER}\n\n## Totals\n`,
      );
    });

    it("the starting thought's graph failing to read is the call's own failure, as it was", async () => {
      expect(await walk({ [THOUGHT]: boom })).toEqual({
        isError: true,
        text: failed500(graphOf(THOUGHT)),
      });
    });

    it("with every graph read it reads as it did, to the character", async () => {
      expect(await walk()).toEqual({
        isError: false,
        text: [
          HOP_1,
          `## Hop 2\n- Chunking — ${A1}  (via RAG -> Retrieval)\n${UNDER_B}`,
          "## Totals\nthoughts 5, links 4",
        ].join("\n\n"),
      });
    });
  });

  describe("brain_list", () => {
    const HOME = "aaaaaaaa-0000-4000-8000-0000000000b2";
    const unindexed = () => ({
      indexer: () => ({ status: () => ({ compatible: false, size: 0 }) }),
    });
    const list = async (state: () => unknown) => {
      const { call } = await connect(
        [
          ["GET /api/app/state", state],
          [
            "GET /api/brains",
            () => [
              { id: BRAIN, name: "Work" },
              { id: HOME, name: "Home" },
            ],
          ],
        ],
        unindexed,
      );
      return call("brain_list", {});
    };
    const open = () => ({
      currentBrainId: BRAIN,
      currentBrainName: "Work",
      activeThoughtId: THOUGHT,
      activeThoughtName: "RAG",
    });
    const RULE = "─".repeat(36);

    it.each(FAILURES)("the app's state failing to read with %s is said, and is not an app with no brain open", async (_name, fails, reads) => {
      // The failure used to be dropped: no row was marked open and no active
      // thought printed, which is what an app with no brain open prints.
      const result = await list(fails);

      // The list is whole, and brainId is never taken from what is open.
      expect(result.isError).toBe(false);
      expect(result.text).toBe(
        [
          "## Brains",
          "Name  Identifier                              Semantic",
          `────  ${RULE}    ────────`,
          `Work  ${BRAIN}    no index`,
          `Home  ${HOME}    no index`,
          "",
          "## Open brain not read",
          "Which brain is open in the app, and its active thought, could not be read: " +
            `${reads("GET /api/app/state")} The brains above are all of them.`,
        ].join("\n"),
      );
    });

    it("with the state read it reads as it did, to the character", async () => {
      expect(await list(open)).toEqual({
        isError: false,
        text: [
          "## Brains",
          "Name  Identifier                                  Semantic",
          `────  ${RULE}  ────  ────────`,
          `Work  ${BRAIN}  open  no index`,
          `Home  ${HOME}        no index`,
          "",
          "## Active thought",
          `RAG (${THOUGHT})`,
        ].join("\n"),
      });
      // An app with no brain open: no mark, no active thought, and no word of a failure.
      const closed = await list(() => ({ currentBrainId: null, activeThoughtName: null }));
      expect(closed.isError).toBe(false);
      expect(closed.text).not.toMatch(/open|Active thought|not read/);
    });
  });
});
