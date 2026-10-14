/**
 * Tools end to end: a real MCP client talking to the registered handlers over
 * an in-memory transport, with only HTTP faked.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";

import { READ_BACK, TheBrainApi } from "../src/api/index.js";
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

/** Past the wait for a write to read back, by a margin. */
const PAST_READ_BACK = READ_BACK.timeoutMs + 1000;

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
 *
 * `elicit`, when given, makes the client one that shows a form: it answers
 * each question the server puts, as a person would through it.
 */
async function connect(
  routes: Route[],
  context: (api: TheBrainApi) => Record<string, unknown> = () => ({}),
  elicit?: (message: string) => ElicitResult | Promise<ElicitResult>,
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
  const client =
    elicit === undefined
      ? new Client({ name: "test-client", version: "0" })
      : new Client({ name: "test-client", version: "0" }, { capabilities: { elicitation: {} } });
  if (elicit !== undefined) {
    client.setRequestHandler(ElicitRequestSchema, async (request) =>
      elicit(request.params.message),
    );
  }
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

/**
 * What a tool says of a note TheBrain did not keep whole, after the lines it
 * names: the two rules by which a line goes, and what to do about it.
 */
const FENCE_RULE =
  "TheBrain deletes the last line that begins with ``` when a note has an odd number of " +
  "them, with whatever else is on that line, and a code block with nothing between its " +
  "two ``` lines.";
const WRITE_IT_AGAIN =
  "with brain_get_thought, and write it again with brain_set_note with a ``` line before " +
  "each code block and one after it, each at the start of its line, and no other line " +
  "that begins with ```.";
/** A note whose code block is left open: TheBrain deletes its third line. */
const OPEN_FENCE = "intro\n\n```js\ncode();\n";
const NOT_KEPT = (of = "this note"): string =>
  `TheBrain did not keep line 3, "\`\`\`js", of ${of}. ${FENCE_RULE} Read the note ${WRITE_IT_AGAIN}`;

/** What the API answers for the graph of an identifier nobody has, and for much else. */
const GENERIC_403 =
  "To use the TheBrain API, make requests to /api (e.g. /api/brains). " +
  "An API key is required via the Authorization header.";
const generic403 = (): Response =>
  new Response(JSON.stringify(GENERIC_403), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
/** A 200 whose connection fails once its status has come, before its body. */
const brokenOff = (): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError("terminated", { cause: new Error("other side closed") }));
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/** What `describeError()` adds to an identifier nobody has, */
const NOBODY_HAS_IT =
  " It may have been deleted, or be another brain's. Take identifiers from brain_search " +
  "or brain_get_thought.";
/** and its sentence for a 500 with the body "boom", by the request that met it. */
const boomAt = (request: string): string =>
  `TheBrain failed with a 500 (${request}): boom. The fault is inside the app, not in the ` +
  "arguments of this call. A read is safe to repeat; before repeating a write, check what " +
  "it left.";

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

  it("the note is in its own section, and not among the attachments as well", async () => {
    // The API lists a thought's note as one of its attachments, and it stood
    // under Attachments as "(unnamed) — Notes.md", beside the Note section.
    const notesFile = { id: LINK, name: null, location: "Notes.md", isNotes: true };
    const page = { id: PARENT, name: "Spec", location: "https://example.com/spec", isNotes: false };
    const read = async (attachments: unknown[]): Promise<string> => {
      const { call } = await connect([
        ["GET /graph", () => ({ ...graph(thought("RAG")), attachments })],
        ["GET /api/notes", () => ({ modificationDateTime: "2026-10-10T12:00:00", markdown: "Body." })],
      ]);
      const result = await call("brain_get_thought", { brainId: BRAIN, thoughtId: THOUGHT });
      expect(result.isError).toBe(false);
      return result.text;
    };
    expect(await read([notesFile])).toBe(`# RAG\n${THOUGHT}\n\n## Note\nBody.`);
    expect(await read([notesFile, page])).toBe(
      `# RAG\n${THOUGHT}\n\n## Attachments\n- Spec — https://example.com/spec\n\n## Note\nBody.`,
    );
    // Without a note among them the list is what it was.
    expect(await read([page, { id: BRAIN, name: null, location: null }])).toBe(
      `# RAG\n${THOUGHT}\n\n## Attachments\n- Spec — https://example.com/spec\n- (unnamed)\n\n## Note\nBody.`,
    );
  });
});

