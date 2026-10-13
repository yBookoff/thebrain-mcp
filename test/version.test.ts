/**
 * The version the server reports to a client is the package's, and the
 * release script is what keeps it so.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { Config } from "../src/config.js";
import { SERVER_NAME, SERVER_VERSION, createServer } from "../src/server/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join("scripts", "sync-server-json.mjs");
const SOURCE = join("src", "server", "index.ts");
const packageVersion = (root: string): string =>
  (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;

describe("the version the server reports", () => {
  it("is the package's, in what a client is told at initialize", async () => {
    // It said 0.1.0 to every client of the 0.2.0 package: the constant was
    // written once by hand, and nothing compared it with package.json.
    const config: Config = {
      apiKey: "k",
      baseUrl: undefined,
      dataDir: join(tmpdir(), "thebrain-mcp-version-never-opened"),
      embeddingModel: "Xenova/multilingual-e5-small",
      embeddingDtype: "q8",
      allowDestructive: false,
      requestTimeoutMs: 1000,
    };
    const { server, context } = createServer(config);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    expect(client.getServerVersion()).toMatchObject({
      name: SERVER_NAME,
      version: packageVersion(ROOT),
    });
    expect(SERVER_VERSION).toBe(packageVersion(ROOT));

    await client.close();
    context.close();
  });
});

describe("scripts/sync-server-json.mjs and the version in the source", () => {
  /** What the script reads and writes, copied to where a test may change it. */
  let copy: string;
  beforeEach(() => {
    copy = mkdtempSync(join(tmpdir(), "thebrain-mcp-version-"));
    for (const file of [SCRIPT, SOURCE, "package.json", "server.json"]) {
      mkdirSync(dirname(join(copy, file)), { recursive: true });
      cpSync(join(ROOT, file), join(copy, file));
    }
  });
  afterEach(() => {
    rmSync(copy, { recursive: true, force: true });
  });

  const run = (root: string, ...args: string[]) =>
    spawnSync(process.execPath, [join(root, SCRIPT), ...args], { encoding: "utf8" });
  const read = (file: string): string => readFileSync(join(copy, file), "utf8");
  const edit = (file: string, change: (text: string) => string): void =>
    writeFileSync(join(copy, file), change(read(file)));
  const reported = (version: string): string => `export const SERVER_VERSION = "${version}";`;

  it("the repository passes the check the publish workflow runs", () => {
    const result = run(ROOT, "--check");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("the check fails on a constant that is not the package's version, and writes nothing", () => {
    const version = packageVersion(copy);
    edit(SOURCE, (text) => text.replace(reported(version), reported("0.1.0")));
    const before = read(SOURCE);

    const result = run(copy, "--check");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `SERVER_VERSION in src/server/index.ts is 0.1.0 while package.json is at ${version}`,
    );
    expect(read(SOURCE)).toBe(before);
  });

  it("run as `npm version` runs it, it writes the new version to server.json and to the constant alone", () => {
    const version = packageVersion(copy);
    const next = "9.8.7";
    edit("package.json", (text) => text.replace(`"version": "${version}"`, `"version": "${next}"`));
    const source = read(SOURCE);
    expect(run(copy, "--check").status).toBe(1);

    const result = run(copy);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    // That line and no other: the file is otherwise as it was, to the byte.
    expect(read(SOURCE)).toBe(source.replace(reported(version), reported(next)));
    expect(read(SOURCE)).toContain(reported(next));
    const server = JSON.parse(read("server.json")) as {
      version: string;
      packages: Array<{ version: string }>;
    };
    expect([server.version, server.packages[0]!.version]).toEqual([next, next]);
    expect(run(copy, "--check").status).toBe(0);
  });

  it("a source with no such constant is refused, whichever way it is run", () => {
    edit(SOURCE, (text) => text.replace("export const SERVER_VERSION", "const VERSION"));
    for (const args of [["--check"], []]) {
      const result = run(copy, ...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("src/server/index.ts has no SERVER_VERSION");
    }
  });
});
