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
export const SERVER_VERSION = "0.1.0";

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
