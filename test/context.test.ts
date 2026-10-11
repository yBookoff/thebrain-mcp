/**
 * The server's own state: which index files it opens, and when it makes one.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TheBrainApi } from "../src/api/index.js";
import type { Config } from "../src/config.js";
import { ServerContext } from "../src/server/context.js";

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
