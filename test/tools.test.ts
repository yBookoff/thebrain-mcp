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
