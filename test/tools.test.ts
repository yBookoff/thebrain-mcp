/**
 * Tools end to end: a real MCP client talking to the registered handlers over
 * an in-memory transport, with only HTTP faked.
 */
import { describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { TheBrainApi } from "../src/api/index.js";
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
 * `Response` it builds itself.
 *
 * One thing is added to what a route returns: a graph lists the thoughts
 * created next to its thought through this connection, in the list their
 * relation puts them in, as the API's does. `brain_ingest` waits for that.
 */
async function connect(routes: Route[]) {
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
  const ctx = { api } as unknown as ServerContext;
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
    expect(sent("PATCH")).toEqual([
      [
        { op: "remove", path: "/label" },
        { op: "remove", path: "/backgroundColor" },
      ],
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
    expect(result.text).toContain('## Failed\n- note for "Top": boom');
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
          // A thought that does not exist is a 403.
          return id in others ? { ...thought("", { aliases: [] }), id, ...others[id] } : 403;
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
