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

/** Routes match by method and path substring, first match wins. */
async function connect(routes: Route[]) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
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
        const value = respond(url, body);
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