describe("a text from the brain that is what no rows read as, or that shows nothing", () => {
  // No rows used to render as the text "(empty)", and section() dropped that
  // text wherever it came from. A note and a thought's one tag of that name
  // went missing from brain_get_thought, which read as no note and no tag.
  const TAG = "ffffffff-0000-4000-8000-000000000006";
  const CHILD = "abababab-0000-4000-8000-000000000007";
  const at = (id: string, name: string, kind = 1) => thought(name, { id, kind });
  const noted = (markdown: string) => ({ modificationDateTime: "2026-10-10T12:00:00", markdown });
  const view = async (shown: unknown, note: unknown): Promise<string> => {
    const { call } = await connect([
      ["GET /graph", () => shown],
      ["GET /api/notes", () => note],
    ]);
    const result = await call("brain_get_thought", { brainId: BRAIN, thoughtId: THOUGHT });
    expect(result.isError).toBe(false);
    return result.text;
  };

  it("brain_get_thought prints a note, a tag, an alias and a neighbour named \"(empty)\"", async () => {
    const shown = {
      ...graph(thought("Mercury", { aliases: ["(empty)"] })),
      tags: [at(TAG, "(empty)", 4)],
      children: [at(CHILD, "(empty)")],
    };
    expect(await view(shown, noted("(empty)"))).toBe(
      [
        "# Mercury",
        THOUGHT,
        "",
        "## Aliases",
        "- (empty)",
        "",
        "## Tags",
        "(empty)",
        "",
        "## Children",
        `- (empty) — ${CHILD}`,
        "",
        "## Note",
        "(empty)",
      ].join("\n"),
    );
  });

  it("a note of white space alone reads as none, as TheBrain reads it; one of what does not show is spelled out", async () => {
    // TheBrain keeps white space alone in the note's file and reads it as ""
    // with the time it was written (contract test): there is nothing to print.
    expect(await view(graph(thought("RAG")), noted(""))).toBe(`# RAG\n${THOUGHT}`);
    // A byte order mark alone is read back as one, and trim() took it for no
    // note; a zero width space alone stood under its heading as nothing.
    expect(await view(graph(thought("RAG")), noted("\ufeff"))).toBe(
      `# RAG\n${THOUGHT}\n\n## Note\n(no visible character: U+FEFF)`,
    );
    expect(await view(graph(thought("RAG")), noted("\u200b\n"))).toBe(
      `# RAG\n${THOUGHT}\n\n## Note\n(no visible character: U+200B U+000A)`,
    );
    // A note with something that shows is printed as it is, blanks and all.
    expect(await view(graph(thought("RAG")), noted("  a\u200b \n"))).toBe(
      `# RAG\n${THOUGHT}\n\n## Note\n  a\u200b \n`,
    );
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

    // What is above a thought by a link that is no parent's: the API lists it
    // among the parents as well (docs/api-map.md, L44).
    const SECOND = "cdcdcdcd-0000-4000-8000-00000000000c";
    /** The link from `above` down to THOUGHT, as a graph lists it. */
    const from = (above: string, meaning: number) => ({
      id: `${above.slice(0, -1)}9`,
      thoughtIdA: above,
      thoughtIdB: THOUGHT,
      relation: 1,
      meaning,
      name: null,
    });

    it("a tag on a tag is one of its tags, and not a parent", async () => {
      // A link of meaning 7. The upper tag stood under Parents, marked a tag.
      const text = await view({
        ...graph(at(THOUGHT, "gotcha", 4)),
        parents: [at(TAG, "measured", 4)],
        tags: [at(TAG, "measured", 4)],
        links: [from(TAG, 7)],
      });
      expect(text).toBe(`# gotcha\n${THOUGHT} [tag]\n\n## Tags\nmeasured`);
    });

    it("a type with a type has it as its type, and not as a parent", async () => {
      // A link of meaning 3.
      const text = await view({
        ...graph(at(THOUGHT, "Design pattern", 2, { typeId: TYPE })),
        type,
        parents: [type],
        links: [from(TYPE, 3)],
      });
      expect(text).toBe(`# Design pattern\n${THOUGHT} [type]\n\n## Type\nPattern — ${TYPE}`);
    });

    it("a thought with two types lists both under Types, the one typeId names first, and neither as a parent", async () => {
      // The second used to stand under Parents, marked a type, and the API's
      // own `type`, printed under Type, was now and then that one.
      const second = at(SECOND, "Method", 2);
      const text = await view({
        ...graph(thought("RAG", { typeId: TYPE })),
        type: second,
        parents: [second, type, at(PARENT, "Retrieval")],
        links: [from(SECOND, 2), from(TYPE, 2), from(PARENT, 1)],
      });
      expect(text).toBe(
        `# RAG\n${THOUGHT}\n\n## Types\n- Pattern — ${TYPE}\n- Method — ${SECOND}\n` +
          "TheBrain links this thought under both. typeId null in brain_update_thought removes " +
          "both, and a type is set only once they are gone: to keep one, remove both, then " +
          `set it.\n\n## Parents\n- Retrieval — ${PARENT}`,
      );
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

    /**
     * The read of each hit's thought, which a search makes before it lists
     * the hit: the three thoughts as they are, or as `now` has them.
     */
    const reads = (now: Record<string, unknown> = {}): Route => [
      "GET /api/thoughts/",
      (url) => {
        const id = url.pathname.split("/").at(-1)!;
        return now[id] ?? [type, plain, tag].find((t) => t.id === id) ?? 404;
      },
    ];

    const lexical = async (args: Record<string, unknown>): Promise<string> => {
      const { call } = await connect(
        [["GET /api/search", () => [hit(type), hit(plain), hit(tag)]], reads()],
        searching(new VectorStore(":memory:")),
      );
      const result = await call("brain_search", { brainId: BRAIN, query: "RAG", ...args });
      expect(result.isError).toBe(false);
      return result.text;
    };

    const vector = async (
      args: Record<string, unknown>,
      now: Record<string, unknown> = {},
    ): Promise<string> => {
      const { call, calls } = await connect([reads(now)], searching(indexed()));
      const result = await call("brain_search", { brainId: BRAIN, query: "RAG", ...args });
      expect(result.isError).toBe(false);
      // What a hit costs is the read of its thought: nothing else is asked.
      const thoughtRead = /^\/api\/thoughts\/[^/]+\/[^/]+$/;
      expect(calls.filter((c) => c.method !== "GET" || !thoughtRead.test(c.path))).toEqual([]);
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

    it("with an index, a type and a tag fill the same column", async () => {
      const text = await vector({ includeAuxiliary: true });
      expect(text).toContain("## Found by meaning");
      expect(cells(text)).toEqual([
        ["Score", "Thought", "Identifier", "Kind", "Matched"],
        ["1.000", "Pattern", TYPE, "type"],
        ["0.800", "Embeddings", OTHER],
        ["0.600", "gotcha", TAG, "tag"],
      ]);
    });

    it("with an index, the name and the kind are the thought's own, not the index's", async () => {
      // The index keeps both as of its last sync. A search reads each hit's
      // thought to see that it is there, and that read has them as they are.
      const text = await vector(
        { includeAuxiliary: true },
        { [OTHER]: at(OTHER, "Vectors", 4), [TYPE]: at(TYPE, "Pattern", 1) },
      );
      expect(cells(text)).toEqual([
        ["Score", "Thought", "Identifier", "Kind", "Matched"],
        ["1.000", "Pattern", TYPE],
        ["0.800", "Vectors", OTHER, "tag"],
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

    it("with an index of types and tags alone, a default search says why it lists nothing", async () => {
      // It answered with no text at all: not an error, and not a sentence.
      const store = indexed();
      store.remove([OTHER]);
      const { call, calls } = await connect([reads()], searching(store));
      const result = await call("brain_search", { brainId: BRAIN, query: "RAG" });
      expect(result).toEqual({
        isError: false,
        text:
          "## Found by meaning\n" +
          "Nothing: the semantic index holds only types and tags, and a search leaves those " +
          "out unless includeAuxiliary is true. A thought added since the index was last " +
          "synced is not in it: call brain_index with action=sync.",
      });
      // Nothing was ranked, so there was no thought to read.
      expect(calls).toEqual([]);

      // Asked for, they are what it lists.
      const asked = await call("brain_search", {
        brainId: BRAIN,
        query: "RAG",
        includeAuxiliary: true,
      });
      expect(cells(asked.text)).toEqual([
        ["Score", "Thought", "Identifier", "Kind", "Matched"],
        ["1.000", "Pattern", TYPE, "type"],
        ["0.600", "gotcha", TAG, "tag"],
      ]);
    });

    it("no result of a search by vectors is an empty text, whatever was asked for", async () => {
      // With types and tags asked for, an index of any rows ranks one: this
      // takes an index emptied between the look at it and the scan.
      const ranked = {
        matches: [],
        gone: [],
        unverified: [],
        mode: "vector",
        degradedReason: null,
        embedderFailure: null,
        phrasings: 1,
        notSearched: [],
      };
      const { call } = await connect([], () => ({
        search: () => ({ find: async () => ranked }),
      }));
      const result = await call("brain_search", {
        brainId: BRAIN,
        query: "RAG",
        includeAuxiliary: true,
      });
      expect(result).toEqual({
        isError: false,
        text:
          "## Found by meaning\n" +
          "Nothing: the semantic index had no row to rank. Call brain_index with " +
          "action=status to see what it holds.",
      });
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

    it("a tag on a tag and a second type are no ancestors", async () => {
      // Each is above by a link that is no parent's, and the API lists it
      // among the parents: a walk went up to it as to a parent.
      const SECOND = "cdcdcdcd-0000-4000-8000-00000000000c";
      const from = (above: string, meaning: number) => ({
        id: `${above.slice(0, -1)}9`,
        thoughtIdA: above,
        thoughtIdB: THOUGHT,
        relation: 1,
        meaning,
        name: null,
      });
      expect(
        await walk({
          ...graph(at(THOUGHT, "gotcha", 4)),
          parents: [tag],
          tags: [tag],
          links: [from(TAG, 7)],
        }),
      ).toBe("# Neighbourhood of: gotcha [tag]\n\n## Totals\nthoughts 1, links 0");
      const second = at(SECOND, "Method", 2);
      expect(
        await walk({
          ...graph(thought("RAG", { typeId: TYPE })),
          type: second,
          parents: [second, type, plain],
          links: [from(SECOND, 2), from(TYPE, 2), from(OTHER, 1)],
        }),
      ).toBe(
        "# Neighbourhood of: RAG\n\n" +
          `## Hop 1\n- Embeddings — ${OTHER}  (via RAG)\n\n` +
          "## Totals\nthoughts 2, links 1",
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

describe("a thought's label in what the read tools print", () => {
  // The label is on every thought the API returns, in a graph's lists and in
  // /types and /tags alike (contract test), and no read tool printed it: the
  // tools wrote and cleared a label nothing read back. A type is given its
  // name for one, and a rename leaves it there (docs/api-map.md, L38).
  const TYPE = "eeeeeeee-0000-4000-8000-000000000005";
  const TAG = "ffffffff-0000-4000-8000-000000000006";
  const OTHER = "abababab-0000-4000-8000-000000000007";
  const SECOND = "cdcdcdcd-0000-4000-8000-00000000000c";

  const at = (id: string, name: string, kind = 1, label: string | null = null) =>
    thought(name, { id, kind, label });
  const TYPE_LABEL =
    "A type's label may be a name it had, which TheBrain keeps there through a rename and " +
    "finds the type by. label null in brain_update_thought clears it.";

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

    it("a thought's label is read back under its title", async () => {
      expect(await view(graph(at(THOUGHT, "Mercury", 1, "planet")))).toBe(
        `# Mercury\n${THOUGHT}\n\n## Label\nplanet`,
      );
      // Whatever it reads: "(empty)" was the text section() dropped as no rows.
      expect(await view(graph(at(THOUGHT, "Mercury", 1, "(empty)")))).toBe(
        `# Mercury\n${THOUGHT}\n\n## Label\n(empty)`,
      );
      // A tag's too, with nothing more said: a tag is given none.
      expect(await view(graph(at(THOUGHT, "gotcha", 4, "a pitfall")))).toBe(
        `# gotcha\n${THOUGHT} [tag]\n\n## Label\na pitfall`,
      );
    });

    it("a label that is the name, or none, leaves the result as it was, to the character", async () => {
      // Every type has its name for a label, and a type read as it did.
      expect(await view(graph(at(THOUGHT, "Pattern", 2, "Pattern")))).toBe(
        `# Pattern\n${THOUGHT} [type]`,
      );
      expect(await view(graph(at(THOUGHT, "RAG", 1, "RAG")))).toBe(`# RAG\n${THOUGHT}`);
      expect(await view(graph(at(THOUGHT, "RAG", 1, "")))).toBe(`# RAG\n${THOUGHT}`);
      expect(await view(graph(thought("RAG", { label: undefined })))).toBe(`# RAG\n${THOUGHT}`);
    });

    it("a type whose label is not its name is said to carry a name it may have had, and what clears it", async () => {
      expect(await view({ ...graph(at(THOUGHT, "Person", 2, "Persn")), children: [at(OTHER, "Ada")] })).toBe(
        `# Person\n${THOUGHT} [type]\n\n## Label\nPersn\n${TYPE_LABEL}\n\n` +
          `## Thoughts of this type\n- Ada — ${OTHER}`,
      );
    });

    it("a neighbour's label follows its identifier and its mark, when it is not its name", async () => {
      const text = await view(
        {
          ...graph(thought("Planets")),
          parents: [at(PARENT, "Astronomy")],
          // Two of one name, told apart by their labels alone.
          children: [at(OTHER, "Mercury", 1, "planet"), at(SECOND, "Mercury", 1, "element")],
          jumps: [at(TYPE, "Body", 2, "Body"), at(TAG, "Celestial", 2, "Heavenly")],
          siblings: [at(LINK, "Moons", 1, "Moons")],
        },
        { includeSiblings: true },
      );
      expect(text).toBe(
        `# Planets\n${THOUGHT}\n\n## Parents\n- Astronomy — ${PARENT}\n\n` +
          `## Children\n- Mercury — ${OTHER}, label "planet"\n- Mercury — ${SECOND}, label "element"\n\n` +
          `## Jumps\n- Body — ${TYPE} [type]\n- Celestial — ${TAG} [type], label "Heavenly"\n\n` +
          `## Siblings\n- Moons — ${LINK}`,
      );
    });

    it("the label of the thought's type and of its tags is the vocabulary's, and not printed here", async () => {
      const text = await view({
        ...graph(thought("Ada", { typeId: TYPE })),
        type: at(TYPE, "Person", 2, "Persn"),
        tags: [at(TAG, "gotcha", 4, "a pitfall")],
      });
      expect(text).toBe(`# Ada\n${THOUGHT}\n\n## Type\nPerson — ${TYPE}\n\n## Tags\ngotcha`);
    });

    it("a label with no character that shows is spelled out, as a name is", async () => {
      const text = await view({
        ...graph(at(THOUGHT, "Mercury", 1, "\u200b")),
        children: [at(OTHER, "Venus", 1, "\ufeff"), at(SECOND, "Mars", 1, 'the "red" one')],
      });
      expect(text).toBe(
        `# Mercury\n${THOUGHT}\n\n## Label\n(no visible character: U+200B)\n\n` +
          `## Children\n- Venus — ${OTHER}, label (no visible character: U+FEFF)\n` +
          `- Mars — ${SECOND}, label "the \\"red\\" one"`,
      );
    });
  });

  describe("brain_list_types_and_tags", () => {
    const list = async (types: unknown[], tags: unknown[]): Promise<string> => {
      const { call } = await connect([
        [`GET /api/thoughts/${BRAIN}/types`, () => types],
        [`GET /api/thoughts/${BRAIN}/tags`, () => tags],
      ]);
      const result = await call("brain_list_types_and_tags", { brainId: BRAIN });
      expect(result.isError).toBe(false);
      return result.text;
    };

    it("types that read with their names for labels, and tags with none, read as they did", async () => {
      expect(
        await list([at(TYPE, "Pattern", 2, "Pattern")], [at(TAG, "gotcha", 4)]),
      ).toBe(`## Types\n- Pattern — ${TYPE}\n\n## Tags\n- gotcha — ${TAG}`);
    });

    it("a type whose label is not its name shows it, and the list says once what that may be", async () => {
      expect(
        await list(
          [
            at(TYPE, "Person", 2, "Persn"),
            at(OTHER, "Pattern", 2, "Pattern"),
            at(SECOND, "Place", 2, "Locale"),
          ],
          [at(TAG, "gotcha", 4, "a pitfall")],
        ),
      ).toBe(
        `## Types\n- Person — ${TYPE}, label "Persn"\n- Pattern — ${OTHER}\n` +
          `- Place — ${SECOND}, label "Locale"\n${TYPE_LABEL}\n\n` +
          `## Tags\n- gotcha — ${TAG}, label "a pitfall"`,
      );
      // A tag's label alone says nothing of types.
      expect(await list([at(TYPE, "Pattern", 2, "Pattern")], [at(TAG, "gotcha", 4, "x")])).toBe(
        `## Types\n- Pattern — ${TYPE}\n\n## Tags\n- gotcha — ${TAG}, label "x"`,
      );
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
    // One read of each thought that may be there. The log has the deletion of
    // the third, so that one is not asked for.
    expect(read).toEqual([THOUGHT, PARENT]);
  });

  it("a thought the log does not say is deleted is deleted by its read's 404", async () => {
    // Deleted after the log was read, or with its `102` behind an attachment
    // made on it since: the read is what says so, as it was.
    const { rows, read } = await changes([
      [
        "GET /modifications",
        () => [
          entry("00:02", { sourceId: GONE, modType: 202, newValue: "a label" }),
          entry("00:01", { sourceId: GONE }),
          entry("00:00", {}),
        ],
      ],
      ["GET /api/thoughts/", (url) => (url.pathname.endsWith(THOUGHT) ? thought("RAG") : 404)],
    ]);

    expect(rows).toEqual([
      ["label changed", "(deleted)"],
      ["created", "(deleted)"],
      ["created", "RAG"],
    ]);
    expect(read).toEqual([GONE, THOUGHT]);
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

describe("brain_recent_changes, the names the log keeps and the identifiers it has", () => {
  const GONE = "eeeeeeee-0000-4000-8000-000000000005";
  const TYPE = "ffffffff-0000-4000-8000-000000000006";
  const TAG = "abababab-0000-4000-8000-000000000007";
  const NOBODY = "00000000-0000-0000-0000-000000000000";
  const CAP = 60;

  /**
   * A log entry as the API sends it: a thought created, unless `fields` say
   * otherwise. A thought's `101` has its name in `newValue`, its `103` the old
   * name and the new, its `102` the last name in `oldValue`.
   */
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
  const link = (time: string, modType: number, a: string, b: string) =>
    entry(time, {
      sourceId: LINK,
      sourceType: 3,
      modType,
      extraAId: a,
      extraAType: 2,
      extraBId: b,
      extraBType: 2,
    });
  /** A note created on a thought: an entry about it that carries no name. */
  const noted = (time: string, id: string) =>
    entry(time, { sourceId: LINK, sourceType: 4, modType: 801, extraAId: id, extraAType: 2 });

  const id = (i: number): string => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000009`;
  const clock = (second: number): string =>
    `${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}`;

  const rows = (text: string): string[][] =>
    text
      .split("\n")
      .filter((l) => l.startsWith("2026-10-10 12:"))
      .map((l) => l.split(/\s{2,}/).slice(1));

  const changes = async (routes: Route[], args: Record<string, unknown> = {}) => {
    const { call, calls } = await connect(routes);
    const result = await call("brain_recent_changes", {
      brainId: BRAIN,
      since: "2026-10-10T00:00:00Z",
      limit: 500,
      ...args,
    });
    expect(result.isError).toBe(false);
    const read = calls.filter((c) => c.path.includes("/api/thoughts/"));
    return {
      text: result.text,
      rows: rows(result.text),
      read: read.map((c) => c.path.split("/").at(-1)),
      requests: calls.length,
    };
  };

  it("a deleted thought has the name its 102 kept, in every row about it, and is not read", async () => {
    const { rows, read } = await changes([
      [
        "GET /modifications",
        () => [
          entry("00:05", { sourceId: GONE, modType: 102, oldValue: "Final" }),
          link("00:04", 102, THOUGHT, GONE),
          entry("00:03", { sourceId: GONE, modType: 103, oldValue: "Draft", newValue: "Final" }),
          link("00:02", 101, THOUGHT, GONE),
          entry("00:01", { sourceId: GONE, newValue: "Draft" }),
          entry("00:00", { newValue: "RAG" }),
        ],
      ],
      ["GET /api/thoughts/", (url) => (url.pathname.endsWith(THOUGHT) ? thought("RAG") : 404)],
    ]);

    // The name it had when it was deleted, not the one it was created with.
    expect(rows).toEqual([
      ["deleted", "Final (deleted)"],
      ["link deleted", "RAG ↔ Final (deleted)"],
      ["renamed", "Final (deleted)"],
      ["link created", "RAG ↔ Final (deleted)"],
      ["created", "Final (deleted)"],
      ["created", "RAG"],
    ]);
    expect(read).toEqual([THOUGHT]);
  });

  it("a thought its read says is gone is deleted under the name of its 101, when the log has it", async () => {
    const { rows, read } = await changes([
      [
        "GET /modifications",
        () => [
          entry("00:02", { sourceId: GONE, newValue: "Draft" }),
          noted("00:01", PARENT),
          entry("00:00", { newValue: "RAG" }),
        ],
      ],
      ["GET /api/thoughts/", (url) => (url.pathname.endsWith(THOUGHT) ? thought("RAG") : 404)],
    ]);

    expect(rows).toEqual([
      ["created", "Draft (deleted)"],
      ["note created", "(deleted)"],
      ["created", "RAG"],
    ]);
    // The one the log has no name for is read first.
    expect(read).toEqual([PARENT, GONE, THOUGHT]);
  });

  it("the name a thought reads with stands over the one the log has", async () => {
    const { rows } = await changes([
      ["GET /modifications", () => [entry("00:00", { newValue: "As logged" })]],
      ["GET /api/thoughts/", () => thought("As read")],
    ]);
    expect(rows).toEqual([["created", "As read"]]);
  });

  it("past the cap a thought created in the period has the name the log kept, and no mark", async () => {
    // One thought more than the cap, the newest first, every one of them a type.
    const log = Array.from({ length: CAP + 1 }, (_, i) =>
      entry(clock(CAP - i), { sourceId: id(i), newValue: `Type ${i}` }),
    );
    const { text, rows, read } = await changes([
      ["GET /modifications", () => log],
      [
        "GET /api/thoughts/",
        (url) => {
          const of = url.pathname.split("/").at(-1)!;
          return thought(`Type ${Number(of.slice(0, 8))}`, { id: of, kind: 2 });
        },
      ],
    ]);

    expect(read).toHaveLength(CAP);
    expect(rows).toEqual([
      ...Array.from({ length: CAP }, (_, i) => ["created", `Type ${i} [type]`]),
      ["created", `Type ${CAP}`],
    ]);
    expect(text).not.toContain("(name not read)");
    expect(text.split("\n").at(-1)).toBe(
      `events ${CAP + 1}; thoughts not read: 1, so a type or a tag among them is not marked`,
    );
  });

  it("the reads go first to the thoughts the log has no name for", async () => {
    // Sixty thoughts created in the period, then three older ones with a note
    // each: as many as the cap ahead of them, in the order of the rows.
    const OLDER = [id(900), id(901), id(902)];
    const log = [
      ...Array.from({ length: CAP }, (_, i) =>
        entry(clock(CAP + 3 - i), { sourceId: id(i), newValue: `New ${i}` }),
      ),
      ...OLDER.map((of, i) => noted(clock(2 - i), of)),
    ];
    const { text, rows, read } = await changes([
      ["GET /modifications", () => log],
      [
        "GET /api/thoughts/",
        (url) => {
          const of = url.pathname.split("/").at(-1)!;
          const n = Number(of.slice(0, 8));
          return thought(n >= 900 ? `Older ${n - 900}` : `New ${n}`, { id: of });
        },
      ],
    ]);

    expect(read).toHaveLength(CAP);
    expect(read.slice(0, 3)).toEqual(OLDER);
    // Every row has a name: the three that are not read are the log's.
    expect(rows).toEqual([
      ...Array.from({ length: CAP }, (_, i) => ["created", `New ${i}`]),
      ...OLDER.map((_, i) => ["note created", `Older ${i}`]),
    ]);
    expect(text.split("\n").at(-1)).toBe(
      `events ${CAP + 3}; thoughts not read: 3, so a type or a tag among them is not marked`,
    );
  });

  it("a read that fails some other way leaves the name the log has, and says the thought was not read", async () => {
    const { text, rows } = await changes([
      [
        "GET /modifications",
        () => [
          entry("00:02", { sourceId: PARENT }),
          entry("00:01", { sourceId: GONE, newValue: "Draft" }),
          entry("00:00", { newValue: "RAG" }),
        ],
      ],
      ["GET /api/thoughts/", (url) => (url.pathname.endsWith(THOUGHT) ? thought("RAG") : 500)],
    ]);

    // Not deleted, and not unnamed: nothing was read of either.
    expect(rows).toEqual([
      ["created", "(name not read)"],
      ["created", "Draft"],
      ["created", "RAG"],
    ]);
    expect(text.split("\n").at(-1)).toBe(
      "events 3; thoughts not read: 2, so a type or a tag among them is not marked",
    );
  });

  it("a name as long as the log keeps one ends in an ellipsis, and a thought that is read has its whole name", async () => {
    // The log has the first 140 UTF-16 code units of a name and no more.
    const cutGone = "g".repeat(140);
    const whole = "w".repeat(200);
    const { rows } = await changes([
      [
        "GET /modifications",
        () => [
          entry("00:02", { sourceId: GONE, modType: 102, oldValue: cutGone }),
          entry("00:01", { sourceId: PARENT, modType: 102, oldValue: "p".repeat(139) }),
          entry("00:00", { newValue: whole.slice(0, 140) }),
        ],
      ],
      ["GET /api/thoughts/", () => thought(whole)],
    ]);

    expect(rows).toEqual([
      ["deleted", `${cutGone}… (deleted)`],
      ["deleted", `${"p".repeat(139)} (deleted)`],
      ["created", whole],
    ]);
  });

  it("a name with no character that shows is spelled out, from the log as from a read", async () => {
    // A zero width space is a name the API stores like any other.
    const ZWSP = "\u200b";
    const { text, rows } = await changes(
      [
        [
          "GET /modifications",
          () => [
            entry("00:02", { sourceId: GONE, modType: 102, oldValue: ZWSP }),
            entry("00:01", { sourceId: PARENT, newValue: ZWSP }),
            entry("00:00", { newValue: ZWSP }),
          ],
        ],
        // One is read, and one is not: its read fails.
        ["GET /api/thoughts/", (url) => (url.pathname.endsWith(THOUGHT) ? thought(ZWSP) : 500)],
      ],
      { identifiers: true },
    );

    expect(rows).toEqual([
      ["deleted", "(no visible character: U+200B) (deleted)"],
      ["created", "(no visible character: U+200B)"],
      ["created", "(no visible character: U+200B)"],
    ]);
    expect(text.split("\n").filter((l) => l.startsWith("- "))).toEqual([
      `- (no visible character: U+200B) — ${PARENT}`,
      `- (no visible character: U+200B) — ${THOUGHT}`,
    ]);
  });

  describe("identifiers", () => {
    const routes: Route[] = [
      [
        "GET /modifications",
        () => [
          // A tag attached is logged as a link created, the tag at one end.
          link("00:04", 101, TAG, THOUGHT),
          entry("00:03", { sourceId: TYPE, newValue: "Pattern" }),
          entry("00:02", { sourceId: GONE, modType: 102, oldValue: "Dropped" }),
          entry("00:01", { sourceId: GONE, newValue: "Dropped" }),
          entry("00:00", { newValue: "RAG" }),
        ],
      ],
      [
        "GET /api/thoughts/",
        (url) =>
          [
            thought("RAG"),
            thought("Pattern", { id: TYPE, kind: 2 }),
            thought("gotcha", { id: TAG, kind: 4 }),
          ].find((t) => url.pathname.endsWith(t.id)) ?? 404,
      ],
    ];
    const TABLE = [
      "## Changes since 2026-10-10 00:00",
      "When (UTC)        What          Thought",
      "────────────────  ────────────  ──────────────────",
      "2026-10-10 12:00  link created  gotcha [tag] ↔ RAG",
      "2026-10-10 12:00  created       Pattern [type]",
      "2026-10-10 12:00  deleted       Dropped (deleted)",
      "2026-10-10 12:00  created       Dropped (deleted)",
      "2026-10-10 12:00  created       RAG",
    ].join("\n");

    it("without the argument the result has no list, and reads as it did but for the deleted name", async () => {
      const plain = await changes(routes);
      expect(plain.text).toBe(`${TABLE}\n\n## Totals\nevents 5`);
      expect((await changes(routes, { identifiers: false })).text).toBe(plain.text);
    });

    it("with it each thought that is there is listed once, the mark after its identifier, at no further request", async () => {
      const plain = await changes(routes);
      const listed = await changes(routes, { identifiers: true });

      expect(listed.text).toBe(
        [
          TABLE,
          "",
          "## Thoughts",
          `- gotcha — ${TAG} [tag]`,
          `- RAG — ${THOUGHT}`,
          `- Pattern — ${TYPE} [type]`,
          "",
          "## Totals",
          "events 5",
        ].join("\n"),
      );
      // The deleted thought is in the rows and not in the list: nothing takes
      // its identifier.
      expect(listed.text).not.toContain(GONE);
      // The identifiers are the log's own.
      expect(listed.read).toEqual(plain.read);
      expect(listed.requests).toBe(plain.requests);
    });

    it("a thought that was not read is listed all the same, under the name the log has or none", async () => {
      // One thought more than the cap, and the oldest with no name in the log.
      const log = Array.from({ length: CAP + 2 }, (_, i) =>
        i === CAP + 1
          ? noted(clock(0), id(i))
          : entry(clock(CAP + 1 - i), { sourceId: id(i), newValue: `New ${i}` }),
      );
      const { text, read } = await changes(
        [
          ["GET /modifications", () => log],
          [
            "GET /api/thoughts/",
            (url) => {
              const of = url.pathname.split("/").at(-1)!;
              return url.pathname.endsWith(id(CAP + 1))
                ? generic403()
                : thought(`New ${Number(of.slice(0, 8))}`, { id: of });
            },
          ],
        ],
        { identifiers: true },
      );

      expect(read).toHaveLength(CAP);
      const list = text.split("\n").filter((l) => l.startsWith("- "));
      expect(list).toHaveLength(CAP + 2);
      // Read, named by the log alone, and neither.
      expect(list[0]).toBe(`- New 0 — ${id(0)}`);
      expect(list[CAP]).toBe(`- New ${CAP} — ${id(CAP)}`);
      expect(list[CAP + 1]).toBe(`- (name not read) — ${id(CAP + 1)}`);
      expect(text.split("\n").at(-1)).toBe(
        `events ${CAP + 2}; thoughts not read: 3, so a type or a tag among them is not marked`,
      );
    });

    it("nothing is listed when every thought of the period is gone", async () => {
      const { text } = await changes(
        [
          [
            "GET /modifications",
            () => [
              entry("00:01", { sourceId: GONE, modType: 102, oldValue: "Dropped" }),
              entry("00:00", { sourceId: GONE, newValue: "Dropped" }),
            ],
          ],
          ["GET /api/thoughts/", () => 404],
        ],
        { identifiers: true },
      );
      expect(text).not.toContain("## Thoughts");
      expect(text).toContain("Dropped (deleted)");
    });

    it("the argument is an optional boolean of the tool's schema", async () => {
      const { client } = await connect([]);
      const { tools } = await client.listTools();
      const schema = tools.find((t) => t.name === "brain_recent_changes")!.inputSchema;
      expect(schema.properties).toMatchObject({ identifiers: { type: "boolean" } });
      expect(schema.required).toEqual(["brainId"]);
    });
  });
});

describe("tools/list", () => {
  it("is the size the documents give for it", async () => {
    // ARCHITECTURE.md §4 and CONTRIBUTING.md count it in tokens at four
    // characters each, "about 1160" for the descriptions and "about 4750"
    // for the whole of it, and had gone stale apart: 4200 in one and 3900 in
    // the other. A description or a schema that changes these numbers
    // changes those two sentences.
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(19);
    expect(tools.reduce((sum, tool) => sum + (tool.description ?? "").length, 0)).toBe(4958);
    expect(JSON.stringify(tools).length).toBe(20318);
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
    const type = thought("Pattern", { id: PARENT, kind: 2 });
    return [
      [
        "GET /graph",
        () => ({
          ...graph(thought("RAG", { typeId })),
          ...(typeId === null ? {} : { type, parents: [type] }),
          links:
            typeId === null ? [] : [{ id: LINK, thoughtIdA: PARENT, thoughtIdB: THOUGHT, ...link }],
        }),
      ],
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
      await vi.advanceTimersByTimeAsync(PAST_READ_BACK);
      const result = await pending;

      expect(result.isError).toBe(true);
      expect(result.text).toContain("the type is still in place");
      expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("null takes a type's type away: the link that carries it has meaning 3", async () => {
    // It was taken for a link that is not the type's. The call waited two
    // seconds and answered that the type was still in place, and it was.
    const { call, calls } = await connect(typedRoutes({ meaning: 3 }));
    const result = await call("brain_update_thought", {
      brainId: BRAIN,
      thoughtId: THOUGHT,
      typeId: null,
    });
    expect(result).toEqual({ isError: false, text: "## Done\n- typeId = null" });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
      `/api/links/${BRAIN}/${LINK}`,
    ]);
  });

  it("null takes both types of a thought with two away, and leaves its parent", async () => {
    // Only the one typeId names went, and the call answered "Done" with the
    // other still its type: deleting either link reads back as typeId null.
    const SECOND = "cdcdcdcd-0000-4000-8000-00000000000c";
    const ABOVE = "efefefef-0000-4000-8000-00000000000e";
    const second = thought("Method", { id: SECOND, kind: 2 });
    const first = thought("Pattern", { id: PARENT, kind: 2 });
    const above = thought("Retrieval", { id: ABOVE });
    const links = new Map(
      [PARENT, SECOND, ABOVE].map((end, i) => [
        end,
        {
          id: `${LINK.slice(0, -1)}${i}`,
          thoughtIdA: end,
          thoughtIdB: THOUGHT,
          relation: 1,
          meaning: end === ABOVE ? 1 : 2,
        },
      ]),
    );
    let typeId: string | null = PARENT;
    const { call, calls } = await connect([
      [
        "GET /graph",
        () => ({
          ...graph(thought("RAG", { typeId })),
          type: links.has(SECOND) ? second : links.has(PARENT) ? first : null,
          parents: [second, first, above].filter((t) => links.has(t.id)),
          links: [...links.values()],
        }),
      ],
      ["GET /api/thoughts/", () => thought("RAG", { typeId })],
      [
        "DELETE /api/links/",
        (url) => {
          for (const [end, link] of links) if (url.pathname.endsWith(link.id)) links.delete(end);
          typeId = null;
          return 200;
        },
      ],
      [
        "GET /api/links/",
        (url) => {
          const [a = "", b = ""] = url.pathname.split("/").slice(-2);
          return links.get(a) ?? links.get(b) ?? 404;
        },
      ],
    ]);
    const result = await call("brain_update_thought", {
      brainId: BRAIN,
      thoughtId: THOUGHT,
      typeId: null,
    });
    expect(result).toEqual({ isError: false, text: "## Done\n- typeId = null" });
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(2);
    expect([...links.keys()]).toEqual([ABOVE]);
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

describe("brain_attach_url", () => {
  /**
   * An attach stored as it was sent and found by `by-location` in that
   * spelling alone, scheme and trailing slashes aside, with the thought's own
   * list a copy that has none of it yet (L17).
   */
  const listBehind = (): Route[] => {
    const stored: Array<Record<string, unknown>> = [];
    const bare = (location: string): string =>
      location.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    return [
      [
        "GET /by-location",
        (url) =>
          stored.filter(
            (a) => bare(String(a["location"])) === bare(url.searchParams.get("location")!),
          ),
      ],
      ["GET /attachments", () => []],
      [
        "POST /api/attachments/",
        (url) => {
          stored.push({
            id: `att-${stored.length + 1}`,
            sourceId: THOUGHT,
            type: 3,
            name: "Example page",
            location: url.searchParams.get("url"),
          });
          return 200;
        },
      ],
    ];
  };

  it("finds the address it attached straight before in another host case, and says how it is stored", async () => {
    const { call, calls } = await connect(listBehind());
    const attach = (url: string) =>
      call("brain_attach_url", { brainId: BRAIN, thoughtId: THOUGHT, url });

    expect((await attach("https://Example.com/p")).text).toBe(
      "## Done\nlink attached: https://Example.com/p",
    );
    const again = await attach("https://example.com/p");
    expect(again).toEqual({
      isError: false,
      text:
        "## Already there\n" +
        'this URL is already attached as "Example page" (stored as https://Example.com/p) ' +
        "— nothing changed",
    });
    // In the spelling it is stored in, it is only already there.
    expect((await attach("https://Example.com/p")).text).toBe(
      '## Already there\nthis URL is already attached as "Example page" — nothing changed',
    );
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
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

  it("aliases TheBrain accepted and did not read back are said as that, not counted as given", async () => {
    // They were counted under "thoughts given aliases", and the batch read
    // as done: a list to build on, which the next edit would have undone.
    vi.useFakeTimers();
    try {
      const { call, sent } = await connect([
        ["GET /api/brains/", () => ({ id: BRAIN, name: "brain", homeThoughtId: PARENT })],
        // PARENT has "RAG" already, and every read of it shows the list before.
        ["GET /graph", () => ({ ...graph(thought("parent")), children: [thought("RAG")] })],
        ["GET /api/thoughts/", () => thought("RAG", { aliases: [] })],
        ["PATCH /api/thoughts/", () => 200],
      ]);
      const pending = call("brain_ingest", {
        brainId: BRAIN,
        thoughts: [{ tempId: "rag", name: "RAG", parent: PARENT, aliases: ["Retrieval"] }],
      });
      await vi.advanceTimersByTimeAsync(PAST_READ_BACK);
      const result = await pending;

      expect(sent("PATCH")).toEqual([[{ op: "replace", path: "/aliases", value: ["Retrieval"] }]]);
      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        [
          "## Thoughts",
          "Outcome  Title  Identifier",
          "───────  ─────  ────────────────────────────────────",
          `existed  RAG    ${THOUGHT}`,
          "",
          "## Also",
          "- links created: 0",
          "- notes written: 0",
          "- tags attached: 0",
          "- thoughts given aliases: 0",
          "",
          "## Aliases not read back",
          "TheBrain accepted the aliases of this thought, and it did not read back with them " +
            "within 6 s: reads lag behind writes for seconds after a burst of them, and longer " +
            "while writes keep coming.",
          `- "RAG" (${THOUGHT}): added ["Retrieval"]; the list is now ["Retrieval"]`,
          "Do not send them again: brain_get_thought shows them once TheBrain catches up. An " +
            "alias edit of this thought sent before then waits for them, and is not sent while " +
            "they do not show, since built on the old list it would undo them.",
          "",
          "## Next",
          "Every write of the plan was accepted, and the identifiers above work immediately. " +
            "Only the aliases under Aliases not read back have not shown on a read: do not " +
            "send them, or this plan, again for them. To show the result to the user, open the " +
            "root thought with brain_activate. Refresh the semantic index with brain_index " +
            "using action=sync once brain_get_thought shows them.",
        ].join("\n"),
      );
    } finally {
      vi.useRealTimers();
    }
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
  const DOOMED = "99999999-0000-4000-8000-000000000009";
  const SIDE = "eeeeeeee-0000-4000-8000-000000000005";
  const TOP = "ffffffff-0000-4000-8000-000000000006";
  type Create = { name: string; sourceThoughtId?: string };

  /**
   * The read of a thought. DOOMED is deleted between a plan's checks and its
   * writes: it is there the first time it is asked for, and nobody has it
   * from then on. A parent nobody has from the start rejects the plan, and
   * no batch is begun.
   */
  const thoughtRead = (): ((url: URL) => unknown) => {
    let checked = false;
    return (url) => {
      if (!url.pathname.endsWith(DOOMED)) return thought("Constraints", { aliases: [] });
      const there = !checked;
      checked = true;
      return there ? thought("doomed", { id: DOOMED }) : 404;
    };
  };

  /**
   * A brain where PARENT is an ordinary thought with no children and nobody
   * has DOOMED by the time a plan writes. As on the live API, a thought
   * created under an identifier nobody has is a 404 that says so, and the
   * graph of one is the 403 the API has for much else. `create` answers for
   * the rest.
   */
  const routes = (create: (body: Create) => unknown, notes: () => unknown = () => 200): Route[] => [
    ["GET /api/brains/", () => ({ id: BRAIN, name: "brain", homeThoughtId: PARENT })],
    [
      "GET /graph",
      (url) => (url.pathname.includes(DOOMED) ? generic403() : graph(thought("parent"))),
    ],
    ["GET /api/thoughts/", thoughtRead()],
    [
      "POST /api/thoughts/",
      (_url, body) => {
        const asked = body as Create;
        return asked.sourceThoughtId === DOOMED
          ? new Response(JSON.stringify(`Source Thought ${DOOMED} could not be located`), {
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
    const result = await call("brain_ingest", plan(DOOMED));

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
        `- thought "Top" (top): Source Thought ${DOOMED} could not be located.${NOBODY_HAS_IT}`,
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
        { tempId: "top", name: "Top", parent: DOOMED },
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
      '- thought "Mid" (mid): request exceeded 30000 ms. Check that the TheBrain desktop ' +
        "app is running and its local API is enabled. No answer came, so TheBrain may have " +
        "created it all the same: before creating it again, look for it next to its parent " +
        "with brain_get_thought.\n",
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
    expect(result.text).toContain(
      `## Failed\n- note for "Top" (${TOP}): ` +
        `${boomAt(`POST /api/notes/${BRAIN}/${TOP}/update`)}\n`,
    );
    expect(result.text).not.toContain("## Skipped");
    expect(result.text).toContain("nothing is rolled back");
  });
});

describe("brain_ingest and a parent nobody has", () => {
  const NOBODY = "99999999-0000-4000-8000-000000000009";
  /**
   * A brain where PARENT is an ordinary thought with no children and nobody
   * has NOBODY, each request about it answered as the live API answers.
   */
  const routes: Route[] = [
    ["GET /api/brains/", () => ({ id: BRAIN, name: "brain", homeThoughtId: PARENT })],
    [
      "GET /graph",
      (url) => (url.pathname.includes(NOBODY) ? generic403() : graph(thought("parent"))),
    ],
    [
      "GET /api/thoughts/",
      (url) => (url.pathname.endsWith(NOBODY) ? 404 : thought("Constraints", { aliases: [] })),
    ],
    ["POST /api/thoughts/", () => ({ id: THOUGHT })],
    ["POST /api/notes/", () => 200],
    [
      "POST /api/links/",
      (_url, body) => {
        const { thoughtIdA, thoughtIdB } = body as { thoughtIdA: string; thoughtIdB: string };
        const end = thoughtIdA === NOBODY ? "source" : thoughtIdB === NOBODY ? "target" : null;
        return end === null
          ? { id: LINK }
          : new Response(JSON.stringify(`Could not get ${end} thought ${NOBODY}`), {
              status: 400,
              headers: { "content-type": "application/json" },
            });
      },
    ],
    ["GET /api/links/", () => 404],
  ];
  const rejected = (references: string): string =>
    `Plan rejected, nothing was written: ${references}, and no thought in this brain has ` +
    `that identifier.${NOBODY_HAS_IT} Fix it and retry.`;
  const read = (id: string) => ({ method: "GET", path: `/api/thoughts/${BRAIN}/${id}` });

  it("the plan is rejected whole, the branch beside it included, by the read that checks the parent", async () => {
    // "Side" used to be created with its note, "Top" listed under Failed in
    // the API's words and "Mid" under Skipped: a batch written in part.
    const { call, calls } = await connect(routes);
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [
        { tempId: "top", name: "Top", parent: NOBODY, note: "summary" },
        { tempId: "mid", name: "Mid", parent: "top" },
        { tempId: "side", name: "Side", parent: PARENT, note: "body" },
      ],
      links: [{ from: "mid", to: "side", name: "relates" }],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toBe(rejected(`thought "top" references parent ${NOBODY}`));
    // One read for each parent the plan names, as before, and nothing else.
    expect(calls.map(({ method, path }) => ({ method, path }))).toEqual(
      expect.arrayContaining([read(PARENT), read(NOBODY)]),
    );
    expect(calls).toHaveLength(2);
  });

  it("a plan with nothing else in it costs that one read, where it cost four and a create", async () => {
    const { call, calls } = await connect(routes);
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [
        { tempId: "top", name: "Top", parent: NOBODY },
        { tempId: "mid", name: "Mid", parent: "top" },
      ],
    });

    expect(result.text).toBe(rejected(`thought "top" references parent ${NOBODY}`));
    expect(calls.map(({ method, path }) => ({ method, path }))).toEqual([read(NOBODY)]);
  });

  it("a thought made as a parent or a jump of it, and a link with it above, are rejected in the same words", async () => {
    for (const relation of ["parent", "jump"]) {
      const { call, calls } = await connect(routes);
      const result = await call("brain_ingest", {
        brainId: BRAIN,
        thoughts: [
          { tempId: "top", name: "Top", parent: NOBODY, relation },
          { tempId: "side", name: "Side", parent: PARENT },
        ],
      });
      expect(result.text, relation).toBe(rejected(`thought "top" references parent ${NOBODY}`));
      expect(calls.filter((c) => c.method !== "GET"), relation).toEqual([]);
    }
    for (const [link, field] of [
      [{ from: NOBODY, to: "a", relation: "child" }, "from"],
      [{ from: "a", to: NOBODY, relation: "parent" }, "to"],
    ] as const) {
      const { call, calls } = await connect(routes);
      const result = await call("brain_ingest", {
        brainId: BRAIN,
        thoughts: [{ tempId: "a", name: "A", parent: PARENT }],
        links: [link],
      });
      expect(result.text, field).toBe(
        rejected(`the link ${link.from} -> ${link.to} references ${NOBODY} in its ${field} field`),
      );
      expect(calls.filter((c) => c.method !== "GET"), field).toEqual([]);
    }
  });

  it("with it below a link, or at an end of a jump, the plan is written and the link fails alone", async () => {
    for (const [link, end] of [
      [{ from: "a", to: NOBODY, relation: "child" }, "target"],
      [{ from: "a", to: NOBODY }, "target"],
      [{ from: NOBODY, to: "a" }, "source"],
    ] as const) {
      const { call } = await connect(routes);
      const result = await call("brain_ingest", {
        brainId: BRAIN,
        thoughts: [{ tempId: "a", name: "A", parent: PARENT }],
        links: [link],
      });

      expect(result.isError, end).toBe(true);
      expect(result.text, end).toContain(`created  A      ${THOUGHT}  a`);
      // The API's words, then what a thought's own line has: it used to end
      // at the request, "(POST /api/links/<brain>)", with no way on.
      expect(result.text, end).toContain(
        `## Failed\n- link ${link.from} -> ${link.to}: Could not get ${end} thought ${NOBODY}. ` +
          "It may have been deleted, or be another brain's. Take identifiers from " +
          "brain_search or brain_get_thought.\n",
      );
    }
  });

  it("every identifier nobody has is named in the one refusal", async () => {
    const ALSO = "88888888-0000-4000-8000-000000000008";
    const { call } = await connect([
      [`GET /api/thoughts/${BRAIN}/${ALSO}`, () => 404],
      ...routes,
    ]);
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [
        { tempId: "top", name: "Top", parent: NOBODY },
        { tempId: "beside", name: "Beside", parent: ALSO, relation: "jump" },
      ],
    });

    expect(result.text).toBe(
      `Plan rejected, nothing was written: thought "top" references parent ${NOBODY}, ` +
        `thought "beside" references parent ${ALSO}, and no thought in this brain has those ` +
        "identifiers. Each may have been deleted, or be another brain's. Take identifiers " +
        "from brain_search or brain_get_thought. Fix it and retry.",
    );
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
        "this name next to it, so nothing was created: " +
        `${boomAt(`GET /api/thoughts/${BRAIN}/${PARENT}/graph`)}\n`,
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
      await vi.advanceTimersByTimeAsync(PAST_READ_BACK);
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
      await vi.advanceTimersByTimeAsync(PAST_READ_BACK);
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

describe("brain_ingest and the note of a thought that was there", () => {
  const HELD = "eeeeeeee-0000-4000-8000-000000000005";
  const BARE = "eeeeeeee-0000-4000-8000-000000000055";
  const QUIET = "eeeeeeee-0000-4000-8000-000000000555";
  const HUMAN = "A person wrote this.";
  const NEXT =
    "## Next\nThe identifiers above work immediately. To show the result to the user, open " +
    "the root thought with brain_activate. Refresh the semantic index with brain_index " +
    "using action=sync.";
  /**
   * A brain where PARENT has three children: "Held", whose note is `held`,
   * and "Bare" and "Quiet", which have none. As on the live API, the note of
   * a thought with none is a 200 with the sentinel. `first` goes ahead.
   */
  const routes = (held: string = HUMAN, first: Route[] = []): Route[] => [
    ...first,
    ["GET /api/brains/", () => ({ id: BRAIN, name: "brain", homeThoughtId: PARENT })],
    [
      "GET /graph",
      () => ({
        ...graph(thought("parent", { id: PARENT })),
        children: [
          { id: HELD, name: "Held", kind: 1 },
          { id: BARE, name: "Bare", kind: 1 },
          { id: QUIET, name: "Quiet", kind: 1 },
        ],
      }),
    ],
    [
      "GET /api/notes/",
      (url) =>
        url.pathname.endsWith(HELD)
          ? { modificationDateTime: "2026-10-11T06:00:00.000001", markdown: held }
          : noNote,
    ],
    ["GET /api/thoughts/", () => thought("parent", { id: PARENT, aliases: [] })],
    ["POST /api/thoughts/", () => ({ id: THOUGHT })],
    ["POST /api/notes/", () => 200],
  ];
  const plan = {
    brainId: BRAIN,
    thoughts: [
      { tempId: "new", name: "New", parent: PARENT, note: "new text" },
      { tempId: "held", name: "Held", parent: PARENT, note: "the plan's" },
      { tempId: "bare", name: "Bare", parent: PARENT, note: "bare text" },
      { tempId: "quiet", name: "Quiet", parent: PARENT },
    ],
  };
  /** The notes written, by the thought each was sent to. */
  const noteWrites = (calls: Array<{ method: string; path: string; body: unknown }>) =>
    calls
      .filter((c) => c.method === "POST" && c.path.includes("/api/notes/"))
      .map((c) => [c.path.split("/").at(-2), (c.body as { markdown: string }).markdown])
      .sort();

  it("a note that is there is kept, one that is not is written, and the table says which of each", async () => {
    // The plan's note used to be written over the one a thought had, on a
    // first run that landed on it as on a second, with "notes written: 3"
    // and no word that a note had been there.
    const { call, calls } = await connect(routes());
    const result = await call("brain_ingest", plan);

    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      [
        "## Thoughts",
        "Outcome  Title  Identifier                            Note",
        "───────  ─────  ────────────────────────────────────  ──────────────────",
        `created  New    ${THOUGHT}  written`,
        `existed  Held   ${HELD}  kept: another text`,
        `existed  Bare   ${BARE}  written`,
        `existed  Quiet  ${QUIET}  -`,
        "",
        "## Also",
        "- links created: 0",
        "- notes written: 2",
        "- notes kept: 1",
        "- tags attached: 0",
        "",
        "## Notes kept",
        "A thought that existed keeps the note it has: a plan's note is written only where " +
          "there is none, never over one. 1 of the notes kept is not the plan's text, marked " +
          '"kept: another text" in the table, and the plan\'s text for that thought was ' +
          "written nowhere. To add it, read the thought with brain_get_thought and call " +
          "brain_append_note. brain_set_note replaces a note, and what it held is lost.",
        "",
        NEXT,
      ].join("\n"),
    );
    // Nothing was sent to the note that was there.
    expect(noteWrites(calls)).toEqual([
      [THOUGHT, "new text"],
      [BARE, "bare text"],
    ].sort());
  });

  it("a second run of a plan finds its own text there: kept, and nothing more to say or to do", async () => {
    const { call, calls } = await connect(routes("the plan's\n"));
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [plan.thoughts[1]!, plan.thoughts[3]!],
    });

    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      [
        "## Thoughts",
        "Outcome  Title  Identifier                            Note",
        "───────  ─────  ────────────────────────────────────  ───────────────",
        `existed  Held   ${HELD}  kept: same text`,
        `existed  Quiet  ${QUIET}  -`,
        "",
        "## Also",
        "- links created: 0",
        "- notes written: 0",
        "- notes kept: 1",
        "- tags attached: 0",
        "",
        NEXT,
      ].join("\n"),
    );
    expect(noteWrites(calls)).toEqual([]);
  });

  it("several notes kept that are not the plan's are counted, in the plural", async () => {
    const { call } = await connect(
      routes(HUMAN, [
        ["GET /api/notes/", () => ({ modificationDateTime: "2026-10-11T06:00:00", markdown: HUMAN })],
      ]),
    );
    const result = await call("brain_ingest", plan);

    expect(result.text).toContain("- notes written: 1\n- notes kept: 2\n");
    expect(result.text).toContain(
      "2 of the notes kept are not the plan's text, marked \"kept: another text\" in the " +
        "table, and the plan's text for those thoughts was written nowhere.",
    );
  });

  it("with no note in the plan for a thought it found, the result has no such column and reads as it did", async () => {
    const { call, calls } = await connect(routes());
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [plan.thoughts[0]!, { tempId: "held", name: "Held", parent: PARENT }],
    });

    expect(result.text).toBe(
      [
        "## Thoughts",
        "Outcome  Title  Identifier",
        "───────  ─────  ────────────────────────────────────",
        `created  New    ${THOUGHT}`,
        `existed  Held   ${HELD}`,
        "",
        "## Also",
        "- links created: 0",
        "- notes written: 1",
        "- tags attached: 0",
        "",
        NEXT,
      ].join("\n"),
    );
    // And no note is read for it.
    expect(calls.filter((c) => c.method === "GET" && c.path.includes("/api/notes/"))).toEqual([]);
  });

  it("a note that cannot be read is not written over: the batch is an error, and its line says why", async () => {
    // BRMCP-46's rule for brain_set_note: a failed read is not "no note".
    const cases: Array<[() => Response, string]> = [
      [
        () => new Response(JSON.stringify("boom"), { status: 500 }),
        boomAt(`GET /api/notes/${BRAIN}/${HELD}`),
      ],
      [
        // What the read of a note answers for a moment after the note is deleted.
        generic403,
        `TheBrain answered 403 and named no cause (GET /api/notes/${BRAIN}/${HELD}). The ` +
          "read of a note gets that answer for a moment after the note is deleted, and it " +
          "says nothing of the thought or of its identifier.",
      ],
    ];
    for (const [answer, why] of cases) {
      const { call, calls } = await connect(
        routes(HUMAN, [[`GET /api/notes/${BRAIN}/${HELD}`, answer]]),
      );
      const result = await call("brain_ingest", plan);

      expect(result.isError, why).toBe(true);
      expect(result.text, why).toContain(`existed  Held   ${HELD}  not written  held\n`);
      expect(result.text, why).toContain(
        `## Failed\n- note for "Held" (${HELD}): not written, because the note this thought ` +
          `has could not be read and a note is not written over one that was not: ${why} ` +
          "Read the thought with brain_get_thought before writing this note: where it has " +
          "one, add to it with brain_append_note.\n",
      );
      expect(noteWrites(calls).map(([id]) => id), why).not.toContain(HELD);
    }
  });

  it("a note write that got no answer says it may have been written, as a create does", async () => {
    // It stood under Failed as a write that had been refused: only a create
    // was told from one that got no answer.
    const { call } = await connect(
      routes(HUMAN, [
        [
          "POST /api/notes/",
          () => {
            throw new DOMException("timed out", "TimeoutError");
          },
        ],
      ]),
    );
    const result = await call("brain_ingest", { brainId: BRAIN, thoughts: [plan.thoughts[0]!] });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      `## Failed\n- note for "New" (${THOUGHT}): request exceeded 30000 ms. Check that the ` +
        "TheBrain desktop app is running and its local API is enabled. No answer came, so " +
        "TheBrain may have written it all the same: read the thought with brain_get_thought " +
        "before writing its note again.\n",
    );
    expect(result.text).toContain(
      "a listed thought's note, tags and aliases included, unless its line says it may have been. ",
    );
  });

  it("the note argument says that a note that is there is kept", async () => {
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    const thoughts = tools.find((t) => t.name === "brain_ingest")!.inputSchema.properties![
      "thoughts"
    ] as { items: { properties: Record<string, { description?: string }> } };
    expect(thoughts.items.properties["note"]!.description).toBe(
      "Note in Markdown. Written to a new thought, and to one that existed only if it has " +
        "no note: a note that is there is kept, and the result says so.",
    );
  });
});

describe("brain_ingest and two thoughts of one name next to a parent", () => {
  const ONE = "eeeeeeee-0000-4000-8000-000000000005";
  const TWO = "eeeeeeee-0000-4000-8000-000000000055";
  const routes: Route[] = [
    ["GET /api/brains/", () => ({ id: BRAIN, name: "brain", homeThoughtId: PARENT })],
    [
      "GET /graph",
      () => ({
        ...graph(thought("parent", { id: PARENT })),
        children: [
          { id: ONE, name: "RAG", kind: 1 },
          { id: TWO, name: "RAG", kind: 1 },
        ],
      }),
    ],
    ["GET /api/thoughts/", () => thought("parent", { id: PARENT, aliases: [] })],
    ["POST /api/thoughts/", () => ({ id: THOUGHT })],
  ];
  const plan = {
    brainId: BRAIN,
    thoughts: [
      { tempId: "rag", name: "RAG", parent: PARENT },
      { tempId: "leaf", name: "Chunking", parent: "rag" },
    ],
  };

  it("neither is taken for the plan's thought: an error that names both, and nothing is created", async () => {
    // The one the graph listed last used to be listed as "existed", with the
    // plan's leaf under it, and the result said nothing of the other.
    const { call, sent } = await connect(routes);
    const result = await call("brain_ingest", plan);

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("## Thoughts");
    expect(result.text).toContain(
      [
        "## Failed",
        `- thought "RAG" (rag): ${PARENT} has 2 thoughts of this name as its child: ${ONE} ` +
          `and ${TWO}. Which of them the plan means was not decided: none was taken, and no ` +
          "further one was made. To use one of them, name its identifier where the plan has " +
          '"rag"; to make another of that name, send this thought in a plan with deduplicate ' +
          "set to false",
        "",
        "## Skipped",
        '- thought "Chunking" (leaf): depends on "rag", which was not created',
      ].join("\n"),
    );
    expect(sent("POST")).toEqual([]);
  });

  it("the argument says so", async () => {
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    const properties = tools.find((t) => t.name === "brain_ingest")!.inputSchema
      .properties as Record<string, { description?: string }>;
    expect(properties["deduplicate"]!.description).toMatch(
      /it fails, with its identifier\. So do two of that name under the same relation\.$/,
    );
  });
});

describe("brain_ingest straight after another tool has written", () => {
  /**
   * A brain where the graph of PARENT is answered from a copy that lists a
   * new thought 200 ms after it is made, as the API's does within 205. The
   * graph is a `Response`, so nothing is added to it here.
   */
  const routes = (lagMs = 200): Route[] => {
    let madeAt = Number.POSITIVE_INFINITY;
    const born = (): unknown[] =>
      Date.now() - madeAt >= lagMs ? [{ id: THOUGHT, name: "RAG", kind: 1 }] : [];
    return [
      ["GET /api/brains/", () => ({ id: BRAIN, name: "brain", homeThoughtId: PARENT })],
      [
        "GET /graph",
        () =>
          new Response(
            JSON.stringify({ ...graph(thought("parent", { id: PARENT })), children: born() }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ],
      ["GET /api/thoughts/", () => thought("parent", { id: PARENT, aliases: [] })],
      [
        "POST /api/thoughts/",
        () => {
          madeAt = Math.min(madeAt, Date.now());
          return { id: THOUGHT };
        },
      ],
      ["PATCH /api/thoughts/", () => 200],
    ];
  };
  const plan = { brainId: BRAIN, thoughts: [{ tempId: "rag", name: "RAG", parent: PARENT }] };
  const creates = (calls: Array<{ method: string; path: string }>): number =>
    calls.filter((c) => c.method === "POST" && c.path === `/api/thoughts/${BRAIN}`).length;

  it("a plan sent at once after brain_create_thought finds the thought it made, and makes no second", async () => {
    // brain_create_thought returns as soon as the thought is made, and the
    // graph the plan looks in was the copy from before it: on a live TheBrain
    // the thought was made again 8 times in 100 sent within 150 ms.
    vi.useFakeTimers();
    try {
      const { call, calls } = await connect(routes());
      const made = call("brain_create_thought", { brainId: BRAIN, name: "RAG", parentId: PARENT });
      await vi.advanceTimersByTimeAsync(0);
      expect((await made).isError).toBe(false);

      const pending = call("brain_ingest", plan);
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;

      expect(result.isError).toBe(false);
      expect(result.text).toContain(`existed  RAG    ${THOUGHT}`);
      expect(creates(calls)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a plan sent long after it waits for nothing", async () => {
    vi.useFakeTimers();
    try {
      const { call, calls } = await connect(routes());
      const made = call("brain_create_thought", { brainId: BRAIN, name: "RAG", parentId: PARENT });
      await vi.advanceTimersByTimeAsync(300);
      await made;

      const before = Date.now();
      const result = await call("brain_ingest", plan);
      expect(Date.now()).toBe(before);
      expect(result.text).toContain(`existed  RAG    ${THOUGHT}`);
      expect(creates(calls)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a copy further behind than the 300 ms is read until it lists the thought, and no second one is made", async () => {
    // The wait by the clock was the whole guard, and on a live TheBrain the
    // copy can be past it: the plan then makes the thought again. The server
    // knows what brain_create_thought put under the parent, and reads the
    // graph until it is there.
    vi.useFakeTimers();
    try {
      const { call, calls } = await connect(routes(900));
      const made = call("brain_create_thought", { brainId: BRAIN, name: "RAG", parentId: PARENT });
      await vi.advanceTimersByTimeAsync(0);
      expect((await made).isError).toBe(false);

      const started = Date.now();
      let took = -1;
      const pending = call("brain_ingest", plan).then((result) => {
        took = Date.now() - started;
        return result;
      });
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;

      expect(result.isError).toBe(false);
      expect(result.text).toContain(`existed  RAG    ${THOUGHT}`);
      expect(creates(calls)).toBe(1);
      expect(took).toBe(900);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a copy still behind after six seconds is an error that says so, and the thought is not made again", async () => {
    vi.useFakeTimers();
    try {
      const { call, calls } = await connect(routes(8000));
      const made = call("brain_create_thought", { brainId: BRAIN, name: "RAG", parentId: PARENT });
      await vi.advanceTimersByTimeAsync(0);
      expect((await made).isError).toBe(false);

      const pending = call("brain_ingest", plan);
      await vi.advanceTimersByTimeAsync(PAST_READ_BACK);
      const result = await pending;

      expect(result.isError).toBe(true);
      expect(result.text).toContain(
        `## Failed\n- thought "RAG" (rag): ${PARENT} was read for ${READ_BACK.timeoutMs} ms ` +
          "to look for a thought of this name next to it, and its graph still does not show " +
          `what this server wrote a moment ago: ${THOUGHT} among its children. TheBrain ` +
          "answers a graph from a copy, and this one is behind, so a thought of this name may " +
          "be there unseen: nothing was created. Send this thought again in a few seconds\n",
      );
      expect(creates(calls)).toBe(1);

      // Sent again once the copy has the thought, the plan finds it.
      await vi.advanceTimersByTimeAsync(3000);
      const again = await call("brain_ingest", plan);
      expect(again.isError).toBe(false);
      expect(again.text).toContain(`existed  RAG    ${THOUGHT}`);
      expect(creates(calls)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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

describe("a type the patch would not set", () => {
  const TYPE = "eeeeeeee-0000-4000-8000-000000000005";
  const SECOND = "abababab-0000-4000-8000-00000000000a";
  const types: Record<string, { name: string; kind: number }> = {
    [TYPE]: { name: "Pattern", kind: 2 },
    [SECOND]: { name: "Method", kind: 2 },
  };
  const at = (id: string) => ({ ...thought("", { aliases: [] }), id, ...types[id] });
  const down = (above: string, below: string, meaning = 2) => ({
    id: `${LINK.slice(0, -2)}${above.slice(0, 2)}`,
    thoughtIdA: above,
    thoughtIdB: below,
    relation: 1,
    meaning,
  });

  /** THOUGHT as `self`, with the links its graph and the lookup of a pair both have. */
  const routes = (self: Record<string, unknown>, links: ReturnType<typeof down>[]): Route[] => [
    [
      "GET /graph",
      () => ({
        ...graph(self),
        type: links.some((l) => l.thoughtIdB === THOUGHT) ? at(links[0]!.thoughtIdA) : null,
        parents: links.filter((l) => l.thoughtIdB === THOUGHT).map((l) => at(l.thoughtIdA)),
        children: links.filter((l) => l.thoughtIdA === THOUGHT).map((l) => at(l.thoughtIdB)),
        links,
      }),
    ],
    [
      "GET /api/links/",
      (url) => {
        const [a, b] = url.pathname.split("/").slice(-2);
        return (
          links.find(
            (l) =>
              (l.thoughtIdA === a && l.thoughtIdB === b) ||
              (l.thoughtIdA === b && l.thoughtIdB === a),
          ) ?? 404
        );
      },
    ],
    [
      "GET /api/thoughts/",
      (url) => {
        const id = url.pathname.split("/").pop()!;
        return id in types ? at(id) : self;
      },
    ],
    ["PATCH /api/thoughts/", () => 200],
  ];

  /**
   * The call with the type alone, and with every field beside it: the type
   * goes first, so a refusal of it stops the call before any write.
   */
  const refusal = async (connected: Awaited<ReturnType<typeof connect>>, typeId: string) => {
    const { call, calls } = connected;
    const alone = await call("brain_update_thought", { brainId: BRAIN, thoughtId: THOUGHT, typeId });
    const all = await call("brain_update_thought", {
      brainId: BRAIN,
      thoughtId: THOUGHT,
      name: "renamed",
      typeId,
      addAliases: ["R.A.G."],
    });
    expect(all.isError).toBe(true);
    expect(all.text).toContain(alone.text);
    expect(all.text).toMatch(/## Skipped\n- name = "renamed"\n- aliases\n/);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    return alone;
  };

  it("brain_update_thought refuses a type on a tag, and writes nothing", async () => {
    // Measured: a 200 that sets nothing. The call waited two seconds for the
    // type to read back and answered that it might yet.
    const result = await refusal(await connect(routes(thought("gotcha", { kind: 4 }), [])), TYPE);
    expect(result).toEqual({
      isError: true,
      text:
        `thoughtId ${THOUGHT} is the tag "gotcha", and a tag takes no type: TheBrain answers ` +
        "a typeId on a tag and sets nothing. Nothing was written. A type goes on an ordinary " +
        "thought or on a type; to put this tag on a thought, pass both to brain_tag.",
    });
  });

  it("brain_update_thought refuses any type for a thought of two, naming both, and writes nothing", async () => {
    // Measured: the other of the two waited two seconds and answered that it
    // might yet read back; a third, and typeId again, answered "Done" with
    // one of the two still beside it.
    for (const typeId of [SECOND, TYPE, PARENT]) {
      const self = thought("RAG", { typeId: TYPE, aliases: [] });
      const connected = await connect([
        // PARENT stands for a third type here.
        [`GET /api/thoughts/${BRAIN}/${PARENT}`, () => ({ ...at(SECOND), id: PARENT, name: "Idea" })],
        ...routes(self, [down(TYPE, THOUGHT), down(SECOND, THOUGHT)]),
      ]);
      const result = await refusal(connected, typeId);
      expect(result, typeId).toEqual({
        isError: true,
        text:
          `thoughtId ${THOUGHT} is linked under two types, "Pattern" ${TYPE} and "Method" ` +
          `${SECOND}, and a typeId set while they are there leaves one of them in place. ` +
          "Nothing was written. To leave it one type, send typeId null first, which removes " +
          "them all, then this typeId in a second brain_update_thought call.",
      });
    }
  });

  it("brain_update_thought refuses a type whose type is the thought, and writes nothing", async () => {
    // Measured: a 200 that sets nothing, and two seconds of waiting.
    const connected = await connect(
      routes(thought("Method family", { kind: 2, aliases: [] }), [down(THOUGHT, SECOND, 3)]),
    );
    const result = await refusal(connected, SECOND);
    expect(result).toEqual({
      isError: true,
      text:
        `typeId ${SECOND} is the type "Method", and this thought is its type: TheBrain ` +
        "answers a typeId that would make two types each other's and sets nothing. Nothing " +
        "was written. To make that type this thought's type, first take this thought away as " +
        "its type, with typeId null in a brain_update_thought call for that type.",
    });
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
          // The hit's thought is read before it is listed, and it is there.
          ["GET /api/thoughts/", () => thought("RAG")],
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

    it("brain_link leaves a parent nobody has to the link, which names it", async () => {
      // Its link is the call's one write, and the API refuses it in words
      // that carry the identifier. Only a plan is rejected ahead of its writes.
      for (const [args, end] of [
        [{ fromId: NOBODY, toId: THOUGHT, relation: "child" }, "source"],
        [{ fromId: THOUGHT, toId: NOBODY, relation: "parent" }, "target"],
      ] as const) {
        const { call, sent } = await connect([
          ["GET /api/thoughts/", bareNotFound],
          ["GET /api/links/", bareNotFound],
          [
            "POST /api/links/",
            () =>
              new Response(JSON.stringify(`Could not get ${end} thought ${NOBODY}`), {
                status: 400,
                headers: { "content-type": "application/json; charset=utf-8" },
              }),
          ],
        ]);
        const result = await call("brain_link", { brainId: BRAIN, ...args });
        expect(result.isError, end).toBe(true);
        // As the create's 404 above. It was the API's sentence and the
        // request, "(POST /api/links/<brain>)", and no more.
        expect(result.text, end).toBe(`Could not get ${end} thought ${NOBODY}.${tail}`);
        expect(sent("POST"), end).toHaveLength(1);
      }
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
  /**
   * The read of a hit's thought, which a search makes before it lists the
   * hit: both thoughts are there, under the names the search has for them.
   */
  const READS: Route = [
    "GET /api/thoughts/",
    (url) =>
      url.pathname.endsWith(OTHER) ? thought("Retrieval", { id: OTHER }) : thought("RAG"),
  ];

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
        // Not "could not reach … — is TheBrain running?": the request went out.
        `${NOTHING_SEARCHED}: the connection to http://localhost:11522 failed before an ` +
          `answer came (other side closed).${RUNNING} Each of the 2 phrasings failed this way.`,
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
      READS,
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
      const { call } = await connect([["GET /api/search", answers], READS], searching());
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
    it("ranking by vectors asks TheBrain's search nothing: the read of each hit is all it sends", async () => {
      // It used to send nothing at all, and list a thought deleted since the
      // last sync like any other. What the reads do with each answer is under
      // "brain_search and a hit for a thought that is gone".
      const { call, calls } = await connect(
        [
          ["GET /api/search", () => text(500, "Internal Server Error")],
          ["GET /api/thoughts/", () => thought("Embeddings", { id: OTHER })],
        ],
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
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        `GET /api/thoughts/${BRAIN}/${OTHER}`,
      ]);
    });

    it("an empty query is refused there as well", async () => {
      const { call } = await connect([], searching(indexed()));
      const result = await call("brain_search", { brainId: BRAIN, query: "" });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^query is empty, and so is every variant/);
    });

    it("without the embeddings package it still falls back, and says why", async () => {
      const { call } = await connect(
        [["GET /api/search", answers], READS],
        searching(indexed(), absent),
      );
      const result = await call("brain_search", { brainId: BRAIN, query: "RAG" });
      expect(result.isError).toBe(false);
      expect(result.text).toContain(`1.000  RAG      ${THOUGHT}  RAG`);
      expect(result.text).toContain("## Found by substring");
      expect(result.text).toContain(
        "Semantic search unavailable: semantic search is off: the @huggingface/transformers " +
          "package is not installed.",
      );
      expect(result.text).not.toContain("## Not searched");
      // The reason is a sentence of its own, and ended "…without it.. Fell
      // back". And the last sentence was "Build the index with the
      // brain_index tool", of an index that is there to rank by.
      expect(result.text.slice(result.text.indexOf("## Warning"))).toBe(
        "## Warning\n" +
          "Semantic search unavailable: semantic search is off: the @huggingface/transformers " +
          "package is not installed. It weighs about 380 MB and downloads a further 113 MB " +
          "model on first use, which is why it is not part of the base install. Substring " +
          "name search is available without it. Fell back to substring name search, so " +
          "recall is lower. The index is there and needs no rebuild: install the package " +
          "with npm install -g @huggingface/transformers.",
      );
    });

    it("with a package that is there and does not load, it says that and what the import failed by", async () => {
      // Every failure of the import read "is not installed".
      const broken: Embedder = {
        ...embedder,
        embedQuery: async () => {
          throw new EmbedderUnavailableError(new Error("Cannot find module 'onnxruntime-node'."));
        },
      };
      const { call } = await connect(
        [["GET /api/search", answers], READS],
        searching(indexed(), broken),
      );
      const result = await call("brain_search", { brainId: BRAIN, query: "RAG" });
      expect(result.isError).toBe(false);
      expect(result.text.slice(result.text.indexOf("## Warning"))).toBe(
        "## Warning\n" +
          "Semantic search unavailable: semantic search is off: the @huggingface/transformers " +
          "package failed to load: Cannot find module 'onnxruntime-node'. Substring name " +
          "search is available without it. Fell back to substring name search, so recall " +
          "is lower. The index is there and needs no rebuild: install the package with " +
          "npm install -g @huggingface/transformers.",
      );
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

describe("brain_search and a hit for a thought that is gone", () => {
  // Measured on 15.0.640 (docs/api-map.md, L34): TheBrain's search returns a
  // deleted thought until its index is refreshed, and now and then for good,
  // and the vector index holds a row until the next sync. Both were listed
  // like any other hit, and a hit is where a model takes an identifier from.
  const OTHER = "abababab-0000-4000-8000-000000000007";
  const GONE = "edededed-0000-4000-8000-00000000000e";

  const hit = (id: string, name: string, kind = 1) => ({
    sourceThought: thought(name, { id, kind }),
    name,
    isFromOtherBrain: false,
  });
  /** What both sources have: their own copies, the third of a thought deleted since. */
  const COPIES: Array<[id: string, name: string]> = [
    [THOUGHT, "RAG"],
    [OTHER, "Retrieval"],
    [GONE, "Gazpacho"],
  ];
  const searchFinds = (ids: readonly string[]): Route => [
    "GET /api/search",
    () => COPIES.filter(([id]) => ids.includes(id)).map(([id, name]) => hit(id, name)),
  ];

  /** The API's answers, and fetch's own failures, as the client meets them. */
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
  const text = (status: number, body: string): Response =>
    new Response(body, { status, headers: { "content-type": "text/plain" } });
  const refusedConnection = (): never => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11522"), {
        code: "ECONNREFUSED",
      }),
    });
  };

  /**
   * The read of each hit's thought. One that is there answers with itself
   * under the name its copy has, the deleted one with the API's 404, and
   * `now` says otherwise for the identifiers it names.
   */
  const reads = (now: Record<string, () => unknown> = {}): Route => [
    "GET /api/thoughts/",
    (url) => {
      const id = url.pathname.split("/").at(-1)!;
      const [, name] = COPIES.find(([copy]) => copy === id) ?? [];
      const asItIs = (): unknown => (id === GONE ? bareNotFound() : thought(name ?? "", { id }));
      return (now[id] ?? asItIs)();
    },
  ];

  const embedder: Embedder = {
    id: "fake@v1",
    dimensions: 2,
    embedDocuments: async (texts) => texts.map(() => new Float32Array([1, 0])),
    embedQuery: async () => new Float32Array([1, 0]),
  };
  /** An index that ranks Retrieval, Gazpacho, RAG, or only the `ids` of them it is given. */
  const indexed = (ids: readonly string[] = [OTHER, GONE, THOUGHT]): VectorStore => {
    const store = new VectorStore(":memory:");
    store.setMeta({
      brainId: BRAIN,
      model: indexModelId(embedder.id),
      dimensions: embedder.dimensions,
      syncedThrough: "2026-10-10T00:00:00.000Z",
    });
    const x: Record<string, number> = { [OTHER]: 1, [GONE]: 0.8, [THOUGHT]: 0.6 };
    store.upsert(
      COPIES.filter(([id]) => ids.includes(id)).map(([thoughtId, name]) => ({
        thoughtId,
        name,
        kind: 1,
        contentHash: "h",
        vector: new Float32Array([x[thoughtId]!, Math.sqrt(1 - x[thoughtId]! ** 2)]),
      })),
    );
    return store;
  };
  const searching =
    (store: VectorStore = new VectorStore(":memory:")) =>
    (api: TheBrainApi) => ({ search: () => new SemanticSearch(api, store, embedder) });

  const NOT_INDEXED =
    "## Warning\n" +
    "Semantic search unavailable: the semantic index has not been built yet — run a rebuild. " +
    "Fell back to substring name search, so recall is lower. " +
    "Build the index with the brain_index tool.";
  const STILL_RETURNED =
    " Its search goes on returning a deleted thought for about five seconds, and now and " +
    "then for good.";
  const SYNC =
    " The index holds a deleted thought until its next sync: call brain_index with action=sync.";
  const BEFORE_USING = " Read a thought with brain_get_thought before using its identifier.";
  const RUNNING = " Check that the TheBrain desktop app is running and its local API is enabled.";

  const search = async (
    routes: Route[],
    store?: VectorStore,
    args: Record<string, unknown> = {},
  ) => {
    const { call, calls } = await connect(routes, searching(store));
    const result = await call("brain_search", { brainId: BRAIN, query: "RAG", ...args });
    return { ...result, calls };
  };

  describe("with no index", () => {
    it("the hit is left out and counted, and the thoughts that are there are listed", async () => {
      const result = await search([searchFinds([THOUGHT, OTHER, GONE]), reads()]);
      expect(result.isError).toBe(false);
      expect(result.text).toBe(
        "## Found by substring\n" +
          "Score  Thought    Identifier                            Matched\n" +
          "─────  ─────────  ────────────────────────────────────  ───────\n" +
          `1.000  RAG        ${THOUGHT}  RAG\n` +
          `0.500  Retrieval  ${OTHER}  RAG\n\n` +
          "## Left out\n" +
          "1 hit was left out: TheBrain's search returned it, and the read of the thought " +
          `answered 404.${STILL_RETURNED}\n\n${NOT_INDEXED}`,
      );
      // An identifier nobody has is of no use to the model, and is not printed.
      expect(result.text).not.toContain(GONE);
      expect(result.text).not.toContain("Gazpacho");
    });

    it("costs one read a hit, after the search", async () => {
      const { calls } = await search([searchFinds([THOUGHT, OTHER, GONE]), reads()]);
      expect(calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual(
        [
          `GET /api/search/${BRAIN}`,
          `GET /api/thoughts/${BRAIN}/${THOUGHT}`,
          `GET /api/thoughts/${BRAIN}/${OTHER}`,
          `GET /api/thoughts/${BRAIN}/${GONE}`,
        ].sort(),
      );
    });

    it("the one hit being gone is not 'matched no thought'", async () => {
      // "Nothing: TheBrain's search matched no thought" would be false: it matched one.
      const result = await search([searchFinds([GONE]), reads()]);
      expect(result.isError).toBe(false);
      expect(result.text).toBe(
        "## Found by substring\n" +
          "Nothing that is still there: the one hit was a thought that is gone.\n\n" +
          "## Left out\n" +
          "1 hit was left out: TheBrain's search returned it, and the read of the thought " +
          `answered 404.${STILL_RETURNED}\n\n${NOT_INDEXED}`,
      );
    });

    it("several hits gone, and nothing else found, are said in the plural", async () => {
      const result = await search([
        searchFinds([THOUGHT, GONE]),
        reads({ [THOUGHT]: bareNotFound }),
      ]);
      expect(result.text).toBe(
        "## Found by substring\n" +
          "Nothing that is still there: each of the 2 hits was a thought that is gone.\n\n" +
          "## Left out\n" +
          "2 hits were left out: TheBrain's search returned them, and the read of each " +
          `thought answered 404.${STILL_RETURNED}\n\n${NOT_INDEXED}`,
      );
    });

    it("a thought the search still has under its old name is listed under the one it has now", async () => {
      // The hit carries the search's copy: the old name, and the old kind.
      const result = await search(
        [
          searchFinds([THOUGHT, OTHER]),
          reads({ [THOUGHT]: () => thought("Retrieval-augmented generation", { kind: 4 }) }),
        ],
        undefined,
        { includeAuxiliary: true },
      );
      expect(result.text).toContain(
        `1.000  Retrieval-augmented generation  ${THOUGHT}  tag   RAG\n`,
      );
      expect(result.text).not.toMatch(/1\.000 {2}RAG /);
    });

    it("a read that fails is not a thought that is gone: the hit stays, marked, and is named", async () => {
      const result = await search([
        searchFinds([THOUGHT, OTHER, GONE]),
        reads({ [OTHER]: () => text(500, "Internal Server Error") }),
      ]);
      // Not an error: the rest is a result, and what it does not say is named.
      expect(result.isError).toBe(false);
      expect(result.text).toBe(
        "## Found by substring\n" +
          "Score  Thought    Identifier                            Verified  Matched\n" +
          "─────  ─────────  ────────────────────────────────────  ────────  ───────\n" +
          `1.000  RAG        ${THOUGHT}            RAG\n` +
          `0.500  Retrieval  ${OTHER}  no        RAG\n\n` +
          "## Not verified\n" +
          "The read of 1 of the 2 thoughts above failed, so this result does not say whether " +
          `it is still there: TheBrain answered 500: Internal Server Error.${BEFORE_USING}\n\n` +
          "## Left out\n" +
          "1 hit was left out: TheBrain's search returned it, and the read of the thought " +
          `answered 404.${STILL_RETURNED}\n\n${NOT_INDEXED}`,
      );
    });

    it("the catch-all 403 on a thought's own read is a failure too, and not a 404", async () => {
      // It is what the graph of a thought nobody has gets. The thought's own
      // read answers 404 for one, so a 403 there says nothing of the thought.
      const result = await search([
        searchFinds([THOUGHT]),
        reads({ [THOUGHT]: generic403 }),
      ]);
      expect(result.isError).toBe(false);
      expect(result.text).toContain(`1.000  RAG      ${THOUGHT}  no        RAG`);
      expect(result.text).toContain(
        "## Not verified\n" +
          "The read of the thought above failed, so this result does not say whether it is " +
          `still there: TheBrain answered 403 and named no cause.${BEFORE_USING}`,
      );
      expect(result.text).not.toContain("## Left out");
    });

    it("reads that fail each in its own way are listed, each with its reason", async () => {
      const result = await search([
        searchFinds([THOUGHT, OTHER]),
        reads({ [THOUGHT]: () => text(500, "boom"), [OTHER]: generic403 }),
      ]);
      expect(result.text).toContain(
        "## Not verified\n" +
          "The read of each of the 2 thoughts above failed, so this result does not say " +
          "whether any of them is still there:\n" +
          `- ${THOUGHT}: TheBrain answered 500: boom.\n` +
          `- ${OTHER}: TheBrain answered 403 and named no cause.\n` +
          BEFORE_USING.trimStart(),
      );
    });
  });

  describe("with an index", () => {
    it("a thought deleted since the last sync is left out, and the result says to sync", async () => {
      // The index knows nothing of the delete: it ranked second, and was listed.
      const result = await search([reads()], indexed());
      expect(result.isError).toBe(false);
      expect(result.text).toBe(
        "## Found by meaning\n" +
          "Score  Thought    Identifier                            Matched\n" +
          "─────  ─────────  ────────────────────────────────────  ───────\n" +
          `1.000  Retrieval  ${OTHER}\n` +
          `0.600  RAG        ${THOUGHT}\n\n` +
          "## Left out\n" +
          "1 hit was left out: the semantic index holds it, and the read of the thought " +
          `answered 404.${SYNC}`,
      );
      expect(result.calls.map((c) => c.path).sort()).toEqual(
        [THOUGHT, OTHER, GONE].map((id) => `/api/thoughts/${BRAIN}/${id}`).sort(),
      );
    });

    it("the only row being of a thought that is gone is said, where nothing used to be printed", async () => {
      const result = await search([reads()], indexed([GONE]));
      expect(result.isError).toBe(false);
      expect(result.text).toBe(
        "## Found by meaning\n" +
          "Nothing that is still there: the one hit was a thought that is gone.\n\n" +
          "## Left out\n" +
          "1 hit was left out: the semantic index holds it, and the read of the thought " +
          `answered 404.${SYNC}`,
      );
    });

    it("with TheBrain not running the hits are listed, and none is passed for a thought that is there", async () => {
      // It listed them with no request at all, the deleted one among them.
      const result = await search([["GET /api/", refusedConnection]], indexed());
      expect(result.isError).toBe(false);
      expect(result.text).toBe(
        "## Found by meaning\n" +
          "Score  Thought    Identifier                            Verified  Matched\n" +
          "─────  ─────────  ────────────────────────────────────  ────────  ───────\n" +
          `1.000  Retrieval  ${OTHER}  no\n` +
          `0.800  Gazpacho   ${GONE}  no\n` +
          `0.600  RAG        ${THOUGHT}  no\n\n` +
          "## Not verified\n" +
          "The read of each of the 3 thoughts above failed, so this result does not say " +
          "whether any of them is still there: could not reach http://localhost:11522 or " +
          `http://localhost:8001 — is TheBrain running?${RUNNING}${BEFORE_USING}`,
      );
    });

    it("a hit that is a type and one that could not be read have a column each", async () => {
      const result = await search(
        [
          reads({
            [OTHER]: () => thought("Retrieval", { id: OTHER, kind: 2 }),
            [THOUGHT]: () => 503,
          }),
        ],
        indexed([OTHER, THOUGHT]),
      );
      expect(result.text).toContain(
        "Score  Thought    Identifier                            Kind  Verified  Matched\n" +
          "─────  ─────────  ────────────────────────────────────  ────  ────────  ───────\n" +
          `1.000  Retrieval  ${OTHER}  type\n` +
          `0.600  RAG        ${THOUGHT}        no\n\n`,
      );
      expect(result.text).toContain(
        "The read of 1 of the 2 thoughts above failed, so this result does not say whether " +
          "it is still there: TheBrain answered 503: (empty response).",
      );
    });

    it.each<[string, () => Response, RegExp]>([
      [
        "a key TheBrain rejects",
        () => text(401, "Invalid API Key"),
        /^TheBrain rejected the key\. Check THEBRAIN_API_KEY/,
      ],
      [
        "a brain that is no brain any more",
        () => text(401, `Access to brain ${BRAIN} is unauthorized.`),
        /^Access to brain \S+ is unauthorized\. The key was accepted: it is brainId/,
      ],
    ])("%s fails the search, where the index used to answer for it", async (_what, answer, told) => {
      // Nothing was asked in vector mode, so the hits of a brain that had been
      // deleted were listed as they stood in its index.
      const result = await search([["GET /api/thoughts/", answer]], indexed());
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(told);
      expect(result.text).not.toContain("## Found by meaning");
    });

    it("a hit left out makes the result shorter than the limit: nothing is read to fill its place", async () => {
      const result = await search([reads()], indexed(), { limit: 2 });
      // Retrieval and Gazpacho were the two. RAG is next in line, and is not asked for.
      expect(result.text).toContain(`1.000  Retrieval  ${OTHER}`);
      expect(result.text).not.toContain(THOUGHT);
      expect(result.text).toContain("1 hit was left out");
      expect(result.calls).toHaveLength(2);
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

    describe("without an embedder to rank by it", () => {
      // "usable: yes" was said from the index alone, of an index every
      // search fell back from: brain_search ranks by vectors only when the
      // embedder can embed the query.
      const INSTALL = "npm install -g @huggingface/transformers";
      const FALLS_BACK =
        " Until then brain_search answers from TheBrain's own search, and does not rank by " +
        "this index.";
      /** As the local embedder is without the package, or with one that does not load. */
      const without = (why: () => EmbedderUnavailableError): Embedder => {
        const fails = async (): Promise<never> => {
          throw why();
        };
        return {
          id: fake.id,
          dimensions: fake.dimensions,
          embedDocuments: fails,
          embedQuery: fails,
          isAvailable: async () => false,
          whyUnavailable: async () => why(),
        };
      };
      const absent = without(() => new EmbedderUnavailableError());
      const built = (): VectorStore => {
        const store = new VectorStore(":memory:");
        store.setMeta({ ...meta, syncedThrough: "2026-10-10T20:00:00.000Z" });
        store.upsert([vector]);
        return store;
      };
      const BUILT = [
        "thoughts indexed: 1",
        "model: fake@v1#doc3",
        "synced through: 2026-10-10T20:00:00.000Z",
      ];

      it("an index that is built is not called usable, and what to do is the package", async () => {
        const { call, calls } = await connect(brain, indexing(built(), absent).context);
        const result = await call("brain_index", { brainId: BRAIN, action: "status" });
        expect(result).toEqual({
          isError: false,
          text:
            `${status(["built: yes", "usable: no — the embeddings package is not installed", ...BUILT])}` +
            `\n\n## What to do\nInstall the embeddings package: ${INSTALL}.${FALLS_BACK}`,
        });
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([BRAINS]);
      });

      it("status and brain_search say the same of that index", async () => {
        const store = built();
        const hit = {
          sourceThought: thought("RAG"),
          sourceLink: null,
          searchResultType: 1,
          isFromOtherBrain: false,
          name: "RAG",
          brainName: null,
        };
        const { call } = await connect(
          [...brain, ["GET /api/search", () => [hit]], ["GET /api/thoughts/", () => thought("RAG")]],
          (api) => ({
            indexer: () => new SemanticIndexer(api, store, absent),
            search: () => new SemanticSearch(api, store, absent),
          }),
        );
        const said = await call("brain_index", { brainId: BRAIN, action: "status" });
        expect(said.text).toContain("- usable: no — the embeddings package is not installed\n");
        const found = await call("brain_search", { brainId: BRAIN, query: "RAG" });
        expect(found.isError).toBe(false);
        expect(found.text).toContain("## Found by substring\n");
        // The one way on, in both: the package, and no rebuild.
        for (const text of [said.text, found.text]) {
          expect(text).toContain(INSTALL);
          expect(text).not.toMatch(/action=rebuild|Build the index/);
        }

        // With an embedder that embeds, the same index is usable and ranked by.
        const able = await connect(
          [...brain, ["GET /api/thoughts/", () => thought("RAG")]],
          (api) => ({
            indexer: () => new SemanticIndexer(api, store, fake),
            search: () => new SemanticSearch(api, store, fake),
          }),
        );
        expect(
          (await able.call("brain_index", { brainId: BRAIN, action: "status" })).text,
        ).toBe(status(["built: yes", "usable: yes", ...BUILT]));
        expect((await able.call("brain_search", { brainId: BRAIN, query: "RAG" })).text).toContain(
          "## Found by meaning\n",
        );
      });

      it("a package that is there and does not load is not told as one that is not installed", async () => {
        // Any failure of the import read "is not installed", and its cause
        // was printed nowhere.
        const broken = without(
          () => new EmbedderUnavailableError(new Error("Cannot find module 'onnxruntime-node'.")),
        );
        const store = built();
        const { call } = await connect(brain, indexing(store, broken).context);
        const said = await call("brain_index", { brainId: BRAIN, action: "status" });
        expect(said).toEqual({
          isError: false,
          text:
            `${status(["built: yes", "usable: no — the embeddings package does not load", ...BUILT])}` +
            "\n\n## What to do\nThe embeddings package failed to load: Cannot find module " +
            `'onnxruntime-node'. Install it again: ${INSTALL}.${FALLS_BACK}`,
        });

        // A run is refused by the same reason, in the embedder's own words.
        const run = await call("brain_index", { brainId: BRAIN, action: "sync" });
        expect(run).toEqual({
          isError: true,
          text:
            "semantic search is off: the @huggingface/transformers package failed to load: " +
            "Cannot find module 'onnxruntime-node'. Substring name search is available " +
            "without it.",
        });
      });

      it("with no index either, the package comes before the rebuild", async () => {
        const { call } = await connect(
          brain,
          indexing(new VectorStore(":memory:"), absent).context,
        );
        const result = await call("brain_index", { brainId: BRAIN, action: "status" });
        expect(result.text).toBe(
          `${status([
            "built: no",
            "usable: no — the embeddings package is not installed",
            "thoughts indexed: 0",
            "model: —",
            "synced through: —",
          ])}\n\n## What to do\nInstall the embeddings package: ${INSTALL}. Then call this ` +
            "tool with action=rebuild.",
        );
      });
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

    it("a sync with no finished index to refresh is titled for what it ran as: a build", async () => {
      // The title went by the action asked for: "## Index refreshed", of a
      // sync that had read the whole brain and built its index.
      const fake = new FakeEmbedder();
      const unfinished = new VectorStore(":memory:");
      unfinished.setMeta({
        brainId: BRAIN,
        model: indexModelId(fake.id),
        dimensions: fake.dimensions,
        syncedThrough: null,
      });
      for (const store of [unfinished, new VectorStore(":memory:")]) {
        const { call } = await connect(brain, indexing(store).context);
        const result = await call("brain_index", { brainId: BRAIN, action: "sync" });
        expect(result.isError).toBe(false);
        expect(result.text).toMatch(
          /^## Index built\n- thoughts encoded: 1\n- skipped unchanged: 0\n- removed from index: 0\n- took: /,
        );
        expect(store.getMeta()!.syncedThrough).not.toBeNull();

        // And the next one, with an index to refresh, is a sync.
        const again = await call("brain_index", { brainId: BRAIN, action: "sync" });
        expect(again.text).toMatch(/^## Index refreshed\n- thoughts encoded: 0\n/);
      }
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

  describe("a run that cannot read every thought", () => {
    // A failed read of a thought was dropped: with every graph a 500 the
    // tool answered "Index built" or "Index refreshed", nothing encoded, and
    // a sync moved its watermark past the changes. Measured through this
    // tool on the live API, the failures put in at fetch (ARCHITECTURE §8).
    const A = THOUGHT;
    const B = PARENT;
    const C = LINK;
    const NAMES: Record<string, string> = { [A]: "RAG", [B]: "Retrieval", [C]: "Embeddings" };
    const THROUGH = "2026-10-01T00:00:00.000Z";
    const NOTE_OF_A = { modificationDateTime: "2026-10-01T10:00:09", markdown: "what RAG is" };
    const NOTED = [{ id: "a77ac4ed-0000-4000-8000-00000000000a", isNotes: true, type: 1 }];

    const created = (id: string, second: number) => ({
      sourceId: id,
      sourceType: 2,
      extraAId: "00000000-0000-0000-0000-000000000000",
      extraAType: -1,
      extraBId: "00000000-0000-0000-0000-000000000000",
      extraBType: -1,
      modType: 101,
      oldValue: null,
      newValue: null,
      userId: "u",
      brainId: BRAIN,
      creationDateTime: `2026-10-01T10:00:${String(second).padStart(2, "0")}`,
      modificationDateTime: `2026-10-01T10:00:${String(second).padStart(2, "0")}`,
      syncUpdateDateTime: null,
    });
    const idOf = (url: URL): string => /\/([0-9a-f-]{36})(?:\/graph)?$/.exec(url.pathname)![1]!;

    /**
     * A brain of three logged thoughts, the first with a note. `fails` puts
     * an answer in the way of a request: it returns nothing to let one through.
     */
    const three = (fails: (url: URL) => unknown = () => undefined): Route[] => [
      ["GET /modifications", (url) => fails(url) ?? [A, B, C].map((id, i) => created(id, i))],
      ["GET /api/brains/", () => ({ id: BRAIN, name: "Test brain", homeThoughtId: A })],
      [
        "GET /graph",
        (url) =>
          fails(url) ?? {
            ...graph(thought(NAMES[idOf(url)]!, { id: idOf(url) })),
            attachments: idOf(url) === A ? NOTED : null,
          },
      ],
      ["GET /api/notes/", (url) => fails(url) ?? NOTE_OF_A],
      ["GET /api/thoughts/", (url) => fails(url) ?? thought(NAMES[idOf(url)]!, { id: idOf(url) })],
    ];
    const graphOf = (id: string) => (url: URL) => url.pathname.endsWith(`${id}/graph`);
    const anyGraph = (url: URL): boolean => url.pathname.endsWith("/graph");
    const aNote = (url: URL): boolean => url.pathname.includes("/api/notes/");
    const when =
      (matches: (url: URL) => boolean, answer: () => unknown) =>
      (url: URL): unknown =>
        matches(url) ? answer() : undefined;
    const boom = (): Response => text(500, "Internal Server Error");
    const dropped = (): never => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
      });
    };

    /** The run's time is the one thing in a result that is not the same twice. */
    const timeless = (said: string): string => said.replace(/- took: [\d.]+ s/, "- took: T s");
    const run = async (store: VectorStore, action: "rebuild" | "sync", routes: Route[]) => {
      const { call, calls } = await connect(routes, indexing(store).context);
      const result = await call("brain_index", { brainId: BRAIN, action });
      return { ...result, text: timeless(result.text), calls, call };
    };
    /** An index of the three thoughts, built through the tool and synced through `THROUGH`. */
    const built = async (): Promise<VectorStore> => {
      const store = new VectorStore(":memory:");
      const first = await run(store, "rebuild", three());
      expect(first.isError).toBe(false);
      expect(first.text).toContain("## Index built\n- thoughts encoded: 3\n");
      store.setSyncedThrough(THROUGH);
      return store;
    };

    /** How the lead of "Not read" ends for a run that read some thoughts. */
    const AS_BEFORE =
      "is what it held before this run, which for a thought not yet indexed is nothing.";
    const UNWALKED =
      "What is next to a thought whose graph was not read was not walked to from it, so a " +
      "thought the log does not list may be missing as well.";
    const GRAPH_500 = "The read of the graph failed: TheBrain answered 500: Internal Server Error.";
    const UNBUILT =
      "Call this tool with action=rebuild again. The index is not built until a rebuild has " +
      "read every thought";
    const SYNC_AGAIN =
      `Call this tool with action=sync again. The index is still synced through ${THROUGH}: ` +
      "this run did not move that on, so the next one reads the same changes again.";

    describe("a rebuild", () => {
      it("with no thought read is an error that says so, and leaves nothing that reads as an index", async () => {
        const store = new VectorStore(":memory:");
        const result = await run(store, "rebuild", three(when(anyGraph, boom)));
        expect(result.isError).toBe(true);
        expect(result.text).toBe(
          "## Index not rebuilt\n" +
            "- thoughts read: 0 of 3\n" +
            "- written to the index: nothing, it is as it was\n" +
            "- took: T s\n\n" +
            "## Not read\n" +
            "None of the 3 thoughts the rebuild asked TheBrain for could be read. " +
            `${GRAPH_500}\n- ${A}\n- ${B}\n- ${C}\n${UNWALKED}\n\n` +
            `## What to do\n${UNBUILT}.`,
        );
        expect(store.getMeta()).toBeNull();

        // It read "built: yes" with a watermark, and brain_list "index: 0".
        const after = await result.call("brain_index", { brainId: BRAIN, action: "status" });
        expect(after.text).toBe(
          `${status([
            "built: no",
            "usable: no",
            "thoughts indexed: 0",
            "model: —",
            "synced through: —",
          ])}\n\n${REBUILD}`,
        );
      });

      it("with one thought not read says what it wrote and which it left, and is not finished", async () => {
        const store = new VectorStore(":memory:");
        const result = await run(store, "rebuild", three(when(graphOf(B), boom)));
        expect(result.isError).toBe(true);
        expect(result.text).toBe(
          "## Index rebuilt in part\n" +
            "- thoughts read: 2 of 3\n" +
            "- thoughts encoded: 2\n" +
            "- skipped unchanged: 0\n" +
            "- removed from index: 0\n" +
            "- took: T s\n\n" +
            "## Not read\n" +
            "1 of the 3 thoughts the rebuild asked TheBrain for could not be read. What the " +
            `index holds for it ${AS_BEFORE} ${GRAPH_500}\n- ${B}\n` +
            `${UNWALKED}\n\n` +
            `## What to do\n${UNBUILT}; brain_search ranks by what is in it meanwhile.`,
        );
        expect([...store.contentHashes().keys()].sort()).toEqual([A, C].sort());

        const after = await result.call("brain_index", { brainId: BRAIN, action: "status" });
        expect(after.text).toBe(
          `${status([
            "built: no — a build was started and did not finish",
            "usable: yes",
            "thoughts indexed: 2",
            "model: fake@v1#doc3",
            "synced through: —",
          ])}\n\n${REBUILD}`,
        );
      });

      it("over a built index, a note not read: the row is kept, and a sync is said not to go back for it", async () => {
        // The note's read gets the catch-all 403 for a moment after the note
        // is deleted. The thought was indexed as one with no note.
        const store = await built();
        const row = store.contentHashes().get(A);
        const result = await run(store, "rebuild", three(when(aNote, generic403)));
        expect(result.isError).toBe(true);
        expect(result.text).toBe(
          "## Index rebuilt in part\n" +
            "- thoughts read: 2 of 3\n" +
            "- thoughts encoded: 0\n" +
            "- skipped unchanged: 2\n" +
            "- removed from index: 0\n" +
            "- took: T s\n\n" +
            "## Not read\n" +
            "1 of the 3 thoughts the rebuild asked TheBrain for could not be read. What the " +
            `index holds for it ${AS_BEFORE} The read of the note failed: ` +
            "TheBrain answered 403 and named no cause. A note's read gets that answer for a " +
            `moment after the note is deleted.\n- RAG — ${A}\n\n` +
            "## What to do\n" +
            "Call this tool with action=rebuild again. action=sync would not go back for this " +
            `thought: it reads what changed since ${THROUGH}, which this run did not move on.`,
        );
        expect(store.contentHashes().get(A)).toBe(row);
        expect(store.getMeta()!.syncedThrough).toBe(THROUGH);
      });

      it("thoughts left for different reasons are listed each with its own", async () => {
        const store = new VectorStore(":memory:");
        const fails = (url: URL): unknown =>
          aNote(url) ? text(500, "boom") : graphOf(B)(url) ? text(503, "") : undefined;
        const result = await run(store, "rebuild", three(fails));
        expect(result.text).toContain(
          "## Not read\n" +
            "2 of the 3 thoughts the rebuild asked TheBrain for could not be read. What the " +
            `index holds for them ${AS_BEFORE}\n` +
            `- RAG — ${A}: The read of the note failed: TheBrain answered 500: boom.\n` +
            `- ${B}: The read of the graph failed: TheBrain answered 503: (empty response).\n` +
            `${UNWALKED}\n\n`,
        );
      });

      it("a graph refused with a 403 while the thought reads is said as that, with the thought's name", async () => {
        const store = new VectorStore(":memory:");
        const result = await run(store, "rebuild", three(when(graphOf(C), generic403)));
        expect(result.isError).toBe(true);
        expect(result.text).toContain(
          "The read of the graph failed: TheBrain answered 403 and named no cause, while the " +
            `thought itself reads.\n- Embeddings — ${C}\n`,
        );
        // The API's own words for that 403 are about the key, and are not passed on.
        expect(result.text).not.toContain("API key");
      });

      it("a graph refused with a 403 and a thought that does not read either: both are said", async () => {
        const store = new VectorStore(":memory:");
        const fails = (url: URL): unknown =>
          graphOf(C)(url) ? generic403() : url.pathname.endsWith(C) ? text(500, "boom") : undefined;
        const result = await run(store, "rebuild", three(fails));
        expect(result.isError).toBe(true);
        expect(result.text).toContain(
          "The read of the graph was a 403 that names no cause, and the read of the thought " +
            `itself failed: TheBrain answered 500: boom.\n- ${C}\n`,
        );
      });

      it("a thought whose graph is a 403 and whose own read is a 404 is gone, and no failure", async () => {
        const store = await built();
        const gone = (url: URL): unknown =>
          graphOf(B)(url) ? generic403() : url.pathname.endsWith(B) ? 404 : undefined;
        const result = await run(store, "rebuild", three(gone));
        expect(result.isError).toBe(false);
        expect(result.text).toBe(
          "## Index built\n- thoughts encoded: 0\n- skipped unchanged: 2\n" +
            "- removed from index: 1\n- took: T s",
        );
      });

      it("lists the first twenty of many, and counts the rest", async () => {
        const ids = Array.from(
          { length: 25 },
          (_, i) => `eeeeeeee-0000-4000-8000-${String(i).padStart(12, "0")}`,
        );
        const routes: Route[] = [
          ["GET /modifications", () => ids.map((id, i) => created(id, i))],
          ["GET /api/brains/", () => ({ id: BRAIN, name: "Test brain", homeThoughtId: ids[0] })],
          ["GET /graph", boom],
        ];
        const result = await run(new VectorStore(":memory:"), "rebuild", routes);
        expect(result.text).toContain("None of the 25 thoughts the rebuild asked TheBrain for");
        expect(result.text.split("\n").filter((l) => l.startsWith("- eeeeeeee"))).toHaveLength(20);
        expect(result.text).toContain(`- ${ids[19]}\n- and 5 more, not listed\n`);
      });

      it("rows the walk did not reach are counted as kept", async () => {
        // D is in no log and next to B alone: with B's graph not read it is
        // not reached, and its row was removed.
        const D = "abababab-0000-4000-8000-000000000007";
        const linked = (fails: (url: URL) => unknown): Route[] => [
          ["GET /modifications", () => [A, B].map((id, i) => created(id, i))],
          ["GET /api/brains/", () => ({ id: BRAIN, name: "Test brain", homeThoughtId: A })],
          [
            "GET /graph",
            (url) =>
              fails(url) ?? {
                ...graph(thought(NAMES[idOf(url)] ?? "Dense retrieval", { id: idOf(url) })),
                jumps: idOf(url) === B ? [thought("Dense retrieval", { id: D })] : null,
              },
          ],
        ];
        const store = new VectorStore(":memory:");
        await run(store, "rebuild", linked(() => undefined));
        expect(store.size()).toBe(3);

        const result = await run(store, "rebuild", linked(when(graphOf(B), boom)));
        expect(result.text).toContain("- removed from index: 0\n");
        expect(result.text).toContain(
          `${UNWALKED} 1 row of a thought the walk did not reach was left in the index, not removed.`,
        );
        expect(store.contentHashes().has(D)).toBe(true);
      });
    });

    describe("a sync", () => {
      it("with one thought not read says so, and that the watermark was not moved", async () => {
        const store = await built();
        const result = await run(store, "sync", three(when(graphOf(B), boom)));
        expect(result.isError).toBe(true);
        expect(result.text).toBe(
          "## Index refreshed in part\n" +
            "- thoughts read: 2 of 3\n" +
            "- thoughts encoded: 0\n" +
            "- skipped unchanged: 2\n" +
            "- removed from index: 0\n" +
            "- took: T s\n\n" +
            "## Not read\n" +
            "1 of the 3 thoughts the sync asked TheBrain for could not be read. What the " +
            `index holds for it ${AS_BEFORE} ${GRAPH_500}\n- ${B}\n\n` +
            `## What to do\n${SYNC_AGAIN}`,
        );
        expect(store.getMeta()!.syncedThrough).toBe(THROUGH);
      });

      it("with no thought read is an error, not a refresh", async () => {
        const store = await built();
        const result = await run(store, "sync", three(when(anyGraph, generic403)));
        expect(result.isError).toBe(true);
        expect(result.text).toBe(
          "## Index not refreshed\n" +
            "- thoughts read: 0 of 3\n" +
            "- written to the index: nothing, it is as it was\n" +
            "- took: T s\n\n" +
            "## Not read\n" +
            "None of the 3 thoughts the sync asked TheBrain for could be read. The read of " +
            "the graph failed: TheBrain answered 403 and named no cause, while the thought " +
            `itself reads.\n- RAG — ${A}\n- Retrieval — ${B}\n- Embeddings — ${C}\n\n` +
            `## What to do\n${SYNC_AGAIN}`,
        );
        expect(store.getMeta()!.syncedThrough).toBe(THROUGH);
      });

      it("with every thought read it reads as it did, and moves the watermark", async () => {
        const store = await built();
        const result = await run(store, "sync", three());
        expect(result.isError).toBe(false);
        expect(result.text).toBe(
          "## Index refreshed\n- thoughts encoded: 0\n- skipped unchanged: 3\n" +
            "- removed from index: 0\n- took: T s",
        );
        expect(store.getMeta()!.syncedThrough).not.toBe(THROUGH);
      });

      it("with no finished index it is a rebuild, and is told as one", async () => {
        const store = new VectorStore(":memory:");
        const result = await run(store, "sync", three(when(graphOf(B), boom)));
        expect(result.isError).toBe(true);
        expect(result.text).toContain("## Index rebuilt in part\n- thoughts read: 2 of 3\n");
        expect(result.text).toContain(`## What to do\n${UNBUILT}`);
      });
    });

    describe("a failure that is not one thought's", () => {
      const STOPPED = (action: string): string =>
        ` The ${action} stopped at that request and wrote nothing: the index is as it was.`;

      it.each(["rebuild", "sync"] as const)(
        "TheBrain not answering at a graph stops the %s, which says the index is as it was",
        async (action) => {
          const store = await built();
          const result = await run(store, action, three(when(graphOf(B), dropped)));
          expect(result.isError).toBe(true);
          expect(result.text).toBe(
            "the connection to http://localhost:11522 failed before an answer came (other " +
              "side closed). Check that the TheBrain desktop app is running and its local " +
              `API is enabled.${STOPPED(action)}`,
          );
          expect(store.getMeta()!.syncedThrough).toBe(THROUGH);
          expect(store.size()).toBe(3);
        },
      );

      it("the log failing to read stops a rebuild before it has written the metadata of a build", async () => {
        const store = new VectorStore(":memory:");
        const fails = when((url) => url.pathname.endsWith("/modifications"), boom);
        const result = await run(store, "rebuild", three(fails));
        expect(result.isError).toBe(true);
        expect(result.text).toBe(
          `TheBrain failed with a 500 (GET /api/brains/${BRAIN}/modifications): Internal ` +
            "Server Error. The fault is inside the app, not in the arguments of this call. A " +
            `read is safe to repeat; before repeating a write, check what it left.${STOPPED("rebuild")}`,
        );
        expect(store.getMeta()).toBeNull();
      });

      it("a key rejected in the middle of a run stops it", async () => {
        const store = new VectorStore(":memory:");
        const fails = when(anyGraph, () => text(401, "Invalid API Key"));
        const result = await run(store, "rebuild", three(fails));
        expect(result.isError).toBe(true);
        expect(result.text).toBe(
          "TheBrain rejected the key. Check THEBRAIN_API_KEY: find it under Settings > User > " +
            `Local API Key.${STOPPED("rebuild")}`,
        );
        expect(store.getMeta()).toBeNull();
      });
    });

    describe("without the embeddings package", () => {
      /** As the local embedder reports the package that is not installed. */
      class NoPackage extends FakeEmbedder {
        async isAvailable(): Promise<boolean> {
          return false;
        }
      }

      it.each(["rebuild", "sync"] as const)(
        "%s says so after the one request for the brain, and status has no build to speak of",
        async (action) => {
          // A rebuild read the whole log and walked the graph first: 13
          // requests on a brain of one thought, minutes on a real one.
          const store = new VectorStore(":memory:");
          const { call, calls } = await connect(three(), indexing(store, new NoPackage()).context);
          const result = await call("brain_index", { brainId: BRAIN, action });
          expect(result.isError).toBe(true);
          expect(result.text).toMatch(/@huggingface\/transformers package is not installed/);
          expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([BRAINS]);

          // Status knows what the run was refused for, and says that first:
          // "Call this tool with action=rebuild" alone sent the model back
          // to the call that had just failed.
          const after = await call("brain_index", { brainId: BRAIN, action: "status" });
          expect(after.text).toBe(
            `${status([
              "built: no",
              "usable: no — the embeddings package is not installed",
              "thoughts indexed: 0",
              "model: —",
              "synced through: —",
            ])}\n\n## What to do\nInstall the embeddings package: npm install -g ` +
              "@huggingface/transformers. Then call this tool with action=rebuild.",
          );
        },
      );
    });
  });

  describe("brain_list and an index that is not one", () => {
    const fake = new FakeEmbedder();
    const meta = {
      brainId: BRAIN,
      model: indexModelId(fake.id),
      dimensions: fake.dimensions,
      syncedThrough: null,
    };
    const row = {
      thoughtId: THOUGHT,
      name: "RAG",
      kind: 1,
      contentHash: "h",
      vector: new Float32Array([1, 0]),
    };
    const cell = async (store: VectorStore): Promise<string> => {
      const { call } = await connect(
        [
          ["GET /api/app/state", () => ({ currentBrainId: null })],
          ["GET /api/brains", () => [{ id: BRAIN, name: "Work" }]],
        ],
        indexing(store).context,
      );
      const result = await call("brain_list", {});
      expect(result.isError).toBe(false);
      return result.text.split("\n")[3]!.split(BRAIN)[1]!.trim();
    };

    it("no index at all", async () => {
      expect(await cell(new VectorStore(":memory:"))).toBe("no index");
    });

    it("an index that was built", async () => {
      const store = new VectorStore(":memory:");
      store.setMeta({ ...meta, syncedThrough: "2026-10-10T20:00:00.000Z" });
      store.upsert([row]);
      expect(await cell(store)).toBe("index: 1");
    });

    it("a build that never finished is not an index of no thoughts", async () => {
      // It printed "index: 0".
      const store = new VectorStore(":memory:");
      store.setMeta(meta);
      expect(await cell(store)).toBe("build not finished");
    });

    it("a build that did not finish and holds thoughts is what search ranks by, and is said to be unfinished", async () => {
      const store = new VectorStore(":memory:");
      store.setMeta(meta);
      store.upsert([row]);
      expect(await cell(store)).toBe("index: 1, build not finished");
    });

    it("an index built with another model is none that can be used", async () => {
      const store = new VectorStore(":memory:");
      store.setMeta({ ...meta, model: "other@v2#doc3", syncedThrough: "2026-10-10T20:00:00.000Z" });
      store.upsert([row]);
      expect(await cell(store)).toBe("no index");
    });
  });

  describe("an index another server process is at", () => {
    // Every client session runs a server of its own over the same index
    // file. Of two runs started together one answered `database is locked`,
    // SQLite's words and the whole result, in 11 pairs of 13 with two real
    // processes (ARCHITECTURE §8).
    const fake = new FakeEmbedder();
    const built = {
      brainId: BRAIN,
      model: indexModelId(fake.id),
      dimensions: fake.dimensions,
      syncedThrough: "2026-10-10T20:00:00.000Z",
    };
    /** A server whose runs wait 30 ms for another's. */
    const impatient = (store: VectorStore) => (api: TheBrainApi) => ({
      indexer: () => new SemanticIndexer(api, store, fake, { runWaitMs: 30 }),
    });
    const SHARED =
      "Every client session runs a server process of its own, and they share one index file";

    it.each(["rebuild", "sync"] as const)(
      "a %s while another run holds the index says so, having read nothing and written nothing",
      async (action) => {
        const store = new VectorStore(":memory:");
        store.setMeta(built);
        const release = await store.claim();
        const { call, calls } = await connect(brain, impatient(store));

        const result = await call("brain_index", { brainId: BRAIN, action });
        expect(result.isError).toBe(true);
        expect(result.text).toBe(
          "Another rebuild or sync of this brain's semantic index is running, and had not " +
            `finished after 0.03 s of waiting. ${SHARED}, which one run writes at a time. ` +
            `This ${action} read nothing and wrote nothing. brain_search ranks by the index ` +
            `as it stands meanwhile. Call this tool with action=${action} again once that ` +
            "run is done.",
        );
        // The brain was asked for, as for every action, and nothing after it.
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([BRAINS]);
        expect(store.getMeta()).toEqual(built);
        expect(store.size()).toBe(0);

        // A look is not a run: status is answered while the index is held.
        const looked = await call("brain_index", { brainId: BRAIN, action: "status" });
        expect(looked.isError).toBe(false);
        expect(looked.text).toContain("- built: yes\n");

        release();
        const again = await call("brain_index", { brainId: BRAIN, action });
        expect(again.isError).toBe(false);
        expect(again.text).toMatch(/^## Index (built|refreshed)\n/);
      },
    );

    it("a write that waits out another process's lock on the file is told as that, not as `database is locked`", async () => {
      const dir = mkdtempSync(join(tmpdir(), "thebrain-mcp-tools-"));
      const path = join(dir, `index-${BRAIN}.sqlite`);
      const store = new VectorStore(path, { busyTimeoutMs: 30 });
      store.setMeta(built);
      // Some other process, part of the way through a write of its own.
      const writing = new DatabaseSync(path);
      writing.exec("BEGIN IMMEDIATE");
      try {
        const { call } = await connect(brain, impatient(store));
        const result = await call("brain_index", { brainId: BRAIN, action: "rebuild" });
        expect(result.isError).toBe(true);
        expect(result.text).toBe(
          "Another server process had the semantic index of this brain locked, and had not " +
            `let go of it after 0.03 s. ${SHARED}. This write to the index was not made. ` +
            "The rebuild stopped there: what it had already written stays in the index, and " +
            "the index is not marked as synced any further than it was. Call this tool with " +
            "action=rebuild again: it encodes only what is still missing.",
        );
        expect(store.size()).toBe(0);

        // The run gave the index back when it stopped: the next one is not kept waiting.
        writing.exec("ROLLBACK");
        const again = await call("brain_index", { brainId: BRAIN, action: "rebuild" });
        expect(again.isError).toBe(false);
        expect(again.text).toContain("## Index built\n- thoughts encoded: 1\n");
      } finally {
        writing.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
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
    // The lookup has the attachment from the post on, and not after the delete.
    let on = false;
    const { call, calls, sent } = await connect([
      ["POST /api/links/", () => ((on = true), { id: LINK })],
      ["GET /api/links/", () => (on ? { id: LINK, ...tagLink } : 404)],
      ["DELETE /api/links/", () => ((on = false), 200)],
      ...routes(),
    ]);
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
    // once more. The lookup goes ahead of the attach, as of the removal.
    const tag = `GET /api/thoughts/${BRAIN}/${TAG}`;
    const lookup = `GET /api/links/${BRAIN}/${THOUGHT}/${TAG}`;
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      tag,
      tag,
      lookup,
      tag,
      `POST /api/links/${BRAIN}`,
      lookup,
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

describe("a label, a tag and a link that are there already", () => {
  const TAG = "ffffffff-0000-4000-8000-000000000006";
  const TOP = "eeeeeeee-0000-4000-8000-000000000005";
  const LEAF = "eeeeeeee-0000-4000-8000-000000000055";
  const NEXT =
    "## Next\nThe identifiers above work immediately. To show the result to the user, open " +
    "the root thought with brain_activate. Refresh the semantic index with brain_index " +
    "using action=sync.";
  const jump = { thoughtIdA: THOUGHT, thoughtIdB: PARENT, relation: 3, meaning: 1 };

  /** A brain whose two thoughts are joined by `link`, or by nothing. */
  const joined = (link: Record<string, unknown> | null): Route[] => [
    ["GET /api/thoughts/", () => thought("RAG", { aliases: [] })],
    ["GET /api/links/", () => (link === null ? 404 : { id: LINK, ...link })],
    ["POST /api/links/", () => ({ id: LINK })],
    ["PATCH /api/links/", () => 200],
  ];
  const ends = { brainId: BRAIN, fromId: THOUGHT, toId: PARENT };

  it("brain_link quotes the label it replaced, and the one the link has now", async () => {
    // It answered "label updated" and no more: 3 times of 3 on a live
    // TheBrain 15.0.640, the label a person had written gone with it.
    const { call, sent } = await connect(joined({ ...jump, name: "contradicts" }));
    const result = await call("brain_link", { ...ends, name: "refines" });
    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      `## Link already existed\nidentifier ${LINK}, label updated: it was "contradicts" ` +
        'and is now "refines"',
    );
    expect(sent("PATCH")).toEqual([[{ op: "replace", path: "/name", value: "refines" }]]);

    // The same on a link of another kind than the one asked for.
    const other = await connect(joined({ ...jump, name: "contradicts" }));
    const parent = await other.call("brain_link", { ...ends, relation: "parent", name: "refines" });
    expect(parent.text).toBe(
      `## Link already existed\nidentifier ${LINK}: the link already existed as jump, the ` +
        "requested parent-child with toId above was not added — only the label was updated: " +
        'it was "contradicts" and is now "refines"',
    );
    expect(other.sent("PATCH")).toHaveLength(1);
  });

  it("brain_link does not send a label the link has, and says it is there", async () => {
    // The write is a 200 that changes nothing and logs nothing; it was sent
    // every time, and answered "label updated".
    for (const name of ["contradicts", "  contradicts\n"]) {
      const { call, calls } = await connect(joined({ ...jump, name: "contradicts" }));
      const result = await call("brain_link", { ...ends, name });
      expect(result.isError, JSON.stringify(name)).toBe(false);
      expect(result.text).toBe(
        `## Link already existed\nidentifier ${LINK}, label already "contradicts"`,
      );
      expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    }
    const mismatch = await connect(joined({ ...jump, name: "contradicts" }));
    const result = await mismatch.call("brain_link", {
      ...ends,
      relation: "child",
      name: "contradicts",
    });
    expect(result.text).toBe(
      `## Link already existed\nidentifier ${LINK}: the link already existed as jump, the ` +
        "requested parent-child with fromId above was not added, and its label is already " +
        '"contradicts"',
    );
    expect(mismatch.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("brain_link answers a first label as it did, on a link never named and on one cleared", async () => {
    for (const name of [null, ""]) {
      const { call, sent } = await connect(joined({ ...jump, name }));
      const result = await call("brain_link", { ...ends, name: "refines" });
      expect(result.text).toBe(`## Link already existed\nidentifier ${LINK}, label updated`);
      expect(sent("PATCH")).toHaveLength(1);
    }
  });

  /**
   * A brain where PARENT has "Top", and "Top" has "Leaf" and "Side". `tagged`
   * are the thoughts TAG is on, and `links` what joins a pair, by the two
   * identifiers in the order they are asked for.
   */
  const SIDE = "eeeeeeee-0000-4000-8000-000000000555";
  const grown = (tagged: string[], links: Record<string, Record<string, unknown>>): Route[] => {
    const under: Record<string, Array<{ id: string; name: string; kind: number }>> = {
      [PARENT]: [{ id: TOP, name: "Top", kind: 1 }],
      [TOP]: [
        { id: LEAF, name: "Leaf", kind: 1 },
        { id: SIDE, name: "Side", kind: 1 },
      ],
    };
    return [
      [
        "GET /graph",
        (url) => {
          const id = url.pathname.split("/").at(-2)!;
          return { ...graph(thought("t", { id })), children: under[id] ?? [] };
        },
      ],
      [
        "GET /api/thoughts/",
        (url) => {
          const id = url.pathname.split("/").pop()!;
          return thought(id === TAG ? "gotcha" : "t", { id, kind: id === TAG ? 4 : 1, aliases: [] });
        },
      ],
      [
        "GET /api/links/",
        (url) => {
          const [a, b] = url.pathname.split("/").slice(-2) as [string, string];
          if (b === TAG && tagged.includes(a)) {
            return { id: LINK, thoughtIdA: TAG, thoughtIdB: a, relation: 1, meaning: 5 };
          }
          const link = links[`${a} ${b}`] ?? links[`${b} ${a}`];
          return link === undefined ? 404 : { id: LINK, meaning: 1, ...link };
        },
      ],
      ["POST /api/thoughts/", () => ({ id: THOUGHT })],
      ["POST /api/links/", () => ({ id: LINK })],
      ["PATCH /api/links/", () => 200],
    ];
  };
  const plan = {
    brainId: BRAIN,
    thoughts: [
      { tempId: "top", name: "Top", parent: PARENT, tagIds: [TAG] },
      { tempId: "leaf", name: "Leaf", parent: "top", tagIds: [TAG] },
      { tempId: "side", name: "Side", parent: "top" },
    ],
    links: [
      { from: "leaf", to: "side", name: "motivates" },
      { from: "top", to: "leaf", name: "has part" },
    ],
  };
  /** What a first run of the plan leaves: both tags on, both labels written. */
  const afterFirstRun = {
    [`${LEAF} ${SIDE}`]: { thoughtIdA: LEAF, thoughtIdB: SIDE, relation: 3, name: "motivates" },
    [`${TOP} ${LEAF}`]: { thoughtIdA: TOP, thoughtIdB: LEAF, relation: 1, name: "has part" },
  };

  it("a second run of a plan sends no write for a tag or a label that is there, and says so", async () => {
    // It sent an attach for each tag and a label for each link, every run:
    // 5 writes for this plan's kind on a live TheBrain 15.0.640, and a `402`
    // logged against each tag's attachment.
    const { call, calls } = await connect(grown([TOP, LEAF], afterFirstRun));
    const result = await call("brain_ingest", plan);

    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      [
        "## Thoughts",
        "Outcome  Title  Identifier",
        "───────  ─────  ────────────────────────────────────",
        `existed  Top    ${TOP}`,
        `existed  Leaf   ${LEAF}`,
        `existed  Side   ${SIDE}`,
        "",
        "## Also",
        "- links created: 0",
        "- notes written: 0",
        "- tags attached: 0",
        "- tags already attached: 2",
        "",
        "## Links that already existed",
        '- leaf -> side: the link already existed, label already "motivates"',
        "- top -> leaf: the link already existed as parent-child with top above, the requested " +
          'jump was not added, and its label is already "has part"',
        "",
        NEXT,
      ].join("\n"),
    );
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    // One lookup a tag, where there were a read of the tag and an attach.
    const lookups = calls.filter((c) => c.path.endsWith(`/${TAG}`) && c.path.includes("/links/"));
    expect(lookups.map((c) => c.path.split("/").at(-2)).sort()).toEqual([TOP, LEAF].sort());
  });

  it("a tag that is missing from a thought that was there is attached, and counted apart", async () => {
    const { call, sent } = await connect(grown([LEAF], afterFirstRun));
    const result = await call("brain_ingest", plan);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("- tags attached: 1\n- tags already attached: 1\n");
    expect(sent("POST")).toEqual([{ thoughtIdA: TOP, thoughtIdB: TAG, relation: 2 }]);
  });

  it("a label a plan replaces is quoted in its line", async () => {
    const { call, sent } = await connect(
      grown([TOP, LEAF], {
        ...afterFirstRun,
        [`${LEAF} ${SIDE}`]: { thoughtIdA: LEAF, thoughtIdB: SIDE, relation: 3, name: "by hand" },
      }),
    );
    const result = await call("brain_ingest", plan);
    expect(result.isError).toBe(false);
    expect(result.text).toContain(
      '- leaf -> side: the link already existed, label updated: it was "by hand" and is now ' +
        '"motivates"\n',
    );
    expect(sent("PATCH")).toEqual([[{ op: "replace", path: "/name", value: "motivates" }]]);
  });

  it("a first run that makes everything reads as it did, to the character", async () => {
    // Nothing is looked up for a thought the batch made, and a first label
    // is "label updated" still.
    const { call, calls } = await connect(grownFresh());
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [
        { tempId: "top", name: "Top", parent: PARENT, tagIds: [TAG] },
        { tempId: "leaf", name: "Leaf", parent: "top", tagIds: [TAG] },
      ],
      links: [
        { from: "top", to: "leaf", name: "has part" },
        { from: "leaf", to: PARENT, name: "motivates" },
      ],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      [
        "## Thoughts",
        "Outcome  Title  Identifier",
        "───────  ─────  ────────────────────────────────────",
        `created  Top    ${TOP}`,
        `created  Leaf   ${LEAF}`,
        "",
        "## Also",
        "- links created: 1",
        "- notes written: 0",
        "- tags attached: 2",
        "",
        "## Links that already existed",
        "- top -> leaf: the link already existed as parent-child with top above, the requested " +
          "jump was not added — only the label was updated",
        "",
        NEXT,
      ].join("\n"),
    );
    const sentTo = (method: string, part: string): number =>
      calls.filter((c) => c.method === method && c.path.includes(part)).length;
    expect(sentTo("POST", "/api/thoughts/")).toBe(2);
    // Two attaches and one link, and one label onto the link the create made.
    expect(sentTo("POST", "/api/links/")).toBe(3);
    expect(sentTo("PATCH", "/api/links/")).toBe(1);
    // No lookup for a tag: the two reads of a pair are the plan's two links.
    expect(sentTo("GET", "/api/links/")).toBe(2);
  });

  /** An empty brain but for PARENT and TAG: a create comes back as TOP, then as LEAF. */
  function grownFresh(): Route[] {
    const made = [TOP, LEAF];
    return [
      ["GET /graph", (url) => graph(thought("t", { id: url.pathname.split("/").at(-2)! }))],
      [
        "GET /api/thoughts/",
        (url) => {
          const id = url.pathname.split("/").pop()!;
          return thought(id === TAG ? "gotcha" : "t", { id, kind: id === TAG ? 4 : 1, aliases: [] });
        },
      ],
      [
        "GET /api/links/",
        (url) =>
          url.pathname.endsWith(`/${TOP}/${LEAF}`)
            ? { id: LINK, thoughtIdA: TOP, thoughtIdB: LEAF, relation: 1, meaning: 1, name: null }
            : 404,
      ],
      ["POST /api/thoughts/", () => ({ id: made.shift() })],
      ["POST /api/links/", () => ({ id: LINK })],
      ["PATCH /api/links/", () => 200],
    ];
  }

  it("two links of a plan between one pair: the first is sent, the other listed as not added", async () => {
    // Both used to post, at once, under "links created: 2", and two links
    // between one pair is what they left 14 times in 20.
    const { call, sent } = await connect(grown([], {}));
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [
        { tempId: "top", name: "Top", parent: PARENT },
        { tempId: "leaf", name: "Leaf", parent: "top" },
        { tempId: "side", name: "Side", parent: "top" },
      ],
      links: [
        { from: "leaf", to: "side", name: "motivates" },
        { from: "side", to: "leaf", relation: "child", name: "is part of" },
        { from: LEAF, to: SIDE },
      ],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("- links created: 1\n");
    const ahead =
      "the plan has a link between the same two thoughts ahead of this one, leaf -> side, " +
      "and two thoughts share one link: this one was not sent";
    expect(result.text).toContain(
      [
        "## Links not added",
        `- side -> leaf: ${ahead}, and its label "is part of" was not written`,
        `- ${LEAF} -> ${SIDE}: ${ahead}`,
        "",
        NEXT,
      ].join("\n"),
    );
    expect(sent("POST")).toEqual([
      { thoughtIdA: LEAF, thoughtIdB: SIDE, relation: 3, name: "motivates" },
    ]);
    expect(sent("PATCH")).toEqual([]);
  });
});

describe("a link changed or removed", () => {
  const TYPE = "eeeeeeee-0000-4000-8000-000000000005";
  const TAG = "ffffffff-0000-4000-8000-000000000006";
  const ELSEWHERE = "12121212-0000-4000-8000-000000000012";
  const LINK_2 = "dddddddd-0000-4000-8000-000000000044";
  const LINK_3 = "dddddddd-0000-4000-8000-000000000444";
  const ZEROS = "00000000-0000-0000-0000-000000000000";
  /** THOUGHT, PARENT and ELSEWHERE ordinary, TAG a tag and TYPE a type. */
  const THOUGHTS: Record<string, { name: string; kind: number }> = {
    [THOUGHT]: { name: "RAG", kind: 1 },
    [PARENT]: { name: "Constraints", kind: 1 },
    [ELSEWHERE]: { name: "Reading", kind: 1 },
    [TAG]: { name: "gotcha", kind: 4 },
    [TYPE]: { name: "Pattern", kind: 2 },
  };
  interface Link {
    id: string;
    thoughtIdA: string;
    thoughtIdB: string;
    relation: number;
    meaning: number;
    name: string | null;
  }
  /** A link as the API stores it: `thoughtIdA` above, the tag, the type. */
  const link = (
    id: string,
    a: string,
    b: string,
    relation: number,
    { meaning = 1, name = null }: { meaning?: number; name?: string | null } = {},
  ): Link => ({ id, thoughtIdA: a, thoughtIdB: b, relation, meaning, name });
  /** THOUGHT and PARENT each under ELSEWHERE, so that neither is left alone. */
  const PARENTED = [link(LINK_3, ELSEWHERE, THOUGHT, 1), link(`${LINK_3.slice(0, -1)}5`, ELSEWHERE, PARENT, 1)];

  /**
   * A brain whose links are `links`. A graph lists each link of its thought,
   * and the lookup of a pair answers as the API's does: its one link; of two
   * that go each way the one whose `thoughtIdA` is named first; and a 404 for
   * two the same way (L35, L43). `lookup` is the lookup's answer instead. A
   * post answers `posted`; `first` goes ahead of the routes.
   */
  const brain = (
    links: Link[],
    {
      lookup,
      posted = LINK,
      first = [],
    }: { lookup?: Link | null; posted?: string; first?: Route[] } = {},
  ): Route[] => [
    ...first,
    [
      "GET /graph",
      (url) => {
        const id = url.pathname.split("/").at(-2)!;
        if (!(id in THOUGHTS)) return generic403();
        return {
          ...graph({ ...thought("", { aliases: [] }), id, ...THOUGHTS[id] }),
          links: links.filter((l) => [l.thoughtIdA, l.thoughtIdB].includes(id)),
        };
      },
    ],
    [
      "GET /api/thoughts/",
      (url) => {
        const id = url.pathname.split("/").pop()!;
        return id in THOUGHTS ? { ...thought("", { aliases: [] }), id, ...THOUGHTS[id] } : 404;
      },
    ],
    [
      "GET /api/links/",
      (url) => {
        if (lookup !== undefined) return lookup ?? 404;
        const [a, b] = url.pathname.split("/").slice(-2) as [string, string];
        const pair = links.filter(
          (l) => [l.thoughtIdA, l.thoughtIdB].includes(a) && [l.thoughtIdA, l.thoughtIdB].includes(b),
        );
        if (pair.length === 1) return pair[0];
        const first = pair.filter((l) => l.thoughtIdA === a);
        return first.length === 1 ? first[0] : 404;
      },
    ],
    ["POST /api/links/", () => ({ id: posted })],
    ["PATCH /api/links/", () => 200],
    ["DELETE /api/links/", () => 200],
  ];
  const requests = (calls: Array<{ method: string; path: string }>): string[] =>
    calls.map((c) => `${c.method} ${c.path}`);
  const writes = (calls: Array<{ method: string; path: string }>): string[] =>
    requests(calls.filter((c) => c.method !== "GET"));
  const ends = { brainId: BRAIN, fromId: THOUGHT, toId: PARENT };
  const said = (status: number, body: unknown) => (): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const noAnswer = (): never => {
    // What the client makes of a timeout: the request may have reached TheBrain.
    throw new DOMException("timed out", "TimeoutError");
  };

  describe("brain_link with replace", () => {
    it("makes the link that is there the one asked for, under its identifier, and says what it was", async () => {
      // It used to have no way to: the result said what was there, and a
      // post over a link that is there is what rewrites it (L21, L43).
      for (const [existing, relation, was, now, posted] of [
        [link(LINK, THOUGHT, PARENT, 3), "parent", "jump", "parent-child with toId above", 2],
        [link(LINK, THOUGHT, PARENT, 3), "child", "jump", "parent-child with fromId above", 1],
        // A jump stored from the other end is the same jump.
        [link(LINK, PARENT, THOUGHT, 3), "child", "jump", "parent-child with fromId above", 1],
        [link(LINK, PARENT, THOUGHT, 1), undefined, "parent-child with toId above", "jump", 3],
        [
          link(LINK, PARENT, THOUGHT, 1),
          "child",
          "parent-child with toId above",
          "parent-child with fromId above",
          1,
        ],
        [
          link(LINK, THOUGHT, PARENT, 1),
          "parent",
          "parent-child with fromId above",
          "parent-child with toId above",
          2,
        ],
      ] as const) {
        const { call, calls, sent } = await connect(brain([existing, ...PARENTED]));
        const asked = relation === undefined ? {} : { relation };
        const result = await call("brain_link", { ...ends, ...asked, replace: true });
        expect(result, `${was} -> ${now}`).toEqual({
          isError: false,
          text: `## Link changed\nidentifier ${LINK}: from ${was} to ${now}`,
        });
        expect(sent("POST")).toEqual([{ thoughtIdA: THOUGHT, thoughtIdB: PARENT, relation: posted }]);
        expect(writes(calls)).toEqual([`POST /api/links/${BRAIN}`]);
      }
    });

    it("reads the upper end and the pair from each end before its one write, and a graph only for a second link", async () => {
      // The one link a pair has is what the lookup gives from either end. A
      // graph, a copy, can list a second straight after it was removed.
      const stale = [link(LINK, THOUGHT, PARENT, 3), link(LINK_2, THOUGHT, PARENT, 1)];
      for (const listed of [[link(LINK, THOUGHT, PARENT, 3)], stale]) {
        const { call, calls } = await connect(brain(listed, { lookup: listed[0]! }));
        const result = await call("brain_link", { ...ends, relation: "parent", replace: true });
        expect(result.text).toBe(
          `## Link changed\nidentifier ${LINK}: from jump to parent-child with toId above`,
        );
        expect(requests(calls)).toEqual([
          `GET /api/thoughts/${BRAIN}/${PARENT}`,
          `GET /api/links/${BRAIN}/${THOUGHT}/${PARENT}`,
          `GET /api/links/${BRAIN}/${PARENT}/${THOUGHT}`,
          // `create()` reads the upper end too, as it does for any new link.
          `GET /api/thoughts/${BRAIN}/${PARENT}`,
          `POST /api/links/${BRAIN}`,
        ]);
      }
      // A lookup that has no link from the other end is a pair with more.
      const three = [
        link(LINK, THOUGHT, PARENT, 3),
        link(LINK_2, PARENT, THOUGHT, 3),
        link(LINK_3, PARENT, THOUGHT, 3),
      ];
      const { call, calls } = await connect(brain(three));
      const result = await call("brain_link", { ...ends, relation: "parent", replace: true });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^fromId and toId are joined by 3 links/);
      expect(requests(calls)).toEqual([
        `GET /api/thoughts/${BRAIN}/${PARENT}`,
        `GET /api/links/${BRAIN}/${THOUGHT}/${PARENT}`,
        `GET /api/links/${BRAIN}/${PARENT}/${THOUGHT}`,
        `GET /api/thoughts/${BRAIN}/${THOUGHT}/graph`,
      ]);
    });

    it("keeps the label, or replaces it and quotes the one it had", async () => {
      const labelled = link(LINK, THOUGHT, PARENT, 3, { name: "contradicts" });
      for (const [existing, name, said, sentName] of [
        [labelled, undefined, ', and keeps its label "contradicts"', undefined],
        [labelled, "refines", ', label updated: it was "contradicts" and is now "refines"', "refines"],
        // The label it has is not sent again.
        [labelled, "contradicts", ', label already "contradicts"', undefined],
        [link(LINK, THOUGHT, PARENT, 3), "refines", ", label updated", "refines"],
      ] as const) {
        const { call, sent } = await connect(brain([existing]));
        const named = name === undefined ? {} : { name };
        const result = await call("brain_link", { ...ends, relation: "child", ...named, replace: true });
        expect(result.text, said).toBe(
          `## Link changed\nidentifier ${LINK}: from jump to parent-child with fromId above${said}`,
        );
        expect(sent("POST"), said).toEqual([
          {
            thoughtIdA: THOUGHT,
            thoughtIdB: PARENT,
            relation: 1,
            ...(sentName === undefined ? {} : { name: sentName }),
          },
        ]);
        expect(sent("PATCH")).toEqual([]);
      }
    });

    it("over the link asked for, answers as brain_link does without it, and reads no graph", async () => {
      for (const name of [undefined, "contradicts"]) {
        const named = name === undefined ? {} : { name };
        const routes = brain([link(LINK, PARENT, THOUGHT, 1)]);
        const without = await connect(routes);
        const plain = await without.call("brain_link", { ...ends, relation: "parent", ...named });
        const withIt = await connect(routes);
        const replaced = await withIt.call("brain_link", {
          ...ends,
          relation: "parent",
          ...named,
          replace: true,
        });
        expect(replaced).toEqual(plain);
        expect(requests(withIt.calls)).toEqual(requests(without.calls));
        expect(requests(withIt.calls).some((r) => r.endsWith("/graph"))).toBe(false);
      }
    });

    it("never replaces a tag's attachment or a type's link, and writes nothing", async () => {
      const NOTHING = "replace changes an ordinary link, never a tag's attachment or a type's link. Nothing was written.";
      for (const [args, existing, text] of [
        [
          { fromId: THOUGHT, toId: TAG },
          link(LINK, TAG, THOUGHT, 1, { meaning: 5 }),
          `toId is a tag on fromId: ${NOTHING} To link the two another way, take the tag off ` +
            "with brain_tag first.",
        ],
        [
          { fromId: THOUGHT, toId: TYPE, relation: "child" },
          link(LINK, TYPE, THOUGHT, 1, { meaning: 2 }),
          `toId is the type of fromId: ${NOTHING} To link the two another way, take the type ` +
            "away first, with typeId null in brain_update_thought.",
        ],
        [
          { fromId: THOUGHT, toId: PARENT, name: "about" },
          link(LINK, PARENT, THOUGHT, 1, { meaning: 6 }),
          `a link of another kind (meaning 6): ${NOTHING}`,
        ],
      ] as const) {
        const { call, calls } = await connect(brain([existing]));
        const result = await call("brain_link", { brainId: BRAIN, ...args, replace: true });
        expect(result).toEqual({ isError: true, text });
        expect(writes(calls)).toEqual([]);
      }
      // Without replace it is what it was: nothing added, and no error.
      const { call } = await connect(brain([link(LINK, TAG, THOUGHT, 1, { meaning: 5 })]));
      expect(await call("brain_link", { brainId: BRAIN, fromId: THOUGHT, toId: TAG })).toEqual({
        isError: false,
        text:
          "## No link added\ntoId is a tag on fromId, and two thoughts share one link: the " +
          "requested jump was not added in its place",
      });
    });

    it("lists two links that join the pair, the same way or each way, and writes nothing", async () => {
      const several = (lines: string[]): string =>
        "fromId and toId are joined by 2 links, and TheBrain posts nothing between two " +
        "thoughts joined by more than one, so none of them can be changed. Nothing was " +
        `written.\n${lines.join("\n")}\nRemove all but one with brain_unlink, naming each by ` +
        "its linkId; brain_link then finds the one left, and replace changes it.";
      for (const [links, lines] of [
        // The same way: the lookup has neither, and a post would be the 400.
        [
          [link(LINK, THOUGHT, PARENT, 3, { name: "x" }), link(LINK_2, THOUGHT, PARENT, 1)],
          [`- ${LINK}: jump, labelled "x"`, `- ${LINK_2}: parent-child with fromId above`],
        ],
        // Each way: the lookup has one, and the graph the other.
        [
          [link(LINK, THOUGHT, PARENT, 3), link(LINK_2, PARENT, THOUGHT, 1)],
          [`- ${LINK}: jump`, `- ${LINK_2}: parent-child with toId above`],
        ],
      ] as const) {
        const { call, calls } = await connect(brain([...links]));
        const result = await call("brain_link", { ...ends, relation: "child", replace: true });
        expect(result).toEqual({ isError: true, text: several([...lines]) });
        expect(writes(calls)).toEqual([]);
      }
    });

    it("with no link between the two, links them as brain_link does without it", async () => {
      // A graph that still lists one link the lookup has not is behind a
      // deletion: there is no link to replace.
      for (const listed of [[], [link(LINK_2, THOUGHT, PARENT, 3)]]) {
        const { call, sent } = await connect(brain(listed, { lookup: null }));
        const result = await call("brain_link", { ...ends, name: "about", replace: true });
        expect(result).toEqual({ isError: false, text: `## Done\nlink created — ${LINK}` });
        expect(sent("POST")).toEqual([
          { thoughtIdA: THOUGHT, thoughtIdB: PARENT, relation: 3, name: "about" },
        ]);
      }
    });

    it("says so when TheBrain answers with another link than the one it read", async () => {
      const { call } = await connect(brain([link(LINK, THOUGHT, PARENT, 3)], { posted: LINK_2 }));
      const result = await call("brain_link", { ...ends, relation: "parent", replace: true });
      expect(result).toEqual({
        isError: false,
        text:
          `## Link changed\nidentifier ${LINK_2}: from jump to parent-child with toId above. ` +
          `TheBrain answered with ${LINK_2}, not ${LINK}: the link read a moment ago was gone, ` +
          "and this one was made in its place",
      });
    });

    it("says that a link is made the one asked for with replace", async () => {
      const { client } = await connect([]);
      const { tools } = await client.listTools();
      const props = tools.find((t) => t.name === "brain_link")!.inputSchema.properties as Record<
        string,
        { type?: string; description?: string }
      >;
      expect(props["replace"]?.type).toBe("boolean");
      expect(props["replace"]?.description).toMatch(/identifier.*label.*Never a tag or a type/s);
    });
  });

  describe("brain_link and two links that join one pair", () => {
    it("explains the 400 a post between them gets, and points at brain_unlink", async () => {
      // The bare "Link could not be created. (POST …)" used to be all of it,
      // and no tool could do anything about the pair.
      const refused = said(400, "Link could not be created.");
      const links = [link(LINK, THOUGHT, PARENT, 3), link(LINK_2, THOUGHT, PARENT, 1)];
      const { call } = await connect(brain(links, { first: [["POST /api/links/", refused]] }));
      expect(await call("brain_link", { ...ends, relation: "child" })).toEqual({
        isError: true,
        text:
          `Link could not be created. TheBrain named no cause (POST /api/links/${BRAIN}). It ` +
          "answers so when the two thoughts are joined by more than one link already, as two " +
          "links posted at once can leave them: nothing more can be posted between them, of " +
          "any kind or either way. Nothing was written. brain_unlink, given the same two " +
          "thoughts, lists the links that join them and removes the one its linkId names; or " +
          "one is removed in TheBrain itself.",
      });
    });
  });

  describe("a pair written to at once", () => {
    const NO_ANSWER_HERE =
      "request exceeded 30000 ms. Check that the TheBrain desktop app is running and its " +
      "local API is enabled.";
    /** A post as the API keeps it: into `links`, under `id`, and answered with `answer`. */
    const posting = (links: Link[], id = LINK, answer = id): Route => [
      "POST /api/links/",
      (_url, body) => {
        const b = body as { thoughtIdA: string; thoughtIdB: string; relation: number };
        // A parent's link is stored as a child's from the other end, and
        // one with a tag above is the tag's attachment.
        links.push(
          b.relation !== 2
            ? link(id, b.thoughtIdA, b.thoughtIdB, b.relation)
            : link(id, b.thoughtIdB, b.thoughtIdA, 1, { meaning: b.thoughtIdB === TAG ? 5 : 1 }),
        );
        return { id: answer };
      },
    ];

    it("two calls for one pair sent at once post once, and the second says what the first made", async () => {
      // Each used to look before either posted: on TheBrain 15.0.640 the
      // pair had two links 12 times in 21, and 7 of the other 9 answered one
      // call with zeros (L47).
      const notAdded =
        `## Link already existed\nidentifier ${LINK}: the link already existed as jump, the ` +
        "requested parent-child with fromId above was not added";
      for (const [second, already] of [
        [ends, `## Link already existed\nidentifier ${LINK}`],
        [{ ...ends, relation: "child" }, notAdded],
        [
          { brainId: BRAIN, fromId: PARENT, toId: THOUGHT },
          `## Link already existed\nidentifier ${LINK}`,
        ],
      ] as const) {
        const links: Link[] = [];
        const { call, sent } = await connect(brain(links, { first: [posting(links)] }));
        const results = await Promise.all([call("brain_link", ends), call("brain_link", second)]);
        expect(results).toEqual([
          { isError: false, text: `## Done\nlink created — ${LINK}` },
          { isError: false, text: already },
        ]);
        expect(sent("POST")).toHaveLength(1);
      }
    });

    it("two brain_tag calls at once attach the tag once, and the second says it was there", async () => {
      // Each used to look before either attached: one attachment, and both
      // calls said "attached" (L47).
      const links: Link[] = [];
      const { call, sent } = await connect(brain(links, { first: [posting(links)] }));
      const args = { brainId: BRAIN, thoughtId: THOUGHT, add: [TAG] };
      const [first, second] = await Promise.all([call("brain_tag", args), call("brain_tag", args)]);
      expect(first.text).toContain(`## Done\n- attached ${TAG}`);
      expect(second.text).toContain(`## Done\n- tag ${TAG} was on the thought already`);
      expect(sent("POST")).toHaveLength(1);
    });

    it("a create that may have landed says so, and that the call sent again looks first", async () => {
      // It used to be the error alone, with no word that the two might be
      // linked: what every other tool that writes once says (L26).
      const next =
        "so TheBrain may have linked the two all the same. Sent again as it is, this call " +
        "looks the two up first: it adds nothing where a link joins them, and says what that " +
        "link is.";
      for (const [answer, opening, why] of [
        [noAnswer, NO_ANSWER_HERE, "No answer came to the create"],
        [
          brokenOff,
          "TheBrain answered 200, and the connection failed",
          "The answer to the create broke off after its status",
        ],
      ] as const) {
        const { call, sent } = await connect(brain([], { first: [["POST /api/links/", answer]] }));
        const result = await call("brain_link", ends);
        expect(result.isError).toBe(true);
        expect(result.text.startsWith(opening)).toBe(true);
        expect(result.text).toContain(`\n\n## Next\n${why}, ${next}`);
        expect(sent("POST")).toHaveLength(1);
      }
    });

    it("a change with replace that got no answer may have changed the link", async () => {
      const { call } = await connect(
        brain([link(LINK, THOUGHT, PARENT, 3)], { first: [["POST /api/links/", noAnswer]] }),
      );
      const result = await call("brain_link", { ...ends, relation: "child", replace: true });
      expect(result).toEqual({
        isError: true,
        text:
          `${NO_ANSWER_HERE}\n\n## Next\nNo answer came to the change, so TheBrain may have ` +
          "changed the link all the same. Sent again as it is, this call reads the link first, " +
          "and changes it only if it is not yet the link asked for.",
      });
    });

    it("an answer of zeros next to a link made at that moment names that link", async () => {
      // Another session's post for the pair went first: TheBrain answers the
      // second with zeros, and makes nothing of it (L47).
      const zeros =
        `no link was made between ${THOUGHT} and ${PARENT}: TheBrain answered 200 with an ` +
        "identifier of zeros, which is its answer for a pair it does not link, and for a post " +
        "sent next to another between the same two thoughts. Nothing was written " +
        `(POST /api/links/${BRAIN})`;
      const links: Link[] = [];
      const { call } = await connect(brain(links, { first: [posting(links, LINK_2, ZEROS)] }));
      expect(await call("brain_link", { ...ends, name: "motivates" })).toEqual({
        isError: true,
        text:
          `${zeros}\n\n## Joined\nthe two are linked all the same, by ${LINK_2}: jump. Another ` +
          "write to them went at the same moment, from another session or from TheBrain " +
          "itself.\n\n## Next\nSent again as it is, this call finds that link and says whether " +
          "it is the one asked for.",
      });

      // With nothing between the two, the answer is all there is to say.
      const zeroed: Route = ["POST /api/links/", () => ({ id: ZEROS })];
      const none = await connect(brain([], { first: [zeroed] }));
      expect(await none.call("brain_link", ends)).toEqual({ isError: true, text: zeros });

      // A lookup that fails is said, and not taken for no link.
      let looks = 0;
      const unread = await connect(
        brain([], {
          first: [
            zeroed,
            ["GET /api/links/", () => ((looks += 1) > 1 ? 500 : 404)],
          ],
        }),
      );
      const result = await unread.call("brain_link", ends);
      expect(result.isError).toBe(true);
      expect(result.text).toContain(
        `${zeros}\n\n## Not read\nwhat joins the two now: TheBrain failed with a 500`,
      );
    });
  });

  describe("brain_unlink", () => {
    const allowed = () => ({ config: { allowDestructive: true } });
    const ASK =
      "This client cannot display a confirmation form. Ask the user yourself and, once they " +
      "agree, repeat the call with confirm=true. Never do this without explicit human consent.";
    const question = (lines: string[]): string =>
      `Remove the link between "RAG" and "Constraints"?\n\n${lines.join("\n")}\n\n` +
      "This cannot be undone.";
    const jump = link(LINK, THOUGHT, PARENT, 3, { name: "contradicts" });
    const REMOVED =
      `## Removed\nthe link between "RAG" and "Constraints": jump, labelled "contradicts" — ${LINK}`;

    it("with deletion not enabled, refuses before any request, as brain_delete_thought does", async () => {
      for (const config of [{}, { allowDestructive: false }]) {
        const { call, calls } = await connect(brain([jump]), () => ({ config }));
        for (const confirm of [undefined, true]) {
          const result = await call("brain_unlink", { ...ends, ...(confirm ? { confirm } : {}) });
          expect(result).toEqual({
            isError: true,
            text:
              "deletion is disabled. To allow it, start the server with " +
              "THEBRAIN_ALLOW_DESTRUCTIVE=1 — that is a deliberate choice by the user, not " +
              "something to work around.",
          });
          const deleted = await call("brain_delete_thought", { brainId: BRAIN, thoughtId: THOUGHT });
          expect(result.text).toBe(deleted.text);
        }
        expect(calls).toEqual([]);
      }
    });

    it("refuses identifiers it cannot use before any request", async () => {
      for (const [args, text] of [
        [
          { fromId: ZEROS, toId: PARENT },
          `fromId is the all-zero UUID (${ZEROS}), which names nothing.`,
        ],
        [{ fromId: THOUGHT, toId: "nope" }, 'toId must be a UUID, got "nope".'],
        [{ ...ends, linkId: "nope" }, 'linkId must be a UUID, got "nope".'],
        [
          { fromId: THOUGHT, toId: THOUGHT.toUpperCase() },
          `fromId and toId are both ${THOUGHT}, and no link joins a thought to itself. ` +
            "Nothing was removed.",
        ],
      ] as const) {
        const { call, calls } = await connect(brain([jump]), allowed);
        const result = await call("brain_unlink", { brainId: BRAIN, ...args, confirm: true });
        expect(result.isError, text).toBe(true);
        expect(result.text).toContain(text);
        expect(calls).toEqual([]);
      }
    });

    it("puts the question first, and removes the link once a person has agreed", async () => {
      const { call, calls } = await connect(brain([jump, ...PARENTED]), allowed);
      const asked = await call("brain_unlink", ends);
      expect(asked).toEqual({
        isError: true,
        text: `${question([`- jump, labelled "contradicts" — ${LINK}`])}\n\n${ASK}`,
      });
      expect(writes(calls)).toEqual([]);

      const result = await call("brain_unlink", { ...ends, confirm: true });
      expect(result).toEqual({ isError: false, text: REMOVED });
      expect(requests(calls).slice(4)).toEqual([
        `GET /api/thoughts/${BRAIN}/${THOUGHT}/graph`,
        `GET /api/thoughts/${BRAIN}/${PARENT}/graph`,
        `GET /api/links/${BRAIN}/${THOUGHT}/${PARENT}`,
        `GET /api/links/${BRAIN}/${PARENT}/${THOUGHT}`,
        `DELETE /api/links/${BRAIN}/${LINK}`,
      ]);
    });

    it("takes the one link both lookups give for the pair's only one, whatever a graph still lists", async () => {
      // Straight after one of two links is removed a graph lists both, and
      // the second removal was asked to choose between them.
      const gone = link(LINK_2, THOUGHT, PARENT, 1);
      const { call, calls } = await connect(brain([jump, gone, ...PARENTED], { lookup: jump }), allowed);
      expect(await call("brain_unlink", { ...ends, confirm: true })).toEqual({
        isError: false,
        text: REMOVED,
      });
      expect(writes(calls)).toEqual([`DELETE /api/links/${BRAIN}/${LINK}`]);

      // Nor is the one a graph still lists a link that keeps a thought linked.
      const alone = await connect(brain([jump, gone], { lookup: jump }), allowed);
      expect((await alone.call("brain_unlink", { ...ends, confirm: true })).text).toBe(
        `${REMOVED}\n\n## Warning\n` +
          ["RAG", "Constraints"]
            .map(
              (name) =>
                `- "${name}" has no parent, child or jump now: TheBrain shows it next to no ` +
                "thought, and a search finds it. brain_link links it again.",
            )
            .join("\n"),
      );
    });

    it("asks through the client's form where it has one, and a refusal or a failure there removes nothing", async () => {
      const shown: string[] = [];
      const through = async (answer: () => ElicitResult) => {
        const { call, calls } = await connect(brain([jump, ...PARENTED]), allowed, (message) => {
          shown.push(message);
          return answer();
        });
        return { result: await call("brain_unlink", ends), writes: writes(calls) };
      };
      const summary = question([`- jump, labelled "contradicts" — ${LINK}`]);

      const agreed = await through(() => ({ action: "accept", content: { confirm: true } }));
      expect(agreed.result).toEqual({ isError: false, text: REMOVED });
      expect(agreed.writes).toEqual([`DELETE /api/links/${BRAIN}/${LINK}`]);
      expect(shown).toEqual([summary]);

      for (const answer of [
        (): ElicitResult => ({ action: "decline" }),
        (): ElicitResult => ({ action: "cancel" }),
        (): ElicitResult => ({ action: "accept", content: { confirm: false } }),
      ]) {
        const refused = await through(answer);
        expect(refused.result).toEqual({
          isError: true,
          text: `Deletion cancelled by the user.\n\n${summary}`,
        });
        expect(refused.writes).toEqual([]);
      }

      // A form that failed is no consent: the call goes back for one.
      const failed = await through(() => {
        throw new Error("client dropped");
      });
      expect(failed.result).toEqual({ isError: true, text: `${summary}\n\n${ASK}` });
      expect(failed.writes).toEqual([]);
    });

    it("says which thought it leaves with no parent, child or jump, before and after", async () => {
      const { call } = await connect(brain([jump, link(LINK_3, ELSEWHERE, PARENT, 1)]), allowed);
      expect((await call("brain_unlink", ends)).text).toBe(
        `${question([
          `- jump, labelled "contradicts" — ${LINK}`,
          '- "RAG" would be left with no parent, child or jump',
        ])}\n\n${ASK}`,
      );
      expect((await call("brain_unlink", { ...ends, confirm: true })).text).toBe(
        `${REMOVED}\n\n## Warning\n- "RAG" has no parent, child or jump now: TheBrain shows ` +
          "it next to no thought, and a search finds it. brain_link links it again.",
      );

      // A type or a tag has none as a rule, and is no thought left alone.
      const typed = await connect(brain([link(LINK, THOUGHT, TYPE, 3), PARENTED[0]!]), allowed);
      expect(
        (await typed.call("brain_unlink", { brainId: BRAIN, fromId: THOUGHT, toId: TYPE })).text,
      ).toBe(
        'Remove the link between "RAG" and "Pattern" [type]?\n\n' +
          `- jump — ${LINK}\n\nThis cannot be undone.\n\n${ASK}`,
      );
    });

    it("lists the links of a pair joined by more than one, and removes only the one named", async () => {
      const links = [
        link(LINK, THOUGHT, PARENT, 3, { name: "contradicts" }),
        link(LINK_2, THOUGHT, PARENT, 1),
      ];
      const { call, calls } = await connect(brain([...links, ...PARENTED]), allowed);
      const listed = await call("brain_unlink", { ...ends, confirm: true });
      expect(listed).toEqual({
        isError: true,
        text:
          "fromId and toId are joined by 2 links. Nothing was removed: send the call again " +
          `with the linkId of the one to remove.\n- ${LINK}: jump, labelled "contradicts"\n` +
          `- ${LINK_2}: parent-child with fromId above`,
      });
      expect(writes(calls)).toEqual([]);

      expect((await call("brain_unlink", { ...ends, linkId: LINK })).text).toBe(
        `${question([
          `- jump, labelled "contradicts" — ${LINK}`,
          `- stays: parent-child with "RAG" above — ${LINK_2}`,
        ])}\n\n${ASK}`,
      );
      const result = await call("brain_unlink", { ...ends, linkId: LINK.toUpperCase(), confirm: true });
      expect(result).toEqual({
        isError: false,
        text:
          `${REMOVED}\n\n## Left\n- ${LINK_2}: parent-child with "RAG" above\nIt is the one ` +
          "link the two have now: brain_link finds it, and with replace changes it.",
      });
      expect(writes(calls)).toEqual([`DELETE /api/links/${BRAIN}/${LINK}`]);
    });

    it("says that more than one is left, of three", async () => {
      const links = [
        link(LINK, THOUGHT, PARENT, 3),
        link(LINK_2, THOUGHT, PARENT, 3),
        link(LINK_3, THOUGHT, PARENT, 3),
      ];
      const { call } = await connect(brain(links), allowed);
      const result = await call("brain_unlink", { ...ends, linkId: LINK_2, confirm: true });
      expect(result.text).toBe(
        `## Removed\nthe link between "RAG" and "Constraints": jump — ${LINK_2}\n\n## Left\n` +
          `- ${LINK}: jump\n- ${LINK_3}: jump\nStill more than one: TheBrain posts nothing ` +
          "between the two while it is so.",
      );
    });

    it("refuses a linkId that is not one of the pair's, and lists theirs", async () => {
      const { call, calls } = await connect(brain([jump]), allowed);
      const result = await call("brain_unlink", { ...ends, linkId: LINK_2, confirm: true });
      expect(result).toEqual({
        isError: true,
        text:
          `No link between fromId and toId has the identifier ${LINK_2}. Nothing was removed. ` +
          `The links that join them:\n- ${LINK}: jump, labelled "contradicts"`,
      });
      expect(writes(calls)).toEqual([]);
    });

    it("never removes a tag's attachment or a type's link, and says which tool does", async () => {
      const tagOn = link(LINK, TAG, THOUGHT, 1, { meaning: 5 });
      const typeOf = link(LINK, TYPE, THOUGHT, 1, { meaning: 2 });
      for (const [args, links, text] of [
        [
          { fromId: THOUGHT, toId: TAG },
          [tagOn],
          "toId is a tag on fromId: a tag's attachment, which brain_unlink does not remove. " +
            "Nothing was removed. Take the tag off with brain_tag.",
        ],
        [
          { fromId: TYPE, toId: THOUGHT },
          [typeOf],
          "fromId is the type of toId: a type's link, which brain_unlink does not remove. " +
            "Nothing was removed. Take the type away with typeId null in brain_update_thought.",
        ],
        [
          { fromId: THOUGHT, toId: PARENT },
          [link(LINK, THOUGHT, PARENT, 1, { meaning: 6 })],
          "a link of another kind (meaning 6), which brain_unlink does not remove. Nothing " +
            "was removed.",
        ],
        // A tag attached twice, which brain_tag takes off whole.
        [
          { fromId: THOUGHT, toId: TAG },
          [tagOn, { ...tagOn, id: LINK_2 }],
          "toId is a tag on fromId: a tag's attachment, which brain_unlink does not remove. " +
            "Nothing was removed. Take the tag off with brain_tag. The tag is attached 2 " +
            "times, and brain_tag remove takes every attachment off; add then attaches it once.",
        ],
        // Named by its identifier, beside an ordinary link.
        [
          { fromId: THOUGHT, toId: TAG, linkId: LINK },
          [tagOn, link(LINK_2, THOUGHT, TAG, 3)],
          "toId is a tag on fromId: a tag's attachment, which brain_unlink does not remove. " +
            "Nothing was removed. Take the tag off with brain_tag.",
        ],
      ] as const) {
        const { call, calls } = await connect(brain([...links]), allowed);
        const result = await call("brain_unlink", { brainId: BRAIN, ...args, confirm: true });
        expect(result, text).toEqual({ isError: true, text });
        expect(writes(calls)).toEqual([]);
      }
    });

    it("removes nothing where no link joins the two", async () => {
      const { call, calls } = await connect(brain([], { lookup: null }), allowed);
      expect(await call("brain_unlink", { ...ends, confirm: true })).toEqual({
        isError: false,
        text: "## Nothing removed\nno link joins fromId and toId",
      });
      expect(writes(calls)).toEqual([]);
    });

    it("does not tell no link from two when the lookup has none and a graph lists one", async () => {
      // A graph is behind a deletion, and behind the creation of a second
      // link as well: once, with the app busy, both lookups had none, a
      // graph listed one, and a post between the two was the bare 400.
      for (const linkId of [undefined, LINK]) {
        const { call, calls } = await connect(
          brain([link(LINK, THOUGHT, PARENT, 3)], { lookup: null }),
          allowed,
        );
        const named = linkId === undefined ? {} : { linkId };
        expect(await call("brain_unlink", { ...ends, ...named, confirm: true })).toEqual({
          isError: true,
          text:
            "TheBrain's lookup has no link between fromId and toId from either end, and " +
            `their graphs list one, ${LINK}: it was removed a moment ago, or the two are ` +
            "joined by more than one link, which the lookup cannot see and a graph does not " +
            "list all of yet. Nothing was removed. Send the call again in a moment.",
        });
        expect(writes(calls)).toEqual([]);
      }
    });

    it("takes the lookup's link that no graph lists yet", async () => {
      const { call, calls } = await connect(brain(PARENTED, { lookup: jump }), allowed);
      expect(await call("brain_unlink", { ...ends, confirm: true })).toEqual({
        isError: false,
        text: REMOVED,
      });
      expect(writes(calls)).toEqual([`DELETE /api/links/${BRAIN}/${LINK}`]);
    });

    it("a read that fails asks nothing and removes nothing", async () => {
      // A thought nobody has: its graph is the catch-all 403.
      const nobody = "99999999-0000-4000-8000-000000000009";
      const { call, calls } = await connect(brain([jump]), allowed);
      const result = await call("brain_unlink", { brainId: BRAIN, fromId: THOUGHT, toId: nobody, confirm: true });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^TheBrain answered 403 and named no cause \(GET .*\/graph\)/);
      expect(writes(calls)).toEqual([]);
    });

    it("a deletion that got no answer, or a link gone by then, is told as that", async () => {
      const lost = await connect(brain([jump, ...PARENTED], { first: [["DELETE /api/links/", noAnswer]] }), allowed);
      expect(await lost.call("brain_unlink", { ...ends, confirm: true })).toEqual({
        isError: true,
        text:
          "request exceeded 30000 ms. Check that the TheBrain desktop app is running and its " +
          "local API is enabled.\n\n## Next\nNo answer came to the deletion, so TheBrain may " +
          "have removed the link all the same. Sent again as it was, this call removes that " +
          "link if it is there still, and nothing else.",
      });

      // Measured: a DELETE of a link that is gone is a 400 with no words.
      const gone = said(400, { title: "Bad Request", status: 400 });
      const late = await connect(brain([jump, ...PARENTED], { first: [["DELETE /api/links/", gone]] }), allowed);
      expect(await late.call("brain_unlink", { ...ends, confirm: true })).toEqual({
        isError: true,
        text:
          `TheBrain answered 400 to the deletion of ${LINK}, its answer for a link that is ` +
          "gone: it was removed a moment ago, after it was read. This call removed nothing. " +
          "Sent again as it was, it says what joins the two now.",
      });
    });

    it("is described as a deletion a person agrees to, and names the tools for the rest", async () => {
      const { client } = await connect([]);
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "brain_unlink")!;
      expect(tool.description).toMatch(/no undo.*human confirmation.*brain_link with replace.*brain_tag.*brain_update_thought/s);
      expect(tool.inputSchema.required).toEqual(["brainId", "fromId", "toId"]);
      const remover = tools.find((t) => t.name === "brain_delete_thought")!;
      const confirm = (t: typeof tool) =>
        (t.inputSchema.properties as Record<string, { description?: string }>)["confirm"];
      expect(confirm(tool)).toEqual(confirm(remover));
    });
  });

  describe("brain_tag and a tag that is there, once or twice", () => {
    const NOTE =
      "## Note\nTag changes are not visible in the graph immediately — up to half a second. " +
      "Re-reading the thought right away may still show the old tags.";
    const tagOn = link(LINK, TAG, THOUGHT, 1, { meaning: 5 });
    const twice = [tagOn, { ...tagOn, id: LINK_2 }];
    const tagArgs = { brainId: BRAIN, thoughtId: THOUGHT };
    const tagRead = `GET /api/thoughts/${BRAIN}/${TAG}`;
    const lookup = `GET /api/links/${BRAIN}/${THOUGHT}/${TAG}`;
    const graphRead = `GET /api/thoughts/${BRAIN}/${THOUGHT}/graph`;
    /** `brain()` over `links`, which a deletion takes the link out of, as the API's does. */
    const deleting = (links: Link[], first: Route[] = []): Route[] =>
      brain(links, {
        first: [
          ...first,
          [
            "DELETE /api/links/",
            (url) => {
              const id = url.pathname.split("/").pop()!;
              const at = links.findIndex((l) => l.id === id);
              if (at < 0) return said(400, "Bad Request")();
              links.splice(at, 1);
              return 200;
            },
          ],
        ],
      });
    const refusedPost: Route = ["POST /api/links/", said(400, "Link could not be created.")];

    it("add of a tag that is on the thought sends nothing, and says so", async () => {
      // It posted again every time: a 200 that changes nothing and logs a
      // `402`, 3 times of 3 through the handler on a live TheBrain 15.0.640.
      const { call, calls } = await connect(brain([tagOn]));
      const result = await call("brain_tag", { ...tagArgs, add: [TAG] });
      expect(result).toEqual({
        isError: false,
        text: `## Done\n- tag ${TAG} was on the thought already\n\n${NOTE}`,
      });
      expect(requests(calls)).toEqual([tagRead, lookup]);
    });

    it("add of a tag attached twice says what is there, and that nothing changed", async () => {
      // The post is the bare 400, and was answered with brain_unlink, which
      // does not remove a tag's attachment (3 times of 3, live).
      const { call, calls } = await connect(brain(twice, { first: [refusedPost] }));
      const result = await call("brain_tag", { ...tagArgs, add: [TAG] });
      expect(result).toEqual({
        isError: false,
        text:
          `## Done\n- tag ${TAG} was on the thought already, attached 2 times, and TheBrain ` +
          "posts nothing between two thoughts joined more than once, so nothing changed: " +
          `${LINK}, ${LINK_2}. brain_tag remove takes every attachment off, and add then ` +
          `attaches it once.\n\n${NOTE}`,
      });
      expect(requests(calls)).toEqual([tagRead, lookup, tagRead, `POST /api/links/${BRAIN}`, graphRead]);

      // A graph that lists no second attachment yet leaves the refusal as it is.
      const behind = await connect(brain([tagOn], { lookup: null, first: [refusedPost] }));
      const alone = await behind.call("brain_tag", { ...tagArgs, add: [TAG] });
      expect(alone.isError).toBe(true);
      expect(alone.text).toMatch(/^Link could not be created\. TheBrain named no cause/);
    });

    it("add refuses a thought and a tag joined by another link, and sends nothing", async () => {
      // The attach was posted over it, and the jump became the tag's
      // attachment (L23; once more through the handler, live).
      for (const [joining, what] of [
        [link(LINK, THOUGHT, TAG, 3, { name: "see" }), 'jump, labelled "see"'],
        [link(LINK, THOUGHT, TAG, 1), "parent-child with the thought above"],
      ] as const) {
        const { call, calls } = await connect(brain([joining]));
        const result = await call("brain_tag", { ...tagArgs, add: [TAG] });
        expect(result, what).toEqual({
          isError: true,
          text:
            `the thought and the tag ${TAG} are joined by a link, ${LINK}: ${what}. Two ` +
            "thoughts share one link, and attaching the tag would turn that one into the " +
            "tag's attachment: what it is now would be gone. Nothing was sent for this tag. " +
            "To tag the thought, remove that link first with brain_unlink.",
        });
        expect(writes(calls)).toEqual([]);
      }
    });

    it("remove takes off every attachment of a tag attached twice, and nothing else", async () => {
      // It answered "was not on the thought" with the graph listing both, 3
      // times of 3 live: the lookup has neither (L43).
      for (const beside of [[], [link(LINK_3, THOUGHT, TAG, 3)]]) {
        const links = [...twice, ...beside];
        const { call, calls } = await connect(deleting(links));
        const result = await call("brain_tag", { ...tagArgs, remove: [TAG] });
        expect(result).toEqual({
          isError: false,
          text:
            `## Done\n- removed ${TAG}: it was attached 2 times, and each attachment is gone, ` +
            `${LINK}, ${LINK_2}\n\n${NOTE}`,
        });
        expect(requests(calls)).toEqual([
          tagRead,
          lookup,
          graphRead,
          `DELETE /api/links/${BRAIN}/${LINK}`,
          `DELETE /api/links/${BRAIN}/${LINK_2}`,
        ]);
        // A jump beside them stays: the lookup gave it, and it is no attachment.
        expect(links).toEqual(beside);
      }
    });

    it("remove of a tag attached once beside another link takes the attachment alone", async () => {
      // Of two links that go each way the lookup gives the one whose
      // `thoughtIdA` it names first: here the jump, not the tag's (L43).
      const jump = link(LINK_2, THOUGHT, TAG, 3);
      const links = [tagOn, jump];
      const { call } = await connect(deleting(links));
      const result = await call("brain_tag", { ...tagArgs, remove: [TAG] });
      expect(result.text).toBe(`## Done\n- removed ${TAG}\n\n${NOTE}`);
      expect(links).toEqual([jump]);
    });

    it("remove never says the tag was not on a thought whose graph lists it", async () => {
      // One listed and no lookup: removed a moment ago, or one of two the
      // graph does not list both of yet.
      const { call, calls } = await connect(deleting([tagOn], [["GET /api/links/", () => 404]]));
      const result = await call("brain_tag", { ...tagArgs, remove: [TAG] });
      expect(result).toEqual({
        isError: true,
        text:
          `TheBrain's lookup has no attachment of the tag ${TAG} to the thought, and the ` +
          `thought's graph lists one, ${LINK}: it was removed a moment ago, or the tag is ` +
          "attached more than once, which the lookup cannot see and the graph does not list " +
          "all of yet. Nothing was removed for this tag. Send it again in a moment.",
      });
      expect(writes(calls)).toEqual([]);
    });

    it("remove says which attachment was gone already, and which it removed before a failure", async () => {
      // A graph lists a deleted link for up to 0.2 s, and the deletion of a
      // link that is gone is a 400 (L43).
      const links = [...twice];
      const gone = await connect(
        deleting(links, [[`DELETE /api/links/${BRAIN}/${LINK_2}`, said(400, "Bad Request")]]),
      );
      const result = await gone.call("brain_tag", { ...tagArgs, remove: [TAG] });
      expect(result.text).toBe(
        `## Done\n- removed ${TAG}: it was attached 2 times, and each attachment is gone, ` +
          `${LINK} (${LINK_2} was gone already)\n\n${NOTE}`,
      );

      const all = await connect(
        deleting([...twice], [["DELETE /api/links/", said(400, "Bad Request")]]),
      );
      expect((await all.call("brain_tag", { ...tagArgs, remove: [TAG] })).text).toBe(
        `## Done\n- tag ${TAG} was not on the thought: ${LINK}, ${LINK_2}, which its graph ` +
          `listed, was gone\n\n${NOTE}`,
      );

      const failing = await connect(
        deleting([...twice], [[`DELETE /api/links/${BRAIN}/${LINK_2}`, said(500, "boom")]]),
      );
      const half = await failing.call("brain_tag", { ...tagArgs, remove: [TAG] });
      expect(half.isError).toBe(true);
      expect(half.text).toMatch(
        new RegExp(
          `^1 of the 2 attachments of the tag ${TAG} were removed, ${LINK}, and then ${LINK_2} ` +
            "was not: TheBrain failed with a 500",
        ),
      );
      expect(half.text).not.toContain("Nothing was written");
    });
  });
});

describe("the identifier of zeros in a call", () => {
  const ZEROS = "00000000-0000-0000-0000-000000000000";
  const TAG = "ffffffff-0000-4000-8000-000000000006";
  const told = (field: string): string =>
    `${field} is the all-zero UUID (${ZEROS}), which names nothing. Leave an optional ` +
    "identifier out rather than send zeros. Take identifiers from brain_list, brain_search " +
    "or brain_get_thought — do not invent them.";
  /** A brain that answers 200 to whatever it is sent, as the live one does to these. */
  const willing: Route[] = [
    ["GET /api/notes/", () => noNote],
    ["GET /graph", () => graph(thought("RAG"))],
    ["GET /api/thoughts/", (url) => thought("t", { kind: url.pathname.endsWith(TAG) ? 4 : 1 })],
    ["GET /api/links/", () => 404],
    ["GET /api/attachments/", () => []],
    ["GET /api/", () => []],
    ["POST /api/", () => ({ id: THOUGHT })],
    ["PATCH /api/", () => 200],
  ];

  it("brain_create_thought makes no thought under it, whatever the relation", async () => {
    // Measured: the API answers 200 to a create with it for a source and
    // makes the thought with no link, and the tool answered "created thought"
    // for a thought linked to nothing, 3 times of 3 under each relation.
    for (const relation of [undefined, "child", "parent", "jump"]) {
      const { call, calls } = await connect(willing);
      const result = await call("brain_create_thought", {
        brainId: BRAIN,
        name: "RAG",
        parentId: ZEROS,
        ...(relation !== undefined ? { relation } : {}),
      });
      expect(result.isError, relation).toBe(true);
      // By the tool's own name for it, whatever the relation.
      expect(result.text, relation).toBe(told("parentId"));
      expect(calls, relation).toEqual([]);
    }
  });

  it("the note tools write no note to it", async () => {
    // Measured: both answered that the note was written, 3 times of 3, for a
    // note stored on no thought that no read returns.
    for (const tool of ["brain_set_note", "brain_append_note"]) {
      const { call, calls } = await connect(willing);
      const result = await call(tool, { brainId: BRAIN, thoughtId: ZEROS, markdown: "text" });
      expect(result.isError, tool).toBe(true);
      expect(result.text, tool).toBe(told("thoughtId"));
      expect(calls, tool).toEqual([]);
    }
  });

  it("no tool sends a request that carries it", async () => {
    const asked: Array<[string, Record<string, unknown>, string]> = [
      ["brain_get_thought", { thoughtId: ZEROS }, "thoughtId"],
      ["brain_traverse", { thoughtId: ZEROS }, "thoughtId"],
      ["brain_update_thought", { thoughtId: ZEROS, name: "x" }, "thoughtId"],
      ["brain_update_thought", { thoughtId: THOUGHT, typeId: ZEROS }, "typeId"],
      ["brain_create_thought", { name: "RAG", parentId: PARENT, typeId: ZEROS }, "typeId"],
      ["brain_create_thought", { name: "RAG", parentId: PARENT, tagIds: [ZEROS] }, "tagId"],
      ["brain_link", { fromId: ZEROS, toId: THOUGHT }, "fromId"],
      ["brain_link", { fromId: THOUGHT, toId: ZEROS, name: "x" }, "toId"],
      ["brain_link", { fromId: ZEROS, toId: THOUGHT, relation: "child" }, "fromId"],
      ["brain_link", { fromId: THOUGHT, toId: ZEROS, relation: "parent" }, "toId"],
      ["brain_tag", { thoughtId: ZEROS, add: [TAG] }, "thoughtId"],
      ["brain_tag", { thoughtId: ZEROS, remove: [TAG] }, "thoughtId"],
      ["brain_tag", { thoughtId: THOUGHT, add: [ZEROS] }, "tagId"],
      ["brain_attach_url", { thoughtId: ZEROS, url: "https://example.com/" }, "thoughtId"],
      ["brain_activate", { thoughtId: ZEROS }, "thoughtId"],
      ["brain_get_thought", { brainId: ZEROS, thoughtId: THOUGHT }, "brainId"],
      ["brain_recent_changes", { brainId: ZEROS }, "brainId"],
    ];
    for (const [tool, args, field] of asked) {
      const { call, calls } = await connect(willing);
      const result = await call(tool, { brainId: BRAIN, ...args });
      const what = `${tool} ${JSON.stringify(args)}`;
      expect(result.isError, what).toBe(true);
      expect(result.text, what).toBe(told(field));
      // Not a read of the call's other identifier either.
      expect(calls, what).toEqual([]);
    }
  });

  it("an identifier beside it that is read first is all a call sends: no request carries it, and none writes", async () => {
    // A list is read in its order, so a tag ahead of the zeros is looked at.
    for (const [tool, args] of [
      ["brain_tag", { thoughtId: THOUGHT, add: [TAG, ZEROS] }],
      ["brain_create_thought", { name: "RAG", parentId: PARENT, tagIds: [TAG, ZEROS] }],
    ] as const) {
      const { call, calls } = await connect(willing);
      const result = await call(tool, { brainId: BRAIN, ...args });
      expect(result.isError, tool).toBe(true);
      expect(result.text, tool).toBe(told("tagId"));
      expect(calls.map((c) => `${c.method} ${c.path}`), tool).toEqual([
        `GET /api/thoughts/${BRAIN}/${TAG}`,
      ]);
    }
  });

  it("brain_ingest rejects a plan that names it, with the plan item and before any request", async () => {
    const rejected = (what: string): string =>
      `Plan rejected, nothing was written: ${what}. Take identifiers from brain_search or ` +
      "brain_get_thought. Fix it and retry.";
    for (const [plan, text] of [
      [
        { thoughts: [{ tempId: "top", name: "Top", parent: ZEROS }] },
        rejected(
          `thought "top" references parent ${ZEROS}, the all-zero UUID, which names no thought`,
        ),
      ],
      [
        { thoughts: [{ tempId: "top", name: "Top", parent: ZEROS, relation: "jump" }] },
        rejected(
          `thought "top" references parent ${ZEROS}, the all-zero UUID, which names no thought`,
        ),
      ],
      [
        // It used to fail at its own turn, with the thought written.
        {
          thoughts: [{ tempId: "top", name: "Top", parent: PARENT }],
          links: [{ from: "top", to: ZEROS, name: "x" }],
        },
        rejected(
          `the link top -> ${ZEROS} references ${ZEROS}, the all-zero UUID, in its to field, ` +
            "and it names no thought",
        ),
      ],
    ] as const) {
      const { call, calls } = await connect(willing);
      const result = await call("brain_ingest", { brainId: BRAIN, ...plan });
      expect(result.isError, text).toBe(true);
      expect(result.text).toBe(text);
      expect(calls, text).toEqual([]);
    }
    // A type and a tag are read ahead of the first write, and refused there.
    for (const [extra, field] of [
      [{ typeId: ZEROS }, "typeId"],
      [{ tagIds: [ZEROS] }, "tagId"],
    ] as const) {
      const { call, calls } = await connect(willing);
      const result = await call("brain_ingest", {
        brainId: BRAIN,
        thoughts: [{ tempId: "top", name: "Top", parent: PARENT, ...extra }],
      });
      expect(result.isError, field).toBe(true);
      expect(result.text, field).toBe(told(field));
      expect(calls.filter((c) => c.method !== "GET"), field).toEqual([]);
    }
  });

  it("brain_recent_changes reads no thought for it, and still calls it deleted", async () => {
    // The log has it for a note written to no thought. Its read was a 404.
    const { call, calls } = await connect([
      [
        "GET /modifications",
        () => [
          {
            sourceId: LINK,
            sourceType: 4,
            extraAId: ZEROS,
            extraAType: 2,
            extraBId: ZEROS,
            extraBType: -1,
            modType: 801,
            oldValue: null,
            newValue: null,
            userId: ZEROS,
            brainId: BRAIN,
            creationDateTime: "2026-10-11T08:00:01",
            modificationDateTime: "2026-10-11T08:00:01",
            syncUpdateDateTime: null,
          },
        ],
      ],
      ["GET /api/thoughts/", () => 404],
    ]);
    const result = await call("brain_recent_changes", {
      brainId: BRAIN,
      since: "2026-10-11T00:00:00Z",
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("(deleted)");
    expect(result.text).not.toContain("(name not read)");
    expect(calls.filter((c) => c.path.includes("/api/thoughts/"))).toEqual([]);
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
        note: OPEN_FENCE,
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
          `- ${NOT_KEPT()}`,
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

    it("a create whose answer broke off is one that may have landed", async () => {
      // A 200 whose body broke off was no TheBrainError at all.
      const { call, calls } = await connect(routes([["POST /api/thoughts/", brokenOff]]));
      const result = await call("brain_create_thought", {
        brainId: BRAIN,
        name: "RAG",
        parentId: PARENT,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        "TheBrain answered 200, and the connection failed before the rest of the answer " +
          "came (other side closed). Check that the TheBrain desktop app is running and its " +
          "local API is enabled.\n\n## Next\nThe answer to the create broke off after its " +
          'status, so TheBrain may have made "RAG" all the same, and there is no identifier ' +
          `to give for it. Before creating it again, look for it next to ${PARENT} with ` +
          "brain_get_thought.",
      );
      // Sent once: a second create would make a second thought.
      expect(writes(calls)).toEqual([`POST /api/thoughts/${BRAIN}`]);
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
          "## Next",
          "The identifier above works immediately. Searching for this thought by name only " +
            "succeeds after a few seconds, so refer to it by identifier.",
        ].join("\n"),
      );
    });

    it("a note with a code block that is closed has no warning, and one TheBrain did not keep whole says which line", async () => {
      // Every note with a fenced block used to be warned about, as one whose
      // closing fence TheBrain drops. It keeps a closed block to the
      // character, and deletes a fence that has no partner.
      const DONE = `## Done\n- created thought "RAG" — ${THOUGHT}\n- note written\n\n`;
      const NEXT =
        "## Next\nThe identifier above works immediately. Searching for this thought by " +
        "name only succeeds after a few seconds, so refer to it by identifier.";
      const create = async (note: string) => {
        const { call } = await connect(routes());
        return call("brain_create_thought", { brainId: BRAIN, name: "RAG", note });
      };

      for (const kept of ["before\n\n```js\ncode();\n```\n\nafter", "~~~\ncode\n~~~", "plain"]) {
        expect(await create(kept), kept).toEqual({ isError: false, text: `${DONE}${NEXT}` });
      }
      expect(await create(OPEN_FENCE)).toEqual({
        isError: false,
        text: `${DONE}## Warning\n- ${NOT_KEPT()}\n\n${NEXT}`,
      });
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

    it("aliases written whose read-back fails are told as accepted, not as the read's error", async () => {
      // The read that waits for the new list failed, and its error used to
      // be the step's: "Failed" for aliases that were in the brain. They were
      // then listed under Done, which reads as a list to build on.
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
        await vi.advanceTimersByTimeAsync(PAST_READ_BACK);
        const result = await pending;

        expect(result.isError).toBe(true);
        expect(result.text).toContain('## Done\n- label = "caption"\n');
        expect(result.text).toContain(
          '## Failed\n- aliases: TheBrain accepted the aliases (added ["R.A.G."]; the list is ' +
            'now ["R.A.G."]), and the thought did not read back with them within 6 s',
        );
        expect(result.text).not.toContain("boom");
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

    /** The line of a type the API accepted and a read did not show. */
    const TYPE_UNREAD =
      "TheBrain accepted the type, and the thought did not read back with it within 6 s: " +
      "reads lag behind writes for seconds after a burst of them, and longer while writes " +
      "keep coming. Do not send it again: brain_get_thought shows it once TheBrain catches up";
    /** "Next" of a call that went past what did not read back to its end. */
    const RAN =
      "The call ran to its end, and nothing is rolled back. What is under Done was done. " +
      `${NOT}. Nothing else is left: of what is under Failed, send again only what its line ` +
      `says to, when it says, in a brain_update_thought call for ${THOUGHT}.`;
    /** A brain where the type is taken and never reads back, and aliases do. */
    const typeLags = (patch: Route[] = []): Route[] => {
      let aliases: string[] = [];
      return [
        ...patch,
        ["GET /graph", () => graph(thought("RAG", { aliases }))],
        [
          "GET /api/thoughts/",
          (url) =>
            url.pathname.endsWith(TYPE)
              ? thought("Pattern", { id: TYPE, kind: 2 })
              : thought("RAG", { aliases }),
        ],
        [
          "PATCH /api/thoughts/",
          (_url, body) => {
            for (const op of body as Array<{ path: string; value?: unknown }>) {
              if (op.path === "/aliases") aliases = op.value as string[];
            }
            return 200;
          },
        ],
      ];
    };

    it("a type that is accepted and does not read back does not stop the call: the fields after it are written", async () => {
      // The call used to stop at the type, list the rest under Skipped, and
      // say to "fix the cause" of a lag. No other field depends on the type.
      vi.useFakeTimers();
      try {
        const { call, sent } = await connect(typeLags());
        const pending = call("brain_update_thought", {
          brainId: BRAIN,
          thoughtId: THOUGHT,
          name: "renamed",
          typeId: TYPE,
        });
        await vi.advanceTimersByTimeAsync(PAST_READ_BACK);
        const result = await pending;

        expect(result.isError).toBe(true);
        expect(result.text).toBe(
          [
            "## Done",
            '- name = "renamed"',
            "",
            "## Failed",
            `- typeId = "${TYPE}": ${TYPE_UNREAD}`,
            "",
            "## Next",
            RAN,
          ].join("\n"),
        );
        expect(sent("PATCH")).toEqual([
          [{ op: "replace", path: "/typeId", value: TYPE }],
          [{ op: "replace", path: "/name", value: "renamed" }],
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("an alias edit after a type that did not read back is not held back by it", async () => {
      // What holds back an edit built on a read from before an unread write
      // is kept by field: the type's holds back a removal of the type, and
      // not the aliases, which are written with no wait for the type.
      vi.useFakeTimers();
      try {
        const { call, sent } = await connect(typeLags());
        const pending = call("brain_update_thought", {
          brainId: BRAIN,
          thoughtId: THOUGHT,
          typeId: TYPE,
          addAliases: ["R.A.G."],
        });
        await vi.advanceTimersByTimeAsync(PAST_READ_BACK);
        const result = await pending;

        expect(result.isError).toBe(true);
        expect(result.text).toBe(
          [
            "## Done",
            '- aliases added: ["R.A.G."]',
            '- aliases now: ["R.A.G."]',
            "",
            "## Failed",
            `- typeId = "${TYPE}": ${TYPE_UNREAD}`,
            "",
            "## Next",
            RAN,
          ].join("\n"),
        );
        expect(sent("PATCH")).toEqual([
          [{ op: "replace", path: "/typeId", value: TYPE }],
          [{ op: "replace", path: "/aliases", value: ["R.A.G."] }],
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("past a type that did not read back the call still stops at a field refused, and lists both", async () => {
      vi.useFakeTimers();
      try {
        const { call, sent } = await connect(typeLags([colours]));
        const pending = call("brain_update_thought", {
          brainId: BRAIN,
          thoughtId: THOUGHT,
          typeId: TYPE,
          foregroundColor: "red",
          addAliases: ["R.A.G."],
        });
        await vi.advanceTimersByTimeAsync(PAST_READ_BACK);
        const result = await pending;

        expect(result.isError).toBe(true);
        expect(result.text).toBe(
          [
            "## Failed",
            `- typeId = "${TYPE}": ${TYPE_UNREAD}`,
            "- foregroundColor = \"red\": Color format is malformed - should be like '#123456'. " +
              `(PATCH /api/thoughts/${BRAIN}/${THOUGHT})`,
            "",
            "## Skipped",
            "- aliases",
            "",
            "## Next",
            "The call went on past what did not read back and stopped at the next failure, " +
              `and nothing is rolled back. ${NOT}${STOPPED}${REST}`,
          ].join("\n"),
        );
        expect(sent("PATCH")).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a removal held back behind this server's unread type is told to be sent again, and the rest is written", async () => {
      // A removal built on a read from before the type would find none to
      // remove, so it waits for the type and is not sent. The name does not
      // depend on it, and is written.
      vi.useFakeTimers();
      try {
        const { call, sent } = await connect(typeLags());
        const first = call("brain_update_thought", { brainId: BRAIN, thoughtId: THOUGHT, typeId: TYPE });
        await vi.advanceTimersByTimeAsync(PAST_READ_BACK);
        expect((await first).text).toBe(TYPE_UNREAD);

        const second = call("brain_update_thought", {
          brainId: BRAIN,
          thoughtId: THOUGHT,
          typeId: null,
          name: "renamed",
        });
        await vi.advanceTimersByTimeAsync(PAST_READ_BACK);
        const result = await second;

        expect(result.isError).toBe(true);
        expect(result.text).toMatch(
          new RegExp(
            '^## Done\\n- name = "renamed"\\n\\n## Failed\\n- typeId = null: this server\'s write ' +
              "to the thought's type \\d+ s ago does not read back yet: .*, so this one was not " +
              `sent\\. Send it again once brain_get_thought shows the type ${TYPE}\\n\\n## Next\\n`,
          ),
        );
        expect(result.text.endsWith(RAN)).toBe(true);
        expect(sent("PATCH")).toEqual([
          [{ op: "replace", path: "/typeId", value: TYPE }],
          [{ op: "replace", path: "/name", value: "renamed" }],
        ]);
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
          ["GET /graph", () => graph(thought("RAG"))],
          ["GET /api/thoughts/", () => (patched ? boom() : thought("RAG"))],
          ["PATCH /api/thoughts/", () => ((patched = true), 200)],
        ]);
        const pending = call("brain_update_thought", {
          brainId: BRAIN,
          thoughtId: THOUGHT,
          typeId: TYPE,
        });
        await vi.advanceTimersByTimeAsync(PAST_READ_BACK);
        const result = await pending;

        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/^TheBrain accepted the type, and the thought did not read back/);
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
      const nobody: Route[] = [[`GET /api/thoughts/${BRAIN}/${NOBODY}/graph`, generic403]];
      const { call, calls } = await connect(routes(nobody));
      const result = await call("brain_tag", { brainId: BRAIN, thoughtId: NOBODY, remove: [TAG] });

      expect(result.isError).toBe(true);
      expect(result.text).toBe(gone);
      expect(writes(calls)).toEqual([]);

      // With more to remove, the rest is listed as not tried.
      const more = await connect(routes(nobody));
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

    it("a tag that was not on a thought that is there reads as it did, at a read of the graph a tag", async () => {
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
      // The two tags, and for each the lookup and the graph: a 404 to the
      // lookup is a tag attached twice as well (L43). The graph's read is the
      // thought's, which a thought nobody has fails.
      const graphOf = `GET /api/thoughts/${BRAIN}/${THOUGHT}/graph`;
      expect(requests(calls)).toEqual([
        `GET /api/thoughts/${BRAIN}/${TAG}`,
        `GET /api/thoughts/${BRAIN}/${TAG_B}`,
        `GET /api/links/${BRAIN}/${THOUGHT}/${TAG}`,
        graphOf,
        `GET /api/links/${BRAIN}/${THOUGHT}/${TAG_B}`,
        graphOf,
      ]);
    });

    it("written whole it reads as it did, to the character, and a removal that finds its tag reads no thought", async () => {
      const { call, calls } = await connect(
        routes([[`GET /api/links/${BRAIN}/${THOUGHT}/${TAG_B}`, () => 404]], tagLink),
      );
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
      expect(requests(calls)).not.toContain(`GET /api/thoughts/${BRAIN}/${THOUGHT}/graph`);
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
      // was gone for good. The index is the store itself, its file held by
      // another process part of the way through a write: a fake stood here
      // that threw SQLite's `database is locked`, which the store has not
      // let out since it waits for a lock and says so in a sentence.
      const dir = mkdtempSync(join(tmpdir(), "thebrain-mcp-tools-"));
      const path = join(dir, `index-${BRAIN}.sqlite`);
      const store = new VectorStore(path, { busyTimeoutMs: 30 });
      store.setMeta({ brainId: BRAIN, model: "fake@v1#doc3", dimensions: 2, syncedThrough: null });
      store.upsert([
        { thoughtId: THOUGHT, name: "RAG", kind: 1, contentHash: "h", vector: new Float32Array([1, 0]) },
      ]);
      const writing = new DatabaseSync(path);
      writing.exec("BEGIN IMMEDIATE");
      try {
        const { call, calls } = await connect(deleted(thought("RAG")), () => ({
          config: { allowDestructive: true },
          store: () => store,
        }));
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
            "- its entry in the semantic index: Another server process had the semantic index " +
              "of this brain locked, and had not let go of it after 0.03 s. Every client " +
              "session runs a server process of its own, and they share one index file. This " +
              "write to the index was not made.",
            "",
            "## Next",
            `${IN_PART}. The thought is deleted, and is not to be deleted again. Its entry stays ` +
              "in the semantic index until brain_index is run with action=sync.",
          ].join("\n"),
        );
        expect(result.text).not.toMatch(/database is locked/);
        expect(writes(calls)).toEqual([`DELETE /api/thoughts/${BRAIN}/${THOUGHT}`]);
        // As the result says: the entry is there still.
        writing.exec("ROLLBACK");
        expect(store.size()).toBe(1);
      } finally {
        writing.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
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

    describe("the question a person is put", () => {
      // It is what they agree to, so each line has to be what it says.
      const ASK =
        "This client cannot display a confirmation form. Ask the user yourself and, once " +
        "they agree, repeat the call with confirm=true. Never do this without explicit " +
        "human consent.";
      /** The note as the API lists it among a thought's attachments, and one that is no note. */
      const NOTES_FILE = {
        id: "a77ac4ed-0000-4000-8000-00000000000a",
        name: null,
        location: "Notes.md",
        isNotes: true,
      };
      const PAGE = {
        id: "a77ac4ed-0000-4000-8000-00000000000b",
        name: "Spec",
        location: "https://example.com/spec",
        isNotes: false,
      };
      const held = { modificationDateTime: "2026-10-10T12:00:00", markdown: "The original note." };
      const under = [thought("Chunking", { id: PARENT }), thought("Ranking", { id: TAG_B })];
      const link = (to: string) => ({ id: LINK, thoughtIdA: THOUGHT, thoughtIdB: to, relation: 1 });
      const ask = async (kind: number, attachments: unknown[], note: unknown = held) => {
        const shown = {
          ...graph(thought("Retrieval", { kind })),
          children: under,
          links: under.map((t) => link(t.id)),
          attachments,
        };
        const { call, calls } = await connect(
          [["GET /graph", () => shown], ["GET /api/notes/", () => note], ...routes()],
          deleting(() => undefined),
        );
        const asked = await call("brain_delete_thought", { brainId: BRAIN, thoughtId: THOUGHT });
        expect(asked.isError).toBe(true);
        expect(writes(calls)).toEqual([]);
        return asked.text;
      };
      const question = (mark: string, lines: string[]): string =>
        `Delete the thought "Retrieval"${mark}?\n\n${lines.map((l) => `- ${l}`).join("\n")}\n\n` +
        `This cannot be undone.\n\n${ASK}`;

      it.each([
        [1, "", "children: 2"],
        [2, " [type]", "thoughts of this type: 2"],
        [4, " [tag]", "thoughts with this tag: 2"],
      ] as const)(
        "names what stands under a thought of kind %i as the read tools do",
        async (kind, mark, underIt) => {
          // "children: 2" of the thoughts of a type and of the thoughts a tag
          // is on: a person agreed to the loss of children there were none of.
          expect(await ask(kind, [NOTES_FILE, PAGE])).toBe(
            question(mark, ["links: 2", underIt, "note: 18 characters", "attachments: 1"]),
          );
        },
      );

      it("counts the note once: on its own line, and not among the attachments", async () => {
        // The API lists the note as an attachment, and it was counted there too.
        expect(await ask(1, [NOTES_FILE])).toBe(
          question("", ["links: 2", "children: 2", "note: 18 characters"]),
        );
        expect(await ask(1, [NOTES_FILE, PAGE, { ...PAGE, name: "Other" }])).toBe(
          question("", ["links: 2", "children: 2", "note: 18 characters", "attachments: 2"]),
        );
        // With no note, the attachments are what they were.
        expect(await ask(1, [PAGE], noNote)).toBe(
          question("", ["links: 2", "children: 2", "attachments: 1"]),
        );
      });
    });
  });
});

describe("what brain_ingest says of a batch written in part", () => {
  const DOOMED = "99999999-0000-4000-8000-000000000009";
  const TAG = "ffffffff-0000-4000-8000-000000000006";
  const HELD = "eeeeeeee-0000-4000-8000-000000000005";
  const FENCED = "```\ncode\n```\n";
  /** The warning for notes TheBrain did not keep whole, one line a note. */
  const WARNING = (...notes: string[]) =>
    `## Warning\nTheBrain did not keep every line of ${notes.length === 1 ? "a note" : "these notes"}:\n` +
    `${notes.map((n) => `- ${n}`).join("\n")}\n${FENCE_RULE} ` +
    `Read ${notes.length === 1 ? "it" : "each"} ${WRITE_IT_AGAIN}`;
  type Create = { name: string; sourceThoughtId?: string };
  /** The identifier a thought of each name is created with. */
  const ID: Record<string, string> = {
    Kept: "11111111-0000-4000-8000-000000000001",
    Lost: "22222222-0000-4000-8000-000000000002",
    Same: "33333333-0000-4000-8000-000000000003",
  };

  /**
   * The read of a thought. DOOMED is deleted between a plan's checks and its
   * writes: it is there the first time it is asked for, and nobody has it
   * from then on.
   */
  const thoughtRead = (): ((url: URL) => unknown) => {
    let checked = false;
    return (url) => {
      const id = url.pathname.split("/").pop()!;
      if (id === DOOMED && checked) return 404;
      if (id === DOOMED) checked = true;
      return { ...thought("Constraints", { aliases: [] }), id, kind: id === TAG ? 4 : 1 };
    };
  };

  /**
   * A brain where PARENT is an ordinary thought with `children` under it,
   * TAG is a tag and nobody has DOOMED by the time a plan writes. A thought
   * is created with the identifier `ID` has for its name; `first` goes ahead
   * of the routes.
   */
  const routes = (first: Route[] = [], children: unknown[] = []): Route[] => [
    ...first,
    ["GET /api/brains/", () => ({ id: BRAIN, name: "brain", homeThoughtId: PARENT })],
    [
      "GET /graph",
      (url) =>
        url.pathname.includes(DOOMED)
          ? generic403()
          : { ...graph(thought("parent", { id: PARENT })), children },
    ],
    ["GET /api/thoughts/", thoughtRead()],
    [
      "POST /api/thoughts/",
      (_url, body) => {
        const asked = body as Create;
        return asked.sourceThoughtId === DOOMED
          ? new Response(JSON.stringify(`Source Thought ${DOOMED} could not be located`), {
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
        { tempId: "kept", name: "Kept", parent: PARENT, note: OPEN_FENCE },
        { tempId: "lost", name: "Lost", parent: PARENT, note: OPEN_FENCE },
        { tempId: "gone", name: "Gone", parent: DOOMED, note: OPEN_FENCE },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(`${WARNING(`"Kept" (${ID["Kept"]}): line 3, "\`\`\`js"`)}\n\n## Next\n`);
    expect(result.text).toContain(
      [
        "## Failed",
        `- thought "Gone" (gone): Source Thought ${DOOMED} could not be located.${NOBODY_HAS_IT}`,
        `- note for "Lost" (${ID["Lost"]}): ` +
          boomAt(`POST /api/notes/${BRAIN}/${ID["Lost"]}/update`),
      ].join("\n"),
    );
  });

  it("with no such note written there is no warning, and written whole it names each note by identifier", async () => {
    const none = await connect(routes([["POST /api/notes/", boom]]));
    const failed = await none.call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [{ tempId: "lost", name: "Lost", parent: PARENT, note: OPEN_FENCE }],
    });
    expect(failed.isError).toBe(true);
    expect(failed.text).not.toContain("## Warning");

    const whole = await connect(routes());
    const result = await whole.call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [
        { tempId: "kept", name: "Kept", parent: PARENT, note: OPEN_FENCE },
        { tempId: "lost", name: "Lost", parent: PARENT, note: "a\n```\n```\nb" },
        { tempId: "plain", name: "Plain", parent: PARENT, note: "prose" },
        { tempId: "same", name: "Same", parent: PARENT, note: FENCED },
      ],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain(
      "- notes written: 4\n- tags attached: 0\n\n" +
        WARNING(
          `"Kept" (${ID["Kept"]}): line 3, "\`\`\`js"`,
          `"Lost" (${ID["Lost"]}): lines 2 and 3, a code block with nothing in it`,
        ) +
        "\n\n## Next\n",
    );
  });

  it("a note whose code blocks are closed is not warned about: the batch reads as one with no code in it", async () => {
    // Every note with a fenced block used to stand under "Warning" as one
    // that "will be corrupted", with the advice to indent code instead.
    // TheBrain keeps a closed block to the character.
    const batch = async (note: string) => {
      const { call } = await connect(routes());
      return call("brain_ingest", {
        brainId: BRAIN,
        thoughts: [
          { tempId: "kept", name: "Kept", parent: PARENT, note },
          { tempId: "lost", name: "Lost", parent: PARENT, note: `before\n\n${note}\nafter` },
        ],
      });
    };
    const plain = await batch("prose\n");
    expect(plain.isError).toBe(false);
    expect(plain.text).not.toContain("## Warning");
    for (const fenced of [FENCED, "```js\nconst a = 1;\n```\n\n~~~\ntilde\n~~~\n"]) {
      expect(await batch(fenced), fenced).toEqual(plain);
    }
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
        `- note for "Same" (${ID["Same"]}): ` +
          boomAt(`POST /api/notes/${BRAIN}/${ID["Same"]}/update`),
        `- tag ${TAG} on "Same" (${ID["Same"]}): ${boomAt("POST /api/links/" + BRAIN)}`,
        `- aliases for "Held" (${HELD}): ${boomAt(`PATCH /api/thoughts/${BRAIN}/${HELD}`)}`,
      ].join("\n"),
    );
  });

  it("a line under Failed explains the API's answer as a call's own failure is explained", async () => {
    // The lines had the API's bare words: its catch-all 403 read as a key
    // that was missing, and "Could not create thought." as nothing at all.
    const answer = (body: string, status: number): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const { call } = await connect(
      routes([
        [
          "POST /api/thoughts/",
          (_url, body) => {
            const { name } = body as Create;
            if (name === "Refused") return answer(GENERIC_403, 403);
            if (name === "Bare") return answer("Could not create thought.", 400);
            return { id: ID[name] ?? THOUGHT };
          },
        ],
      ]),
    );
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [
        { tempId: "kept", name: "Kept", parent: PARENT },
        { tempId: "refused", name: "Refused", parent: PARENT },
        { tempId: "bare", name: "Bare", parent: PARENT },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      [
        "## Failed",
        '- thought "Refused" (refused): TheBrain answered 403 and named no cause ' +
          `(POST /api/thoughts/${BRAIN}). That is its answer when an identifier in the call ` +
          `names nothing in this brain.${NOBODY_HAS_IT}`,
        '- thought "Bare" (bare): Could not create thought. TheBrain named no cause ' +
          `(POST /api/thoughts/${BRAIN}). It answers so when the parent named for the new ` +
          "thought was deleted a moment ago, or the type named for it is no thought of this " +
          "brain. Nothing was created. Read the parent and the type with brain_get_thought " +
          "before sending the call again.",
        "",
        "## Next",
      ].join("\n"),
    );
    // The API's own words for a key are not passed on for what is no key's failure.
    expect(result.text).not.toContain("An API key is required");
  });

  it("a refusal ahead of a write is explained without its \"Nothing was written\", which the batch would be read by", async () => {
    // A plan thought that lands on a type its parent holds as a child: what
    // the plan puts under it is refused before the request, and the rest of
    // the batch is written.
    const TYPE = "eeeeeeee-0000-4000-8000-00000000000e";
    const { call } = await connect(
      routes(
        [
          [
            `GET /api/thoughts/${BRAIN}/${TYPE}`,
            (url) => {
              const type = { ...thought("Pattern"), id: TYPE, kind: 2 };
              return url.pathname.endsWith("/graph") ? graph(type) : type;
            },
          ],
        ],
        [{ id: TYPE, name: "Pattern", kind: 2 }],
      ),
    );
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [
        { tempId: "p", name: "Pattern", parent: PARENT },
        { tempId: "under", name: "Under", parent: "p" },
        { tempId: "kept", name: "Kept", parent: PARENT },
      ],
    });

    expect(result.isError).toBe(true);
    const line = /^- thought "Under" \(under\): (.*)$/m.exec(result.text)?.[1];
    expect(line).toBe(
      `sourceThoughtId ${TYPE} cannot be a parent: it is the type "Pattern". A thought ` +
        "linked under a type is given that type in place of the one it had. To set a type " +
        "pass it as typeId to brain_update_thought or brain_create_thought; for a parent " +
        "name an ordinary thought.",
    );
    expect(result.text).toContain(`created  Kept     ${ID["Kept"]}`);
  });

  it("two plan items for one thought that fails are one line under Failed, and the other is skipped", async () => {
    // Both used to stand under Failed with the one reason, as if two
    // requests had been refused.
    const { call, sent } = await connect(routes());
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [
        { tempId: "x", name: "Same", parent: DOOMED },
        { tempId: "y", name: "Same", parent: DOOMED },
        { tempId: "under", name: "Leaf", parent: "y" },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      [
        "## Failed",
        `- thought "Same" (x): Source Thought ${DOOMED} could not be located.${NOBODY_HAS_IT}`,
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
  const DROPPED =
    `the connection to http://localhost:11522 failed before an answer came (read ECONNRESET).${APP}`;
  const catchAll = (request: string): string =>
    `TheBrain answered 403 and named no cause (${request}). ` +
    (request.includes("/api/notes/")
      ? "The read of a note gets that answer for a moment after the note is deleted, and it " +
        "says nothing of the thought or of its identifier."
      : !request.includes(BRAIN)
        ? "The request carries no identifier, so none is at fault."
        : "That is its answer when an identifier in the call names nothing in this brain. It " +
          "may have been deleted, or be another brain's. Take identifiers from brain_search " +
          "or brain_get_thought.");
  /** Each way a read is failed here: its name, the answer, and what that reads as. */
  const FAILURES: Array<[string, () => unknown, (request: string) => string]> = [
    ["a 500", boom, failed500],
    ["no answer", noAnswer, () => NO_ANSWER],
    ["a dropped connection", dropped, () => DROPPED],
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

      // A code block that is closed is kept to the character, and used to
      // be warned about as one whose closing fence TheBrain drops.
      const fresh = await set([["GET /api/notes/", () => noNote]], { markdown: "```\ncode\n```\n" });
      expect(fresh.result).toEqual({ isError: false, text: "## Done\nnote created" });
    });

    it("a note TheBrain reads back is one, though nothing in it shows; white space alone it reads as none", async () => {
      // A byte order mark alone is read back as one (contract test), and
      // trim() took it for no note: the result said the note was created.
      const bom = [["GET /api/notes/", () => ({ ...held, markdown: "\ufeff" })]] as Route[];
      expect((await set(bom)).result).toEqual({
        isError: false,
        text: "## Done\nnote replaced; the previous text (1 characters) is gone",
      });
      const unanswered = await set([...bom, ["POST /api/notes/", noAnswer]]);
      expect(unanswered.result.text).toContain(
        "Before the call the note held 1 characters, and they are gone if it did.",
      );
      // White space alone TheBrain reads as "", the same as no note.
      const blank = [["GET /api/notes/", () => ({ ...held, markdown: "" })]] as Route[];
      expect((await set(blank)).result).toEqual({ isError: false, text: "## Done\nnote created" });
    });

    it("says which lines TheBrain did not keep, and only of a note that lost one", async () => {
      const REPLACED = "## Done\nnote replaced; the previous text (18 characters) is gone";
      const warned = (lines: string, more = ""): string =>
        `${REPLACED}\n\n## Warning\nTheBrain did not keep ${lines}, of this note. ` +
        `${FENCE_RULE}${more} Read the note ${WRITE_IT_AGAIN}`;

      for (const kept of [
        "before\n\n```js\ncode();\n```\n\nafter",
        "```\none\n```\n\n````md\n```js\nnested\n```\n````",
        "a ```span``` and an indented fence:\n\n    ```\n    code",
        "~~~\ncode\n~~~",
      ]) {
        expect((await set([], { markdown: kept })).result, kept).toEqual({
          isError: false,
          text: REPLACED,
        });
      }

      for (const [markdown, lines, more] of [
        // A block left open loses the fence that opened it.
        [OPEN_FENCE, 'line 3, "```js"'],
        // A line that opens with a code span goes with its sentence.
        ["a\n\n```x``` is inline code\n\nend", 'line 3, "```x``` is inline code"'],
        [`a\n\n\`\`\`${"x".repeat(70)}\n\nend`, `line 3, "\`\`\`${"x".repeat(57)}…"`],
        ["a\n\n```\n```\n\nend", "lines 3 and 4, a code block with nothing in it"],
        // A longer fence around a bare one is that to TheBrain: its first two lines.
        ["````md\n```\nnested\n```\n````", "lines 1 and 2, a code block with nothing in it"],
        [
          "x\n```\n```\ny\n```tail",
          'lines 2 and 3, a code block with nothing in it; line 5, "```tail"',
        ],
        // With `\r\n` the lines are the same lines.
        ["intro\r\n\r\n```js\r\ncode();", 'line 3, "```js"'],
        [
          "```js\n```",
          "lines 1 and 2, a code block with nothing in it",
          " Nothing else was in the note, so the thought reads as having none.",
        ],
      ] as const) {
        const { result, calls } = await set([], { markdown });
        expect(result, markdown).toEqual({ isError: false, text: warned(lines, more) });
        // The note is written as it was given: nothing is refused or mended.
        expect(requests(calls), markdown).toEqual([NOTE, `POST /api/notes/${BRAIN}/${THOUGHT}/update`]);
      }
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

    it("says which lines of the whole note TheBrain did not keep, and nothing of a block that is closed", async () => {
      const APPENDED = "## Done\ntext appended to the note";
      const warned = (lines: string): string =>
        `${APPENDED}\n\n## Warning\nTheBrain did not keep ${lines}, of the note with this ` +
        `text added. ${FENCE_RULE} Read the note ${WRITE_IT_AGAIN}`;
      const BLOCK = "```sh\nls\n```";

      // A closed block, added to a note and written as a first note: it used
      // to be warned about either way.
      for (const note of [held, noNote, { ...held, markdown: "a\n\n```\nfirst\n```" }]) {
        const { result } = await append([["GET /api/notes/", () => note]], { markdown: BLOCK });
        expect(result, note.markdown).toEqual({ isError: false, text: APPENDED });
      }

      // The lines are counted in the note as it is with the text added:
      // "The original note.", the separator's blank line, then the addition.
      const open = await append([], { markdown: "```js\ncode();" });
      expect(open.result).toEqual({ isError: false, text: warned('line 3, "```js"') });
      expect(open.sent("POST")).toEqual([{ markdown: "\n\n```js\ncode();" }]);

      // TheBrain goes over the whole note. Where the note holds a fence with
      // no partner, a block that is closed loses the fence that closes it.
      const stray = { ...held, markdown: "begin\n\n```\nleft open" };
      const closed = await append([["GET /api/notes/", () => stray]], { markdown: BLOCK });
      expect(closed.result).toEqual({ isError: false, text: warned('line 8, "```"') });

      // With no note the text is the whole note.
      const first = await append([["GET /api/notes/", () => noNote]], { markdown: "x\n```" });
      expect(first.result).toEqual({ isError: false, text: warned('line 2, "```"') });
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

      // A note of a byte order mark alone is read back as one, and was left
      // out of the question as none: consent to that is not consent to it.
      const bom = await connect(
        routes([["GET /api/notes/", () => ({ ...held, markdown: "\ufeff" })]]),
        deleting,
      );
      expect(
        (await bom.call("brain_delete_thought", { brainId: BRAIN, thoughtId: THOUGHT })).text,
      ).toBe(question(["- links: 0", "- children: 0", "- note: 1 characters"]));
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

  describe("brain_list_types_and_tags", () => {
    // What each list answers for a brain that has none, 5 of 5 on the live
    // API: a 400, in the words of a failure (docs/api-map.md, L1).
    const noTypes = said(400, `Could not retrieve list of Types for brain ${BRAIN}`);
    const noTags = said(400, `Could not retrieve list of Tags for brain ${BRAIN}`);
    const list = async (types: () => unknown, tags: () => unknown) => {
      const { call } = await connect([
        [`GET /api/thoughts/${BRAIN}/types`, types],
        [`GET /api/thoughts/${BRAIN}/tags`, tags],
      ]);
      return call("brain_list_types_and_tags", { brainId: BRAIN });
    };

    it("the 400 of an empty list is a brain with none", async () => {
      expect(await list(noTypes, noTags)).toEqual({
        isError: false,
        text: "## Note\nThis brain has no types or tags yet.",
      });
    });

    it.each([
      ["types", (failure: () => unknown) => list(failure, noTags)],
      ["tags", (failure: () => unknown) => list(noTypes, failure)],
    ])("a 400 in other words from /%s is an error, where it read as a brain with none", async (which, call) => {
      // Any 400 was taken for an empty list, and the answer was the note above.
      expect(await call(said(400, "The list could not be read."))).toEqual({
        isError: true,
        text: `The list could not be read. (GET /api/thoughts/${BRAIN}/${which})`,
      });
    });

    it.each(FAILURES)("%s from the list of types is an error too", async (_name, failure) => {
      const result = await list(failure, noTags);
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain("no types or tags");
    });
  });
});

describe("a thought's name: none, white space alone, too long, and one that does not show", () => {
  const TYPE = "eeeeeeee-0000-4000-8000-000000000005";
  const TAG = "ffffffff-0000-4000-8000-000000000006";
  const OTHER = "abababab-0000-4000-8000-000000000007";

  /**
   * Names the live API takes for none, each with what the refusal says of
   * it. White space is Unicode's property: a next line (U+0085) is of it,
   * which `trim()` does not drop.
   */
  const BLANK: Array<[sent: string, said: string]> = [
    [" ", "white space alone (U+0020)"],
    ["\t\n", "white space alone (U+0009 U+000A)"],
    ["\u00a0", "white space alone (U+00A0)"],
    ["\u0085", "white space alone (U+0085)"],
    ["\u3000 ", "white space alone (U+3000 U+0020)"],
  ];
  const TOO_LONG: [sent: string, said: string] = [
    "a".repeat(1025),
    "1025 UTF-16 units long, and TheBrain keeps the first 1024 of a name and drops the rest " +
      "with a 200",
  ];
  const noName = (said: string): string =>
    `name is ${said}, and a thought has to have a name. Nothing was written.`;
  const UNSEEN = "(no visible character: U+200B)";

  describe("brain_update_thought", () => {
    /** A brain that would take every write of these calls: the type is one, the patch a 200. */
    const routes: Route[] = [
      ["GET /api/thoughts/", () => thought("Pattern", { id: TYPE, kind: 2, aliases: [] })],
      ["PATCH /api/thoughts/", () => 200],
    ];
    const rename = async (name: string, extra: Record<string, unknown> = {}) => {
      const { call, calls, sent } = await connect(routes);
      const result = await call("brain_update_thought", {
        brainId: BRAIN,
        thoughtId: THOUGHT,
        name,
        ...extra,
      });
      return { result, calls, patches: sent("PATCH") };
    };

    it("a rename to no name is refused before any request, where it was listed under Done", async () => {
      // The API answers 200 to each of these and leaves the name as it was.
      for (const [name, said] of [["", "empty"], ...BLANK]) {
        const { result, calls } = await rename(name!);
        expect(result, JSON.stringify(name)).toEqual({ isError: true, text: noName(said!) });
        expect(calls, JSON.stringify(name)).toEqual([]);
      }
    });

    it("so is a rename to a name too long to keep, which the API would cut", async () => {
      const { result, calls } = await rename(TOO_LONG[0]);
      expect(result).toEqual({ isError: true, text: `name is ${TOO_LONG[1]}. Nothing was written.` });
      expect(calls).toEqual([]);
    });

    it("nothing else of the call is written either, the type that goes first included", async () => {
      const { result, calls } = await rename("\u00a0", {
        typeId: TYPE,
        label: "pattern",
        addAliases: ["R.A.G."],
      });
      expect(result).toEqual({ isError: true, text: noName("white space alone (U+00A0)") });
      expect(calls).toEqual([]);
    });

    it("a name is sent as it was given and reported as it is stored", async () => {
      for (const [name, stored] of [
        ["  RAG\t", "RAG"],
        ["\u0085RAG\u0085", "RAG"],
        ["line\nbreak", "line break"],
        ["\ufeffRAG", "\ufeffRAG"],
      ] as const) {
        const { result, patches } = await rename(name);
        expect(result, JSON.stringify(name)).toEqual({
          isError: false,
          text: `## Done\n- name = ${JSON.stringify(stored)}`,
        });
        expect(patches).toEqual([[{ op: "replace", path: "/name", value: name }]]);
      }
    });

    it("a name that does not show is written, and spelled out where it read as an empty one", async () => {
      const { result, patches } = await rename("\u200b", { label: "pattern" });
      expect(result).toEqual({
        isError: false,
        text: `## Done\n- name = "${UNSEEN}"\n- label = "pattern"`,
      });
      expect(patches).toEqual([
        [{ op: "replace", path: "/name", value: "\u200b" }],
        [{ op: "replace", path: "/label", value: "pattern" }],
      ]);
    });

    it("an ordinary rename reads as it did, to the character", async () => {
      for (const name of ["RAG", "Ретривер", "日本語", "🧠", "👨\u200d👩\u200d👧", "é", "a\u200bb", "."]) {
        const { result } = await rename(name);
        expect(result).toEqual({ isError: false, text: `## Done\n- name = ${JSON.stringify(name)}` });
      }
    });

    it("the alias edit is told the name as it is stored", async () => {
      // An alias equal to the name is none, and the name here is "RAG": told
      // the name as it was sent, the edit took "RAG" for an alias to add.
      const { result, patches } = await rename("\u0085RAG", { addAliases: ["rag"] });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("aliases unchanged");
      expect(patches).toEqual([[{ op: "replace", path: "/name", value: "\u0085RAG" }]]);
    });
  });

  describe("brain_create_thought", () => {
    const create = async (name: string, extra: Record<string, unknown> = {}) => {
      const { call, calls, sent } = await connect(brainRoutes({ aliases: true }));
      const result = await call("brain_create_thought", {
        brainId: BRAIN,
        name,
        parentId: PARENT,
        ...extra,
      });
      return { result, calls, posts: sent("POST") };
    };

    it("a name of white space is refused before any request, the reads of the tag and the parent included", async () => {
      // The API's own 400 for it came after those reads: "A name is required".
      for (const [name, said] of BLANK) {
        const { result, calls } = await create(name, { tagIds: [TAG], typeId: TYPE });
        expect(result, JSON.stringify(name)).toEqual({ isError: true, text: noName(said) });
        expect(calls, JSON.stringify(name)).toEqual([]);
      }
    });

    it("an empty name is refused by the schema, as it was: no request, and the argument named", async () => {
      const { result, calls } = await create("");
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/at least 1 character.* name$/);
      expect(calls).toEqual([]);
    });

    it("a name too long to keep is refused, where it was cut and reported whole", async () => {
      const { result, calls } = await create(TOO_LONG[0]);
      expect(result).toEqual({ isError: true, text: `name is ${TOO_LONG[1]}. Nothing was written.` });
      expect(calls).toEqual([]);
      // 1,024 units are kept whole, and the blanks at the ends are not counted.
      const kept = await create(` ${"a".repeat(1024)} `);
      expect(kept.result.isError).toBe(false);
      expect(kept.result.text).toContain(`created thought "${"a".repeat(1024)}" — ${THOUGHT}`);
    });

    it("the thought is reported under the name it is stored by, and sent as it was given", async () => {
      for (const [name, stored] of [
        ["  RAG\t", "RAG"],
        ["line\nbreak", "line break"],
      ] as const) {
        const { result, posts } = await create(name);
        expect(result.isError).toBe(false);
        expect(result.text).toContain(`## Done\n- created thought "${stored}" — ${THOUGHT}\n`);
        expect(posts).toEqual([expect.objectContaining({ name })]);
      }
    });

    it("a name that does not show is created, and spelled out in the result", async () => {
      const { result, posts } = await create("\u200b");
      expect(result.isError).toBe(false);
      expect(result.text).toContain(`## Done\n- created thought "${UNSEEN}" — ${THOUGHT}\n`);
      expect(posts).toEqual([expect.objectContaining({ name: "\u200b" })]);
    });

    it("an ordinary name reads as it did, to the character", async () => {
      for (const name of ["RAG", "Ретривер", "🧠", "👨\u200d👩\u200d👧", "a\u200bb", "\u2800"]) {
        const { result } = await create(name);
        expect(result).toEqual({
          isError: false,
          text:
            `## Done\n- created thought "${name}" — ${THOUGHT}\n\n## Next\n` +
            "The identifier above works immediately. Searching for this thought by name only " +
            "succeeds after a few seconds, so refer to it by identifier.",
        });
      }
    });
  });

  describe("brain_ingest", () => {
    const plan = async (name: string) => {
      const { call, calls, sent } = await connect(brainRoutes({ aliases: true }));
      const result = await call("brain_ingest", {
        brainId: BRAIN,
        thoughts: [
          { tempId: "top", name: "Top", parent: PARENT },
          { tempId: "t1", name, parent: "top" },
        ],
      });
      return { result, calls, posts: sent("POST") };
    };
    /** The table's rows, each cut into cells where two or more spaces part them. */
    const rows = (text: string): string[][] =>
      text
        .split("\n")
        .filter((l) => /^(created|existed) /.test(l))
        .map((l) => l.split(/\s{2,}/));

    it("a plan is rejected for such a name before any request, with the plan item named", async () => {
      // A next line used to pass the check and be refused by the API in the
      // middle of the batch, with the thought above it written.
      for (const [name, said] of [...BLANK, TOO_LONG]) {
        const { result, calls } = await plan(name);
        expect(result, JSON.stringify(name.slice(0, 8))).toEqual({
          isError: true,
          text:
            `Plan rejected, nothing was written: the name of thought "t1" is ${said}` +
            `${said.startsWith("white") ? ", and a thought has to have a name" : ""}. ` +
            "Fix it and retry.",
        });
        expect(calls).toEqual([]);
      }
    });

    it("a byte order mark is no white space: the thought is made, as the other tools make it", async () => {
      // `trim()` drops it, and the plan used to be rejected for an empty name.
      const { result, posts } = await plan("\ufeff");
      expect(result.isError).toBe(false);
      expect(posts).toEqual([
        expect.objectContaining({ name: "Top" }),
        expect.objectContaining({ name: "\ufeff" }),
      ]);
      // In the last cell of a row it used to go with the padding.
      expect(rows(result.text)).toEqual([
        ["created", "Top", THOUGHT],
        ["created", "(no visible character: U+FEFF)", THOUGHT],
      ]);
    });

    it("the table has each title as it is stored: a line feed in one broke the row in two", async () => {
      const { result } = await plan(" line\nbreak\t");
      expect(result.isError).toBe(false);
      expect(rows(result.text)).toEqual([
        ["created", "Top", THOUGHT],
        ["created", "line break", THOUGHT],
      ]);
    });
  });

  describe("where else a result quotes a name that does not show", () => {
    // These printed the name as it is: `thought "" (t1)`, `it is the type ""`.
    const MARK = "(no visible character: U+FEFF)";
    /** The read of a thought: each of these is there, of the kind and under the name given. */
    const reads = (named: Record<string, { name: string; kind: number }>): Route => [
      "GET /api/thoughts/",
      (url) => {
        const id = url.pathname.split("/").pop()!;
        return thought("RAG", { id, aliases: [], ...named[id] });
      },
    ];
    const boom = (): Response =>
      new Response(JSON.stringify("boom"), {
        status: 500,
        headers: { "content-type": "application/json" },
      });

    it("brain_list: the active thought", async () => {
      const { call } = await connect(
        [
          [
            "GET /api/app/state",
            () => ({ currentBrainId: BRAIN, activeThoughtId: THOUGHT, activeThoughtName: "\u200b" }),
          ],
          ["GET /api/brains", () => [{ id: BRAIN, name: "Work" }]],
        ],
        () => ({ indexer: () => ({ status: () => ({ compatible: false, size: 0 }) }) }),
      );
      const result = await call("brain_list", {});
      expect(result.isError).toBe(false);
      expect(result.text.slice(result.text.indexOf("## Active"))).toBe(
        `## Active thought\n${UNSEEN} (${THOUGHT})`,
      );
    });

    it("a typeId that is no type, and a tag that is no tag: the refusal names what it is", async () => {
      const routes: Route[] = [
        reads({ [TYPE]: { name: "\u200b", kind: 1 }, [TAG]: { name: "\ufeff", kind: 2 } }),
      ];
      const typed = await connect(routes);
      expect(
        await typed.call("brain_update_thought", { brainId: BRAIN, thoughtId: THOUGHT, typeId: TYPE }),
      ).toEqual({
        isError: true,
        text:
          `typeId ${TYPE} is not a type: it is the thought "${UNSEEN}". Nothing was written. ` +
          "Take type identifiers from brain_list_types_and_tags.",
      });
      const tagged = await connect(routes);
      expect(
        await tagged.call("brain_tag", { brainId: BRAIN, thoughtId: THOUGHT, add: [TAG] }),
      ).toEqual({
        isError: true,
        text:
          `tagId ${TAG} is not a tag: it is the type "${MARK}". Nothing was written. ` +
          "Take tag identifiers from brain_list_types_and_tags.",
      });
      expect([...typed.calls, ...tagged.calls].filter((c) => c.method !== "GET")).toEqual([]);
    });

    it("a type and a tag named as a parent: the refusal names which", async () => {
      const { call, calls } = await connect([
        reads({ [TYPE]: { name: "\u200b", kind: 2 }, [TAG]: { name: "\ufeff", kind: 4 } }),
      ]);
      const under = (id: string) =>
        call("brain_link", { brainId: BRAIN, fromId: id, toId: THOUGHT, relation: "child" });
      expect((await under(TYPE)).text).toMatch(
        new RegExp(`^fromId ${TYPE} cannot be a parent: it is the type "\\(no visible character: U\\+200B\\)"\\. Nothing was written\\. `),
      );
      expect((await under(TAG)).text).toMatch(
        new RegExp(`^fromId ${TAG} cannot be a parent: it is the tag "\\(no visible character: U\\+FEFF\\)"\\. Nothing was written\\. `),
      );
      expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    });

    it("brain_ingest: a thought's line under Failed and under Skipped", async () => {
      const { call } = await connect([
        ["POST /api/thoughts/", boom],
        ...brainRoutes({ aliases: true }),
      ]);
      const result = await call("brain_ingest", {
        brainId: BRAIN,
        thoughts: [
          { tempId: "top", name: "\u200b", parent: PARENT },
          { tempId: "t1", name: "\ufeff", parent: "top" },
          { tempId: "t2", name: "Seen", parent: "top" },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain(`## Failed\n- thought "${UNSEEN}" (top): TheBrain failed with a 500 `);
      expect(result.text).toContain(
        `## Skipped\n- thought "${MARK}" (t1): depends on "top", which was not created\n` +
          '- thought "Seen" (t2): depends on "top", which was not created\n',
      );
    });

    const plan = (extra: Record<string, unknown>) => ({
      brainId: BRAIN,
      thoughts: [{ tempId: "top", name: "\u200b", parent: PARENT, ...extra }],
    });

    it("brain_ingest: the lines for its note, its tag and its aliases", async () => {
      const failing = await connect([
        ["POST /api/notes/", boom],
        ["POST /api/links/", boom],
        ["PATCH /api/thoughts/", boom],
        ["GET /api/notes/", () => noNote],
        // Found in place: a plan adds aliases to a thought that was there.
        ["GET /graph", () => ({ ...graph(thought("parent")), children: [thought("\u200b")] })],
        reads({ [TAG]: { name: "gotcha", kind: 4 } }),
        ...brainRoutes({ aliases: true }),
      ]);
      const failed = await failing.call(
        "brain_ingest",
        plan({ note: "Body.", tagIds: [TAG], aliases: ["Alias"] }),
      );
      expect(failed.isError).toBe(true);
      const lines = failed.text.split("\n").filter((l) => l.startsWith("- ") && l.includes(": TheBrain failed"));
      expect(lines.map((l) => l.slice(0, l.indexOf(": TheBrain failed")))).toEqual([
        `- note for "${UNSEEN}" (${THOUGHT})`,
        `- tag ${TAG} on "${UNSEEN}" (${THOUGHT})`,
        `- aliases for "${UNSEEN}" (${THOUGHT})`,
      ]);
    });

    it("brain_ingest: the warning about a note that lost a line", async () => {
      const written = await connect([
        ["POST /api/notes/", () => 200],
        ["GET /api/notes/", () => noNote],
        ...brainRoutes({ aliases: true }),
      ]);
      // A code block left open, so the note is one TheBrain does not keep
      // whole: a block that is closed is not warned about at all.
      const warned = await written.call("brain_ingest", plan({ note: OPEN_FENCE }));
      expect(warned.isError).toBe(false);
      expect(warned.text).toContain(
        "\n\n## Warning\nTheBrain did not keep every line of a note:\n" +
          `- "${UNSEEN}" (${THOUGHT}): line 3, "\`\`\`js"\n` +
          `${FENCE_RULE} Read it ${WRITE_IT_AGAIN}\n\n## Next\n`,
      );
    });

    it("brain_index: a thought it could not read", async () => {
      const embedder: Embedder = {
        id: "fake@v1",
        dimensions: 2,
        embedDocuments: async (texts) => texts.map(() => new Float32Array([1, 0])),
        embedQuery: async () => new Float32Array([1, 0]),
      };
      const store = new VectorStore(":memory:");
      const { call } = await connect(
        [
          ["GET /modifications", () => []],
          ["GET /api/brains/", () => ({ id: BRAIN, name: "Test brain", homeThoughtId: THOUGHT })],
          [
            "GET /graph",
            () => ({ ...graph(thought("\u200b")), attachments: [{ id: LINK, isNotes: true, type: 1 }] }),
          ],
          ["GET /api/notes/", boom],
        ],
        (api) => ({ indexer: () => new SemanticIndexer(api, store, embedder) }),
      );
      const result = await call("brain_index", { brainId: BRAIN, action: "rebuild" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain(`\n- ${UNSEEN} — ${THOUGHT}\n`);
    });

    it("a name that shows is quoted as it was, to the character", async () => {
      const { call } = await connect([reads({ [TYPE]: { name: "Pattern", kind: 1 } })]);
      expect(
        (await call("brain_update_thought", { brainId: BRAIN, thoughtId: THOUGHT, typeId: TYPE })).text,
      ).toBe(
        `typeId ${TYPE} is not a type: it is the thought "Pattern". Nothing was written. ` +
          "Take type identifiers from brain_list_types_and_tags.",
      );
    });
  });

  describe("what the read tools print for a name that does not show", () => {
    const at = (id: string, name: string | null, kind = 1) => thought("x", { id, kind, name });
    const zero = at(OTHER, "\u200b");
    const mark = at(PARENT, "\ufeff");
    const NO_ID = "00000000-0000-0000-0000-000000000000";

    it("brain_get_thought: the thought, its neighbours, its type and its tags", async () => {
      const { call } = await connect([
        [
          "GET /graph",
          () => ({
            ...graph(thought("\u200b\ufeff\u00ad", { typeId: TYPE })),
            type: at(TYPE, "\u2060", 2),
            tags: [at(TAG, "\u200d", 4), at(LINK, "gotcha", 4)],
            parents: [mark],
            children: [zero, at(LINK, "Embeddings"), at(TAG, null)],
          }),
        ],
        ["GET /api/notes", () => noNote],
      ]);
      const result = await call("brain_get_thought", { brainId: BRAIN, thoughtId: THOUGHT });
      expect(result).toEqual({
        isError: false,
        text: [
          "# (no visible character: U+200B U+FEFF U+00AD)",
          THOUGHT,
          "",
          "## Type",
          `(no visible character: U+2060) — ${TYPE}`,
          "",
          "## Tags",
          "(no visible character: U+200D), gotcha",
          "",
          "## Parents",
          `- (no visible character: U+FEFF) — ${PARENT}`,
          "",
          "## Children",
          `- ${UNSEEN} — ${OTHER}`,
          `- Embeddings — ${LINK}`,
          `- (unnamed) — ${TAG}`,
        ].join("\n"),
      });
    });

    it("brain_traverse: in its heading, its hops, the way there and a labelled link", async () => {
      const { call } = await connect([
        [
          "GET /graph",
          () => ({
            ...graph(thought("\u200b")),
            children: [mark, at(OTHER, "Embeddings"), at(TAG, null)],
            links: [{ id: LINK, thoughtIdA: THOUGHT, thoughtIdB: PARENT, relation: 1, meaning: 1, name: "holds" }],
          }),
        ],
      ]);
      const result = await call("brain_traverse", { brainId: BRAIN, thoughtId: THOUGHT, depth: 1 });
      expect(result).toEqual({
        isError: false,
        text: [
          `# Neighbourhood of: ${UNSEEN}`,
          "",
          "## Hop 1",
          `- (no visible character: U+FEFF) — ${PARENT}  (via ${UNSEEN})`,
          `- Embeddings — ${OTHER}  (via ${UNSEEN})`,
          // A thought the API sends with no name read as an empty one here.
          `- (unnamed) — ${TAG}  (via ${UNSEEN})`,
          "",
          "## Labelled links",
          `- ${UNSEEN} -> holds -> (no visible character: U+FEFF)`,
          "",
          "## Totals",
          "thoughts 4, links 3",
        ].join("\n"),
      });
    });

    it("brain_list_types_and_tags", async () => {
      const { call } = await connect([
        ["GET /types", () => [at(TYPE, "\u2060", 2), at(OTHER, "Pattern", 2)]],
        ["GET /tags", () => [at(TAG, "\ufe0f", 4)]],
      ]);
      const result = await call("brain_list_types_and_tags", { brainId: BRAIN });
      expect(result).toEqual({
        isError: false,
        text:
          `## Types\n- (no visible character: U+2060) — ${TYPE}\n- Pattern — ${OTHER}\n\n` +
          `## Tags\n- (no visible character: U+FE0F) — ${TAG}`,
      });
    });

    it("brain_recent_changes: a byte order mark at the end of a row went with the padding", async () => {
      const entry = (second: number, fields: Record<string, unknown>) => ({
        sourceId: THOUGHT,
        sourceType: 2,
        extraAId: NO_ID,
        extraAType: -1,
        extraBId: NO_ID,
        extraBType: -1,
        modType: 101,
        oldValue: null,
        newValue: null,
        userId: NO_ID,
        brainId: BRAIN,
        creationDateTime: `2026-10-10T12:00:0${second}`,
        modificationDateTime: `2026-10-10T12:00:0${second}`,
        syncUpdateDateTime: null,
        ...fields,
      });
      const known = [thought("RAG"), mark, at(OTHER, "\u200b", 4)];
      const { call } = await connect([
        [
          "GET /modifications",
          () => [
            entry(3, {
              sourceId: LINK,
              sourceType: 3,
              extraAId: THOUGHT,
              extraAType: 2,
              extraBId: PARENT,
              extraBType: 2,
            }),
            entry(2, { sourceId: PARENT }),
            entry(1, { sourceId: OTHER }),
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
        // It read "RAG ↔", and the row under it "created" and no more.
        ["link created", "RAG ↔ (no visible character: U+FEFF)"],
        ["created", "(no visible character: U+FEFF)"],
        ["created", `${UNSEEN} [tag]`],
      ]);
    });

    it("brain_delete_thought: the question names what is to be deleted", async () => {
      const { call } = await connect(
        [
          ["GET /graph", () => graph(thought("\u200b"))],
          ["GET /api/notes", () => noNote],
        ],
        () => ({ config: { allowDestructive: true } }),
      );
      const asked = await call("brain_delete_thought", { brainId: BRAIN, thoughtId: THOUGHT });
      expect(asked.isError).toBe(true);
      expect(asked.text).toMatch(/^Delete the thought "\(no visible character: U\+200B\)"\?\n/);
    });

    it("a name with one character that shows is printed as it is", async () => {
      // A person's emoji, a single symbol, a script the tables may not know:
      // none of it is spelled out, with what does not show beside it or not.
      const names = ["🧠", "👨\u200d👩\u200d👧", "❤\ufe0f", ".", "é", "e\u0301", "日本", "a\u200bb", "\u200bRAG\ufeff"];
      // Blank to the eye, and a symbol or a mark by its properties: as it was.
      const unknown = ["\u2800", "\u0301"];
      const all = [...names, ...unknown];
      const { call } = await connect([
        [
          "GET /graph",
          () => ({
            ...graph(thought("RAG")),
            children: all.map((name, i) => at(`${OTHER.slice(0, -2)}${String(i).padStart(2, "0")}`, name)),
          }),
        ],
        ["GET /api/notes", () => noNote],
      ]);
      const result = await call("brain_get_thought", { brainId: BRAIN, thoughtId: THOUGHT });
      expect(result.text.split("\n").slice(4)).toEqual(
        all.map((name, i) => `- ${name} — ${OTHER.slice(0, -2)}${String(i).padStart(2, "0")}`),
      );
    });
  });
});

describe("brain_create_type_or_tag", () => {
  const NEW = "eeeeeeee-0000-4000-8000-000000000005";
  /** The newest entry the brain's log has before the call. */
  const NEWEST = "2026-10-13T21:01:39.153181";
  const entry = (sourceId: string, modType: number, at: string) => ({
    sourceId,
    sourceType: 2,
    extraAId: "00000000-0000-0000-0000-000000000000",
    extraAType: -1,
    extraBId: "00000000-0000-0000-0000-000000000000",
    extraBType: -1,
    modType,
    oldValue: null,
    newValue: null,
    userId: "00000000-0000-0000-0000-000000000000",
    brainId: BRAIN,
    creationDateTime: at,
    modificationDateTime: at,
    syncUpdateDateTime: null,
  });
  /** A thought made by the call has its `101` after the newest entry; one that was there, before it. */
  const MADE_NOW = "2026-10-13T21:01:40.546889";
  const MADE_BEFORE = "2026-10-02T08:00:00";

  /**
   * A brain that answers a create with `NEW`, which then reads as `read`
   * and has its `101` at `madeAt`. A route in `first` goes ahead of these.
   */
  const routes = (
    read: Record<string, unknown>,
    madeAt: string,
    first: Route[] = [],
  ): Route[] => [
    ...first,
    ["GET /api/brains/", () => [entry(THOUGHT, 103, NEWEST)]],
    ["POST /api/thoughts/", () => ({ id: NEW })],
    [`GET /${NEW}/modifications`, () => [entry(NEW, 101, madeAt)]],
    ["GET /api/thoughts/", () => ({ ...thought(""), id: NEW, ...read })],
  ];
  const requests = (calls: Array<{ method: string; path: string }>): string[] =>
    calls.map((c) => `${c.method} ${c.path}`);
  const FOUR = [
    `GET /api/brains/${BRAIN}/modifications`,
    `POST /api/thoughts/${BRAIN}`,
    `GET /api/thoughts/${BRAIN}/${NEW}/modifications`,
    `GET /api/thoughts/${BRAIN}/${NEW}`,
  ];

  const USE_TAG = "pass it to brain_tag, or in tagIds to brain_create_thought or brain_ingest";
  const USE_TYPE =
    "pass it as typeId to brain_create_thought, brain_update_thought or brain_ingest";
  const next = (kind: string, use: string): string =>
    `## Next\nThe identifier above works immediately: ${use}. brain_list_types_and_tags ` +
    `lists the new ${kind} within half a second or so, and brain_update_thought gives it a ` +
    "caption or colours.";
  const LOOSE =
    "TheBrain takes two names for one tag when they differ in letter case, in characters " +
    "that do not show, or in the form of a character, such as a ligature, a superscript or " +
    "a no-break space.";

  it("makes a tag with a name and a kind alone, and gives it by identifier, marked", async () => {
    const { call, calls, sent } = await connect(routes({ name: "gotcha", kind: 4 }, MADE_NOW));
    const result = await call("brain_create_type_or_tag", {
      brainId: BRAIN,
      kind: "tag",
      name: "gotcha",
    });

    expect(result).toEqual({
      isError: false,
      text: `## Done\n- created tag "gotcha" — ${NEW} [tag]\n\n${next("tag", USE_TAG)}`,
    });
    expect(requests(calls)).toEqual(FOUR);
    expect(sent("POST")).toEqual([{ name: "gotcha", kind: 4, acType: 0 }]);
  });

  it("makes a type, and says where a type's identifier goes", async () => {
    const { call, sent } = await connect(
      routes({ name: "Pattern", kind: 2, label: "Pattern" }, MADE_NOW),
    );
    const result = await call("brain_create_type_or_tag", {
      brainId: BRAIN,
      kind: "type",
      name: "Pattern",
    });

    expect(result).toEqual({
      isError: false,
      text: `## Done\n- created type "Pattern" — ${NEW} [type]\n\n${next("type", USE_TYPE)}`,
    });
    expect(sent("POST")).toEqual([{ name: "Pattern", kind: 2, acType: 0 }]);
  });

  it("a tag that was there is not reported as created", async () => {
    // TheBrain answers the create with the identifier of the tag the brain
    // has, as it answers with a new one, and "created" would be untrue.
    const { call, calls } = await connect(routes({ name: "gotcha", kind: 4 }, MADE_BEFORE));
    const result = await call("brain_create_type_or_tag", {
      brainId: BRAIN,
      kind: "tag",
      name: "gotcha",
    });

    expect(result).toEqual({
      isError: false,
      text:
        `## Already there\n- tag "gotcha" — ${NEW} [tag]\n\n## Note\n` +
        "No tag was created: the brain had this one, and TheBrain answered the create with " +
        `it. It is as it was, and the identifier above is the one to use: ${USE_TAG}.`,
    });
    expect(requests(calls)).toEqual(FOUR);
  });

  it("one that was there under another name is given by the name it has", async () => {
    for (const [asked, has, shownAsked] of [
      ["GOTCHA", "Gotcha", "GOTCHA"],
      ["m\u00b2", "m2", "m\u00b2"],
      // As it would be stored: the padding is not what tells the names apart.
      ["  gotcha\t", "Gotcha", "gotcha"],
    ] as const) {
      const { call } = await connect(routes({ name: has, kind: 4 }, MADE_BEFORE));
      const result = await call("brain_create_type_or_tag", {
        brainId: BRAIN,
        kind: "tag",
        name: asked,
      });
      expect(result, asked).toEqual({
        isError: false,
        text:
          `## Already there\n- tag "${has}" — ${NEW} [tag]\n\n## Note\n` +
          "No tag was created: the brain had this one, and TheBrain answered the create with " +
          `it. Its name is "${has}", not "${shownAsked}" as asked for: ${LOOSE} It is as it ` +
          `was, and the identifier above is the one to use: ${USE_TAG}.`,
      });
    }
  });

  it("a name that does not show is spelled out, the one asked for and the one found", async () => {
    // Every name of such characters alone is one name to TheBrain.
    const { call } = await connect(routes({ name: "\ufeff", kind: 4 }, MADE_BEFORE));
    const result = await call("brain_create_type_or_tag", {
      brainId: BRAIN,
      kind: "tag",
      name: "\u200b",
    });
    expect(result.text).toContain(`- tag "(no visible character: U+FEFF)" — ${NEW} [tag]`);
    expect(result.text).toContain(
      'Its name is "(no visible character: U+FEFF)", not "(no visible character: U+200B)" as asked for',
    );
  });

  it("the name of a tag just made is the one read, as TheBrain stored it", async () => {
    const { call, sent } = await connect(routes({ name: "got cha", kind: 4 }, MADE_NOW));
    const result = await call("brain_create_type_or_tag", {
      brainId: BRAIN,
      kind: "tag",
      name: " got\tcha ",
    });
    expect(result.text).toContain(`- created tag "got cha" — ${NEW} [tag]`);
    // The request carries the name as it was given.
    expect(sent("POST")).toEqual([{ name: " got\tcha ", kind: 4, acType: 0 }]);
  });

  it("a type that was there would be said to be there, should TheBrain ever answer with one", async () => {
    // Not seen: a type is made under a name another has. The result goes by
    // the log for a type as for a tag, and not by what was seen.
    const { call } = await connect(routes({ name: "pattern", kind: 2 }, MADE_BEFORE));
    const result = await call("brain_create_type_or_tag", {
      brainId: BRAIN,
      kind: "type",
      name: "Pattern",
    });
    expect(result).toEqual({
      isError: false,
      text:
        `## Already there\n- type "pattern" — ${NEW} [type]\n\n## Note\n` +
        "No type was created: the brain had this one, and TheBrain answered the create with " +
        'it. Its name is "pattern", not "Pattern" as asked for. It is as it was, and the ' +
        `identifier above is the one to use: ${USE_TYPE}.`,
    });
  });

  it("a name TheBrain would not keep is refused before any request", async () => {
    const { call, calls } = await connect(routes({ name: "x", kind: 4 }, MADE_NOW));
    const refused = async (name: string): Promise<string> => {
      const result = await call("brain_create_type_or_tag", { brainId: BRAIN, kind: "tag", name });
      expect(result.isError, JSON.stringify(name)).toBe(true);
      return result.text;
    };
    expect(await refused(" \u00a0")).toBe(
      "name is white space alone (U+0020 U+00A0), and a thought has to have a name. Nothing was written.",
    );
    expect(await refused("\u0085")).toBe(
      "name is white space alone (U+0085), and a thought has to have a name. Nothing was written.",
    );
    expect(await refused("a".repeat(1025))).toBe(
      "name is 1025 UTF-16 units long, and TheBrain keeps the first 1024 of a name and drops " +
        "the rest with a 200. Nothing was written.",
    );
    // The schema's own refusals: an empty name, and a kind that is neither.
    expect(await refused("")).toContain("name");
    const ordinary = await call("brain_create_type_or_tag", {
      brainId: BRAIN,
      kind: "thought",
      name: "x",
    });
    expect(ordinary.isError).toBe(true);
    expect(ordinary.text).toContain("Expected 'type' | 'tag'");
    expect(calls).toEqual([]);
  });

  it("a brainId that is malformed or of zeros sends nothing, and one that is no brain stops at the first read", async () => {
    const unknown = (): Response =>
      new Response(JSON.stringify(`Access to brain ${BRAIN} is unauthorized.`), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    const { call, calls } = await connect(
      routes({ name: "x", kind: 4 }, MADE_NOW, [["GET /api/brains/", unknown]]),
    );
    for (const brainId of ["nope", "00000000-0000-0000-0000-000000000000"]) {
      const result = await call("brain_create_type_or_tag", { brainId, kind: "tag", name: "x" });
      expect(result.isError, brainId).toBe(true);
      expect(result.text, brainId).toContain("brainId");
    }
    expect(calls).toEqual([]);

    const result = await call("brain_create_type_or_tag", {
      brainId: BRAIN,
      kind: "tag",
      name: "x",
    });
    expect(result).toEqual({
      isError: true,
      text:
        `Access to brain ${BRAIN} is unauthorized. The key was accepted: it is brainId that ` +
        "names no brain open to it. Take brainId from brain_list. The other identifiers in " +
        "the call were not looked at.",
    });
    expect(requests(calls)).toEqual([`GET /api/brains/${BRAIN}/modifications`]);
  });

  it("with the log not read nothing is created, and the result says what the read was for", async () => {
    const { call, calls } = await connect(
      routes({ name: "x", kind: 4 }, MADE_NOW, [
        ["GET /api/brains/", () => new Response(JSON.stringify("boom"), { status: 500 })],
      ]),
    );
    for (const kind of ["tag", "type"]) {
      const result = await call("brain_create_type_or_tag", { brainId: BRAIN, kind, name: "x" });
      expect(result, kind).toEqual({
        isError: true,
        text:
          `Nothing was created. The brain's log is read before a ${kind} is made, to tell ` +
          "one this call makes from one that was there, and that read failed: " +
          `${boomAt(`GET /api/brains/${BRAIN}/modifications`)} This call can be sent again as it is.`,
      });
    }
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("a create that is refused is the API's answer, with nothing read after it", async () => {
    const { call, calls } = await connect(
      routes({ name: "x", kind: 4 }, MADE_NOW, [
        ["POST /api/thoughts/", () => new Response(JSON.stringify("boom"), { status: 500 })],
      ]),
    );
    const result = await call("brain_create_type_or_tag", { brainId: BRAIN, kind: "tag", name: "x" });
    expect(result).toEqual({ isError: true, text: boomAt(`POST /api/thoughts/${BRAIN}`) });
    expect(requests(calls)).toEqual(FOUR.slice(0, 2));
  });

  describe("a create that gets no answer", () => {
    const NO_ANSWER =
      "request exceeded 30000 ms. Check that the TheBrain desktop app is running and its " +
      "local API is enabled.";
    const unanswered = async (kind: string) => {
      const { call, calls } = await connect(
        routes({ name: "x", kind: 4 }, MADE_NOW, [
          [
            "POST /api/thoughts/",
            () => {
              // What the client makes of a timeout: the request may have reached TheBrain.
              throw new DOMException("timed out", "TimeoutError");
            },
          ],
        ]),
      );
      const result = await call("brain_create_type_or_tag", {
        brainId: BRAIN,
        kind,
        name: " Gotcha ",
      });
      return { result, calls };
    };

    it("for a tag says to send the call again: TheBrain makes no second tag of the name", async () => {
      const { result, calls } = await unanswered("tag");
      expect(result).toEqual({
        isError: true,
        text:
          `${NO_ANSWER}\n\n## Next\n` +
          'No answer came to the create, so TheBrain may have made the tag "Gotcha" all the ' +
          "same, and there is no identifier to give for it. Send this call again: under the " +
          "name of a tag the brain has TheBrain makes no second one, and the result gives the " +
          "tag that is there.",
      });
      expect(requests(calls)).toEqual(FOUR.slice(0, 2));
    });

    it("for a type says to look first: sent again, the call makes a second type", async () => {
      const { result } = await unanswered("type");
      expect(result).toEqual({
        isError: true,
        text:
          `${NO_ANSWER}\n\n## Next\n` +
          'No answer came to the create, so TheBrain may have made the type "Gotcha" all the ' +
          "same, and there is no identifier to give for it. Before creating it again, look " +
          "for it with brain_list_types_and_tags, which lists a new type within half a second " +
          "or so: sent again, this call makes a second type of the same name.",
      });
    });
  });

  describe("a read that fails after the create", () => {
    const IN_PART =
      "The call stopped at its first failure, and nothing is rolled back. What is under " +
      "Done was done. What is under Failed was not, unless its line says otherwise. ";
    const boom = (): Response => new Response(JSON.stringify("boom"), { status: 500 });
    const failed500 = (request: string): string =>
      `TheBrain failed with a 500 (${request}): boom. The fault is inside the app, not in the ` +
      "arguments of this call. A read is safe to repeat; before repeating a write, check what it left.";

    it("does not lose the identifier: whether the tag was made is said to be unknown", async () => {
      // Thrown to guard(), the 500 was the whole result, and for a type the
      // call sent again would have made a second one.
      const { call, calls } = await connect(
        routes({ name: "x", kind: 4 }, MADE_NOW, [[`GET /${NEW}/modifications`, boom]]),
      );
      const result = await call("brain_create_type_or_tag", {
        brainId: BRAIN,
        kind: "tag",
        name: "gotcha",
      });
      expect(result).toEqual({
        isError: true,
        text:
          `## Done\n- the brain has the tag ${NEW}, asked for as "gotcha"\n\n` +
          "## Failed\n- whether this call made it, or TheBrain answered with a tag that was " +
          `there: ${failed500(`GET /api/thoughts/${BRAIN}/${NEW}/modifications`)}\n\n` +
          `## Next\n${IN_PART}The identifier works immediately: do not create the tag again. ` +
          `Read it with brain_get_thought, then ${USE_TAG}.`,
      });
      expect(requests(calls)).toEqual(FOUR.slice(0, 3));
    });

    it("says what is known when only the thought was not read: made by this call, or there before", async () => {
      for (const [madeAt, had] of [
        [MADE_NOW, "has, made by this call,"],
        [MADE_BEFORE, "had"],
      ] as const) {
        const { call } = await connect([
          ["GET /api/brains/", () => [entry(THOUGHT, 103, NEWEST)]],
          ["POST /api/thoughts/", () => ({ id: NEW })],
          [`GET /${NEW}/modifications`, () => [entry(NEW, 101, madeAt)]],
          ["GET /api/thoughts/", boom],
        ]);
        const result = await call("brain_create_type_or_tag", {
          brainId: BRAIN,
          kind: "type",
          name: "Pattern",
        });
        expect(result, madeAt).toEqual({
          isError: true,
          text:
            `## Done\n- the brain ${had} the type ${NEW}, asked for as "Pattern"\n\n` +
            "## Failed\n- the read of the type after the create: " +
            `${failed500(`GET /api/thoughts/${BRAIN}/${NEW}`)}\n\n` +
            `## Next\n${IN_PART}The identifier works immediately: do not create the type again. ` +
            `Read it with brain_get_thought, then ${USE_TYPE}.`,
        });
      }
    });
  });

  it("takes a kind of two values and a name, and nothing a tag that is there would be changed by", async () => {
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === "brain_create_type_or_tag")!.inputSchema;
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["brainId", "kind", "name"]);
    expect(schema.properties).toMatchObject({ kind: { type: "string", enum: ["type", "tag"] } });
    expect(schema.required).toEqual(["brainId", "kind", "name"]);
  });

  it("every tool a description sends the model to is a tool", async () => {
    // brain_tag said to "create a new tag via brain_create_thought", which
    // makes an ordinary thought, and brain_tag then refuses that as no tag.
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    const mentioned = [...JSON.stringify(tools).matchAll(/brain_[a-z_]+/g)].map((m) => m[0]);
    expect(mentioned.filter((name) => !names.has(name))).toEqual([]);

    const tag = tools.find((t) => t.name === "brain_tag")!.description ?? "";
    expect(tag).toContain("create a new tag via brain_create_type_or_tag");
    expect(tag).not.toContain("brain_create_thought");
    // And nothing sends the model to brain_create_thought for a tag or a type.
    const create = tools.find((t) => t.name === "brain_create_thought")!;
    expect(JSON.stringify(create.inputSchema)).not.toContain('"kind"');
  });

  it("a plan still makes ordinary thoughts alone", async () => {
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    const plan = tools.find((t) => t.name === "brain_ingest")!.inputSchema.properties as {
      thoughts: { items: { properties: Record<string, unknown> } };
    };
    expect(Object.keys(plan.thoughts.items.properties)).not.toContain("kind");
  });
});

describe("an identifier in capitals", () => {
  // The API takes one and answers in lower case (BRMCP-62). Taken as given,
  // it went on to be compared with the API's spelling, and keyed beside it.
  const CHILD = "abababab-0000-4000-8000-000000000007";
  const TYPE = "eeeeeeee-0000-4000-8000-000000000005";
  const TAG = "ffffffff-0000-4000-8000-000000000006";
  const up = (id: string): string => id.toUpperCase();

  it("is the root of brain_traverse once, and the names of its links are kept", async () => {
    // The root was keyed as given and every neighbour as the API spells it:
    // the walk came back to the root as to another thought, and the link from
    // it was looked for under the capitals and lost its name.
    const link = {
      id: LINK,
      thoughtIdA: THOUGHT,
      thoughtIdB: CHILD,
      relation: 1,
      meaning: 1,
      name: "motivates",
    };
    const rag = thought("RAG");
    const embeddings = thought("Embeddings", { id: CHILD });
    const { call } = await connect([
      [
        "GET /graph",
        (url) =>
          url.pathname.toLowerCase().includes(THOUGHT)
            ? { ...graph(rag), children: [embeddings], links: [link] }
            : { ...graph(embeddings), parents: [rag], links: [link] },
      ],
    ]);
    const result = await call("brain_traverse", {
      brainId: up(BRAIN),
      thoughtId: up(THOUGHT),
      depth: 2,
    });
    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      "# Neighbourhood of: RAG\n\n" +
        `## Hop 1\n- Embeddings — ${CHILD}  (via RAG)\n\n` +
        "## Labelled links\n- RAG -> motivates -> Embeddings\n- Embeddings -> motivates -> RAG\n\n" +
        "## Totals\nthoughts 2, links 2",
    );
  });

  it.each<[string, Record<string, unknown>]>([
    ["brain_get_thought", { thoughtId: THOUGHT }],
    ["brain_search", { query: "RAG" }],
    ["brain_traverse", { thoughtId: THOUGHT }],
    ["brain_list_types_and_tags", {}],
    ["brain_recent_changes", {}],
    ["brain_index", { action: "status" }],
    ["brain_create_thought", { name: "RAG", parentId: PARENT, typeId: TYPE, tagIds: [TAG] }],
    ["brain_update_thought", { thoughtId: THOUGHT, typeId: TYPE }],
    ["brain_set_note", { thoughtId: THOUGHT, markdown: "x" }],
    ["brain_append_note", { thoughtId: THOUGHT, markdown: "x" }],
    ["brain_link", { fromId: PARENT, toId: THOUGHT, relation: "child" }],
    ["brain_unlink", { fromId: PARENT, toId: THOUGHT, linkId: LINK, confirm: true }],
    ["brain_tag", { thoughtId: THOUGHT, add: [TAG], remove: [TAG] }],
    ["brain_create_type_or_tag", { kind: "tag", name: "gotcha" }],
    ["brain_attach_url", { thoughtId: THOUGHT, url: "https://example.com/p" }],
    ["brain_activate", { thoughtId: THOUGHT }],
    ["brain_delete_thought", { thoughtId: THOUGHT, confirm: true }],
    [
      "brain_ingest",
      {
        thoughts: [{ tempId: "t", name: "RAG", parent: PARENT, typeId: TYPE, tagIds: [TAG] }],
        links: [{ from: "t", to: CHILD }],
      },
    ],
  ])("%s sends it to TheBrain in lower case, and the brain's index is opened so", async (tool, args) => {
    const opened: string[] = [];
    const embedder = { id: "test", dimensions: 3 } as unknown as Embedder;
    const context = (api: TheBrainApi) => ({
      config: { allowDestructive: true },
      search: (id: string) => {
        opened.push(id);
        return new SemanticSearch(api, new VectorStore(":memory:"), embedder);
      },
      indexer: (id: string) => {
        opened.push(id);
        return new SemanticIndexer(api, new VectorStore(":memory:"), embedder);
      },
      store: (id: string) => {
        opened.push(id);
        return new VectorStore(":memory:");
      },
    });
    const { call, calls } = await connect([], context);
    const capitals = Object.fromEntries(
      Object.entries(args).map(([key, value]) => [
        key,
        JSON.parse(JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, up)),
      ]),
    );
    await call(tool, { brainId: up(BRAIN), ...capitals });
    expect(calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(calls)).not.toMatch(/[A-F]{8}-/);
    expect(opened.filter((id) => id !== id.toLowerCase())).toEqual([]);
  });

  it("names one thought in a plan, in whichever spelling", async () => {
    // A plan's parent is a tempId or a UUID, and only the plan says which.
    // Kept as sent, the parent in capitals and in lower case were two
    // thoughts: each was looked under, and the one thought asked for twice
    // was made twice.
    const { call, sent } = await connect(brainRoutes({ aliases: true }));
    const result = await call("brain_ingest", {
      brainId: BRAIN,
      thoughts: [
        { tempId: "a", name: "RAG", parent: up(PARENT) },
        { tempId: "b", name: "RAG", parent: PARENT },
      ],
    });
    expect(result.isError).toBe(false);
    expect(sent("POST")).toEqual([
      { name: "RAG", kind: 1, acType: 0, sourceThoughtId: PARENT, relation: 1 },
    ]);
  });

  it("one that is no UUID is refused in the caller's spelling", async () => {
    const { call, calls } = await connect([]);
    const result = await call("brain_get_thought", { brainId: "My-Brain", thoughtId: THOUGHT });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('brainId must be a UUID, got "My-Brain"');
    expect(calls).toEqual([]);
  });
});
