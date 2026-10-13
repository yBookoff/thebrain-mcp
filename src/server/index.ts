/**
 * MCP server assembly.
 *
 * Important: only protocol traffic goes to stdout. All diagnostics go to
 * stderr, otherwise JSON-RPC breaks.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Config } from "../config.js";
import { ServerContext } from "./context.js";
import { registerIngestTool } from "./tools/ingest.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";

export const SERVER_NAME = "thebrain-mcp";
/**
 * The package's version, as every client is told it at `initialize`. Not
 * edited by hand: `npm version` writes this line through
 * scripts/sync-server-json.mjs, whose `--check` the publish workflow runs,
 * and a unit test sets it against package.json.
 */
export const SERVER_VERSION = "0.2.0";

export function createServer(config: Config): {
  server: McpServer;
  context: ServerContext;
} {
  const context = new ServerContext(config);
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerReadTools(server, context);
  registerWriteTools(server, context);
  registerIngestTool(server, context);

  return { server, context };
}
