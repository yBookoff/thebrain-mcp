/**
 * The server's own state: which index files it opens, and when it makes one.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { TheBrainApi } from "../src/api/index.js";
import type { Config } from "../src/config.js";
import type { Embedder } from "../src/semantic/embedder.js";
import { ServerContext } from "../src/server/context.js";
import { registerReadTools } from "../src/server/tools/read.js";

const BRAIN = "aaaaaaaa-0000-4000-8000-000000000001";
const THOUGHT = "bbbbbbbb-0000-4000-8000-000000000002";

describe("the index of a brain that is not there", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = join(mkdtempSync(join(tmpdir(), "thebrain-mcp-context-")), "data");
  });
  afterEach(() => {
    rmSync(join(dataDir, ".."), { recursive: true, force: true });
  });

  /** A server whose API answers every request as it does for a `brainId` no brain has. */
  function context(): ServerContext {
    const config: Config = {
      apiKey: "k",
      baseUrl: undefined,
      dataDir,
      embeddingModel: "Xenova/multilingual-e5-small",
      embeddingDtype: "q8",
      allowDestructive: false,
      requestTimeoutMs: 1000,
    };
    const ctx = new ServerContext(config);
    const noBrain: typeof fetch = async () =>
      new Response(JSON.stringify(`Access to brain ${BRAIN} is unauthorized.`), {
        status: 401,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    (ctx as unknown as { api: TheBrainApi }).api = new TheBrainApi({
      apiKey: "k",
      fetchImpl: noBrain,
    });
    return ctx;
  }

  it("a search leaves no index file behind", async () => {
    // The store was opened, and so created, before the request that says
    // there is no such brain: three files for every identifier tried.
    const ctx = context();
    await expect(ctx.search(BRAIN).find(BRAIN, "anything")).rejects.toMatchObject({
      kind: "unknown_brain",
    });
    expect(existsSync(dataDir)).toBe(false);
    ctx.close();
  });

  it("nor does a look at its index, or the removal of a thought from it", () => {
    // `brain_list` looks at the index of every brain, and `brain_delete_thought`
    // removes a thought from an index the brain may never have had.
    const ctx = context();
    expect(ctx.indexer(BRAIN).status(BRAIN)).toMatchObject({ exists: false, size: 0 });
    ctx.store(BRAIN).remove([THOUGHT]);
    expect(existsSync(dataDir)).toBe(false);
    ctx.close();
  });
});

describe("the index of a brain named in capitals", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = join(mkdtempSync(join(tmpdir(), "thebrain-mcp-context-")), "data");
  });
  afterEach(() => {
    rmSync(join(dataDir, ".."), { recursive: true, force: true });
  });

  /** A brain of one thought, and an embedder with nothing to load. */
  async function connect() {
    const config: Config = {
      apiKey: "k",
      baseUrl: undefined,
      dataDir,
      embeddingModel: "Xenova/multilingual-e5-small",
      embeddingDtype: "q8",
      allowDestructive: false,
      requestTimeoutMs: 1000,
    };
    const ctx = new ServerContext(config);
    const json = (value: unknown): Response =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const thought = { id: THOUGHT, brainId: BRAIN, name: "RAG", kind: 1, typeId: null };
    const answer: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/modifications")) return json([]);
      if (path.endsWith("/graph")) {
        return json({ activeThought: thought, parents: [], children: [], jumps: [], links: [] });
      }
      if (path.startsWith("/api/notes/")) {
        return json({ modificationDateTime: "0001-01-01T00:00:00", markdown: "" });
      }
      return json({ id: BRAIN, name: "Test brain", homeThoughtId: THOUGHT });
    };
    const embedder: Embedder = {
      id: "fake@v1",
      dimensions: 2,
      embedDocuments: async (texts) => texts.map(() => new Float32Array([1, 0])),
      embedQuery: async () => new Float32Array([1, 0]),
    };
    Object.assign(ctx, { api: new TheBrainApi({ apiKey: "k", fetchImpl: answer }), embedder });
    const server = new McpServer({ name: "thebrain-mcp-test", version: "0" });
    registerReadTools(server, ctx);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const index = async (brainId: string, action: string): Promise<string> => {
      const result = await client.callTool({ name: "brain_index", arguments: { brainId, action } });
      const content = result.content as Array<{ text: string }>;
      expect(result.isError).not.toBe(true);
      return content.map((c) => c.text).join("\n");
    };
    return { ctx, index };
  }

  it("is the one its identifier in lower case names, and is usable by it", async () => {
    // The identifier went into the file name as given. Where the file system
    // tells case apart that was a second index; on macOS it was the same file,
    // whose brainId, in capitals, made it another brain's index to a call in
    // lower case.
    const { ctx, index } = await connect();
    await index(BRAIN.toUpperCase(), "rebuild");
    const status = await index(BRAIN, "status");
    expect(status).toContain("- thoughts indexed: 1\n");
    expect(status).toContain("- usable: yes\n");
    expect(readdirSync(dataDir).filter((name) => name !== name.toLowerCase())).toEqual([]);
    ctx.close();
  });
});
