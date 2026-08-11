#!/usr/bin/env node
/**
 * Entry point: the TheBrain MCP server over stdio.
 *
 * Only JSON-RPC protocol traffic goes to stdout. Everything else to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ConfigError, loadConfig } from "./config.js";
import { createServer } from "./server/index.js";

function log(message: string): void {
  process.stderr.write(`[thebrain-mcp] ${message}\n`);
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      log(`configuration error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const { server, context } = createServer(config);

  const shutdown = (signal: string) => (): void => {
    log(`received ${signal}, shutting down`);
    context.close();
    void server.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown("SIGINT"));
  process.once("SIGTERM", shutdown("SIGTERM"));

  await server.connect(new StdioServerTransport());
  log(`connected to ${config.baseUrl}, indexes in ${config.dataDir}`);
}

main().catch((error: unknown) => {
  log(`fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
